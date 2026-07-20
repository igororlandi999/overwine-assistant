/**
 * orders-store — ÚNICA camada que conhece o layout das chaves Redis do snapshot
 * de pedidos. Fala só com a interface Cache (get/set/del) — nunca com Upstash
 * direto, nunca com scan/keys/mget.
 *
 * Layout (dois espaços independentes: ativos e cancelados):
 *   orders:manifest                     manifesto PUBLICADO (ponteiro único)
 *   orders:manifest:previous            manifesto da versão imediatamente anterior
 *   orders:chunk:{versao}:{i}           chunk = JSON de OrderSlim[]
 *   orders:cancel:manifest
 *   orders:cancel:manifest:previous
 *   orders:cancel:chunk:{versao}:{i}
 *   orders:build:chunk:{jobId}:{i}      chunks TEMPORÁRIOS de um rebuild
 *
 * Retenção (Correção 1): ao publicar, mantemos a versão atual E a anterior
 * legíveis. Só apagamos os chunks apontados pelo previous ANTIGO. Nunca
 * apagamos imediatamente os chunks do manifesto que está sendo substituído.
 *
 * O manifesto lista TODAS as chaves de chunk explicitamente — a leitura nunca
 * depende de descoberta de chaves.
 */
import type { Cache } from './cache/cache.js';
import type { OrderSlim } from '../services/orders.service.js';

export type Alvo = 'ativos' | 'cancelados';

export interface OrdersManifest {
  versao: number;
  chunks: string[]; // chaves Redis, em ordem (date_desc)
  totalRegistros: number;
  newestDate: string | null;
  oldestDate: string | null;
  chunkSize: number;
  updatedAt: string; // ISO
  origem: 'full' | 'incremental';
}

interface Prefixos {
  manifest: string;
  previous: string;
  chunkBase: string;
}

function prefixos(alvo: Alvo): Prefixos {
  return alvo === 'cancelados'
    ? { manifest: 'orders:cancel:manifest', previous: 'orders:cancel:manifest:previous', chunkBase: 'orders:cancel:chunk' }
    : { manifest: 'orders:manifest', previous: 'orders:manifest:previous', chunkBase: 'orders:chunk' };
}

/** Chave de um chunk publicado. */
export function chunkKey(alvo: Alvo, versao: number, i: number): string {
  return `${prefixos(alvo).chunkBase}:${versao}:${i}`;
}

/** Chave de um chunk TEMPORÁRIO de build (isolado do publicado). */
export function buildChunkKey(jobId: string, i: number): string {
  return `orders:build:chunk:${jobId}:${i}`;
}

function parseManifest(raw: string | null): OrdersManifest | null {
  if (raw === null) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    throw new Error('Manifesto de pedidos corrompido (JSON inválido).');
  }
  const man = m as OrdersManifest;
  if (!man || !Array.isArray(man.chunks) || typeof man.versao !== 'number') {
    throw new Error('Manifesto de pedidos com estrutura inválida.');
  }
  return man;
}

export async function readManifest(cache: Cache, alvo: Alvo): Promise<OrdersManifest | null> {
  return parseManifest(await cache.get(prefixos(alvo).manifest));
}

export async function readPreviousManifest(cache: Cache, alvo: Alvo): Promise<OrdersManifest | null> {
  return parseManifest(await cache.get(prefixos(alvo).previous));
}

/** Grava um chunk (publicado) — array de OrderSlim como JSON string. */
export async function writeChunk(
  cache: Cache,
  alvo: Alvo,
  versao: number,
  i: number,
  pedidos: OrderSlim[]
): Promise<string> {
  const key = chunkKey(alvo, versao, i);
  await cache.set(key, JSON.stringify(pedidos));
  return key;
}

/** Grava um chunk temporário de build. */
export async function writeBuildChunk(
  cache: Cache,
  jobId: string,
  i: number,
  pedidos: OrderSlim[]
): Promise<string> {
  const key = buildChunkKey(jobId, i);
  await cache.set(key, JSON.stringify(pedidos));
  return key;
}

function parseChunk(raw: string | null, key: string): OrderSlim[] {
  if (raw === null) {
    throw new Error(`Chunk ausente no Redis: ${key} (snapshot inconsistente).`);
  }
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('não é array');
    return arr as OrderSlim[];
  } catch {
    throw new Error(`Chunk com JSON inválido: ${key}.`);
  }
}

/** Lê um chunk por chave; erro explícito se ausente ou inválido. */
export async function readChunkByKey(cache: Cache, key: string): Promise<OrderSlim[]> {
  return parseChunk(await cache.get(key), key);
}

/**
 * Lê o snapshot COMPLETO seguindo a lista de chunks do manifesto publicado.
 * Qualquer chunk ausente/ inválido lança — nunca devolve snapshot parcial.
 */
export async function readSnapshot(cache: Cache, alvo: Alvo): Promise<OrderSlim[]> {
  const man = await readManifest(cache, alvo);
  if (!man) return [];
  const out: OrderSlim[] = [];
  for (const key of man.chunks) {
    const pedidos = await readChunkByKey(cache, key);
    out.push(...pedidos);
  }
  return out;
}

/**
 * PUBLICAÇÃO ATÔMICA com retenção da versão anterior (Correção 1).
 * Pré-condição: todos os chunks de `novoManifesto.chunks` já estão gravados.
 * Passos exatos:
 *   1. (chunks já gravados pelo chamador)
 *   2. ler manifesto atual (o que será substituído)
 *   3. ler manifesto previous (o mais antigo — cujos chunks serão apagados)
 *   4. apagar SOMENTE os chunks do previous ANTIGO
 *   5. gravar o manifesto atual em manifest:previous
 *   6. publicar o novo manifesto em manifest
 * A versão nova e a imediatamente anterior permanecem legíveis.
 */
export async function publishManifest(
  cache: Cache,
  alvo: Alvo,
  novoManifesto: OrdersManifest
): Promise<void> {
  const p = prefixos(alvo);
  const atual = await readManifest(cache, alvo); // vira o novo "previous"
  const previousAntigo = await readPreviousManifest(cache, alvo);

  // 4) apagar apenas os chunks do previous antigo — nunca os do atual.
  if (previousAntigo) {
    const chavesAtuais = new Set(atual?.chunks ?? []);
    const chavesNovas = new Set(novoManifesto.chunks);
    for (const key of previousAntigo.chunks) {
      // proteção extra: só apaga se a chave não for reutilizada pelo atual/novo
      if (!chavesAtuais.has(key) && !chavesNovas.has(key)) {
        await cache.del(key);
      }
    }
  }

  // 5) manifesto atual → previous (se existir)
  if (atual) {
    await cache.set(p.previous, JSON.stringify(atual));
  }
  // 6) publica o novo (troca atômica do ponteiro)
  await cache.set(p.manifest, JSON.stringify(novoManifesto));
}

/** Apaga um conjunto de chunks de build (limpeza pós-publicação). */
export async function deleteBuildChunks(cache: Cache, keys: string[]): Promise<void> {
  for (const key of keys) await cache.del(key);
}
