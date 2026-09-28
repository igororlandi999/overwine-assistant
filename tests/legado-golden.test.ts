/**
 * Regressão "antes/depois" da conta legada — etapa 0 do plano multi-conta.
 *
 * `tests/fixtures/legado-golden.json` foi gerado pelo código ANTERIOR à etapa
 * 0 (HEAD 5e76642), com esta mesma base sintética, o mesmo Mercado Livre
 * simulado e o relógio congelado em 2026-09-28T15:00:00Z. Este teste refaz o
 * mesmo roteiro no código atual e exige igualdade: rotas (status, metrics,
 * margin, logistics, list, sync parcial e concluído, webhook + dreno, refresh,
 * catálogo reconstruído, inventário) e o estado persistido no Redis falso
 * (manifestos, status, head, telemetria, chunks por hash).
 *
 * O que é removido antes de comparar, e por quê:
 *  - `conta` nas respostas: campo NOVO da etapa 0 (delta conhecido);
 *  - ids aleatórios (jobId, build chunk) e chaves de sessão/rate limit;
 *  - valores de `ml:*` (tokens falsos) — mascarados nos dois lados;
 *  - conteúdo dos chunks vira SHA-256, para a fixture caber no repositório.
 *
 * Para REGERAR a fixture (só quando uma mudança de comportamento for
 * intencional e revisada): `GOLDEN_UPDATE=1 npx vitest run tests/legado-golden.test.ts`.
 * Nenhum dado real: ids, valores e nomes são sintéticos; TEST_ENV é falso.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { createSession } from '../src/lib/session.js';
import { type OrdersManifest, writeChunk, publishManifest } from '../src/lib/orders-store.js';
import { toSlim, type OrderInput } from '../src/services/orders.service.js';
import ordersHandler from '../api/orders/[resource].js';
import refreshHandler from '../api/orders/refresh.js';
import syncHandler from '../api/admin/orders-sync.js';
import notifHandler from '../api/notifications/ml.js';
import itemsHandler from '../api/items/[resource].js';

const FIXTURE = new URL('./fixtures/legado-golden.json', import.meta.url);
const AGORA = Date.parse('2026-09-28T15:00:00.000Z');
const UID = TEST_ENV.ML_USER_ID;

function mockReq(o: Partial<{ method: string; headers: Record<string, unknown>; query: Record<string, unknown>; body: unknown }> = {}) {
  return { method: 'GET', headers: {}, query: {}, body: undefined, socket: { remoteAddress: '10.0.0.9' }, ...o } as any;
}
function mockRes() {
  const r: any = { statusCode: 0, headers: {} as Record<string, string>, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k.toLowerCase()] = v; return r; };
  r.send = (b: any) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}

// ── Mercado Livre determinístico ────────────────────────────────────────────
const mlOrders: OrderInput[] = [];
function pedidoML(id: number, minutosAtras: number, valor: number, status = 'paid'): OrderInput {
  return {
    id, status,
    date_created: new Date(AGORA - minutosAtras * 60_000).toISOString(),
    paid_amount: valor, total_amount: valor,
    buyer: { nickname: 'COMPRADOR' + (id % 7) },
    shipping: { id: 40000 + id, logistic_type: id % 3 === 0 ? 'fulfillment' : 'drop_off' },
    order_items: [{ quantity: 1 + (id % 2), unit_price: valor, item: { id: 'MLB' + (100 + (id % 5)), title: 'Vinho ' + (id % 5), seller_sku: 'VT-' + (id % 5), variation_id: null } }],
  } as unknown as OrderInput;
}
for (let i = 0; i < 320; i++) mlOrders.push(pedidoML(500000 + i, 15 + i * 271, 80 + (i % 9) * 15, i % 23 === 0 ? 'cancelled' : 'paid'));

const fetchReal = globalThis.fetch;
function stubML() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('https://api.mercadolibre.com')) return fetchReal(input, init);
    const u = new URL(url);
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/orders/search') {
      const offset = Number(u.searchParams.get('offset') || 0), limit = Number(u.searchParams.get('limit') || 50);
      const sorted = [...mlOrders].sort((a, b) => String(b.date_created).localeCompare(String(a.date_created)));
      return j({ results: sorted.slice(offset, offset + limit), paging: { total: sorted.length, offset, limit } });
    }
    const m = u.pathname.match(/^\/orders\/(\d+)$/);
    if (m) { const o = mlOrders.find(x => String(x.id) === m[1]); return o ? j(o) : j({ error: 'not_found' }, 404); }
    if (u.pathname === `/users/${UID}/items/search`) { const ativo = u.searchParams.get('status') === 'active'; return j({ results: ativo ? ['MLB100', 'MLB101', 'MLB102', 'MLB103', 'MLB104'] : [], paging: { total: ativo ? 5 : 0 } }); }
    if (u.pathname === '/items') return j((u.searchParams.get('ids') || '').split(',').filter(Boolean).map(id => ({ code: 200, body: { id, title: 'Vinho ' + id.slice(-1), price: 100, available_quantity: 10 + Number(id.slice(-1)), status: 'active', sold_quantity: 5, permalink: 'https://x', thumbnail: '', seller_custom_field: 'VT-' + id.slice(-1), attributes: [], variations: [], listing_type_id: 'gold_special', shipping: { logistic_type: 'fulfillment' } } })));
    return j({ error: 'not_stubbed' }, 404);
  }) as typeof fetch;
}

let cache: FakeCache;
let token: string;
beforeAll(async () => {
  vi.useFakeTimers({ now: AGORA, toFake: ['Date'] });
  cache = new FakeCache();
  setCacheForTests(cache);
  Object.assign(process.env, TEST_ENV, { ML_WEBHOOK_SECRET: 'segredo-de-webhook-bem-longo' });
  delete process.env.MULTI_CONTA_ENABLED;
  resetEnvForTests();
  stubML();
  await cache.set('ml:access_token', JSON.stringify({ token: 'token-falso', expiresAt: AGORA + 3600_000 }));
  await cache.set('ml:refresh_token', 'refresh-falso');
  token = (await createSession(cache)).id;
  const base = [...mlOrders].sort((a, b) => String(b.date_created).localeCompare(String(a.date_created))).slice(20).map(toSlim);
  const chaves: string[] = []; const counts: number[] = [];
  for (let i = 0; i < base.length; i += 100) { const f = base.slice(i, i + 100); chaves.push(await writeChunk(cache, 'ativos', 1, chaves.length, f)); counts.push(f.length); }
  const man: OrdersManifest = { versao: 1, chunks: chaves, totalRegistros: base.length, newestDate: base[0].date_created, oldestDate: base[base.length - 1].date_created, chunkSize: 100, updatedAt: new Date(AGORA - 3600_000).toISOString(), origem: 'full', chunkCounts: counts };
  await publishManifest(cache, 'ativos', man);
  await cache.set('orders:sync:status:ativos', JSON.stringify({ ultimaVersao: 1, totalRegistros: base.length, newestDate: man.newestDate, lastSyncAt: new Date(AGORA - 3600_000).toISOString(), lastResult: 'ok', emAndamento: false }));
});
afterAll(() => { vi.useRealTimers(); globalThis.fetch = fetchReal; });

async function chamar(handler: any, o: any) {
  const res = mockRes();
  await handler(mockReq(o), res);
  let body: unknown = res.body;
  try { body = JSON.parse(res.body); } catch { /* texto */ }
  return { status: res.statusCode, body };
}
const auth = () => ({ authorization: `Bearer ${token}`, origin: TEST_ENV.ALLOWED_ORIGIN });
const admin = () => ({ 'x-admin-key': TEST_ENV.ADMIN_KEY, 'content-type': 'application/json' });

function normalizar(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalizar);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'conta') continue;
      if (k === 'jobId') { o[k] = '<jobId>'; continue; }
      o[k] = normalizar(val);
    }
    return o;
  }
  return v;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

async function gerar(): Promise<{ rotas: unknown; estado: Record<string, unknown> }> {
  const saida: Record<string, unknown> = {};
  const q = (resource: string, extra: Record<string, unknown> = {}) => chamar(ordersHandler, { query: { resource, alvo: 'ativos', ...extra }, headers: auth() });

  saida['status_inicial'] = await q('status');
  saida['metrics_7'] = await q('metrics', { dias: '7' });
  saida['metrics_range'] = await q('metrics', { from: '2026-08-01', to: '2026-09-28' });
  saida['margin_30'] = await q('margin', { dias: '30' });
  saida['logistics'] = await q('logistics');
  saida['list_p1'] = await q('list', { pageSize: '50' });

  saida['sync_1'] = await chamar(syncHandler, { method: 'POST', headers: admin(), body: { alvo: 'ativos' } });
  saida['sync_2'] = await chamar(syncHandler, { method: 'POST', headers: admin(), body: { alvo: 'ativos' } });
  saida['status_pos_sync'] = await q('status');

  mlOrders.push(pedidoML(999999, 1, 350));
  saida['notif'] = await chamar(notifHandler, { method: 'POST', query: { k: 'segredo-de-webhook-bem-longo' }, body: { _id: 'n-gold', topic: 'orders_v2', resource: '/orders/999999', user_id: Number(UID), application_id: Number(TEST_ENV.ML_CLIENT_ID), attempts: 1, sent: new Date(AGORA).toISOString() } });
  saida['dreno'] = await chamar(syncHandler, { method: 'POST', headers: admin(), body: { acao: 'drenar' } });
  saida['status_pos_webhook'] = await q('status');

  await cache.set('orders:sync:status:ativos', JSON.stringify({ ...JSON.parse((await cache.get('orders:sync:status:ativos'))!), lastSyncAt: new Date(AGORA - 600_000).toISOString() }));
  mlOrders.push(pedidoML(999998, 0, 120));
  saida['refresh'] = await chamar(refreshHandler, { method: 'POST', headers: auth(), body: {} });
  saida['status_pos_refresh'] = await q('status');
  saida['metrics_pos'] = await q('metrics', { dias: '7' });
  saida['margin_pos'] = await q('margin', { dias: '7' });

  saida['catalog'] = await chamar(itemsHandler, { query: { resource: 'catalog' }, headers: auth() });
  saida['inventory'] = await chamar(itemsHandler, { query: { resource: 'inventory', dias: '30' }, headers: auth() });

  const estado: Record<string, unknown> = {};
  for (const [k, v] of [...cache.store.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (k.startsWith('sess:') || k.startsWith('rl:')) continue;
    const chave = k.replace(/orders:build:chunk:[0-9a-f]+:/, 'orders:build:chunk:<jobId>:');
    if (k.startsWith('ml:')) { estado[chave] = '<token-falso>'; continue; }
    if (/^(orders|items:catalog):(cancel:)?chunk:|^orders:build:chunk:/.test(k)) { estado[chave] = 'sha256:' + hash(JSON.stringify(normalizar(JSON.parse(v.v)))); continue; }
    let val: unknown = v.v;
    try { val = JSON.parse(v.v); } catch { /* string */ }
    estado[chave] = normalizar(val);
  }
  for (const [k, v] of cache.lists.entries()) estado['lista:' + k] = v;
  return { rotas: normalizar(saida), estado };
}

describe('conta legada — igual ao codigo anterior a etapa 0', () => {
  it('rotas e estado persistido batem com a fixture gerada pelo codigo antigo', async () => {
    const atual = await gerar();
    if (process.env.GOLDEN_UPDATE === '1') {
      writeFileSync(FIXTURE, JSON.stringify(atual, null, 1) + '\n');
      return;
    }
    const esperado = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(Object.keys(atual.estado)).toEqual(Object.keys(esperado.estado));
    expect(atual.rotas).toEqual(esperado.rotas);
    expect(atual.estado).toEqual(esperado.estado);
  }, 120_000);
});
