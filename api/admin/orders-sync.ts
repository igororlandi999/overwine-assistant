/**
 * POST /api/admin/orders-sync — dispara UM passo de sincronização de pedidos.
 *
 * Proteção (mesmo padrão de /api/admin/seed):
 * - Somente POST, Content-Type application/json.
 * - x-admin-key comparada com safeEquals (timing-safe).
 * - Rate limit por IP. Logs com IP mascarado, sem credenciais.
 *
 * O mlFetch REAL é injetado aqui como FetchOrdersPage; o serviço de sync não
 * conhece rede. Um passo respeita ORDERS_SYNC_MAX_PAGES e é retomável.
 * Body: { alvo?: 'ativos' | 'cancelados', modo?: 'full' | 'incremental' }.
 *
 * `{ "acao": "drenar" }` roda o dreno da fila de notificações do Mercado Livre
 * em vez de um passo de sincronização. É o gatilho de GARANTIA do caminho de
 * tempo real: se o runtime não ofereceu waitUntil, ou se o dreno da notificação
 * esbarrou no lock de uma sincronização em andamento, os eventos ficaram na
 * fila — e esta chamada os processa. Fica no mesmo endpoint de propósito: o
 * plano gratuito da Vercel limita o número de funções, e a proteção (POST,
 * x-admin-key, rate limit) é idêntica.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getEnv } from '../../src/config/env.js';
import { getCache } from '../../src/lib/cache/cache.js';
import { mlFetch } from '../../src/lib/ml-auth.js';
import { safeEquals, rateLimitOk, clientIp, maskIp, json } from '../../src/lib/http.js';
import { runSyncStep, type FetchOrdersPage } from '../../src/services/orders-sync.service.js';
import { drenarFila } from '../../src/services/orders-webhook.service.js';
import { criarFetchOrder } from '../../src/lib/ml-orders.js';
import type { OrderInput } from '../../src/services/orders.service.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cache = getCache();
  const ip = clientIp(req);

  try {
    const env = getEnv();

    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      return json(res, 415, { error: 'Content-Type deve ser application/json.' });
    }
    if (!(await rateLimitOk(cache, `orders-sync:${ip}`, 10, 600))) {
      console.warn(`[orders-sync] rate limit ip=${maskIp(ip)}`);
      return json(res, 429, { error: 'Muitas requisições.' });
    }
    const key = String(req.headers['x-admin-key'] || '');
    if (!key || !safeEquals(key, env.ADMIN_KEY)) {
      console.warn(`[orders-sync] admin key inválida ip=${maskIp(ip)}`);
      return json(res, 401, { error: 'Não autorizado.' });
    }

    const body = (req.body ?? {}) as {
      alvo?: 'ativos' | 'cancelados';
      modo?: 'full' | 'incremental';
      acao?: 'sincronizar' | 'drenar';
      max?: number;
    };
    const alvo = body.alvo === 'cancelados' ? 'cancelados' : 'ativos';
    const uid = env.ML_USER_ID;

    if (body.acao === 'drenar') {
      const max = Number.isInteger(body.max) && (body.max as number) > 0 ? (body.max as number) : undefined;
      console.info(`[orders-sync] dreno ip=${maskIp(ip)} max=${max ?? 'padrao'}`);
      const dreno = await drenarFila(cache, criarFetchOrder(cache), max === undefined ? {} : { max });
      return json(res, 200, dreno);
    }

    // Fetcher real: traduz a página em { results, total }; erro NÃO é engolido.
    // paging.total ausente/ inválido NÃO vira 0 (isso mascararia resposta
    // incompleta como sync concluído) — lança, entrando no retry/erro_parcial.
    const fetchPage: FetchOrdersPage = async ({ offset, limit, status }) => {
      let path = `/orders/search?seller=${uid}&sort=date_desc&limit=${limit}&offset=${offset}`;
      if (status) path += `&order.status=${status}`;
      const r = await mlFetch(cache, path);
      if (!r.ok) throw new Error(`ML /orders/search HTTP ${r.status} (offset ${offset}).`);
      const data = (await r.json()) as { results?: unknown; paging?: { total?: unknown } };
      if (!Array.isArray(data.results)) {
        throw new Error(`ML /orders/search sem results[] (offset ${offset}).`);
      }
      const total = data.paging?.total;
      if (typeof total !== 'number' || !Number.isInteger(total) || !Number.isFinite(total) || total < 0) {
        throw new Error(`ML /orders/search com paging.total inválido: ${String(total)} (offset ${offset}).`);
      }
      return { results: data.results as OrderInput[], total };
    };

    console.info(`[orders-sync] passo ip=${maskIp(ip)} alvo=${alvo} modo=${body.modo ?? 'auto'}`);
    const result = await runSyncStep(cache, fetchPage, { alvo, modo: body.modo });
    return json(res, 200, result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erro interno';
    console.error('[orders-sync]', msg);
    return json(res, 502, { error: msg });
  }
}