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
 *   GET /shipments/{id}/sla        expected_date — prazo MÁXIMO de despacho.
 *                                  Substitui estimated_handling_limit
 *                                  (/lead_time), descontinuado pelo ML em
 *                                  13/05/2025: na validação real de 21/10/2026
 *                                  o /lead_time veio sem o campo em 52 de 52
 *                                  envios, com ou sem x-format-new.
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
 *   ready_to_ship/in_hub                 já no centro da logística do ML
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
 * prazo ainda não foi atribuído (verificado em envios reais xd_drop_off em
 * 21/10/2026). Por isso o envio sai como 'programado', com
 * `liberacaoEm` em campo próprio e `prazoPostagem: null`: a data de liberação
 * não é prazo e nunca é copiada para ele. Ao sair de buffered, o envio volta
 * a ser 'pendente' e o prazo vem do /sla.
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
import { hojeBRT, ymdBRT } from '../lib/datas-brt.js';

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
  /** Prazo oficial de postagem, 'YYYY-MM-DD' (dia, em Brasília, do expected_date do /sla). */
  prazoPostagem: string | null;
  /**
   * Horário-limite do SLA, como o ML enviou (`expected_date`), quando ele traz
   * hora de verdade. null quando o prazo é só uma data (meia-noite) ou não veio.
   */
  prazoLimiteEm: string | null;
  /** `status` do /sla como o ML enviou (ex.: on_time, delayed), sem tradução. */
  slaStatus: string | null;
  /**
   * Só para 'programado': dia em que o ML LIBERA o envio (etiqueta disponível),
   * de `buffering.date`. NÃO é prazo de postagem e nunca é copiado para
   * `prazoPostagem`: o prazo oficial só é atribuído depois da liberação.
   */
  liberacaoEm: string | null;
  /**
   * Atraso segundo o PRÓPRIO Mercado Livre (GET /shipments/{id}/delays), só
   * para pendente com prazo já vencido na nossa comparação de datas:
   *   'confirmado'   o ML lista atraso para o envio (tipos em `atrasoTipos`)
   *   'nao_indicado' o ML não lista atraso (404 "Delays Not Found")
   *   null           não se aplica, ou o ML não respondeu (motivo em avisos)
   * Prazo vencido NÃO é atraso: só 'confirmado' é.
   */
  atrasoML: 'confirmado' | 'nao_indicado' | null;
  atrasoTipos: string[];
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
  /** GET /shipments/{id}/delays — atrasos que o próprio ML reconhece. */
  atrasos(id: string): Promise<RespostaML>;
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

/**
 * Substatus de ready_to_ship em que o pacote já saiu da mão do vendedor.
 * `in_hub`: o pacote está no centro da logística do ML — já foi entregue a ela
 * (caso real 48265507555, 21/10/2026, que sem isto aparecia como atrasado).
 */
export const SUBSTATUS_DESPACHO = new Set(['dropped_off', 'picked_up', 'authorized_by_carrier', 'in_hub']);

/**
 * Substatus de ready_to_ship em que o pacote AINDA está com o vendedor. Lista
 * fechada, como STATUS_PENDENTE: um substatus novo do ML não vira "pendente"
 * (e atraso falso) por exclusão — sai como 'outro', com o substatus no aviso.
 * Sem substatus conta como pendente.
 */
export const SUBSTATUS_RTS_PENDENTE = new Set([
  'ready_to_print', 'printed', 'label_generated', 'invoice_pending', 'in_packing_list',
  'ready_to_pack', 'packed', 'in_pickup_list', 'ready_for_pickup', 'ready_for_dropoff',
  'waiting_for_carrier_authorization',
]);

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
  /** Fallback de prazo quando o /sla não responde (campo antigo, descontinuado). */
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

/**
 * Dia do PRAZO a partir de um instante do ML. Meia-noite exata é data pura
 * (só a data importa): vale a data escrita. Qualquer outra hora é um INSTANTE
 * de limite (ex.: 23:59:59 -03:00, ou o mesmo em UTC): vale o dia em Brasília.
 */
export function diaDoPrazo(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (!/T\d{2}:\d{2}/.test(s) || /T00:00:00(\.0+)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) return diaDoCampo(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? ymdBRT(new Date(t)) : null;
}

/**
 * Prazo oficial de postagem de GET /shipments/{id}/sla: `expected_date`.
 * Aceita o objeto na raiz ou em `data` e, por compatibilidade, o campo
 * antigo `estimated_handling_limit.date`.
 */
export function extrairPrazo(data: unknown): string | null {
  const raiz = obj(data);
  const o = obj(raiz?.data) ?? raiz;
  return diaDoPrazo(o?.expected_date) ?? diaDoPrazo(obj(o?.estimated_handling_limit)?.date);
}

/** Instante-limite do SLA, cru, só quando tem hora real (não meia-noite). */
export function extrairLimite(data: unknown): string | null {
  const raiz = obj(data);
  const o = obj(raiz?.data) ?? raiz;
  const s = str(o?.expected_date);
  if (!s || !/T\d{2}:\d{2}/.test(s) || /T00:00:00(\.0+)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) return null;
  return Number.isFinite(Date.parse(s)) ? s : null;
}

export function extrairSlaStatus(data: unknown): string | null {
  const raiz = obj(data);
  const o = obj(raiz?.data) ?? raiz;
  return str(o?.status);
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
/** /sla respondeu 200 SEM prazo: não perguntar de novo por 5 minutos. */
export const TTL_PRAZO_AUSENTE_S = 5 * 60;
/** Janela sem chamadas ao ML depois de um 429. */
export const COOLDOWN_429_S = 60;

export const CHAVE_COOLDOWN = 'exped:cooldown';
/**
 * Versão das chaves de envio e prazo. Sobe quando a forma de LER o ML muda:
 * v2 = /lead_time com x-format-new; v3 = prazo do /sla; v4 = in_hub como
 * despacho e horário-limite do SLA (resultados v3 de in_hub diziam pendente). Resultados v1 (gravados sem o cabeçalho,
 * inclusive despachados com 60 dias de cache) deixam de ser lidos e expiram
 * sozinhos.
 */
export const VERSAO_CHAVES = 'v5';
const chaveEnvio = (id: string) => `exped:${VERSAO_CHAVES}:env:${id}`;
const chavePrazo = (id: string) => `exped:${VERSAO_CHAVES}:prazo:${id}`;
const chaveAtraso = (id: string) => `exped:${VERSAO_CHAVES}:atraso:${id}`;

/** Ids por requisição. Acima disso o dashboard fatia. */
export const MAX_IDS = 50;
/** Chamadas ao ML por requisição — cabe folgado no maxDuration de 30 s. */
export const MAX_CHAMADAS_PADRAO = 90;
/** Mesma ordem de grandeza do backfill de logística (CONCORRENCIA = 8). */
export const CONCORRENCIA_PADRAO = 6;

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
    prazoPostagem: null, prazoLimiteEm: null, slaStatus: null, liberacaoEm: null, atrasoML: null, atrasoTipos: [], despachadoEm: null, consultadoEm: null, avisos,
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
    prazoPostagem: null, prazoLimiteEm: null, slaStatus: null, liberacaoEm: null, atrasoML: null, atrasoTipos: [], despachadoEm: null, consultadoEm: agoraIso, avisos: [],
  };

  if (ehFull(d.logistica)) return { ...base, situacao: 'full' };
  if (envioCancelado(d.status)) return { ...base, situacao: 'cancelado' };
  const despachou = eventoEhDespacho(d.status, d.substatus);
  if (!despachou && !STATUS_PENDENTE.has(d.status)) {
    return { ...base, situacao: 'outro', avisos: [`status_nao_mapeado:${d.status}`] };
  }
  if (!despachou && d.status === 'ready_to_ship' && d.substatus && !SUBSTATUS_RTS_PENDENTE.has(d.substatus)) {
    return { ...base, situacao: 'outro', avisos: [`substatus_nao_mapeado:ready_to_ship/${d.substatus}`] };
  }

  // Já saiu: a data vem do histórico. O SLA não é consultado — prazo de quem
  // já despachou não muda nenhum grupo da aba e custaria 1 chamada por envio.
  if (despachou) {
    base.situacao = 'despachado';
    base.prazoPostagem = d.prazoNoEnvio;
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

  // Prazo oficial: cache próprio → /sla → campo antigo do próprio envio.
  let prazo: string | null = null;
  const prazoCache = await lerJSON<{ prazo: string | null; sla?: string | null; limite?: string | null }>(cache, chavePrazo(id));
  if (prazoCache) {
    prazo = prazoCache.prazo;
    base.slaStatus = prazoCache.sla ?? null;
    base.prazoLimiteEm = prazoCache.limite ?? null;
  } else {
    const rPrazo = await chamar(f.prazo);
    let lido = false;
    if (rPrazo.status === 200) {
      lido = true;
      prazo = extrairPrazo(rPrazo.data);
      base.slaStatus = extrairSlaStatus(rPrazo.data);
      base.prazoLimiteEm = prazo ? extrairLimite(rPrazo.data) : null;
      if (!prazo) base.avisos.push('sla_sem_prazo');
    } else {
      base.avisos.push(`sla_http_${rPrazo.status}`);
    }
    if (!prazo && d.prazoNoEnvio) {
      prazo = d.prazoNoEnvio;
      base.avisos.push('prazo_do_envio');
    }
    // Prazo lido fica 20 min. Resposta 200 sem prazo fica 5 min (ausência
    // confirmada). Falha de rede ou HTTP de erro NÃO é cacheada.
    if (prazo) await cache.set(chavePrazo(id), JSON.stringify({ prazo, sla: base.slaStatus, limite: base.prazoLimiteEm }), TTL_PRAZO_S);
    else if (lido) await cache.set(chavePrazo(id), JSON.stringify({ prazo: null, sla: base.slaStatus, limite: null }), TTL_PRAZO_AUSENTE_S);
  }
  base.prazoPostagem = prazo;
  if (!prazo) base.avisos.push('prazo_nao_informado');

  // Programado (pending/buffered): o ML segura o envio até buffering.date e
  // só então libera a etiqueta e atribui o prazo de postagem. A data de
  // liberação sai em campo PRÓPRIO; não vira prazo, não entra em "a enviar"
  // nem em atraso. Se o /sla já trouxer prazo, ele é mantido.
  if (d.status === 'pending' && d.substatus === SUBSTATUS_PROGRAMADO) {
    base.situacao = 'programado';
    base.liberacaoEm = d.liberacao;
    if (!prazo) base.avisos.push('prazo_atribuido_apos_liberacao');
    if (!d.liberacao) base.avisos.push('liberacao_nao_informada');
    return base;
  }

  // Pendente com prazo VENCIDO na nossa comparação: pergunta ao ML se ele
  // reconhece atraso. Vencido não é atrasado: só a resposta do ML confirma.
  if (prazoVencido(prazo, base.prazoLimiteEm, agoraIso)) {
    const c = await lerJSON<{ atraso: 'confirmado' | 'nao_indicado'; tipos: string[] }>(cache, chaveAtraso(id));
    if (c) {
      base.atrasoML = c.atraso; base.atrasoTipos = c.tipos;
    } else {
      const rA = await chamar(f.atrasos);
      const lido = interpretarAtrasos(rA);
      if (lido) {
        base.atrasoML = lido.atraso; base.atrasoTipos = lido.tipos;
        await cache.set(chaveAtraso(id), JSON.stringify(lido), TTL_ATRASO_S);
      } else {
        base.avisos.push(`delays_http_${rA.status}`);
      }
    }
  }
  return base;
}

/** O corpo do 404 diz que não há atraso para o envio (texto da documentação)? */
export function ehDelaysNaoEncontrado(data: unknown): boolean {
  const o = obj(data);
  const textos = [str(o?.message), str(o?.error)].filter((t): t is string => !!t);
  return textos.some(t => /delays?\s+not\s*found/i.test(t));
}

/** Atraso do ML é revisto a cada 10 min: muda raramente e custa 1 chamada. */
export const TTL_ATRASO_S = 10 * 60;

/**
 * Prazo vencido pela NOSSA comparação: o horário-limite do SLA já passou, ou,
 * sem horário, o dia do prazo é anterior a hoje em Brasília.
 */
export function prazoVencido(prazo: string | null, limite: string | null, agoraIso: string): boolean {
  if (!prazo) return false;
  if (limite) {
    const t = Date.parse(limite);
    if (Number.isFinite(t)) return t < Date.parse(agoraIso);
  }
  return prazo < (ymdBRT(new Date(agoraIso)) ?? '');
}

/**
 * GET /shipments/{id}/delays. Documentação: 404 "Delays Not Found for
 * shipment" quando não há atraso. Com atraso, uma lista de itens com `type`
 * (ex.: handling_delayed). Formato inesperado ou outro HTTP: null (não
 * cacheado, aviso no envio) — nunca vira "sem atraso" nem "atrasado".
 */
export function interpretarAtrasos(r: RespostaML): { atraso: 'confirmado' | 'nao_indicado'; tipos: string[] } | null {
  // 404 só significa "sem atraso" com a mensagem documentada ("Delays Not Found
  // for shipment"). Outro 404 (envio inexistente, rota, recurso) é desconhecido.
  if (r.status === 404) return ehDelaysNaoEncontrado(r.data) ? { atraso: 'nao_indicado', tipos: [] } : null;
  if (r.status !== 200) return null;
  const raiz = obj(r.data);
  const lista: unknown = Array.isArray(r.data) ? r.data : (raiz?.delays ?? raiz?.results ?? raiz?.data);
  if (!Array.isArray(lista)) {
    const tipo = str(raiz?.type);
    return tipo ? { atraso: 'confirmado', tipos: [tipo] } : null;
  }
  if (lista.length === 0) return { atraso: 'nao_indicado', tipos: [] };
  const tipos = lista.map(e => str(obj(e)?.type) ?? 'sem_tipo');
  return { atraso: 'confirmado', tipos: [...new Set(tipos)] };
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
  /** Ids respondidos direto do cache, sem chamada ao ML. */
  doCache: number;
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
    doCache: ids.length - aConsultar.length,
    cooldown: orc.bloqueado === 'cooldown',
  };
}
