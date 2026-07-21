import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { createSession } from '../src/lib/session.js';
import {
  type Alvo, type OrdersManifest, writeChunk, publishManifest,
} from '../src/lib/orders-store.js';
import type { OrderSlim } from '../src/services/orders.service.js';
import handler from '../api/orders/[resource].js';

// ── mocks mínimos de Vercel req/res ──
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

async function publicar(cache: FakeCache, alvo: Alvo, n: number, chunkSize: number): Promise<OrdersManifest> {
  const pedidos: OrderSlim[] = Array.from({ length: n }, (_, i) => ({
    id: i + 1, status: 'paid', date_created: `2026-07-01T10:00:${String(i % 60).padStart(2, '0')}.000-03:00`,
    paid_amount: 100, total_amount: 100,
    order_items: [{ quantity: 1, unit_price: 100, item: { id: `MLB${i + 1}`, title: 'V', seller_sku: 'S', variation_id: null } }],
    buyer: { nickname: 'X' },
  }));
  const chunks: string[] = [];
  for (let i = 0; i * chunkSize < n; i++) {
    chunks.push(await writeChunk(cache, alvo, 1, i, pedidos.slice(i * chunkSize, (i + 1) * chunkSize)));
  }
  const man: OrdersManifest = {
    versao: 1, chunks, totalRegistros: n,
    newestDate: n ? pedidos[n - 1].date_created : null, oldestDate: n ? pedidos[0].date_created : null,
    chunkSize, updatedAt: '2026-07-20T12:00:00.000Z', origem: 'full',
  };
  await publishManifest(cache, alvo, man);
  return man;
}

let cache: FakeCache;
beforeEach(() => {
  cache = new FakeCache();
  setCacheForTests(cache);
  Object.assign(process.env, TEST_ENV);
  resetEnvForTests();
  vi.restoreAllMocks();
});
afterEach(() => vi.restoreAllMocks());

async function comSessao(): Promise<string> {
  const s = await createSession(cache);
  return s.id;
}

describe('rota /api/orders/[resource] — auth e método', () => {
  it('23. sem sessão → 401 unauthorized', async () => {
    const res = mockRes();
    await handler(mockReq({ query: { resource: 'status', alvo: 'ativos' } }), res);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
  });

  it('24. apenas x-admin-key (sem Bearer) → 401 (não substitui sessão)', async () => {
    const res = mockRes();
    await handler(mockReq({ query: { resource: 'status', alvo: 'ativos' }, headers: { 'x-admin-key': TEST_ENV.ADMIN_KEY } }), res);
    expect(res.statusCode).toBe(401);
  });

  it('25. OPTIONS (preflight) responde 204 e encerra', async () => {
    const res = mockRes();
    await handler(mockReq({ method: 'OPTIONS', headers: { origin: TEST_ENV.ALLOWED_ORIGIN }, query: { resource: 'status' } }), res);
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
  });

  it('26. POST → 405', async () => {
    const tok = await comSessao();
    const res = mockRes();
    await handler(mockReq({ method: 'POST', query: { resource: 'status', alvo: 'ativos' }, headers: { authorization: `Bearer ${tok}` } }), res);
    expect(res.statusCode).toBe(405);
  });

  it('27. resource inválido → 404', async () => {
    const tok = await comSessao();
    const res = mockRes();
    await handler(mockReq({ query: { resource: 'qualquer', alvo: 'ativos' }, headers: { authorization: `Bearer ${tok}` } }), res);
    expect(res.statusCode).toBe(404);
  });
});

describe('rota — status', () => {
  it('status ativos com sessão → 200 e projeção pública', async () => {
    await publicar(cache, 'ativos', 10, 500);
    const tok = await comSessao();
    const res = mockRes();
    await handler(mockReq({ query: { resource: 'status', alvo: 'ativos' }, headers: { authorization: `Bearer ${tok}` } }), res);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ alvo: 'ativos', versao: 1, totalRegistros: 10, origem: 'full' });
    // não vaza interno
    expect(res.body).not.toContain('chunks');
    expect(res.body).not.toContain('orders:');
  });
});

describe('rota — list', () => {
  it('lista 1ª página com sessão → 200', async () => {
    await publicar(cache, 'ativos', 100, 500);
    const tok = await comSessao();
    const res = mockRes();
    await handler(mockReq({ query: { resource: 'list', alvo: 'ativos', pageSize: '50' }, headers: { authorization: `Bearer ${tok}` } }), res);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(50);
    expect(body.servedFrom).toBe('atual');
    expect(body.nextCursor).not.toBeNull();
    expect(res.body).not.toContain('orders:chunk');
  });

  it('cursor inválido → 400 invalid_cursor', async () => {
    await publicar(cache, 'ativos', 10, 500);
    const tok = await comSessao();
    const res = mockRes();
    await handler(mockReq({ query: { resource: 'list', alvo: 'ativos', cursor: '###' }, headers: { authorization: `Bearer ${tok}` } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_cursor');
  });

  it('manifesto ausente → 409 not_ready', async () => {
    const tok = await comSessao();
    const res = mockRes();
    await handler(mockReq({ query: { resource: 'list', alvo: 'ativos' }, headers: { authorization: `Bearer ${tok}` } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_ready');
  });
});

describe('28. nenhuma rota importa/chama mlFetch (garantia estática)', () => {
  // Remove comentários (linha // e bloco /* */) antes de checar código efetivo,
  // para não casar com menções em documentação interna.
  function semComentarios(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }
  it('a rota não importa ml-auth nem chama mlFetch/mercadolibre', () => {
    const src = semComentarios(readFileSync(new URL('../api/orders/[resource].ts', import.meta.url), 'utf-8'));
    expect(src).not.toMatch(/from\s+['"][^'"]*ml-auth/);
    expect(src).not.toMatch(/mlFetch\s*\(/);
    expect(src).not.toMatch(/mercadolibre/);
  });
  it('o read-service não importa ml-auth, não chama mlFetch/readSnapshot, nem scan/keys/mget', () => {
    const src = semComentarios(readFileSync(new URL('../src/services/orders-read.service.ts', import.meta.url), 'utf-8'));
    expect(src).not.toMatch(/from\s+['"][^'"]*ml-auth/);
    expect(src).not.toMatch(/mlFetch\s*\(/);
    expect(src).not.toMatch(/readSnapshot\s*\(/); // não chama a leitura-tudo
    expect(src).not.toMatch(/\.scan\s*\(|\.keys\s*\(|\.mget\s*\(/);
  });
});