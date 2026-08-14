/**
 * orders-metrics.service — agregados prontos para o boot do dashboard.
 *
 * Serviço PURO de composição: NÃO reimplementa nenhuma regra financeira. Cada
 * campo é delegado à função já portada e testada correspondente, para que os
 * números batam exatamente com o card que o usuário vê hoje.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CONVENÇÕES DE VALOR (diferentes de propósito — não uniformizar)
 *
 *  janelas.*            → sales-metrics.calcularConsulta
 *                         só 'paid'; receita = paid_amount ?? 0 (SEM fallback);
 *                         unidades sobre TODOS os order_items.
 *                         Paridade: card renderPedidos e chatbot (Fase 5g).
 *
 *  periodo.faturamento  → orders.faturamentoPeriodo
 *  reputacao60d         → só 'paid'; bruto = paid_amount || total_amount;
 *                         tarifas de config/taxas.json (estimado: true).
 *                         Paridade: calcLiquidoPeriodo e renderCardReputacao.
 *
 *  periodo.porItem      → orders.vendasPorItem
 *                         exclui 'cancelled' (pendentes CONTAM); indexa SOMENTE
 *                         order_items[0]; receita = paid_amount do pedido
 *                         inteiro (quirk legado preservado).
 *                         Paridade: loadPeriodoData.
 *
 *  estoque30d.porItem   → orders.unidadesPorItem
 *                         exclui 'cancelled'; TODOS os order_items; quantity||1.
 *                         Paridade: estGetSKUData.
 *
 *  faturamentoMensal    → orders.faturamentoMensal
 *                         só 'paid'; mês = date_created.slice(0,7) textual.
 *                         Paridade: renderChartFaturamento.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CANCELADOS — LIMITAÇÃO DELIBERADA E DOCUMENTADA
 *
 * A fonte é SEMPRE o snapshot `ativos`. A sincronização de `ativos` busca a
 * listagem do ML sem filtro de status (orders-sync: statusFetch = undefined
 * quando alvo !== 'cancelados'), então pedidos cancelados PODEM aparecer no
 * snapshot — mas NADA no contrato, no manifesto ou nos testes garante que o
 * conjunto de cancelados esteja COMPLETO, e `toSlim` descarta `cancel_detail`.
 * O dashboard obtém cancelados por uma busca dedicada no proxy
 * (loadCancelledOrders), que não é tocada aqui.
 *
 * Consequência: `porStatus` NUNCA inclui a chave 'cancelled', nem mesmo como
 * zero. O bloco `cancelados` declara a indisponibilidade explicitamente. Um
 * número parcial apresentado como total seria pior do que número nenhum.
 */
import {
  contarPorStatus,
  faturamentoMensal,
  faturamentoPeriodo,
  unidadesPorItem,
  vendasPorItem,
  type OrderSlim,
  type SerieMensal,
} from './orders.service.js';
import {
  calcularConsulta,
  type CoberturaSnapshot,
  type MetricasVendas,
  type PeriodoYmd,
  type ResultadoConsulta,
} from './sales-metrics.service.js';
import { brtStartOfDay, brtEndOfDay, hojeBRT, ymdBRT } from '../lib/datas-brt.js';

// ── contrato de saída ───────────────────────────────────────────────────────

export interface JanelaPublica {
  /** null quando o período está fora da janela de dados — nunca zero disfarçado. */
  receita: number | null;
  pedidos: number | null;
  unidades: number | null;
  ticketMedio: number | null;
  fromYmd: string;
  toYmd: string;
  disponivel: boolean;
  cobertura: 'total' | 'parcial' | 'indisponivel';
}

export interface FaturamentoPublico {
  bruto: number;
  tarifaML: number;
  tarifaEnv: number;
  liquido: number;
  estimado: true;
  fonte: string;
  metodologia: string;
}

export interface ItemPeriodo {
  itemId: string;
  pedidos: number;
  unidades: number;
  receita: number;
}

export interface ItemUnidades {
  itemId: string;
  unidades: number;
}

export interface MetricsResponse {
  versao: number;
  updatedAt: string | null;
  origem: string | null;
  coverage: {
    oldestDate: string | null;
    newestDate: string | null;
    dataFromYmd: string | null;
    dataToYmd: string | null;
    partial: boolean;
    totalRegistros: number;
    alvo: 'ativos';
  };
  /** Contagem por status observada no snapshot 'ativos'. NUNCA contém 'cancelled'. */
  porStatus: Record<string, number>;
  cancelados: {
    disponivel: false;
    total: null;
    motivo: 'fora_do_escopo_do_snapshot_ativos';
    fonte: 'carga_sob_demanda_no_dashboard';
  };
  janelas: {
    hoje: JanelaPublica;
    ultimos7: JanelaPublica;
    mesAtual: JanelaPublica;
    historico: JanelaPublica;
  };
  periodo: {
    fromYmd: string;
    toYmd: string;
    faturamento: FaturamentoPublico;
    porItem: ItemPeriodo[];
  };
  reputacao60d: {
    fromYmd: string;
    toYmd: string;
    bruto: number;
  };
  estoque30d: {
    fromYmd: string;
    toYmd: string;
    porItem: ItemUnidades[];
  };
  faturamentoMensal: SerieMensal[];
  warnings: string[];
}

/** Metadados do snapshot exigidos para montar a resposta. */
export interface StatusSnapshot {
  versao: number | null;
  totalRegistros: number;
  oldestDate: string | null;
  newestDate: string | null;
  updatedAt: string | null;
  origem: string | null;
  partial: boolean;
}

export const REPUTACAO_DIAS = 60; // ML_REPUTATION_TARGETS.periodoDias no dashboard
export const ESTOQUE_DIAS = 30;   // janela de estGetSKUData

// ── helpers de data (todos delegam a datas-brt; nada de fuso reimplementado) ─

/** YMD de `dias` atrás, contado a partir de `hojeYmd` (inclusive, como o dashboard). */
export function ymdMenosDias(hojeYmd: string, dias: number): string {
  const base = brtStartOfDay(hojeYmd);
  if (!base) return hojeYmd;
  return ymdBRT(new Date(base.getTime() - dias * 86400000)) || hojeYmd;
}

function janela(
  pedidos: OrderSlim[],
  periodo: PeriodoYmd,
  cobertura: CoberturaSnapshot
): { publica: JanelaPublica; warnings: string[] } {
  const r: ResultadoConsulta = calcularConsulta(pedidos, periodo, cobertura);
  const m: MetricasVendas | null = r.metricas;
  return {
    publica: {
      receita: m ? m.receita : null,
      pedidos: m ? m.pedidos : null,
      unidades: m ? m.unidades : null,
      ticketMedio: m ? m.ticketMedio : null,
      fromYmd: periodo.fromYmd,
      toYmd: periodo.toYmd,
      disponivel: r.disponivel,
      cobertura: r.cobertura,
    },
    warnings: r.warnings,
  };
}

// ── montagem ────────────────────────────────────────────────────────────────

/**
 * Monta a resposta agregada. Recebe os pedidos JÁ LIDOS (uma única leitura de
 * snapshot pela rota) e o status do manifesto. Não faz I/O.
 */
export function montarMetrics(
  pedidos: OrderSlim[],
  status: StatusSnapshot,
  periodo: PeriodoYmd,
  agora: Date = new Date()
): MetricsResponse {
  const hoje = hojeBRT(agora);
  const cobertura: CoberturaSnapshot = {
    oldestDate: status.oldestDate,
    newestDate: status.newestDate,
    partial: status.partial,
  };

  // ── janelas fixas (regra sales-metrics) ──
  const jHoje = janela(pedidos, { fromYmd: hoje, toYmd: hoje }, cobertura);
  const j7 = janela(pedidos, { fromYmd: ymdMenosDias(hoje, 6), toYmd: hoje }, cobertura);
  const jMes = janela(pedidos, { fromYmd: hoje.slice(0, 7) + '-01', toYmd: hoje }, cobertura);
  const jHist = janela(
    pedidos,
    {
      fromYmd: ymdBRT(status.oldestDate) || hoje,
      toYmd: ymdBRT(status.newestDate) || hoje,
    },
    cobertura
  );

  // ── período selecionado (regras faturamentoPeriodo + vendasPorItem) ──
  const ini = brtStartOfDay(periodo.fromYmd);
  const fim = brtEndOfDay(periodo.toYmd);
  const fat = faturamentoPeriodo(pedidos, ini, fim);
  const porItem: ItemPeriodo[] = Array.from(vendasPorItem(pedidos, ini, fim).values())
    .map(v => ({ itemId: v.itemId, pedidos: v.pedidos, unidades: v.unidades, receita: v.receita }))
    .sort((a, b) => (b.receita - a.receita) || a.itemId.localeCompare(b.itemId));

  // ── reputação: bruto dos últimos 60 dias (regra faturamentoPeriodo) ──
  const repDe = ymdMenosDias(hoje, REPUTACAO_DIAS);
  const fatRep = faturamentoPeriodo(pedidos, brtStartOfDay(repDe), brtEndOfDay(hoje));

  // ── estoque: unidades por item nos últimos 30 dias (regra unidadesPorItem) ──
  const estDe = ymdMenosDias(hoje, ESTOQUE_DIAS);
  const est30: ItemUnidades[] = Array.from(
    unidadesPorItem(pedidos, brtStartOfDay(estDe), brtEndOfDay(hoje)).entries()
  )
    .map(([itemId, unidades]) => ({ itemId, unidades }))
    .sort((a, b) => (b.unidades - a.unidades) || a.itemId.localeCompare(b.itemId));

  // ── contagem por status, SEM 'cancelled' (ver nota do cabeçalho) ──
  const contagem = contarPorStatus(pedidos);
  const porStatus: Record<string, number> = {};
  for (const k of Object.keys(contagem).sort()) {
    if (k === 'cancelled') continue;
    porStatus[k] = contagem[k];
  }

  const warnings = Array.from(new Set([
    ...jHoje.warnings, ...j7.warnings, ...jMes.warnings, ...jHist.warnings,
  ]));

  return {
    versao: status.versao ?? 0,
    updatedAt: status.updatedAt,
    origem: status.origem,
    coverage: {
      oldestDate: status.oldestDate,
      newestDate: status.newestDate,
      dataFromYmd: ymdBRT(status.oldestDate),
      dataToYmd: ymdBRT(status.newestDate),
      partial: status.partial,
      totalRegistros: status.totalRegistros,
      alvo: 'ativos',
    },
    porStatus,
    cancelados: {
      disponivel: false,
      total: null,
      motivo: 'fora_do_escopo_do_snapshot_ativos',
      fonte: 'carga_sob_demanda_no_dashboard',
    },
    janelas: {
      hoje: jHoje.publica,
      ultimos7: j7.publica,
      mesAtual: jMes.publica,
      historico: jHist.publica,
    },
    periodo: {
      fromYmd: periodo.fromYmd,
      toYmd: periodo.toYmd,
      faturamento: {
        bruto: fat.bruto,
        tarifaML: fat.tarifaML,
        tarifaEnv: fat.tarifaEnv,
        liquido: fat.liquido,
        estimado: true,
        fonte: fat.fonte,
        metodologia: fat.metodologia,
      },
      porItem,
    },
    reputacao60d: { fromYmd: repDe, toYmd: hoje, bruto: fatRep.bruto },
    estoque30d: { fromYmd: estDe, toYmd: hoje, porItem: est30 },
    faturamentoMensal: faturamentoMensal(pedidos),
    warnings,
  };
}

// ── validação de parâmetros ─────────────────────────────────────────────────

export const DIAS_MIN = 1;
export const DIAS_MAX = 730;          // 2 anos: cobre a sazonalidade de 24 meses
export const INTERVALO_MAX_DIAS = 730;

export type ParamsErro =
  | 'parametro_desconhecido'
  | 'dias_invalido'
  | 'dias_fora_do_limite'
  | 'combinacao_invalida'
  | 'intervalo_incompleto'
  | 'data_invalida'
  | 'intervalo_invertido'
  | 'intervalo_excessivo';

export type ParamsResultado =
  | { ok: true; periodo: PeriodoYmd }
  | { ok: false; erro: ParamsErro };

const RE_YMD = /^\d{4}-\d{2}-\d{2}$/;

/** YMD sintaticamente válido E existente no calendário (rejeita 31/02). */
function dataReal(ymd: string): boolean {
  if (!RE_YMD.test(ymd)) return false;
  const [a, m, d] = ymd.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const dias = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return d <= dias;
}

/**
 * Resolve o período a partir da query. Determinístico e sem I/O.
 * Aceita `dias` OU `from`+`to`, nunca os dois. Sem nenhum parâmetro de período,
 * usa o padrão do dashboard (7 dias, hoje incluso).
 */
export function resolverPeriodo(
  query: Record<string, unknown>,
  agora: Date = new Date(),
  diasPadrao = 7
): ParamsResultado {
  const permitidos = new Set(['resource', 'alvo', 'dias', 'from', 'to']);
  for (const k of Object.keys(query)) {
    if (!permitidos.has(k)) return { ok: false, erro: 'parametro_desconhecido' };
  }

  const dias = query.dias;
  const from = query.from;
  const to = query.to;
  const temDias = dias !== undefined && dias !== '';
  const temFrom = from !== undefined && from !== '';
  const temTo = to !== undefined && to !== '';

  if (temDias && (temFrom || temTo)) return { ok: false, erro: 'combinacao_invalida' };

  const hoje = hojeBRT(agora);

  if (temFrom || temTo) {
    if (!temFrom || !temTo) return { ok: false, erro: 'intervalo_incompleto' };
    if (typeof from !== 'string' || typeof to !== 'string') return { ok: false, erro: 'data_invalida' };
    if (!dataReal(from) || !dataReal(to)) return { ok: false, erro: 'data_invalida' };
    if (from > to) return { ok: false, erro: 'intervalo_invertido' };
    const ini = brtStartOfDay(from);
    const fim = brtStartOfDay(to);
    if (!ini || !fim) return { ok: false, erro: 'data_invalida' };
    const span = Math.round((fim.getTime() - ini.getTime()) / 86400000) + 1;
    if (span > INTERVALO_MAX_DIAS) return { ok: false, erro: 'intervalo_excessivo' };
    return { ok: true, periodo: { fromYmd: from, toYmd: to } };
  }

  let n = diasPadrao;
  if (temDias) {
    if (typeof dias !== 'string' || !/^\d+$/.test(dias)) return { ok: false, erro: 'dias_invalido' };
    n = Number(dias);
    if (!Number.isInteger(n)) return { ok: false, erro: 'dias_invalido' };
    if (n < DIAS_MIN || n > DIAS_MAX) return { ok: false, erro: 'dias_fora_do_limite' };
  }
  // Paridade com o dashboard: "últimos N dias" = hoje - N até hoje.
  return { ok: true, periodo: { fromYmd: ymdMenosDias(hoje, n), toYmd: hoje } };
}