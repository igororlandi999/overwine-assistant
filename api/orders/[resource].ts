/**
 * GET /api/orders/status?alvo=ativos|cancelados
 * GET /api/orders/list?alvo=...&cursor=...&pageSize=...
 *
 * Rota de LEITURA dos snapshots de pedidos (Fase 4c.1). Uma única função
 * serverless com `resource ∈ {status, list}` (padrão de api/auth/[action].ts).
 *
 * Regras: só GET/OPTIONS; CORS pelos helpers existentes; Bearer de sessão
 * obrigatório (x-admin-key NÃO substitui sessão); rate limit por sessão.
 * NUNCA chama o Mercado Livre / mlFetch. NUNCA expõe nomes de chunk, chaves
 * Redis, jobId, tokens ou credenciais.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getCache } from '../../src/lib/cache/cache.js';
import { validateSession } from '../../src/lib/session.js';
import { applyCors, rateLimitOk, readBearer, json } from '../../src/lib/http.js';
import type { Alvo } from '../../src/lib/orders-store.js';
import { getReadStatus, getPage } from '../../src/services/orders-read.service.js';

function parseAlvo(v: unknown): Alvo {
  return v === 'cancelados' ? 'cancelados' : 'ativos'; // default ativos
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return; // OPTIONS encerra aqui (204)

  const resource = String(req.query.resource || '');
  if (resource !== 'status' && resource !== 'list') {
    return json(res, 404, { error: `Recurso desconhecido: ${resource}` });
  }
  if (req.method !== 'GET') {
    return json(res, 405, { error: 'Use GET' });
  }

  const cache = getCache();

  try {
    // Sessão obrigatória — CORS não é autenticação; x-admin-key não vale aqui.
    const sess = await validateSession(cache, readBearer(req));
    if (!sess) return json(res, 401, { error: 'unauthorized' });

    // Rate limit por sessão (mesma folga do proxy ML).
    if (!(await rateLimitOk(cache, `orders-read:${sess.id.slice(0, 24)}`, 600, 60))) {
      return json(res, 429, { error: 'rate_limited' });
    }

    const alvo = parseAlvo(req.query.alvo);

    if (resource === 'status') {
      const status = await getReadStatus(cache, alvo);
      return json(res, 200, status);
    }

    // resource === 'list'
    const rawCursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const rawPageSize = req.query.pageSize;
    const r = await getPage(cache, alvo, rawCursor, rawPageSize);

    if (r.ok) return json(res, 200, r.value);
    switch (r.code) {
      case 'invalid_cursor':
        return json(res, 400, { error: 'invalid_cursor' });
      case 'not_ready':
        return json(res, 409, { error: 'not_ready' });
      case 'snapshot_changed':
        return json(res, 409, { error: 'snapshot_changed', versao: r.versao, totalRegistros: r.totalRegistros });
      case 'inconsistente':
        // Erro controlado: não vaza chave nem detalhe interno.
        console.error(`[orders-read] snapshot inconsistente alvo=${alvo}`);
        return json(res, 500, { error: 'snapshot_inconsistente' });
    }
  } catch (e) {
    console.error('[orders-read]', e instanceof Error ? e.message : e);
    return json(res, 500, { error: 'erro_interno' });
  }
}