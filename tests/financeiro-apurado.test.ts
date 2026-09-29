/**
 * Tarifa e frete REAIS, com cobertura — financeiro-apurado.service e as
 * métricas de uma seleção sem perfil financeiro.
 *
 * O que fica travado:
 *  - o valor sai do pedido (`sale_fee × quantidade`) e do envio (`custoFrete`),
 *    nunca de percentual;
 *  - cobertura incompleta NÃO vira total: `valor` é `null` e o subtotal vai em
 *    `conhecida`, com a fração da receita que cobre;
 *  - ausência de `sale_fee` é "desconhecida", não zero;
 *  - no consolidado, a Overwine entra com a estimativa DELA e a Degustar com o
 *    apurado; o total só existe quando as duas partes existem;
 *  - o snapshot de um pedido sem `sale_fee` continua com o formato de sempre.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests, type Cache } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { createSession } from '../src/lib/session.js';
import { contaPorId } from '../src/config/contas.js';
import { cacheDaConta } from '../src/lib/cache/conta-cache.js';
import { type OrdersManifest, writeChunk, publishManifest } from '../src/lib/orders-store.js';
import { publicarMapaEnvios, type EnvioInfo } from '../src/lib/shipping-store.js';
import { toSlim, type OrderSlim } from '../src/services/orders.service.js';
import { apurarFinanceiro, tarifaDoPedido } from '../src/services/financeiro-apurado.service.js';
import ordersHandler from '../api/orders/[resource].js';

const INI = new Date('2026-09-01T00:00:00.000-03:00');
const FIM = new Date('2026-09-30T23:59:59.999-03:00');

function ped(id: number, dia: string, valor: number, o: { fee?: number | null; qtd?: number; envio?: number | null; status?: string } = {}): OrderSlim {
  const qtd = o.qtd ?? 1;
  const item: OrderSlim['order_items'][number] = {
    quantity: qtd, unit_price: valor / qtd,
    item: { id: 'MLB-DG1', title: 'Vinho', seller_sku: '21003', variation_id: null },
  };
  if (typeof o.fee === 'number') item.sale_fee = o.fee;
  const p: OrderSlim = {
    id, status: o.status ?? 'paid', date_created: `${dia}T12:00:00.000-03:00`,
    paid_amount: valor, total_amount: valor, order_items: [item],
  };
  if (o.envio !== null) p.shipping = { id: o.envio ?? id + 9000, logistic_type: null };
  return p;
}
const mapa = (...e: Array<[number, number | null]>): Map<string, EnvioInfo> =>
  new Map(e.map(([id, custo]) => [String(id), { logisticType: 'fulfillment', custoFrete: custo }]));

describe('toSlim — a tarifa real entra no snapshot sem mudar o que ja existe', () => {
  const base = { id: 1, status: 'paid', date_created: '2026-09-10T12:00:00.000-03:00', paid_amount: 100, total_amount: 100 };
  const oi = { quantity: 2, unit_price: 50, item: { id: 'MLB1', title: 'V', seller_sku: 'S', variation_id: null } };

  it('pedido SEM sale_fee: o item nao ganha o campo (formato de sempre)', () => {
    const s = toSlim({ ...base, order_items: [oi] });
    expect(s.order_items[0]).toEqual(oi);
    expect('sale_fee' in s.order_items[0]).toBe(false);
  });
  it('pedido COM sale_fee: guardado como veio', () => {
    expect(toSlim({ ...base, order_items: [{ ...oi, sale_fee: 7.4 }] }).order_items[0].sale_fee).toBe(7.4);
    expect(toSlim({ ...base, order_items: [{ ...oi, sale_fee: 0 }] }).order_items[0].sale_fee).toBe(0);
  });
  it('sale_fee invalido (null, negativo, texto, NaN) nao e guardado', () => {
    for (const ruim of [null, -1, NaN, Infinity, '7.4' as unknown as number]) {
      expect('sale_fee' in toSlim({ ...base, order_items: [{ ...oi, sale_fee: ruim }] }).order_items[0]).toBe(false);
    }
  });
});

describe('tarifaDoPedido', () => {
  it('sale_fee e por unidade: multiplica pela quantidade', () => {
    expect(tarifaDoPedido(ped(1, '2026-09-10', 300, { fee: 15, qtd: 3 }))).toBe(45);
  });
  it('falta em UM item: a tarifa do pedido e desconhecida, nao a soma dos outros', () => {
    const p = ped(1, '2026-09-10', 300, { fee: 15 });
    p.order_items.push({ quantity: 1, unit_price: 50, item: { id: 'MLB2', title: 'X', seller_sku: null, variation_id: null } });
    expect(tarifaDoPedido(p)).toBeNull();
  });
  it('zero e um valor conhecido', () => {
    expect(tarifaDoPedido(ped(1, '2026-09-10', 300, { fee: 0 }))).toBe(0);
  });
});

describe('apurarFinanceiro', () => {
  it('cobertura completa: totais reais e liquido', () => {
    const ps = [ped(1, '2026-09-10', 100, { fee: 12 }), ped(2, '2026-09-11', 200, { fee: 11, qtd: 2 })];
    const r = apurarFinanceiro(ps, INI, FIM, mapa([9001, 18], [9002, 0]));
    expect(r.bruto).toBe(300);
    expect(r.tarifaML).toMatchObject({ valor: -34, conhecida: -34, completa: true, fracao: 1, pedidosCobertos: 2, pedidosTotal: 2 });
    expect(r.frete).toMatchObject({ valor: -18, completa: true });
    expect(r.liquido).toBe(300 - 34 - 18);
    expect(r.metodo).toBe('apurado_pedidos_envios');
  });

  it('frete gratis para o vendedor (0) e conhecido; pedido sem envio nao tem frete', () => {
    const r = apurarFinanceiro([ped(1, '2026-09-10', 100, { fee: 10, envio: null })], INI, FIM, new Map());
    expect(r.frete).toMatchObject({ valor: -0, completa: true });
    expect(r.liquido).toBe(90);
  });

  it('tarifa parcial: total null, subtotal e fracao da receita', () => {
    const ps = [ped(1, '2026-09-10', 100, { fee: 12 }), ped(2, '2026-09-11', 300)];   // o 2o sem sale_fee
    const r = apurarFinanceiro(ps, INI, FIM, mapa([9001, 10], [9002, 20]));
    expect(r.tarifaML.valor).toBeNull();
    expect(r.tarifaML).toMatchObject({ conhecida: -12, receitaCoberta: 100, fracao: 0.25, completa: false, pedidosCobertos: 1, pedidosTotal: 2 });
    expect(r.frete).toMatchObject({ valor: -30, completa: true });
    expect(r.liquido).toBeNull();
    expect(r.liquidoConhecido).toEqual({ valor: 100 - 12 - 10, receitaCoberta: 100, fracao: 0.25, pedidos: 1 });
  });

  it('frete parcial: envio ainda nao resolvido nao vira zero', () => {
    const ps = [ped(1, '2026-09-10', 100, { fee: 12 }), ped(2, '2026-09-11', 100, { fee: 12 })];
    const r = apurarFinanceiro(ps, INI, FIM, mapa([9001, 15], [9002, null]));
    expect(r.frete).toMatchObject({ valor: null, conhecida: -15, fracao: 0.5, completa: false });
    expect(r.tarifaML.completa).toBe(true);
    expect(r.liquido).toBeNull();
  });

  it('nada conhecido: fracao 0, e nenhum numero no lugar do total', () => {
    const r = apurarFinanceiro([ped(1, '2026-09-10', 100)], INI, FIM, new Map());
    expect(r.tarifaML).toMatchObject({ valor: null, conhecida: -0, fracao: 0, completa: false });
    expect(r.frete).toMatchObject({ valor: null, fracao: 0 });
    expect(r.liquido).toBeNull();
    expect(r.liquidoConhecido.pedidos).toBe(0);
  });

  it('so vendas do periodo; cancelado nao entra', () => {
    const ps = [
      ped(1, '2026-09-10', 100, { fee: 10 }), ped(2, '2026-08-31', 500, { fee: 50 }),
      ped(3, '2026-09-12', 700, { fee: 70, status: 'cancelled' }),
    ];
    const r = apurarFinanceiro(ps, INI, FIM, mapa([9001, 5], [9002, 5], [9003, 5]));
    expect(r).toMatchObject({ bruto: 100, pedidos: 1, liquido: 85 });
  });

  it('carrinho: dois pedidos no MESMO envio pagam um frete so, rateado pela receita', () => {
    const ps = [ped(1, '2026-09-10', 100, { fee: 1, envio: 77 }), ped(2, '2026-09-10', 300, { fee: 1, envio: 77 })];
    const r = apurarFinanceiro(ps, INI, FIM, mapa([77, 40]));
    expect(r.frete.valor).toBeCloseTo(-40, 9);   // nao 80
  });

  it('carrinho que atravessa a borda do periodo: cada lado leva a sua fatia', () => {
    const ps = [ped(1, '2026-08-31', 100, { fee: 1, envio: 77 }), ped(2, '2026-09-01', 300, { fee: 1, envio: 77 })];
    const r = apurarFinanceiro(ps, INI, FIM, mapa([77, 40]));
    expect(r.frete.valor).toBeCloseTo(-30, 9);   // 40 x 300/400
  });

  it('periodo sem vendas: tudo completo e zerado — nao ha o que cobrir', () => {
    const r = apurarFinanceiro([], INI, FIM, new Map());
    expect(r).toMatchObject({ bruto: 0, pedidos: 0, liquido: 0 });
    expect(r.tarifaML).toMatchObject({ completa: true, fracao: 1 });
  });
});

// ── pela rota ───────────────────────────────────────────────────────────────
function mockReq(query: Record<string, unknown>, token: string) {
  return { method: 'GET', headers: { authorization: `Bearer ${token}` }, query, body: undefined, socket: { remoteAddress: '10.0.0.1' } } as any;
}
function mockRes() {
  const r: any = { statusCode: 0, headers: {}, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.setHeader = () => r;
  r.send = (b: any) => { r.body = b; return r; };
  r.end = () => r;
  r.json = () => JSON.parse(r.body);
  return r;
}
const OW = 'overwine-ml', DG = 'degustar-ml';
const PERIODO = { from: '2026-09-01', to: '2026-09-30' };
let cache: FakeCache; let cacheDG: Cache; let token: string;

async function publicar(c: Cache, pedidos: OrderSlim[], versao: number) {
  const chave = await writeChunk(c, 'ativos', versao, 0, pedidos);
  const man: OrdersManifest = {
    versao, chunks: [chave], totalRegistros: pedidos.length, newestDate: pedidos[0].date_created,
    oldestDate: pedidos[pedidos.length - 1].date_created, chunkSize: 500, updatedAt: '2026-09-25T00:00:00.000Z', origem: 'full', chunkCounts: [pedidos.length],
  };
  await publishManifest(c, 'ativos', man);
  await c.set('orders:sync:status:ativos', JSON.stringify({ ultimaVersao: versao, totalRegistros: pedidos.length, newestDate: man.newestDate, lastSyncAt: '2026-09-25T00:00:00.000Z', lastResult: 'ok', emAndamento: false }));
}
async function metrics(contas?: string) {
  const res = mockRes();
  await ordersHandler(mockReq({ resource: 'metrics', ...PERIODO, ...(contas ? { contas } : {}) }, token), res);
  return res;
}
const PED_OW = [ped(1002, '2026-09-12', 300, { fee: 99 }), ped(1001, '2026-09-10', 300, { fee: 99 })];

beforeEach(async () => {
  cache = new FakeCache();
  setCacheForTests(cache);
  Object.assign(process.env, TEST_ENV, { MULTI_CONTA_ENABLED: 'true', CONTAS_ATIVAS: DG, ML_DEGUSTAR_USER_ID: '3642371174' });
  resetEnvForTests();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  token = (await createSession(cache)).id;
  cacheDG = cacheDaConta(cache, contaPorId(DG)!);
  await publicar(cache, PED_OW, 7);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CONTAS_ATIVAS; delete process.env.MULTI_CONTA_ENABLED; delete process.env.ML_DEGUSTAR_USER_ID;
});

describe('GET /api/orders/metrics — financeiro por metodo', () => {
  it('Overwine sozinha: a estimativa de sempre, e a tarifa real do snapshot NAO muda nada', async () => {
    const m = (await metrics()).json();
    expect(m.periodo.faturamento).toMatchObject({ bruto: 600, estimado: true, fonte: 'dashboard_legado' });
    expect(m.periodo.faturamento.tarifaML).toBeCloseTo(-600 * 0.148, 9);
    expect(m).not.toHaveProperty('financeiro');
  });

  it('Degustar com tudo conhecido: tarifa, frete e liquido REAIS, sem percentual', async () => {
    await publicar(cacheDG, [ped(2002, '2026-09-15', 100, { fee: 12.5 }), ped(2001, '2026-09-11', 200, { fee: 11, qtd: 2 })], 3);
    await publicarMapaEnvios(cacheDG, mapa([11002, 18.9], [11001, 0]));
    const m = (await metrics(DG)).json();
    const f = m.periodo.faturamento;
    expect(f).toMatchObject({ bruto: 300, estimado: false, fonte: 'apurado_pedidos_envios' });
    expect(f.tarifaML).toBeCloseTo(-34.5, 9);
    expect(f.tarifaEnv).toBeCloseTo(-18.9, 9);
    expect(f.liquido).toBeCloseTo(300 - 34.5 - 18.9, 9);
    // nada a ver com 14,8% e 14,4%
    expect(f.tarifaML).not.toBeCloseTo(-300 * 0.148, 3);
    expect(f.tarifaEnv).not.toBeCloseTo(-300 * 0.144, 3);
    // margem continua sem perfil: custo de produto nao existe
    expect(m.financeiro).toMatchObject({ disponivel: false, motivo: 'perfil_financeiro_nao_configurado', contasSemPerfil: [DG] });
    expect(m.financeiro.conhecido).toMatchObject({ completo: true, metodo: 'apurado_pedidos_envios' });
    expect(m.financeiro.conhecido.liquido).toMatchObject({ receitaCoberta: 300, fracaoReceita: 1 });
    expect(m.financeiro.porConta[DG]).toMatchObject({ metodo: 'apurado_pedidos_envios', bruto: 300 });
  });

  it('Degustar carregada ANTES do campo (sem sale_fee): indisponivel, cobertura 0 — nunca zero', async () => {
    await publicar(cacheDG, [ped(2002, '2026-09-15', 100), ped(2001, '2026-09-11', 200)], 3);
    await publicarMapaEnvios(cacheDG, mapa([11002, 18.9], [11001, 7.1]));
    const m = (await metrics(DG)).json();
    expect(m.periodo.faturamento).toMatchObject({ bruto: 300, tarifaML: null, liquido: null });
    expect(m.periodo.faturamento.tarifaEnv).toBeCloseTo(-26, 9);          // o frete, esse, e conhecido
    const c = m.financeiro.porConta[DG].cobertura;
    expect(c.tarifaML).toMatchObject({ valor: null, fracao: 0, pedidosCobertos: 0, pedidosTotal: 2 });
    expect(c.frete).toMatchObject({ completa: true, fracao: 1 });
    expect(m.financeiro.conhecido.completo).toBe(false);
    expect(m.financeiro.conhecido.liquido).toMatchObject({ valor: 0, receitaCoberta: 0, fracaoReceita: 0 });
  });

  it('Degustar com cobertura parcial: subtotal rotulado, total ausente', async () => {
    await publicar(cacheDG, [ped(2002, '2026-09-15', 100, { fee: 12 }), ped(2001, '2026-09-11', 300)], 3);
    await publicarMapaEnvios(cacheDG, mapa([11002, 10], [11001, 20]));
    const m = (await metrics(DG)).json();
    expect(m.periodo.faturamento.liquido).toBeNull();
    expect(m.financeiro.conhecido).toMatchObject({ completo: false });
    expect(m.financeiro.conhecido.tarifaML).toEqual({ valor: -12, receitaCoberta: 100, fracaoReceita: 0.25 });
    expect(m.financeiro.conhecido.liquido).toEqual({ valor: 78, receitaCoberta: 100, fracaoReceita: 0.25 });
  });

  it('consolidado completo: Overwine estimada + Degustar apurada = total MISTO, declarado', async () => {
    await publicar(cacheDG, [ped(2001, '2026-09-11', 200, { fee: 20 })], 3);
    await publicarMapaEnvios(cacheDG, mapa([11001, 10]));
    const m = (await metrics(`${OW},${DG}`)).json();
    const f = m.periodo.faturamento;
    expect(f).toMatchObject({ bruto: 800, estimado: true, fonte: 'misto' });
    const estOW = { t: -600 * 0.148, e: -600 * 0.144 };
    expect(f.tarifaML).toBeCloseTo(estOW.t - 20, 9);
    expect(f.tarifaEnv).toBeCloseTo(estOW.e - 10, 9);
    expect(f.liquido).toBeCloseTo(600 + estOW.t + estOW.e + (200 - 20 - 10), 9);
    expect(m.financeiro.porConta[OW]).toMatchObject({ metodo: 'estimado_taxas_da_conta', bruto: 600, cobertura: null });
    expect(m.financeiro.porConta[DG]).toMatchObject({ metodo: 'apurado_pedidos_envios', bruto: 200, liquido: 170 });
    expect(m.financeiro.conhecido).toMatchObject({ completo: true, metodo: 'misto' });
    // a tarifa real que veio no snapshot da Overwine (99) NAO substitui a estimativa dela
    expect(m.financeiro.porConta[OW].tarifaML).toBeCloseTo(estOW.t, 9);
  });

  it('consolidado com a Degustar incompleta: o subtotal conhecido nao e apresentado como total', async () => {
    await publicar(cacheDG, [ped(2001, '2026-09-11', 200)], 3);   // sem sale_fee, sem frete
    const m = (await metrics(`${OW},${DG}`)).json();
    const f = m.periodo.faturamento;
    expect(f).toMatchObject({ bruto: 800, tarifaML: null, tarifaEnv: null, liquido: null });
    const k = m.financeiro.conhecido;
    expect(k.completo).toBe(false);
    expect(k.liquido.receitaCoberta).toBe(600);                    // so a Overwine
    expect(k.liquido.fracaoReceita).toBeCloseTo(0.75, 9);
    expect(k.liquido.valor).toBeCloseTo(600 * (1 - 0.148 - 0.144), 9);
    expect(m.financeiro.porConta[DG].liquido).toBeNull();
  });
});
