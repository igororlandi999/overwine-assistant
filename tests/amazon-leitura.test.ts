/**
 * Camada de LEITURA da Amazon: status (contrato oficial), projeção para as
 * telas existentes, FBA × Easy Ship × envio próprio, consolidação com o
 * Mercado Livre, financeiro lançado separado do faturamento, refresh com aba
 * aberta dentro das cotas, e os fluxos de retomada e falta de permissão.
 *
 * A Amazon fica ATIVADA só dentro destes testes (CONTAS_ATIVAS no ambiente do
 * processo de teste); o registro continua com `ativo: false`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { createSession } from '../src/lib/session.js';
import { contaPorId, type Conta } from '../src/config/contas.js';
import { cacheDaConta } from '../src/lib/cache/conta-cache.js';
import { type OrdersManifest, writeChunk, publishManifest, readManifest } from '../src/lib/orders-store.js';
import { readCatalogManifest, writeCatalogChunk, publishCatalog } from '../src/lib/items-store.js';
import type { OrderSlim } from '../src/services/orders.service.js';
import { contaComoVendaAmazon, contaComoVenda, STATUS_VENDA } from '../src/lib/status-venda.js';
import { STATUS_AMAZON, referenciaDeFrescor, CHAVE_CATALOGO_VERIFICADO, projetarPedido, projetarCatalogo, modalidadeDoPedido, statusDeLeitura } from '../src/amazon/leitura.js';
import { normalizarPedido } from '../src/amazon/pedidos.js';
import { normalizarAnuncio } from '../src/amazon/catalogo.js';
import { executarPassoAmazon } from '../src/amazon/sync.service.js';
import { MODELOS, CREDENCIAIS_TESTE, TRAVA_AMAZON_LIGADA, criarAmazonSimulada, exemploOficialSearchOrders, pedidoApi, anuncioApi, transacaoApi, type Cenario } from './amazon-simulada.js';
import syncHandler from '../api/admin/orders-sync.js';
import ordersHandler from '../api/orders/[resource].js';
import refreshHandler from '../api/orders/refresh.js';
import itemsHandler from '../api/items/[resource].js';
import mlHandler from '../api/ml/[op].js';

const AGORA = Date.parse('2026-10-01T12:00:00.000Z');
const BR = 'A2Q3Y263D00KWC';

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
async function chamar(h: (req: any, res: any) => unknown, o: Parameters<typeof mockReq>[0]) { const r = mockRes(); await h(mockReq(o), r); return r; }
const admin = () => ({ 'x-admin-key': TEST_ENV.ADMIN_KEY, 'content-type': 'application/json' });

let cache: FakeCache;
let conta: Conta;
let sessao: string;
const auth = () => ({ authorization: `Bearer ${sessao}` });
const fetchOriginal = globalThis.fetch;
const amzCache = () => cacheDaConta(cache, conta);

function usarAmazon(cen: Cenario) {
  const amz = criarAmazonSimulada(cen);
  amz.usarRelogio(() => Date.now());
  const real = amz.fetch;
  const mlChamadas: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input.url ?? input);
    if (url.includes('mercadolibre.com')) { mlChamadas.push(url); throw new Error('o Mercado Livre não pode ser chamado nestes testes'); }
    return real(input, init);
  }) as typeof fetch;
  return Object.assign(amz, { mlChamadas });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA);
  cache = new FakeCache();
  setCacheForTests(cache);
  Object.assign(process.env, TEST_ENV, CREDENCIAIS_TESTE, TRAVA_AMAZON_LIGADA, { MULTI_CONTA_ENABLED: 'true', CONTAS_ATIVAS: 'alemmar-amazon' });
  resetEnvForTests();
  conta = contaPorId('alemmar-amazon')!;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  sessao = (await createSession(cache)).id;
});
afterEach(() => {
  globalThis.fetch = fetchOriginal;
  for (const k of Object.keys(CREDENCIAIS_TESTE)) delete process.env[k];
  delete process.env.AMZ_ALEMMAR_ENABLED;
  delete process.env.MULTI_CONTA_ENABLED;
  delete process.env.CONTAS_ATIVAS;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Snapshot ML mínimo da Overwine (conta legada), para a consolidação. */
async function publicarOverwine() {
  const pedidos: OrderSlim[] = [
    { id: 1, status: 'paid', date_created: '2026-09-20T10:00:00.000-03:00', paid_amount: 100, total_amount: 100, order_items: [{ quantity: 1, unit_price: 100, item: { id: 'MLB1', title: 'Vinho ML', seller_sku: '21003', variation_id: null } }] },
    { id: 2, status: 'cancelled', date_created: '2026-09-21T10:00:00.000-03:00', paid_amount: 0, total_amount: 50, order_items: [{ quantity: 1, unit_price: 50, item: { id: 'MLB1', title: 'Vinho ML', seller_sku: '21003', variation_id: null } }] },
  ];
  const k = await writeChunk(cache, 'ativos', 1, 0, pedidos);
  const man: OrdersManifest = { versao: 1, chunks: [k], totalRegistros: 2, newestDate: pedidos[1].date_created, oldestDate: pedidos[0].date_created, chunkSize: 500, updatedAt: new Date(AGORA).toISOString(), origem: 'full', chunkCounts: [2] };
  await publishManifest(cache, 'ativos', man);
  await cache.set('orders:sync:status:ativos', JSON.stringify({ ultimaVersao: 1, totalRegistros: 2, newestDate: man.newestDate, lastSyncAt: new Date(AGORA).toISOString(), lastResult: 'ok', emAndamento: false }));
}

// Cenário com as três modalidades, todos os status relevantes e um débito.
function cenarioCompleto(): Cenario {
  const d = (h: number) => new Date(AGORA - h * 3600_000).toISOString();
  return {
    pedidos: [
      pedidoApi('701-0000001-0000001', d(30), { fulfillment: { fulfillmentStatus: 'SHIPPED', fulfilledBy: 'AMAZON' } }),
      pedidoApi('701-0000002-0000002', d(29), { programs: ['AMAZON_EASY_SHIP'], fulfillment: { fulfillmentStatus: 'UNSHIPPED', fulfilledBy: 'MERCHANT' } }),
      pedidoApi('701-0000003-0000003', d(28), { fulfillment: { fulfillmentStatus: 'PARTIALLY_SHIPPED', fulfilledBy: 'MERCHANT' } }),
      pedidoApi('701-0000004-0000004', d(27), { fulfillment: { fulfillmentStatus: 'PENDING', fulfilledBy: 'MERCHANT' } }),
      pedidoApi('701-0000005-0000005', d(26), { fulfillment: { fulfillmentStatus: 'CANCELLED', fulfilledBy: 'AMAZON' } }),
    ],
    anuncios: [anuncioApi('21003', 12), anuncioApi('21004', 0)],
    estoqueFba: [{ sellerSku: '21003', asin: 'B021003', fnSku: 'X21003', totalQuantity: 40, inventoryDetails: { fulfillableQuantity: 35 } }],
    transacoes: [
      transacaoApi('T1', '701-0000001-0000001', d(20), 84.91),
      transacaoApi('T2', '701-0000001-0000001', d(10), -30, 'RELEASED'),
      transacaoApi('T3', null, d(5), -19.9),
    ],
  };
}

async function sincronizar(cen: Cenario) {
  const amz = usarAmazon(cen);
  const r = await chamar(syncHandler, { method: 'POST', headers: admin(), body: { conta: 'alemmar-amazon' } });
  expect(r.statusCode, r.body).toBe(200);
  return amz;
}

// ── 1. Status ──────────────────────────────────────────────────────────────
describe('status Amazon: tabela própria, decidida sobre o contrato', () => {
  it('a tabela cobre exatamente o enum FulfillmentStatus do modelo oficial', () => {
    const en = MODELOS.orders.definitions.FulfillmentStatus.enum as string[];
    expect(Object.keys(STATUS_AMAZON).sort()).toEqual([...en].sort());
  });
  it('Amazon conta tudo menos CANCELLED (regra de exclusão); a classe de exibição não muda', () => {
    for (const s of Object.keys(STATUS_AMAZON)) expect(contaComoVenda(statusDeLeitura(s))).toBe(s !== 'CANCELLED');
    expect(contaComoVenda(statusDeLeitura(null))).toBe(true);           // amazon:desconhecido entra
    expect(contaComoVenda('amazon:status_que_ainda_nao_existe')).toBe(true);
    // A classe de exibição não muda: PENDING continua "pendente".
    expect(STATUS_AMAZON.PENDING).toMatchObject({ classe: 'pendente', rotulo: 'Pendente' });
    // A regra da Amazon nunca alcança status do ML (sem prefixo).
    for (const s of ['SHIPPED', 'PENDING', 'pending', 'cancelled', 'xpto']) expect(contaComoVendaAmazon(s)).toBe(false);
    expect(contaComoVenda('SHIPPED')).toBe(false);
  });
});

// ── 2. Projeção ────────────────────────────────────────────────────────────
describe('projeção para as telas', () => {
  it('FBA, Easy Ship e envio próprio ficam distintos; nada vira "fulfillment" do ML', () => {
    expect(modalidadeDoPedido({ atendidoPor: 'AMAZON', programas: [] })).toBe('amazon_fba');
    expect(modalidadeDoPedido({ atendidoPor: 'MERCHANT', programas: ['AMAZON_EASY_SHIP'] })).toBe('amazon_easy_ship');
    expect(modalidadeDoPedido({ atendidoPor: 'MERCHANT', programas: ['PRIME'] })).toBe('amazon_envio_proprio');
    expect(modalidadeDoPedido({ atendidoPor: null, programas: [] })).toBeNull();
  });
  it('exemplo oficial: status prefixado, valor do produto sem frete/imposto, total pago preservado à parte', () => {
    const o = exemploOficialSearchOrders().orders[0];
    const p = projetarPedido(normalizarPedido(o, 'alemmar-amazon'));
    expect(p.status).toBe('amazon:' + o.fulfillment.fulfillmentStatus.toLowerCase());
    expect(p.canal).toBe('amazon');
    expect(p.amazon.totalPago).toEqual({ valor: Number(o.proceeds.grandTotal.amount), moeda: o.proceeds.grandTotal.currencyCode });
    expect(p.paid_amount).not.toBeNull();
    expect(p.paid_amount!).toBeLessThanOrEqual(Number(o.proceeds.grandTotal.amount));
    expect('sale_fee' in p.order_items[0]).toBe(false);
  });
  it('item cancelado sai do valor; desconto é abatido; sem ITEM cai no preço unitário e marca', () => {
    const base = normalizarPedido(pedidoApi('701-9', '2026-09-30T10:00:00Z', {
      orderItems: [
        { orderItemId: 'a', quantityOrdered: 2, product: { sellerSku: 'S1', price: { unitPrice: { amount: '50.00', currencyCode: 'BRL' } } }, proceeds: { proceedsTotal: { amount: '90.00', currencyCode: 'BRL' }, breakdowns: [{ type: 'ITEM', subtotal: { amount: '100.00', currencyCode: 'BRL' } }, { type: 'DISCOUNT', subtotal: { amount: '-10.00', currencyCode: 'BRL' } }] } },
        { orderItemId: 'b', quantityOrdered: 1, product: { sellerSku: 'S2', price: { unitPrice: { amount: '30.00', currencyCode: 'BRL' } } }, cancellation: { cancellationExecution: { cancelledBy: 'MERCHANT' } } },
        { orderItemId: 'c', quantityOrdered: 3, product: { sellerSku: 'S3', price: { unitPrice: { amount: '20.00', currencyCode: 'BRL' } } } },
      ],
    }), 'alemmar-amazon');
    const p = projetarPedido(base);
    expect(p.paid_amount).toBe(90 + 60);
    expect(p.order_items.map(i => i.item.seller_sku)).toEqual(['S1', 'S3']);
    expect(p.amazon).toMatchObject({ itensCancelados: 1, valorPorPrecoUnitario: true });
  });
  it('catálogo: estoque próprio e FBA em linhas separadas; sem leitura de FBA não há linha FBA', () => {
    const a = normalizarAnuncio(anuncioApi('21003', 12), 'alemmar-amazon', BR);
    const fba = [{ canal: 'amazon' as const, conta: 'alemmar-amazon', sku: '21003', asin: 'B0', fnSku: 'X', disponivel: 35, total: 40, reservado: null, aCaminho: null, indisponivelParaVenda: null, atualizadoEm: null }];
    const com = projetarCatalogo([a], fba, { disponivel: true, motivo: null, verificadoEm: '' });
    expect(com.map(i => [i.id, i.available_quantity, i.shipping?.logistic_type])).toEqual([['21003', 12, 'amazon_proprio'], ['21003#fba', 35, 'amazon_fba']]);
    const sem = projetarCatalogo([a], fba, { disponivel: false, motivo: 'sem_permissao', verificadoEm: '' });
    expect(sem.map(i => i.id)).toEqual(['21003']);
    expect([...com, ...sem].some(i => i.shipping?.logistic_type === 'fulfillment')).toBe(false);
  });
});

// ── 3. Rotas existentes lendo a Amazon ────────────────────────────────────
describe('rotas existentes servem a Amazon (conta ativada só no teste)', () => {
  it('status, lista e catálogo da conta Amazon; o ML nunca é chamado', async () => {
    const amz = await sincronizar(cenarioCompleto());
    const st = (await chamar(ordersHandler, { query: { resource: 'status', alvo: 'ativos', contas: 'alemmar-amazon' }, headers: auth() })).json();
    expect(st).toMatchObject({ conta: 'alemmar-amazon', canal: 'amazon', totalRegistros: 5, lastResult: 'ok' });
    // tempoReal é diagnóstico (só com ?diagnostico=1); na Amazon vem desabilitado.
    expect(st).not.toHaveProperty('tempoReal');
    const diag = (await chamar(ordersHandler, { query: { resource: 'status', alvo: 'ativos', contas: 'alemmar-amazon', diagnostico: '1' }, headers: auth() })).json();
    expect(diag.tempoReal.habilitado).toBe(false);
    expect(st.amazon).toMatchObject({ semAbaAberta: 'reconciliacao_agendada_sem_horario_garantido', ultimoPasso: { ok: true } });
    expect(st.amazon.pedidosLidosAte).toBeTruthy();
    const lista = (await chamar(ordersHandler, { query: { resource: 'list', alvo: 'ativos', contas: 'alemmar-amazon', pageSize: '50' }, headers: auth() })).json();
    const porId = Object.fromEntries(lista.items.map((o: any) => [o.id, o]));
    expect(porId['701-0000001-0000001'].shipping.logistic_type).toBe('amazon_fba');
    expect(porId['701-0000002-0000002'].shipping.logistic_type).toBe('amazon_easy_ship');
    expect(porId['701-0000003-0000003'].shipping.logistic_type).toBe('amazon_envio_proprio');
    const cat = (await chamar(itemsHandler, { query: { resource: 'catalog', contas: 'alemmar-amazon' }, headers: auth() })).json();
    expect(cat.items.map((i: any) => i.id).sort()).toEqual(['21003', '21003#fba', '21004']);
    const inv = await chamar(itemsHandler, { query: { resource: 'inventory', contas: 'alemmar-amazon' }, headers: auth() });
    expect([inv.statusCode, inv.json().error]).toEqual([400, 'recurso_indisponivel_no_canal']);
    const proxy = await chamar(mlHandler, { query: { op: 'reputation', conta: 'alemmar-amazon' }, headers: auth() });
    expect(proxy.statusCode).toBe(400);
    expect(amz.mlChamadas).toEqual([]);
  });

  it('métricas: faturamento de todos menos cancelados (pendente entra); transação lançada NÃO entra no faturamento', async () => {
    await sincronizar(cenarioCompleto());
    const m = (await chamar(ordersHandler, { query: { resource: 'metrics', contas: 'alemmar-amazon', from: '2026-09-01', to: '2026-10-01' }, headers: auth() })).json();
    // 701-1 (SHIPPED), 701-2 (UNSHIPPED), 701-3 (PARTIALLY_SHIPPED), 701-4 (PENDING) = 4 × 99,90. Só CANCELLED fora.
    expect(m.periodo.faturamento.bruto).toBeCloseTo(399.6, 2);
    expect(m.periodo.faturamento).toMatchObject({ tarifaML: null, tarifaEnv: null, liquido: null, fonte: 'transacoes_amazon' });
    const f = m.financeiro.porConta['alemmar-amazon'];
    expect(f.metodo).toBe('transacoes_amazon');
    expect(f.amazon).toMatchObject({
      pedidos: { vendas: 4, comTransacoes: 1, semTransacoesAteLeitura: 3, foraDaLeitura: 0 },
      faturamentoComTransacoes: 99.9, lancadoDessasVendas: 54.91,
      debitos: { pedidos: 1, valor: -30 }, lancamentosSemPedido: { quantidade: 1, valor: -19.9 }, conciliado: false,
    });
    expect(m.financeiro.conhecido.completo).toBe(false);
  });

  it('consolidado Overwine (ML) + Amazon: bruto é a soma; nenhum subtotal do ML recebe a Amazon', async () => {
    await publicarOverwine();
    await sincronizar(cenarioCompleto());
    const so = (await chamar(ordersHandler, { query: { resource: 'metrics', from: '2026-09-01', to: '2026-10-01' }, headers: auth() })).json();
    const m = (await chamar(ordersHandler, { query: { resource: 'metrics', contas: 'overwine-ml,alemmar-amazon', from: '2026-09-01', to: '2026-10-01' }, headers: auth() })).json();
    expect(m.consolidado).toBe(true);
    expect(m.periodo.faturamento.bruto).toBeCloseTo(so.periodo.faturamento.bruto + 399.6, 2);
    expect(m.periodo.faturamento.liquido).toBeNull(); // a Amazon não fecha líquido
    expect(m.financeiro.porConta['overwine-ml'].metodo).toBe('estimado_taxas_da_conta');
    expect(m.financeiro.porConta['alemmar-amazon'].metodo).toBe('transacoes_amazon');
    // A receita coberta do "conhecido" é só a da Overwine.
    expect(m.financeiro.conhecido.liquido.receitaCoberta).toBeCloseTo(so.periodo.faturamento.bruto, 2);
    const st = (await chamar(ordersHandler, { query: { resource: 'status', alvo: 'ativos', contas: 'overwine-ml,alemmar-amazon' }, headers: auth() })).json();
    expect(Object.keys(st.amazon)).toEqual(['alemmar-amazon']);
    expect(st.versoes['overwine-ml']).toBe(1);
  });

  it('a Overwine sozinha continua idêntica com a Amazon publicada ao lado', async () => {
    await publicarOverwine();
    const antes = (await chamar(ordersHandler, { query: { resource: 'metrics', from: '2026-09-01', to: '2026-10-01' }, headers: auth() })).json();
    await sincronizar(cenarioCompleto());
    const depois = (await chamar(ordersHandler, { query: { resource: 'metrics', from: '2026-09-01', to: '2026-10-01' }, headers: auth() })).json();
    expect(depois).toEqual(antes);
  });

  it('sem mudança na Amazon, a versão não cresce (o poll não recarrega à toa)', async () => {
    await sincronizar(cenarioCompleto());
    const v1 = (await readManifest(amzCache(), 'ativos'))!.versao;
    vi.setSystemTime(AGORA + 3600_000);
    await chamar(syncHandler, { method: 'POST', headers: admin(), body: { conta: 'alemmar-amazon' } });
    expect((await readManifest(amzCache(), 'ativos'))!.versao).toBe(v1);
  });
});

// ── 3a. Faturamento Amazon: todos menos cancelados ────────────────────────
describe('faturamento Amazon: tudo entra, só CANCELADO fica fora', () => {
  // 21/10/2026 12:00 em Brasília. Hoje = 21/10; 7 dias = 15/10 a 21/10; mês = 01/10 a 21/10.
  const AGORA_FAT = Date.parse('2026-10-21T15:00:00.000Z');
  function pedidoValor(id: string, quando: string, status: string, valor: number) {
    const p = pedidoApi(id, quando, { fulfillment: { fulfillmentStatus: status, fulfilledBy: 'MERCHANT' } });
    p.orderItems[0].product.price.unitPrice.amount = valor.toFixed(2);
    return p;
  }
  const cenarioFat = (): Cenario => ({
    pedidos: [
      pedidoValor('702-0000001-0000001', '2026-10-21T13:00:00.000Z', 'PENDING', 100),   // hoje
      pedidoValor('702-0000002-0000002', '2026-10-21T14:00:00.000Z', 'SHIPPED', 250),   // hoje
      pedidoValor('702-0000003-0000003', '2026-10-21T14:30:00.000Z', 'CANCELLED', 60),  // hoje, fora
      pedidoValor('702-0000004-0000004', '2026-10-17T15:00:00.000Z', 'PENDING', 40),    // 7 dias e mês
      pedidoValor('702-0000005-0000005', '2026-10-05T15:00:00.000Z', 'UNSHIPPED', 30),  // só mês
      pedidoValor('702-0000008-0000008', '2026-10-10T15:00:00.000Z', 'NOVO_STATUS_FUTURO', 15), // só mês, status desconhecido
      pedidoValor('702-0000006-0000006', '2026-09-25T15:00:00.000Z', 'PENDING', 70),    // setembro
      pedidoValor('702-0000007-0000007', '2026-09-25T16:00:00.000Z', 'CANCELLED', 80),  // setembro, fora
    ],
    anuncios: [anuncioApi('21003', 12)], estoqueFba: [], transacoes: [],
  });
  const metricas = async (q: Record<string, string> = {}) =>
    (await chamar(ordersHandler, { query: { resource: 'metrics', contas: 'alemmar-amazon', ...q }, headers: auth() })).json();

  // A sessão criada no relógio padrão (01/10) já expirou em 21/10: nova sessão no relógio do teste.
  beforeEach(async () => { vi.setSystemTime(AGORA_FAT); sessao = (await createSession(cache)).id; });

  it('1-3. pending, shipped, unshipped e status desconhecido entram; cancelado não; o status bruto é preservado', () => {
    expect(contaComoVenda('amazon:pending')).toBe(true);
    expect(contaComoVenda('amazon:shipped')).toBe(true);
    expect(contaComoVenda('amazon:unshipped')).toBe(true);
    expect(contaComoVenda('amazon:novo_status_futuro')).toBe(true);
    expect(contaComoVenda('amazon:cancelled')).toBe(false);
    const d = projetarPedido(normalizarPedido(pedidoValor('702-8', '2026-10-21T13:00:00.000Z', 'NOVO_STATUS_FUTURO', 15) as any, 'alemmar-amazon'));
    expect(d.status).toBe('amazon:novo_status_futuro');  // status original preservado
    expect(d.amazon.classe).toBe('desconhecido');
    const p = projetarPedido(normalizarPedido(pedidoValor('702-9', '2026-10-21T13:00:00.000Z', 'PENDING', 100) as any, 'alemmar-amazon'));
    expect(p.status).toBe('amazon:pending');            // dado bruto não vira "pago"
    expect(p.amazon.classe).toBe('pendente');
    expect(p.paid_amount).toBe(100);
  });

  it('4-7, 9. mistura pendente + enviado + desconhecido + cancelado: hoje, 7 dias, mês, histórico, quantidade e ticket', async () => {
    await sincronizar(cenarioFat());
    const m = await metricas();
    expect(m.janelas.hoje).toMatchObject({ receita: 350, pedidos: 2, ticketMedio: 175 });
    expect(m.janelas.ultimos7).toMatchObject({ receita: 390, pedidos: 3, ticketMedio: 130 });
    expect(m.janelas.mesAtual).toMatchObject({ receita: 435, pedidos: 5, ticketMedio: 87 });
    expect(m.janelas.historico).toMatchObject({ receita: 505, pedidos: 6 });
    expect(m.janelas.historico.ticketMedio).toBeCloseTo(84.17, 2);
  });

  it('8. período filtrado: pendente entra, cancelado fica fora', async () => {
    await sincronizar(cenarioFat());
    const set = await metricas({ from: '2026-09-20', to: '2026-09-30' });
    expect(set.periodo.faturamento.bruto).toBeCloseTo(70, 2);
    expect(set.financeiro.porConta['alemmar-amazon'].amazon.pedidos.vendas).toBe(1);
    const tudo = await metricas({ from: '2026-09-01', to: '2026-10-21' });
    expect(tudo.periodo.faturamento.bruto).toBeCloseTo(505, 2);
    expect(tudo.financeiro.porConta['alemmar-amazon'].amazon.pedidos.vendas).toBe(6);
  });

  it('10. Mercado Livre sem regressão: a lista do ML e os status do ML não mudam', () => {
    expect([...STATUS_VENDA].sort()).toEqual(['paid', 'partially_refunded']);
    for (const s of ['pending', 'payment_required', 'payment_in_process', 'cancelled', 'invalid']) expect(contaComoVenda(s)).toBe(false);
    expect(contaComoVenda('paid')).toBe(true);
    expect(contaComoVenda('partially_refunded')).toBe(true);
  });
});

// ── 3b. Trava AMZ_ALEMMAR_ENABLED ─────────────────────────────────────────
// Cenário do deploy: credenciais presentes, CONTAS_ATIVAS=alemmar-amazon e
// MULTI_CONTA_ENABLED=true (o beforeEach deste arquivo). Sem a trava em "true",
// a Amazon fica inativa e NENHUMA chamada sai, nem para a LWA.
describe('trava AMZ_ALEMMAR_ENABLED: sem "true", a Amazon fica bloqueada', () => {
  const VALORES_QUE_NAO_LIGAM: Array<string | undefined> = [undefined, '', 'false', '0', '1', 'TRUE', 'True', 'yes', ' true', 'true '];
  const comTrava = (v: string | undefined) => { if (v === undefined) delete process.env.AMZ_ALEMMAR_ENABLED; else process.env.AMZ_ALEMMAR_ENABLED = v; };

  it('pré-condição: com a trava em "true" a conta está ativa (o resto do cenário liga a Amazon)', () => {
    expect(process.env.AMZ_ALEMMAR_ENABLED).toBe('true');
    expect(contaPorId('alemmar-amazon')!.ativo).toBe(true);
  });

  for (const v of VALORES_QUE_NAO_LIGAM) {
    it(`AMZ_ALEMMAR_ENABLED=${JSON.stringify(v)}: conta inativa, rotas recusam, nada chamado nem gravado`, async () => {
      comTrava(v);
      const amz = usarAmazon(cenarioCompleto());
      const c = contaPorId('alemmar-amazon')!;
      expect(c.ativo).toBe(false);

      const admin1 = await chamar(syncHandler, { method: 'POST', headers: admin(), body: { conta: 'alemmar-amazon' } });
      expect([admin1.statusCode, admin1.json().error]).toEqual([400, 'conta_inativa']);
      // Nem o modo preparação da admin passa a trava.
      const admin2 = await chamar(syncHandler, { method: 'POST', headers: admin(), body: { conta: 'alemmar-amazon', preparacao: true } });
      expect([admin2.statusCode, admin2.json().error]).toEqual([400, 'conta_inativa']);
      const refresh = await chamar(refreshHandler, { method: 'POST', headers: auth(), body: { conta: 'alemmar-amazon' } });
      expect([refresh.statusCode, refresh.json().error]).toEqual([400, 'conta_inativa']);
      const leitura = await chamar(ordersHandler, { query: { resource: 'status', contas: 'alemmar-amazon' }, headers: auth() });
      expect([leitura.statusCode, leitura.json().error]).toEqual([400, 'conta_inativa']);

      // Defesa em profundidade: chamado direto, o passo também não roda.
      const passo = await executarPassoAmazon(amzCache(), { ...c, ativo: true });
      expect(passo).toMatchObject({ ok: false, motivo: 'amazon_desabilitada', concluido: false, etapas: {} });

      expect(amz.trocasLwa).toHaveLength(0);
      expect(amz.chamadas).toHaveLength(0);
      expect([...cache.store.keys()].filter(k => k.startsWith('c:alemmar-amazon:'))).toEqual([]);
    });
  }

  it('a resposta do job no GitHub com a trava desligada é a de "passo pulado" (400 conta_inativa)', async () => {
    comTrava(undefined);
    const r = await chamar(syncHandler, { method: 'POST', headers: admin(), body: { conta: 'alemmar-amazon' } });
    // Mesmo critério do orders-sync.yml para pular sem falhar o job.
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.json())).toMatch(/"error":"conta_(inativa|nao_habilitada|sem_credencial|sem_suporte)"/);
  });

  it('a trava não substitui as outras: com "true" mas sem MULTI_CONTA_ENABLED ou sem CONTAS_ATIVAS, continua bloqueada', async () => {
    const amz = usarAmazon(cenarioCompleto());
    delete process.env.MULTI_CONTA_ENABLED;
    const semFlag = await chamar(syncHandler, { method: 'POST', headers: admin(), body: { conta: 'alemmar-amazon' } });
    expect([semFlag.statusCode, semFlag.json().error]).toEqual([400, 'conta_nao_habilitada']);
    process.env.MULTI_CONTA_ENABLED = 'true';
    delete process.env.CONTAS_ATIVAS;
    const semAtivas = await chamar(syncHandler, { method: 'POST', headers: admin(), body: { conta: 'alemmar-amazon' } });
    expect([semAtivas.statusCode, semAtivas.json().error]).toEqual([400, 'conta_inativa']);
    expect(amz.chamadas).toHaveLength(0);
  });

  it('o Mercado Livre não depende da trava', async () => {
    comTrava(undefined);
    expect(contaPorId('overwine-ml')!.ativo).toBe(true);
    const ml = await chamar(ordersHandler, { query: { resource: 'status' }, headers: auth() });
    expect(ml.statusCode).toBe(200);
  });
});

// ── 4. Refresh com aba aberta ─────────────────────────────────────────────
describe('refresh com o dashboard aberto, dentro das cotas', () => {
  it('sincroniza; outra aba no mesmo minuto não chama a Amazon', async () => {
    const amz = usarAmazon(cenarioCompleto());
    const r1 = (await chamar(refreshHandler, { method: 'POST', headers: auth(), body: { conta: 'alemmar-amazon' } })).json();
    expect(r1).toMatchObject({ ok: true, acao: 'sincronizado', publicou: true, canal: 'amazon' });
    const n = amz.chamadas.length;
    const r2 = (await chamar(refreshHandler, { method: 'POST', headers: auth(), body: { conta: 'alemmar-amazon' } })).json();
    expect(r2.acao).toBe('intervalo_minimo');
    expect(amz.chamadas.length).toBe(n);
  });
  it('cota de pedidos esgotada: não chama searchOrders e diz quando poderá', async () => {
    const amz = usarAmazon(cenarioCompleto());
    await amzCache().set('amz:rl:searchOrders', JSON.stringify({ fichas: 0, em: AGORA, rate: 0.0056, burst: 20, fonte: 'contrato' }), 3600);
    const r = (await chamar(refreshHandler, { method: 'POST', headers: auth(), body: { conta: 'alemmar-amazon' } })).json();
    expect(r.acao).toBe('sincronizado');
    expect(r.etapas.pedidos).toMatchObject({ status: 'aguardando_limite', operacao: 'searchOrders' });
    expect(amz.chamadas.some(c => c.operationId === 'searchOrders')).toBe(false);
    expect(Date.parse(r.proximaConsultaPedidosEm)).toBeGreaterThan(AGORA);
    const st = (await chamar(ordersHandler, { query: { resource: 'status', alvo: 'ativos', contas: 'alemmar-amazon' }, headers: auth() })).json();
    expect(st.amazon.proximaConsultaPedidosEm).toBe(r.proximaConsultaPedidosEm);
  });
  it('refresh da Amazon nunca chama o Mercado Livre, e o da Overwine nunca chama a Amazon', async () => {
    const amz = usarAmazon(cenarioCompleto());
    await chamar(refreshHandler, { method: 'POST', headers: auth(), body: { conta: 'alemmar-amazon' } });
    expect(amz.mlChamadas).toEqual([]);
    const n = amz.chamadas.length;
    await publicarOverwine();
    await chamar(refreshHandler, { method: 'POST', headers: auth(), body: {} }).catch(() => null);
    expect(amz.chamadas.length).toBe(n);
  });
});

// ── 4b. Frescor do catálogo: última consulta × última mudança ─────────────
describe('catálogo Amazon: frescor pela última consulta completa, não pela última mudança', () => {
  const H = 3600_000;
  const catalogo = async () => (await chamar(itemsHandler, { query: { resource: 'catalog', contas: 'alemmar-amazon' }, headers: auth() })).json();
  const varreuCatalogo = (amz: { chamadas: Array<{ operationId: string | null }> }, desde: number) => amz.chamadas.slice(desde).some(c => c.operationId === 'searchListingsItems');

  it('referenciaDeFrescor: o mais recente dos dois; valor ausente ou mais antigo não muda nada', () => {
    const a = '2026-10-01T12:00:00.000Z', b = '2026-10-01T14:00:00.000Z';
    expect(referenciaDeFrescor(a, b)).toBe(b);
    expect(referenciaDeFrescor(b, a)).toBe(b);
    expect(referenciaDeFrescor(a, null)).toBe(a);
  });

  it('consulta completa sem mudança: não regrava o catálogo e não acusa desatualizado', async () => {
    await sincronizar(cenarioCompleto());
    const man1 = (await readCatalogManifest(amzCache()))!;
    vi.setSystemTime(AGORA + 2 * H);
    await sincronizar(cenarioCompleto());
    const man2 = (await readCatalogManifest(amzCache()))!;
    expect([man2.versao, man2.updatedAt, man2.chunks]).toEqual([man1.versao, man1.updatedAt, man1.chunks]);
    const cat = await catalogo();
    expect(cat.updatedAt).toBe(new Date(AGORA).toISOString());               // última mudança de conteúdo
    expect(cat.verificadoEm).toBe(new Date(AGORA + 2 * H).toISOString());    // última consulta completa
    expect(cat.freshness).toMatchObject({ ageSeconds: 0, stale: false });
    expect(cat.source).toBe('snapshot');
    expect(cat.warnings).not.toContain('amazon_catalogo_desatualizado');
  });

  it('consulta de anúncios sem sucesso não conta como verificação: continua desatualizado', async () => {
    await sincronizar(cenarioCompleto());
    vi.setSystemTime(AGORA + 7 * H);
    usarAmazon({ ...cenarioCompleto(), semPermissao: ['searchListingsItems'] });
    const r = await executarPassoAmazon(amzCache(), conta);
    expect(r.etapas.anuncios?.status).toBe('sem_permissao');
    expect(await amzCache().get(CHAVE_CATALOGO_VERIFICADO)).toBe(new Date(AGORA).toISOString());
    const cat = await catalogo();
    expect(cat.freshness).toMatchObject({ ageSeconds: 7 * 3600, stale: true });
  });

  it('passo só de pedidos/financeiro não renova a verificação do catálogo', async () => {
    await sincronizar(cenarioCompleto());
    vi.setSystemTime(AGORA + 7 * H);
    usarAmazon(cenarioCompleto());
    await executarPassoAmazon(amzCache(), conta, { etapas: ['pedidos', 'financeiro'] });
    expect((await catalogo()).freshness.stale).toBe(true);
  });

  it('Amazon: desatualizado só depois de 6 h sem consulta completa; updatedAt e verificadoEm mantêm o significado', async () => {
    await sincronizar(cenarioCompleto());
    vi.setSystemTime(AGORA + 2 * H);
    await sincronizar(cenarioCompleto());                                   // consulta completa, conteúdo igual
    vi.setSystemTime(AGORA + 2 * H + 6 * H - 60_000);                       // 5 h 59 min depois da consulta
    let cat = await catalogo();
    expect(cat.freshness).toMatchObject({ stale: false, softTtlSeconds: 6 * 3600 });
    expect(cat.updatedAt).toBe(new Date(AGORA).toISOString());              // última mudança de conteúdo
    expect(cat.verificadoEm).toBe(new Date(AGORA + 2 * H).toISOString());   // última consulta completa
    expect(cat.warnings).not.toContain('amazon_catalogo_desatualizado');
    vi.setSystemTime(AGORA + 2 * H + 6 * H + 60_000);                       // 6 h 1 min
    cat = await catalogo();
    expect(cat.freshness).toMatchObject({ stale: true, softTtlSeconds: 6 * 3600 });
    expect(cat.updatedAt).toBe(new Date(AGORA).toISOString());
    expect(cat.verificadoEm).toBe(new Date(AGORA + 2 * H).toISOString());
  });

  it('Mercado Livre continua com a regra atual (soft TTL do ambiente, 15 min)', async () => {
    const itemMl = { id: 'MLB1', title: 'Vinho ML', status: 'active', seller_custom_field: '21003' } as any;
    const chave = await writeCatalogChunk(cache, 1, 0, [itemMl]);
    await publishCatalog(cache, { versao: 1, chunks: [chave], counts: { total: 1, active: 1, paused: 0, closed: 0 }, chunkSize: 500, updatedAt: new Date(AGORA).toISOString(), complete: true });
    await sincronizar(cenarioCompleto());
    vi.setSystemTime(AGORA + 30 * 60_000);
    const ml = (await chamar(itemsHandler, { query: { resource: 'catalog', contas: 'overwine-ml' }, headers: auth() })).json();
    expect(ml.freshness).toMatchObject({ stale: true, softTtlSeconds: 900, ageSeconds: 1800 });
    expect(ml).not.toHaveProperty('verificadoEm');
    expect((await catalogo()).freshness).toMatchObject({ stale: false, softTtlSeconds: 6 * 3600 });
  });

  it('refresh: catálogo verificado há menos de 6 h não é varrido de novo, mesmo sem mudança há mais de 6 h', async () => {
    await sincronizar(cenarioCompleto());
    vi.setSystemTime(AGORA + 5 * H);
    await sincronizar(cenarioCompleto());
    vi.setSystemTime(AGORA + 7 * H);
    const amz = usarAmazon(cenarioCompleto());
    const r = (await chamar(refreshHandler, { method: 'POST', headers: auth(), body: { conta: 'alemmar-amazon' } })).json();
    expect(r.acao).toBe('sincronizado');
    expect(varreuCatalogo(amz, 0)).toBe(false);
    expect(r.etapas.anuncios).toBeUndefined();
  });

  it('refresh: sem verificação recente (> 6 h), o catálogo é varrido e a verificação renovada', async () => {
    await sincronizar(cenarioCompleto());
    await amzCache().del(CHAVE_CATALOGO_VERIFICADO);
    vi.setSystemTime(AGORA + 7 * H);
    const amz = usarAmazon(cenarioCompleto());
    const r = (await chamar(refreshHandler, { method: 'POST', headers: auth(), body: { conta: 'alemmar-amazon' } })).json();
    expect(r.etapas.anuncios?.status).toBe('concluida');
    expect(varreuCatalogo(amz, 0)).toBe(true);
    expect(await amzCache().get(CHAVE_CATALOGO_VERIFICADO)).toBe(new Date(AGORA + 7 * H).toISOString());
    expect((await catalogo()).freshness.stale).toBe(false);
  });
});

// ── 5. Retomada, paginação e falta de permissão ───────────────────────────
describe('fluxos de retomada e permissão', () => {
  it('sem a função de pedidos (403): etapa "sem_permissao", as outras seguem e a leitura não publica pedido', async () => {
    usarAmazon({ ...cenarioCompleto(), semPermissao: ['searchOrders'] });
    const r = await executarPassoAmazon(amzCache(), conta);
    expect(r.etapas.pedidos).toMatchObject({ status: 'sem_permissao', operacao: 'searchOrders' });
    expect(r.etapas.anuncios?.status).toBe('concluida');
    expect(r.etapas.financeiro?.status).toBe('concluida');
    expect(await readManifest(amzCache(), 'ativos')).toBeNull();
    expect(JSON.parse((await amzCache().get('orders:sync:status:ativos'))!).lastResult).toBe('erro_parcial');
  });
  it('sem a função de anúncios: catálogo não publicado e a rota diz não pronto, sem inventar', async () => {
    usarAmazon({ ...cenarioCompleto(), semPermissao: ['searchListingsItems'] });
    const r = await executarPassoAmazon(amzCache(), conta);
    expect(r.etapas.anuncios?.status).toBe('sem_permissao');
    const cat = await chamar(itemsHandler, { query: { resource: 'catalog', contas: 'alemmar-amazon' }, headers: auth() });
    expect([cat.statusCode, cat.json().code]).toEqual([409, 'amazon_catalogo_nao_sincronizado']);
  });
  it('autorização revogada: nenhuma etapa roda, nada publicado, motivo explícito', async () => {
    usarAmazon({ ...cenarioCompleto(), lwa: 'invalid_grant' });
    const r = await executarPassoAmazon(amzCache(), conta);
    expect(r).toMatchObject({ ok: false, motivo: 'autorizacao_invalida' });
    expect(Object.values(r.etapas).every(e => e?.status === 'nao_executada')).toBe(true);
    expect(await readManifest(amzCache(), 'ativos')).toBeNull();
  });
  it('financeiro: página vazia com nextToken (permitida pelo contrato) não encerra a leitura', async () => {
    usarAmazon({ ...cenarioCompleto(), paginaVaziaFinanceiro: true });
    const r = await executarPassoAmazon(amzCache(), conta, { etapas: ['financeiro'] });
    expect(r.etapas.financeiro).toMatchObject({ status: 'concluida', detalhe: { transacoes: 3 } });
  });
  it('pedidos em várias invocações: leitura publicada só cresce, nunca some pedido entre passos', async () => {
    const muitos = Array.from({ length: 230 }, (_, i) => pedidoApi(`702-${String(i).padStart(7, '0')}-1`, new Date(AGORA - (240 - i) * 3600_000).toISOString()));
    usarAmazon({ pedidos: muitos, anuncios: [], estoqueFba: [], transacoes: [] });
    const totais: number[] = [];
    for (let i = 0; i < 4; i++) {
      await executarPassoAmazon(amzCache(), conta, { etapas: ['pedidos'], orcamentoMs: 60_000 });
      totais.push((await readManifest(amzCache(), 'ativos'))?.totalRegistros ?? 0);
    }
    expect(totais[totais.length - 1]).toBe(230);
    for (let i = 1; i < totais.length; i++) expect(totais[i]).toBeGreaterThanOrEqual(totais[i - 1]);
  });
});
