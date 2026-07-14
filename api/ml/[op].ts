/**
 * Proxy com allowlist para a API do Mercado Livre.
 *   GET    /api/ml/<op>?params...
 *   POST   /api/ml/<op>   (body JSON — só ops de escrita da allowlist)
 *   DELETE /api/ml/<op>?params...
 *
 * Fluxo: valida sessão → valida params (zod) → getAccessToken() interno →
 * chamada ao ML com Bearer → resposta filtrada (só campos necessários).
 * O access token NUNCA aparece na resposta. Não existe modo "URL livre".
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getCache } from '../../src/lib/cache/cache.js';
import { validateSession } from '../../src/lib/session.js';
import { runOp, OPS } from '../../src/ml/ops.js';
import { applyCors, rateLimitOk, readBearer, json } from '../../src/lib/http.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;

  const cache = getCache();
  const opName = String(req.query.op || '');
  const op = OPS[opName];
  if (!op) return json(res, 404, { error: `Operação desconhecida: ${opName}` });
  if (req.method !== op.method) return json(res, 405, { error: `Use ${op.method}` });

  try {
    // 1) Sessão obrigatória — CORS não é autenticação.
    const sess = await validateSession(cache, readBearer(req));
    if (!sess) return json(res, 401, { error: 'Sessão inválida ou expirada. Faça login.' });

    // 2) Rate limit por sessão (o dashboard faz rajadas legítimas ao carregar).
    if (!(await rateLimitOk(cache, `ml:${sess.id.slice(0, 24)}`, 600, 60))) {
      return json(res, 429, { error: 'Limite de requisições atingido. Aguarde.' });
    }

    // 3) Params: query para GET/DELETE, body para POST.
    const { op: _drop, ...query } = req.query as Record<string, unknown>;
    const rawParams = op.method === 'POST' ? (req.body ?? {}) : query;

    const result = await runOp(cache, opName, rawParams);
    return json(res, result.status, result.data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erro interno';
    console.error(`[ml:${opName}]`, msg); // sem tokens: mlFetch não loga credenciais
    return json(res, 502, { error: msg });
  }
}
