/**
 * Ambiente do roteiro de navegador: dashboard REAL + handlers REAIS do backend
 * + Mercado Livre SIMULADO com dois vendedores.
 *
 * Nada aqui fala com produção. O "Mercado Livre" é uma função que substitui
 * `fetch` para `api.mercadolibre.com`; o Redis é o FakeCache dos testes. Todos
 * os pedidos, compradores, valores, tarifas e fretes são INVENTADOS.
 *
 * Usado por `contas.e2e.ts` (o roteiro automatizado) e por `previa.ts` (o
 * servidor para revisão visual).
 */
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeCache, TEST_ENV } from '../tests/fake-cache.js';
import { setCacheForTests, type Cache } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { contaPorId } from '../src/config/contas.js';
import { cacheDaConta } from '../src/lib/cache/conta-cache.js';
import { type OrdersManifest, writeChunk, publishManifest } from '../src/lib/orders-store.js';
import { publicarMapaEnvios, type EnvioInfo } from '../src/lib/shipping-store.js';
import { toSlim, type OrderInput } from '../src/services/orders.service.js';
import authHandler from '../api/auth/[action].js';
import ordersHandler from '../api/orders/[resource].js';
import refreshHandler from '../api/orders/refresh.js';
import itemsHandler from '../api/items/[resource].js';
import mlHandler from '../api/ml/[op].js';
import chatHandler from '../api/chat.js';

const AQUI = dirname(fileURLToPath(import.meta.url));

export const OW = 'overwine-ml';
export const DG = 'degustar-ml';
export const UID_OW = TEST_ENV.ML_USER_ID;
export const UID_DG = '3642371174';
export const TOK_OW = 'APP_USR-simulado-overwine';
export const TOK_DG = 'APP_USR-simulado-degustar';
export const SENHA = TEST_ENV.DASHBOARD_PASSWORD;
/** O MESMO SKU e o MESMO título nas duas empresas — é o caso real, e o mais perigoso. */
export const SKU = '21003';
export const TITULO = 'Vinho Tinto Portugues Arcos Do Convento Bag In Box 5 Lts';

/** Onde está o index.html do dashboard. `DASHBOARD_HTML` vence; senão, o repositório irmão. */
export function caminhoDoDashboard(): string {
  const candidatos = [
    process.env.DASHBOARD_HTML,
    resolve(AQUI, '../../wt-seletores-frontend/index.html'),
    resolve(AQUI, '../../ml-dashboard-overwine/index.html'),
  ].filter((c): c is string => typeof c === 'string' && c !== '');
  const achado = candidatos.find(c => existsSync(c));
  if (!achado) throw new Error('index.html do dashboard nao encontrado. Defina DASHBOARD_HTML. Tentados: ' + candidatos.join(' | '));
  return achado;
}

// ── Lojas simuladas ─────────────────────────────────────────────────────────
export interface Loja {
  conta: string; uid: string; item: string; preco: number; saldo: number; vendidos: number;
  pedidos: OrderInput[]; cancelados: OrderInput[]; visitasDia: number; nivel: string; apelido: string;
  /** Custo real de frete por envio. Ausente = envio ainda não resolvido. */
  fretes: Map<string, number>;
}

export interface OpcoesPedido { status?: string; tarifa?: number | null }

export function pedidoML(id: number, horasAtras: number, valor: number, item: string, comprador: string, o: OpcoesPedido = {}): OrderInput {
  const status = o.status ?? 'paid';
  const oi: Record<string, unknown> = {
    quantity: 1, unit_price: valor,
    item: { id: item, title: TITULO, seller_sku: SKU, variation_id: null },
  };
  if (typeof o.tarifa === 'number') oi.sale_fee = o.tarifa;
  return {
    id, status,
    date_created: new Date(Date.now() - horasAtras * 3600_000).toISOString(),
    paid_amount: status === 'paid' ? valor : 0, total_amount: valor,
    buyer: { nickname: comprador },
    shipping: { id: 900000 + id, logistic_type: 'fulfillment' },
    cancel_detail: status === 'cancelled' ? { group: 'buyer', code: 'buyer_regret', description: 'arrependimento' } : undefined,
    order_items: [oi],
  } as unknown as OrderInput;
}

/** Tarifa e frete simulados da Degustar: valores fixos, fáceis de conferir à mão. */
export const DG_TARIFA = 12;
export const DG_FRETE = 9.5;
/** Pedidos da Degustar mais novos que isto têm tarifa e frete; os mais antigos, não (carga anterior ao campo). */
export const DG_COBERTOS = 12;

export function criarLojas(): Record<string, Loja> {
  const ow: Loja = { conta: OW, uid: UID_OW, item: 'MLB1000001', preco: 300, saldo: 40, vendidos: 900, pedidos: [], cancelados: [], visitasDia: 200, nivel: '5_green', apelido: 'OVERWINE-SIMULADA', fretes: new Map() };
  const dg: Loja = { conta: DG, uid: UID_DG, item: 'MLB2000001', preco: 100, saldo: 8, vendidos: 60, pedidos: [], cancelados: [], visitasDia: 30, nivel: '4_light_green', apelido: 'DEGUSTAR-SIMULADA', fretes: new Map() };
  // Overwine: 120 pedidos de R$ 300, um a cada 8 h. Degustar: 21 de R$ 100, um a cada 36 h.
  for (let i = 0; i < 120; i++) ow.pedidos.push(pedidoML(100000 + i, 3 + i * 8, 300, ow.item, 'COMPRADOR_SIMULADO_OW', { tarifa: 40 }));
  for (let i = 0; i < 21; i++) {
    const coberto = i < DG_COBERTOS;
    const p = pedidoML(200000 + i, 5 + i * 36, 100, dg.item, 'COMPRADOR_SIMULADO_DG', { tarifa: coberto ? DG_TARIFA : null });
    dg.pedidos.push(p);
    if (coberto) dg.fretes.set(String(900000 + 200000 + i), DG_FRETE);
  }
  for (let i = 0; i < 4; i++) ow.cancelados.push(pedidoML(150000 + i, 10 + i * 50, 300, ow.item, 'COMPRADOR_SIMULADO_OW', { status: 'cancelled' }));
  for (let i = 0; i < 2; i++) dg.cancelados.push(pedidoML(250000 + i, 20 + i * 70, 100, dg.item, 'COMPRADOR_SIMULADO_DG', { status: 'cancelled' }));
  return { [TOK_OW]: ow, [TOK_DG]: dg };
}

export const ehOW = (id: number | string) => Number(id) >= 100000 && Number(id) < 200000;
export const ehDG = (id: number | string) => Number(id) >= 200000 && Number(id) < 300000;

// ── Registros ───────────────────────────────────────────────────────────────
export interface RegistroML { t: number; loja: string; path: string }
export interface RegistroHttp { t: number; method: string; path: string; query: string; status: number; req?: string; res?: string }

export interface Ambiente {
  origem: string;
  lojas: Record<string, Loja>;
  cache: FakeCache;
  cacheDG: Cache;
  mlLog: RegistroML[];
  httpLog: RegistroHttp[];
  fetchReal: typeof fetch;
  encerrar(): Promise<void>;
}

/**
 * O vendedor é reconhecido pelo TOKEN. Uma consulta que nomeie um vendedor
 * diferente do dono do token é recusada (403): é a prova de que o backend
 * nunca consulta uma loja com a credencial da outra.
 */
function instalarMercadoLivreSimulado(lojas: Record<string, Loja>, mlLog: RegistroML[], fetchReal: typeof fetch) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('https://api.mercadolibre.com')) return fetchReal(input, init);
    const u = new URL(url);
    const h = new Headers((init && init.headers) || (typeof input !== 'string' ? input.headers : undefined));
    const tok = (h.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const j0 = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    // Renovacao de token: o backend a pede quando o access token vence. Sem isto
    // a previa parava de responder depois de uma hora no ar.
    if (u.pathname === '/oauth/token') {
      const corpo = String((init && init.body) || '');
      const par = Object.entries(lojas).find(([, l]) => corpo.includes('TG-simulado-' + l.conta));
      mlLog.push({ t: Date.now(), loja: par ? par[1].conta : 'SEM_TOKEN', path: u.pathname });
      if (!par) return j0({ message: 'invalid_grant' }, 400);
      return j0({ access_token: par[0], refresh_token: 'TG-simulado-' + par[1].conta, user_id: Number(par[1].uid), expires_in: 21600, token_type: 'Bearer' });
    }
    const loja = lojas[tok];
    mlLog.push({ t: Date.now(), loja: loja ? loja.conta : 'SEM_TOKEN', path: u.pathname + u.search });
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (!loja) return j({ message: 'invalid token' }, 401);
    const p = u.pathname;
    const todos = () => [...loja.pedidos, ...loja.cancelados];
    let m: RegExpMatchArray | null;

    if (p === '/orders/search') {
      const seller = u.searchParams.get('seller');
      if (seller && seller !== loja.uid) return j({ message: 'seller/token mismatch' }, 403);
      const offset = Number(u.searchParams.get('offset') || 0);
      const limit = Number(u.searchParams.get('limit') || 50);
      const cancelados = u.searchParams.get('order.status') === 'cancelled' || u.searchParams.get('status') === 'cancelled';
      // Simplificação: a busca sem filtro devolve só os pagos, para o total do snapshot ser conferível.
      const de = u.searchParams.get('order.date_created.from'), ate = u.searchParams.get('order.date_created.to');
      const base = (cancelados ? loja.cancelados : loja.pedidos).filter(o => {
        const t = new Date(String(o.date_created)).getTime();
        return (!de || t >= new Date(de).getTime()) && (!ate || t <= new Date(ate).getTime());
      });
      const sorted = [...base].sort((a, b) => String(b.date_created).localeCompare(String(a.date_created)));
      return j({ results: sorted.slice(offset, offset + limit), paging: { total: sorted.length, offset, limit } });
    }
    if ((m = p.match(/^\/users\/(\d+)\/items\/search$/))) {
      if (m[1] !== loja.uid) return j({ message: 'user/token mismatch' }, 403);
      const ativo = u.searchParams.get('status') === 'active';
      return j({ results: ativo ? [loja.item] : [], paging: { total: ativo ? 1 : 0 } });
    }
    if (p === '/items') {
      return j((u.searchParams.get('ids') || '').split(',').filter(Boolean).map(id => (id === loja.item
        ? { code: 200, body: { id, title: TITULO, price: loja.preco, available_quantity: loja.saldo, status: 'active', sold_quantity: loja.vendidos, permalink: 'https://exemplo.invalid/' + id, thumbnail: '', seller_custom_field: SKU, attributes: [], variations: [], listing_type_id: 'gold_special', shipping: { logistic_type: 'fulfillment' }, tags: [] } }
        : { code: 403, body: { message: 'forbidden' } })));
    }
    if ((m = p.match(/^\/users\/(\d+)\/items_visits\/time_window$/))) {
      if (m[1] !== loja.uid) return j({ message: 'user/token mismatch' }, 403);
      const last = Number(u.searchParams.get('last') || 30);
      const results = Array.from({ length: last }, (_, i) => ({ date: new Date(Date.now() - i * 86400_000).toISOString(), total: loja.visitasDia }));
      return j({ total_visits: last * loja.visitasDia, results });
    }
    if ((m = p.match(/^\/users\/(\d+)$/))) {
      if (m[1] !== loja.uid) return j({ message: 'user/token mismatch' }, 403);
      return j({ id: Number(loja.uid), nickname: loja.apelido, seller_reputation: { level_id: loja.nivel, power_seller_status: null, transactions: { total: loja.pedidos.length, completed: loja.pedidos.length, canceled: 0 }, metrics: { claims: { rate: 0 }, delayed_handling_time: { rate: 0 }, cancellations: { rate: 0 } } } });
    }
    if ((m = p.match(/^\/orders\/(\d+)$/))) {
      const o = todos().find(x => String(x.id) === m![1]);
      return o ? j({ ...o, payments: [], pack_id: null }) : j({ message: 'order not found for this seller' }, 404);
    }
    if (p.match(/^\/orders\/(\d+)\/discounts$/)) return j({ details: [] });
    if ((m = p.match(/^\/shipments\/(\d+)\/costs$/))) {
      const custo = loja.fretes.get(m[1]);
      return custo === undefined ? j({ message: 'costs not available' }, 404) : j({ senders: [{ cost: custo }], receiver: { cost: 0 } });
    }
    if ((m = p.match(/^\/shipments\/(\d+)$/))) {
      const o = todos().find(x => String((x as any).shipping?.id) === m![1]);
      return o ? j({ id: Number(m[1]), status: 'delivered', substatus: '', logistic_type: 'fulfillment', mode: 'me2', shipping_option: { cost: 0, list_cost: 20 }, status_history: {} })
        : j({ message: 'shipment not found for this seller' }, 404);
    }
    if (p === '/advertising/advertisers') return j({ advertisers: [] });   // loja sem Product Ads
    return j({ error: 'not_stubbed' }, 404);
  }) as typeof fetch;
}

async function semear(c: Cache, loja: Loja, tok: string, versao: number) {
  await c.set('ml:access_token', JSON.stringify({ token: tok, expiresAt: Date.now() + 6 * 3600_000 }));
  await c.set('ml:refresh_token', 'TG-simulado-' + loja.conta);
  const slims = [...loja.pedidos].sort((a, b) => String(b.date_created).localeCompare(String(a.date_created))).map(toSlim);
  const chaves: string[] = []; const counts: number[] = [];
  for (let i = 0; i < slims.length; i += 500) { const f = slims.slice(i, i + 500); chaves.push(await writeChunk(c, 'ativos', versao, chaves.length, f)); counts.push(f.length); }
  const velho = new Date(Date.now() - 3600_000).toISOString();
  const man: OrdersManifest = { versao, chunks: chaves, totalRegistros: slims.length, newestDate: slims[0].date_created, oldestDate: slims[slims.length - 1].date_created, chunkSize: 500, updatedAt: velho, origem: 'full', chunkCounts: counts };
  await publishManifest(c, 'ativos', man);
  await c.set('orders:sync:status:ativos', JSON.stringify({ ultimaVersao: versao, totalRegistros: slims.length, newestDate: man.newestDate, lastSyncAt: velho, lastResult: 'ok', emAndamento: false, ultimaRevisaoEm: new Date(Date.now() - 60_000).toISOString() }));
  if (loja.fretes.size) {
    const mapa = new Map<string, EnvioInfo>();
    for (const [id, custo] of loja.fretes) mapa.set(id, { logisticType: 'fulfillment', custoFrete: custo });
    await publicarMapaEnvios(c, mapa);
  }
}

const FAIXA = `<div id="faixa-simulado" style="position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#7a1f1f;color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:8px 16px;text-align:center;letter-spacing:.03em;border-top:2px solid #ffd27a">DADOS SIMULADOS &mdash; pr&eacute;via local. Pedidos, compradores, valores, tarifas e fretes s&atilde;o inventados. Nada aqui vem da Overwine nem da Degustar.</div>`;

export interface OpcoesAmbiente { porta: number; faixa?: boolean; silencioso?: boolean }

export async function iniciarAmbiente(op: OpcoesAmbiente): Promise<Ambiente> {
  const origem = `http://127.0.0.1:${op.porta}`;
  const cache = new FakeCache();
  setCacheForTests(cache);
  Object.assign(process.env, TEST_ENV, {
    ALLOWED_ORIGIN: origem, ML_WEBHOOK_SECRET: 'segredo-simulado-de-webhook-bem-longo',
    MULTI_CONTA_ENABLED: 'true', CONTAS_ATIVAS: DG, ML_DEGUSTAR_USER_ID: UID_DG,
  });
  resetEnvForTests();
  if (op.silencioso) { console.info = () => {}; }

  const lojas = criarLojas();
  const mlLog: RegistroML[] = [];
  const httpLog: RegistroHttp[] = [];
  const fetchReal = globalThis.fetch;
  instalarMercadoLivreSimulado(lojas, mlLog, fetchReal);

  const cacheDG = cacheDaConta(cache, contaPorId(DG)!);
  await semear(cache, lojas[TOK_OW], TOK_OW, 7);
  await semear(cacheDG, lojas[TOK_DG], TOK_DG, 3);

  let html = readFileSync(caminhoDoDashboard(), 'utf8');
  const alvo = "const BACKEND_URL = 'https://overwine-assistant.vercel.app';";
  if (!html.includes(alvo)) throw new Error('BACKEND_URL nao encontrado no index.html: o dashboard mudou e o ambiente precisa acompanhar.');
  // Mesma origem da pagina: funciona em 127.0.0.1 e em localhost, sem CORS.
  html = html.replace(alvo, `const BACKEND_URL = '';`);
  if (op.faixa) html = html.replace('</body>', FAIXA + '</body>');

  function adaptar(req: http.IncomingMessage, res: http.ServerResponse, rawBody: string, params: Record<string, string>) {
    const u = new URL(req.url || '/', origem);
    const query: Record<string, string> = { ...params };
    u.searchParams.forEach((v, k) => { query[k] = v; });
    let body: unknown = undefined;
    if (rawBody) { try { body = JSON.parse(rawBody); } catch { body = rawBody; } }
    const vreq: any = { method: req.method, headers: req.headers, query, body, url: req.url, socket: req.socket };
    let statusCode = 200; let enviado = '';
    const guardar = /\/orders\/refresh|\/api\/chat/.test(u.pathname);
    const registrar = () => httpLog.push({ t: Date.now(), method: req.method || '', path: u.pathname, query: u.search, status: statusCode, req: guardar ? rawBody : undefined, res: guardar ? enviado : undefined });
    const vres: any = {
      status(c: number) { statusCode = c; return vres; },
      setHeader(k: string, v: string) { res.setHeader(k, v); return vres; },
      getHeader(k: string) { return res.getHeader(k); },
      send(b: any) { enviado = String(b); res.statusCode = statusCode; res.end(enviado); registrar(); return vres; },
      json(b: any) { return vres.send(JSON.stringify(b)); },
      end(b?: any) { res.statusCode = statusCode; res.end(b); registrar(); return vres; },
    };
    return { vreq, vres };
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', async () => {
      const u = new URL(req.url || '/', origem);
      if (u.pathname === '/' || u.pathname === '/index.html') {
        res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.end(html); return;
      }
      try {
        if (u.pathname === '/api/chat') { const { vreq, vres } = adaptar(req, res, raw, {}); await chatHandler(vreq, vres); return; }
        const m = u.pathname.match(/^\/api\/(auth|orders|items|ml)\/([^/]+)$/);
        if (!m) { res.statusCode = 404; res.end('{}'); return; }
        const [, grupo, nome] = m;
        if (grupo === 'auth') { const { vreq, vres } = adaptar(req, res, raw, { action: nome }); await authHandler(vreq, vres); return; }
        if (grupo === 'orders' && nome === 'refresh') { const { vreq, vres } = adaptar(req, res, raw, {}); await refreshHandler(vreq, vres); return; }
        if (grupo === 'orders') { const { vreq, vres } = adaptar(req, res, raw, { resource: nome }); await ordersHandler(vreq, vres); return; }
        if (grupo === 'items') { const { vreq, vres } = adaptar(req, res, raw, { resource: nome }); await itemsHandler(vreq, vres); return; }
        if (grupo === 'ml') { const { vreq, vres } = adaptar(req, res, raw, { op: nome }); await mlHandler(vreq, vres); return; }
      } catch (e) {
        res.statusCode = 500; res.end(JSON.stringify({ error: String(e) }));
      }
    });
  });
  await new Promise<void>((ok, erro) => { server.once('error', erro); server.listen(op.porta, '127.0.0.1', () => ok()); });

  return {
    origem, lojas, cache, cacheDG, mlLog, httpLog, fetchReal,
    async encerrar() { await new Promise<void>(r => server.close(() => r())); globalThis.fetch = fetchReal; },
  };
}

/** O que os cards deveriam mostrar, calculado aqui, à parte do backend. */
export function esperado(lojas: Record<string, Loja>, toks: string[], fromYmd: string, toYmd: string) {
  const ini = new Date(fromYmd + 'T00:00:00.000-03:00').getTime();
  const fim = new Date(toYmd + 'T23:59:59.999-03:00').getTime();
  const ps = toks.flatMap(t => lojas[t].pedidos).filter(p => { const t = new Date(String(p.date_created)).getTime(); return t >= ini && t <= fim && p.status === 'paid'; });
  const comTarifa = ps.filter(p => typeof (p.order_items as any)[0].sale_fee === 'number');
  return {
    pedidos: ps.length,
    bruto: ps.reduce((s, p) => s + (p.paid_amount || 0), 0),
    ids: ps.map(p => Number(p.id)),
    comTarifa: comTarifa.length,
    receitaComTarifa: comTarifa.reduce((s, p) => s + (p.paid_amount || 0), 0),
  };
}
