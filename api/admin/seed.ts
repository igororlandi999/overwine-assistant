/**
 * POST /api/admin/seed — semeadura da cadeia de tokens (endpoint administrativo).
 *
 * Endurecimentos (revisão 2.1):
 * - Somente POST com Content-Type: application/json.
 * - SEM headers de CORS: navegador nenhum consegue chamar cross-origin.
 * - Desativável via SEED_ENABLED=false após a semeadura.
 * - Recusa nova semeadura se a cadeia já existe, salvo { force: true }.
 * - Valida user_id da autorização contra ML_USER_ID (em ml-auth.seedTokens).
 * - Rate limit 3/10min por IP. Loga tentativas SEM o code/token.
 * - NUNCA retorna nenhum token na resposta.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getEnv } from '../../src/config/env.js';
import { getCache } from '../../src/lib/cache/cache.js';
import { seedTokens, isChainSeeded } from '../../src/lib/ml-auth.js';
import { safeEquals, rateLimitOk, clientIp, maskIp, json } from '../../src/lib/http.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cache = getCache();
  const ip = clientIp(req);

  try {
    const env = getEnv();

    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      return json(res, 415, { error: 'Content-Type deve ser application/json.' });
    }
    if (env.SEED_ENABLED !== 'true') {
      return json(res, 403, { error: 'Semeadura desativada (SEED_ENABLED=false).' });
    }
    if (!(await rateLimitOk(cache, `seed:${ip}`, 3, 600))) {
      console.warn(`[seed] rate limit ip=${maskIp(ip)}`);
      return json(res, 429, { error: 'Muitas tentativas.' });
    }

    const key = String(req.headers['x-admin-key'] || '');
    if (!key || !safeEquals(key, env.ADMIN_KEY)) {
      console.warn(`[seed] admin key inválida ip=${maskIp(ip)}`);
      return json(res, 401, { error: 'Não autorizado.' });
    }

    const { code, refreshToken, force } = (req.body ?? {}) as {
      code?: string;
      refreshToken?: string;
      force?: boolean;
    };

    if ((await isChainSeeded(cache)) && force !== true) {
      return json(res, 409, {
        error: 'Cadeia já semeada. Para substituir intencionalmente, envie { "force": true }.',
      });
    }

    console.info(`[seed] tentativa ip=${maskIp(ip)} via=${code ? 'code' : 'refreshToken'}`);
    const result = await seedTokens(cache, { code, refreshToken });

    return json(res, 200, {
      ok: true,
      user_id_validado: Number(env.ML_USER_ID),
      access_token_expira_em: new Date(result.expiresAt).toISOString(),
      proximo_passo: 'Defina SEED_ENABLED=false na Vercel e faça redeploy.',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erro interno';
    console.error('[seed]', msg); // seedTokens não inclui code/token nas mensagens
    return json(res, 500, { error: msg });
  }
}
