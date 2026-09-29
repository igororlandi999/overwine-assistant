/**
 * GET /api/orders/status?alvo=ativos|cancelados
 * GET /api/orders/list?alvo=...&cursor=...&pageSize=...
 * GET /api/orders/metrics?dias=7 | ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * GET /api/orders/logistics
 * GET /api/orders/margin?dias=7 | ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * GET /api/orders/contas            — contas que o seletor pode oferecer
 *
 * Toda leitura aceita `contas=a` (uma conta) ou `contas=a,b` (consolidado,
 * etapa 4 do plano multi-conta). Ausente = conta legada, com a resposta de
 * sempre, byte a byte. A união e o perfil financeiro por conta vivem em
 * orders-consolidado.service.
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
import { getEnv } from '../../src/config/env.js';
import { getCache } from '../../src/lib/cache/cache.js';
import {
  resolverContasDeLeitura, contaTemFinanceiro, descreverContas,
  ContaInvalidaError, erroContaParaHttp, type Conta,
} from '../../src/config/contas.js';
import {
  statusConsolidado, paginaConsolidada, lerBases, metricsDaSelecao,
  logisticaDaSelecao, margemDaSelecao, marcar, type ContaLida,
} from '../../src/services/orders-consolidado.service.js';
import { cacheDaConta } from '../../src/lib/cache/conta-cache.js';
import { validateSession } from '../../src/lib/session.js';
import { applyCors, rateLimitOk, readBearer, json } from '../../src/lib/http.js';
import type { Alvo } from '../../src/lib/orders-store.js';
import { getReadStatus, getPage } from '../../src/services/orders-read.service.js';
import { readSnapshot } from '../../src/lib/orders-store.js';
import { montarMetrics, resolverPeriodo } from '../../src/services/orders-metrics.service.js';
import { lerManifesto, lerMapaEnvios } from '../../src/lib/shipping-store.js';
import { calcularRanking } from '../../src/services/product-ranking.service.js';
import { coberturaLogistica } from '../../src/services/shipping-logistics.service.js';

function parseAlvo(v: unknown): Alvo {
  return v === 'cancelados' ? 'cancelados' : 'ativos'; // default ativos
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return; // OPTIONS encerra aqui (204)

  const resource = String(req.query.resource || '');
  const RECURSOS = new Set(['status', 'list', 'metrics', 'logistics', 'margin', 'contas']);
  if (!RECURSOS.has(resource)) {
    return json(res, 404, { error: `Recurso desconhecido: ${resource}` });
  }
  if (req.method !== 'GET') {
    return json(res, 405, { error: 'Use GET' });
  }

  // `cache` é o do backend (sessão, rate limit). `cacheDados` é o da CONTA:
  // snapshot, mapa de envios, telemetria. Para a conta legada são o mesmo
  // objeto e as mesmas chaves de sempre.
  const cache = getCache();

  try {
    // Sessão obrigatória — CORS não é autenticação; x-admin-key não vale aqui.
    const sess = await validateSession(cache, readBearer(req));
    if (!sess) return json(res, 401, { error: 'unauthorized' });

    // Rate limit por sessão (mesma folga do proxy ML).
    if (!(await rateLimitOk(cache, `orders-read:${sess.id.slice(0, 24)}`, 600, 60))) {
      return json(res, 429, { error: 'rate_limited' });
    }

    // Só rótulos e capacidades — nenhum dado de conta é lido aqui.
    if (resource === 'contas') return json(res, 200, { ok: true, ...descreverContas() });

    // Conta: ausente = legada (compatibilidade da transição); inválida = 400.
    // Mais de uma = consolidado: TODAS precisam ser válidas, senão 400 — nunca
    // responder só pelas que passaram.
    let contas: Conta[];
    try {
      contas = resolverContasDeLeitura(req.query.contas);
    } catch (e) {
      if (e instanceof ContaInvalidaError) return json(res, 400, erroContaParaHttp(e));
      throw e;
    }
    const lidas: ContaLida[] = contas.map(c => ({ conta: c, cache: cacheDaConta(cache, c) }));
    const varias = contas.length > 1;
    const conta = contas[0];
    const cacheDados = lidas[0].cache;

    const alvo = parseAlvo(req.query.alvo);

    // ── Seleção que não é "a conta legada sozinha" ──────────────────────────
    if (varias && resource === 'status') {
      return json(res, 200, await statusConsolidado(lidas, alvo, {
        notificacoesHabilitadas: Boolean(getEnv().ML_WEBHOOK_SECRET),
      }));
    }
    if (varias && resource === 'logistics') {
      return json(res, 200, await logisticaDaSelecao(lidas));
    }
    if (varias && resource === 'list') {
      const rawCursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
      const r = await paginaConsolidada(lidas, alvo, rawCursor, req.query.pageSize);
      if (r.ok) return json(res, 200, r.value);
      switch (r.code) {
        case 'invalid_cursor': return json(res, 400, { error: 'invalid_cursor' });
        case 'not_ready': return json(res, 409, { error: 'not_ready' });
        case 'snapshot_changed':
          return json(res, 409, { error: 'snapshot_changed', versao: r.versao, totalRegistros: r.totalRegistros });
        case 'inconsistente':
          console.error(`[orders-read] snapshot inconsistente alvo=${alvo} contas=${contas.map(c => c.id).join(',')}`);
          return json(res, 500, { error: 'snapshot_inconsistente' });
      }
    }
    // Métricas e margem: a união (várias) e a conta sem custos/tarifas próprios
    // passam pelo mesmo caminho, que declara o que é indisponível.
    const semPerfil = contas.some(c => !contaTemFinanceiro(c));
    if ((varias || semPerfil) && (resource === 'metrics' || resource === 'margin')) {
      const p = resolverPeriodo(req.query as Record<string, unknown>);
      if (!p.ok) return json(res, 400, { error: 'invalid_params', code: p.erro });
      // Margem consolidada entre contas COM perfil exigiria fundir custos de
      // empresas diferentes; não existe, e não se improvisa.
      if (resource === 'margin' && !semPerfil) {
        return json(res, 400, { error: 'consolidacao_indisponivel', conta: contas.map(c => c.id).join(',') });
      }
      const b = await lerBases(lidas);
      if (!b.ok) return json(res, 409, { error: 'not_ready', contasNaoProntas: b.contasNaoProntas });
      if (resource === 'metrics') return json(res, 200, { ok: true, ...metricsDaSelecao(b.bases, p.periodo) });
      return json(res, 200, await margemDaSelecao(b.bases, p.periodo));
    }

    if (resource === 'status') {
      // Rota BARATA de propósito: manifesto + status + telemetria, sem tocar
      // em chunk e sem chamar o Mercado Livre. É ela que o dashboard consulta
      // a cada poucos dezenas de segundos para decidir se vale repaginar os
      // milhares de pedidos — a decisão sai de `versao`.
      const status = await getReadStatus(cacheDados, alvo, {
        notificacoesHabilitadas: Boolean(getEnv().ML_WEBHOOK_SECRET),
      });
      return json(res, 200, { ...status, conta: conta.id });
    }

    if (resource === 'logistics') {
      // Agrupado por TIPO: os ~3.500 ids repetiriam a string do tipo em cada
      // entrada, triplicando o payload sem acrescentar informação.
      const mapa = await lerMapaEnvios(cacheDados);
      const manifesto = await lerManifesto(cacheDados);
      const porTipo: Record<string, string[]> = {};
      for (const [shipmentId, info] of mapa) {
        (porTipo[info.logisticType] ??= []).push(shipmentId);
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

      const status = await getReadStatus(cacheDados, 'ativos');
      if (status.versao === null || status.totalRegistros <= 0 || !status.oldestDate || !status.newestDate) {
        return json(res, 409, { error: 'not_ready' });
      }

      let pedidos;
      try {
        pedidos = await readSnapshot(cacheDados, 'ativos');   // UMA leitura por chamada
      } catch {
        return json(res, 409, { error: 'not_ready' });
      }
      if (pedidos.length === 0) return json(res, 409, { error: 'not_ready' });

      const mapa = await lerMapaEnvios(cacheDados);
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
      // Desde o Patch O3 isto NÃO é mais um percentual: é o frete real do envio
      // rateado por receita, com o percentual médio só onde o envio ainda não
      // teve custo apurado. A divisão entre os dois vai em `frete`, para a tela
      // não rotular como estimativa um número que foi apurado.
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
        frete: {
          real: r.frete.real,
          estimado: r.frete.estimado,
          fracaoReceitaReal: r.frete.fracaoReceitaReal,
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

      const status = await getReadStatus(cacheDados, 'ativos');
      if (status.versao === null || status.totalRegistros <= 0 || !status.oldestDate || !status.newestDate) {
        return json(res, 409, { error: 'not_ready' });
      }

      let pedidos;
      try {
        pedidos = await readSnapshot(cacheDados, 'ativos');   // UMA leitura por chamada
      } catch {
        return json(res, 409, { error: 'not_ready' });
      }
      if (pedidos.length === 0) return json(res, 409, { error: 'not_ready' });

      return json(res, 200, { ok: true, ...montarMetrics(pedidos, status, p.periodo) });
    }

    // resource === 'list'
    const rawCursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const rawPageSize = req.query.pageSize;
    const r = await getPage(cacheDados, alvo, rawCursor, rawPageSize);

    // Conta não legada: os pedidos saem marcados. A legada segue sem o campo,
    // com o corpo de sempre.
    if (r.ok) return json(res, 200, conta.legada ? r.value : { ...r.value, conta: conta.id, items: marcar(r.value.items, conta) });
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