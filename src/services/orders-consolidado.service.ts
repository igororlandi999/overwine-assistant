/**
 * orders-consolidado.service — leitura de pedidos de MAIS DE UMA conta como
 * uma base só (etapa 4 do plano multi-conta), e o perfil financeiro por conta.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O QUE "CONSOLIDAR" SIGNIFICA AQUI
 *
 * 1. As bases continuam SEPARADAS no Redis. Nada é copiado, fundido ou
 *    regravado: cada conta é lida pelo cache dela (`cacheDaConta`) e a união
 *    existe só na resposta. Desligar a consolidação não deixa resíduo.
 * 2. Todo pedido sai MARCADO com `conta` e `canal`. É a única forma de a tela
 *    abrir o detalhe de um pedido com o token do vendedor certo, e de provar
 *    que nenhum pedido apareceu na conta errada.
 * 3. Indicadores são RECALCULADOS sobre a união dos pedidos — nunca a soma de
 *    indicadores prontos. Ticket médio, SKUs distintos e cobertura não são
 *    somáveis.
 * 4. Uma conta sem snapshot publicado torna a consolidação `not_ready`. Somar
 *    só as contas que responderam apresentaria um total parcial como total.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PERFIL FINANCEIRO
 *
 * `custos.json` e `taxas.json` são da Overwine. Aplicá-los a outra empresa
 * produziria uma margem com cara de número e sem nenhum significado — pior
 * que não ter margem, porque ninguém desconfia de um número. Para uma conta
 * sem perfil:
 *  - TARIFA e FRETE saem dos valores REAIS dos pedidos e envios dela
 *    (financeiro-apurado.service), com a cobertura declarada. O total só é
 *    preenchido com 100% de cobertura; abaixo disso sai o subtotal conhecido,
 *    rotulado como subtotal;
 *  - CUSTO DE PRODUTO e MARGEM saem `null`: não há de onde tirá-los.
 * Na união, cada conta entra com o método DELA (`porConta`), e o total só
 * existe quando todas as partes existem.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * VERSÃO CONSOLIDADA
 *
 * `versao` é a SOMA das versões das contas. A versão de um snapshot só
 * cresce, então a soma cresce sempre que qualquer conta publica, e nunca
 * repete: serve à tela exatamente como a versão de uma conta só (comparar por
 * igualdade para decidir se recarrega). `versoes` traz o detalhe por conta.
 */
import type { Cache } from '../lib/cache/cache.js';
import { contaTemFinanceiro, MOTIVO_SEM_FINANCEIRO, type Conta } from '../config/contas.js';
import { type Alvo, type OrdersManifest, readSnapshot } from '../lib/orders-store.js';
import type { OrderSlim } from './orders.service.js';
import {
  getReadStatus, lerJanela, normalizarPageSize, resolverManifesto,
  type OrdersReadStatus, type OrdersRealtimeStatus, type ReadResult,
} from './orders-read.service.js';
import { montarMetrics, type MetricsResponse, type StatusSnapshot } from './orders-metrics.service.js';
import type { PeriodoYmd } from './sales-metrics.service.js';
import { lerManifesto, lerMapaEnvios } from '../lib/shipping-store.js';
import { calcularRanking, type ResultadoRanking } from './product-ranking.service.js';
import { coberturaLogistica } from './shipping-logistics.service.js';
import type { EnvioInfo } from '../lib/shipping-store.js';
import { faturamentoPeriodo } from './orders.service.js';
import { apurarFinanceiro, type ParcelaApurada } from './financeiro-apurado.service.js';
import { brtStartOfDay, brtEndOfDay } from '../lib/datas-brt.js';

/** Uma conta da seleção com o cache DELA. A rota monta; o serviço não conhece prefixo. */
export interface ContaLida {
  conta: Conta;
  cache: Cache;
}

export type PedidoMarcado = OrderSlim & { conta: string; canal: string };

export function marcar(pedidos: readonly OrderSlim[], conta: Conta): PedidoMarcado[] {
  return pedidos.map(p => ({ ...p, conta: conta.id, canal: conta.canal }));
}

// ── Perfil financeiro ───────────────────────────────────────────────────────

/** Como a tarifa e o frete de UMA conta foram obtidos no período. */
export type MetodoFinanceiro = 'estimado_taxas_da_conta' | 'apurado_pedidos_envios';

export interface FinanceiroDaConta {
  metodo: MetodoFinanceiro;
  bruto: number;
  /** ≤ 0. `null` quando a cobertura não é completa. */
  tarifaML: number | null;
  tarifaEnv: number | null;
  liquido: number | null;
  /** Só no método apurado: o que se conhece e quanto da receita cobre. */
  cobertura: { tarifaML: ParcelaApurada; frete: ParcelaApurada; liquidoConhecido: { valor: number; receitaCoberta: number; fracao: number; pedidos: number } } | null;
}

/** Um subtotal e quanto da receita bruta da seleção ele cobre. */
export interface SubtotalConhecido {
  valor: number;
  receitaCoberta: number;
  fracaoReceita: number;
}

export interface FinanceiroPublico {
  /** Custos de PRODUTO e tarifas médias próprios em todas as contas (margem possível). */
  disponivel: boolean;
  motivo: typeof MOTIVO_SEM_FINANCEIRO | null;
  /** Contas da seleção sem custos/tarifas próprios. Vazio quando disponível. */
  contasSemPerfil: string[];
  /** Presente nas métricas: tarifa, frete e líquido de cada conta, com o método. */
  porConta?: Record<string, FinanceiroDaConta>;
  /**
   * Presente nas métricas: o que se conhece da SELEÇÃO. `completo: false`
   * significa que os valores são um SUBTOTAL que cobre `fracaoReceita` do
   * bruto — não o total.
   */
  conhecido?: {
    completo: boolean;
    metodo: MetodoFinanceiro | 'misto';
    /** Cada parcela com a SUA cobertura: a da tarifa pode diferir da do frete. */
    tarifaML: SubtotalConhecido;
    tarifaEnv: SubtotalConhecido;
    /** Líquido só dos pedidos em que tarifa E frete são conhecidos. */
    liquido: SubtotalConhecido;
  };
}

export function financeiroDaSelecao(contas: readonly Conta[]): FinanceiroPublico {
  const sem = contas.filter(c => !contaTemFinanceiro(c)).map(c => c.id);
  return {
    disponivel: sem.length === 0,
    motivo: sem.length === 0 ? null : MOTIVO_SEM_FINANCEIRO,
    contasSemPerfil: sem,
  };
}

// ── Ordenação canônica da união ─────────────────────────────────────────────

/**
 * Mais recente primeiro — a mesma ordem dos chunks de uma conta. Data ausente
 * vai para o fim. Empate: ordem das contas na seleção, depois id. Determinístico
 * para a paginação não repetir nem pular pedido entre páginas.
 */
function comparar(a: PedidoMarcado, b: PedidoMarcado, ordemConta: Map<string, number>): number {
  const da = a.date_created ?? '';
  const db = b.date_created ?? '';
  if (da !== db) return da < db ? 1 : -1;
  const ca = ordemConta.get(a.conta) ?? 0;
  const cb = ordemConta.get(b.conta) ?? 0;
  if (ca !== cb) return ca - cb;
  return String(a.id).localeCompare(String(b.id));
}

// ── STATUS ──────────────────────────────────────────────────────────────────

export interface StatusConsolidado extends Omit<OrdersReadStatus, 'versao'> {
  consolidado: true;
  contas: string[];
  /** Soma das versões; `null` enquanto alguma conta não tem snapshot. */
  versao: number | null;
  versoes: Record<string, number | null>;
  contasNaoProntas: string[];
  /** Status completo de cada conta — a tela decide o refresh POR CONTA. */
  porConta: Record<string, OrdersReadStatus>;
}

const maisRecente = (vs: Array<string | null>): string | null =>
  vs.reduce<string | null>((m, v) => (v !== null && (m === null || v > m) ? v : m), null);
const maisAntigo = (vs: Array<string | null>): string | null =>
  vs.reduce<string | null>((m, v) => (v !== null && (m === null || v < m) ? v : m), null);
const maior = (vs: Array<number | null>): number | null =>
  vs.reduce<number | null>((m, v) => (v !== null && (m === null || v > m) ? v : m), null);
const menor = (vs: Array<number | null>): number | null =>
  vs.reduce<number | null>((m, v) => (v !== null && (m === null || v < m) ? v : m), null);

function fundirTempoReal(ts: OrdersRealtimeStatus[]): OrdersRealtimeStatus {
  // O evento mais recente de cada tipo vence INTEIRO (id, ação e horário do
  // mesmo evento): misturar o id de uma conta com o horário de outra criaria
  // um evento que nunca existiu.
  const ultima = <K extends keyof OrdersRealtimeStatus>(campo: K): OrdersRealtimeStatus =>
    ts.reduce((m, t) => {
      const a = m[campo] as unknown as string | null;
      const b = t[campo] as unknown as string | null;
      return b !== null && (a === null || b > a) ? t : m;
    }, ts[0]);
  const notif = ultima('ultimaNotificacaoEm');
  const proc = ultima('ultimoPedidoAtualizadoEm');
  const dreno = ultima('ultimoDrenoEm');
  const rej = ultima('ultimaRejeicaoEm');
  const erro = ultima('ultimoErroEm');
  const soma = (f: (t: OrdersRealtimeStatus) => number) => ts.reduce((s, t) => s + f(t), 0);
  return {
    habilitado: ts.some(t => t.habilitado),
    ultimaNotificacaoEm: notif.ultimaNotificacaoEm,
    ultimaNotificacaoTopico: notif.ultimaNotificacaoTopico,
    ultimaNotificacaoPedido: notif.ultimaNotificacaoPedido,
    ultimaNotificacaoSent: notif.ultimaNotificacaoSent,
    ultimoAckMs: notif.ultimoAckMs,
    ultimoDrenoPedidoEm: maisRecente(ts.map(t => t.ultimoDrenoPedidoEm)),
    ultimoPedidoAtualizadoId: proc.ultimoPedidoAtualizadoId,
    ultimoPedidoAtualizadoEm: proc.ultimoPedidoAtualizadoEm,
    ultimaAcao: proc.ultimaAcao,
    ultimaVersaoPublicada: proc.ultimaVersaoPublicada,
    ultimaLatenciaTotalMs: proc.ultimaLatenciaTotalMs,
    ultimoDrenoEm: dreno.ultimoDrenoEm,
    pendentes: soma(t => t.pendentes),
    recebidas: soma(t => t.recebidas),
    duplicadas: soma(t => t.duplicadas),
    rejeitadas: soma(t => t.rejeitadas),
    ultimoMotivoRejeicao: rej.ultimoMotivoRejeicao,
    ultimaRejeicaoEm: rej.ultimaRejeicaoEm,
    aplicadosNovos: soma(t => t.aplicadosNovos),
    aplicadosAtualizados: soma(t => t.aplicadosAtualizados),
    falhas: soma(t => t.falhas),
    ultimoErro: erro.ultimoErro,
    ultimoErroEm: erro.ultimoErroEm,
  };
}

export async function statusConsolidado(
  lidas: readonly ContaLida[],
  alvo: Alvo,
  opts: { notificacoesHabilitadas?: boolean } = {}
): Promise<StatusConsolidado> {
  const porConta: Record<string, OrdersReadStatus> = {};
  const todos: OrdersReadStatus[] = [];
  for (const l of lidas) {
    const s = await getReadStatus(l.cache, alvo, opts);
    porConta[l.conta.id] = s;
    todos.push(s);
  }
  const naoProntas = lidas.filter((_, i) => todos[i].versao === null).map(l => l.conta.id);
  const versoes: Record<string, number | null> = {};
  lidas.forEach((l, i) => { versoes[l.conta.id] = todos[i].versao; });

  // "Velho" é governado pela conta MAIS ATRASADA: a união só está em dia
  // quando todas estão. Por isso o check é o mais antigo e a idade, a maior.
  const falhou = todos.find(s => s.lastResult !== null && s.lastResult !== 'ok');
  return {
    consolidado: true,
    contas: lidas.map(l => l.conta.id),
    alvo,
    versao: naoProntas.length ? null : todos.reduce((s, t) => s + (t.versao ?? 0), 0),
    versoes,
    contasNaoProntas: naoProntas,
    totalRegistros: todos.reduce((s, t) => s + t.totalRegistros, 0),
    newestDate: maisRecente(todos.map(t => t.newestDate)),
    oldestDate: maisAntigo(todos.map(t => t.oldestDate)),
    updatedAt: maisRecente(todos.map(t => t.updatedAt)),
    origem: todos.reduce((m, t) => (t.updatedAt !== null && (m.updatedAt === null || t.updatedAt > m.updatedAt) ? t : m), todos[0]).origem,
    partial: todos.some(t => t.partial),
    lastResult: falhou ? falhou.lastResult : (todos.every(t => t.lastResult === 'ok') ? 'ok' : null),
    lastSyncAt: todos.some(t => t.lastSyncAt === null) ? null : maisAntigo(todos.map(t => t.lastSyncAt)),
    idadeSegundos: menor(todos.map(t => t.idadeSegundos)),
    agora: todos[0].agora,
    idadeCheckSegundos: todos.some(t => t.idadeCheckSegundos === null) ? null : maior(todos.map(t => t.idadeCheckSegundos)),
    ultimaRevisaoEm: todos.some(t => t.ultimaRevisaoEm === null) ? null : maisAntigo(todos.map(t => t.ultimaRevisaoEm)),
    tempoReal: fundirTempoReal(todos.map(t => t.tempoReal)),
    // Telemetria não se funde: é um diário por conta. No topo vai a da conta
    // mais atrasada (a que explica "por que a tela parou"); o resto, em porConta.
    sincronizacao: todos.reduce((m, t) => ((t.idadeCheckSegundos ?? Infinity) > (m.idadeCheckSegundos ?? Infinity) ? t : m), todos[0]).sincronizacao,
    porConta,
  };
}

// ── CURSOR CONSOLIDADO ──────────────────────────────────────────────────────

interface CursorConta { c: string; v: number; o: number }
export interface CursorConsolidado { m: CursorConta[]; a: Alvo }

export class CursorConsolidadoInvalido extends Error {
  constructor(motivo = 'cursor inválido') { super(motivo); this.name = 'CursorConsolidadoInvalido'; }
}

export function encodeCursorConsolidado(d: CursorConsolidado): string {
  return Buffer.from(JSON.stringify({ m: d.m.map(x => ({ c: x.c, v: x.v, o: x.o })), a: d.a }), 'utf-8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Validação rigorosa, como a do cursor de uma conta: qualquer desvio é
 * `invalid_cursor`. As contas do cursor precisam ser EXATAMENTE as da seleção,
 * na mesma ordem — um cursor de outra seleção não pagina esta.
 */
export function decodeCursorConsolidado(raw: string, contas: readonly string[], alvo: Alvo): CursorConsolidado {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) throw new CursorConsolidadoInvalido();
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new CursorConsolidadoInvalido();
  let obj: unknown;
  try {
    obj = JSON.parse(Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
  } catch {
    throw new CursorConsolidadoInvalido();
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new CursorConsolidadoInvalido();
  const c = obj as Record<string, unknown>;
  if (c.a !== alvo) throw new CursorConsolidadoInvalido('alvo divergente');
  if (!Array.isArray(c.m) || c.m.length !== contas.length) throw new CursorConsolidadoInvalido('contas divergentes');
  const m: CursorConta[] = c.m.map((x, i) => {
    if (!x || typeof x !== 'object') throw new CursorConsolidadoInvalido();
    const e = x as Record<string, unknown>;
    if (e.c !== contas[i]) throw new CursorConsolidadoInvalido('contas divergentes');
    if (typeof e.v !== 'number' || !Number.isInteger(e.v) || e.v <= 0) throw new CursorConsolidadoInvalido();
    if (typeof e.o !== 'number' || !Number.isInteger(e.o) || e.o < 0) throw new CursorConsolidadoInvalido();
    return { c: contas[i], v: e.v, o: e.o };
  });
  return { m, a: alvo };
}

// ── LISTAGEM ────────────────────────────────────────────────────────────────

export interface PaginaConsolidada {
  alvo: Alvo;
  consolidado: true;
  contas: string[];
  versao: number;
  versoes: Record<string, number>;
  totalRegistros: number;
  pageSize: number;
  items: PedidoMarcado[];
  nextCursor: string | null;
  servedFrom: 'atual' | 'previous';
}

/**
 * Página da união, mais recente primeiro. Intercala as contas (k-way merge):
 * lê de cada uma no máximo `pageSize` pedidos a partir do offset dela, leva os
 * `pageSize` mais recentes do conjunto e avança cada offset SÓ pelo que aquela
 * conta cedeu à página. Nenhum pedido se repete ou se perde entre páginas.
 */
export async function paginaConsolidada(
  lidas: readonly ContaLida[],
  alvo: Alvo,
  rawCursor: string | null,
  rawPageSize: unknown
): Promise<ReadResult<PaginaConsolidada>> {
  const ids = lidas.map(l => l.conta.id);
  let cursor: CursorConsolidado | null = null;
  if (rawCursor !== null && rawCursor !== undefined && rawCursor !== '') {
    try {
      cursor = decodeCursorConsolidado(rawCursor, ids, alvo);
    } catch (e) {
      if (e instanceof CursorConsolidadoInvalido) return { ok: false, code: 'invalid_cursor' };
      throw e;
    }
  }
  const pageSize = normalizarPageSize(rawPageSize);

  const mans: Array<{ man: OrdersManifest; servedFrom: 'atual' | 'previous'; offset: number }> = [];
  let mudou: { versao: number; totalRegistros: number } | null = null;
  const atuais: Array<{ versao: number; totalRegistros: number }> = [];
  for (let i = 0; i < lidas.length; i++) {
    const cur = cursor ? { v: cursor.m[i].v, o: cursor.m[i].o, a: alvo } : null;
    const r = await resolverManifesto(lidas[i].cache, alvo, cur);
    if (r.tipo === 'not_ready') return { ok: false, code: 'not_ready' };
    if (r.tipo === 'snapshot_changed') {
      mudou = { versao: r.versao, totalRegistros: r.totalRegistros };
      atuais.push(mudou);
      continue;
    }
    mans.push({ man: r.man, servedFrom: r.servedFrom, offset: r.offset });
    atuais.push({ versao: r.man.versao, totalRegistros: r.man.totalRegistros });
  }
  if (mudou) {
    // A versão devolvida é a CONSOLIDADA atual, para a tela reiniciar nela.
    const st = await statusConsolidado(lidas, alvo);
    return {
      ok: false, code: 'snapshot_changed',
      versao: st.versao ?? atuais.reduce((s, a) => s + a.versao, 0),
      totalRegistros: st.totalRegistros,
    };
  }

  const ordemConta = new Map(ids.map((id, i) => [id, i]));
  const janelas: PedidoMarcado[][] = [];
  try {
    for (let i = 0; i < lidas.length; i++) {
      const j = await lerJanela(lidas[i].cache, mans[i].man, mans[i].offset, pageSize);
      janelas.push(marcar(j, lidas[i].conta));
    }
  } catch {
    return { ok: false, code: 'inconsistente' };
  }

  const pos = janelas.map(() => 0);
  const items: PedidoMarcado[] = [];
  while (items.length < pageSize) {
    let escolhida = -1;
    for (let i = 0; i < janelas.length; i++) {
      if (pos[i] >= janelas[i].length) continue;
      if (escolhida === -1 || comparar(janelas[i][pos[i]], janelas[escolhida][pos[escolhida]], ordemConta) < 0) {
        escolhida = i;
      }
    }
    if (escolhida === -1) break;
    items.push(janelas[escolhida][pos[escolhida]]);
    pos[escolhida]++;
  }

  const proximos = mans.map((m, i) => m.offset + pos[i]);
  const acabou = mans.every((m, i) => proximos[i] >= m.man.totalRegistros);
  const versoes: Record<string, number> = {};
  mans.forEach((m, i) => { versoes[ids[i]] = m.man.versao; });

  return {
    ok: true,
    value: {
      alvo,
      consolidado: true,
      contas: ids,
      versao: mans.reduce((s, m) => s + m.man.versao, 0),
      versoes,
      totalRegistros: mans.reduce((s, m) => s + m.man.totalRegistros, 0),
      pageSize,
      items,
      nextCursor: acabou
        ? null
        : encodeCursorConsolidado({ m: mans.map((m, i) => ({ c: ids[i], v: m.man.versao, o: proximos[i] })), a: alvo }),
      servedFrom: mans.some(m => m.servedFrom === 'previous') ? 'previous' : 'atual',
    },
  };
}

// ── LEITURA INTEIRA (métricas e margem) ─────────────────────────────────────

export interface BaseLida {
  conta: Conta;
  cache: Cache;
  status: OrdersReadStatus;
  pedidos: PedidoMarcado[];
  /** Mapa de envios DA CONTA (custo real de frete). Vazio quando não há. */
  envios: Map<string, EnvioInfo>;
}

export type LeituraBases =
  | { ok: true; bases: BaseLida[] }
  | { ok: false; code: 'not_ready'; contasNaoProntas: string[] };

/** Uma leitura de snapshot POR CONTA. Conta vazia ou ilegível torna tudo `not_ready`. */
export async function lerBases(lidas: readonly ContaLida[]): Promise<LeituraBases> {
  const bases: BaseLida[] = [];
  const naoProntas: string[] = [];
  for (const l of lidas) {
    const status = await getReadStatus(l.cache, 'ativos');
    if (status.versao === null || status.totalRegistros <= 0 || !status.oldestDate || !status.newestDate) {
      naoProntas.push(l.conta.id);
      continue;
    }
    let pedidos: OrderSlim[];
    try {
      pedidos = await readSnapshot(l.cache, 'ativos');
    } catch {
      naoProntas.push(l.conta.id);
      continue;
    }
    if (pedidos.length === 0) { naoProntas.push(l.conta.id); continue; }
    bases.push({ conta: l.conta, cache: l.cache, status, pedidos: marcar(pedidos, l.conta), envios: await lerMapaEnvios(l.cache) });
  }
  if (naoProntas.length) return { ok: false, code: 'not_ready', contasNaoProntas: naoProntas };
  return { ok: true, bases };
}

function statusDaUniao(bases: readonly BaseLida[]): StatusSnapshot & { lastSyncAt: string | null; lastResult: string | null } {
  const ss = bases.map(b => b.status);
  const falhou = ss.find(s => s.lastResult !== null && s.lastResult !== 'ok');
  return {
    versao: ss.reduce((s, t) => s + (t.versao ?? 0), 0),
    totalRegistros: ss.reduce((s, t) => s + t.totalRegistros, 0),
    oldestDate: maisAntigo(ss.map(t => t.oldestDate)),
    newestDate: maisRecente(ss.map(t => t.newestDate)),
    updatedAt: maisRecente(ss.map(t => t.updatedAt)),
    origem: ss.reduce((m, t) => (t.updatedAt !== null && (m.updatedAt === null || t.updatedAt > m.updatedAt) ? t : m), ss[0]).origem,
    partial: ss.some(t => t.partial),
    lastSyncAt: ss.some(t => t.lastSyncAt === null) ? null : maisAntigo(ss.map(t => t.lastSyncAt)),
    lastResult: falhou ? falhou.lastResult : (ss.every(t => t.lastResult === 'ok') ? 'ok' : null),
  };
}

function unir(bases: readonly BaseLida[]): PedidoMarcado[] {
  const ordemConta = new Map(bases.map((b, i) => [b.conta.id, i]));
  return bases.flatMap(b => b.pedidos).sort((a, b) => comparar(a, b, ordemConta));
}

// ── MÉTRICAS ────────────────────────────────────────────────────────────────

type FaturamentoComPerfil = MetricsResponse['periodo']['faturamento'];
/**
 * Faturamento de uma seleção que inclui conta sem perfil. Os três valores são
 * o TOTAL da seleção e só existem quando todas as contas os têm completos;
 * o que se conhece antes disso está em `financeiro.conhecido`.
 */
export interface FaturamentoSemPerfil {
  bruto: number;
  tarifaML: number | null;
  tarifaEnv: number | null;
  liquido: number | null;
  /** true quando alguma parte do total é estimativa (a parte da Overwine). */
  estimado: boolean;
  fonte: string;
  metodologia: string;
}

/**
 * Junta o financeiro das contas da seleção: o TOTAL (só quando todas as partes
 * existem) e o que se CONHECE (conta completa entra inteira; incompleta, com o
 * subtotal dela e a receita que ele cobre).
 */
export function apurarSelecao(finPorConta: Record<string, FinanceiroDaConta>, bruto: number) {
  const partes = Object.values(finPorConta);
  const todas = (f: (p: FinanceiroDaConta) => number | null): number | null =>
    partes.every(p => f(p) !== null) ? partes.reduce((s, p) => s + (f(p) as number), 0) : null;
  const metodos = new Set(partes.map(p => p.metodo));
  const metodo: MetodoFinanceiro | 'misto' = metodos.size === 1 ? partes[0].metodo : 'misto';
  const temEstimativa = metodos.has('estimado_taxas_da_conta');

  const sub = (): SubtotalConhecido => ({ valor: 0, receitaCoberta: 0, fracaoReceita: 0 });
  const cT = sub(), cF = sub(), cL = sub();
  const somar = (a: SubtotalConhecido, valor: number, receita: number) => { a.valor += valor; a.receitaCoberta += receita; };
  for (const p of partes) {
    if (p.cobertura) {
      somar(cT, p.cobertura.tarifaML.conhecida, p.cobertura.tarifaML.receitaCoberta);
      somar(cF, p.cobertura.frete.conhecida, p.cobertura.frete.receitaCoberta);
      somar(cL, p.cobertura.liquidoConhecido.valor, p.cobertura.liquidoConhecido.receitaCoberta);
    } else {
      somar(cT, p.tarifaML ?? 0, p.bruto);
      somar(cF, p.tarifaEnv ?? 0, p.bruto);
      somar(cL, p.liquido ?? 0, p.bruto);
    }
  }
  for (const a of [cT, cF, cL]) a.fracaoReceita = bruto > 0 ? a.receitaCoberta / bruto : 1;
  return {
    bruto, todas, metodo, temEstimativa,
    conhecido: { completo: partes.every(p => p.liquido !== null), metodo, tarifaML: cT, tarifaEnv: cF, liquido: cL },
  };
}

/** Tarifa, frete e líquido de UMA conta no período, pelo método dela. */
export function financeiroDaConta(b: BaseLida, periodo: PeriodoYmd): FinanceiroDaConta {
  const ini = brtStartOfDay(periodo.fromYmd);
  const fim = brtEndOfDay(periodo.toYmd);
  if (contaTemFinanceiro(b.conta)) {
    const f = faturamentoPeriodo(b.pedidos, ini, fim);
    return { metodo: 'estimado_taxas_da_conta', bruto: f.bruto, tarifaML: f.tarifaML, tarifaEnv: f.tarifaEnv, liquido: f.liquido, cobertura: null };
  }
  const a = apurarFinanceiro(b.pedidos, ini, fim, b.envios);
  return {
    metodo: 'apurado_pedidos_envios',
    bruto: a.bruto,
    tarifaML: a.tarifaML.valor,
    tarifaEnv: a.frete.valor,
    liquido: a.liquido,
    cobertura: { tarifaML: a.tarifaML, frete: a.frete, liquidoConhecido: a.liquidoConhecido },
  };
}

export interface ResumoContaMetrics {
  versao: number;
  totalRegistros: number;
  oldestDate: string | null;
  newestDate: string | null;
  updatedAt: string | null;
  financeiro: boolean;
  janelas: MetricsResponse['janelas'];
  periodo: { bruto: number; pedidosPorItem: number };
  financeiroPeriodo: FinanceiroDaConta;
}

export type MetricsDaSelecao = Omit<MetricsResponse, 'periodo'> & {
  periodo: Omit<MetricsResponse['periodo'], 'faturamento'> & {
    faturamento: FaturamentoComPerfil | FaturamentoSemPerfil;
  };
  contas: string[];
  consolidado: boolean;
  financeiro: FinanceiroPublico;
  versoes: Record<string, number>;
  porConta: Record<string, ResumoContaMetrics>;
};

/**
 * Métricas da seleção (uma conta não legada, ou várias). Os indicadores saem
 * de `montarMetrics` aplicado à UNIÃO dos pedidos — a mesma função, as mesmas
 * regras, outra base. `porConta` repete janelas e bruto de cada conta isolada,
 * para a tela (e o teste) conferirem que a união bate com as partes.
 */
export function metricsDaSelecao(
  bases: readonly BaseLida[],
  periodo: PeriodoYmd,
  agora: Date = new Date()
): MetricsDaSelecao {
  const contas = bases.map(b => b.conta);
  const financeiro = financeiroDaSelecao(contas);
  const m = montarMetrics(unir(bases), statusDaUniao(bases), periodo, agora);

  const porConta: Record<string, ResumoContaMetrics> = {};
  const versoes: Record<string, number> = {};
  const finPorConta: Record<string, FinanceiroDaConta> = {};
  for (const b of bases) {
    const mc = montarMetrics(b.pedidos, b.status, periodo, agora);
    finPorConta[b.conta.id] = financeiroDaConta(b, periodo);
    versoes[b.conta.id] = b.status.versao ?? 0;
    porConta[b.conta.id] = {
      versao: b.status.versao ?? 0,
      totalRegistros: b.status.totalRegistros,
      oldestDate: b.status.oldestDate,
      newestDate: b.status.newestDate,
      updatedAt: b.status.updatedAt,
      financeiro: contaTemFinanceiro(b.conta),
      janelas: mc.janelas,
      periodo: { bruto: mc.periodo.faturamento.bruto, pedidosPorItem: mc.periodo.porItem.reduce((s, i) => s + i.pedidos, 0) },
      financeiroPeriodo: finPorConta[b.conta.id],
    };
  }

  const ap = apurarSelecao(finPorConta, m.periodo.faturamento.bruto);
  financeiro.porConta = finPorConta;
  financeiro.conhecido = ap.conhecido;
  const { bruto, todas, metodo, temEstimativa } = ap;

  const faturamento: FaturamentoComPerfil | FaturamentoSemPerfil = financeiro.disponivel
    ? m.periodo.faturamento
    : {
      bruto,
      tarifaML: todas(p => p.tarifaML),
      tarifaEnv: todas(p => p.tarifaEnv),
      liquido: todas(p => p.liquido),
      estimado: temEstimativa,
      fonte: metodo,
      metodologia: metodo === 'apurado_pedidos_envios'
        ? 'Tarifa de venda real de cada item (sale_fee x quantidade) e frete real pago pelo vendedor em cada envio. Sem percentuais.'
        : 'Misto: contas com tabela propria entram com a estimativa da tabela delas; as demais, com tarifa e frete reais dos pedidos e envios. Ver financeiro.porConta.',
    };

  return {
    ...m,
    periodo: { ...m.periodo, faturamento },
    contas: contas.map(c => c.id),
    consolidado: contas.length > 1,
    financeiro,
    versoes,
    porConta,
  };
}

// ── LOGÍSTICA ───────────────────────────────────────────────────────────────

export async function logisticaDaSelecao(lidas: readonly ContaLida[]) {
  const porTipo: Record<string, string[]> = {};
  const versoes: Record<string, number | null> = {};
  const atualizacoes: Array<string | null> = [];
  let total = 0;
  for (const l of lidas) {
    const mapa = await lerMapaEnvios(l.cache);
    const man = await lerManifesto(l.cache);
    versoes[l.conta.id] = man?.versao ?? null;
    atualizacoes.push(man?.updatedAt ?? null);
    total += mapa.size;
    for (const [shipmentId, info] of mapa) (porTipo[info.logisticType] ??= []).push(shipmentId);
  }
  for (const ids of Object.values(porTipo)) ids.sort();
  const vs = Object.values(versoes);
  return {
    ok: true as const,
    consolidado: lidas.length > 1,
    contas: lidas.map(l => l.conta.id),
    versao: vs.every(v => v === null) ? null : vs.reduce<number>((s, v) => s + (v ?? 0), 0),
    versoes,
    updatedAt: maisRecente(atualizacoes),
    total,
    porTipo,
  };
}

// ── MARGEM ──────────────────────────────────────────────────────────────────

/**
 * Margem da seleção. COM perfil em todas as contas (hoje: só a Overwine
 * sozinha, que nem passa por aqui) os custos valem. SEM perfil em qualquer
 * uma, a resposta traz só o que não depende de custo nem de tarifa — receita,
 * unidades, pedidos por SKU — e todo o resto `null`.
 *
 * As linhas NÃO são fundidas entre contas: o mesmo código de SKU em duas
 * empresas são dois produtos, com dois estoques e dois custos. Cada linha leva
 * a conta dela, e `skusDistintos` é a soma por conta.
 */
export async function margemDaSelecao(bases: readonly BaseLida[], periodo: PeriodoYmd) {
  const contas = bases.map(b => b.conta);
  const financeiro = financeiroDaSelecao(contas);
  const uniao = statusDaUniao(bases);

  const rankings: Array<{ base: BaseLida; r: ResultadoRanking; envios: { resolvidos: number; totalDistintos: number } }> = [];
  for (const b of bases) {
    const mapa = await lerMapaEnvios(b.cache);
    const r = calcularRanking(
      b.pedidos,
      { fromYmd: periodo.fromYmd, toYmd: periodo.toYmd },
      {
        // Cobertura da UNIÃO: o período pedido vale para a seleção inteira. A
        // conta mais nova não "encolhe" a janela da mais antiga.
        oldestDate: uniao.oldestDate ?? b.status.oldestDate!,
        newestDate: uniao.newestDate ?? b.status.newestDate!,
        partial: uniao.partial,
        lastSyncAt: uniao.lastSyncAt,
        lastResult: uniao.lastResult,
      },
      { criterio: 'revenue', todos: true, mapaLogistica: mapa }
    );
    const cob = coberturaLogistica(b.pedidos, mapa);
    rankings.push({ base: b, r, envios: { resolvidos: cob.resolvidos, totalDistintos: cob.totalDistintos } });
  }

  const linhas = rankings.flatMap(({ base, r }) => r.linhas.map(l => ({ conta: base.conta.id, l })))
    .sort((a, b) => (b.l.receitaProdutos - a.l.receitaProdutos) || a.conta.localeCompare(b.conta) || a.l.sku.localeCompare(b.l.sku));

  // Tarifa e frete REAIS (ou a estimativa propria da conta com perfil). Custo
  // de produto continua sem fonte: margem segue null.
  const finPorConta: Record<string, FinanceiroDaConta> = {};
  for (const b of bases) finPorConta[b.conta.id] = financeiroDaConta(b, periodo);
  const ap = apurarSelecao(finPorConta, Object.values(finPorConta).reduce((s, p) => s + p.bruto, 0));
  financeiro.porConta = finPorConta;
  financeiro.conhecido = ap.conhecido;
  const totTarifa = ap.todas(p => p.tarifaML);
  const totFrete = ap.todas(p => p.tarifaEnv);
  const totLiquido = ap.todas(p => p.liquido);

  const enviosConhecidos = rankings.reduce((s, x) => s + x.envios.resolvidos, 0);
  const enviosTotal = rankings.reduce((s, x) => s + x.envios.totalDistintos, 0);
  const primeiro = rankings[0].r;
  const disponivel = rankings.some(x => x.r.disponivel);

  return {
    ok: true as const,
    contas: contas.map(c => c.id),
    consolidado: contas.length > 1,
    financeiro,
    periodo: { fromYmd: periodo.fromYmd, toYmd: periodo.toYmd },
    cobertura: {
      disponivel,
      tipo: rankings.every(x => x.r.cobertura === primeiro.cobertura) ? primeiro.cobertura : 'parcial' as const,
      fromYmd: maisAntigo(rankings.map(x => x.r.periodoCalculado?.fromYmd ?? null)),
      toYmd: maisRecente(rankings.map(x => x.r.periodoCalculado?.toYmd ?? null)),
    },
    totais: {
      receitaProdutos: rankings.reduce((s, x) => s + x.r.totais.receitaProdutos, 0),
      unidades: rankings.reduce((s, x) => s + x.r.totais.unidades, 0),
      skusDistintos: rankings.reduce((s, x) => s + x.r.totais.skusDistintos, 0),
      // Positivos, como no restante deste recurso. `null` = cobertura incompleta.
      // Base: o faturamento do período (paid_amount), a mesma de /metrics.
      tarifaML: totTarifa === null ? null : -totTarifa,
      tarifaEnvio: totFrete === null ? null : -totFrete,
      receitaLiquida: totLiquido,
      custoTotal: null,
      margem: null,
      margemPct: null,
      receitaComCusto: null,
    },
    porSku: linhas.map(({ conta, l }) => ({
      conta,
      sku: l.sku,
      semSku: l.semSku,
      label: l.label,
      itemIds: l.itemIds,
      unidades: l.unidades,
      pedidos: l.pedidos,
      receitaProdutos: l.receitaProdutos,
      receitaComCusto: null,
      custoCobertura: null,
      custoTotal: null,
      tarifaML: null,
      tarifaEnvio: null,
      margem: null,
      margemPct: null,
    })),
    semCusto: null,
    logistica: {
      enviosConhecidos,
      enviosTotal,
      fracao: enviosTotal > 0 ? enviosConhecidos / enviosTotal : 1,
    },
    frete: null,
    antesDePublicidade: true as const,
    estimado: true as const,
    warnings: Array.from(new Set([MOTIVO_SEM_FINANCEIRO, ...rankings.flatMap(x => x.r.warnings)])),
  };
}
