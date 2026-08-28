/**
 * Contrato HTTP de POST /api/orders/refresh.
 *
 * O ponto sensível desta rota é quem pode chamá-la e o que ela devolve. Ela é
 * o primeiro caminho do projeto em que o NAVEGADOR provoca uma escrita de
 * snapshot e uma chamada ao Mercado Livre. Os testes abaixo travam as duas
 * fronteiras: a autorização é a sessão normal do dashboard (nunca ADMIN_KEY),
 * e a resposta não carrega token, chave Redis nem pedido bruto.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { createSession } from '../src/lib/session.js';
import {
  type OrdersManifest, writeChunk, publishManifest,
} from '../src/lib/orders-store.js';
import { ORDERS_SYNC_LOCK_KEY } from '../src/services/orders-sync.service.js';
import { CHAVE_COOLDOWN_REFRESH } from '../src/services/orders-refresh.service.js';
import type { OrderSlim } from '../src/services/orders.service.js';
import handler from '../api/orders/refresh.js';

function mockReq(o: Partial<{ method: string; headers: Record<string, unknown>; query: Record<string, unknown>; body: unknown }> = {}) {
  return { method: 'POST', headers: {}, query: {}, body: undefined, ...o } as any;
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

let cache: FakeCache;
beforeEach(() => {
  cache = new FakeCache();
  setCacheForTests(cache);
  Object.assign(process.env, TEST_ENV);
  resetEnvForTests();
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function sessao(): Promise<string> {
  return (await createSession(cache)).id;
}

async function chamar(token?: string, method = 'POST') {
  const res = mockRes();
  await handler(
    mockReq({ method, headers: token ? { authorization: `Bearer ${token}` } : {} }),
    res
  );
  return res;
}

/** Snapshot base com `lastSyncAt` velho o bastante para acionar o refresh. */
async function baseVelha(n = 5) {
  const pedidos: OrderSlim[] = Array.from({ length: n }, (_, i) => ({
    id: i + 1, status: 'paid', date_created: `2026-08-2${i}T10:00:00.000Z`,
    paid_amount: 100, total_amount: 100,
    order_items: [{ quantity: 1, unit_price: 100, item: { id: 'MLB1', title: 'V', seller_sku: 'S', variation_id: null } }],
  }));
  const chave = await writeChunk(cache, 'ativos', 1, 0, pedidos);
  const man: OrdersManifest = {
    versao: 1, chunks: [chave], totalRegistros: n,
    newestDate: pedidos[0].date_created, oldestDate: pedidos[n - 1].date_created,
    chunkSize: 500, updatedAt: '2026-08-28T02:24:00.000Z', origem: 'full', chunkCounts: [n],
  };
  await publishManifest(cache, 'ativos', man);
  await cache.set('orders:sync:status:ativos', JSON.stringify({
    ultimaVersao: 1, totalRegistros: n, newestDate: man.newestDate,
    lastSyncAt: new Date(Date.now() - 3600_000).toISOString(),
    lastResult: 'ok', emAndamento: false,
  }));
}

describe('autorização — sessão do dashboard, nunca ADMIN_KEY', () => {
  it('sem Bearer: 401', async () => {
    expect((await chamar()).statusCode).toBe(401);
  });

  it('Bearer inválido: 401', async () => {
    expect((await chamar('sess_inexistente')).statusCode).toBe(401);
  });

  it('x-admin-key NÃO substitui sessão', async () => {
    const res = mockRes();
    await handler(mockReq({ headers: { 'x-admin-key': TEST_ENV.ADMIN_KEY } }), res);
    expect(res.statusCode).toBe(401);
  });

  it('só POST', async () => {
    expect((await chamar(await sessao(), 'GET')).statusCode).toBe(405);
  });

  it('sessão válida é aceita', async () => {
    await baseVelha();
    // Sem token do ML semeado, a busca falha — mas a AUTORIZAÇÃO passou, que é
    // o que este teste verifica.
    const res = await chamar(await sessao());
    expect(res.statusCode).toBe(200);
  });
});

describe('resposta — nada de segredo, token ou pedido bruto', () => {
  it('snapshot fresco devolve acao=fresco sem tocar em nada', async () => {
    await baseVelha();
    await cache.set('orders:sync:status:ativos', JSON.stringify({
      ultimaVersao: 1, totalRegistros: 5, newestDate: null,
      lastSyncAt: new Date().toISOString(), lastResult: 'ok', emAndamento: false,
    }));
    const b = (await chamar(await sessao())).json();
    expect(b).toMatchObject({ ok: true, acao: 'fresco' });
  });

  it('sem snapshot base: acao=sem_snapshot (carga inicial não é do navegador)', async () => {
    const b = (await chamar(await sessao())).json();
    expect(b).toMatchObject({ ok: true, acao: 'sem_snapshot' });
  });

  it('lock ocupado: acao=sync_em_andamento, e o lock segue com o dono', async () => {
    await baseVelha();
    await cache.setNX(ORDERS_SYNC_LOCK_KEY, 'reconciliacao', 120);
    const b = (await chamar(await sessao())).json();
    expect(b).toMatchObject({ ok: true, acao: 'sync_em_andamento' });
    expect(await cache.get(ORDERS_SYNC_LOCK_KEY)).toBe('reconciliacao');
  });

  it('cooldown ativo: acao=cooldown', async () => {
    await baseVelha();
    await cache.setNX(CHAVE_COOLDOWN_REFRESH, 'outra-aba', 60);
    const b = (await chamar(await sessao())).json();
    expect(b).toMatchObject({ ok: true, acao: 'cooldown' });
  });

  /**
   * Falha do Mercado Livre NÃO pode virar 5xx: o snapshot anterior continua
   * válido e servido, e o dashboard não deve tratar isso como erro de leitura.
   */
  it('erro na sincronização responde 200 com ok:false, não 5xx', async () => {
    await baseVelha();
    // Sem `ml:refresh_token` semeado, getAccessToken lança dentro do fetcher.
    const res = await chamar(await sessao());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, acao: 'erro' });
  });

  it('a resposta NUNCA carrega token, chave Redis, chunk ou pedido bruto', async () => {
    await baseVelha();
    await cache.set('ml:access_token', JSON.stringify({ token: 'token-secreto-do-ml', expiresAt: Date.now() + 3600_000 }));
    const bruto = String((await chamar(await sessao())).body);
    for (const proibido of [
      'token-secreto-do-ml', 'access_token', 'orders:chunk', 'orders:manifest',
      'orders:sync', TEST_ENV.ADMIN_KEY, 'order_items', 'paid_amount', 'buyer',
    ]) {
      expect(bruto, proibido).not.toContain(proibido);
    }
  });
});

describe('carga — abas concorrentes na fronteira HTTP', () => {
  it('10 requisições simultâneas não viram 10 sincronizações', async () => {
    await baseVelha();
    const tokens = await Promise.all(Array.from({ length: 10 }, () => sessao()));
    const rs = await Promise.all(tokens.map(t => chamar(t)));

    const acoes = rs.map(r => r.json().acao);
    expect(acoes.filter(a => a === 'cooldown')).toHaveLength(9);
    // A que passou tentou sincronizar (e falha por falta de token do ML, o que
    // não importa aqui: o ponto é que só UMA passou do cooldown).
    expect(acoes.filter(a => a !== 'cooldown')).toHaveLength(1);
  });
});
