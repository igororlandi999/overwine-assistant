/**
 * GET /api/items/catalog            — catálogo agregado (usa snapshot)
 * GET /api/items/catalog?refresh=1  — reconstrução EXPLÍCITA (com cooldown)
 * GET /api/items/inventory          — estoque próprio × Full, deduplicado
 *
 * Uma única função serverless com `resource ∈ {catalog, inventory}` (mesmo
 * padrão de api/orders/[resource].ts e api/auth/[action].ts).
 *
 * `inventory` expõe o inventory.service, que já existia inteiro e testado mas
 * não tinha consumidor: a dedução de saldo físico entre anúncio próprio e
 * espelho Full continuava sendo refeita no navegador. Enquanto ela vive no
 * frontend, o chatbot não consegue responder "o que está em ruptura?" — as
 * perguntas de estoque caem no fluxo legado de api/chat.ts, que depende do
 * contexto que a tela manda. Mesma motivação de `/api/orders/margin`: uma
 * resposta só, calculada no backend, para todos os consumidores.
 *
 * NUNCA chama o Mercado Livre: lê o snapshot de catálogo PUBLICADO e o
 * snapshot de pedidos `ativos`. Sem catálogo publicado responde 409 not_ready
 * — reconstruir é trabalho de `catalog?refresh=1`, não deste recurso.
 *
 * Regras: só GET/OPTIONS; CORS pelos helpers existentes; Bearer de sessão
 * obrigatório (x-admin-key NÃO substitui sessão); rate limit por sessão.
 * O token do Mercado Livre vive só aqui dentro, via mlFetch do backend, e
 * NUNCA chega ao navegador. A resposta traz apenas os 18 campos de anúncio
 * usados pelo dashboard — sem buyer, sem pedidos, sem PII, sem credenciais.
 *
 * COMPLETUDE: uma reconstrução incompleta nunca é publicada nem devolvida.
 * Nesse caso, se houver snapshot completo anterior, ele é servido com
 * `source: 'fallback_stale'` e warning explícito; se não houver, 409.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getCache } from '../../src/lib/cache/cache.js';
import { getEnv } from '../../src/config/env.js';
import { validateSession } from '../../src/lib/session.js';
import { applyCors, rateLimitOk, readBearer, json } from '../../src/lib/http.js';
import { mlFetch } from '../../src/lib/ml-auth.js';
import {
  CATALOG_COOLDOWN_KEY, CATALOG_LOCK_KEY,
  readCatalogManifest, type CatalogManifest,
} from '../../src/lib/items-store.js';
import {
  IDS_POR_PAGINA, lerCatalogoPublicado, montarResposta, precisaReconstruir,
  reconstruirCatalogo,
  type FetchItemIds, type FetchItemsBatch, type ItemBruto, type StatusCatalogo,
} from '../../src/services/items-catalog.service.js';
import { LIMITES_CLASSIFICACAO, type ModoEstoque } from '../../src/services/inventory.service.js';
import {
  lerInventario, resolverPeriodoInventario,
  type EscopoEstoque, type Inventario,
} from '../../src/services/inventory-read.service.js';

/** Ids aleatórios do lock — sem depender de crypto extra. */
function donoLock(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function fetchers(cache: ReturnType<typeof getCache>, userId: string): {
  ids: FetchItemIds; batch: FetchItemsBatch;
} {
  const ids: FetchItemIds = async (status: StatusCatalogo, offset: number) => {
    const res = await mlFetch(
      cache,
      `/users/${userId}/items/search?status=${status}&limit=${IDS_POR_PAGINA}&offset=${offset}`
    );
    if (!res.ok) throw new Error(`items-search ${res.status}`);
    const d = (await res.json()) as { results?: unknown; paging?: { total?: unknown } };
    const results = Array.isArray(d.results) ? d.results.filter(x => typeof x === 'string') as string[] : [];
    const total = typeof d.paging?.total === 'number' ? d.paging.total : results.length;
    return { results, total };
  };

  const batch: FetchItemsBatch = async (lote: string[]) => {
    const res = await mlFetch(cache, `/items?ids=${lote.join(',')}`);
    if (!res.ok) throw new Error(`items ${res.status}`);
    const d = (await res.json()) as Array<{ code?: number; body?: ItemBruto }>;
    if (!Array.isArray(d)) throw new Error('items: resposta inválida');
    return d.filter(r => r && r.code === 200 && r.body).map(r => r.body as ItemBruto);
  };

  return { ids, batch };
}

// ── Recurso `inventory` ───────────────────────────────────────────────────

const MODOS_ESTOQUE = new Set<string>(['legado', 'seguro']);
const ESCOPOS_ESTOQUE = new Set<string>(['proprio', 'full', 'ambos']);

/**
 * Janela legada de vendas da aba Estoque: estGetSKUData usa 30 dias. Serve de
 * `diasPadrao` para resolverPeriodo, que é o MESMO parser de período de
 * /api/orders/metrics e /api/orders/margin — uma regra de data só no backend.
 */
const INVENTARIO_DIAS_PADRAO = 30;

interface ResumoEstoque {
  skus: number;
  unidades: number;
  porTipo: Record<string, number>;
}

function resumir<T extends { tipo: string | null }>(
  linhas: readonly T[],
  unidadeDe: (l: T) => number
): ResumoEstoque {
  const porTipo: Record<string, number> = {
    ruptura: 0, alerta: 0, ok: 0, excesso: 0, semvenda: 0,
  };
  let unidades = 0;
  for (const l of linhas) {
    unidades += unidadeDe(l);
    if (l.tipo) porTipo[l.tipo] = (porTipo[l.tipo] ?? 0) + 1;
  }
  return { skus: linhas.length, unidades, porTipo };
}

/**
 * GET /api/items/inventory?dias=30&modo=seguro|legado&escopo=proprio|full|ambos
 *
 * MODO PADRÃO É `seguro`, não `legado`, e a razão é concreta: no modo legado o
 * saldo negativo é PROPAGADO, e `classificarEstoque` LANÇA com estoque < 0 —
 * um único anúncio com available_quantity negativo derrubaria a rota inteira.
 * O modo seguro normaliza para 0 e registra alerta. Fora esse caso os totais
 * são idênticos nos dois modos (ver cabeçalho de inventory.service.ts), então
 * o padrão seguro não afasta a rota dos números do dashboard; só remove o bug
 * de não determinismo da partição clássico/premium. `modo=legado` continua
 * disponível para comparar paridade.
 *
 * PERÍODO: `dias=N` significa N dias civis terminando hoje, bordas incluídas —
 * NÃO os N+1 dias de `/api/orders/metrics`. A razão está em
 * inventory-read.service.ts: com estoque também no chat, as duas convenções
 * passariam a responder a mesma pergunta com números diferentes. `periodo.dias`
 * vai na resposta para o consumidor auditar o divisor.
 *
 * A composição inteira vive em inventory-read.service.ts, para que o assistente
 * produza exatamente os mesmos números sem uma chamada HTTP interna.
 */
async function responderInventario(
  req: VercelRequest,
  res: VercelResponse,
  cache: ReturnType<typeof getCache>
) {
  const PERMITIDOS = new Set(['resource', 'dias', 'from', 'to', 'modo', 'escopo']);
  for (const k of Object.keys(req.query)) {
    if (!PERMITIDOS.has(k)) {
      return json(res, 400, { error: 'invalid_params', code: 'parametro_desconhecido' });
    }
  }

  const rawModo = req.query.modo;
  let modo: ModoEstoque = 'seguro';
  if (rawModo !== undefined && rawModo !== '') {
    if (typeof rawModo !== 'string' || !MODOS_ESTOQUE.has(rawModo)) {
      return json(res, 400, { error: 'invalid_params', code: 'modo_invalido' });
    }
    modo = rawModo as ModoEstoque;
  }

  const rawEscopo = req.query.escopo;
  let escopo: EscopoEstoque = 'ambos';
  if (rawEscopo !== undefined && rawEscopo !== '') {
    if (typeof rawEscopo !== 'string' || !ESCOPOS_ESTOQUE.has(rawEscopo)) {
      return json(res, 400, { error: 'invalid_params', code: 'escopo_invalido' });
    }
    escopo = rawEscopo as EscopoEstoque;
  }

  const p = resolverPeriodoInventario({
    dias: req.query.dias, from: req.query.from, to: req.query.to,
  });
  if (!p.ok) return json(res, 400, { error: 'invalid_params', code: p.erro });

  const env = getEnv();
  const r = await lerInventario(cache, {
    periodo: p.periodo,
    modo,
    escopo,
    hardTtlS: env.ITEMS_CATALOG_HARD_TTL_S,
  });

  if (!r.ok) {
    // `saldo_invalido_no_modo_legado` é 409 e não 500 de propósito: o pedido
    // foi entendido, o modo pedido é que não suporta o dado que existe.
    return json(res, 409, { error: 'not_ready', code: r.code });
  }

  const inv = r.value;
  return json(res, 200, {
    ok: true,
    catalogo: inv.catalogo,
    periodo: inv.periodo,
    modo: inv.modo,
    escopo: inv.escopo,
    vendas: { disponivel: inv.vendasDisponiveis },
    limites: LIMITES_CLASSIFICACAO,
    proprio: inv.proprio
      ? { resumo: resumir(inv.proprio, l => l.estProprio), linhas: inv.proprio }
      : null,
    full: inv.full
      ? { resumo: resumir(inv.full, l => l.estTotal), linhas: inv.full }
      : null,
    warnings: inv.warnings,
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return; // OPTIONS encerra aqui (204)

  const resource = String(req.query.resource || '');
  const RECURSOS = new Set(['catalog', 'inventory']);
  if (!RECURSOS.has(resource)) {
    return json(res, 404, { error: `Recurso desconhecido: ${resource}` });
  }
  if (req.method !== 'GET') {
    return json(res, 405, { error: 'Use GET' });
  }

  const cache = getCache();

  try {
    const sess = await validateSession(cache, readBearer(req));
    if (!sess) return json(res, 401, { error: 'unauthorized' });

    if (!(await rateLimitOk(cache, `items-read:${sess.id.slice(0, 24)}`, 600, 60))) {
      return json(res, 429, { error: 'rate_limited' });
    }

    if (resource === 'inventory') return await responderInventario(req, res, cache);

    // Allowlist de parâmetros do `catalog`: 400 determinístico para qualquer outro.
    for (const k of Object.keys(req.query)) {
      if (k !== 'resource' && k !== 'refresh') {
        return json(res, 400, { error: 'invalid_params', code: 'parametro_desconhecido' });
      }
    }
    const rawRefresh = req.query.refresh;
    let refresh = false;
    if (rawRefresh !== undefined && rawRefresh !== '') {
      if (rawRefresh !== '1' && rawRefresh !== '0') {
        return json(res, 400, { error: 'invalid_params', code: 'refresh_invalido' });
      }
      refresh = rawRefresh === '1';
    }

    const env = getEnv();
    const SOFT = env.ITEMS_CATALOG_SOFT_TTL_S;
    const HARD = env.ITEMS_CATALOG_HARD_TTL_S;

    let manifest: CatalogManifest | null = null;
    let manifestoCorrompido = false;
    try {
      manifest = await readCatalogManifest(cache);
    } catch {
      manifestoCorrompido = true; // trata como ausente; nunca 500 por isso
    }

    const vencido = precisaReconstruir(manifest, HARD);
    const warnings: string[] = [];
    if (manifestoCorrompido) warnings.push('manifesto_anterior_invalido');

    // Caminho rápido: snapshot válido e nenhuma reconstrução pedida.
    if (manifest && !vencido && !refresh) {
      const items = await lerCatalogoPublicado(cache, manifest);
      return json(res, 200, {
        ok: true,
        ...montarResposta(manifest, items, 'snapshot', SOFT, HARD, warnings),
      });
    }

    // Cooldown protege o ML de rajadas de refresh forçado. Não se aplica
    // quando não há snapshot algum — aí a reconstrução é a única saída.
    if (refresh && manifest && !vencido) {
      const livre = await cache.setNX(CATALOG_COOLDOWN_KEY, '1', env.ITEMS_CATALOG_COOLDOWN_S);
      if (!livre) {
        const items = await lerCatalogoPublicado(cache, manifest);
        warnings.push('refresh_em_cooldown');
        return json(res, 200, {
          ok: true,
          ...montarResposta(manifest, items, 'snapshot', SOFT, HARD, warnings),
        });
      }
    }

    // Lock: nenhuma reconstrução concorrente duplicada.
    const dono = donoLock();
    const gotLock = await cache.setNX(CATALOG_LOCK_KEY, dono, env.ITEMS_CATALOG_LOCK_TTL_S);
    if (!gotLock) {
      if (manifest) {
        const items = await lerCatalogoPublicado(cache, manifest);
        warnings.push('reconstrucao_em_andamento');
        return json(res, 200, {
          ok: true,
          ...montarResposta(manifest, items, vencido ? 'fallback_stale' : 'snapshot', SOFT, HARD, warnings),
        });
      }
      return json(res, 409, { error: 'not_ready', code: 'reconstrucao_em_andamento' });
    }

    try {
      const { ids, batch } = fetchers(cache, env.ML_USER_ID);
      const { manifest: novo, resultado } = await reconstruirCatalogo(
        cache, ids, batch, env.ITEMS_CATALOG_CHUNK_SIZE,
        { maxChamadas: env.ITEMS_CATALOG_MAX_CALLS }
      );

      if (novo) {
        const items = await lerCatalogoPublicado(cache, novo);
        return json(res, 200, {
          ok: true,
          ...montarResposta(novo, items, 'rebuilt', SOFT, HARD, warnings),
        });
      }

      // INCOMPLETO: nada foi publicado. Serve o snapshot completo anterior.
      console.warn(`[items-catalog] construcao incompleta motivos=${resultado.motivos.join('|')}`);
      if (manifest) {
        const items = await lerCatalogoPublicado(cache, manifest);
        warnings.push('catalogo_incompleto_usando_anterior', ...resultado.motivos);
        return json(res, 200, {
          ok: true,
          ...montarResposta(manifest, items, 'fallback_stale', SOFT, HARD, warnings),
        });
      }
      return json(res, 409, { error: 'not_ready', code: 'catalogo_incompleto' });
    } catch (e) {
      // Falha da reconstrução NUNCA apaga o snapshot anterior.
      console.error('[items-catalog] falha na reconstrucao');
      if (manifest) {
        const items = await lerCatalogoPublicado(cache, manifest);
        warnings.push('atualizacao_falhou');
        return json(res, 200, {
          ok: true,
          ...montarResposta(manifest, items, 'fallback_stale', SOFT, HARD, warnings),
        });
      }
      return json(res, 409, { error: 'not_ready', code: 'atualizacao_falhou' });
    } finally {
      await cache.delIfEquals(CATALOG_LOCK_KEY, dono);
    }
  } catch (e) {
    console.error('[items-catalog]', e instanceof Error ? e.message : e);
    return json(res, 500, { error: 'erro_interno' });
  }
}