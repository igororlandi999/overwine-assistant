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
 * 1. STATUS: `contaComoVenda` (lib/status-venda) — fonte ÚNICA do sistema.
 *    Cancelados e status desconhecidos ficam de fora; reembolso parcial conta,
 *    porque o dinheiro entrou e o paid_amount já vem líquido do estorno.
 *
 * 2. BASE DE RECEITA: `unit_price * quantity` de cada order_item — NÃO
 *    `paid_amount`. Decisão consciente (opção A): a margem precisa da receita
 *    ATRIBUÍVEL ao produto, e paid_amount inclui frete cobrado do comprador e
 *    descontos de pedido, que não pertencem a nenhum item específico.
 *    CONSEQUÊNCIA: `receitaProdutos` daqui é MENOR que a `receita` de
 *    sales-metrics para os mesmos pedidos. Isso não é divergência — são
 *    grandezas diferentes, e a camada de resposta DEVE dizer isso.
 *
 * 3. TARIFA ML: percentual fixo de config/taxas.json sobre a receita de
 *    produtos. É média de planilha, NÃO fee real da API. Por isso todo
 *    resultado sai com `estimado: true`.
 *
 * 3b. FRETE: custo REAL do envio (GET /shipments/{id}, guardado no mapa
 *    ship:logi), rateado por receita entre os itens do envio. O percentual
 *    taxaEnv de 14,4% só entra como FALLBACK, para o envio cujo custo ainda não
 *    foi apurado, e a fatia estimada é declarada em `frete`. Antes do Patch O3
 *    o frete era cobrado DUAS vezes — R$ 1,49 por garrafa dentro do custo mais
 *    14,4% da receita como tarifa —, e nenhuma das duas tinha relação com o que
 *    o envio custou de verdade.
 *
 * 4. CUSTO: custoUnitarioVendido (products.service) = custo de aquisição ×
 *    garrafas + embalagem, esta última APENAS em venda por estoque próprio e
 *    UMA vez por venda, mesmo em kit. A decisão é por PEDIDO, via
 *    shipping.logistic_type; ausente ou desconhecido é tratado como próprio
 *    (lado conservador: nunca infla a margem). O frete NÃO está aqui dentro:
 *    ele é por envio, não por unidade, e vive em `tarifaEnvio` (convenção 3b).
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
import { contaComoVenda } from '../lib/status-venda.js';
import {
  logisticaDoPedido,
  montarBaseRateioFrete,
  freteDoItem,
} from './shipping-logistics.service.js';
import type { EnvioInfo } from '../lib/shipping-store.js';
import taxasConfig from '../config/taxas.json' with { type: 'json' };

/**
 * Fração máxima da receita sem custo conhecido tolerada antes de declarar a
 * margem indisponível. 20% é o ponto em que o número deixa de ser informativo.
 */
export const LIMITE_SEM_CUSTO = 0.2;

export const WARN_CUSTO_PARCIAL = 'custo_parcial';
export const WARN_CUSTO_INSUFICIENTE = 'custo_insuficiente';
export const WARN_ANTES_DE_PUBLICIDADE = 'antes_de_publicidade';
/** Parte do frete veio do percentual médio, não do custo real do envio. */
export const WARN_FRETE_ESTIMADO = 'frete_estimado';

/** Margem de um agrupamento (total do período ou uma linha de SKU). */
export interface MargemLinha {
  /** Σ unit_price × quantity dos itens com custo conhecido. */
  receitaProdutos: number;
  /** Σ tarifa ML estimada sobre receitaProdutos. */
  tarifaML: number;
  /**
   * Σ custo de envio: o frete REAL do envio rateado por receita onde ele é
   * conhecido, e o percentual médio do taxas.json onde ainda não é. A divisão
   * entre os dois está em `ResultadoMargem.frete`.
   */
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

/**
 * Quanto do custo de envio veio do valor REAL e quanto veio do percentual.
 *
 * Existe para a resposta poder dizer "este número usa o frete de verdade" ou
 * "parte do frete ainda é média de planilha", em vez de apresentar uma mistura
 * das duas coisas como se fosse tudo apurado. Considera apenas os itens que
 * ENTRARAM na margem: os sem custo de produto já saíram da conta antes.
 */
export interface CoberturaFrete {
  /** Σ frete real rateado (R$). */
  real: number;
  /** Σ frete estimado pelo percentual (R$). */
  estimado: number;
  /** Receita cujo frete saiu do custo real do envio. */
  receitaReal: number;
  /** Receita cujo frete saiu do percentual médio. */
  receitaEstimada: number;
  /** 0..1 — fração da receita com frete real. 1 = nada estimado. */
  fracaoReceitaReal: number;
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
  /** Divisão do custo de envio entre frete real e percentual médio. */
  frete: CoberturaFrete;
  /** Sempre true: publicidade não entra nesta conta. */
  antesDePublicidade: true;
  /** Sempre true: a tarifa de ML é média de planilha, não fee real. */
  estimado: true;
  warnings: string[];
}

const PREFIXO_SEM_SKU = 'sem-sku-';

const FRETE_VAZIO: CoberturaFrete = {
  real: 0,
  estimado: 0,
  receitaReal: 0,
  receitaEstimada: 0,
  fracaoReceitaReal: 1,
};

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
    frete: FRETE_VAZIO,
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
  taxas: { taxaML: number; taxaEnv: number } = taxasConfig,
  /**
   * shipmentId → { logisticType, custoFrete }. Ausente = toda venda vira
   * estoque próprio (soma embalagem) e todo frete cai no percentual médio.
   * Nenhum dos dois infla a margem.
   */
  mapaLogistica: ReadonlyMap<string, EnvioInfo> | null = null
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

  // Denominador do rateio de frete: montado UMA vez, sobre o array inteiro.
  // Ver a nota de RATEIO em shipping-logistics.service para o motivo de a base
  // não ser filtrada por período.
  const baseFrete = montarBaseRateioFrete(orders);
  const frete: CoberturaFrete = { real: 0, estimado: 0, receitaReal: 0, receitaEstimada: 0, fracaoReceitaReal: 1 };

  for (const o of orders) {
    if (!o || !contaComoVenda(o.status)) continue;
    if (!dentroDoPeriodo(o.date_created, inicio, fim)) continue;

    // A API de pedidos do ML NÃO devolve logistic_type: o snapshot grava null
    // em 100% dos registros. Sem o mapa, `ehVendaFull(null)` é false e o custo
    // soma R$ 3,00 de embalagem em TODA venda, inclusive nas do Full, onde o
    // Mercado Livre é quem embala — com ~82% da operação em Full, a margem
    // saía sistematicamente subestimada. Ver lib/shipping-store.ts.
    const logisticType = logisticaDoPedido(o, mapaLogistica);

    for (const oi of o.order_items ?? []) {
      const qtd = oi?.quantity ?? 1;
      const receita = (oi?.unit_price ?? 0) * qtd;
      const titulo = oi?.item?.title ?? '';

      const custoBase = getCustoProduto(titulo, oi?.item?.seller_sku ?? null);
      // garrafasPorVenda: kits ("Kit Com 6 Un") são UMA unidade vendida com N
      // garrafas dentro. Sem este fator o kit era custeado como uma garrafa só
      // e a margem dele saía inflada.
      const custoUn = custoUnitarioVendido(
        custoBase.encontrado ? custoBase.custoProduto : null,
        logisticType,
        undefined,
        custoBase.garrafasPorVenda
      );

      if (custoUn === null) {
        semCustoReceita += receita;
        semCustoUnidades += qtd;
        if (titulo !== '') semCustoTitulos.add(titulo);
        continue;
      }

      const tML = receita * taxas.taxaML;

      // Frete REAL do envio, rateado por receita entre os itens (convenção 3b).
      // null = envio ainda sem custo apurado: cai no percentual médio e a fatia
      // estimada fica declarada em `frete`, nunca disfarçada de valor real.
      const freteItem = freteDoItem(o, mapaLogistica, baseFrete, receita, qtd);
      const tEnv = freteItem !== null ? freteItem : receita * taxas.taxaEnv;
      if (freteItem !== null) {
        frete.real += freteItem;
        frete.receitaReal += receita;
      } else {
        frete.estimado += tEnv;
        frete.receitaEstimada += receita;
      }

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

  const receitaFrete = frete.receitaReal + frete.receitaEstimada;
  frete.fracaoReceitaReal = receitaFrete > 0 ? frete.receitaReal / receitaFrete : 1;
  if (frete.receitaEstimada > 0) warnings.push(WARN_FRETE_ESTIMADO);
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
    frete,
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