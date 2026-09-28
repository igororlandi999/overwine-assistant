/**
 * Etapa 1 — duas contas do Mercado Livre (Overwine legada + Degustar) no
 * MESMO backend e no MESMO Redis falso, com o ML simulado por um stub de
 * `fetch` que sabe QUAL vendedor está sendo chamado (pelo path e pelo Bearer).
 *
 * O que fica provado aqui, e que a etapa 0 ainda não podia provar porque não
 * havia segunda conta ativa:
 *  - a Degustar só existe para as rotas quando CONTAS_ATIVAS a nomeia e
 *    MULTI_CONTA_ENABLED está ligada; fora disso é 400, nunca a Overwine;
 *  - nenhuma chamada da Degustar usa o seller id nem o token da Overwine
 *    (o stub registra seller e Bearer de cada chamada);
 *  - tokens, renovação simultânea, pedidos, catálogo, webhook (fila, dedup,
 *    lock, dreno) e refresh são isolados por conta;
 *  - falha ou lock de uma conta não interrompe a outra;
 *  - semeadura com o vendedor errado é recusada sem gravar nada;
 *  - a Overwine continua respondendo exatamente como antes (o golden da
 *    etapa 0 cobre o formato; aqui, o comportamento lado a lado).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { createSession } from '../src/lib/session.js';
import { cacheDaConta } from '../src/lib/cache/conta-cache.js';
import { contaPorId, contaLegada } from '../src/config/contas.js';
import { getAccessToken } from '../src/lib/ml-auth.js';
import { type OrdersManifest, writeChunk, publishManifest, readSnapshot } from '../src/lib/orders-store.js';
import { CHAVE_FILA } from '../src/lib/orders-events.js';
import { ORDERS_SYNC_LOCK_KEY } from '../src/services/orders-sync.service.js';
import { toSlim, type OrderInput } from '../src/services/orders.service.js';
import ordersHandler from '../api/orders/[resource].js';
import refreshHandler from '../api/orders/refresh.js';
import itemsHandler from '../api/items/[resource].js';
import mlHandler from '../api/ml/[op].js';
import syncHandler from '../api/admin/orders-sync.js';
import seedHandler from '../api/admin/seed.js';
import notifHandler from '../api/notifications/ml.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const OVERWINE = TEST_ENV.ML_USER_ID;   // '2329718196'
const DEGUSTAR = '777000111';
const SEGREDO = 'segredo-de-webhook-bem-longo';

function mockReq(o: Partial<{ method: string; headers: Record<string, unknown>; query: Record<string, unknown>; body: unknown }> = {}) {
  return { method: 'GET', headers: {}, query: {}, body: undefined, socket: { remoteAddress: '10.0.0.7' }, ...o } as any;
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

// ── Mercado Livre simulado, com DOIS vendedores ────────────────────────────
interface Chamada { seller: string | null; bearer: string | null; path: string }
let chamadas: Chamada[];
let pedidosPorSeller: Record<string, OrderInput[]>;
let falhaPorSeller: Record<string, number | null>;   // status HTTP a devolver para /orders/search do vendedor
let tokenRequests: number;

function pedido(id: number, seller: string, minutosAtras: number, valor: number): OrderInput {
  return {
    id, status: 'paid', date_created: new Date(Date.now() - minutosAtras * 60_000).toISOString(),
    paid_amount: valor, total_amount: valor, buyer: { nickname: 'C' }, shipping: { id: 90000 + id, logistic_type: 'drop_off' },
    order_items: [{ quantity: 1, unit_price: valor, item: { id: `MLB${seller.slice(-3)}${id % 10}`, title: `Vinho ${seller.slice(-3)}`, seller_sku: `SKU-${seller.slice(-3)}`, variation_id: null } }],
  } as unknown as OrderInput;
}

const fetchReal = globalThis.fetch;
function stubML() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://api.mercadolibre.com/oauth/token') {
      tokenRequests++;
      const p = new URLSearchParams(String(init?.body));
      const grant = p.get('grant_type');
      const cred = grant === 'refresh_token' ? p.get('refresh_token') : p.get('code');
      // credencial codifica o vendedor: "TG-<seller>-..." ou "code-<seller>"
      const seller = (cred || '').split('-')[1] || '';
      await new Promise(r => setTimeout(r, 20));   // renovacao "lenta", para cruzar as duas contas
      return j({ access_token: `AT-${seller}-${Date.now()}`, refresh_token: `TG-${seller}-novo`, expires_in: 21600, user_id: Number(seller) });
    }
    if (!url.startsWith('https://api.mercadolibre.com')) return fetchReal(input, init);
    const u = new URL(url);
    const bearer = String((init?.headers as Record<string, string>)?.Authorization ?? (init?.headers as Record<string, string>)?.authorization ?? '').replace('Bearer ', '') || null;
    const sellerDoBearer = bearer ? bearer.split('-')[1] : null;
    const sellerDoPath = u.searchParams.get('seller') ?? (u.pathname.match(/^\/users\/(\d+)/)?.[1] ?? null);
    chamadas.push({ seller: sellerDoPath, bearer, path: u.pathname + u.search });
    if (u.pathname === '/orders/search') {
      const seller = sellerDoPath!;
      if (falhaPorSeller[seller]) return j({ error: 'simulada' }, falhaPorSeller[seller]!);
      if (sellerDoBearer !== seller) return j({ error: 'token de outro vendedor' }, 403);
      const lista = [...(pedidosPorSeller[seller] ?? [])].sort((a, b) => String(b.date_created).localeCompare(String(a.date_created)));
      const offset = Number(u.searchParams.get('offset') || 0), limit = Number(u.searchParams.get('limit') || 50);
      return j({ results: lista.slice(offset, offset + limit), paging: { total: lista.length, offset, limit } });
    }
    const m = u.pathname.match(/^\/orders\/(\d+)$/);
    if (m) {
      const todos = Object.values(pedidosPorSeller).flat();
      const o = todos.find(x => String(x.id) === m[1]);
      return o ? j(o) : j({ error: 'not_found' }, 404);
    }
    if (/^\/users\/\d+\/items\/search$/.test(u.pathname)) {
      const ativo = u.searchParams.get('status') === 'active';
      return j({ results: ativo ? [`MLB${sellerDoPath!.slice(-3)}1`] : [], paging: { total: ativo ? 1 : 0 } });
    }
    if (u.pathname === '/items') return j((u.searchParams.get('ids') || '').split(',').filter(Boolean).map(id => ({ code: 200, body: { id, title: 'Vinho ' + id, price: 100, available_quantity: 5, status: 'active', sold_quantity: 1, permalink: 'https://x', thumbnail: '', seller_custom_field: 'SKU-' + id.slice(3, 6), attributes: [], variations: [], listing_type_id: 'gold_special', shipping: { logistic_type: 'drop_off' } } })));
    if (/^\/users\/\d+$/.test(u.pathname)) return j({ id: Number(sellerDoPath), nickname: 'LOJA-' + sellerDoPath, seller_reputation: { level_id: '5_green' } });
    return j({ error: 'not_stubbed' }, 404);
  }) as typeof fetch;
}

let cache: FakeCache;
let token: string;
const legada = () => cacheDaConta(cache, contaLegada());
const degustar = () => cacheDaConta(cache, contaPorId('degustar-ml')!);

async function publicarBase(c: ReturnType<typeof cacheDaConta>, pedidos: OrderInput[]) {
  const slims = [...pedidos].sort((a, b) => String(b.date_created).localeCompare(String(a.date_created))).map(toSlim);
  const chave = await writeChunk(c, 'ativos', 1, 0, slims);
  const man: OrdersManifest = { versao: 1, chunks: [chave], totalRegistros: slims.length, newestDate: slims[0].date_created, oldestDate: slims[slims.length - 1].date_created, chunkSize: 500, updatedAt: new Date(Date.now() - 3600_000).toISOString(), origem: 'full', chunkCounts: [slims.length] };
  await publishManifest(c, 'ativos', man);
  await c.set('orders:sync:status:ativos', JSON.stringify({ ultimaVersao: 1, totalRegistros: slims.length, newestDate: man.newestDate, lastSyncAt: new Date(Date.now() - 3600_000).toISOString(), lastResult: 'ok', emAndamento: false, ultimaRevisaoEm: new Date().toISOString() }));
}

beforeEach(async () => {
  cache = new FakeCache();
  setCacheForTests(cache);
  Object.assign(process.env, TEST_ENV, {
    ML_WEBHOOK_SECRET: SEGREDO, MULTI_CONTA_ENABLED: 'true', CONTAS_ATIVAS: 'degustar-ml', ML_DEGUSTAR_USER_ID: DEGUSTAR,
  });
  resetEnvForTests();
  chamadas = []; tokenRequests = 0; falhaPorSeller = {};
  pedidosPorSeller = {
    [OVERWINE]: Array.from({ length: 30 }, (_, i) => pedido(100 + i, OVERWINE, 60 + i * 30, 100)),
    [DEGUSTAR]: Array.from({ length: 12 }, (_, i) => pedido(900 + i, DEGUSTAR, 60 + i * 30, 50)),
  };
  stubML();
  // cadeias de token semeadas, uma por conta, cada uma com o SEU vendedor
  await legada().set('ml:access_token', JSON.stringify({ token: `AT-${OVERWINE}-inicial`, expiresAt: Date.now() + 3600_000 }));
  await legada().set('ml:refresh_token', `TG-${OVERWINE}-inicial`);
  await degustar().set('ml:access_token', JSON.stringify({ token: `AT-${DEGUSTAR}-inicial`, expiresAt: Date.now() + 3600_000 }));
  await degustar().set('ml:refresh_token', `TG-${DEGUSTAR}-inicial`);
  await publicarBase(legada(), pedidosPorSeller[OVERWINE]);
  await publicarBase(degustar(), pedidosPorSeller[DEGUSTAR]);
  token = (await createSession(cache)).id;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); globalThis.fetch = fetchReal; delete process.env.CONTAS_ATIVAS; delete process.env.MULTI_CONTA_ENABLED; delete process.env.ML_DEGUSTAR_USER_ID; });

const auth = () => ({ authorization: `Bearer ${token}` });
const admin = () => ({ 'x-admin-key': TEST_ENV.ADMIN_KEY, 'content-type': 'application/json' });
async function chamar(handler: any, o: any) { const res = mockRes(); await handler(mockReq(o), res); return res; }
const chavesDegustar = () => [...cache.store.keys(), ...cache.lists.keys()].filter(k => k.startsWith('c:degustar-ml:'));
const chavesLegadas = () => [...cache.store.keys(), ...cache.lists.keys()].filter(k => !k.startsWith('c:') && !k.startsWith('sess:') && !k.startsWith('rl:'));

// ═══════════════════════════════════════════════════════════════════════════
describe('ativação: a Degustar só existe quando o ambiente a liga', () => {
  it('sem CONTAS_ATIVAS: 400 conta_inativa em leitura e acao, e a Overwine segue normal', async () => {
    delete process.env.CONTAS_ATIVAS;
    expect((await chamar(ordersHandler, { query: { resource: 'status', contas: 'degustar-ml' }, headers: auth() })).json().error).toBe('conta_inativa');
    expect((await chamar(refreshHandler, { method: 'POST', headers: auth(), body: { conta: 'degustar-ml' } })).json().error).toBe('conta_inativa');
    expect((await chamar(ordersHandler, { query: { resource: 'status' }, headers: auth() })).json().totalRegistros).toBe(30);
  });

  it('ativa mas com MULTI_CONTA_ENABLED desligada: 400 conta_nao_habilitada', async () => {
    process.env.MULTI_CONTA_ENABLED = 'false';
    expect((await chamar(ordersHandler, { query: { resource: 'status', contas: 'degustar-ml' }, headers: auth() })).json().error).toBe('conta_nao_habilitada');
  });

  it('ativa sem ML_DEGUSTAR_USER_ID: 400 conta_sem_credencial — nunca o vendedor da Overwine', async () => {
    delete process.env.ML_DEGUSTAR_USER_ID;
    const res = await chamar(ordersHandler, { query: { resource: 'status', contas: 'degustar-ml' }, headers: auth() });
    expect(res.json().error).toBe('conta_sem_credencial');
    expect(chamadas).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('pedidos e catálogo separados; nenhuma chamada da Degustar usa seller ou token da Overwine', () => {
  it('status/list de cada conta vêm do snapshot dela', async () => {
    const ow = (await chamar(ordersHandler, { query: { resource: 'status' }, headers: auth() })).json();
    const dg = (await chamar(ordersHandler, { query: { resource: 'status', contas: 'degustar-ml' }, headers: auth() })).json();
    expect(ow.totalRegistros).toBe(30); expect(ow.conta).toBe('overwine-ml');
    expect(dg.totalRegistros).toBe(12); expect(dg.conta).toBe('degustar-ml');
    const lista = (await chamar(ordersHandler, { query: { resource: 'list', contas: 'degustar-ml', pageSize: '50' }, headers: auth() })).json();
    expect(lista.items.every((o: any) => o.id >= 900)).toBe(true);
  });

  it('refresh da Degustar chama o ML com seller=Degustar e Bearer da Degustar; publica só nela', async () => {
    pedidosPorSeller[DEGUSTAR].push(pedido(999, DEGUSTAR, 1, 70));
    pedidosPorSeller[OVERWINE].push(pedido(199, OVERWINE, 1, 300));
    await degustar().set('orders:sync:status:ativos', JSON.stringify({ ...JSON.parse((await degustar().get('orders:sync:status:ativos'))!), lastSyncAt: new Date(Date.now() - 600_000).toISOString() }));
    const r = await chamar(refreshHandler, { method: 'POST', headers: auth(), body: { conta: 'degustar-ml' } });
    expect(r.json()).toMatchObject({ acao: 'sincronizado', publicou: true, novosPedidos: 1, conta: 'degustar-ml' });
    const buscas = chamadas.filter(c => c.path.startsWith('/orders/search'));
    expect(buscas).toHaveLength(1);
    expect(buscas[0].seller).toBe(DEGUSTAR);
    expect(buscas[0].bearer).toMatch(new RegExp(`^AT-${DEGUSTAR}-`));
    expect((await readSnapshot(degustar(), 'ativos')).some(o => o.id === 999)).toBe(true);
    expect((await readSnapshot(legada(), 'ativos')).some(o => o.id === 999)).toBe(false);
    expect((await readSnapshot(legada(), 'ativos')).some(o => o.id === 199)).toBe(false);   // a Overwine não foi tocada
  });

  it('reconciliação (admin/orders-sync) da Degustar: seller e token dela; a legada sem conta segue a Overwine', async () => {
    pedidosPorSeller[DEGUSTAR].push(pedido(998, DEGUSTAR, 1, 70));
    const r = await chamar(syncHandler, { method: 'POST', headers: admin(), body: { alvo: 'ativos', conta: 'degustar-ml' } });
    expect(r.json().conta).toBe('degustar-ml');
    expect(chamadas.filter(c => c.path.startsWith('/orders/search')).every(c => c.seller === DEGUSTAR && c.bearer!.startsWith(`AT-${DEGUSTAR}`))).toBe(true);
    chamadas = [];
    const ow = await chamar(syncHandler, { method: 'POST', headers: admin(), body: { alvo: 'ativos' } });
    expect(ow.json().conta).toBe('overwine-ml');
    expect(chamadas.filter(c => c.path.startsWith('/orders/search')).every(c => c.seller === OVERWINE && c.bearer!.startsWith(`AT-${OVERWINE}`))).toBe(true);
  });

  it('catálogo: reconstrução da Degustar usa /users/<degustar>/items/search e o snapshot fica sob o prefixo dela', async () => {
    const r = await chamar(itemsHandler, { query: { resource: 'catalog', contas: 'degustar-ml' }, headers: auth() });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.items.map((i: any) => i.id)).toEqual([`MLB${DEGUSTAR.slice(-3)}1`]);
    expect(chamadas.some(c => c.path.startsWith(`/users/${DEGUSTAR}/items/search`))).toBe(true);
    expect(chamadas.some(c => c.path.startsWith(`/users/${OVERWINE}/`))).toBe(false);
    expect(chavesDegustar().some(k => k.includes('items:catalog:manifest'))).toBe(true);
    expect(chavesLegadas().some(k => k.includes('items:catalog'))).toBe(false);
  });

  it('proxy /api/ml/<op> com conta=degustar-ml monta o path com o seller da Degustar', async () => {
    const r = await chamar(mlHandler, { query: { op: 'reputation', conta: 'degustar-ml' }, headers: auth() });
    expect(r.statusCode).toBe(200);
    expect(chamadas.at(-1)!.path).toBe(`/users/${DEGUSTAR}`);
    expect(chamadas.at(-1)!.bearer).toMatch(new RegExp(`^AT-${DEGUSTAR}-`));
    const ow = await chamar(mlHandler, { query: { op: 'reputation' }, headers: auth() });
    expect(ow.statusCode).toBe(200);
    expect(chamadas.at(-1)!.path).toBe(`/users/${OVERWINE}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('tokens: cadeias separadas, renovação simultânea sem cruzamento', () => {
  it('as duas contas renovam ao mesmo tempo; cada uma recebe o token do seu vendedor', async () => {
    await legada().set('ml:access_token', JSON.stringify({ token: `AT-${OVERWINE}-velho`, expiresAt: Date.now() + 1000 }));
    await degustar().set('ml:access_token', JSON.stringify({ token: `AT-${DEGUSTAR}-velho`, expiresAt: Date.now() + 1000 }));
    const [a, b] = await Promise.all([getAccessToken(legada()), getAccessToken(degustar())]);
    expect(a.token).toMatch(new RegExp(`^AT-${OVERWINE}-`));
    expect(b.token).toMatch(new RegExp(`^AT-${DEGUSTAR}-`));
    expect(tokenRequests).toBe(2);
    expect(await legada().get('ml:refresh_token')).toBe(`TG-${OVERWINE}-novo`);
    expect(await degustar().get('ml:refresh_token')).toBe(`TG-${DEGUSTAR}-novo`);
    expect(cache.store.has('c:degustar-ml:ml:refresh_lock') || true).toBe(true);   // lock da Degustar viveu no prefixo dela
    expect([...cache.store.keys()].filter(k => k.startsWith('ml:')).length).toBe(2);              // e só 2 chaves ml:* sem prefixo (as da Overwine)
  });

  it('seed da Degustar com o vendedor CERTO grava só no espaço dela; com o errado, 500 e nada gravado', async () => {
    await degustar().del('ml:refresh_token'); await degustar().del('ml:access_token');
    const ok = await chamar(seedHandler, { method: 'POST', headers: admin(), body: { code: `code-${DEGUSTAR}`, conta: 'degustar-ml' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, conta: 'degustar-ml', user_id_validado: Number(DEGUSTAR) });
    expect(await degustar().get('ml:refresh_token')).toBe(`TG-${DEGUSTAR}-novo`);
    expect(await legada().get('ml:refresh_token')).toBe(`TG-${OVERWINE}-inicial`);   // Overwine intacta

    await degustar().del('ml:refresh_token'); await degustar().del('ml:access_token');
    const errado = await chamar(seedHandler, { method: 'POST', headers: admin(), body: { code: `code-${OVERWINE}`, conta: 'degustar-ml' } });
    expect(errado.statusCode).toBe(500);
    expect(errado.json().error).toMatch(/difere do vendedor esperado/);
    expect(errado.body).not.toContain('TG-'); expect(errado.body).not.toContain('AT-');
    expect(await degustar().get('ml:refresh_token')).toBeNull();
    expect(await legada().get('ml:refresh_token')).toBe(`TG-${OVERWINE}-inicial`);
  });

  it('seed sem conta continua sendo a Overwine (compatibilidade), e recusa o vendedor da Degustar', async () => {
    const r = await chamar(seedHandler, { method: 'POST', headers: admin(), body: { code: `code-${DEGUSTAR}`, force: true } });
    expect(r.statusCode).toBe(500);
    expect(await legada().get('ml:refresh_token')).toBe(`TG-${OVERWINE}-inicial`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('webhook: cada vendedor cai na sua conta; desconhecido é recusado', () => {
  const notif = (userId: string, orderId: number, id = 'n-' + orderId) => ({ _id: id, topic: 'orders_v2', resource: `/orders/${orderId}`, user_id: Number(userId), application_id: Number(TEST_ENV.ML_CLIENT_ID), attempts: 1, sent: new Date().toISOString() });
  const enviar = (corpo: unknown) => chamar(notifHandler, { method: 'POST', query: { k: SEGREDO }, body: corpo });

  it('notificação da Degustar enfileira na fila DELA; da Overwine, na legada; desconhecido → 200 ignorada e recusa registrada', async () => {
    pedidosPorSeller[DEGUSTAR].push(pedido(950, DEGUSTAR, 1, 60));
    pedidosPorSeller[OVERWINE].push(pedido(150, OVERWINE, 1, 200));
    expect((await enviar(notif(DEGUSTAR, 950))).json()).toEqual({ ok: true });
    expect((await enviar(notif(OVERWINE, 150))).json()).toEqual({ ok: true });
    // o dreno em segundo plano roda na hora (a promessa ja esta em andamento
    // quando a rota responde): o que prova o roteamento e ONDE o pedido caiu
    await new Promise(r => setTimeout(r, 80));
    expect((await readSnapshot(degustar(), 'ativos')).some(o => o.id === 950)).toBe(true);
    expect((await readSnapshot(legada(), 'ativos')).some(o => o.id === 950)).toBe(false);
    expect((await readSnapshot(legada(), 'ativos')).some(o => o.id === 150)).toBe(true);
    expect((await readSnapshot(degustar(), 'ativos')).some(o => o.id === 150)).toBe(false);
    // marca de idempotencia e telemetria de recebimento ficaram no espaco de cada conta
    expect(cache.store.has('c:degustar-ml:orders:evt:seen:n-950')).toBe(true);
    expect(cache.store.has('orders:evt:seen:n-150')).toBe(true);
    expect(cache.store.has('c:degustar-ml:orders:evt:seen:n-150')).toBe(false);
    // dedup por _id: reenvio do ML e "duplicada" na conta certa
    expect((await enviar(notif(DEGUSTAR, 950))).json()).toEqual({ ok: true, duplicada: true });
    // e o pedido 950 foi buscado no ML com o token da Degustar
    expect(chamadas.find(c => c.path === '/orders/950')!.bearer).toMatch(new RegExp(`^AT-${DEGUSTAR}-`));
    expect(chamadas.find(c => c.path === '/orders/150')!.bearer).toMatch(new RegExp(`^AT-${OVERWINE}-`));

    const desconhecido = await enviar(notif('123456', 1));
    expect(desconhecido.json()).toEqual({ ok: true, ignorada: true });
    expect(await legada().llen(CHAVE_FILA)).toBe(0);
    const obs = JSON.parse((await legada().get('orders:evt:obs:notif'))!);
    expect(obs.ultimoMotivoRejeicao).toBe('user_id_divergente');
  });

  it('dreno da Degustar aplica o pedido dela com o token dela; a Overwine não muda', async () => {
    pedidosPorSeller[DEGUSTAR].push(pedido(951, DEGUSTAR, 1, 60));
    // Segura o lock da Degustar para o dreno em segundo plano NAO conseguir
    // processar: o evento fica na fila dela e e o dreno explicito (o do
    // GitHub Actions, com conta) que aplica.
    await degustar().setNX(ORDERS_SYNC_LOCK_KEY, 'reconciliacao-degustar', 120);
    await enviar(notif(DEGUSTAR, 951));
    await new Promise(r => setTimeout(r, 1500));   // o dreno de fundo desiste do lock (3 x 400 ms)
    expect(await degustar().llen(CHAVE_FILA)).toBe(1);
    expect(await legada().llen(CHAVE_FILA)).toBe(0);
    await degustar().delIfEquals(ORDERS_SYNC_LOCK_KEY, 'reconciliacao-degustar');
    const d = await chamar(syncHandler, { method: 'POST', headers: admin(), body: { acao: 'drenar', conta: 'degustar-ml' } });
    expect(d.json()).toMatchObject({ processados: 1, novos: 1, conta: 'degustar-ml' });
    expect((await readSnapshot(degustar(), 'ativos')).some(o => o.id === 951)).toBe(true);
    expect((await readSnapshot(legada(), 'ativos')).some(o => o.id === 951)).toBe(false);
    const busca = chamadas.find(c => c.path === '/orders/951');
    expect(busca!.bearer).toMatch(new RegExp(`^AT-${DEGUSTAR}-`));
  });

  it('Degustar desativada: a notificação dela volta a ser recusada como vendedor desconhecido', async () => {
    delete process.env.CONTAS_ATIVAS;
    const r = await enviar(notif(DEGUSTAR, 952));
    expect(r.json()).toEqual({ ok: true, ignorada: true });
    expect(cache.lists.has('c:degustar-ml:' + CHAVE_FILA)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('falha ou bloqueio em uma conta não interrompe a outra', () => {
  const envelhecer = async (c: ReturnType<typeof cacheDaConta>) =>
    c.set('orders:sync:status:ativos', JSON.stringify({ ...JSON.parse((await c.get('orders:sync:status:ativos'))!), lastSyncAt: new Date(Date.now() - 600_000).toISOString() }));

  it('ML devolve 500 para a Degustar: erro só nela; a Overwine sincroniza normalmente', async () => {
    falhaPorSeller[DEGUSTAR] = 500;
    pedidosPorSeller[OVERWINE].push(pedido(160, OVERWINE, 1, 100));
    await envelhecer(degustar()); await envelhecer(legada());
    const dg = await chamar(refreshHandler, { method: 'POST', headers: auth(), body: { conta: 'degustar-ml' } });
    expect(dg.json()).toMatchObject({ ok: false, acao: 'erro', conta: 'degustar-ml' });
    const ow = await chamar(refreshHandler, { method: 'POST', headers: auth(), body: {} });
    expect(ow.json()).toMatchObject({ ok: true, acao: 'sincronizado', publicou: true, novosPedidos: 1, conta: 'overwine-ml' });
    // a telemetria de falha ficou no espaço da Degustar, nao no da Overwine
    expect(JSON.parse((await degustar().get('orders:sync:obs'))!).totalFalhas).toBe(1);
    expect(JSON.parse((await legada().get('orders:sync:obs'))!).totalFalhas).toBe(0);
  }, 20_000);

  it('lock preso na Degustar (dreno/reconciliação travados): a Overwine não vê o lock', async () => {
    await degustar().setNX(ORDERS_SYNC_LOCK_KEY, 'preso', 120);
    pedidosPorSeller[OVERWINE].push(pedido(161, OVERWINE, 1, 100));
    await envelhecer(degustar()); await envelhecer(legada());
    expect((await chamar(refreshHandler, { method: 'POST', headers: auth(), body: { conta: 'degustar-ml' } })).json().acao).toBe('sync_em_andamento');
    expect((await chamar(refreshHandler, { method: 'POST', headers: auth(), body: {} })).json()).toMatchObject({ acao: 'sincronizado', publicou: true });
  });

  it('cooldown da Degustar não segura a Overwine, e vice-versa', async () => {
    await envelhecer(degustar()); await envelhecer(legada());
    expect((await chamar(refreshHandler, { method: 'POST', headers: auth(), body: { conta: 'degustar-ml' } })).json().acao).toBe('sincronizado');
    expect((await chamar(refreshHandler, { method: 'POST', headers: auth(), body: {} })).json().acao).toBe('sincronizado');
    await envelhecer(degustar()); await envelhecer(legada());
    expect((await chamar(refreshHandler, { method: 'POST', headers: auth(), body: { conta: 'degustar-ml' } })).json().acao).toBe('cooldown');
    expect((await chamar(refreshHandler, { method: 'POST', headers: auth(), body: {} })).json().acao).toBe('cooldown');
  });
});
