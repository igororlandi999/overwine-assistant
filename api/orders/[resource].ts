/**
 * GET /api/orders/status?alvo=ativos|cancelados
 * GET /api/orders/list?alvo=...&cursor=...&pageSize=...
 * GET /api/orders/metrics?dias=7 | ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * GET /api/orders/logistics
 *
 * Rota de LEITURA dos snapshots de pedidos (Fase 4c.1). Uma única função
 * serverless com `resource ∈ {status, list, metrics}` (padrão de
 * api/auth/[action].ts).
 *
 * `logistics` devolve o mapa shipmentId → logistic_type, AGRUPADO por tipo
 * para caber em poucos KB. Existe porque a API de pedidos do Mercado Livre não
 * devolve `logistic_type`: sem este mapa, o dashboard precisa adivinhar a
 * logística pelo ANÚNCIO, o que erra duas vezes — perde o pedido cujo anúncio
 * saiu do catálogo, e responde pela configuração de HOJE em vez da do dia da
 * venda. Contém só ids de envio e nomes de logística: nenhum id de pedido,
 * valor, data, comprador ou endereço.
 *
 * `metrics` devolve SOMENTE agregados do snapshot `ativos`: nenhum pedido
 * bruto, nenhum id de pedido, nenhuma data individual, nenhum buyer, nickname,
 * shipping ou order_items. Contratos de `status` e `list` ficam intocados.
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
import { readSnapshot } from '../../src/lib/orders-store.js';
import { montarMetrics, resolverPeriodo } from '../../src/services/orders-metrics.service.js';
import { lerManifesto, lerMapaLogistica } from '../../src/lib/shipping-store.js';

function parseAlvo(v: unknown): Alvo {
  return v === 'cancelados' ? 'cancelados' : 'ativos'; // default ativos
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return; // OPTIONS encerra aqui (204)

  const resource = String(req.query.resource || '');
  if (resource !== 'status' && resource !== 'list' && resource !== 'metrics' && resource !== 'logistics') {
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

    if (resource === 'logistics') {
      // Agrupado por TIPO: os ~3.500 ids repetiriam a string do tipo em cada
      // entrada, triplicando o payload sem acrescentar informação.
      const mapa = await lerMapaLogistica(cache);
      const manifesto = await lerManifesto(cache);
      const porTipo: Record<string, string[]> = {};
      for (const [shipmentId, tipo] of mapa) {
        (porTipo[tipo] ??= []).push(shipmentId);
      }
      for (const ids of Object.values(porTipo)) ids.sort();
      return json(res, 200, {
        ok: true,
        versao: manifesto?.versao ?? null,
        updatedAt: manifesto?.updatedAt ?? null,
        total: mapa.size,
        porTipo,
      });
    }

    if (resource === 'metrics') {
      // Métricas SEMPRE do snapshot 'ativos' — o parâmetro alvo é aceito na
      // allowlist mas ignorado de propósito: cancelados têm outra fonte.
      const p = resolverPeriodo(req.query as Record<string, unknown>);
      if (!p.ok) return json(res, 400, { error: 'invalid_params', code: p.erro });

      const status = await getReadStatus(cache, 'ativos');
      if (status.versao === null || status.totalRegistros <= 0 || !status.oldestDate || !status.newestDate) {
        return json(res, 409, { error: 'not_ready' });
      }

      let pedidos;
      try {
        pedidos = await readSnapshot(cache, 'ativos');   // UMA leitura por chamada
      } catch {
        return json(res, 409, { error: 'not_ready' });
      }
      if (pedidos.length === 0) return json(res, 409, { error: 'not_ready' });

      return json(res, 200, { ok: true, ...montarMetrics(pedidos, status, p.periodo) });
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