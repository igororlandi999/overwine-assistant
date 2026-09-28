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
import { resolverContaDeAcao, ContaInvalidaError, erroContaParaHttp } from '../../src/config/contas.js';
import { cacheDaConta } from '../../src/lib/cache/conta-cache.js';
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
    // O proxy fala com o ML EM NOME DE UMA conta: `conta` sai dos parâmetros
    // antes da validação da operação e escolhe o token. Ausente = legada.
    const { op: _drop, conta: contaQuery, ...query } = req.query as Record<string, unknown>;
    const corpo = (op.method === 'POST' && req.body && typeof req.body === 'object') ? { ...(req.body as Record<string, unknown>) } : {};
    const contaCorpo = corpo.conta;
    delete corpo.conta;
    let conta;
    try {
      conta = resolverContaDeAcao(contaQuery ?? contaCorpo);
    } catch (e) {
      if (e instanceof ContaInvalidaError) return json(res, 400, erroContaParaHttp(e));
      throw e;
    }
    const rawParams = op.method === 'POST' ? (req.body === undefined ? {} : corpo) : query;

    const result = await runOp(cacheDaConta(cache, conta), opName, rawParams);
    return json(res, result.status, result.data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erro interno';
    console.error(`[ml:${opName}]`, msg); // sem tokens: mlFetch não loga credenciais
    return json(res, 502, { error: msg });
  }
}
