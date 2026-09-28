/**
 * Contrato HTTP da conta nas rotas — etapa 0 do plano multi-conta.
 *
 * Duas promessas, uma por lado:
 *  - COMPATIBILIDADE: sem `contas`/`conta` (o dashboard, o GitHub Actions e
 *    os scripts atuais) tudo responde como antes, sobre as chaves de sempre;
 *    `contas=overwine-ml` explicito e identico ao ausente.
 *  - REJEICAO: conta desconhecida, inativa ou nao habilitada e 400 em toda
 *    rota, de leitura ou de acao, e nada e lido nem escrito — nunca cai na
 *    legada. Acao com lista de contas e 400 `conta_unica`.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { createSession } from '../src/lib/session.js';
import { type OrdersManifest, writeChunk, publishManifest } from '../src/lib/orders-store.js';
import type { OrderSlim } from '../src/services/orders.service.js';
import ordersHandler from '../api/orders/[resource].js';
import refreshHandler from '../api/orders/refresh.js';
import itemsHandler from '../api/items/[resource].js';
import mlHandler from '../api/ml/[op].js';
import syncHandler from '../api/admin/orders-sync.js';
import shippingHandler from '../api/admin/shipping-sync.js';
import seedHandler from '../api/admin/seed.js';

function mockReq(o: Partial<{ method: string; headers: Record<string, unknown>; query: Record<string, unknown>; body: unknown }> = {}) {
  return { method: 'GET', headers: {}, query: {}, body: undefined, socket: { remoteAddress: '10.0.0.1' }, ...o } as any;
}
function mockRes() {
  const r: any = { statusCode: 0, headers: {} as Record<string, string>, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k.toLowerCase()] = v; return r; };
  r.send = (b: any) => { r.body = b; return r; };
  r.end = () => r;
  r.json = () => JSON.parse(r.body);
  return r;
}

let cache: FakeCache;
let token: string;
beforeEach(async () => {
  cache = new FakeCache();
  setCacheForTests(cache);
  Object.assign(process.env, TEST_ENV);
  delete process.env.MULTI_CONTA_ENABLED;
  resetEnvForTests();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  token = (await createSession(cache)).id;
  await publicar(5);
});
afterEach(() => vi.restoreAllMocks());

async function publicar(n: number) {
  const pedidos: OrderSlim[] = Array.from({ length: n }, (_, i) => ({
    id: i + 1, status: 'paid', date_created: `2026-09-2${i}T10:00:00.000Z`, paid_amount: 100, total_amount: 100,
    order_items: [{ quantity: 1, unit_price: 100, item: { id: 'MLB1', title: 'V', seller_sku: 'S', variation_id: null } }],
  }));
  const chave = await writeChunk(cache, 'ativos', 1, 0, pedidos);
  const man: OrdersManifest = { versao: 1, chunks: [chave], totalRegistros: n, newestDate: pedidos[n - 1].date_created, oldestDate: pedidos[0].date_created, chunkSize: 500, updatedAt: '2026-09-25T00:00:00.000Z', origem: 'full', chunkCounts: [n] };
  await publishManifest(cache, 'ativos', man);
  await cache.set('orders:sync:status:ativos', JSON.stringify({ ultimaVersao: 1, totalRegistros: n, newestDate: man.newestDate, lastSyncAt: '2026-09-25T00:00:00.000Z', lastResult: 'ok', emAndamento: false }));
}
// Rate limit (rl:*) e escrito antes da validacao da conta: nao e dado de conta.
const chaves = () => [...cache.store.keys(), ...cache.lists.keys()].filter(k => !k.startsWith('rl:')).sort();
const auth = () => ({ authorization: `Bearer ${token}` });
const admin = () => ({ 'x-admin-key': TEST_ENV.ADMIN_KEY, 'content-type': 'application/json' });

async function orders(query: Record<string, unknown>) {
  const res = mockRes();
  await ordersHandler(mockReq({ query: { resource: 'status', alvo: 'ativos', ...query }, headers: auth() }), res);
  return res;
}

describe('leitura — /api/orders/status', () => {
  it('sem contas: responde como antes e declara a conta legada', async () => {
    const res = await orders({});
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.versao).toBe(1);
    expect(b.totalRegistros).toBe(5);
    expect(b.conta).toBe('overwine-ml');
  });

  it('contas=overwine-ml explicito e identico ao ausente', async () => {
    const a = (await orders({})).json();
    const b = (await orders({ contas: 'overwine-ml' })).json();
    delete a.agora; delete b.agora; delete a.idadeSegundos; delete b.idadeSegundos; delete a.idadeCheckSegundos; delete b.idadeCheckSegundos;
    expect(b).toEqual(a);
  });

  it('conta desconhecida → 400 conta_invalida, e nenhuma chave nova foi tocada', async () => {
    const antes = chaves();
    const res = await orders({ contas: 'xpto' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'conta_invalida', conta: 'xpto' });
    expect(chaves()).toEqual(antes);
  });

  it('conta declarada mas inativa → 400 conta_inativa (flag desligada ou ligada)', async () => {
    const res = await orders({ contas: 'degustar-ml' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('conta_inativa');
  });

  it('lista com mais de uma conta → 400, nunca "a primeira em silencio" (flag desligada ou ligada)', async () => {
    expect((await orders({ contas: 'overwine-ml,degustar-ml' })).statusCode).toBe(400);
    process.env.MULTI_CONTA_ENABLED = 'true';
    const res = await orders({ contas: 'overwine-ml,degustar-ml' });
    expect(res.statusCode).toBe(400);
    expect(['conta_inativa', 'consolidacao_indisponivel']).toContain(res.json().error);
    const itens = mockRes();
    await itemsHandler(mockReq({ query: { resource: 'catalog', contas: 'overwine-ml,degustar-ml' }, headers: auth() }), itens);
    expect(itens.statusCode).toBe(400);
  });

  it('conta inativa com a flag ligada → 400 conta_inativa (ativar exige a etapa da conta)', async () => {
    process.env.MULTI_CONTA_ENABLED = 'true';
    const res = await orders({ contas: 'alemmar-amazon' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('conta_inativa');
  });

  it('a validacao da conta vem DEPOIS da sessao: sem sessao e 401, nao 400', async () => {
    const res = mockRes();
    await ordersHandler(mockReq({ query: { resource: 'status', contas: 'xpto' } }), res);
    expect(res.statusCode).toBe(401);
  });

  it('list, metrics, margin e logistics aceitam contas= e rejeitam invalida', async () => {
    for (const resource of ['list', 'metrics', 'margin', 'logistics']) {
      const ok = mockRes();
      await ordersHandler(mockReq({ query: { resource, alvo: 'ativos', contas: 'overwine-ml', dias: resource === 'list' || resource === 'logistics' ? undefined : '7' }, headers: auth() }), ok);
      expect([200, 409]).toContain(ok.statusCode);   // 409 not_ready e o contrato de sempre para base pequena
      const ruim = mockRes();
      await ordersHandler(mockReq({ query: { resource, alvo: 'ativos', contas: 'xpto' }, headers: auth() }), ruim);
      expect(ruim.statusCode).toBe(400);
    }
  });
});

describe('leitura — /api/items/catalog e /inventory', () => {
  it('contas= entra na allowlist do catalogo; invalida e 400', async () => {
    const ok = mockRes();
    await itemsHandler(mockReq({ query: { resource: 'catalog', contas: 'overwine-ml' }, headers: auth() }), ok);
    expect(ok.statusCode).not.toBe(400);
    const ruim = mockRes();
    await itemsHandler(mockReq({ query: { resource: 'catalog', contas: 'xpto' }, headers: auth() }), ruim);
    expect(ruim.statusCode).toBe(400);
    expect(ruim.json().error).toBe('conta_invalida');
    const inv = mockRes();
    await itemsHandler(mockReq({ query: { resource: 'inventory', contas: 'degustar-ml' }, headers: auth() }), inv);
    expect(inv.statusCode).toBe(400);
  });
});

describe('acoes — uma conta explicita ou a legada', () => {
  it('POST /api/orders/refresh: sem conta e como antes; conta invalida e 400 sem tocar no ML', async () => {
    const ok = mockRes();
    await refreshHandler(mockReq({ method: 'POST', headers: auth(), body: {} }), ok);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().conta).toBe('overwine-ml');
    for (const conta of ['xpto', 'degustar-ml', 'overwine-ml,degustar-ml']) {
      const r = mockRes();
      await refreshHandler(mockReq({ method: 'POST', headers: auth(), body: { conta } }), r);
      expect(r.statusCode).toBe(400);
    }
    const lista = mockRes();
    await refreshHandler(mockReq({ method: 'POST', headers: auth(), body: { conta: ['overwine-ml', 'overwine-ml'] } }), lista);
    expect(lista.statusCode).toBe(200);   // a mesma conta repetida e uma so
  });

  it('POST /api/admin/orders-sync: conta no corpo; invalida e 400 antes de qualquer passo', async () => {
    const antes = chaves();
    const r = mockRes();
    await syncHandler(mockReq({ method: 'POST', headers: admin(), body: { alvo: 'ativos', conta: 'xpto' } }), r);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('conta_invalida');
    expect(chaves()).toEqual(antes);
    const lista = mockRes();
    await syncHandler(mockReq({ method: 'POST', headers: admin(), body: { alvo: 'ativos', conta: 'overwine-ml,degustar-ml' } }), lista);
    expect(lista.json().error).toBe('conta_unica');
  });

  it('POST /api/admin/shipping-sync e /seed: conta invalida e 400', async () => {
    const s = mockRes();
    await shippingHandler(mockReq({ method: 'POST', headers: admin(), body: { conta: 'xpto' } }), s);
    expect(s.statusCode).toBe(400);
    // seed e rota de PREPARACAO: aceita conta declarada e inativa, mas exige a
    // credencial de identidade (ML_DEGUSTAR_USER_ID) — sem ela, 400.
    const seed = mockRes();
    await seedHandler(mockReq({ method: 'POST', headers: admin(), body: { refreshToken: 'TG-x', conta: 'degustar-ml' } }), seed);
    expect(seed.statusCode).toBe(400);
    expect(seed.json().error).toBe('conta_sem_credencial');
    const inexistente = mockRes();
    await seedHandler(mockReq({ method: 'POST', headers: admin(), body: { refreshToken: 'TG-x', conta: 'xpto' } }), inexistente);
    expect(inexistente.json().error).toBe('conta_invalida');
  });

  it('GET /api/ml/<op>: conta na query e removida dos parametros da operacao; invalida e 400', async () => {
    const ruim = mockRes();
    await mlHandler(mockReq({ query: { op: 'reputation', conta: 'xpto' }, headers: auth() }), ruim);
    expect(ruim.statusCode).toBe(400);
    expect(ruim.json().error).toBe('conta_invalida');
    // conta legada explicita: passa da validacao de conta (o proxy falha depois por falta de token, como sempre)
    const ok = mockRes();
    await mlHandler(mockReq({ query: { op: 'reputation', conta: 'overwine-ml' }, headers: auth() }), ok);
    expect(ok.statusCode).not.toBe(400);
  });
});
