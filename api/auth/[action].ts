/**
 * POST /api/auth/login   { password } → { session_token, expires_at }
 * POST /api/auth/logout  (Bearer sess_...) → { ok }
 * GET  /api/auth/session (Bearer sess_...) → { ok, expires_at }
 *
 * O session_token é um identificador OPACO e aleatório — não contém e não dá
 * acesso a nenhuma credencial do Mercado Livre. Nenhuma resposta deste
 * backend contém access_token/refresh_token do ML.
 *
 * Brute force: 5 tentativas/min por IP + bloqueio de 15 min após 10 senhas
 * erradas na última hora. Logs com IP mascarado e sem a senha.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getEnv } from '../../src/config/env.js';
import { getCache } from '../../src/lib/cache/cache.js';
import { createSession, validateSession, destroySession } from '../../src/lib/session.js';
import { applyCors, safeEquals, rateLimitOk, readBearer, clientIp, maskIp, json } from '../../src/lib/http.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;

  const action = String(req.query.action || '');
  const cache = getCache();
  const ip = clientIp(req);

  try {
    if (action === 'login') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });

      if (!(await rateLimitOk(cache, `login:${ip}`, 5, 60))) {
        return json(res, 429, { error: 'Muitas tentativas. Aguarde um minuto.' });
      }
      if ((await cache.get(`lock:login:${ip}`)) !== null) {
        return json(res, 429, { error: 'IP temporariamente bloqueado por excesso de falhas.' });
      }

      const env = getEnv();
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!password || !safeEquals(password, env.DASHBOARD_PASSWORD)) {
        const fails = await cache.incr(`fail:login:${ip}`, 3600);
        if (fails >= 10) await cache.set(`lock:login:${ip}`, '1', 900);
        console.warn(`[auth] senha incorreta ip=${maskIp(ip)} falhas_1h=${fails}`);
        return json(res, 401, { error: 'Senha incorreta.' });
      }

      const sess = await createSession(cache);
      console.info(`[auth] login ok ip=${maskIp(ip)}`);
      return json(res, 200, { session_token: sess.id, expires_at: sess.expiresAt });
    }

    if (action === 'logout') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
      const tok = readBearer(req);
      if (tok) await destroySession(cache, tok);
      return json(res, 200, { ok: true });
    }

    if (action === 'session') {
      if (req.method !== 'GET') return json(res, 405, { error: 'Use GET' });
      const sess = await validateSession(cache, readBearer(req));
      if (!sess) return json(res, 401, { ok: false });
      return json(res, 200, { ok: true, expires_at: sess.expiresAt });
    }

    return json(res, 404, { error: 'Ação desconhecida.' });
  } catch (e) {
    console.error(`[auth:${action}]`, e instanceof Error ? e.message : e);
    return json(res, 500, { error: 'Erro interno.' });
  }
}
