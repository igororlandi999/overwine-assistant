/**
 * Abstração de cache — nenhum serviço ou endpoint importa Upstash diretamente.
 * Trocar de provedor = escrever um novo adapter que implemente esta interface.
 */
export interface Cache {
  get(key: string): Promise<string | null>;
  /** ttlSeconds opcional; sem TTL o valor persiste. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** SET NX — retorna true se adquiriu (usado como lock distribuído). */
  setNX(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /**
   * Compare-and-delete ATÔMICO: apaga a chave somente se o valor atual for
   * exatamente `value`. Evita que uma instância apague um lock que expirou
   * e já foi adquirido por outra. Retorna true se apagou.
   */
  delIfEquals(key: string, value: string): Promise<boolean>;
  /** INCR com TTL na primeira escrita — usado para rate limiting. */
  incr(key: string, ttlSeconds: number): Promise<number>;
}

import { UpstashCache } from './upstash.js';

let instance: Cache | null = null;

export function getCache(): Cache {
  if (!instance) instance = new UpstashCache();
  return instance;
}

/** Permite injetar um cache fake nos testes. */
export function setCacheForTests(c: Cache) {
  instance = c;
}
