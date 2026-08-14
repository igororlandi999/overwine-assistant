/**
 * GET /api/items/catalog            — catálogo agregado (usa snapshot)
 * GET /api/items/catalog?refresh=1  — reconstrução EXPLÍCITA (com cooldown)
 *
 * Uma única função serverless com `resource ∈ {catalog}` (mesmo padrão de
 * api/orders/[resource].ts e api/auth/[action].ts).
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return; // OPTIONS encerra aqui (204)

  const resource = String(req.query.resource || '');
  if (resource !== 'catalog') {
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

    // Allowlist de parâmetros: 400 determinístico para qualquer outro.
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