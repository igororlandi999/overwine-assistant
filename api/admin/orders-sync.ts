/**
 * POST /api/admin/orders-sync — dispara UM passo de sincronização de pedidos.
 *
 * Proteção (mesmo padrão de /api/admin/seed):
 * - Somente POST, Content-Type application/json.
 * - x-admin-key comparada com safeEquals (timing-safe).
 * - Rate limit por IP. Logs com IP mascarado, sem credenciais.
 *
 * O fetcher REAL é injetado aqui como FetchOrdersPage; o serviço de sync não
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
import { safeEquals, rateLimitOk, clientIp, maskIp, json } from '../../src/lib/http.js';
import { runSyncStep } from '../../src/services/orders-sync.service.js';
import { drenarFila } from '../../src/services/orders-webhook.service.js';
import { criarFetchOrder, criarFetchOrdersPage } from '../../src/lib/ml-orders.js';
import { readManifest } from '../../src/lib/orders-store.js';
import { registrarConclusaoSync, registrarFalhaSync, registrarTentativaSync } from '../../src/lib/sync-telemetry.js';
import { resolverContaDeAcao, mlUserIdDaConta, ContaInvalidaError, erroContaParaHttp } from '../../src/config/contas.js';
import { cacheDaConta } from '../../src/lib/cache/conta-cache.js';

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
      conta?: unknown;
      /**
       * `true` = preparação DELIBERADA de uma conta ainda inativa (carga
       * inicial antes de ligá-la). Sem isto, a rota respeita o estado
       * operacional: conta inativa é 400, e a rotina automática do GitHub
       * Actions — que nunca envia esta flag — a pula.
       */
      preparacao?: unknown;
    };
    const alvo = body.alvo === 'cancelados' ? 'cancelados' : 'ativos';

    // Ação: UMA conta. O GitHub Actions atual não envia conta → legada.
    let conta;
    try {
      conta = resolverContaDeAcao(body.conta, { preparacao: body.preparacao === true });
    } catch (e) {
      if (e instanceof ContaInvalidaError) return json(res, 400, erroContaParaHttp(e));
      throw e;
    }
    const cacheDados = cacheDaConta(cache, conta);
    const uid = mlUserIdDaConta(conta);

    if (body.acao === 'drenar') {
      const max = Number.isInteger(body.max) && (body.max as number) > 0 ? (body.max as number) : undefined;
      console.info(`[orders-sync] dreno ip=${maskIp(ip)} conta=${conta.id} max=${max ?? 'padrao'}`);
      const dreno = await drenarFila(cacheDados, criarFetchOrder(cacheDados), max === undefined ? {} : { max });
      return json(res, 200, { ...dreno, conta: conta.id });
    }

    // O fetcher de página vive em src/lib/ml-orders.ts: o auto-refresh do
    // dashboard usa exatamente o mesmo, e duas cópias seriam duas chances de
    // consertar o tratamento de paging.total em uma só.
    const fetchPage = criarFetchOrdersPage(cacheDados, uid);

    console.info(`[orders-sync] passo ip=${maskIp(ip)} conta=${conta.id} alvo=${alvo} modo=${body.modo ?? 'auto'}`);
    await registrarTentativaSync(cacheDados, 'reconciliation');
    const inicio = Date.now();
    const result = await runSyncStep(cacheDados, fetchPage, { alvo, modo: body.modo });
    // Telemetria unificada: só para o alvo que o dashboard lê. Lock ocupado
    // não é falha nem conclusão — a reconciliação simplesmente tenta depois.
    if (alvo === 'ativos' && result.motivo !== 'sync_em_andamento' && result.motivo !== 'job_em_andamento') {
      if (!result.ok) {
        await registrarFalhaSync(cacheDados, 'reconciliation', result.motivo ?? 'falha');
      } else {
        const man = result.concluido ? await readManifest(cacheDados, 'ativos') : null;
        await registrarConclusaoSync(cacheDados, {
          origem: 'reconciliation', modo: body.modo === 'full' ? 'full' : 'incremental',
          duracaoMs: Date.now() - inicio, chamadasML: result.paginasLidas,
          novos: result.concluido ? result.novosPedidos : 0, atualizados: 0,
          versaoPublicada: man?.versao ?? null,
        });
      }
    }
    return json(res, 200, { ...result, conta: conta.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erro interno';
    console.error('[orders-sync]', msg);
    return json(res, 502, { error: msg });
  }
}