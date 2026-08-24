import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { createSession } from '../src/lib/session.js';
import {
  publishCatalog, writeCatalogChunk,
  type CatalogManifest, type ItemSlim,
} from '../src/lib/items-store.js';
import {
  publishManifest, writeChunk, type OrdersManifest,
} from '../src/lib/orders-store.js';
import type { OrderSlim } from '../src/services/orders.service.js';
import handler from '../api/items/[resource].js';
import { hojeBRT } from '../src/lib/datas-brt.js';
import { ymdMenosDias } from '../src/services/orders-metrics.service.js';

// ── mocks mínimos de Vercel req/res (mesmo padrão dos demais testes de rota) ──
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

/** Anúncio no formato do snapshot de catálogo, com os defaults do recorte ItemSlim. */
function item(o: Partial<ItemSlim> & { id: string }): ItemSlim {
  return {
    title: 'Vinho ' + o.id,
    status: 'active',
    price: 100,
    original_price: null,
    available_quantity: 0,
    sold_quantity: null,
    listing_type_id: 'gold_special',
    catalog_listing: false,
    inventory_id: null,
    permalink: null,
    thumbnail: null,
    last_updated: null,
    seller_custom_field: null,
    seller_sku: null,
    tags: [],
    shipping: { logistic_type: 'drop_off' },
    attributes: null,
    ...o,
  };
}

/**
 * Cenário base:
 *   S1 → 1 anúncio próprio (10) + 2 espelhos Full com o MESMO inventory_id (25
 *        cada). O dedup precisa devolver 25 no Full, não 50.
 *   S2 → só próprio (2 unidades).
 *   S3 → só Full, e PAUSADO: aparece no Full (que não filtra status) e não
 *        aparece no próprio (que filtra active).
 */
const ITENS_BASE: ItemSlim[] = [
  item({ id: 'MLB-P1', seller_custom_field: 'S1', available_quantity: 10 }),
  item({
    id: 'MLB-F1', seller_custom_field: 'S1', available_quantity: 25,
    inventory_id: 'INV1', tags: ['fulfillment'],
    shipping: { logistic_type: 'fulfillment' },
  }),
  item({
    id: 'MLB-F2', seller_custom_field: 'S1', available_quantity: 25,
    inventory_id: 'INV1', tags: ['fulfillment'], listing_type_id: 'gold_pro',
    shipping: { logistic_type: 'fulfillment' },
  }),
  item({ id: 'MLB-P2', seller_custom_field: 'S2', available_quantity: 2 }),
  item({
    id: 'MLB-F3', seller_custom_field: 'S3', available_quantity: 7, status: 'paused',
    inventory_id: 'INV3', tags: ['fulfillment'],
    shipping: { logistic_type: 'fulfillment' },
  }),
];

async function publicarCatalogo(cache: FakeCache, itens: ItemSlim[] = ITENS_BASE) {
  const chave = await writeCatalogChunk(cache, 1, 0, itens);
  const man: CatalogManifest = {
    versao: 1,
    chunks: [chave],
    counts: {
      total: itens.length,
      active: itens.filter(i => i.status === 'active').length,
      paused: itens.filter(i => i.status === 'paused').length,
      closed: itens.filter(i => i.status === 'closed').length,
    },
    chunkSize: 500,
    updatedAt: new Date().toISOString(),
    complete: true,
  };
  await publishCatalog(cache, man);
  return man;
}

/** Pedidos no snapshot `ativos`, com unidades por item_id dentro da janela. */
async function publicarPedidos(cache: FakeCache, unidadesPorItemId: Record<string, number>) {
  const pedidos: OrderSlim[] = [];
  let seq = 1;
  for (const [itemId, unidades] of Object.entries(unidadesPorItemId)) {
    for (let i = 0; i < unidades; i++) {
      pedidos.push({
        id: seq++,
        status: 'paid',
        date_created: '2026-08-05T10:00:00.000-03:00',
        paid_amount: 100,
        total_amount: 100,
        order_items: [
          { quantity: 1, unit_price: 100, item: { id: itemId, title: 'V', seller_sku: null, variation_id: null } },
        ],
      });
    }
  }
  const chave = await writeChunk(cache, 'ativos', 1, 0, pedidos);
  const man: OrdersManifest = {
    versao: 1,
    chunks: [chave],
    totalRegistros: pedidos.length,
    newestDate: '2026-08-05T10:00:00.000-03:00',
    oldestDate: '2026-08-05T10:00:00.000-03:00',
    chunkSize: 500,
    updatedAt: '2026-08-10T12:00:00.000Z',
    origem: 'full',
  };
  await publishManifest(cache, 'ativos', man);
}

let cache: FakeCache;
let mlCalls: string[] = [];

beforeEach(() => {
  cache = new FakeCache();
  setCacheForTests(cache);
  Object.assign(process.env, TEST_ENV);
  resetEnvForTests();
  vi.restoreAllMocks();
  mlCalls = [];
  // Qualquer ida ao Mercado Livre nesta rota é um defeito: registramos a
  // chamada e devolvemos algo inócuo em vez de deixar a rede de verdade.
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    mlCalls.push(String(url));
    return { ok: true, status: 200, json: async () => ({}) } as any;
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const JANELA = { from: '2026-08-01', to: '2026-08-10' }; // 10 dias, bordas incluídas

async function chamar(query: Record<string, unknown> = {}, token?: string, method = 'GET') {
  const res = mockRes();
  await handler(mockReq({
    method,
    query: { resource: 'inventory', ...query },
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }), res);
  return res;
}
const comSessao = async () => (await createSession(cache)).id;
const linhaDe = (corpo: any, lado: 'proprio' | 'full', sku: string) =>
  corpo[lado].linhas.find((l: any) => l.sku === sku);

// ══════════════════════════════════════════════════════════════════════════
describe('GET /api/items/inventory — autenticação, método e parâmetros', () => {
  it('401 sem sessão, e sem tocar no Mercado Livre', async () => {
    const res = await chamar();
    expect(res.statusCode).toBe(401);
    expect(mlCalls).toEqual([]);
  });

  it('404 para recurso desconhecido', async () => {
    const res = await chamar({ resource: 'nao-existe' }, await comSessao());
    expect(res.statusCode).toBe(404);
  });

  it('405 fora do GET', async () => {
    const res = await chamar({}, await comSessao(), 'POST');
    expect(res.statusCode).toBe(405);
  });

  it('400 para parâmetro fora da allowlist', async () => {
    await publicarCatalogo(cache);
    const res = await chamar({ refresh: '1' }, await comSessao());
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('parametro_desconhecido');
  });

  it('400 para modo inválido', async () => {
    await publicarCatalogo(cache);
    const res = await chamar({ modo: 'agressivo' }, await comSessao());
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('modo_invalido');
  });

  it('400 para escopo inválido', async () => {
    await publicarCatalogo(cache);
    const res = await chamar({ escopo: 'tudo' }, await comSessao());
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('escopo_invalido');
  });

  it('400 herda a validação de período de resolverPeriodo', async () => {
    await publicarCatalogo(cache);
    const res = await chamar({ dias: '30', from: '2026-08-01' }, await comSessao());
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('combinacao_invalida');
  });
});

describe('GET /api/items/inventory — dependência de snapshot', () => {
  it('409 not_ready sem catálogo publicado', async () => {
    const res = await chamar(JANELA, await comSessao());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'not_ready', code: 'catalogo_indisponivel' });
  });

  it('409 not_ready com catálogo vazio', async () => {
    await publicarCatalogo(cache, []);
    const res = await chamar(JANELA, await comSessao());
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('catalogo_vazio');
  });

  it('NUNCA chama o Mercado Livre no caminho de sucesso', async () => {
    await publicarCatalogo(cache);
    await publicarPedidos(cache, { 'MLB-P2': 10 });
    const res = await chamar(JANELA, await comSessao());
    expect(res.statusCode).toBe(200);
    expect(mlCalls).toEqual([]);
  });

  it('sem snapshot de pedidos ainda responde 200, com aviso e sem classificação', async () => {
    await publicarCatalogo(cache);
    const res = await chamar(JANELA, await comSessao());
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c.vendas.disponivel).toBe(false);
    expect(c.warnings).toContain('vendas_indisponiveis');
    // O saldo continua correto — só a velocidade fica indisponível.
    expect(linhaDe(c, 'proprio', 'S1').estProprio).toBe(10);
    expect(linhaDe(c, 'proprio', 'S1').tipo).toBeNull();
    expect(linhaDe(c, 'proprio', 'S1').velocidadeDia).toBeNull();
  });
});

describe('GET /api/items/inventory — dedup próprio × Full', () => {
  it('espelhos Full com o mesmo inventory_id contam UMA vez', async () => {
    await publicarCatalogo(cache);
    const c = (await chamar(JANELA, await comSessao())).json();
    const s1 = linhaDe(c, 'proprio', 'S1');
    expect(s1.estProprio).toBe(10);
    expect(s1.estFull).toBe(25);   // 25 e 25 na mesma chave → 25, não 50
    expect(s1.estTotal).toBe(35);
    expect(s1.anuncios).toBe(3);
  });

  it('a linha Full separa clássico e premium sem inflar o total', async () => {
    await publicarCatalogo(cache);
    const c = (await chamar(JANELA, await comSessao())).json();
    const s1 = linhaDe(c, 'full', 'S1');
    expect(s1.estTotal).toBe(25);
    expect(s1.estClassico + s1.estPremium).toBe(25);
  });

  it('próprio filtra status active; Full não filtra status', async () => {
    await publicarCatalogo(cache);
    const c = (await chamar(JANELA, await comSessao())).json();
    expect(linhaDe(c, 'proprio', 'S3')).toBeUndefined();
    expect(linhaDe(c, 'full', 'S3').estTotal).toBe(7);
  });
});

describe('GET /api/items/inventory — classificação por velocidade', () => {
  it('classifica ruptura e semvenda com o span real do período', async () => {
    await publicarCatalogo(cache);
    await publicarPedidos(cache, { 'MLB-P2': 10 }); // 10 unidades em 10 dias
    const c = (await chamar(JANELA, await comSessao())).json();

    expect(c.periodo).toMatchObject({ fromYmd: '2026-08-01', toYmd: '2026-08-10', dias: 10 });
    expect(c.vendas.disponivel).toBe(true);

    const s2 = linhaDe(c, 'proprio', 'S2');
    expect(s2.vendasPeriodo).toBe(10);
    expect(s2.velocidadeDia).toBe(1);   // 10 / 10 dias
    expect(s2.diasCobertura).toBe(2);   // 2 unidades / 1 por dia
    expect(s2.tipo).toBe('ruptura');

    const s1 = linhaDe(c, 'proprio', 'S1');
    expect(s1.vendasPeriodo).toBe(0);
    expect(s1.tipo).toBe('semvenda');
    expect(s1.diasCobertura).toBeNull();
  });

  it('pedidos fora da janela não entram na velocidade', async () => {
    await publicarCatalogo(cache);
    await publicarPedidos(cache, { 'MLB-P2': 10 }); // todos em 2026-08-05
    const c = (await chamar({ from: '2026-07-01', to: '2026-07-10' }, await comSessao())).json();
    expect(linhaDe(c, 'proprio', 'S2').vendasPeriodo).toBe(0);
    expect(linhaDe(c, 'proprio', 'S2').tipo).toBe('semvenda');
  });

  it('resumo conta SKUs, unidades e tipos do lado correspondente', async () => {
    await publicarCatalogo(cache);
    await publicarPedidos(cache, { 'MLB-P2': 10 });
    const c = (await chamar(JANELA, await comSessao())).json();

    // Próprio: S1 (10) e S2 (2). S3 está pausado e não entra.
    expect(c.proprio.resumo.skus).toBe(2);
    expect(c.proprio.resumo.unidades).toBe(12);
    expect(c.proprio.resumo.porTipo.ruptura).toBe(1);
    expect(c.proprio.resumo.porTipo.semvenda).toBe(1);

    // Full: S1 (25) e S3 (7).
    expect(c.full.resumo.skus).toBe(2);
    expect(c.full.resumo.unidades).toBe(32);
  });
});

describe('GET /api/items/inventory — escopo e modo', () => {
  it('escopo=proprio omite o Full e escopo=full omite o próprio', async () => {
    await publicarCatalogo(cache);
    const sess = await comSessao();

    const soProprio = (await chamar({ ...JANELA, escopo: 'proprio' }, sess)).json();
    expect(soProprio.full).toBeNull();
    expect(soProprio.proprio.linhas.length).toBeGreaterThan(0);

    const soFull = (await chamar({ ...JANELA, escopo: 'full' }, sess)).json();
    expect(soFull.proprio).toBeNull();
    expect(soFull.full.linhas.length).toBeGreaterThan(0);
  });

  it('modo padrão é seguro: saldo negativo vira 0 com alerta, sem derrubar a rota', async () => {
    await publicarCatalogo(cache, [
      item({ id: 'MLB-NEG', seller_custom_field: 'S9', available_quantity: -4, inventory_id: 'INVNEG' }),
    ]);
    await publicarPedidos(cache, { 'MLB-NEG': 1 });
    const res = await chamar(JANELA, await comSessao());
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c.modo).toBe('seguro');
    const s9 = linhaDe(c, 'proprio', 'S9');
    expect(s9.estProprio).toBe(0);
    expect(s9.alertas.some((a: any) => a.tipo === 'saldo_negativo_normalizado')).toBe(true);
  });

  it('modo=legado com saldo negativo devolve 409 explicado, não 500', async () => {
    await publicarCatalogo(cache, [
      item({ id: 'MLB-NEG', seller_custom_field: 'S9', available_quantity: -4, inventory_id: 'INVNEG' }),
    ]);
    await publicarPedidos(cache, { 'MLB-NEG': 1 });
    const res = await chamar({ ...JANELA, modo: 'legado' }, await comSessao());
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('saldo_invalido_no_modo_legado');
  });

  it('modo=legado e modo=seguro coincidem quando não há saldo negativo', async () => {
    await publicarCatalogo(cache);
    await publicarPedidos(cache, { 'MLB-P2': 10 });
    const sess = await comSessao();
    const seguro = (await chamar({ ...JANELA, modo: 'seguro' }, sess)).json();
    const legado = (await chamar({ ...JANELA, modo: 'legado' }, sess)).json();

    const totais = (c: any) => c.proprio.linhas.map((l: any) => [l.sku, l.estProprio, l.estFull, l.estTotal]);
    expect(totais(legado)).toEqual(totais(seguro));
    expect(legado.full.resumo.unidades).toBe(seguro.full.resumo.unidades);
  });
});

describe('GET /api/items/inventory — semântica de período', () => {
  it('dias=N são N dias civis terminando hoje, não N+1', async () => {
    await publicarCatalogo(cache);
    const c = (await chamar({ dias: '30' }, await comSessao())).json();
    const hoje = hojeBRT();
    expect(c.periodo.toYmd).toBe(hoje);
    expect(c.periodo.fromYmd).toBe(ymdMenosDias(hoje, 29));
    // 31 seria a convenção de /api/orders/metrics; estoque diverge de propósito
    // para bater com o "últimos 30 dias" do parser do chat.
    expect(c.periodo.dias).toBe(30);
  });

  it('sem parâmetro de período usa a mesma janela de dias=30', async () => {
    await publicarCatalogo(cache);
    const sess = await comSessao();
    const semParam = (await chamar({}, sess)).json();
    const com30 = (await chamar({ dias: '30' }, sess)).json();
    expect(semParam.periodo).toEqual(com30.periodo);
  });

  it('dias=1 é só hoje', async () => {
    await publicarCatalogo(cache);
    const c = (await chamar({ dias: '1' }, await comSessao())).json();
    expect(c.periodo.fromYmd).toBe(c.periodo.toYmd);
    expect(c.periodo.dias).toBe(1);
  });

  it('intervalo explícito passa intocado', async () => {
    await publicarCatalogo(cache);
    const c = (await chamar(JANELA, await comSessao())).json();
    expect(c.periodo).toMatchObject({ fromYmd: '2026-08-01', toYmd: '2026-08-10', dias: 10 });
  });
});

describe('GET /api/items/inventory — base total', () => {
  it('escopo ambos devolve os três blocos, e `proprio` mantém a paridade', async () => {
    await publicarCatalogo(cache);
    await publicarPedidos(cache, { 'MLB-P2': 10 });
    const c = (await chamar(JANELA, await comSessao())).json();
    expect(c.proprio).not.toBeNull();
    expect(c.full).not.toBeNull();
    expect(c.total).not.toBeNull();
    // As linhas de `total` são as mesmas, só reclassificadas.
    expect(c.total.linhas.length).toBe(c.proprio.linhas.length);
    expect(c.total.resumo.skus).toBe(c.proprio.resumo.skus);
    // O resumo de `proprio` soma o saldo próprio; o de `total`, o saldo total.
    const somaProprio = c.proprio.linhas.reduce((n: number, l: any) => n + l.estProprio, 0);
    const somaTotal = c.proprio.linhas.reduce((n: number, l: any) => n + l.estTotal, 0);
    expect(c.proprio.resumo.unidades).toBe(somaProprio);
    expect(c.total.resumo.unidades).toBe(somaTotal);
  });

  it('escopo proprio e full não trazem o bloco total', async () => {
    await publicarCatalogo(cache);
    const sess = await comSessao();
    expect((await chamar({ ...JANELA, escopo: 'proprio' }, sess)).json().total).toBeNull();
    expect((await chamar({ ...JANELA, escopo: 'full' }, sess)).json().total).toBeNull();
  });

  it('estTotal = estProprio + estFull em toda linha devolvida', async () => {
    await publicarCatalogo(cache);
    await publicarPedidos(cache, { 'MLB-P2': 10 });
    const c = (await chamar(JANELA, await comSessao())).json();
    for (const l of c.proprio.linhas) expect(l.estTotal, l.sku).toBe(l.estProprio + l.estFull);
  });
});

describe('GET /api/items/inventory — metadados da resposta', () => {
  it('declara a versão do catálogo, os limites de classificação e o modo', async () => {
    await publicarCatalogo(cache);
    const c = (await chamar(JANELA, await comSessao())).json();
    expect(c.catalogo).toMatchObject({ versao: 1, stale: false });
    expect(c.catalogo.counts.total).toBe(ITENS_BASE.length);
    expect(c.limites).toMatchObject({ rupturaDiasMax: 30, alertaDiasMax: 90, okDiasMax: 365 });
    expect(c.escopo).toBe('ambos');
  });

  it('marca catalogo_stale quando o snapshot passou do TTL duro', async () => {
    const chave = await writeCatalogChunk(cache, 1, 0, ITENS_BASE);
    await publishCatalog(cache, {
      versao: 1, chunks: [chave],
      counts: { total: ITENS_BASE.length, active: 4, paused: 1, closed: 0 },
      chunkSize: 500,
      updatedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
      complete: true,
    });
    const c = (await chamar(JANELA, await comSessao())).json();
    expect(c.catalogo.stale).toBe(true);
    expect(c.warnings).toContain('catalogo_stale');
  });

  it('não expõe chave Redis, chunk, token ou credencial na resposta', async () => {
    await publicarCatalogo(cache);
    const bruto = (await chamar(JANELA, await comSessao())).body as string;
    for (const proibido of ['items:catalog', 'orders:', 'chunk', 'refresh_token', 'access_token', 'ml:']) {
      expect(bruto).not.toContain(proibido);
    }
  });
});
