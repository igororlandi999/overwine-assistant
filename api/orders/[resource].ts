/**
 * GET /api/orders/status?alvo=ativos|cancelados
 * GET /api/orders/list?alvo=...&cursor=...&pageSize=...
 * GET /api/orders/metrics?dias=7 | ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * GET /api/orders/logistics
 * GET /api/orders/margin?dias=7 | ?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Rota de LEITURA dos snapshots de pedidos (Fase 4c.1). Uma única função
 * serverless com `resource ∈ {status, list, metrics}` (padrão de
 * api/auth/[action].ts).
 *
 * `margin` devolve a margem do período, total e por SKU, com a MESMA conta que
 * o chatbot usa — é o ponto todo do recurso. O dashboard tinha uma segunda
 * implementação que ignorava frete, embalagem e kits, e por isso reportava
 * margem 6 pontos percentuais acima da real (R$ 17.489 contra R$ 14.492 em
 * agosto/2026). Duas respostas para a mesma pergunta é pior que nenhuma.
 *
 * NÃO inclui publicidade: esse dado vem da API de anúncios do Mercado Livre,
 * que o backend não consulta, e pode ser informado à mão na tela. O consumidor
 * subtrai por cima — por isso o corpo declara `antesDePublicidade: true`.
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
import { calcularRanking } from '../../src/services/product-ranking.service.js';
import { coberturaLogistica } from '../../src/services/shipping-logistics.service.js';

function parseAlvo(v: unknown): Alvo {
  return v === 'cancelados' ? 'cancelados' : 'ativos'; // default ativos
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return; // OPTIONS encerra aqui (204)

  const resource = String(req.query.resource || '');
  const RECURSOS = new Set(['status', 'list', 'metrics', 'logistics', 'margin']);
  if (!RECURSOS.has(resource)) {
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

    if (resource === 'margin') {
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

      const mapa = await lerMapaLogistica(cache);
      const r = calcularRanking(
        pedidos,
        { fromYmd: p.periodo.fromYmd, toYmd: p.periodo.toYmd },
        {
          oldestDate: status.oldestDate,
          newestDate: status.newestDate,
          partial: status.partial,
          lastSyncAt: status.lastSyncAt,
          lastResult: status.lastResult,
        },
        { criterio: 'revenue', todos: true, mapaLogistica: mapa }
      );

      const somar = (f: (l: typeof r.linhas[number]) => number) => r.linhas.reduce((s, l) => s + f(l), 0);
      const tarifaML = somar(l => l.tarifaML ?? 0);
      const tarifaEnvio = somar(l => l.tarifaEnvio ?? 0);
      const custoTotal = somar(l => l.custoTotal ?? 0);
      // Margem só das linhas com custo INTEGRALMENTE conhecido: somar as demais
      // como se custassem zero inflaria o resultado, que é o erro que este
      // recurso existe para não repetir.
      const margem = r.linhas.reduce((s, l) => s + (l.margem ?? 0), 0);
      const receitaComCusto = somar(l => l.receitaComCusto);
      const cobLog = coberturaLogistica(pedidos, mapa);

      return json(res, 200, {
        ok: true,
        periodo: { fromYmd: p.periodo.fromYmd, toYmd: p.periodo.toYmd },
        cobertura: {
          disponivel: r.disponivel,
          tipo: r.cobertura,
          fromYmd: r.periodoCalculado?.fromYmd ?? null,
          toYmd: r.periodoCalculado?.toYmd ?? null,
        },
        totais: {
          receitaProdutos: r.totais.receitaProdutos,
          unidades: r.totais.unidades,
          skusDistintos: r.totais.skusDistintos,
          tarifaML,
          tarifaEnvio,
          receitaLiquida: receitaComCusto - tarifaML - tarifaEnvio,
          custoTotal,
          margem,
          margemPct: receitaComCusto > 0 ? margem / receitaComCusto : null,
          receitaComCusto,
        },
        porSku: r.linhas.map(l => ({
          sku: l.sku,
          semSku: l.semSku,
          label: l.label,
          itemIds: l.itemIds,
          unidades: l.unidades,
          pedidos: l.pedidos,
          receitaProdutos: l.receitaProdutos,
          receitaComCusto: l.receitaComCusto,
          custoCobertura: l.custoCobertura,
          custoTotal: l.custoTotal,
          tarifaML: l.tarifaML,
          tarifaEnvio: l.tarifaEnvio,
          margem: l.margem,
          margemPct: l.margemPct,
        })),
        semCusto: r.semCusto,
        logistica: {
          enviosConhecidos: cobLog.resolvidos,
          enviosTotal: cobLog.totalDistintos,
          fracao: cobLog.fracao,
        },
        // A tela subtrai publicidade por cima: o backend não a conhece.
        antesDePublicidade: true,
        estimado: true,
        warnings: r.warnings,
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