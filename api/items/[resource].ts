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
import {
  resolverContasDeLeitura, mlUserIdDaConta, ContaInvalidaError, erroContaParaHttp, type Conta,
} from '../../src/config/contas.js';
import { cacheDaConta } from '../../src/lib/cache/conta-cache.js';
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
 * TRÊS BASES: `proprio` e `full` classificam pelo saldo do respectivo lado, em
 * paridade com as abas do dashboard. `total` traz as mesmas linhas de `proprio`
 * reclassificadas sobre próprio + Full, com os MESMOS limites — é a base que
 * responde "o que está acabando?" sem confundir depósito vazio com falta de
 * estoque. Só aparece no escopo `ambos`.
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
  lidas: ReadonlyArray<{ conta: Conta; cache: ReturnType<typeof getCache> }>
) {
  const PERMITIDOS = new Set(['resource', 'dias', 'from', 'to', 'modo', 'escopo', 'contas']);
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
  const opcoes = { periodo: p.periodo, modo, escopo, hardTtlS: env.ITEMS_CATALOG_HARD_TTL_S };

  // Seleção que não é a conta legada sozinha: estoque por conta, linhas
  // MARCADAS e nunca fundidas — o mesmo SKU em duas empresas são dois saldos.
  if (lidas.length > 1 || !lidas[0].conta.legada) {
    const partes: Array<{ conta: Conta; inv: Inventario }> = [];
    const naoProntas: Array<{ conta: string; code: string }> = [];
    for (const l of lidas) {
      const ri = await lerInventario(l.cache, opcoes);
      if (ri.ok) partes.push({ conta: l.conta, inv: ri.value });
      else naoProntas.push({ conta: l.conta.id, code: ri.code });
    }
    if (naoProntas.length) {
      return json(res, 409, { error: 'not_ready', code: naoProntas[0].code, contasNaoProntas: naoProntas });
    }
    const juntar = <T extends { tipo: string | null }>(
      pegar: (i: Inventario) => T[] | null
    ): Array<T & { conta: string }> | null => {
      const blocos = partes.map(x => ({ conta: x.conta.id, linhas: pegar(x.inv) }));
      if (blocos.some(b => b.linhas === null)) return null;
      return blocos.flatMap(b => b.linhas!.map(l => ({ ...l, conta: b.conta })));
    };
    const proprio = juntar(i => i.proprio);
    const full = juntar(i => i.full);
    const total = juntar(i => i.total);
    const counts: Record<string, number> = {};
    for (const x of partes) {
      for (const [k, v] of Object.entries(x.inv.catalogo.counts as unknown as Record<string, number>)) {
        counts[k] = (counts[k] ?? 0) + v;
      }
    }
    const base = partes[0].inv;
    return json(res, 200, {
      ok: true,
      contas: partes.map(x => x.conta.id),
      consolidado: partes.length > 1,
      catalogo: {
        versao: partes.reduce((s, x) => s + x.inv.catalogo.versao, 0),
        versoes: Object.fromEntries(partes.map(x => [x.conta.id, x.inv.catalogo.versao])),
        // O mais ANTIGO: o catálogo da seleção só é tão fresco quanto o mais velho.
        updatedAt: partes.map(x => x.inv.catalogo.updatedAt).sort()[0],
        counts,
        stale: partes.some(x => x.inv.catalogo.stale),
      },
      periodo: base.periodo,
      modo: base.modo,
      escopo: base.escopo,
      vendas: { disponivel: partes.every(x => x.inv.vendasDisponiveis) },
      limites: LIMITES_CLASSIFICACAO,
      proprio: proprio ? { resumo: resumir(proprio, l => l.estProprio), linhas: proprio } : null,
      full: full ? { resumo: resumir(full, l => l.estTotal), linhas: full } : null,
      total: total ? { resumo: resumir(total, l => l.estTotal), linhas: total } : null,
      warnings: Array.from(new Set(partes.flatMap(x => x.inv.warnings))),
    });
  }

  const r = await lerInventario(lidas[0].cache, opcoes);

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
    // Mesmas linhas de `proprio`, reclassificadas sobre próprio + Full. É a
    // base que responde à pergunta geral "o que está acabando?" sem mandar
    // repor um SKU que só está zerado no depósito. Presente só no escopo
    // `ambos`; `proprio` e `full` seguem intocados, com a classificação de
    // paridade que o dashboard já consome.
    total: inv.total
      ? { resumo: resumir(inv.total, l => l.estTotal), linhas: inv.total }
      : null,
    warnings: inv.warnings,
  });
}

/** Resultado do catálogo de UMA conta: o status HTTP e o corpo que a rota devolveria. */
interface RespostaCatalogo {
  status: number;
  corpo: Record<string, unknown>;
}

/**
 * Catálogo de UMA conta — a lógica de sempre (snapshot, cooldown, lock,
 * reconstrução, fallback), isolada para que a consolidação chame a MESMA
 * sequência para cada conta, com o cache, o lock e o vendedor dela.
 */
async function catalogoDaConta(
  cache: ReturnType<typeof getCache>,
  conta: Conta,
  refresh: boolean
): Promise<RespostaCatalogo> {
  const env = getEnv();
  const SOFT = env.ITEMS_CATALOG_SOFT_TTL_S;
  const HARD = env.ITEMS_CATALOG_HARD_TTL_S;
  const ok = (corpo: object): RespostaCatalogo => ({ status: 200, corpo: { ok: true, ...corpo } });

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
    return ok(montarResposta(manifest, items, 'snapshot', SOFT, HARD, warnings));
  }

  // Cooldown protege o ML de rajadas de refresh forçado. Não se aplica
  // quando não há snapshot algum — aí a reconstrução é a única saída.
  if (refresh && manifest && !vencido) {
    const livre = await cache.setNX(CATALOG_COOLDOWN_KEY, '1', env.ITEMS_CATALOG_COOLDOWN_S);
    if (!livre) {
      const items = await lerCatalogoPublicado(cache, manifest);
      warnings.push('refresh_em_cooldown');
      return ok(montarResposta(manifest, items, 'snapshot', SOFT, HARD, warnings));
    }
  }

  // Lock: nenhuma reconstrução concorrente duplicada.
  const dono = donoLock();
  const gotLock = await cache.setNX(CATALOG_LOCK_KEY, dono, env.ITEMS_CATALOG_LOCK_TTL_S);
  if (!gotLock) {
    if (manifest) {
      const items = await lerCatalogoPublicado(cache, manifest);
      warnings.push('reconstrucao_em_andamento');
      return ok(montarResposta(manifest, items, vencido ? 'fallback_stale' : 'snapshot', SOFT, HARD, warnings));
    }
    return { status: 409, corpo: { error: 'not_ready', code: 'reconstrucao_em_andamento' } };
  }

  try {
    const { ids, batch } = fetchers(cache, mlUserIdDaConta(conta));
    const { manifest: novo, resultado } = await reconstruirCatalogo(
      cache, ids, batch, env.ITEMS_CATALOG_CHUNK_SIZE,
      { maxChamadas: env.ITEMS_CATALOG_MAX_CALLS }
    );

    if (novo) {
      const items = await lerCatalogoPublicado(cache, novo);
      return ok(montarResposta(novo, items, 'rebuilt', SOFT, HARD, warnings));
    }

    // INCOMPLETO: nada foi publicado. Serve o snapshot completo anterior.
    console.warn(`[items-catalog] construcao incompleta motivos=${resultado.motivos.join('|')}`);
    if (manifest) {
      const items = await lerCatalogoPublicado(cache, manifest);
      warnings.push('catalogo_incompleto_usando_anterior', ...resultado.motivos);
      return ok(montarResposta(manifest, items, 'fallback_stale', SOFT, HARD, warnings));
    }
    return { status: 409, corpo: { error: 'not_ready', code: 'catalogo_incompleto' } };
  } catch (e) {
    // Falha da reconstrução NUNCA apaga o snapshot anterior.
    console.error('[items-catalog] falha na reconstrucao');
    if (manifest) {
      const items = await lerCatalogoPublicado(cache, manifest);
      warnings.push('atualizacao_falhou');
      return ok(montarResposta(manifest, items, 'fallback_stale', SOFT, HARD, warnings));
    }
    return { status: 409, corpo: { error: 'not_ready', code: 'atualizacao_falhou' } };
  } finally {
    await cache.delIfEquals(CATALOG_LOCK_KEY, dono);
  }
}

/** Do pior para o melhor: a origem da união é a da conta em pior situação. */
const ORDEM_SOURCE = ['fallback_stale', 'rebuilt', 'snapshot'];

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

  // `cacheGlobal`: sessão e rate limit, do backend. O cache de DADOS é o da
  // conta (snapshot de catálogo, lock, cooldown, token do ML). Para a conta
  // legada são o mesmo objeto e as mesmas chaves de sempre.
  const cacheGlobal = getCache();

  try {
    const sess = await validateSession(cacheGlobal, readBearer(req));
    if (!sess) return json(res, 401, { error: 'unauthorized' });

    if (!(await rateLimitOk(cacheGlobal, `items-read:${sess.id.slice(0, 24)}`, 600, 60))) {
      return json(res, 429, { error: 'rate_limited' });
    }

    // Conta: ausente = legada; inválida = 400; mais de uma = consolidado.
    let contas: Conta[];
    try {
      contas = resolverContasDeLeitura(req.query.contas);
    } catch (e) {
      if (e instanceof ContaInvalidaError) return json(res, 400, erroContaParaHttp(e));
      throw e;
    }
    const lidas = contas.map(c => ({ conta: c, cache: cacheDaConta(cacheGlobal, c) }));

    if (resource === 'inventory') return await responderInventario(req, res, lidas);

    // Allowlist de parâmetros do `catalog`: 400 determinístico para qualquer outro.
    for (const k of Object.keys(req.query)) {
      if (k !== 'resource' && k !== 'refresh' && k !== 'contas') {
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

    // A conta legada sozinha responde com o corpo de sempre, sem campo novo.
    if (lidas.length === 1 && lidas[0].conta.legada) {
      const r = await catalogoDaConta(lidas[0].cache, lidas[0].conta, refresh);
      return json(res, r.status, r.corpo);
    }

    // Demais seleções: uma passada por conta (cada uma com o lock e o
    // vendedor dela), anúncios MARCADOS com a conta.
    const partes: Array<{ conta: Conta; corpo: Record<string, any> }> = [];
    const naoProntas: Array<{ conta: string; code: unknown }> = [];
    for (const l of lidas) {
      const r = await catalogoDaConta(l.cache, l.conta, refresh);
      if (r.status === 200) partes.push({ conta: l.conta, corpo: r.corpo });
      else naoProntas.push({ conta: l.conta.id, code: r.corpo.code });
    }
    if (naoProntas.length) {
      return json(res, 409, { error: 'not_ready', code: naoProntas[0].code, contasNaoProntas: naoProntas });
    }
    const counts: Record<string, number> = {};
    for (const x of partes) {
      for (const [k, v] of Object.entries(x.corpo.counts as Record<string, number>)) counts[k] = (counts[k] ?? 0) + v;
    }
    const pior = partes.reduce((m, x) => (x.corpo.freshness.ageSeconds > m.corpo.freshness.ageSeconds ? x : m), partes[0]);
    return json(res, 200, {
      ok: true,
      contas: partes.map(x => x.conta.id),
      consolidado: partes.length > 1,
      versao: partes.reduce((s, x) => s + (x.corpo.versao as number), 0),
      versoes: Object.fromEntries(partes.map(x => [x.conta.id, x.corpo.versao])),
      // O mais ANTIGO: a união só é tão fresca quanto o catálogo mais velho.
      updatedAt: pior.corpo.updatedAt,
      source: partes.map(x => String(x.corpo.source)).sort((a, b) => ORDEM_SOURCE.indexOf(a) - ORDEM_SOURCE.indexOf(b))[0],
      complete: true,
      freshness: { ...pior.corpo.freshness, stale: partes.some(x => x.corpo.freshness.stale) },
      counts,
      items: partes.flatMap(x => (x.corpo.items as object[]).map(i => ({ ...i, conta: x.conta.id }))),
      warnings: Array.from(new Set(partes.flatMap(x => x.corpo.warnings as string[]))),
    });
  } catch (e) {
    console.error('[items-catalog]', e instanceof Error ? e.message : e);
    return json(res, 500, { error: 'erro_interno' });
  }
}
