/**
 * Pedidos da Amazon — Orders API v2026-01-01, `searchOrders`.
 *
 * Sincronização incremental por `lastUpdatedAfter`/`lastUpdatedBefore`: toda
 * mudança de pedido (criação, envio, cancelamento) atualiza `lastUpdatedTime`,
 * então uma janela por data de ATUALIZAÇÃO cobre pedidos novos e alterados.
 * Cada janela é um "job" com limite superior FIXO (agora − 2 min, exigência do
 * contrato); o cursor só avança para esse limite quando a última página da
 * janela foi lida. O `nextToken` vale 24 h: um job mais velho que isso
 * recomeça a mesma janela, sem perder nem pular nada.
 *
 * O formato gravado é o da Amazon, normalizado — NÃO o OrderSlim do Mercado
 * Livre. Nenhum status, tarifa ou regra do ML entra aqui. O que conta como
 * venda na Amazon é decisão da etapa de leitura do dashboard.
 */
import type { Cache } from '../lib/cache/cache.js';
import type { ClienteSpApi } from './cliente.js';
import { mesclarColecao } from './store.js';
import {
  PEDIDOS_INCLUDED_DATA, PEDIDOS_POR_PAGINA_MAX, VALIDADE_TOKEN_PEDIDOS_MS, FOLGA_DATA_FINAL_MS,
} from './contrato.js';

// ── Contrato (subconjunto lido) ────────────────────────────────────────────
interface Money { amount: string; currencyCode: string }
interface ApiOrderItem {
  orderItemId: string;
  quantityOrdered: number;
  product: { asin?: string; title?: string; sellerSku?: string; price?: { unitPrice?: Money } };
  proceeds?: { proceedsTotal?: Money; breakdowns?: Array<{ type: string; subtotal: Money }> };
  cancellation?: { cancellationRequest?: { requester?: string; cancelReason?: string }; cancellationExecution?: { cancelledBy?: string; cancelReason?: string } };
  fulfillment?: { quantityFulfilled?: number; quantityUnfulfilled?: number };
}
export interface ApiOrder {
  orderId: string;
  createdTime: string;
  lastUpdatedTime: string;
  programs?: string[];
  salesChannel: { channelName: string; marketplaceId?: string; marketplaceName?: string };
  proceeds?: { grandTotal?: Money; breakdowns?: Array<{ type: string; subtotal: Money }> };
  fulfillment?: { fulfillmentStatus: string; fulfilledBy?: string };
  orderItems: ApiOrderItem[];
}
export interface SearchOrdersResponse { orders: ApiOrder[]; pagination?: { nextToken?: string }; lastUpdatedBefore?: string; createdBefore?: string }

// ── Formato gravado ────────────────────────────────────────────────────────
export interface Valor { valor: number; moeda: string }

export interface PedidoAmazon {
  canal: 'amazon';
  conta: string;
  orderId: string;
  criadoEm: string;
  atualizadoEm: string;
  marketplaceId: string | null;
  canalVenda: string;
  /** FulfillmentStatus da Amazon, sem tradução. Ausente = a Amazon não informou. */
  statusAtendimento: string | null;
  /** AMAZON (FBA) | MERCHANT (envio próprio) | null. */
  atendidoPor: string | null;
  programas: string[];
  /** proceeds.grandTotal: o que o comprador pagou. NÃO é o líquido do vendedor. */
  totalPedido: Valor | null;
  composicaoTotal: Array<{ tipo: string; valor: Valor }>;
  itens: Array<{
    orderItemId: string;
    asin: string | null;
    sku: string | null;
    titulo: string | null;
    quantidade: number;
    quantidadeEnviada: number | null;
    precoUnitario: Valor | null;
    totalItem: Valor | null;
    composicao: Array<{ tipo: string; valor: Valor }>;
    cancelamento: { solicitadoPor: string | null; executadoPor: string | null; motivo: string | null } | null;
  }>;
}

function valor(m: Money | undefined | null): Valor | null {
  if (!m || m.amount === undefined || m.amount === null) return null;
  const n = Number(m.amount);
  return Number.isFinite(n) ? { valor: n, moeda: m.currencyCode } : null;
}
function composicao(b: Array<{ type: string; subtotal: Money }> | undefined): Array<{ tipo: string; valor: Valor }> {
  return (b ?? []).flatMap(x => { const v = valor(x.subtotal); return v ? [{ tipo: x.type, valor: v }] : []; });
}

export function normalizarPedido(o: ApiOrder, conta: string): PedidoAmazon {
  return {
    canal: 'amazon',
    conta,
    orderId: o.orderId,
    criadoEm: o.createdTime,
    atualizadoEm: o.lastUpdatedTime,
    marketplaceId: o.salesChannel?.marketplaceId ?? null,
    canalVenda: o.salesChannel?.channelName ?? 'AMAZON',
    statusAtendimento: o.fulfillment?.fulfillmentStatus ?? null,
    atendidoPor: o.fulfillment?.fulfilledBy ?? null,
    programas: o.programs ?? [],
    totalPedido: valor(o.proceeds?.grandTotal),
    composicaoTotal: composicao(o.proceeds?.breakdowns),
    itens: (o.orderItems ?? []).map(i => {
      const c = i.cancellation;
      return {
        orderItemId: i.orderItemId,
        asin: i.product?.asin ?? null,
        sku: i.product?.sellerSku ?? null,
        titulo: i.product?.title ?? null,
        quantidade: i.quantityOrdered,
        quantidadeEnviada: i.fulfillment?.quantityFulfilled ?? null,
        precoUnitario: valor(i.product?.price?.unitPrice),
        totalItem: valor(i.proceeds?.proceedsTotal),
        composicao: composicao(i.proceeds?.breakdowns),
        cancelamento: c && (c.cancellationRequest || c.cancellationExecution)
          ? {
            solicitadoPor: c.cancellationRequest?.requester ?? null,
            executadoPor: c.cancellationExecution?.cancelledBy ?? null,
            motivo: c.cancellationExecution?.cancelReason ?? c.cancellationRequest?.cancelReason ?? null,
          }
          : null,
      };
    }),
  };
}

// ── Sincronização ──────────────────────────────────────────────────────────
const K = { cursor: 'amz:pedidos:cursor', job: 'amz:pedidos:job' };

interface CursorPedidos { ate: string }
interface JobPedidos { de: string; ate: string; token: string | null; tokenEm: number | null; paginas: number; lidos: number }

export interface ResultadoPedidos {
  concluido: boolean;
  paginas: number;
  pedidos: number;
  janela: { de: string; ate: string };
  /** Até onde a coleção cobre COM CERTEZA (fim da última janela concluída). */
  cobertoAte: string | null;
}

export interface OpcoesPedidos {
  conta: string;
  marketplaceId: string;
  agora?: () => number;
  maxPaginas?: number;
  /** Primeira carga: quantos dias para trás. A Amazon não devolve pedidos com mais de 2 anos. */
  cargaInicialDias?: number;
  /** Instante (ms) a partir do qual não se pede outra página: a função serverless tem 30 s. */
  prazo?: number;
}

export async function sincronizarPedidos(cache: Cache, cliente: ClienteSpApi, o: OpcoesPedidos): Promise<ResultadoPedidos> {
  const agora = o.agora ?? Date.now;
  const maxPaginas = o.maxPaginas ?? 5;
  const cursor = await lerJson<CursorPedidos>(cache, K.cursor);
  let job = await lerJson<JobPedidos>(cache, K.job);

  if (job && job.token && job.tokenEm !== null && agora() - job.tokenEm > VALIDADE_TOKEN_PEDIDOS_MS - 60_000) {
    job = { ...job, token: null, tokenEm: null }; // token vencido: refaz a janela inteira
  }
  if (!job) {
    const de = cursor?.ate ?? new Date(agora() - (o.cargaInicialDias ?? 730) * 86_400_000).toISOString();
    job = { de, ate: new Date(agora() - FOLGA_DATA_FINAL_MS).toISOString(), token: null, tokenEm: null, paginas: 0, lidos: 0 };
    if (job.ate <= job.de) return { concluido: true, paginas: 0, pedidos: 0, janela: { de: job.de, ate: job.ate }, cobertoAte: cursor?.ate ?? null };
    await cache.set(K.job, JSON.stringify(job));
  }

  let paginas = 0, pedidos = 0;
  while (paginas < maxPaginas && (o.prazo === undefined || agora() < o.prazo)) {
    const resp: SearchOrdersResponse = await cliente.chamar<SearchOrdersResponse>('searchOrders', {
      query: {
        lastUpdatedAfter: job.de,
        lastUpdatedBefore: job.ate,
        marketplaceIds: [o.marketplaceId],
        includedData: PEDIDOS_INCLUDED_DATA,
        maxResultsPerPage: PEDIDOS_POR_PAGINA_MAX,
        paginationToken: job.token ?? undefined,
      },
    });
    paginas++;
    const lote: PedidoAmazon[] = (resp.orders ?? []).map((x: ApiOrder) => normalizarPedido(x, o.conta));
    if (lote.length) await mesclarColecao(cache, 'pedidos', lote, p => p.orderId);
    pedidos += lote.length;
    const prox: string | null = resp.pagination?.nextToken ?? null;
    job = { ...job, token: prox, tokenEm: prox ? agora() : null, paginas: job.paginas + 1, lidos: job.lidos + lote.length };
    if (!prox) {
      await cache.set(K.cursor, JSON.stringify({ ate: job.ate } satisfies CursorPedidos));
      await cache.del(K.job);
      return { concluido: true, paginas, pedidos, janela: { de: job.de, ate: job.ate }, cobertoAte: job.ate };
    }
    await cache.set(K.job, JSON.stringify(job));
  }
  return { concluido: false, paginas, pedidos, janela: { de: job.de, ate: job.ate }, cobertoAte: cursor?.ate ?? null };
}

export async function estadoPedidos(cache: Cache): Promise<{ cobertoAte: string | null; jobEmAndamento: boolean }> {
  const c = await lerJson<CursorPedidos>(cache, K.cursor);
  return { cobertoAte: c?.ate ?? null, jobEmAndamento: (await cache.get(K.job)) !== null };
}

async function lerJson<T>(cache: Cache, k: string): Promise<T | null> {
  const raw = await cache.get(k);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export const CHAVES_PEDIDOS = K;
