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

  /**
   * FILA (lista Redis). Existe para a fila de notificações do Mercado Livre:
   * duas notificações podem chegar no mesmo instante, em instâncias
   * serverless diferentes, e um ciclo get/parse/push/set perderia uma delas.
   * RPUSH e LPOP são ATÔMICOS no servidor; é por isso que a fila não é um
   * array em JSON dentro de uma chave comum.
   */
  /** Acrescenta valores ao FIM da fila. Retorna o tamanho depois da escrita. */
  rpush(key: string, ...values: string[]): Promise<number>;
  /** Remove e devolve, atomicamente, até `max` itens do INÍCIO da fila. */
  lpopMany(key: string, max: number): Promise<string[]>;
  /** Tamanho atual da fila (0 se não existir). */
  llen(key: string): Promise<number>;
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
