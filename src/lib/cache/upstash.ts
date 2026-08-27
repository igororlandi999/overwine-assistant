import { Redis } from '@upstash/redis';
import type { Cache } from './cache.js';
import { getEnv } from '../../config/env.js';

/** Lua: apaga a chave só se o valor bater (compare-and-delete atômico). */
const CAD_SCRIPT =
  'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

export class UpstashCache implements Cache {
  private redis: Redis;

  constructor() {
    const env = getEnv();
    this.redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
      automaticDeserialization: false,
    });
  }

  async get(key: string): Promise<string | null> {
    const v = await this.redis.get<string>(key);
    return v === undefined || v === null ? null : String(v);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) await this.redis.set(key, value, { ex: ttlSeconds });
    else await this.redis.set(key, value);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async setNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const res = await this.redis.set(key, value, { nx: true, ex: ttlSeconds });
    return res === 'OK';
  }

  async delIfEquals(key: string, value: string): Promise<boolean> {
    const res = await this.redis.eval(CAD_SCRIPT, [key], [value]);
    return res === 1;
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, ttlSeconds);
    return n;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    if (values.length === 0) return this.llen(key);
    return this.redis.rpush(key, ...values);
  }

  /**
   * LPOP com contagem. Chave inexistente devolve null; um item devolve string.
   * Normalizamos os três casos para string[] — quem chama nunca vê a variação.
   */
  async lpopMany(key: string, max: number): Promise<string[]> {
    if (max <= 0) return [];
    const r = (await this.redis.lpop<string | string[]>(key, max)) as unknown;
    if (r === null || r === undefined) return [];
    if (Array.isArray(r)) return r.map(v => String(v));
    return [String(r)];
  }

  async llen(key: string): Promise<number> {
    const n = await this.redis.llen(key);
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  }
}
