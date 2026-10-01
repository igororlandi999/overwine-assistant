/**
 * Armazém simples de registros da Amazon no cache DA CONTA, por coleção:
 *
 *   amz:<colecao>:manifest        { versao, chaves[], total, atualizadoEm }
 *   amz:<colecao>:chunk:<v>:<i>   JSON de registros
 *
 * Escrita = nova versão completa e troca do manifesto (o leitor nunca vê meia
 * versão), depois apaga os blocos da versão anterior. Mesmo princípio do
 * orders-store do Mercado Livre, sem compartilhar chaves nem formato com ele.
 */
import type { Cache } from '../lib/cache/cache.js';

export type Colecao = 'pedidos' | 'anuncios' | 'estoque-fba' | 'financeiro';

export interface ManifestoAmz {
  versao: number;
  chaves: string[];
  total: number;
  atualizadoEm: string;
}

const POR_BLOCO = 200;
const chaveManifesto = (c: Colecao) => `amz:${c}:manifest`;

export async function lerManifesto(cache: Cache, c: Colecao): Promise<ManifestoAmz | null> {
  const raw = await cache.get(chaveManifesto(c));
  return raw ? JSON.parse(raw) as ManifestoAmz : null;
}

export async function lerColecao<T>(cache: Cache, c: Colecao): Promise<T[]> {
  const man = await lerManifesto(cache, c);
  if (!man) return [];
  const out: T[] = [];
  for (const k of man.chaves) {
    const raw = await cache.get(k);
    if (raw === null) throw new Error(`amz:${c}: bloco ${k} ausente na versão ${man.versao}`);
    out.push(...JSON.parse(raw) as T[]);
  }
  return out;
}

export async function gravarColecao<T>(cache: Cache, c: Colecao, registros: T[], agora = new Date()): Promise<ManifestoAmz> {
  const anterior = await lerManifesto(cache, c);
  const versao = (anterior?.versao ?? 0) + 1;
  const chaves: string[] = [];
  for (let i = 0; i * POR_BLOCO < registros.length || i === 0; i++) {
    const k = `amz:${c}:chunk:${versao}:${i}`;
    await cache.set(k, JSON.stringify(registros.slice(i * POR_BLOCO, (i + 1) * POR_BLOCO)));
    chaves.push(k);
  }
  const man: ManifestoAmz = { versao, chaves, total: registros.length, atualizadoEm: agora.toISOString() };
  await cache.set(chaveManifesto(c), JSON.stringify(man));
  if (anterior) for (const k of anterior.chaves) await cache.del(k);
  return man;
}

/**
 * Construção em blocos de uma coleção completa, ao longo de várias
 * invocações: cada página vira um bloco de construção; só no fim o manifesto
 * passa a apontar para eles. Uma construção interrompida nunca é publicada.
 */
export async function gravarBlocoDeConstrucao<T>(cache: Cache, c: Colecao, construcao: string, i: number, registros: T[]): Promise<string> {
  const k = `amz:${c}:build:${construcao}:${i}`;
  await cache.set(k, JSON.stringify(registros), 7 * 24 * 3600);
  return k;
}

export async function publicarConstrucao(cache: Cache, c: Colecao, chaves: string[], total: number, agora = new Date()): Promise<ManifestoAmz> {
  const anterior = await lerManifesto(cache, c);
  const versao = (anterior?.versao ?? 0) + 1;
  // Os blocos de construção tinham TTL: regrava sem TTL antes de publicar.
  const definitivas: string[] = [];
  for (let i = 0; i < chaves.length; i++) {
    const raw = await cache.get(chaves[i]);
    if (raw === null) throw new Error(`amz:${c}: bloco de construção ${chaves[i]} expirou antes da publicação`);
    const k = `amz:${c}:chunk:${versao}:${i}`;
    await cache.set(k, raw);
    definitivas.push(k);
  }
  const man: ManifestoAmz = { versao, chaves: definitivas, total, atualizadoEm: agora.toISOString() };
  await cache.set(chaveManifesto(c), JSON.stringify(man));
  for (const k of chaves) await cache.del(k);
  if (anterior) for (const k of anterior.chaves) await cache.del(k);
  return man;
}

/** Junta registros novos aos existentes pela chave; o novo substitui o antigo. */
export async function mesclarColecao<T>(cache: Cache, c: Colecao, novos: T[], chave: (r: T) => string, agora = new Date()): Promise<ManifestoAmz> {
  const mapa = new Map<string, T>();
  for (const r of await lerColecao<T>(cache, c)) mapa.set(chave(r), r);
  for (const r of novos) mapa.set(chave(r), r);
  return gravarColecao(cache, c, [...mapa.values()], agora);
}
