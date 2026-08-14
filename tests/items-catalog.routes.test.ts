import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { createSession } from '../src/lib/session.js';
import { CATALOG_COOLDOWN_KEY, CATALOG_LOCK_KEY, readCatalogManifest } from '../src/lib/items-store.js';
import handler from '../api/items/[resource].js';

// ── mocks de Vercel req/res ──
function mockReq(o: Partial<{ method: string; headers: Record<string, unknown>; query: Record<string, unknown> }> = {}) {
  return { method: 'GET', headers: {}, query: {}, ...o } as any;
}
function mockRes() {
  const r: any = { statusCode: 0, headers: {} as Record<string, string>, body: undefined, ended: false };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k.toLowerCase()] = v; return r; };
  r.send = (b: any) => { r.body = b; return r; };
  r.end = () => { r.ended = true; return r; };
  r.json = () => JSON.parse(r.body);
  return r;
}

// ── ML falso: intercepta o fetch global usado por ml-auth.mlFetch ──
let mlCalls: string[] = [];
let totais = { active: 30, paused: 10, closed: 5 };
let falharBusca = false;
let falharLote = false;

function itemBruto(id: string, status: string) {
  return {
    id, title: 'Vinho ' + id, status, price: 89.9, original_price: null,
    available_quantity: 12, sold_quantity: 3, listing_type_id: 'gold_special',
    catalog_listing: false, inventory_id: null, permalink: 'https://x/' + id,
    thumbnail: 'https://t/' + id, last_updated: '2026-08-05T10:00:00.000Z',
    seller_custom_field: 'SKU-' + id, seller_sku: null, tags: ['fulfillment'],
    // Campos que NAO podem sair na resposta:
    shipping: { logistic_type: 'fulfillment', mode: 'me2', free_shipping: true },
    attributes: [{ id: 'BRAND', value_name: 'Quinta do Coro' }, { id: 'SELLER_SKU', value_name: 'SKU-' + id }],
    health: 0.95, sub_status: [], variations: [{ id: 1, price: 80 }], base_price: 99,
    category_id: 'MLB1234', condition: 'new', date_created: '2020-01-01', catalog_product_id: 'P1',
    seller_id: 2329718196,
  };
}

function instalarML() {
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    const u = String(url);
    mlCalls.push(u);
    if (u.includes('/oauth/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok', refresh_token: 'r', expires_in: 21600 }) } as any;
    }
    if (u.includes('/items/search')) {
      if (falharBusca) return { ok: false, status: 500, json: async () => ({}) } as any;
      const st = /status=(\w+)/.exec(u)![1] as 'active' | 'paused' | 'closed';
      const off = Number(/offset=(\d+)/.exec(u)![1]);
      const total = totais[st];
      const n = Math.max(0, Math.min(100, total - off));
      return { ok: true, status: 200, json: async () => ({
        results: Array.from({ length: n }, (_, k) => `${st[0].toUpperCase()}${off + k}`),
        paging: { total },
      }) } as any;
    }
    if (u.includes('/items?ids=')) {
      if (falharLote) return { ok: false, status: 500, json: async () => ({}) } as any;
      const ids = decodeURIComponent(u.split('ids=')[1].split('&')[0]).split(',');
      return { ok: true, status: 200, json: async () => ids.map(id => ({
        code: 200,
        body: itemBruto(id, id.startsWith('A') ? 'active' : id.startsWith('P') ? 'paused' : 'closed'),
      })) } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  }));
}

let cache: FakeCache;
beforeEach(async () => {
  cache = new FakeCache();
  setCacheForTests(cache);
  Object.assign(process.env, TEST_ENV);
  resetEnvForTests();
  vi.restoreAllMocks();
  mlCalls = [];
  totais = { active: 30, paused: 10, closed: 5 };
  falharBusca = false;
  falharLote = false;
  instalarML();
  // Semeia a cadeia de token do ml-auth (access valido por 6h).
  await cache.set('ml:refresh_token', 'TG-refresh-de-teste');
  await cache.set('ml:access_token', JSON.stringify({ token: 'tok', expiresAt: Date.now() + 6 * 3600 * 1000 }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function comSessao(): Promise<string> {
  return (await createSession(cache)).id;
}

async function chamar(query: Record<string, unknown> = {}, token?: string, method = 'GET') {
  const res = mockRes();
  await handler(mockReq({
    method,
    query: { resource: 'catalog', ...query },
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }), res);
  return res;
}

const buscas = () => mlCalls.filter(u => u.includes('/items/search')).length;
const lotes = () => mlCalls.filter(u => u.includes('/items?ids=')).length;

// ══════════════════════════════════════════════════════════════════════════
describe('GET /api/items/catalog — autenticacao e metodo', () => {
  it('401 sem sessao', async () => {
    const res = await chamar();
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
  });

  it('401 com token invalido', async () => {
    const res = await chamar({}, 'sess_naoexiste');
    expect(res.statusCode).toBe(401);
  });

  it('sem sessao NAO chama o Mercado Livre', async () => {
    await chamar();
    expect(mlCalls.length).toBe(0);
  });

  it('405 fora do GET', async () => {
    const res = await chamar({}, await comSessao(), 'POST');
    expect(res.statusCode).toBe(405);
  });

  it('404 para recurso desconhecido', async () => {
    const res = mockRes();
    await handler(mockReq({ query: { resource: 'catalogo' } }), res);
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/items/catalog — parametros', () => {
  it('400 para parametro desconhecido', async () => {
    const res = await chamar({ foo: '1' }, await comSessao());
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_params', code: 'parametro_desconhecido' });
  });

  it('400 para refresh invalido', async () => {
    const res = await chamar({ refresh: 'sim' }, await comSessao());
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('refresh_invalido');
  });

  it('refresh=0 e aceito e nao forca reconstrucao', async () => {
    const t = await comSessao();
    await chamar({}, t);                       // constroi
    mlCalls = [];
    const res = await chamar({ refresh: '0' }, t);
    expect(res.statusCode).toBe(200);
    expect(mlCalls.length).toBe(0);
    expect(res.json().source).toBe('snapshot');
  });

  it('parametros invalidos nao chamam o ML', async () => {
    await chamar({ foo: '1' }, await comSessao());
    expect(mlCalls.length).toBe(0);
  });
});

describe('GET /api/items/catalog — construcao e contrato', () => {
  it('primeira chamada constroi e devolve catalogo completo', async () => {
    const res = await chamar({}, await comSessao());
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.ok).toBe(true);
    expect(b.complete).toBe(true);
    expect(b.source).toBe('rebuilt');
    expect(b.versao).toBe(1);
    expect(b.counts).toEqual({ total: 45, active: 30, paused: 10, closed: 5 });
    expect(b.items.length).toBe(45);
    expect(buscas()).toBe(3);       // 1 pagina por status
    expect(lotes()).toBe(3);        // ceil(45/20)
  });

  it('resposta expoe exatamente os campos do contrato', async () => {
    const b = (await chamar({}, await comSessao())).json();
    expect(Object.keys(b).sort()).toEqual(
      ['complete', 'counts', 'freshness', 'items', 'ok', 'source', 'updatedAt', 'versao', 'warnings']
    );
    expect(Object.keys(b.freshness).sort()).toEqual(
      ['ageSeconds', 'hardTtlSeconds', 'softTtlSeconds', 'stale']
    );
  });

  it('cada item traz somente os 18 campos aprovados', async () => {
    const b = (await chamar({}, await comSessao())).json();
    const esperado = [
      'attributes', 'available_quantity', 'catalog_listing', 'id', 'inventory_id',
      'last_updated', 'listing_type_id', 'original_price', 'permalink', 'price',
      'seller_custom_field', 'seller_sku', 'shipping', 'sold_quantity', 'status',
      'tags', 'thumbnail', 'title',
    ];
    for (const item of b.items) expect(Object.keys(item).sort()).toEqual(esperado);
    expect(b.items[0].shipping).toEqual({ logistic_type: 'fulfillment' });
    expect(b.items[0].attributes).toEqual([{ id: 'SELLER_SKU', value_name: 'SKU-A0' }]);
  });

  it('ordem active, paused, closed preservada', async () => {
    const b = (await chamar({}, await comSessao())).json();
    expect(b.items[0].id).toBe('A0');
    expect(b.items[30].id).toBe('P0');
    expect(b.items[40].id).toBe('C0');
  });

  it('nenhum campo extra, credencial ou PII na serializacao', async () => {
    const bruto = (await chamar({}, await comSessao())).body as string;
    for (const proibido of [
      'health', 'sub_status', 'variations', 'base_price', 'category_id',
      'condition', 'date_created', 'catalog_product_id', 'free_shipping', 'mode',
      'BRAND', 'Quinta do Coro', 'seller_id', 'access_token', 'refresh',
      'buyer', 'nickname', 'Bearer', 'items:catalog', 'chunk',
    ]) {
      expect(bruto).not.toContain(proibido);
    }
  });
});

describe('GET /api/items/catalog — cache, frescor e lock', () => {
  it('segunda chamada usa o snapshot, sem tocar no ML', async () => {
    const t = await comSessao();
    await chamar({}, t);
    mlCalls = [];
    const b = (await chamar({}, t)).json();
    expect(mlCalls.length).toBe(0);
    expect(b.source).toBe('snapshot');
    expect(b.versao).toBe(1);
    expect(b.freshness.stale).toBe(false);
  });

  it('freshness reflete os TTLs configurados', async () => {
    const b = (await chamar({}, await comSessao())).json();
    expect(b.freshness.softTtlSeconds).toBe(900);
    expect(b.freshness.hardTtlSeconds).toBe(86400);
  });

  it('alem do soft TTL: stale true, mas continua servindo sem reconstruir', async () => {
    const t = await comSessao();
    await chamar({}, t);
    const man = (await readCatalogManifest(cache))!;
    man.updatedAt = new Date(Date.now() - 1800 * 1000).toISOString(); // 30 min
    await cache.set('items:catalog:manifest', JSON.stringify(man));
    mlCalls = [];
    const b = (await chamar({}, t)).json();
    expect(mlCalls.length).toBe(0);
    expect(b.source).toBe('snapshot');
    expect(b.freshness.stale).toBe(true);
  });

  it('alem do hard TTL: reconstroi antes de responder', async () => {
    const t = await comSessao();
    await chamar({}, t);
    const man = (await readCatalogManifest(cache))!;
    man.updatedAt = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    await cache.set('items:catalog:manifest', JSON.stringify(man));
    mlCalls = [];
    const b = (await chamar({}, t)).json();
    expect(mlCalls.length).toBeGreaterThan(0);
    expect(b.source).toBe('rebuilt');
    expect(b.versao).toBe(2);
  });

  it('refresh=1 reconstroi e incrementa a versao', async () => {
    const t = await comSessao();
    await chamar({}, t);
    const b = (await chamar({ refresh: '1' }, t)).json();
    expect(b.source).toBe('rebuilt');
    expect(b.versao).toBe(2);
  });

  it('cooldown bloqueia o segundo refresh seguido e serve o snapshot', async () => {
    const t = await comSessao();
    await chamar({}, t);
    await chamar({ refresh: '1' }, t);
    mlCalls = [];
    const b = (await chamar({ refresh: '1' }, t)).json();
    expect(mlCalls.length).toBe(0);
    expect(b.source).toBe('snapshot');
    expect(b.warnings).toContain('refresh_em_cooldown');
    expect(await cache.get(CATALOG_COOLDOWN_KEY)).not.toBeNull();
  });

  it('lock ocupado: serve o snapshot atual, sem reconstruir', async () => {
    const t = await comSessao();
    await chamar({}, t);
    await cache.setNX(CATALOG_LOCK_KEY, 'outro-dono', 60);
    mlCalls = [];
    const b = (await chamar({ refresh: '1' }, t)).json();
    expect(mlCalls.length).toBe(0);
    expect(b.warnings).toContain('reconstrucao_em_andamento');
    expect(b.versao).toBe(1);
  });

  it('lock ocupado e sem snapshot: 409, nunca catalogo vazio', async () => {
    const t = await comSessao();
    await cache.setNX(CATALOG_LOCK_KEY, 'outro-dono', 60);
    const res = await chamar({}, t);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'not_ready', code: 'reconstrucao_em_andamento' });
  });

  it('o lock e liberado ao final da reconstrucao', async () => {
    const t = await comSessao();
    await chamar({}, t);
    expect(await cache.get(CATALOG_LOCK_KEY)).toBeNull();
  });
});

describe('GET /api/items/catalog — catalogo parcial e falhas', () => {
  it('falha na busca de ids: serve o snapshot anterior como fallback stale', async () => {
    const t = await comSessao();
    await chamar({}, t);                        // versao 1 completa
    falharBusca = true;
    const b = (await chamar({ refresh: '1' }, t)).json();
    expect(b.ok).toBe(true);
    expect(b.complete).toBe(true);              // o que voltou E completo (o anterior)
    expect(b.source).toBe('fallback_stale');
    expect(b.versao).toBe(1);
    expect(b.items.length).toBe(45);
    expect(b.warnings).toContain('atualizacao_falhou');
  });

  it('lote que falha nao publica: snapshot anterior permanece intacto', async () => {
    const t = await comSessao();
    await chamar({}, t);
    falharLote = true;
    const b = (await chamar({ refresh: '1' }, t)).json();
    expect(b.source).toBe('fallback_stale');
    expect(b.versao).toBe(1);
    expect((await readCatalogManifest(cache))!.versao).toBe(1);
  });

  it('catalogo incompleto NUNCA vira snapshot publicado', async () => {
    const t = await comSessao();
    await chamar({}, t);
    const antes = await readCatalogManifest(cache);
    falharLote = true;
    await chamar({ refresh: '1' }, t);
    expect(await readCatalogManifest(cache)).toEqual(antes);
  });

  it('falha na primeira construcao, sem snapshot anterior: 409', async () => {
    falharBusca = true;
    const res = await chamar({}, await comSessao());
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_ready');
    expect(res.json().code).toBe('atualizacao_falhou');
  });

  it('counts sempre corresponde ao catalogo completo devolvido', async () => {
    const t = await comSessao();
    const b1 = (await chamar({}, t)).json();
    expect(b1.counts.total).toBe(b1.items.length);
    falharLote = true;
    const b2 = (await chamar({ refresh: '1' }, t)).json();
    expect(b2.counts.total).toBe(b2.items.length);
  });

  it('manifesto corrompido nao vira 500: reconstroi e avisa', async () => {
    const t = await comSessao();
    await cache.set('items:catalog:manifest', '{ isso nao e json');
    const res = await chamar({}, t);
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings).toContain('manifesto_anterior_invalido');
    expect(res.json().complete).toBe(true);
  });
});

describe('GET /api/items/catalog — garantias estaticas', () => {
  function semComentarios(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('a rota nunca devolve o token do ML nem usa scan/keys/mget', () => {
    const src = semComentarios(readFileSync(new URL('../api/items/[resource].ts', import.meta.url), 'utf-8'));
    expect(src).not.toMatch(/getAccessToken\s*\(/);
    // cache.keys/scan/mget sao proibidos (Object.keys do req.query nao conta).
    expect(src).not.toMatch(/cache\.(scan|keys|mget)\s*\(/);
    expect(src).not.toMatch(/access_token/);
  });

  it('o store de catalogo fala so com a interface Cache', () => {
    const src = semComentarios(readFileSync(new URL('../src/lib/items-store.ts', import.meta.url), 'utf-8'));
    expect(src).not.toMatch(/\.scan\s*\(|\.keys\s*\(|\.mget\s*\(/);
    expect(src).not.toMatch(/upstash/i);
  });

  it('o service nao conhece rede: nenhum fetch nem mercadolibre', () => {
    const src = semComentarios(readFileSync(new URL('../src/services/items-catalog.service.ts', import.meta.url), 'utf-8'));
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/mercadolibre/);
  });
});