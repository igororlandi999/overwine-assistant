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
}
