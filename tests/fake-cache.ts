import type { Cache } from '../src/lib/cache/cache.js';

/** Cache fake em memória com TTL real (para testes). */
export class FakeCache implements Cache {
  store = new Map<string, { v: string; exp: number | null }>();

  private alive(k: string): string | null {
    const e = this.store.get(k);
    if (!e) return null;
    if (e.exp !== null && Date.now() > e.exp) {
      this.store.delete(k);
      return null;
    }
    return e.v;
  }
  async get(k: string) { return this.alive(k); }
  async set(k: string, v: string, ttl?: number) {
    this.store.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : null });
  }
  async del(k: string) { this.store.delete(k); }
  async setNX(k: string, v: string, ttl: number) {
    if (this.alive(k) !== null) return false;
    await this.set(k, v, ttl);
    return true;
  }
  async delIfEquals(k: string, v: string) {
    if (this.alive(k) !== v) return false;
    this.store.delete(k);
    return true;
  }
  async incr(k: string, ttl: number) {
    const cur = parseInt(this.alive(k) || '0') || 0;
    const n = cur + 1;
    if (cur === 0) await this.set(k, String(n), ttl);
    else this.store.get(k)!.v = String(n);
    return n;
  }
}

export const TEST_ENV = {
  ML_CLIENT_ID: '123', ML_CLIENT_SECRET: 'segredo-de-teste-xx', ML_USER_ID: '2329718196',
  ML_REDIRECT_URI: 'https://exemplo.com/', ADMIN_KEY: 'chave-admin-de-teste-16car',
  DASHBOARD_PASSWORD: 'senha-teste', ALLOWED_ORIGIN: 'https://exemplo.com',
  UPSTASH_REDIS_REST_URL: 'https://fake.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'x',
  SEED_ENABLED: 'true',
};
