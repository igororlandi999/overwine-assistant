/**
 * Consolidação de contas nas rotas de LEITURA — etapa 4 do plano multi-conta.
 *
 * O que este arquivo trava:
 *  - a Overwine sozinha (ausente ou `contas=overwine-ml`) responde com o corpo
 *    de sempre: nenhum campo novo, nenhum pedido de outra conta;
 *  - a Degustar sozinha só tem os pedidos dela, MARCADOS, e nenhum custo,
 *    tarifa, líquido ou margem — `null` com o motivo, nunca zero, nunca o
 *    número da Overwine. O cenário usa de propósito o MESMO SKU e o MESMO
 *    título nas duas empresas, que é exatamente o caso real (Arcos do
 *    Convento Bag in Box);
 *  - o consolidado é a união exata das duas bases, com indicadores
 *    RECALCULADOS (ticket médio não é soma de tickets);
 *  - paginação consolidada não repete nem perde pedido, e um cursor de outra
 *    seleção não pagina esta;
 *  - conta sem snapshot torna o consolidado `not_ready` — total parcial não
 *    se apresenta como total.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests, type Cache } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { createSession } from '../src/lib/session.js';
import { contaPorId } from '../src/config/contas.js';
import { cacheDaConta } from '../src/lib/cache/conta-cache.js';
import { type OrdersManifest, writeChunk, publishManifest } from '../src/lib/orders-store.js';
import { publishCatalog, writeCatalogChunk, type CatalogManifest, type ItemSlim } from '../src/lib/items-store.js';
import type { OrderSlim } from '../src/services/orders.service.js';
import ordersHandler from '../api/orders/[resource].js';
import itemsHandler from '../api/items/[resource].js';

function mockReq(o: Partial<{ method: string; headers: Record<string, unknown>; query: Record<string, unknown> }> = {}) {
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

const OW = 'overwine-ml';
const DG = 'degustar-ml';
const AMBAS = `${OW},${DG}`;
const SKU = '21003';
const TITULO = 'Vinho Tinto Portugues Arcos Do Convento Bag In Box 5 Lts';

let cache: FakeCache;
let cacheDG: Cache;
let token: string;

function pedido(id: number, dia: string, valor: number, itemId: string, qtd = 1): OrderSlim {
  return {
    id, status: 'paid', date_created: `${dia}T12:00:00.000-03:00`, paid_amount: valor, total_amount: valor,
    order_items: [{ quantity: qtd, unit_price: valor / qtd, item: { id: itemId, title: TITULO, seller_sku: SKU, variation_id: null } }],
    shipping: { id: id + 900000, logistic_type: null },
  };
}

/** Overwine: 6 pedidos de R$ 300 (ids 1001..1006). Degustar: 3 de R$ 100 (2001..2003). */
const PED_OW: OrderSlim[] = [
  pedido(1006, '2026-09-20', 300, 'MLB-OW1'), pedido(1005, '2026-09-18', 300, 'MLB-OW1'),
  pedido(1004, '2026-09-16', 300, 'MLB-OW1'), pedido(1003, '2026-09-14', 300, 'MLB-OW1'),
  pedido(1002, '2026-09-12', 300, 'MLB-OW1'), pedido(1001, '2026-09-10', 300, 'MLB-OW1'),
];
const PED_DG: OrderSlim[] = [
  pedido(2003, '2026-09-19', 100, 'MLB-DG1'), pedido(2002, '2026-09-15', 100, 'MLB-DG1'),
  pedido(2001, '2026-09-11', 100, 'MLB-DG1'),
];
const PERIODO = { from: '2026-09-01', to: '2026-09-30' };

async function publicar(c: Cache, pedidos: OrderSlim[], versao: number) {
  const chave = await writeChunk(c, 'ativos', versao, 0, pedidos);
  const man: OrdersManifest = {
    versao, chunks: [chave], totalRegistros: pedidos.length,
    newestDate: pedidos[0].date_created, oldestDate: pedidos[pedidos.length - 1].date_created,
    chunkSize: 500, updatedAt: '2026-09-25T00:00:00.000Z', origem: 'full', chunkCounts: [pedidos.length],
  };
  await publishManifest(c, 'ativos', man);
  await c.set('orders:sync:status:ativos', JSON.stringify({
    ultimaVersao: versao, totalRegistros: pedidos.length, newestDate: man.newestDate,
    lastSyncAt: '2026-09-25T00:00:00.000Z', lastResult: 'ok', emAndamento: false,
  }));
}

function anuncio(id: string, saldo: number): ItemSlim {
  return {
    id, title: TITULO, status: 'active', price: 100, original_price: null, available_quantity: saldo,
    sold_quantity: null, listing_type_id: 'gold_special', catalog_listing: false, inventory_id: null,
    permalink: null, thumbnail: null, last_updated: null, seller_custom_field: SKU, seller_sku: null,
    tags: [], shipping: { logistic_type: 'drop_off' }, attributes: null,
  };
}
async function publicarCatalogo(c: Cache, itens: ItemSlim[], versao: number) {
  const chave = await writeCatalogChunk(c, versao, 0, itens);
  const man: CatalogManifest = {
    versao, chunks: [chave],
    counts: { total: itens.length, active: itens.length, paused: 0, closed: 0 },
    chunkSize: 500, updatedAt: new Date().toISOString(), complete: true,
  };
  await publishCatalog(c, man);
}

beforeEach(async () => {
  cache = new FakeCache();
  setCacheForTests(cache);
  Object.assign(process.env, TEST_ENV, {
    MULTI_CONTA_ENABLED: 'true', CONTAS_ATIVAS: DG, ML_DEGUSTAR_USER_ID: '3642371174',
  });
  resetEnvForTests();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  token = (await createSession(cache)).id;
  cacheDG = cacheDaConta(cache, contaPorId(DG)!);
  await publicar(cache, PED_OW, 7);
  await publicar(cacheDG, PED_DG, 3);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CONTAS_ATIVAS; delete process.env.MULTI_CONTA_ENABLED; delete process.env.ML_DEGUSTAR_USER_ID;
});

const auth = () => ({ authorization: `Bearer ${token}` });
async function orders(resource: string, query: Record<string, unknown> = {}) {
  const res = mockRes();
  await ordersHandler(mockReq({ query: { resource, ...query }, headers: auth() }), res);
  return res;
}
async function items(resource: string, query: Record<string, unknown> = {}) {
  const res = mockRes();
  await itemsHandler(mockReq({ query: { resource, ...query }, headers: auth() }), res);
  return res;
}
const semRelogio = (b: any) => {
  const c = JSON.parse(JSON.stringify(b));
  for (const k of ['agora', 'idadeSegundos', 'idadeCheckSegundos']) delete c[k];
  return c;
};

describe('GET /api/orders/contas — o que o seletor pode oferecer', () => {
  it('lista rotulos e capacidades, sem credencial nem prefixo', async () => {
    const res = await orders('contas');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.multiConta).toBe(true);
    const ow = b.contas.find((c: any) => c.id === OW);
    const dg = b.contas.find((c: any) => c.id === DG);
    expect(ow).toMatchObject({ selecionavel: true, financeiro: true, legada: true, canal: 'ml' });
    expect(dg).toMatchObject({ selecionavel: true, financeiro: false, legada: false, empresa: 'degustar' });
    expect(b.contas.find((c: any) => c.id === 'alemmar-amazon')).toMatchObject({ selecionavel: false, motivoIndisponivel: 'conta_inativa' });
    const bruto = res.body as string;
    for (const proibido of ['3642371174', TEST_ENV.ML_USER_ID, 'ML_DEGUSTAR_USER_ID', 'c:degustar-ml:', 'userIdEnv', 'prefixo']) {
      expect(bruto).not.toContain(proibido);
    }
  });

  it('exige sessao', async () => {
    const res = mockRes();
    await ordersHandler(mockReq({ query: { resource: 'contas' } }), res);
    expect(res.statusCode).toBe(401);
  });

  it('com a flag desligada a Degustar aparece como nao selecionavel', async () => {
    delete process.env.MULTI_CONTA_ENABLED;
    const b = (await orders('contas')).json();
    expect(b.multiConta).toBe(false);
    expect(b.contas.find((c: any) => c.id === DG).selecionavel).toBe(false);
    expect(b.contas.find((c: any) => c.id === OW).selecionavel).toBe(true);
  });
});

describe('Overwine sozinha — comportamento de sempre', () => {
  it('status, list, metrics, margin e logistics: contas=overwine-ml e identico ao ausente', async () => {
    for (const [resource, q] of [
      ['status', { alvo: 'ativos' }], ['list', { alvo: 'ativos' }],
      ['metrics', PERIODO], ['margin', PERIODO], ['logistics', {}],
    ] as Array<[string, Record<string, unknown>]>) {
      const a = await orders(resource, q);
      const b = await orders(resource, { ...q, contas: OW });
      expect(b.statusCode, resource).toBe(a.statusCode);
      expect(semRelogio(b.json()), resource).toEqual(semRelogio(a.json()));
    }
  });

  it('a lista nao ganha campo novo nem pedido da Degustar', async () => {
    const b = (await orders('list', { alvo: 'ativos' })).json();
    expect(b.items.map((p: any) => p.id)).toEqual([1006, 1005, 1004, 1003, 1002, 1001]);
    expect(b.versao).toBe(7);
    expect(b).not.toHaveProperty('consolidado');
    for (const p of b.items) expect(p).not.toHaveProperty('conta');
  });

  it('metricas e margem mantem tarifas e custos da Overwine', async () => {
    const m = (await orders('metrics', PERIODO)).json();
    expect(m.periodo.faturamento.bruto).toBe(1800);
    expect(m.periodo.faturamento.liquido).toBeCloseTo(1800 * (1 - 0.148 - 0.144), 6);
    expect(m).not.toHaveProperty('financeiro');
    const g = (await orders('margin', PERIODO)).json();
    expect(g.totais.custoTotal).toBeGreaterThan(0);
    expect(typeof g.totais.margem).toBe('number');
  });
});

describe('Degustar sozinha — so os pedidos dela, sem numero da Overwine', () => {
  it('lista: tres pedidos, todos marcados, nenhum da Overwine', async () => {
    const b = (await orders('list', { alvo: 'ativos', contas: DG })).json();
    expect(b.items.map((p: any) => p.id)).toEqual([2003, 2002, 2001]);
    expect(b.versao).toBe(3);
    expect(b.conta).toBe(DG);
    for (const p of b.items) expect(p).toMatchObject({ conta: DG, canal: 'ml' });
  });

  it('status e o dela', async () => {
    const b = (await orders('status', { alvo: 'ativos', contas: DG })).json();
    expect(b).toMatchObject({ conta: DG, versao: 3, totalRegistros: 3 });
  });

  it('metricas: bruto dela; tarifa e liquido indisponiveis (null), nunca zero', async () => {
    const res = await orders('metrics', { ...PERIODO, contas: DG });
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(m.contas).toEqual([DG]);
    expect(m.consolidado).toBe(false);
    expect(m.periodo.faturamento.bruto).toBe(300);
    expect(m.periodo.faturamento.tarifaML).toBeNull();
    expect(m.periodo.faturamento.tarifaEnv).toBeNull();
    expect(m.periodo.faturamento.liquido).toBeNull();
    expect(m.financeiro).toMatchObject({ disponivel: false, motivo: 'perfil_financeiro_nao_configurado', contasSemPerfil: [DG] });
    // os pedidos deste cenario nao trazem sale_fee nem ha envio resolvido: cobertura zero
    expect(m.financeiro.conhecido).toMatchObject({ completo: false, liquido: { receitaCoberta: 0, fracaoReceita: 0 } });
    expect(m.janelas.historico).toMatchObject({ receita: 300, pedidos: 3, ticketMedio: 100 });
    expect(m.periodo.porItem.map((i: any) => i.itemId)).toEqual(['MLB-DG1']);
  });

  it('margem: MESMO SKU e MESMO titulo da Overwine, e ainda assim sem custo nem margem', async () => {
    const res = await orders('margin', { ...PERIODO, contas: DG });
    expect(res.statusCode).toBe(200);
    const g = res.json();
    expect(g.financeiro.disponivel).toBe(false);
    expect(g.totais.receitaProdutos).toBe(300);
    expect(g.totais.unidades).toBe(3);
    // tarifa e frete: null AQUI porque o cenario nao tem sale_fee nem envio resolvido
    for (const k of ['tarifaML', 'tarifaEnvio', 'receitaLiquida', 'custoTotal', 'margem', 'margemPct', 'receitaComCusto']) {
      expect(g.totais[k], k).toBeNull();
    }
    expect(g.porSku).toHaveLength(1);
    expect(g.porSku[0]).toMatchObject({ conta: DG, sku: SKU, receitaProdutos: 300, custoTotal: null, margem: null, margemPct: null, custoCobertura: null });
    expect(g.semCusto).toBeNull();
    expect(g.frete).toBeNull();
    // o custo da Overwine para este SKU existe — a prova de que nao vazou
    const ow = (await orders('margin', PERIODO)).json();
    expect(ow.porSku[0].custoTotal).toBeGreaterThan(0);
  });
});

describe('consolidado — uniao exata, indicadores recalculados', () => {
  it('status: versao e a soma, e cada conta aparece inteira em porConta', async () => {
    const b = (await orders('status', { alvo: 'ativos', contas: AMBAS })).json();
    expect(b).toMatchObject({
      consolidado: true, contas: [OW, DG], versao: 10, totalRegistros: 9,
      versoes: { [OW]: 7, [DG]: 3 }, contasNaoProntas: [],
      newestDate: PED_OW[0].date_created, oldestDate: PED_OW[5].date_created,
    });
    expect(b.porConta[OW]).toMatchObject({ versao: 7, totalRegistros: 6 });
    expect(b.porConta[DG]).toMatchObject({ versao: 3, totalRegistros: 3 });
  });

  it('a versao consolidada muda quando QUALQUER conta publica', async () => {
    await publicar(cacheDG, [pedido(2004, '2026-09-21', 100, 'MLB-DG1'), ...PED_DG], 4);
    const b = (await orders('status', { alvo: 'ativos', contas: AMBAS })).json();
    expect(b.versao).toBe(11);
    expect(b.totalRegistros).toBe(10);
  });

  it('lista: os 9 pedidos, mais recente primeiro, cada um na conta certa', async () => {
    const b = (await orders('list', { alvo: 'ativos', contas: AMBAS })).json();
    expect(b).toMatchObject({ consolidado: true, versao: 10, totalRegistros: 9, nextCursor: null });
    expect(b.items.map((p: any) => p.id)).toEqual([1006, 2003, 1005, 1004, 2002, 1003, 1002, 2001, 1001]);
    for (const p of b.items) expect(p.conta).toBe(p.id >= 2000 ? DG : OW);
  });

  it('paginacao de 2 em 2: nenhum pedido repetido, nenhum perdido, mesma ordem', async () => {
    const vistos: number[] = [];
    let cursor: string | null = null;
    let paginas = 0;
    do {
      const res = await orders('list', { alvo: 'ativos', contas: AMBAS, pageSize: '2', ...(cursor ? { cursor } : {}) });
      expect(res.statusCode).toBe(200);
      const b = res.json();
      expect(b.items.length).toBeLessThanOrEqual(2);
      vistos.push(...b.items.map((p: any) => p.id));
      cursor = b.nextCursor;
      paginas++;
    } while (cursor && paginas < 20);
    expect(vistos).toEqual([1006, 2003, 1005, 1004, 2002, 1003, 1002, 2001, 1001]);
    expect(paginas).toBe(5);
  });

  it('cursor de outra selecao, de uma conta so, ou adulterado → 400 invalid_cursor', async () => {
    const p1 = (await orders('list', { alvo: 'ativos', contas: AMBAS, pageSize: '2' })).json();
    const invertida = await orders('list', { alvo: 'ativos', contas: `${DG},${OW}`, pageSize: '2', cursor: p1.nextCursor });
    expect(invertida.statusCode).toBe(400);
    const simples = (await orders('list', { alvo: 'ativos', pageSize: '2' })).json();
    const misto = await orders('list', { alvo: 'ativos', contas: AMBAS, pageSize: '2', cursor: simples.nextCursor });
    expect(misto.statusCode).toBe(400);
    expect(misto.json()).toEqual({ error: 'invalid_cursor' });
    const lixo = await orders('list', { alvo: 'ativos', contas: AMBAS, cursor: 'nao-e-cursor!!' });
    expect(lixo.statusCode).toBe(400);
    // e o cursor consolidado nao pagina uma conta so
    const aoContrario = await orders('list', { alvo: 'ativos', cursor: p1.nextCursor });
    expect(aoContrario.statusCode).toBe(400);
  });

  it('publicacao no meio da paginacao: a versao anterior ainda serve; duas depois, snapshot_changed', async () => {
    const p1 = (await orders('list', { alvo: 'ativos', contas: AMBAS, pageSize: '2' })).json();
    await publicar(cacheDG, [pedido(2004, '2026-09-21', 100, 'MLB-DG1'), ...PED_DG], 4);
    const p2 = await orders('list', { alvo: 'ativos', contas: AMBAS, pageSize: '2', cursor: p1.nextCursor });
    expect(p2.statusCode).toBe(200);
    expect(p2.json().servedFrom).toBe('previous');
    await publicar(cacheDG, [pedido(2005, '2026-09-22', 100, 'MLB-DG1'), pedido(2004, '2026-09-21', 100, 'MLB-DG1'), ...PED_DG], 5);
    const p3 = await orders('list', { alvo: 'ativos', contas: AMBAS, pageSize: '2', cursor: p1.nextCursor });
    expect(p3.statusCode).toBe(409);
    expect(p3.json()).toEqual({ error: 'snapshot_changed', versao: 12, totalRegistros: 11 });
  });

  it('metricas: receita e pedidos sao a soma das bases; ticket medio e RECALCULADO', async () => {
    const ow = (await orders('metrics', PERIODO)).json();
    const dg = (await orders('metrics', { ...PERIODO, contas: DG })).json();
    const c = (await orders('metrics', { ...PERIODO, contas: AMBAS })).json();
    expect(c).toMatchObject({ consolidado: true, contas: [OW, DG], versao: 10, versoes: { [OW]: 7, [DG]: 3 } });
    const h = c.janelas.historico;
    expect(h.receita).toBe(ow.janelas.historico.receita + dg.janelas.historico.receita);
    expect(h.pedidos).toBe(ow.janelas.historico.pedidos + dg.janelas.historico.pedidos);
    expect(h.unidades).toBe(9);
    expect(h.receita).toBe(2100);
    // soma dos tickets seria 400; media dos tickets, 200; o certo e 2100 / 9
    expect(h.ticketMedio).toBeCloseTo(2100 / 9, 6);
    expect(c.periodo.faturamento.bruto).toBe(2100);
    expect(c.coverage.totalRegistros).toBe(9);
    expect(c.porStatus).toEqual({ paid: 9 });
    expect(c.periodo.porItem).toEqual([
      { itemId: 'MLB-OW1', pedidos: 6, unidades: 6, receita: 1800 },
      { itemId: 'MLB-DG1', pedidos: 3, unidades: 3, receita: 300 },
    ]);
    expect(c.faturamentoMensal).toHaveLength(1);
    // as partes, para a tela conferir
    expect(c.porConta[OW]).toMatchObject({ totalRegistros: 6, financeiro: true, periodo: { bruto: 1800 } });
    expect(c.porConta[DG]).toMatchObject({ totalRegistros: 3, financeiro: false, periodo: { bruto: 300 } });
    expect(c.porConta[OW].janelas.historico.receita + c.porConta[DG].janelas.historico.receita).toBe(h.receita);
  });

  it('metricas: o liquido nao e o da Overwine aplicado ao total — e indisponivel', async () => {
    const c = (await orders('metrics', { ...PERIODO, contas: AMBAS })).json();
    expect(c.periodo.faturamento).toMatchObject({ bruto: 2100, tarifaML: null, tarifaEnv: null, liquido: null });
    expect(c.financeiro).toMatchObject({ disponivel: false, motivo: 'perfil_financeiro_nao_configurado', contasSemPerfil: [DG] });
  });

  it('margem: o mesmo SKU nas duas empresas sao DUAS linhas, cada uma na sua conta', async () => {
    const g = (await orders('margin', { ...PERIODO, contas: AMBAS })).json();
    expect(g.consolidado).toBe(true);
    expect(g.porSku.map((l: any) => [l.conta, l.sku, l.receitaProdutos])).toEqual([[OW, SKU, 1800], [DG, SKU, 300]]);
    expect(g.totais).toMatchObject({ receitaProdutos: 2100, unidades: 9, skusDistintos: 2, margem: null, custoTotal: null });
    expect(g.financeiro.contasSemPerfil).toEqual([DG]);
  });

  it('logistica: uniao dos mapas', async () => {
    const b = (await orders('logistics', { contas: AMBAS })).json();
    expect(b).toMatchObject({ ok: true, consolidado: true, contas: [OW, DG], total: 0, porTipo: {} });
  });

  it('periodo invalido continua 400', async () => {
    const res = await orders('metrics', { from: '2026-09-30', to: '2026-09-01', contas: AMBAS });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_params', code: 'intervalo_invertido' });
  });
});

describe('consolidado — nada de total parcial', () => {
  it('conta sem snapshot: status avisa, e list/metrics/margin respondem 409', async () => {
    cache = new FakeCache();
    setCacheForTests(cache);
    token = (await createSession(cache)).id;
    await publicar(cache, PED_OW, 7);   // so a Overwine
    const st = (await orders('status', { alvo: 'ativos', contas: AMBAS })).json();
    expect(st.versao).toBeNull();
    expect(st.contasNaoProntas).toEqual([DG]);
    expect((await orders('list', { alvo: 'ativos', contas: AMBAS })).statusCode).toBe(409);
    const m = await orders('metrics', { ...PERIODO, contas: AMBAS });
    expect(m.statusCode).toBe(409);
    expect(m.json()).toEqual({ error: 'not_ready', contasNaoProntas: [DG] });
    expect((await orders('margin', { ...PERIODO, contas: AMBAS })).statusCode).toBe(409);
  });

  it('uma conta invalida na lista derruba a selecao inteira (400), sem responder pela outra', async () => {
    for (const resource of ['status', 'list', 'metrics', 'margin', 'logistics']) {
      const res = await orders(resource, { contas: `${OW},xpto` });
      expect(res.statusCode, resource).toBe(400);
      expect(res.json()).toEqual({ error: 'conta_invalida', conta: 'xpto' });
    }
    const amazon = await orders('status', { contas: `${OW},alemmar-amazon` });
    expect(amazon.statusCode).toBe(400);
    expect(amazon.json().error).toBe('conta_inativa');
  });

  it('com a flag desligada nao ha consolidado nem Degustar', async () => {
    delete process.env.MULTI_CONTA_ENABLED;
    expect((await orders('status', { contas: AMBAS })).statusCode).toBe(400);
    expect((await orders('status', { contas: DG })).statusCode).toBe(400);
    expect((await orders('status', {})).statusCode).toBe(200);
  });

  it('a consolidacao nao escreve nada: as chaves das duas contas ficam como estavam', async () => {
    const chaves = () => [...cache.store.keys()].filter(k => !k.startsWith('rl:')).sort();
    const antes = chaves();
    const valores = antes.map(k => cache.store.get(k)!.v);
    for (const resource of ['status', 'list', 'metrics', 'margin', 'logistics']) {
      await orders(resource, { ...(resource === 'metrics' || resource === 'margin' ? PERIODO : {}), contas: AMBAS });
    }
    expect(chaves()).toEqual(antes);
    expect(antes.map(k => cache.store.get(k)!.v)).toEqual(valores);
  });
});

describe('catalogo e estoque', () => {
  beforeEach(async () => {
    await publicarCatalogo(cache, [anuncio('MLB-OW1', 40), anuncio('MLB-OW2', 5)], 2);
    await publicarCatalogo(cacheDG, [anuncio('MLB-DG1', 8)], 1);
  });

  it('Overwine sozinha: corpo de sempre, sem marca de conta', async () => {
    const a = (await items('catalog')).json();
    const b = (await items('catalog', { contas: OW })).json();
    delete a.freshness.ageSeconds; delete b.freshness.ageSeconds;
    expect(b).toEqual(a);
    expect(a.items.map((i: any) => i.id)).toEqual(['MLB-OW1', 'MLB-OW2']);
    expect(a).not.toHaveProperty('contas');
    for (const i of a.items) expect(i).not.toHaveProperty('conta');
  });

  it('Degustar sozinha: so o anuncio dela', async () => {
    const b = (await items('catalog', { contas: DG })).json();
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ id: 'MLB-DG1', conta: DG });
    expect(b.contas).toEqual([DG]);
    expect(b.counts.total).toBe(1);
  });

  it('consolidado: tres anuncios marcados, contagens somadas', async () => {
    const b = (await items('catalog', { contas: AMBAS })).json();
    expect(b).toMatchObject({ consolidado: true, versao: 3, versoes: { [OW]: 2, [DG]: 1 }, complete: true });
    expect(b.items.map((i: any) => [i.id, i.conta])).toEqual([['MLB-OW1', OW], ['MLB-OW2', OW], ['MLB-DG1', DG]]);
    expect(b.counts).toMatchObject({ total: 3, active: 3 });
  });

  it('estoque consolidado: o mesmo SKU sao duas linhas, e os saldos nao se somam', async () => {
    const res = await items('inventory', { contas: AMBAS, from: '2026-09-01', to: '2026-09-30' });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.consolidado).toBe(true);
    // Cada linha e EXATAMENTE a que a conta devolve sozinha (com a regra de
    // saldo de sempre), so que marcada.
    const q = { from: '2026-09-01', to: '2026-09-30' };
    const ow = (await items('inventory', q)).json().proprio.linhas;
    const dg = (await items('inventory', { ...q, contas: DG })).json().proprio.linhas;
    expect(ow).toHaveLength(1);
    expect(b.proprio.linhas).toEqual([{ ...ow[0], conta: OW }, ...dg]);
    expect(b.proprio.linhas.map((l: any) => [l.conta, l.sku])).toEqual([[OW, SKU], [DG, SKU]]);
    expect(dg[0].estProprio).toBe(8);
    expect(b.proprio.resumo.unidades).toBe(ow[0].estProprio + 8);
  });

  it('estoque da Degustar sozinha aceita contas= (antes era parametro desconhecido)', async () => {
    const res = await items('inventory', { contas: DG });
    expect(res.statusCode).toBe(200);
    expect(res.json().proprio.linhas).toHaveLength(1);
    expect(res.json().proprio.linhas[0]).toMatchObject({ conta: DG, estProprio: 8 });
  });

  it('catalogo de uma conta ausente torna o consolidado 409, e nada e reconstruido no lugar', async () => {
    cache = new FakeCache();
    setCacheForTests(cache);
    token = (await createSession(cache)).id;
    await publicarCatalogo(cache, [anuncio('MLB-OW1', 40)], 2);
    const inv = await items('inventory', { contas: AMBAS });
    expect(inv.statusCode).toBe(409);
    expect(inv.json().contasNaoProntas).toEqual([{ conta: DG, code: 'catalogo_indisponivel' }]);
  });
});
