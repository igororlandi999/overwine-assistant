import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json } from '../src/lib/http.js';
import { getEnv } from '../src/config/env.js';
import { getCache } from '../src/lib/cache/cache.js';
import { isChainSeeded } from '../src/lib/ml-auth.js';
import { safeEquals } from '../src/lib/http.js';

/**
 * GET /api/health → { ok: true } (público, sem detalhes internos).
 * Com header X-Admin-Key válido → diagnóstico completo (Redis, cadeia).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const env = getEnv();
    const key = String(req.headers['x-admin-key'] || '');
    if (key && safeEquals(key, env.ADMIN_KEY)) {
      const cache = getCache();
      await cache.set('health:ping', String(Date.now()), 60);
      return json(res, 200, { ok: true, redis: true, cadeia_semeada: await isChainSeeded(cache) });
    }
    return json(res, 200, { ok: true });
  } catch {
    return json(res, 500, { ok: false });
  }
}
