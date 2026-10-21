/**
 * expedicao.service — situação de EXPEDIÇÃO de envios do Mercado Livre:
 * prazo oficial de postagem e data efetiva do despacho, por envio.
 *
 * Existe para a aba Expedição do dashboard. A aba é só leitura e precisa
 * responder três perguntas por dia: o que tem que sair, o que já saiu e o que
 * está atrasado. Nenhuma das três sai do snapshot de pedidos, que não guarda
 * situação de envio.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FONTES (documentação "Shipment handling" do Mercado Livre)
 *
 *   GET /shipments/{id}            status, substatus, logistic_type
 *   GET /shipments/{id}/lead_time  estimated_handling_limit.date — prazo
 *                                  oficial de postagem. "Só a data importa: o
 *                                  vendedor tem o dia inteiro indicado."
 *   GET /shipments/{id}/history    [{ status, substatus, date }] — quando
 *                                  cada mudança aconteceu.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O QUE CONTA COMO DESPACHO
 *
 * Só evento em que o pacote SAIU da mão do vendedor:
 *   ready_to_ship/dropped_off            deixado na agência ou ponto
 *   ready_to_ship/picked_up              coletado
 *   ready_to_ship/authorized_by_carrier  aceito pela transportadora
 *   shipped, delivered, not_delivered    já em trânsito ou além
 *
 * NÃO contam: pagamento aprovado, etiqueta gerada (ready_to_print), etiqueta
 * impressa (printed), entrada em preparação (handling) nem qualquer outra
 * mudança genérica de status. A data do despacho é a do PRIMEIRO evento
 * qualificado do histórico.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ENVIO PROGRAMADO (pending/buffered)
 *
 * O ML segura o envio até `buffering.date` ("Fecha que podrá realizar el
 * envío", doc. Mercado Envios 2) e só então libera a etiqueta. Nesse estado o
 * /lead_time responde SEM estimated_handling_limit — verificado em envios reais
 * xd_drop_off em 21/10/2026. Por isso o envio sai como 'programado', com
 * `liberacaoEm` em campo próprio e `prazoPostagem: null`: a data de liberação
 * não é prazo e nunca é copiada para ele. Ao sair de buffered, o envio volta
 * a ser 'pendente' e o prazo vem do /lead_time.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AUSENTE NÃO É ZERO
 *
 * Prazo ou data ausentes saem como `null`, com o motivo em `avisos`. Um envio
 * despachado cujo histórico não traz data fica `situacao: 'despachado'` com
 * `despachadoEm: null` — o dashboard mostra "data não informada" e não o
 * encaixa em dia nenhum.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CUSTO E INCREMENTALIDADE
 *
 * Cada envio custa até 3 chamadas ao Mercado Livre, e o dashboard pede os
 * mesmos envios a cada atualização. Por isso:
 *   - Full para na 1ª chamada: quem despacha é o Mercado Livre, e o envio
 *     não entra na expedição. Resultado FINAL.
 *   - Cancelado e despachado COM data são FINAIS: ficam em cache por
 *     TTL_FINAL_S e nunca mais tocam no ML. Despachado SEM data é revisto a
 *     cada TTL_INCOMPLETO_S, para a data aparecer quando o histórico a trouxer.
 *   - Status fora da lista fechada de pendentes vira 'outro' (nunca pendente
 *     por exclusão, o que geraria atraso falso).
 *   - Pendente é revisto no máximo a cada TTL_PENDENTE_S. O prazo oficial
 *     muda raramente e tem cache próprio (TTL_PRAZO_S), então a revisão de
 *     um pendente custa 1 chamada (o envio), não 3.
 *   - O histórico só é pedido quando o envio JÁ indica despacho.
 *   - Concorrência fixa e teto de chamadas por requisição. O que sobra volta
 *     como `aguardando`, e o dashboard pede de novo na próxima passada.
 *   - 429 do ML abre uma janela de COOLDOWN no Redis, compartilhada por
 *     todas as instâncias: nela nenhuma chamada nova sai, só o cache responde.
 *
 * Nenhum dado de comprador entra ou sai daqui: só ids, status e datas.
 */
import type { Cache } from '../lib/cache/cache.js';
import { hojeBRT } from '../lib/datas-brt.js';

// ── Tipos ───────────────────────────────────────────────────────────────

export type Situacao =
  | 'pendente'     // ainda com o vendedor
  | 'programado'   // pending/buffered: o ML ainda não liberou a etiqueta (ver liberacaoEm)
  | 'despachado'   // saiu da mão do vendedor
  | 'cancelado'    // envio cancelado: não sai mais
  | 'full'         // Full: despacho é do Mercado Livre, fora da expedição
  | 'aguardando'   // ainda não consultado nesta passada (teto ou cooldown)
  | 'outro'        // status que não é pendente, despacho nem cancelamento (ex.: a combinar)
  | 'indisponivel'; // o ML não respondeu de forma utilizável

export interface EnvioExpedicao {
  id: string;
  situacao: Situacao;
  logistica: string | null;
  status: string | null;
  substatus: string | null;
  /** Prazo oficial de postagem, 'YYYY-MM-DD' (dia civil informado pelo ML). */
  prazoPostagem: string | null;
  /**
   * Só para 'programado': dia em que o ML LIBERA o envio (etiqueta disponível),
   * de `buffering.date`. NÃO é prazo de postagem e nunca é copiado para
   * `prazoPostagem`: o prazo oficial só é atribuído depois da liberação.
   */
  liberacaoEm: string | null;
  /** Instante do primeiro evento de despacho (ISO, como o ML enviou). */
  despachadoEm: string | null;
  /** Quando o backend leu o ML pela última vez para este envio. */
  consultadoEm: string | null;
  avisos: string[];
}

/** Resposta de uma chamada ao ML, já com corpo lido. */
export interface RespostaML {
  status: number;
  data: unknown;
}

export interface FetchersEnvio {
  envio(id: string): Promise<RespostaML>;
  prazo(id: string): Promise<RespostaML>;
  historico(id: string): Promise<RespostaML>;
}

// ── Regras de status ────────────────────────────────────────────────────

/** Status que só existem DEPOIS do despacho. */
export const STATUS_DESPACHADO = new Set(['shipped', 'delivered', 'not_delivered']);

/**
 * Status em que o pacote ainda está com o vendedor. Lista FECHADA de
 * propósito: um status que o ML venha a criar não vira "pendente" por
 * exclusão — viraria atraso falso na tela. Cai em 'outro', com o status no aviso.
 */
export const STATUS_PENDENTE = new Set(['pending', 'handling', 'ready_to_ship']);

/** Substatus de ready_to_ship em que o pacote já saiu da mão do vendedor. */
export const SUBSTATUS_DESPACHO = new Set(['dropped_off', 'picked_up', 'authorized_by_carrier']);

/**
 * Status de ENVIO cancelado. Não confundir com status de PEDIDO, que tem regra
 * própria em lib/status-venda: um envio pode ser cancelado e reemitido sem que
 * o pedido seja cancelado, e vice-versa.
 */
export function envioCancelado(status: string | null | undefined): boolean {
  return status === ENVIO_CANCELADO;
}
const ENVIO_CANCELADO = 'cancelled';

/** Só 'fulfillment' é Full — mesma regra do resto do backend. */
export function ehFull(logistica: string | null | undefined): boolean {
  return logistica === 'fulfillment';
}

export function eventoEhDespacho(status: unknown, substatus: unknown): boolean {
  if (typeof status !== 'string') return false;
  if (STATUS_DESPACHADO.has(status)) return true;
  return status === 'ready_to_ship' && typeof substatus === 'string' && SUBSTATUS_DESPACHO.has(substatus);
}

// ── Extração (defensiva: o ML muda formato sem aviso) ───────────────────

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * Dia civil de um campo de data do ML.
 *
 * Usamos a DATA ESCRITA pelo ML ('2026-10-20T00:00:00.000-03:00' → 2026-10-20)
 * e não o instante convertido: a documentação diz que só a data importa, e
 * converter um '...T00:00:00Z' para Brasília o jogaria para o dia anterior.
 */
export function diaDoCampo(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const [, a, me, d] = m;
  const dt = new Date(Date.UTC(Number(a), Number(me) - 1, Number(d)));
  if (dt.getUTCFullYear() !== Number(a) || dt.getUTCMonth() !== Number(me) - 1 || dt.getUTCDate() !== Number(d)) return null;
  return `${a}-${me}-${d}`;
}

export interface DadosEnvio {
  status: string | null;
  substatus: string | null;
  logistica: string | null;
  /** Fallback de prazo quando /lead_time não responde. */
  prazoNoEnvio: string | null;
  /** Fallback de data quando /history não traz o evento. */
  dataShippedNoEnvio: string | null;
  /** buffering.date: dia de LIBERAÇÃO do envio programado. Não é prazo. */
  liberacao: string | null;
}

/** Substatus de pending em que o ML segura o envio até a data de liberação. */
export const SUBSTATUS_PROGRAMADO = 'buffered';

export function extrairEnvio(data: unknown): DadosEnvio | null {
  const o = obj(data);
  if (!o) return null;
  const so = obj(o.shipping_option);
  const lt = obj(o.lead_time);
  const sh = obj(o.status_history);
  return {
    status: str(o.status),
    substatus: str(o.substatus),
    logistica: str(o.logistic_type),
    prazoNoEnvio:
      diaDoCampo(obj(lt?.estimated_handling_limit)?.date) ??
      diaDoCampo(obj(so?.estimated_handling_limit)?.date),
    dataShippedNoEnvio: str(sh?.date_shipped),
    liberacao:
      diaDoCampo(obj(lt?.buffering)?.date) ??
      diaDoCampo(obj(so?.buffering)?.date),
  };
}

/** Prazo oficial de postagem a partir de GET /shipments/{id}/lead_time. */
export function extrairPrazo(data: unknown): string | null {
  return diaDoCampo(obj(obj(data)?.estimated_handling_limit)?.date);
}

/**
 * Instante do PRIMEIRO evento de despacho no histórico. Aceita a lista na
 * raiz ou dentro de `data`/`results` (o ML já entregou as duas formas em
 * endpoints vizinhos). Eventos sem data válida são ignorados, nunca viram 0.
 */
export function extrairDespacho(data: unknown): string | null {
  const raiz = obj(data);
  const lista: unknown = Array.isArray(data) ? data : (raiz?.data ?? raiz?.results);
  if (!Array.isArray(lista)) return null;
  let melhor: { iso: string; t: number } | null = null;
  for (const e of lista) {
    const ev = obj(e);
    if (!ev || !eventoEhDespacho(ev.status, ev.substatus)) continue;
    const iso = str(ev.date);
    if (!iso) continue;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) continue;
    if (!melhor || t < melhor.t) melhor = { iso, t };
  }
  return melhor ? melhor.iso : null;
}

// ── Cache ───────────────────────────────────────────────────────────────

/** Despachado, cancelado ou Full: não muda mais. 60 dias. */
export const TTL_FINAL_S = 60 * 24 * 3600;
/** Pendente: revisto no máximo a cada 2 minutos. */
export const TTL_PENDENTE_S = 120;
/**
 * Despachado SEM data, ou status 'outro': não é final. Revisto a cada 10 min,
 * para a data aparecer quando o histórico a trouxer, sem martelar o ML.
 */
export const TTL_INCOMPLETO_S = 10 * 60;
/** Prazo oficial de um pendente: muda raramente. 20 minutos. */
export const TTL_PRAZO_S = 20 * 60;
/** /lead_time respondeu 200 SEM prazo: não perguntar de novo por 5 minutos. */
export const TTL_PRAZO_AUSENTE_S = 5 * 60;
/** Janela sem chamadas ao ML depois de um 429. */
export const COOLDOWN_429_S = 60;

export const CHAVE_COOLDOWN = 'exped:cooldown';
/**
 * Versão das chaves de envio e prazo. Sobe quando a forma de LER o ML muda:
 * v2 = /lead_time com x-format-new. Resultados v1 (gravados sem o cabeçalho,
 * inclusive despachados com 60 dias de cache) deixam de ser lidos e expiram
 * sozinhos.
 */
export const VERSAO_CHAVES = 'v2';
const chaveEnvio = (id: string) => `exped:${VERSAO_CHAVES}:env:${id}`;
const chavePrazo = (id: string) => `exped:${VERSAO_CHAVES}:prazo:${id}`;

/** Ids por requisição. Acima disso o dashboard fatia. */
export const MAX_IDS = 50;
/** Chamadas ao ML por requisição — cabe folgado no maxDuration de 30 s. */
export const MAX_CHAMADAS_PADRAO = 60;
/** Mesma ordem de grandeza do backfill de logística (CONCORRENCIA = 8). */
export const CONCORRENCIA_PADRAO = 4;

/**
 * TTL de um resultado. Final só quando nada mais muda: Full, cancelado e
 * despachado COM data. Despachado sem data continua sendo revisto.
 */
export function ttlDoResultado(e: EnvioExpedicao, hoje: string = hojeBRT()): number {
  if (e.situacao === 'full' || e.situacao === 'cancelado') return TTL_FINAL_S;
  if (e.situacao === 'despachado') return e.despachadoEm ? TTL_FINAL_S : TTL_INCOMPLETO_S;
  if (e.situacao === 'outro') return TTL_INCOMPLETO_S;
  // Programado com liberação FUTURA: nada muda até lá além de cancelamento.
  // No dia da liberação (ou sem data) volta ao ritmo do pendente.
  if (e.situacao === 'programado' && e.liberacaoEm && e.liberacaoEm > hoje) return TTL_INCOMPLETO_S;
  return TTL_PENDENTE_S;
}

function parseJSON<T>(v: string | null): T | null {
  if (v === null) return null;
  try { return JSON.parse(v) as T; } catch { return null; }
}

async function lerJSON<T>(cache: Cache, k: string): Promise<T | null> {
  return parseJSON<T>(await cache.get(k));
}

// ── Orçamento de chamadas (teto + 429) ──────────────────────────────────

class LimiteML extends Error {
  constructor(readonly motivo: 'teto' | 'cooldown') { super(motivo); }
}

class Orcamento {
  usadas = 0;
  bloqueado: 'teto' | 'cooldown' | null = null;
  constructor(private readonly max: number) {}
  reservar(): void {
    if (this.bloqueado) throw new LimiteML(this.bloqueado);
    if (this.usadas >= this.max) { this.bloqueado = 'teto'; throw new LimiteML('teto'); }
    this.usadas++;
  }
}

// ── Núcleo ──────────────────────────────────────────────────────────────

function vazio(id: string, situacao: Situacao, avisos: string[] = []): EnvioExpedicao {
  return {
    id, situacao, logistica: null, status: null, substatus: null,
    prazoPostagem: null, liberacaoEm: null, despachadoEm: null, consultadoEm: null, avisos,
  };
}

/**
 * Lê um envio no ML e classifica. Lança LimiteML quando o orçamento acabou
 * ou o ML respondeu 429 (aí também abre o cooldown global).
 */
async function resolverEnvio(
  cache: Cache, id: string, f: FetchersEnvio, orc: Orcamento, agoraIso: string
): Promise<EnvioExpedicao> {
  const chamar = async (fn: (id: string) => Promise<RespostaML>): Promise<RespostaML> => {
    orc.reservar();
    const r = await fn(id);
    if (r.status === 429) {
      orc.bloqueado = 'cooldown';
      await cache.set(CHAVE_COOLDOWN, '1', COOLDOWN_429_S);
      throw new LimiteML('cooldown');
    }
    return r;
  };

  const rEnvio = await chamar(f.envio);
  if (rEnvio.status !== 200) return vazio(id, 'indisponivel', [`envio_http_${rEnvio.status}`]);
  const d = extrairEnvio(rEnvio.data);
  if (!d || !d.status) return vazio(id, 'indisponivel', ['envio_sem_status']);

  const base: EnvioExpedicao = {
    id, situacao: 'pendente', logistica: d.logistica, status: d.status, substatus: d.substatus,
    prazoPostagem: null, liberacaoEm: null, despachadoEm: null, consultadoEm: agoraIso, avisos: [],
  };

  if (ehFull(d.logistica)) return { ...base, situacao: 'full' };
  if (envioCancelado(d.status)) return { ...base, situacao: 'cancelado' };
  const despachou = eventoEhDespacho(d.status, d.substatus);
  if (!despachou && !STATUS_PENDENTE.has(d.status)) {
    return { ...base, situacao: 'outro', avisos: [`status_nao_mapeado:${d.status}`] };
  }

  // Prazo oficial: cache próprio → /lead_time → campo do próprio envio.
  let prazo: string | null = null;
  const prazoCache = await lerJSON<{ prazo: string | null }>(cache, chavePrazo(id));
  if (prazoCache) {
    prazo = prazoCache.prazo;
  } else {
    const rPrazo = await chamar(f.prazo);
    let lido = false;
    if (rPrazo.status === 200) {
      lido = true;
      prazo = extrairPrazo(rPrazo.data);
      if (!prazo) base.avisos.push('lead_time_sem_prazo');
    } else {
      base.avisos.push(`lead_time_http_${rPrazo.status}`);
    }
    if (!prazo && d.prazoNoEnvio) {
      prazo = d.prazoNoEnvio;
      base.avisos.push('prazo_do_envio');
    }
    // Prazo lido fica 20 min. Resposta 200 sem prazo fica 5 min (ausência
    // confirmada). Falha de rede ou HTTP de erro NÃO é cacheada.
    if (prazo) await cache.set(chavePrazo(id), JSON.stringify({ prazo }), TTL_PRAZO_S);
    else if (lido) await cache.set(chavePrazo(id), JSON.stringify({ prazo: null }), TTL_PRAZO_AUSENTE_S);
  }
  base.prazoPostagem = prazo;
  if (!prazo) base.avisos.push('prazo_nao_informado');

  // Programado (pending/buffered): o ML segura o envio até buffering.date e
  // só então libera a etiqueta e atribui o prazo de postagem. A data de
  // liberação sai em campo PRÓPRIO; não vira prazo, não entra em "a enviar"
  // nem em atraso. Se o /lead_time já trouxer prazo, ele é mantido.
  if (d.status === 'pending' && d.substatus === SUBSTATUS_PROGRAMADO) {
    base.situacao = 'programado';
    base.liberacaoEm = d.liberacao;
    if (!prazo) base.avisos.push('prazo_atribuido_apos_liberacao');
    if (!d.liberacao) base.avisos.push('liberacao_nao_informada');
    return base;
  }

  if (!despachou) return base;

  // Já saiu: a data vem do histórico. Sem ela, despachado SEM data.
  base.situacao = 'despachado';
  const rHist = await chamar(f.historico);
  if (rHist.status === 200) base.despachadoEm = extrairDespacho(rHist.data);
  else base.avisos.push(`history_http_${rHist.status}`);
  if (!base.despachadoEm && d.dataShippedNoEnvio) {
    base.despachadoEm = d.dataShippedNoEnvio;
    base.avisos.push('data_do_envio');
  }
  if (!base.despachadoEm) base.avisos.push('data_despacho_nao_informada');
  return base;
}

/** Normaliza a lista pedida: só ids numéricos, sem repetição, na ordem. */
export function normalizarIds(entrada: unknown): string[] | null {
  if (typeof entrada !== 'string') return null;
  const out: string[] = [];
  const vistos = new Set<string>();
  for (const bruto of entrada.split(',')) {
    const id = bruto.trim();
    if (!id) continue;
    if (!/^\d{5,20}$/.test(id)) return null;
    if (!vistos.has(id)) { vistos.add(id); out.push(id); }
  }
  return out.length > 0 && out.length <= MAX_IDS ? out : null;
}

export interface OpcoesConsulta {
  agora?: Date;
  concorrencia?: number;
  maxChamadas?: number;
}

export interface ResultadoConsulta {
  envios: EnvioExpedicao[];
  /** Chamadas feitas ao Mercado Livre nesta requisição. */
  chamadasML: number;
  /** Ids que ficaram para a próxima passada. */
  aguardando: number;
  cooldown: boolean;
}

/**
 * Consulta a situação de expedição de uma lista de envios.
 *
 * Erro de um envio não derruba os outros. Envio que o ML não respondeu sai
 * `indisponivel` e NÃO é cacheado — a próxima passada tenta de novo.
 */
export async function consultarEnvios(
  cache: Cache, ids: string[], f: FetchersEnvio, opcoes: OpcoesConsulta = {}
): Promise<ResultadoConsulta> {
  const agoraIso = (opcoes.agora ?? new Date()).toISOString();
  const orc = new Orcamento(Math.max(0, opcoes.maxChamadas ?? MAX_CHAMADAS_PADRAO));

  // Cooldown e cache de TODOS os envios num único MGET: a Upstash cobra por
  // comando, e esta consulta roda a cada atualização da aba.
  const [cooldown, ...emCache] = await cache.mget([CHAVE_COOLDOWN, ...ids.map(chaveEnvio)]);
  if (cooldown !== null) orc.bloqueado = 'cooldown';

  const saida = new Map<string, EnvioExpedicao>();
  const aConsultar: string[] = [];

  ids.forEach((id, i) => {
    const c = parseJSON<EnvioExpedicao>(emCache[i] ?? null);
    if (c && c.id === id) saida.set(id, c);
    else aConsultar.push(id);
  });

  const conc = Math.max(1, Math.min(opcoes.concorrencia ?? CONCORRENCIA_PADRAO, 8));
  let proximo = 0;
  async function trabalhador(): Promise<void> {
    for (;;) {
      const i = proximo++;
      if (i >= aConsultar.length) return;
      const id = aConsultar[i];
      if (orc.bloqueado) { saida.set(id, vazio(id, 'aguardando', [orc.bloqueado])); continue; }
      try {
        const e = await resolverEnvio(cache, id, f, orc, agoraIso);
        saida.set(id, e);
        if (e.situacao !== 'indisponivel') {
          await cache.set(chaveEnvio(id), JSON.stringify(e), ttlDoResultado(e, hojeBRT(opcoes.agora ?? new Date())));
        }
      } catch (err) {
        if (err instanceof LimiteML) saida.set(id, vazio(id, 'aguardando', [err.motivo]));
        else saida.set(id, vazio(id, 'indisponivel', ['erro_consulta']));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, aConsultar.length) }, trabalhador));

  const envios = ids.map(id => saida.get(id) ?? vazio(id, 'aguardando'));
  return {
    envios,
    chamadasML: orc.usadas,
    aguardando: envios.filter(e => e.situacao === 'aguardando').length,
    cooldown: orc.bloqueado === 'cooldown',
  };
}
