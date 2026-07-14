import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { runOp, OPS } from '../src/ml/ops.js';
import { resetEnvForTests } from '../src/config/env.js';

let cache: FakeCache;
beforeEach(async () => {
  cache = new FakeCache();
  Object.assign(process.env, TEST_ENV);
  resetEnvForTests();
  vi.restoreAllMocks();
  // access token válido em cache p/ não disparar renovação
  await cache.set('ml:access_token',
    JSON.stringify({ token: 'AT-teste', expiresAt: Date.now() + 3600_000 }));
});
afterEach(() => vi.restoreAllMocks());

function mockML(resposta: unknown, status = 200) {
  // Response novo a cada chamada — body de Response só pode ser lido uma vez.
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify(resposta), { status }) as unknown as Response
  );
  return spy;
}

describe('allowlist do proxy', () => {
  it('rejeita operação desconhecida (sem proxy genérico)', async () => {
    const r = await runOp(cache, 'qualquer-url', {});
    expect(r.status).toBe(404);
  });

  it('valida parâmetros com zod (status inválido)', async () => {
    const r = await runOp(cache, 'items-search', { status: 'hackeado', offset: 0 });
    expect(r.status).toBe(400);
    expect(String((r.data as any).error)).toMatch(/Parâmetros inválidos/);
  });

  it('impõe limites: máximo 20 ids por lote', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `MLB12345${String(i).padStart(2, '0')}`).join(',');
    const r = await runOp(cache, 'items', { ids });
    expect(r.status).toBe(400);
  });

  it('monta a URL no servidor e usa Bearer (nunca query string)', async () => {
    const spy = mockML({ results: ['MLB1'], paging: { total: 1, offset: 0, limit: 100 } });
    const r = await runOp(cache, 'items-search', { status: 'active', offset: '0' });
    expect(r.status).toBe(200);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe('https://api.mercadolibre.com/users/2329718196/items/search?status=active&limit=100&offset=0');
    expect(String(url)).not.toContain('access_token');
    expect((init?.headers as any).Authorization).toBe('Bearer AT-teste');
  });

  it('filtra campos da resposta (whitelist) e remove PII do buyer', async () => {
    mockML({
      results: [{
        id: 1, status: 'paid', paid_amount: 100, date_created: '2026-07-01T10:00:00Z',
        buyer: { id: 9, nickname: 'COMPRADOR', first_name: 'Nome', phone: { number: '119999' } },
        order_items: [], internal_ml_field: 'nao-deve-passar',
      }],
      paging: { total: 1, offset: 0, limit: 50 },
    });
    const r = await runOp(cache, 'orders', {});
    const o = (r.data as any).results[0];
    expect(o.paid_amount).toBe(100);
    expect(o.internal_ml_field).toBeUndefined();
    expect(o.buyer.nickname).toBe('COMPRADOR');
    expect(o.buyer.first_name).toBeUndefined(); // PII fora
    expect(o.buyer.phone).toBeUndefined();
  });

  it('nenhuma resposta de operação contém access token', async () => {
    mockML({ results: [], paging: { total: 0 } });
    for (const opName of ['orders', 'promotions', 'reputation'] as const) {
      const r = await runOp(cache, opName, {});
      expect(JSON.stringify(r.data)).not.toContain('AT-teste');
      expect(JSON.stringify(r.data)).not.toContain('access_token');
    }
  });

  it('escrita: valida payload estrito de promoção e envia como body JSON', async () => {
    const spy = mockML({ status: 'started' });
    const r = await runOp(cache, 'promotion-item-set', {
      id: 'MLB5345213082', deal_price: 129.9, stock: 5,
      promotion_type: 'LIGHTNING', promotion_id: 'P-123',
    });
    expect(r.status).toBe(200);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain('/seller-promotions/items/MLB5345213082');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      deal_price: 129.9, stock: 5, promotion_type: 'LIGHTNING', promotion_id: 'P-123',
    });
  });

  it('escrita: rejeita payload com campos fora do schema', async () => {
    const r = await runOp(cache, 'promotion-item-set', {
      id: 'MLB5345213082', deal_price: -5, stock: 5,
      promotion_type: 'LIGHTNING', promotion_id: 'P-123',
    });
    expect(r.status).toBe(400);
  });

  it('erro do ML volta sem headers e sem token, com causa útil', async () => {
    mockML({ message: 'item already in promotion', cause: [{ error_message: 'duplicado' }] }, 409);
    const r = await runOp(cache, 'promotion-item-set', {
      id: 'MLB5345213082', deal_price: 10, stock: 1,
      promotion_type: 'LIGHTNING', promotion_id: 'P-1',
    });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.data)).not.toContain('AT-teste');
    expect((r.data as any).cause[0].error_message).toBe('duplicado');
  });

  it('cobre todas as 16 operações do inventário da auditoria', () => {
    expect(Object.keys(OPS).sort()).toEqual([
      'ads-billing', 'items', 'items-search', 'order', 'order-discounts', 'orders',
      'product-items', 'promotion-item-remove', 'promotion-item-set', 'promotion-items',
      'promotions', 'reputation', 'shipment', 'sites-search', 'visits',
    ].sort());
  });
});
