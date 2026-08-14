/**
 * items-catalog.service — snapshot de catálogo (anúncios) para o boot do
 * dashboard em UMA requisição.
 *
 * Serviço PURO quanto a rede: o acesso ao Mercado Livre entra por INJEÇÃO
 * (`FetchItemIds` / `FetchItemsBatch`), como em orders-sync. Ele conhece Redis
 * apenas através de items-store e da interface Cache.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RECORTE DE CAMPOS (Onda E)
 *
 * `toSlimItem` mantém EXATAMENTE os 18 campos que o dashboard usa, derivados
 * do levantamento de acessos no index.html. Em particular:
 *   - `shipping` guarda SOMENTE logistic_type (isFullItem);
 *   - `attributes` guarda SOMENTE o par SELLER_SKU (itemSKU), nunca a lista
 *     completa — um anúncio de vinho carrega dezenas de atributos.
 * Campos deliberadamente DESCARTADOS por não terem nenhum uso no frontend:
 * health, sub_status, variations, base_price, category_id, condition,
 * date_created, catalog_product_id.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * COMPLETUDE (invariante não-negociável)
 *
 * Um catálogo só é `complete: true` quando TODOS os ids descobertos na busca
 * por status foram resolvidos em detalhe. Qualquer teto de chamadas atingido,
 * lote que falhou ou id sem corpo torna o resultado INCOMPLETO, e um resultado
 * incompleto:
 *   - nunca é publicado (publishCatalog recusa);
 *   - nunca é devolvido como `ok:true` completo;
 *   - faz a rota cair para o snapshot completo anterior, se existir.
 */
import type { Cache } from '../lib/cache/cache.js';
import {
  publishCatalog,
  readCatalog,
  readCatalogManifest,
  writeCatalogChunk,
  type CatalogCounts,
  type CatalogManifest,
  type ItemSlim,
} from '../lib/items-store.js';

// ── entrada crua (o que o ML devolve) ───────────────────────────────────────

export interface ItemAtributoBruto {
  id?: string | null;
  value_name?: string | null;
}

export interface ItemBruto {
  id?: string | null;
  title?: string | null;
  status?: string | null;
  price?: number | null;
  original_price?: number | null;
  available_quantity?: number | null;
  sold_quantity?: number | null;
  listing_type_id?: string | null;
  catalog_listing?: boolean | null;
  inventory_id?: string | null;
  permalink?: string | null;
  thumbnail?: string | null;
  last_updated?: string | null;
  seller_custom_field?: string | null;
  seller_sku?: string | null;
  tags?: string[] | null;
  shipping?: { logistic_type?: string | null } | null;
  attributes?: ItemAtributoBruto[] | null;
  [k: string]: unknown;
}

export type StatusCatalogo = 'active' | 'paused' | 'closed';
export const STATUS_CATALOGO: StatusCatalogo[] = ['active', 'paused', 'closed'];

/** Busca uma página de ids de um status. Injetada pela rota. */
export type FetchItemIds = (
  status: StatusCatalogo,
  offset: number
) => Promise<{ results: string[]; total: number }>;

/** Busca o detalhe de até 20 ids. Injetada pela rota. */
export type FetchItemsBatch = (ids: string[]) => Promise<ItemBruto[]>;

// ── recorte ─────────────────────────────────────────────────────────────────

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Reduz um anúncio ao recorte mínimo. NUNCA carrega campos fora da lista. */
export function toSlimItem(item: ItemBruto): ItemSlim | null {
  const id = str(item.id);
  if (!id) return null;

  // Apenas o par SELLER_SKU sobrevive — itemSKU() do dashboard só lê esse.
  const sellerSku = (item.attributes ?? [])
    .filter(a => a && a.id === 'SELLER_SKU')
    .slice(0, 1)
    .map(a => ({ id: 'SELLER_SKU', value_name: str(a.value_name) }));

  return {
    id,
    title: str(item.title),
    status: str(item.status),
    price: num(item.price),
    original_price: num(item.original_price),
    available_quantity: num(item.available_quantity),
    sold_quantity: num(item.sold_quantity),
    listing_type_id: str(item.listing_type_id),
    catalog_listing: typeof item.catalog_listing === 'boolean' ? item.catalog_listing : null,
    inventory_id: str(item.inventory_id),
    permalink: str(item.permalink),
    thumbnail: str(item.thumbnail),
    last_updated: str(item.last_updated),
    seller_custom_field: str(item.seller_custom_field),
    seller_sku: str(item.seller_sku),
    tags: Array.isArray(item.tags) ? item.tags.filter(t => typeof t === 'string') : null,
    shipping: item.shipping ? { logistic_type: str(item.shipping.logistic_type) } : null,
    attributes: sellerSku.length ? sellerSku : null,
  };
}

export function contar(itens: ItemSlim[]): CatalogCounts {
  const c: CatalogCounts = { total: itens.length, active: 0, paused: 0, closed: 0 };
  for (const i of itens) {
    if (i.status === 'active') c.active++;
    else if (i.status === 'paused') c.paused++;
    else if (i.status === 'closed') c.closed++;
  }
  return c;
}

// ── construção ──────────────────────────────────────────────────────────────

export const IDS_POR_PAGINA = 100;   // limite da busca por status no ML
export const IDS_POR_LOTE = 20;      // limite de /items?ids= (zod: max 20)
export const CONCORRENCIA = 8;       // lotes simultâneos por rodada

export interface ConstruirOpcoes {
  /** Teto de chamadas ao ML por construção (protege maxDuration e rate limit). */
  maxChamadas?: number;
  concorrencia?: number;
}

export interface ResultadoConstrucao {
  /** false => NÃO publicar, NÃO devolver como catálogo válido. */
  complete: boolean;
  itens: ItemSlim[];
  counts: CatalogCounts;
  chamadas: number;
  /** Códigos estáveis: teto_de_chamadas, lote_falhou, id_sem_detalhe. */
  motivos: string[];
}

/**
 * Constrói o catálogo a partir do ML. Não escreve no Redis: quem decide
 * publicar é `reconstruirCatalogo`, e só se `complete === true`.
 */
export async function construirCatalogo(
  fetchIds: FetchItemIds,
  fetchBatch: FetchItemsBatch,
  opts: ConstruirOpcoes = {}
): Promise<ResultadoConstrucao> {
  const maxChamadas = opts.maxChamadas ?? 200;
  const conc = opts.concorrencia ?? CONCORRENCIA;
  const motivos: string[] = [];
  let chamadas = 0;
  let completo = true;

  // 1) ids por status, os 3 em paralelo (paginação interna sequencial).
  const porStatus = await Promise.all(STATUS_CATALOGO.map(async status => {
    const ids: string[] = [];
    let offset = 0;
    for (;;) {
      if (chamadas >= maxChamadas) { completo = false; motivos.push('teto_de_chamadas'); return ids; }
      chamadas++;
      const pg = await fetchIds(status, offset);
      ids.push(...pg.results);
      offset += IDS_POR_PAGINA;
      if (offset >= pg.total || pg.results.length === 0) break;
    }
    return ids;
  }));

  // Ordem preservada: active, paused, closed (mesma do dashboard legado).
  const todosIds: string[] = [];
  for (const ids of porStatus) todosIds.push(...ids);

  if (!completo) {
    return { complete: false, itens: [], counts: contar([]), chamadas, motivos: dedup(motivos) };
  }

  // 2) detalhe em lotes de 20, em rodadas de `conc`.
  const lotes: string[][] = [];
  for (let i = 0; i < todosIds.length; i += IDS_POR_LOTE) lotes.push(todosIds.slice(i, i + IDS_POR_LOTE));

  const porLote: (ItemSlim[] | null)[] = new Array(lotes.length).fill(null);
  for (let r = 0; r < lotes.length; r += conc) {
    if (chamadas >= maxChamadas) { completo = false; motivos.push('teto_de_chamadas'); break; }
    const rodada = lotes.slice(r, r + conc);
    chamadas += rodada.length;
    const saidas = await Promise.allSettled(rodada.map(l => fetchBatch(l)));
    for (let k = 0; k < saidas.length; k++) {
      const s = saidas[k];
      if (s.status !== 'fulfilled') { completo = false; motivos.push('lote_falhou'); continue; }
      const slim: ItemSlim[] = [];
      for (const bruto of s.value) {
        const item = toSlimItem(bruto);
        if (item) slim.push(item);
      }
      porLote[r + k] = slim;
    }
  }

  const itens: ItemSlim[] = [];
  for (const parte of porLote) {
    if (parte === null) { completo = false; continue; }
    itens.push(...parte);
  }

  // Todo id descoberto precisa ter virado item. Senão, o catálogo é incompleto.
  if (completo && itens.length !== todosIds.length) {
    completo = false;
    motivos.push('id_sem_detalhe');
  }

  return { complete: completo, itens, counts: contar(itens), chamadas, motivos: dedup(motivos) };
}

function dedup(a: string[]): string[] {
  return Array.from(new Set(a));
}

/**
 * Constrói e, SE completo, publica. Devolve o manifesto publicado ou null
 * quando a construção foi incompleta — nesse caso nada é escrito no Redis e o
 * snapshot anterior permanece intacto.
 */
export async function reconstruirCatalogo(
  cache: Cache,
  fetchIds: FetchItemIds,
  fetchBatch: FetchItemsBatch,
  chunkSize: number,
  opts: ConstruirOpcoes = {},
  agora: Date = new Date()
): Promise<{ manifest: CatalogManifest | null; resultado: ResultadoConstrucao }> {
  const resultado = await construirCatalogo(fetchIds, fetchBatch, opts);
  if (!resultado.complete) return { manifest: null, resultado };

  const anterior = await readCatalogManifest(cache).catch(() => null);
  const versao = (anterior?.versao ?? 0) + 1;

  const chunks: string[] = [];
  for (let i = 0; i * chunkSize < resultado.itens.length; i++) {
    chunks.push(await writeCatalogChunk(
      cache, versao, i, resultado.itens.slice(i * chunkSize, (i + 1) * chunkSize)
    ));
  }
  // Catálogo vazio ainda precisa de um chunk para o manifesto ser coerente.
  if (chunks.length === 0) chunks.push(await writeCatalogChunk(cache, versao, 0, []));

  const manifest: CatalogManifest = {
    versao,
    chunks,
    counts: resultado.counts,
    chunkSize,
    updatedAt: agora.toISOString(),
    complete: true,
  };
  await publishCatalog(cache, manifest);
  return { manifest, resultado };
}

// ── frescor e resposta ──────────────────────────────────────────────────────

export type CatalogSource = 'snapshot' | 'rebuilt' | 'fallback_stale';

export interface CatalogFreshness {
  ageSeconds: number;
  stale: boolean;
  softTtlSeconds: number;
  hardTtlSeconds: number;
}

export interface CatalogResponse {
  versao: number;
  updatedAt: string;
  source: CatalogSource;
  complete: true;
  freshness: CatalogFreshness;
  counts: CatalogCounts;
  items: ItemSlim[];
  warnings: string[];
}

export function idadeSegundos(updatedAt: string, agora: Date = new Date()): number {
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((agora.getTime() - t) / 1000));
}

/** true quando o manifesto passou do TTL hard e precisa ser reconstruído. */
export function precisaReconstruir(
  man: CatalogManifest | null,
  hardTtlS: number,
  agora: Date = new Date()
): boolean {
  if (!man) return true;
  return idadeSegundos(man.updatedAt, agora) > hardTtlS;
}

export function montarResposta(
  man: CatalogManifest,
  items: ItemSlim[],
  source: CatalogSource,
  softTtlS: number,
  hardTtlS: number,
  warnings: string[] = [],
  agora: Date = new Date()
): CatalogResponse {
  const ageSeconds = idadeSegundos(man.updatedAt, agora);
  return {
    versao: man.versao,
    updatedAt: man.updatedAt,
    source,
    complete: true,   // só chega aqui manifesto publicado, que é sempre completo
    freshness: { ageSeconds, stale: ageSeconds > softTtlS, softTtlSeconds: softTtlS, hardTtlSeconds: hardTtlS },
    counts: man.counts,
    items,
    warnings,
  };
}

/** Lê o catálogo publicado. Lança se algum chunk estiver ausente/inválido. */
export async function lerCatalogoPublicado(
  cache: Cache,
  man: CatalogManifest
): Promise<ItemSlim[]> {
  return readCatalog(cache, man);
}