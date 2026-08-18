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
import { publicarMapaLogistica } from '../src/lib/shipping-store.js';

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

// ═════════════════════════════════════════════════════════════════════════
// 29. GET /api/orders/metrics — agregados do snapshot ativos
// ═════════════════════════════════════════════════════════════════════════
describe('29. GET /api/orders/metrics', () => {
  async function chamar(query: Record<string, unknown>, token?: string) {
    const res = mockRes();
    await handler(
      mockReq({
        query: { resource: 'metrics', ...query },
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
      res
    );
    return res;
  }

  it('401 sem sessao', async () => {
    await publicar(cache, 'ativos', 10, 5);
    const res = await chamar({});
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
  });

  it('401 com token invalido', async () => {
    await publicar(cache, 'ativos', 10, 5);
    const res = await chamar({}, 'sess_naoexiste');
    expect(res.statusCode).toBe(401);
  });

  it('405 fora do GET', async () => {
    const t = await comSessao();
    const res = mockRes();
    await handler(
      mockReq({ method: 'POST', query: { resource: 'metrics' }, headers: { authorization: `Bearer ${t}` } }),
      res
    );
    expect(res.statusCode).toBe(405);
  });

  it('200 com sessao valida e snapshot publicado', async () => {
    await publicar(cache, 'ativos', 10, 5);
    const res = await chamar({}, await comSessao());
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.ok).toBe(true);
    expect(b.versao).toBe(1);
    expect(b.coverage.alvo).toBe('ativos');
    expect(b.coverage.totalRegistros).toBe(10);
  });

  it('409 not_ready quando nao ha snapshot', async () => {
    const res = await chamar({}, await comSessao());
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_ready');
  });

  it('409 not_ready com snapshot vazio (nunca zero disfarcado)', async () => {
    await publicar(cache, 'ativos', 0, 5);
    const res = await chamar({}, await comSessao());
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_ready');
  });

  it('NUNCA le o snapshot de cancelados, mesmo com alvo=cancelados', async () => {
    await publicar(cache, 'ativos', 10, 5);
    await publicar(cache, 'cancelados', 4, 5);
    const lidas: string[] = [];
    const orig = (cache as any).get.bind(cache);
    (cache as any).get = async (k: string) => { lidas.push(k); return orig(k); };
    const res = await chamar({ alvo: 'cancelados' }, await comSessao());
    expect(res.statusCode).toBe(200);
    expect(lidas.filter(k => k.includes('orders:cancel'))).toEqual([]);
    expect(res.json().coverage.alvo).toBe('ativos');
  });

  it('nao publica cancelled em porStatus e declara indisponibilidade', async () => {
    await publicar(cache, 'ativos', 10, 5);
    const b = (await chamar({}, await comSessao())).json();
    expect(Object.keys(b.porStatus)).not.toContain('cancelled');
    expect(b.cancelados).toEqual({
      disponivel: false,
      total: null,
      motivo: 'fora_do_escopo_do_snapshot_ativos',
      fonte: 'carga_sob_demanda_no_dashboard',
    });
  });

  it('nenhuma PII no corpo serializado', async () => {
    await publicar(cache, 'ativos', 10, 5);
    const res = await chamar({}, await comSessao());
    const bruto = res.body as string;
    for (const proibido of [
      'buyer', 'nickname', 'shipping', 'order_items', 'seller_sku',
      'unit_price', 'paid_amount', 'date_created', 'cursor', 'chunk',
    ]) {
      expect(bruto).not.toContain(proibido);
    }
  });

  it('nao expoe chaves Redis, versao de chunk nem cursor', async () => {
    await publicar(cache, 'ativos', 10, 5);
    const bruto = (await chamar({}, await comSessao())).body as string;
    expect(bruto).not.toContain('orders:');
    expect(bruto).not.toContain('nextCursor');
  });

  const parametrosInvalidos: Array<[string, Record<string, unknown>, string]> = [
    ['parametro desconhecido', { foo: 'x' }, 'parametro_desconhecido'],
    ['dias nao numerico', { dias: 'abc' }, 'dias_invalido'],
    ['dias fora do limite', { dias: '99999' }, 'dias_fora_do_limite'],
    ['dias com from', { dias: '7', from: '2026-07-01' }, 'combinacao_invalida'],
    ['intervalo incompleto', { from: '2026-07-01' }, 'intervalo_incompleto'],
    ['data inexistente', { from: '2026-02-31', to: '2026-03-01' }, 'data_invalida'],
    ['intervalo invertido', { from: '2026-07-31', to: '2026-07-01' }, 'intervalo_invertido'],
    ['intervalo excessivo', { from: '2015-01-01', to: '2026-07-01' }, 'intervalo_excessivo'],
  ];
  for (const [nome, q, code] of parametrosInvalidos) {
    it(`400 deterministico: ${nome}`, async () => {
      await publicar(cache, 'ativos', 10, 5);
      const res = await chamar(q, await comSessao());
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_params', code });
    });
  }

  it('parametros invalidos NAO leem o snapshot', async () => {
    await publicar(cache, 'ativos', 10, 5);
    const t = await comSessao();
    const lidas: string[] = [];
    const orig = (cache as any).get.bind(cache);
    (cache as any).get = async (k: string) => { lidas.push(k); return orig(k); };
    const res = await chamar({ dias: 'abc' }, t);
    expect(res.statusCode).toBe(400);
    expect(lidas.filter(k => k.startsWith('orders:'))).toEqual([]);
  });

  it('dias e from/to validos resolvem o periodo devolvido', async () => {
    await publicar(cache, 'ativos', 10, 5);
    const t = await comSessao();
    const b1 = (await chamar({ dias: '30' }, t)).json();
    expect(b1.periodo.toYmd >= b1.periodo.fromYmd).toBe(true);
    const b2 = (await chamar({ from: '2026-07-01', to: '2026-07-31' }, t)).json();
    expect(b2.periodo).toMatchObject({ fromYmd: '2026-07-01', toYmd: '2026-07-31' });
  });

  it('contratos de status e list seguem intactos', async () => {
    const man = await publicar(cache, 'ativos', 10, 5);
    const t = await comSessao();
    const st = mockRes();
    await handler(mockReq({ query: { resource: 'status', alvo: 'ativos' }, headers: { authorization: `Bearer ${t}` } }), st);
    expect(st.statusCode).toBe(200);
    expect(st.json().versao).toBe(man.versao);
    const li = mockRes();
    await handler(mockReq({ query: { resource: 'list', alvo: 'ativos', pageSize: '5' }, headers: { authorization: `Bearer ${t}` } }), li);
    expect(li.statusCode).toBe(200);
    expect(li.json().items.length).toBe(5);
    expect(typeof li.json().nextCursor).toBe('string');
  });

  it('recurso desconhecido continua 404', async () => {
    const res = mockRes();
    await handler(mockReq({ query: { resource: 'metricas' } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('a rota metrics nao importa ml-auth nem menciona mercadolibre', () => {
    const src = readFileSync(new URL('../api/orders/[resource].ts', import.meta.url), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/mercadolibre/);
    expect(src).not.toMatch(/mlFetch\s*\(/);
  });
});

// ── GET /api/orders/logistics — mapa de logistica por envio ────────────────
describe('rota /api/orders/logistics', () => {
  it('exige sessao, igual aos demais recursos', async () => {
    const res = mockRes();
    await handler(mockReq({ query: { resource: 'logistics' } }), res);
    expect(res.statusCode).toBe(401);
  });

  it('so aceita GET', async () => {
    const tok = await comSessao();
    const res = mockRes();
    await handler(mockReq({ method: 'POST', query: { resource: 'logistics' }, headers: { authorization: `Bearer ${tok}` } }), res);
    expect(res.statusCode).toBe(405);
  });

  it('mapa ausente devolve 200 com total zero — nunca 500', async () => {
    const tok = await comSessao();
    const res = mockRes();
    await handler(mockReq({ query: { resource: 'logistics' }, headers: { authorization: `Bearer ${tok}` } }), res);
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.ok).toBe(true);
    expect(b.total).toBe(0);
    expect(b.porTipo).toEqual({});
    expect(b.versao).toBeNull();
  });

  it('agrupa por tipo, com ids ordenados', async () => {
    await publicarMapaLogistica(cache, new Map([
      ['300', 'fulfillment'], ['100', 'fulfillment'], ['200', 'xd_drop_off'],
    ]));
    const tok = await comSessao();
    const res = mockRes();
    await handler(mockReq({ query: { resource: 'logistics' }, headers: { authorization: `Bearer ${tok}` } }), res);
    const b = res.json();
    expect(b.total).toBe(3);
    expect(b.porTipo.fulfillment).toEqual(['100', '300']);
    expect(b.porTipo.xd_drop_off).toEqual(['200']);
    expect(b.versao).toBe(1);
    expect(typeof b.updatedAt).toBe('string');
  });

  it('NAO vaza id de pedido, valor, data, comprador nem endereco', async () => {
    await publicar(cache, 'ativos', 5, 10);
    await publicarMapaLogistica(cache, new Map([['100', 'fulfillment']]));
    const tok = await comSessao();
    const res = mockRes();
    await handler(mockReq({ query: { resource: 'logistics' }, headers: { authorization: `Bearer ${tok}` } }), res);
    const bruto = JSON.stringify(res.json());
    for (const proibido of ['buyer', 'nickname', 'paid_amount', 'date_created', 'order_items', 'receiver_address']) {
      expect(bruto, proibido).not.toContain(proibido);
    }
  });

  it('agrupar por tipo encolhe o payload de verdade', async () => {
    // Racional do formato: com ~3.500 envios, repetir a string do tipo em cada
    // entrada triplicaria o corpo sem acrescentar informacao nenhuma.
    const mapa = new Map<string, string>();
    for (let i = 0; i < 3500; i++) mapa.set(`5550${i}`, i % 5 === 0 ? 'xd_drop_off' : 'fulfillment');
    await publicarMapaLogistica(cache, mapa);
    const tok = await comSessao();
    const res = mockRes();
    await handler(mockReq({ query: { resource: 'logistics' }, headers: { authorization: `Bearer ${tok}` } }), res);
    const b = res.json();
    expect(b.total).toBe(3500);
    const agrupado = JSON.stringify(b).length;
    const plano = JSON.stringify(Object.fromEntries(mapa)).length;
    expect(agrupado).toBeLessThan(plano * 0.6);
  });
});