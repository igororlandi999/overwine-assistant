/**
 * product-ranking.service — ranking determinístico de produtos por período.
 *
 * Serviço PURO: sem Redis, sem fetch, sem DOM, sem globais, sem formatação de
 * moeda, sem IA. Recebe os pedidos já lidos e devolve o ranking pronto. A
 * Gemini NUNCA calcula nem ordena estes valores — ela apenas os redige.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CONVENÇÕES
 *
 * 1. STATUS: somente `status === 'paid'`, idêntico a sales-metrics e
 *    margin-metrics. Cancelados e pendentes ficam de fora.
 *
 * 2. BASE DE RECEITA: `unit_price × quantity` de cada order_item — NÃO
 *    `paid_amount`. Mesma decisão de margin-metrics (convenção 2): o ranking
 *    precisa da receita ATRIBUÍVEL a cada produto, e paid_amount inclui frete
 *    cobrado do comprador e descontos de pedido, que não pertencem a item
 *    nenhum. CONSEQUÊNCIA: a soma do ranking é MENOR que o faturamento do
 *    mesmo período em sales-metrics. Não é divergência — são grandezas
 *    diferentes, e a camada de resposta DEVE dizer isso.
 *
 *    A alternativa (atribuir paid_amount do pedido inteiro ao primeiro item,
 *    quirk de `vendasPorItem`) infla pedidos multi-item e não é usada aqui.
 *
 * 3b. LABEL: título do anúncio que MAIS FATURA no grupo, não o mais curto. O
 *    consolidado legado usa o mais curto, e em produção isso exibia o anúncio
 *    errado: o SKU 25101 fatura R$ 46 mil no anúncio principal e R$ 388 numa
 *    variante chamada "...Exclusive Edition 3571"; por ter um caractere a
 *    menos, o código interno virava o nome do produto no ranking. Números
 *    certos com nome irreconhecível é um erro de leitura, não de estética.
 *
 * 3. AGRUPAMENTO: por `itemSKU` do anúncio, com fallback `sem-sku-<itemId>` —
 *    EXATAMENTE a mesma chave de margin-metrics. Duas convenções de
 *    agrupamento coexistindo repetiria o erro de `!== 'cancelled'` vs
 *    `=== 'paid'`. Anúncios clássico e premium do mesmo SKU caem na MESMA
 *    linha, que é o que torna isto um ranking de PRODUTOS e não de anúncios.
 *
 * 4. UNIDADES: soma `quantity` de TODOS os order_items. O fallback para 1
 *    aplica-se SOMENTE a null/undefined (`?? 1`): `quantity: 0` é legítimo e
 *    permanece 0.
 *
 * 5. CUSTO DESCONHECIDO NUNCA VIRA ZERO. Diferente de margin-metrics, que
 *    EXCLUI da conta o item sem custo, aqui o produto continua no ranking:
 *    rankings de faturamento e de quantidade não dependem de custo algum, e
 *    sumir com um produto vendido seria pior do que declarar o custo ausente.
 *    Cada linha declara `custoCobertura` e os campos de margem viram null
 *    quando o custo é desconhecido.
 *
 * 6. RANKING POR MARGEM inclui SOMENTE linhas com custo INTEGRALMENTE
 *    conhecido. Uma linha de custo parcial tem margem absoluta subestimada por
 *    construção (parte das unidades ficou de fora), e ordenar por um número
 *    subestimado produziria uma classificação falsa. As linhas excluídas são
 *    contadas em `margemCobertura` para a resposta declarar a limitação.
 *
 * 7. LIMITE_SEM_CUSTO (margin-metrics) NÃO se aplica aqui. Lá, estourar 20%
 *    derruba o resultado inteiro para indisponível, o que é correto para um
 *    número único de margem. No ranking isso seria destrutivo: derrubaria
 *    também faturamento e quantidade, que não dependem de custo.
 *
 * 8. COBERTURA: delegada a `avaliarCobertura` (sales-metrics). Período fora da
 *    janela devolve `disponivel: false` com `linhas: []` — nunca zeros que
 *    possam ser lidos como "não vendemos nada".
 *
 * 9. TARIFAS: percentuais fixos de config/taxas.json, médias de planilha e não
 *    fees reais da API do ML. Por isso todo resultado sai com `estimado: true`
 *    e `antesDePublicidade: true`.
 */
import { brtStartOfDay, brtEndOfDay, dentroDoPeriodo } from '../lib/datas-brt.js';
import type { OrderSlim } from './orders.service.js';
import {
  avaliarCobertura,
  periodoValido,
  WARN_SEM_DADOS_NO_PERIODO,
  type PeriodoYmd,
  type CoberturaSnapshot,
  type CoberturaTipo,
} from './sales-metrics.service.js';
import { getCustoProduto, custoUnitarioVendido, itemSKU } from './products.service.js';
import taxasConfig from '../config/taxas.json' with { type: 'json' };

/** Critério de ordenação do ranking. */
export const RANKING_CRITERIOS = ['revenue', 'units', 'margin'] as const;
export type RankingCriterio = typeof RANKING_CRITERIOS[number];

/** Limite padrão quando a pergunta não diz quantos. */
export const RANKING_LIMITE_PADRAO = 5;
/** Teto absoluto: acima disso a "lista" vira o catálogo e deixa de ser ranking. */
export const RANKING_LIMITE_MAX = 20;

export const WARN_MARGEM_COBERTURA_PARCIAL = 'ranking_margem_cobertura_parcial';
export const WARN_CUSTO_PARCIAL = 'custo_parcial';
export const WARN_ANTES_DE_PUBLICIDADE = 'antes_de_publicidade';

/** Quanto do custo da linha é conhecido. */
export type CustoCobertura = 'total' | 'parcial' | 'ausente';

export interface RankingLinha {
  /** 1-based, já na ordem final do critério pedido. */
  posicao: number;
  /** SKU real do anúncio, ou 'sem-sku-<itemId>' quando não há SKU. */
  sku: string;
  /** true quando a chave é sintética (anúncio sem SKU confiável). */
  semSku: boolean;
  /** Título representativo: o mais curto visto no período. */
  label: string;
  /** IDs (MLB) dos anúncios que caíram nesta linha, ordenados. */
  itemIds: string[];
  /** Σ quantity de todos os order_items desta linha. */
  unidades: number;
  /** Σ unit_price × quantity — TODA a receita da linha (ver convenção 2). */
  receitaProdutos: number;
  /** Pedidos DISTINTOS que contêm esta linha (mesmo SKU 2× num pedido = 1). */
  pedidos: number;
  custoCobertura: CustoCobertura;
  /** Receita da parcela com custo conhecido. Base de margemPct. */
  receitaComCusto: number;
  /** Unidades da parcela com custo conhecido. */
  unidadesComCusto: number;
  /** null quando custoCobertura === 'ausente'. */
  custoTotal: number | null;
  tarifaML: number | null;
  tarifaEnvio: number | null;
  /** receitaComCusto − tarifaML − tarifaEnvio − custoTotal. null se ausente. */
  margem: number | null;
  /** margem / receitaComCusto. null quando a base é 0 ou o custo é ausente. */
  margemPct: number | null;
}

export interface RankingSemCusto {
  /** Linhas (SKUs) sem custo integralmente conhecido. */
  skus: number;
  /** Receita dessas linhas que ficou sem custo. */
  receitaProdutos: number;
  unidades: number;
  /** Fração da receita total do período sem custo conhecido (0..1). */
  fracaoReceita: number;
  /** Títulos distintos sem regra de custo, para o usuário cadastrá-los. */
  titulos: string[];
}

export interface ResultadoRanking {
  /** false quando o período está inteiramente fora da janela de dados. */
  disponivel: boolean;
  criterio: RankingCriterio;
  /** Limite efetivamente aplicado (já normalizado). */
  limite: number;
  periodoSolicitado: PeriodoYmd;
  periodoCalculado: PeriodoYmd | null;
  cobertura: CoberturaTipo;
  /** Já ordenado e cortado em `limite`. Vazio quando indisponível. */
  linhas: RankingLinha[];
  totais: {
    /** Receita de produtos de TODOS os SKUs do período, não só os do top N. */
    receitaProdutos: number;
    unidades: number;
    /** Quantos SKUs distintos venderam no período. */
    skusDistintos: number;
  };
  semCusto: RankingSemCusto;
  /**
   * Preenchido SOMENTE quando criterio === 'margin'. Diz quanto do período
   * ficou de fora da classificação por falta de custo (ver convenção 6).
   */
  margemCobertura: {
    /** Fração da receita do período em linhas de custo integralmente conhecido. */
    fracaoReceitaComCusto: number;
    /** Linhas elegíveis que foram excluídas do ranking por custo incompleto. */
    skusExcluidos: number;
  } | null;
  /** Sempre true: publicidade não entra nesta conta. */
  antesDePublicidade: true;
  /** Sempre true: tarifas são médias de planilha, não fees reais. */
  estimado: true;
  warnings: string[];
}

const PREFIXO_SEM_SKU = 'sem-sku-';

const SEM_CUSTO_VAZIO: RankingSemCusto = {
  skus: 0,
  receitaProdutos: 0,
  unidades: 0,
  fracaoReceita: 0,
  titulos: [],
};

/** Normaliza o limite pedido para [1, RANKING_LIMITE_MAX]. */
export function normalizarLimite(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return RANKING_LIMITE_PADRAO;
  const inteiro = Math.floor(n);
  if (inteiro < 1) return 1;
  if (inteiro > RANKING_LIMITE_MAX) return RANKING_LIMITE_MAX;
  return inteiro;
}

/** Acumulador interno de uma linha, antes de fechar os cálculos. */
interface Acc {
  sku: string;
  semSku: boolean;
  /** Receita acumulada por título, para eleger o label representativo. */
  receitaPorTitulo: Map<string, number>;
  itemIds: Set<string>;
  pedidoIds: Set<string>;
  unidades: number;
  receitaProdutos: number;
  unidadesComCusto: number;
  receitaComCusto: number;
  custoTotal: number;
  unidadesSemCusto: number;
  receitaSemCusto: number;
}

function novoAcc(sku: string, semSku: boolean): Acc {
  return {
    sku,
    semSku,
    receitaPorTitulo: new Map(),
    itemIds: new Set(),
    pedidoIds: new Set(),
    unidades: 0,
    receitaProdutos: 0,
    unidadesComCusto: 0,
    receitaComCusto: 0,
    custoTotal: 0,
    unidadesSemCusto: 0,
    receitaSemCusto: 0,
  };
}

/**
 * Título representativo do grupo: o de MAIOR receita (decisão 3b). Empate
 * resolve pelo mais curto e, se ainda empatar, pela ordem alfabética — para o
 * resultado não depender da ordem de leitura dos pedidos.
 */
function elegerLabel(receitaPorTitulo: Map<string, number>): string {
  let melhor = '';
  let melhorReceita = -Infinity;
  for (const [titulo, receita] of receitaPorTitulo) {
    if (receita > melhorReceita) { melhor = titulo; melhorReceita = receita; continue; }
    if (receita === melhorReceita) {
      if (titulo.length < melhor.length) { melhor = titulo; continue; }
      if (titulo.length === melhor.length && titulo.localeCompare(melhor, 'pt-BR') < 0) melhor = titulo;
    }
  }
  return melhor;
}

function indisponivel(
  periodo: PeriodoYmd,
  criterio: RankingCriterio,
  limite: number,
  cobertura: CoberturaTipo,
  warnings: string[]
): ResultadoRanking {
  return {
    disponivel: false,
    criterio,
    limite,
    periodoSolicitado: periodo,
    periodoCalculado: null,
    cobertura,
    linhas: [],
    totais: { receitaProdutos: 0, unidades: 0, skusDistintos: 0 },
    semCusto: SEM_CUSTO_VAZIO,
    margemCobertura: null,
    antesDePublicidade: true,
    estimado: true,
    warnings,
  };
}

export interface RankingOpcoes {
  criterio?: RankingCriterio;
  limite?: number;
  taxas?: { taxaML: number; taxaEnv: number };
}

/**
 * Ranking de produtos do período. Ver as nove convenções no topo do arquivo —
 * em especial a base de receita (unit_price, não paid_amount) e o tratamento
 * de custo desconhecido (declarado, nunca zero, nunca some do ranking).
 */
export function calcularRanking(
  orders: OrderSlim[],
  periodo: PeriodoYmd,
  cobertura: CoberturaSnapshot,
  opcoes: RankingOpcoes = {}
): ResultadoRanking {
  const criterio: RankingCriterio = opcoes.criterio ?? 'revenue';
  const limite = normalizarLimite(opcoes.limite);
  const taxas = opcoes.taxas ?? taxasConfig;

  if (!periodoValido(periodo)) {
    return indisponivel(periodo, criterio, limite, 'indisponivel', ['periodo_invalido']);
  }

  const cob = avaliarCobertura(periodo, cobertura);
  if (cob.tipo === 'indisponivel' || !cob.periodoEfetivo) {
    return indisponivel(periodo, criterio, limite, 'indisponivel', cob.warnings);
  }

  const inicio = brtStartOfDay(cob.periodoEfetivo.fromYmd);
  const fim = brtEndOfDay(cob.periodoEfetivo.toYmd);

  const grupos = new Map<string, Acc>();
  const titulosSemCusto = new Set<string>();

  for (const o of orders) {
    if (!o || o.status !== 'paid') continue;
    if (!dentroDoPeriodo(o.date_created, inicio, fim)) continue;

    const logisticType = o.shipping?.logistic_type ?? null;
    const pedidoId = String(o.id);

    for (const oi of o.order_items ?? []) {
      const qtd = oi?.quantity ?? 1;            // 0 é válido e permanece 0
      const receita = (oi?.unit_price ?? 0) * qtd;
      const titulo = oi?.item?.title ?? '';
      const itemId = oi?.item?.id ?? '';

      // Mesma chave de margin-metrics — ver convenção 3.
      const skuReal = itemSKU({ id: itemId, title: titulo, seller_sku: oi?.item?.seller_sku ?? null });
      const chave = skuReal ?? PREFIXO_SEM_SKU + (itemId || 'desconhecido');

      let g = grupos.get(chave);
      if (!g) {
        g = novoAcc(chave, skuReal === null);
        grupos.set(chave, g);
      }
      // Label: acumula receita por título; o vencedor é eleito ao fechar (3b).
      if (titulo !== '') {
        g.receitaPorTitulo.set(titulo, (g.receitaPorTitulo.get(titulo) ?? 0) + receita);
      }
      if (itemId !== '') g.itemIds.add(itemId);
      g.pedidoIds.add(pedidoId);
      g.unidades += qtd;
      g.receitaProdutos += receita;

      const custoBase = getCustoProduto(titulo, oi?.item?.seller_sku ?? null);
      // garrafasPorVenda: um "Kit Com 6 Un" é UMA unidade vendida contendo seis
      // garrafas. O custo escala; a embalagem não (uma caixa por venda).
      const custoUn = custoUnitarioVendido(
        custoBase.encontrado ? custoBase.custoProduto : null,
        logisticType,
        undefined,
        custoBase.garrafasPorVenda
      );

      if (custoUn === null) {
        // Sem custo: a receita e as unidades CONTINUAM na linha (convenção 5),
        // apenas fora da parcela que sustenta a margem.
        g.unidadesSemCusto += qtd;
        g.receitaSemCusto += receita;
        if (titulo !== '') titulosSemCusto.add(titulo);
        continue;
      }

      g.unidadesComCusto += qtd;
      g.receitaComCusto += receita;
      g.custoTotal += custoUn * qtd;
    }
  }

  // ── Fecha as linhas ──
  const linhas: RankingLinha[] = [];
  let totalReceita = 0;
  let totalUnidades = 0;
  let semCustoSkus = 0;
  let semCustoReceita = 0;
  let semCustoUnidades = 0;
  let receitaComCustoTotal = 0;

  for (const g of grupos.values()) {
    totalReceita += g.receitaProdutos;
    totalUnidades += g.unidades;

    const custoCobertura: CustoCobertura =
      g.unidadesSemCusto === 0 && g.unidadesComCusto > 0 ? 'total'
        : g.unidadesComCusto === 0 ? 'ausente'
          : 'parcial';

    if (custoCobertura !== 'total') {
      semCustoSkus += 1;
      semCustoReceita += g.receitaSemCusto;
      semCustoUnidades += g.unidadesSemCusto;
    } else {
      receitaComCustoTotal += g.receitaComCusto;
    }

    const temCusto = custoCobertura !== 'ausente';
    const tML = temCusto ? g.receitaComCusto * taxas.taxaML : null;
    const tEnv = temCusto ? g.receitaComCusto * taxas.taxaEnv : null;
    const margem = temCusto
      ? g.receitaComCusto - (tML as number) - (tEnv as number) - g.custoTotal
      : null;

    linhas.push({
      posicao: 0, // atribuído depois da ordenação
      sku: g.sku,
      semSku: g.semSku,
      label: elegerLabel(g.receitaPorTitulo),
      itemIds: [...g.itemIds].sort(),
      unidades: g.unidades,
      receitaProdutos: g.receitaProdutos,
      pedidos: g.pedidoIds.size,
      custoCobertura,
      receitaComCusto: g.receitaComCusto,
      unidadesComCusto: g.unidadesComCusto,
      custoTotal: temCusto ? g.custoTotal : null,
      tarifaML: tML,
      tarifaEnvio: tEnv,
      margem,
      margemPct: margem !== null && g.receitaComCusto > 0 ? margem / g.receitaComCusto : null,
    });
  }

  // ── Ordena e corta ──
  // Por margem, SOMENTE linhas de custo integralmente conhecido (convenção 6).
  const elegiveis = criterio === 'margin'
    ? linhas.filter(l => l.custoCobertura === 'total')
    : linhas;

  const ordenadas = [...elegiveis].sort((a, b) => {
    const chave = criterio === 'revenue' ? b.receitaProdutos - a.receitaProdutos
      : criterio === 'units' ? b.unidades - a.unidades
        : (b.margem as number) - (a.margem as number);
    // Desempate determinístico: mesma regra de products.service.
    return chave || a.sku.localeCompare(b.sku, 'pt-BR');
  });

  const top = ordenadas.slice(0, limite).map((l, i) => ({ ...l, posicao: i + 1 }));

  // ── Warnings ──
  const warnings = [...cob.warnings, WARN_ANTES_DE_PUBLICIDADE];
  if (linhas.length === 0) warnings.push(WARN_SEM_DADOS_NO_PERIODO);
  if (semCustoSkus > 0) warnings.push(WARN_CUSTO_PARCIAL);

  let margemCobertura: ResultadoRanking['margemCobertura'] = null;
  if (criterio === 'margin') {
    const excluidos = linhas.length - elegiveis.length;
    margemCobertura = {
      fracaoReceitaComCusto: totalReceita > 0 ? receitaComCustoTotal / totalReceita : 0,
      skusExcluidos: excluidos,
    };
    if (excluidos > 0) warnings.push(WARN_MARGEM_COBERTURA_PARCIAL);
  }

  return {
    disponivel: true,
    criterio,
    limite,
    periodoSolicitado: periodo,
    periodoCalculado: cob.periodoEfetivo,
    cobertura: cob.tipo,
    linhas: top,
    totais: {
      receitaProdutos: totalReceita,
      unidades: totalUnidades,
      skusDistintos: linhas.length,
    },
    semCusto: {
      skus: semCustoSkus,
      receitaProdutos: semCustoReceita,
      unidades: semCustoUnidades,
      fracaoReceita: totalReceita > 0 ? semCustoReceita / totalReceita : 0,
      titulos: [...titulosSemCusto].sort(),
    },
    margemCobertura,
    antesDePublicidade: true,
    estimado: true,
    warnings,
  };
}