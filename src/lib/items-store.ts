/**
 * items-store — ÚNICA camada que conhece o layout das chaves Redis do snapshot
 * de CATÁLOGO (anúncios). Espelha orders-store: fala só com a interface Cache
 * (get/set/del/setNX/delIfEquals) — nunca com Upstash direto, nunca com
 * scan/keys/mget.
 *
 * Layout:
 *   items:catalog:manifest            manifesto PUBLICADO (ponteiro único)
 *   items:catalog:manifest:previous   manifesto da versão imediatamente anterior
 *   items:catalog:chunk:{versao}:{i}  chunk = JSON de ItemSlim[]
 *   items:catalog:lock                lock de reconstrução (setNX/delIfEquals)
 *   items:catalog:cooldown            cooldown de refresh forçado
 *
 * INVARIANTE CENTRAL (Onda E): o manifesto publicado é SEMPRE completo.
 * `publishCatalog` recusa manifesto com `complete !== true`, então um snapshot
 * parcial nunca substitui um snapshot completo — nem por engano de chamador.
 *
 * O manifesto lista TODAS as chaves de chunk explicitamente: a leitura nunca
 * depende de descoberta de chaves.
 */
import type { Cache } from './cache/cache.js';

/** Anúncio no recorte MÍNIMO usado pelo dashboard (Onda E). */
export interface ItemSlim {
  id: string;
  title: string | null;
  status: string | null;
  price: number | null;
  original_price: number | null;
  available_quantity: number | null;
  sold_quantity: number | null;
  listing_type_id: string | null;
  catalog_listing: boolean | null;
  inventory_id: string | null;
  permalink: string | null;
  thumbnail: string | null;
  last_updated: string | null;
  seller_custom_field: string | null;
  seller_sku: string | null;
  tags: string[] | null;
  /** SOMENTE logistic_type — o restante de shipping nunca é persistido. */
  shipping: { logistic_type: string | null } | null;
  /** SOMENTE o par SELLER_SKU — nunca a lista completa de atributos. */
  attributes: Array<{ id: string; value_name: string | null }> | null;
}

export interface CatalogCounts {
  total: number;
  active: number;
  paused: number;
  closed: number;
}

export interface CatalogManifest {
  versao: number;
  chunks: string[];      // chaves Redis, na ordem active → paused → closed
  counts: CatalogCounts;
  chunkSize: number;
  updatedAt: string;     // ISO do momento da publicação
  /** Sempre true no publicado. Existe explicitamente no contrato e no store. */
  complete: true;
}

const K = {
  manifest: 'items:catalog:manifest',
  previous: 'items:catalog:manifest:previous',
  chunkBase: 'items:catalog:chunk',
  lock: 'items:catalog:lock',
  cooldown: 'items:catalog:cooldown',
} as const;

export const CATALOG_LOCK_KEY = K.lock;
export const CATALOG_COOLDOWN_KEY = K.cooldown;

/** Chave de um chunk publicado. */
export function catalogChunkKey(versao: number, i: number): string {
  return `${K.chunkBase}:${versao}:${i}`;
}

function parseManifest(raw: string | null): CatalogManifest | null {
  if (raw === null) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    throw new Error('Manifesto de catálogo corrompido (JSON inválido).');
  }
  const man = m as CatalogManifest;
  if (!man || !Array.isArray(man.chunks) || typeof man.versao !== 'number' ||
      !man.counts || typeof man.counts.total !== 'number' || man.complete !== true) {
    throw new Error('Manifesto de catálogo com estrutura inválida.');
  }
  return man;
}

export async function readCatalogManifest(cache: Cache): Promise<CatalogManifest | null> {
  return parseManifest(await cache.get(K.manifest));
}

export async function readPreviousCatalogManifest(cache: Cache): Promise<CatalogManifest | null> {
  return parseManifest(await cache.get(K.previous));
}

/** Grava um chunk publicado — array de ItemSlim como JSON string. */
export async function writeCatalogChunk(
  cache: Cache,
  versao: number,
  i: number,
  itens: ItemSlim[]
): Promise<string> {
  const key = catalogChunkKey(versao, i);
  await cache.set(key, JSON.stringify(itens));
  return key;
}

function parseChunk(raw: string | null, key: string): ItemSlim[] {
  if (raw === null) {
    throw new Error(`Chunk de catálogo ausente no Redis: ${key} (snapshot inconsistente).`);
  }
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('não é array');
    return arr as ItemSlim[];
  } catch {
    throw new Error(`Chunk de catálogo com JSON inválido: ${key}.`);
  }
}

export async function readCatalogChunkByKey(cache: Cache, key: string): Promise<ItemSlim[]> {
  return parseChunk(await cache.get(key), key);
}

/**
 * Lê o catálogo COMPLETO seguindo a lista de chunks do manifesto publicado.
 * Qualquer chunk ausente ou inválido lança — nunca devolve catálogo parcial.
 */
export async function readCatalog(cache: Cache, man: CatalogManifest): Promise<ItemSlim[]> {
  const out: ItemSlim[] = [];
  for (const key of man.chunks) {
    out.push(...(await readCatalogChunkByKey(cache, key)));
  }
  if (out.length !== man.counts.total) {
    throw new Error('Catálogo inconsistente: itens lidos ≠ counts.total.');
  }
  return out;
}

/**
 * Publica um novo manifesto. RECUSA manifesto incompleto: essa é a barreira
 * final contra um snapshot parcial substituir um completo.
 * Mantém a versão anterior legível (mesma retenção do orders-store): só
 * apagamos os chunks apontados pelo `previous` ANTIGO.
 */
export async function publishCatalog(cache: Cache, man: CatalogManifest): Promise<void> {
  if (man.complete !== true) {
    throw new Error('Recusado: catálogo parcial não pode ser publicado.');
  }
  const previousAntigo = await readPreviousCatalogManifest(cache).catch(() => null);
  const atual = await readCatalogManifest(cache).catch(() => null);

  await cache.set(K.manifest, JSON.stringify(man));
  if (atual) await cache.set(K.previous, JSON.stringify(atual));

  if (previousAntigo && previousAntigo.versao !== man.versao &&
      (!atual || previousAntigo.versao !== atual.versao)) {
    for (const key of previousAntigo.chunks) {
      await cache.del(key);
    }
  }
}