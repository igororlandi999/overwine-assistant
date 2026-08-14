/**
 * margin-metrics.service — margem determinística por período e por SKU.
 *
 * Serviço PURO: sem Redis, sem fetch, sem DOM, sem globais, sem formatação de
 * moeda, sem IA. Recebe os pedidos já lidos e devolve números prontos. A Gemini
 * NUNCA calcula estes valores — ela apenas os redige.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CONVENÇÕES (decididas explicitamente com o proprietário):
 *
 * 1. STATUS: somente `status === 'paid'`, idêntico a sales-metrics. Cancelados
 *    e pendentes ficam de fora.
 *
 * 2. BASE DE RECEITA: `unit_price * quantity` de cada order_item — NÃO
 *    `paid_amount`. Decisão consciente (opção A): a margem precisa da receita
 *    ATRIBUÍVEL ao produto, e paid_amount inclui frete cobrado do comprador e
 *    descontos de pedido, que não pertencem a nenhum item específico.
 *    CONSEQUÊNCIA: `receitaProdutos` daqui é MENOR que a `receita` de
 *    sales-metrics para os mesmos pedidos. Isso não é divergência — são
 *    grandezas diferentes, e a camada de resposta DEVE dizer isso.
 *
 * 3. TARIFAS: percentuais fixos de config/taxas.json sobre a receita de
 *    produtos. São médias de planilha, NÃO fees reais da API do ML. Por isso
 *    todo resultado sai com `estimado: true`.
 *
 * 4. CUSTO: custoUnitarioVendido (products.service) = custo de aquisição +
 *    frete + embalagem, esta última APENAS em venda por estoque próprio. A
 *    decisão é por PEDIDO, via shipping.logistic_type; ausente ou desconhecido
 *    é tratado como próprio (lado conservador: nunca infla a margem).
 *
 * 5. PUBLICIDADE FORA: o custo de anúncios não entra. Todo resultado é margem
 *    ANTES de publicidade e o campo `antesDePublicidade: true` obriga a camada
 *    de resposta a dizê-lo.
 *
 * 6. CUSTO DESCONHECIDO NUNCA VIRA ZERO: item sem regra de custo é excluído da
 *    margem e contabilizado em `semCusto`. Se a fatia sem custo passa de
 *    LIMITE_SEM_CUSTO da receita, o resultado inteiro é declarado
 *    `disponivel: false` — melhor não responder do que responder um número que
 *    parece completo e não é.
 *
 * 7. COBERTURA: delegada a avaliarCobertura (sales-metrics). Período fora da
 *    janela devolve `disponivel: false` com `margem: null`.
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

/**
 * Fração máxima da receita sem custo conhecido tolerada antes de declarar a
 * margem indisponível. 20% é o ponto em que o número deixa de ser informativo.
 */
export const LIMITE_SEM_CUSTO = 0.2;

export const WARN_CUSTO_PARCIAL = 'custo_parcial';
export const WARN_CUSTO_INSUFICIENTE = 'custo_insuficiente';
export const WARN_ANTES_DE_PUBLICIDADE = 'antes_de_publicidade';

/** Margem de um agrupamento (total do período ou uma linha de SKU). */
export interface MargemLinha {
  /** Σ unit_price × quantity dos itens com custo conhecido. */
  receitaProdutos: number;
  /** Σ tarifa ML estimada sobre receitaProdutos. */
  tarifaML: number;
  /** Σ tarifa de envio estimada sobre receitaProdutos. */
  tarifaEnvio: number;
  /** Σ custoUnitarioVendido × quantidade. */
  custoTotal: number;
  /** receitaProdutos − tarifaML − tarifaEnvio − custoTotal. */
  margem: number;
  /** margem / receitaProdutos. null quando a receita é 0. */
  margemPct: number | null;
  /** Unidades com custo conhecido que entraram na conta. */
  unidades: number;
}

export interface MargemSku extends MargemLinha {
  /** SKU real do anúncio, ou 'sem-sku-<itemId>' quando não há SKU. */
  sku: string;
  /** Título representativo (o mais curto visto no período). */
  label: string;
}

/** Receita e unidades que ficaram FORA da conta por falta de custo. */
export interface SemCusto {
  receitaProdutos: number;
  unidades: number;
  /** Fração da receita total de produtos sem custo conhecido (0..1). */
  fracaoReceita: number;
  /** Títulos distintos sem regra de custo, para o usuário poder cadastrá-los. */
  titulos: string[];
}

export interface ResultadoMargem {
  disponivel: boolean;
  periodoSolicitado: PeriodoYmd;
  periodoCalculado: PeriodoYmd | null;
  cobertura: CoberturaTipo;
  /** null quando disponivel === false — nunca zeros que pareçam fato. */
  total: MargemLinha | null;
  /** Ordenado por margem desc. Vazio quando indisponível. */
  porSku: MargemSku[];
  semCusto: SemCusto;
  /** Sempre true: publicidade não entra nesta conta. */
  antesDePublicidade: true;
  /** Sempre true: tarifas são médias de planilha, não fees reais. */
  estimado: true;
  warnings: string[];
}

const PREFIXO_SEM_SKU = 'sem-sku-';

const SEM_CUSTO_VAZIO: SemCusto = {
  receitaProdutos: 0,
  unidades: 0,
  fracaoReceita: 0,
  titulos: [],
};

function linhaVazia(): MargemLinha {
  return {
    receitaProdutos: 0,
    tarifaML: 0,
    tarifaEnvio: 0,
    custoTotal: 0,
    margem: 0,
    margemPct: null,
    unidades: 0,
  };
}

/** Fecha uma linha: calcula margem e percentual a partir dos acumuladores. */
function fechar(l: MargemLinha): MargemLinha {
  const margem = l.receitaProdutos - l.tarifaML - l.tarifaEnvio - l.custoTotal;
  return {
    ...l,
    margem,
    margemPct: l.receitaProdutos > 0 ? margem / l.receitaProdutos : null,
  };
}

function indisponivel(
  periodo: PeriodoYmd,
  cobertura: CoberturaTipo,
  warnings: string[],
  semCusto: SemCusto = SEM_CUSTO_VAZIO
): ResultadoMargem {
  return {
    disponivel: false,
    periodoSolicitado: periodo,
    periodoCalculado: null,
    cobertura,
    total: null,
    porSku: [],
    semCusto,
    antesDePublicidade: true,
    estimado: true,
    warnings,
  };
}

/**
 * Margem do período, total e por SKU. Ver as sete convenções no topo do
 * arquivo — especialmente a base de receita (unit_price, não paid_amount) e o
 * tratamento de custo desconhecido (exclusão, nunca zero).
 */
export function calcularMargem(
  orders: OrderSlim[],
  periodo: PeriodoYmd,
  cobertura: CoberturaSnapshot,
  taxas: { taxaML: number; taxaEnv: number } = taxasConfig
): ResultadoMargem {
  if (!periodoValido(periodo)) {
    return indisponivel(periodo, 'indisponivel', ['periodo_invalido']);
  }

  const cob = avaliarCobertura(periodo, cobertura);
  if (cob.tipo === 'indisponivel' || !cob.periodoEfetivo) {
    return indisponivel(periodo, 'indisponivel', cob.warnings);
  }

  const inicio = brtStartOfDay(cob.periodoEfetivo.fromYmd);
  const fim = brtEndOfDay(cob.periodoEfetivo.toYmd);

  const grupos = new Map<string, { label: string; l: MargemLinha }>();
  const total = linhaVazia();
  let semCustoReceita = 0;
  let semCustoUnidades = 0;
  const semCustoTitulos = new Set<string>();

  for (const o of orders) {
    if (!o || o.status !== 'paid') continue;
    if (!dentroDoPeriodo(o.date_created, inicio, fim)) continue;

    const logisticType = o.shipping?.logistic_type ?? null;

    for (const oi of o.order_items ?? []) {
      const qtd = oi?.quantity ?? 1;
      const receita = (oi?.unit_price ?? 0) * qtd;
      const titulo = oi?.item?.title ?? '';

      const custoBase = getCustoProduto(titulo, oi?.item?.seller_sku ?? null);
      const custoUn = custoUnitarioVendido(
        custoBase.encontrado ? custoBase.custoProduto : null,
        logisticType
      );

      if (custoUn === null) {
        semCustoReceita += receita;
        semCustoUnidades += qtd;
        if (titulo !== '') semCustoTitulos.add(titulo);
        continue;
      }

      const tML = receita * taxas.taxaML;
      const tEnv = receita * taxas.taxaEnv;
      const custo = custoUn * qtd;

      total.receitaProdutos += receita;
      total.tarifaML += tML;
      total.tarifaEnvio += tEnv;
      total.custoTotal += custo;
      total.unidades += qtd;

      // Agrupamento por SKU do anúncio; sem SKU vira grupo próprio do item.
      const skuReal = itemSKU({ id: oi?.item?.id ?? '', title: titulo, seller_sku: oi?.item?.seller_sku ?? null });
      const chave = skuReal ?? PREFIXO_SEM_SKU + (oi?.item?.id ?? 'desconhecido');
      let g = grupos.get(chave);
      if (!g) {
        g = { label: titulo, l: linhaVazia() };
        grupos.set(chave, g);
      }
      // Label: o título mais curto entre os vistos (mesma regra do consolidado).
      if (titulo !== '' && (g.label === '' || titulo.length < g.label.length)) g.label = titulo;
      g.l.receitaProdutos += receita;
      g.l.tarifaML += tML;
      g.l.tarifaEnvio += tEnv;
      g.l.custoTotal += custo;
      g.l.unidades += qtd;
    }
  }

  const receitaBruta = total.receitaProdutos + semCustoReceita;
  const fracaoSemCusto = receitaBruta > 0 ? semCustoReceita / receitaBruta : 0;
  const semCusto: SemCusto = {
    receitaProdutos: semCustoReceita,
    unidades: semCustoUnidades,
    fracaoReceita: fracaoSemCusto,
    titulos: [...semCustoTitulos].sort(),
  };

  const warnings = [...cob.warnings, WARN_ANTES_DE_PUBLICIDADE];

  // Fatia sem custo grande demais: o número deixaria de ser informativo.
  if (fracaoSemCusto > LIMITE_SEM_CUSTO) {
    return indisponivel(
      periodo,
      cob.tipo,
      [...warnings, WARN_CUSTO_INSUFICIENTE],
      semCusto
    );
  }
  if (semCustoReceita > 0) warnings.push(WARN_CUSTO_PARCIAL);
  if (total.unidades === 0 && semCustoUnidades === 0) warnings.push(WARN_SEM_DADOS_NO_PERIODO);

  const porSku: MargemSku[] = [...grupos.entries()]
    .map(([sku, g]) => ({ sku, label: g.label, ...fechar(g.l) }))
    .sort((a, b) => b.margem - a.margem || a.sku.localeCompare(b.sku));

  return {
    disponivel: true,
    periodoSolicitado: periodo,
    periodoCalculado: cob.periodoEfetivo,
    cobertura: cob.tipo,
    total: fechar(total),
    porSku,
    semCusto,
    antesDePublicidade: true,
    estimado: true,
    warnings,
  };
}

/** Os `n` SKUs de MAIOR margem absoluta no período. */
export function melhoresMargens(r: ResultadoMargem, n = 5): MargemSku[] {
  return r.porSku.slice(0, Math.max(0, n));
}

/** Os `n` SKUs de MENOR margem absoluta (prejuízo primeiro). */
export function pioresMargens(r: ResultadoMargem, n = 5): MargemSku[] {
  return [...r.porSku].reverse().slice(0, Math.max(0, n));
}