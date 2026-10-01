/**
 * Anúncios e estoque da Amazon.
 *
 * ANÚNCIOS — Listings Items v2021-08-01, `searchListingsItems` (por sellerId),
 * com `summaries` (ASIN, título, status), `offers` (preço) e
 * `fulfillmentAvailability` (quantidade por canal de atendimento). Coleção
 * publicada só quando COMPLETA: uma varredura interrompida continua na
 * próxima invocação e nunca substitui a última completa.
 *
 * ESTOQUE FBA — FBA Inventory v1, `getInventorySummaries`. O `nextToken`
 * expira em 30 s, então a varredura inteira acontece numa invocação. Se a
 * conta não usa FBA, ou o app não tem a função, o estoque FBA fica
 * INDISPONÍVEL com o motivo — nunca zero.
 *
 * Estoque próprio (envio pelo vendedor) vem da quantidade do canal DEFAULT em
 * `fulfillmentAvailability`. FBA e próprio ficam separados; nada é somado nem
 * deduplicado com o Mercado Livre.
 */
import { randomBytes } from 'node:crypto';
import type { Cache } from '../lib/cache/cache.js';
import { ErroSpApi, type ClienteSpApi } from './cliente.js';
import { gravarBlocoDeConstrucao, publicarConstrucao, gravarColecao } from './store.js';
import { ANUNCIOS_INCLUDED_DATA, ANUNCIOS_POR_PAGINA_MAX } from './contrato.js';
import type { Valor } from './pedidos.js';

// ── Contrato (subconjunto lido) ────────────────────────────────────────────
interface Money { amount: string; currencyCode: string }
interface ApiListing {
  sku: string;
  summaries?: Array<{ marketplaceId: string; asin?: string; productType: string; conditionType?: string; status: string[]; fnSku?: string; itemName?: string; createdDate: string; lastUpdatedDate: string; mainImage?: { link: string } }>;
  offers?: Array<{ marketplaceId: string; offerType: string; price: Money }>;
  fulfillmentAvailability?: Array<{ fulfillmentChannelCode: string; quantity?: number }>;
}
export interface SearchListingsResponse { numberOfResults: number; pagination?: { nextToken?: string }; items: ApiListing[] }

interface ApiInventorySummary {
  asin?: string; fnSku?: string; sellerSku?: string; productName?: string; totalQuantity?: number; lastUpdatedTime?: string;
  inventoryDetails?: {
    fulfillableQuantity?: number; inboundWorkingQuantity?: number; inboundShippedQuantity?: number; inboundReceivingQuantity?: number;
    reservedQuantity?: { totalReservedQuantity?: number };
    unfulfillableQuantity?: { totalUnfulfillableQuantity?: number };
  };
}
export interface InventorySummariesResponse { payload?: { inventorySummaries: ApiInventorySummary[] }; pagination?: { nextToken?: string }; errors?: unknown[] }

// ── Formatos gravados ──────────────────────────────────────────────────────
export interface AnuncioAmazon {
  canal: 'amazon';
  conta: string;
  sku: string;
  asin: string | null;
  titulo: string | null;
  tipoProduto: string | null;
  condicao: string | null;
  /** BUYABLE / DISCOVERABLE, como a Amazon devolve. Lista vazia = nenhum dos dois. */
  status: string[];
  fnSku: string | null;
  /** Oferta B2C no marketplace da conta. */
  preco: Valor | null;
  disponibilidade: Array<{ canal: string; quantidade: number | null }>;
  /** Quantidade do canal DEFAULT (envio pelo vendedor). null = a Amazon não informou. */
  estoqueProprio: number | null;
  criadoEm: string | null;
  atualizadoEm: string | null;
  imagem: string | null;
}

export interface EstoqueFbaAmazon {
  canal: 'amazon';
  conta: string;
  sku: string | null;
  asin: string | null;
  fnSku: string | null;
  disponivel: number | null;
  total: number | null;
  reservado: number | null;
  aCaminho: number | null;
  indisponivelParaVenda: number | null;
  atualizadoEm: string | null;
}

export function normalizarAnuncio(l: ApiListing, conta: string, marketplaceId: string): AnuncioAmazon {
  const s = (l.summaries ?? []).find(x => x.marketplaceId === marketplaceId) ?? null;
  const oferta = (l.offers ?? []).find(x => x.marketplaceId === marketplaceId && x.offerType === 'B2C') ?? null;
  const n = oferta ? Number(oferta.price?.amount) : NaN;
  const disp = (l.fulfillmentAvailability ?? []).map(f => ({ canal: f.fulfillmentChannelCode, quantidade: Number.isInteger(f.quantity) ? f.quantity! : null }));
  const proprio = disp.find(d => d.canal === 'DEFAULT');
  return {
    canal: 'amazon', conta, sku: l.sku,
    asin: s?.asin ?? null, titulo: s?.itemName ?? null, tipoProduto: s?.productType ?? null, condicao: s?.conditionType ?? null,
    status: s?.status ?? [], fnSku: s?.fnSku ?? null,
    preco: Number.isFinite(n) ? { valor: n, moeda: oferta!.price.currencyCode } : null,
    disponibilidade: disp,
    estoqueProprio: proprio ? proprio.quantidade : null,
    criadoEm: s?.createdDate ?? null, atualizadoEm: s?.lastUpdatedDate ?? null, imagem: s?.mainImage?.link ?? null,
  };
}

export function normalizarEstoqueFba(x: ApiInventorySummary, conta: string): EstoqueFbaAmazon {
  const d = x.inventoryDetails;
  const soma = (...v: Array<number | undefined>) => v.some(n => Number.isInteger(n)) ? v.reduce<number>((s, n) => s + (n ?? 0), 0) : null;
  return {
    canal: 'amazon', conta, sku: x.sellerSku ?? null, asin: x.asin ?? null, fnSku: x.fnSku ?? null,
    disponivel: d?.fulfillableQuantity ?? null,
    total: x.totalQuantity ?? null,
    reservado: d?.reservedQuantity?.totalReservedQuantity ?? null,
    aCaminho: d ? soma(d.inboundWorkingQuantity, d.inboundShippedQuantity, d.inboundReceivingQuantity) : null,
    indisponivelParaVenda: d?.unfulfillableQuantity?.totalUnfulfillableQuantity ?? null,
    atualizadoEm: x.lastUpdatedTime ?? null,
  };
}

// ── Anúncios ───────────────────────────────────────────────────────────────
const K = { jobAnuncios: 'amz:anuncios:job', estadoFba: 'amz:estoque-fba:estado' };
interface JobAnuncios { id: string; token: string | null; blocos: string[]; total: number; inicio: string }

export interface ResultadoAnuncios { concluido: boolean; paginas: number; anuncios: number }

export async function sincronizarAnuncios(
  cache: Cache, cliente: ClienteSpApi,
  o: { conta: string; sellerId: string; marketplaceId: string; maxPaginas?: number; agora?: () => number; prazo?: number },
): Promise<ResultadoAnuncios> {
  const agora = o.agora ?? Date.now;
  const raw = await cache.get(K.jobAnuncios);
  let job: JobAnuncios = raw ? JSON.parse(raw) as JobAnuncios
    : { id: randomBytes(6).toString('hex'), token: null, blocos: [], total: 0, inicio: new Date(agora()).toISOString() };
  let paginas = 0;
  while (paginas < (o.maxPaginas ?? 25) && (o.prazo === undefined || agora() < o.prazo)) {
    let resp: SearchListingsResponse;
    try {
      resp = await cliente.chamar<SearchListingsResponse>('searchListingsItems', {
        caminho: { sellerId: o.sellerId },
        query: {
          marketplaceIds: [o.marketplaceId], includedData: ANUNCIOS_INCLUDED_DATA,
          pageSize: ANUNCIOS_POR_PAGINA_MAX, pageToken: job.token ?? undefined,
        },
      });
    } catch (e) {
      // Token de página recusado: a varredura recomeça do zero na próxima vez.
      if (e instanceof ErroSpApi && e.motivo === 'requisicao_invalida' && job.token) await cache.del(K.jobAnuncios);
      throw e;
    }
    paginas++;
    const lote = (resp.items ?? []).map(l => normalizarAnuncio(l, o.conta, o.marketplaceId));
    const k = await gravarBlocoDeConstrucao(cache, 'anuncios', job.id, job.blocos.length, lote);
    job = { ...job, blocos: [...job.blocos, k], total: job.total + lote.length, token: resp.pagination?.nextToken ?? null };
    if (!job.token) {
      await publicarConstrucao(cache, 'anuncios', job.blocos, job.total, new Date(agora()));
      await cache.del(K.jobAnuncios);
      return { concluido: true, paginas, anuncios: job.total };
    }
    await cache.set(K.jobAnuncios, JSON.stringify(job), 7 * 24 * 3600);
  }
  return { concluido: false, paginas, anuncios: job.total };
}

// ── Estoque FBA ────────────────────────────────────────────────────────────
export interface EstadoEstoqueFba {
  disponivel: boolean;
  /** Quando indisponível: por quê. `sem_permissao` = app sem a função ou conta sem FBA neste marketplace. */
  motivo: string | null;
  verificadoEm: string;
}

export async function sincronizarEstoqueFba(
  cache: Cache, cliente: ClienteSpApi,
  o: { conta: string; marketplaceId: string; maxPaginas?: number; agora?: () => number },
): Promise<{ estado: EstadoEstoqueFba; registros: number; paginas: number }> {
  const agora = o.agora ?? Date.now;
  const todos: EstoqueFbaAmazon[] = [];
  let token: string | null = null, paginas = 0;
  try {
    do {
      const resp: InventorySummariesResponse = await cliente.chamar<InventorySummariesResponse>('getInventorySummaries', {
        query: {
          details: true, granularityType: 'Marketplace', granularityId: o.marketplaceId,
          marketplaceIds: [o.marketplaceId], nextToken: token ?? undefined,
        },
      });
      paginas++;
      todos.push(...(resp.payload?.inventorySummaries ?? []).map(x => normalizarEstoqueFba(x, o.conta)));
      token = resp.pagination?.nextToken ?? null;
    } while (token && paginas < (o.maxPaginas ?? 20));
  } catch (e) {
    if (e instanceof ErroSpApi && (e.motivo === 'sem_permissao' || e.motivo === 'requisicao_invalida')) {
      // Conta sem FBA ou app sem a função: indisponível, sem apagar o que existir e sem gravar zero.
      const estado: EstadoEstoqueFba = { disponivel: false, motivo: e.motivo, verificadoEm: new Date(agora()).toISOString() };
      await cache.set(K.estadoFba, JSON.stringify(estado));
      return { estado, registros: 0, paginas };
    }
    throw e;
  }
  if (token) throw new Error('estoque FBA: varredura não terminou numa invocação (nextToken expira em 30 s)');
  await gravarColecao(cache, 'estoque-fba', todos, new Date(agora()));
  const estado: EstadoEstoqueFba = { disponivel: true, motivo: null, verificadoEm: new Date(agora()).toISOString() };
  await cache.set(K.estadoFba, JSON.stringify(estado));
  return { estado, registros: todos.length, paginas };
}

export async function lerEstadoEstoqueFba(cache: Cache): Promise<EstadoEstoqueFba | null> {
  const raw = await cache.get(K.estadoFba);
  return raw ? JSON.parse(raw) as EstadoEstoqueFba : null;
}

export const CHAVES_CATALOGO = K;
