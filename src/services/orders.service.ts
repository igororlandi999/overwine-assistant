/**
 * orders.service — agregações PURAS sobre pedidos do Mercado Livre.
 * Porte do dashboard legado (index.html): calcLiquidoPeriodo (li. 4748),
 * bloco de pedidos de loadPeriodoData (li. 3898), apColetarVendas (li. 7499),
 * grVendasPorSku (li. 8176), série byMonth de renderChartFaturamento
 * (li. 4256), pvGroupByDay (li. 7778), buildCancelMotivos (li. 6135), dedup e
 * slim map de loadAllOrders/saveOrdersCache (li. 3631, 3733).
 *
 * Serviço PURO: recebe orders[] + parâmetros; sem I/O de rede, sem Redis, sem
 * fetch, sem globais, sem DOM, sem formatação de moeda. Reusa datas-brt
 * (Fase 1). Não monta skuMap internamente — quem chama fornece (o mapa é
 * derivado de products.itemSKU, Fase 2).
 *
 * DIVERGÊNCIA LEGADA PRESERVADA (documentada e testada):
 * - vendasPorItem conta SOMENTE order_items[0] de cada pedido, e atribui a
 *   receita = paid_amount do PEDIDO INTEIRO a esse primeiro item;
 * - vendasPorSkuDetalhado e vendasPorSkuAgregado percorrem TODOS os
 *   order_items e usam unit_price * quantity (preço real por item).
 * Pedidos multi-item produzem números diferentes conforme a função — isto é
 * uma inconsistência do dashboard, mantida por paridade. NÃO reconciliada.
 */
import { dentroDoPeriodo, ymdBRT } from '../lib/datas-brt.js';
import taxasConfig from '../config/taxas.json' with { type: 'json' };

// ── Contratos de entrada (só os campos realmente lidos — slim map li. 3631) ─

export interface OrderItemInput {
  quantity?: number | null;
  unit_price?: number | null;
  item?: {
    id?: string | null;
    title?: string | null;
    seller_sku?: string | null;
    variation_id?: number | string | null;
  } | null;
}

export interface OrderInput {
  id: number | string;
  status?: string | null;
  date_created?: string | null;
  paid_amount?: number | null;
  total_amount?: number | null;
  order_items?: OrderItemInput[] | null;
  buyer?: { nickname?: string | null } | null;
  shipping?: { id?: number | string | null; logistic_type?: string | null } | null;
  cancel_detail?: { group?: string | null; code?: string | null; description?: string | null } | null;
}

// ── 1. dedupById ────────────────────────────────────────────────────────────

/**
 * Remove pedidos com id repetido — porte do dedup de loadAllOrders (li. 3733):
 * o PRIMEIRO visto vence, ordem de entrada preservada. Compara ids por forma
 * canônica em string (o ML devolve id numérico; um mesmo id como number e
 * string é o mesmo pedido).
 */
export function dedupById(orders: OrderInput[]): OrderInput[] {
  const seen = new Set<string>();
  const out: OrderInput[] = [];
  for (const o of orders) {
    const k = String(o.id);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(o);
  }
  return out;
}

// ── 2. toSlim ───────────────────────────────────────────────────────────────

export interface OrderSlim {
  id: number | string;
  status: string | null;
  date_created: string | null;
  paid_amount: number | null;
  total_amount: number | null;
  order_items: Array<{
    quantity: number | null;
    unit_price: number | null;
    item: {
      id: string | null;
      title: string | null;
      seller_sku: string | null;
      variation_id: number | string | null;
    };
  }>;
  buyer?: { nickname: string | null };
  shipping?: { id: number | string | null; logistic_type: string | null };
}

/**
 * Reduz um pedido ao conjunto mínimo persistido — porte do slim map de
 * saveOrdersCache (li. 3631). Só os campos usados pelas agregações; nada de
 * PII além de buyer.nickname (paridade). buyer/shipping ausentes ficam
 * ausentes (undefined), como no legado (o `o.buyer ? ... : undefined`).
 */
export function toSlim(order: OrderInput): OrderSlim {
  const slim: OrderSlim = {
    id: order.id,
    status: order.status ?? null,
    date_created: order.date_created ?? null,
    paid_amount: order.paid_amount ?? null,
    total_amount: order.total_amount ?? null,
    order_items: (order.order_items ?? []).map(oi => ({
      quantity: oi.quantity ?? null,
      unit_price: oi.unit_price ?? null,
      item: {
        id: oi.item?.id ?? null,
        title: oi.item?.title ?? null,
        seller_sku: oi.item?.seller_sku ?? null,
        variation_id: oi.item?.variation_id ?? null,
      },
    })),
  };
  if (order.buyer) slim.buyer = { nickname: order.buyer.nickname ?? null };
  if (order.shipping) {
    slim.shipping = {
      id: order.shipping.id ?? null,
      logistic_type: order.shipping.logistic_type ?? null,
    };
  }
  return slim;
}

// ── 3. faturamentoPeriodo ───────────────────────────────────────────────────

export interface TaxasConfig {
  taxaML: number;
  taxaEnv: number;
  fonte: string;
  metodologia: string;
}

export interface FaturamentoPeriodo {
  bruto: number;
  tarifaML: number;   // <= 0
  tarifaEnv: number;  // <= 0
  liquido: number;    // bruto + tarifaML + tarifaEnv
  estimado: true;
  fonte: string;
  metodologia: string;
}

/**
 * Faturamento bruto/líquido do período — porte de calcLiquidoPeriodo (li. 4748).
 * SOMENTE status === 'paid' ∩ período BRT. bruto usa `paid_amount || total_amount
 * || 0` (operador || do legado: paid_amount 0 cai para total_amount). As tarifas
 * são percentuais fixos de planilha (config/taxas.json), NÃO fees reais da API —
 * por isso o retorno é marcado estimado:true (R4). Limites de período nulos
 * significam "sem limite" daquele lado (dentroDoPeriodo, Fase 1).
 */
export function faturamentoPeriodo(
  orders: OrderInput[],
  inicio: Date | null,
  fim: Date | null,
  taxas: TaxasConfig = taxasConfig as TaxasConfig
): FaturamentoPeriodo {
  let bruto = 0;
  for (const o of orders) {
    if (o.status !== 'paid') continue;
    if (!dentroDoPeriodo(o.date_created, inicio, fim)) continue;
    bruto += o.paid_amount || o.total_amount || 0;
  }
  const tarifaML = -(bruto * taxas.taxaML);
  const tarifaEnv = -(bruto * taxas.taxaEnv);
  return {
    bruto,
    tarifaML,
    tarifaEnv,
    liquido: bruto + tarifaML + tarifaEnv,
    estimado: true,
    fonte: taxas.fonte,
    metodologia: taxas.metodologia,
  };
}

// ── 4. vendasPorItem ────────────────────────────────────────────────────────

export interface VendasItem {
  itemId: string;
  pedidos: number;
  unidades: number;
  /** Σ paid_amount do PEDIDO INTEIRO (quirk legado — infla em multi-item). */
  receita: number;
}

/**
 * Vendas agregadas por item_id — porte do bloco de pedidos de loadPeriodoData
 * (li. 3898/3911). Exclui status 'cancelled' (pendentes CONTAM). QUIRK LEGADO:
 * indexa SOMENTE order_items[0] de cada pedido e soma `paid_amount` do pedido
 * inteiro como receita desse item. Um pedido nunca é atribuído a mais de um
 * item. Período opcional (nulos = sem filtro).
 * Contraste com vendasPorSkuAgregado, que percorre todos os order_items.
 */
export function vendasPorItem(
  orders: OrderInput[],
  inicio: Date | null = null,
  fim: Date | null = null
): Map<string, VendasItem> {
  const mapa = new Map<string, VendasItem>();
  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    if ((inicio || fim) && !dentroDoPeriodo(o.date_created, inicio, fim)) continue;
    const oi = o.order_items?.[0];
    const id = oi?.item?.id;
    if (!id) continue;
    let acc = mapa.get(id);
    if (!acc) {
      acc = { itemId: id, pedidos: 0, unidades: 0, receita: 0 };
      mapa.set(id, acc);
    }
    acc.pedidos += 1;
    acc.unidades += oi?.quantity || 1;
    acc.receita += o.paid_amount || 0;
  }
  return mapa;
}

// ── 5. vendasPorSkuDetalhado ────────────────────────────────────────────────

export interface VendaSku {
  orderId: number | string;
  itemId: string;
  sku: string;
  data: string;
  titulo: string;
  precoUnit: number;
  qtd: number;
  valorTotal: number;
  status: string;
  comprador: string;
}

/**
 * Linhas de venda de um SKU consolidado — porte de apColetarVendas (li. 7499).
 * SOMENTE status 'paid' ∩ período. Percorre TODOS os order_items; dedup por
 * `order:item:idx` (mesmo order_item repetido não duplica). Usa unit_price
 * REAL da venda (não paid_amount). skuMap (item_id → sku) vem de quem chama.
 * Ordenação determinística: data asc, depois orderId, itemId (estável e
 * independente da ordem de entrada).
 */
export function vendasPorSkuDetalhado(
  orders: OrderInput[],
  skuMap: Record<string, string>,
  sku: string,
  inicio: Date | null = null,
  fim: Date | null = null
): VendaSku[] {
  const vendas: VendaSku[] = [];
  const vistos = new Set<string>();
  for (const o of orders) {
    if (o.status !== 'paid') continue;
    if ((inicio || fim) && !dentroDoPeriodo(o.date_created, inicio, fim)) continue;
    (o.order_items ?? []).forEach((oi, idx) => {
      const itemId = oi.item?.id;
      if (!itemId) return;
      if (skuMap[itemId] !== sku) return;
      const chave = `${o.id}:${itemId}:${idx}`;
      if (vistos.has(chave)) return;
      vistos.add(chave);
      const qtd = oi.quantity || 1;
      const precoUnit = oi.unit_price || 0;
      vendas.push({
        orderId: o.id,
        itemId,
        sku,
        data: o.date_created || '',
        titulo: oi.item?.title || '-',
        precoUnit,
        qtd,
        valorTotal: precoUnit * qtd,
        status: o.status || '',
        comprador: o.buyer?.nickname || '-',
      });
    });
  }
  vendas.sort(
    (a, b) =>
      a.data.localeCompare(b.data) ||
      String(a.orderId).localeCompare(String(b.orderId)) ||
      a.itemId.localeCompare(b.itemId)
  );
  return vendas;
}

// ── 6. vendasPorSkuAgregado ─────────────────────────────────────────────────

export interface VendaSkuAgregada {
  sku: string;
  totalQty: number;
  totalRev: number;
  porSemana: Record<number, number>;
}

/**
 * Vendas agregadas por SKU com quebra semanal — porte de grVendasPorSku
 * (li. 8176). SOMENTE 'paid' ∩ período. Percorre TODOS os order_items;
 * totalRev = Σ unit_price * quantity (preço real). A semana é calculada pelo
 * chamador via `semanaDe` (evita acoplar grSemanasEntre aqui); por padrão,
 * tudo cai na semana 1 se `semanaDe` não for fornecida.
 * Contraste com vendasPorItem (só primeiro order_item, receita do pedido).
 */
export function vendasPorSkuAgregado(
  orders: OrderInput[],
  skuMap: Record<string, string>,
  inicio: Date | null = null,
  fim: Date | null = null,
  semanaDe: (dataIso: string) => number = () => 1
): Map<string, VendaSkuAgregada> {
  const out = new Map<string, VendaSkuAgregada>();
  for (const o of orders) {
    if (o.status !== 'paid') continue;
    if ((inicio || fim) && !dentroDoPeriodo(o.date_created, inicio, fim)) continue;
    const semana = semanaDe(o.date_created || '');
    for (const oi of o.order_items ?? []) {
      const itemId = oi.item?.id;
      if (!itemId) continue;
      const sku = skuMap[itemId];
      if (!sku) continue;
      const qty = oi.quantity || 1;
      let acc = out.get(sku);
      if (!acc) {
        acc = { sku, totalQty: 0, totalRev: 0, porSemana: {} };
        out.set(sku, acc);
      }
      acc.totalQty += qty;
      acc.totalRev += (oi.unit_price || 0) * qty;
      acc.porSemana[semana] = (acc.porSemana[semana] || 0) + qty;
    }
  }
  return out;
}

// ── 7. faturamentoMensal ────────────────────────────────────────────────────

export interface SerieMensal {
  mes: string; // YYYY-MM
  total: number;
}

/**
 * Faturamento por mês — porte da série byMonth de renderChartFaturamento
 * (li. 4256). SOMENTE 'paid'. Mês = date_created.slice(0,7) (paridade: usa o
 * prefixo textual do ISO, não conversão BRT — o dashboard agrupa assim).
 * Total = Σ paid_amount (sem fallback para total_amount, como no legado).
 * Ordenado por mês asc (determinístico).
 */
export function faturamentoMensal(orders: OrderInput[]): SerieMensal[] {
  const byMonth: Record<string, number> = {};
  for (const o of orders) {
    if (o.status !== 'paid') continue;
    const m = (o.date_created || '').slice(0, 7);
    if (m) byMonth[m] = (byMonth[m] || 0) + (o.paid_amount || 0);
  }
  return Object.keys(byMonth)
    .sort()
    .map(mes => ({ mes, total: byMonth[mes] }));
}

// ── 8. faturamentoPorDia ────────────────────────────────────────────────────

/**
 * Faturamento por dia do mês — porte de pvGroupByDay (li. 7778). SOMENTE
 * 'paid'. Usa ymdBRT (Fase 1) para o dia CIVIL em São Paulo, filtra ano/mês
 * e soma `paid_amount || total_amount`. Retorna { dia(1..31): total }.
 */
export function faturamentoPorDia(
  orders: OrderInput[],
  mes: number,
  ano: number
): Record<number, number> {
  const porDia: Record<number, number> = {};
  for (const o of orders) {
    if (o.status !== 'paid') continue;
    const ymd = ymdBRT(o.date_created);
    if (!ymd) continue;
    const [y, m, d] = ymd.split('-').map(Number);
    if (y !== ano || m !== mes) continue;
    porDia[d] = (porDia[d] || 0) + (o.paid_amount || o.total_amount || 0);
  }
  return porDia;
}

// ── 9. cancelMotivos ────────────────────────────────────────────────────────

export interface CancelMotivo {
  group: string;
  code: string;
  desc: string;
  count: number;
  total: number;
}

/**
 * Agrupa pedidos cancelados por motivo — porte de buildCancelMotivos (li. 6135).
 * Chave group::code; cancel_detail ausente → 'desconhecido'::'sem_detalhe'.
 * A descrição legível vem de labelDeCodigo (fornecida pelo chamador, que tem o
 * mapa CANCEL_CODE_LABELS) com fallback para cancel_detail.description.
 * total = Σ total_amount. Ordenado por count desc, com desempate determinístico
 * por group::code (o legado não desempata; endurecimento que só afeta empates).
 */
export function cancelMotivos(
  cancelled: OrderInput[],
  labelDeCodigo: (code: string) => string | undefined = () => undefined
): CancelMotivo[] {
  const motivos = new Map<string, CancelMotivo>();
  for (const o of cancelled) {
    const group = o.cancel_detail?.group || 'desconhecido';
    const code = o.cancel_detail?.code || 'sem_detalhe';
    const desc = labelDeCodigo(code) || o.cancel_detail?.description || 'Sem descricao';
    const key = `${group}::${code}`;
    let acc = motivos.get(key);
    if (!acc) {
      acc = { group, code, desc, count: 0, total: 0 };
      motivos.set(key, acc);
    }
    acc.count += 1;
    acc.total += o.total_amount || 0;
  }
  return [...motivos.values()].sort(
    (a, b) => b.count - a.count || `${a.group}::${a.code}`.localeCompare(`${b.group}::${b.code}`)
  );
}

// ── 10. contarPorStatus ─────────────────────────────────────────────────────

/**
 * Conta pedidos por status. Utilitário para KPIs (ex.: taxa de cancelamento =
 * cancelled / (cancelled + paid)). status ausente → 'desconhecido'.
 */
export function contarPorStatus(orders: OrderInput[]): Record<string, number> {
  const cont: Record<string, number> = {};
  for (const o of orders) {
    const s = o.status || 'desconhecido';
    cont[s] = (cont[s] || 0) + 1;
  }
  return cont;
}