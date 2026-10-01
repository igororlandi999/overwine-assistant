/**
 * Integração Amazon (alemmar-amazon), contra uma Amazon simulada que confere
 * cada requisição com os modelos OFICIAIS da SP-API (tests/contratos/amazon).
 * Nenhuma credencial real; nada sai da máquina.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { createSession } from '../src/lib/session.js';
import { contaPorId, resolverContaDeAcao, resolverContasDeLeitura, descreverContas, ContaInvalidaError, type Conta } from '../src/config/contas.js';
import { cacheDaConta } from '../src/lib/cache/conta-cache.js';
import { OPERACOES, PEDIDOS_INCLUDED_DATA, ANUNCIOS_INCLUDED_DATA, PEDIDOS_POR_PAGINA_MAX, ANUNCIOS_POR_PAGINA_MAX } from '../src/amazon/contrato.js';
import { lerCredenciais, variaveisAusentes } from '../src/amazon/credenciais.js';
import { obterAccessToken, FalhaLwa, CHAVES_LWA } from '../src/amazon/lwa.js';
import { criarClienteSpApi, ErroSpApi } from '../src/amazon/cliente.js';
import { normalizarPedido, sincronizarPedidos, CHAVES_PEDIDOS, type PedidoAmazon } from '../src/amazon/pedidos.js';
import { sincronizarAnuncios, sincronizarEstoqueFba } from '../src/amazon/catalogo.js';
import { sincronizarFinanceiro, apurarPedido, type TransacaoAmazon } from '../src/amazon/financeiro.js';
import { lerColecao, lerManifesto } from '../src/amazon/store.js';
import { executarPassoAmazon } from '../src/amazon/sync.service.js';
import { MODELOS, CREDENCIAIS_TESTE, criarAmazonSimulada, exemploOficialSearchOrders, validarContraModelo, pedidoApi, anuncioApi, transacaoApi, type Cenario } from './amazon-simulada.js';
import syncHandler from '../api/admin/orders-sync.js';
import ordersHandler from '../api/orders/[resource].js';
import refreshHandler from '../api/orders/refresh.js';

const AGORA = Date.parse('2026-10-01T12:00:00.000Z');
const BR = 'A2Q3Y263D00KWC';

function mockReq(o: Partial<{ method: string; headers: Record<string, unknown>; query: Record<string, unknown>; body: unknown }> = {}) {
  return { method: 'GET', headers: {}, query: {}, body: undefined, socket: { remoteAddress: '10.0.0.9' }, ...o } as any;
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
const admin = () => ({ 'x-admin-key': TEST_ENV.ADMIN_KEY, 'content-type': 'application/json' });

let cache: FakeCache;
let conta: Conta;
const fetchOriginal = globalThis.fetch;

function usarAmazon(cen: Cenario) {
  const amz = criarAmazonSimulada(cen);
  amz.usarRelogio(() => Date.now());
  globalThis.fetch = amz.fetch;
  return amz;
}
const contaCache = () => cacheDaConta(cache, conta);
const credenciais = () => lerCredenciais(conta);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA);
  cache = new FakeCache();
  setCacheForTests(cache);
  Object.assign(process.env, TEST_ENV, CREDENCIAIS_TESTE);
  delete process.env.MULTI_CONTA_ENABLED;
  delete process.env.CONTAS_ATIVAS;
  resetEnvForTests();
  conta = contaPorId('alemmar-amazon')!;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = fetchOriginal;
  for (const k of Object.keys(CREDENCIAIS_TESTE)) delete process.env[k];
  delete process.env.MULTI_CONTA_ENABLED;
  delete process.env.CONTAS_ATIVAS;
  vi.useRealTimers();
  vi.restoreAllMocks();
});


// ── 1. Contrato ────────────────────────────────────────────────────────────
describe('contrato: constantes iguais aos modelos oficiais', () => {
  const modeloDe: Record<string, any> = { searchOrders: MODELOS.orders, getOrder: MODELOS.orders, listTransactions: MODELOS.finances, searchListingsItems: MODELOS.listings, getInventorySummaries: MODELOS.fbaInventory };
  it('caminho, método e limite padrão de cada operação', () => {
    for (const [op, def] of Object.entries(OPERACOES)) {
      const m = modeloDe[op];
      const entrada = Object.entries<any>(m.paths).find(([, x]) => x.get?.operationId === op);
      expect(entrada, op).toBeTruthy();
      expect(entrada![0]).toBe(def.caminho);
      const tabela = /\|\s*([\d.]+)\s*\|\s*(\d+)\s*\|/.exec(entrada![1].get.description)!;
      expect({ rate: Number(tabela[1]), burst: Number(tabela[2]) }, op).toEqual(def.limite);
    }
  });
  it('includedData e tamanhos de página dentro do contrato; nenhum dado pessoal pedido', () => {
    const p = MODELOS.orders.paths['/orders/2026-01-01/orders'].get.parameters;
    expect(p.find((x: any) => x.name === 'includedData').items.enum).toEqual(expect.arrayContaining([...PEDIDOS_INCLUDED_DATA]));
    for (const pessoal of ['BUYER', 'RECIPIENT', 'TAX', 'PAYMENT']) expect(PEDIDOS_INCLUDED_DATA).not.toContain(pessoal);
    // O modelo diz o teto só no texto: "The value must be between 1 and 100".
    const teto = Number(/between 1 and (\d+)/.exec(p.find((x: any) => x.name === 'maxResultsPerPage').description)![1]);
    expect(PEDIDOS_POR_PAGINA_MAX).toBeLessThanOrEqual(teto);
    const l = MODELOS.listings.paths['/listings/2021-08-01/items/{sellerId}'].get.parameters;
    expect(l.find((x: any) => x.name === 'includedData').items.enum).toEqual(expect.arrayContaining([...ANUNCIOS_INCLUDED_DATA]));
    expect(ANUNCIOS_POR_PAGINA_MAX).toBeLessThanOrEqual(l.find((x: any) => x.name === 'pageSize').maximum);
  });
  it('o validador da simulação recusa o que a Amazon recusaria', () => {
    const u = new URL('https://sellingpartnerapi-na.amazon.com/orders/2026-01-01/orders?lastUpdatedAfter=x&includedData=BUYER,XPTO&NextToken=1');
    const v = validarContraModelo(u);
    expect(v.erros).toEqual(expect.arrayContaining(['parâmetro não declarado: NextToken', 'includedData: valor fora do enum: XPTO']));
    expect(validarContraModelo(new URL('https://sellingpartnerapi-na.amazon.com/orders/v0/orders')).erros[0]).toMatch(/não existe/);
  });
  it('o exemplo oficial de searchOrders é lido sem perder pedido, item, SKU, ASIN nem total', () => {
    const ex = exemploOficialSearchOrders();
    const p = normalizarPedido(ex.orders[0], 'alemmar-amazon');
    const o = ex.orders[0];
    expect(p.orderId).toBe(o.orderId);
    expect(p.itens).toHaveLength(o.orderItems.length);
    expect(p.itens[0].sku).toBe(o.orderItems[0].product.sellerSku);
    expect(p.itens[0].asin).toBe(o.orderItems[0].product.asin);
    expect(p.totalPedido).toEqual({ valor: Number(o.proceeds.grandTotal.amount), moeda: o.proceeds.grandTotal.currencyCode });
    expect(p.statusAtendimento).toBe(o.fulfillment.fulfillmentStatus);
    expect(JSON.stringify(p)).not.toContain(o.buyer.buyerEmail); // dado pessoal não é gravado
  });
  it('nada do Mercado Livre entra no módulo Amazon: tarifa, custo, status ou regra de venda', () => {
    for (const f of readdirSync('src/amazon')) {
      // Só o CÓDIGO (sem comentários): a documentação pode citar o ML para dizer o que não se usa.
      const src = readFileSync(join('src/amazon', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/taxas\.json|custos\.json|sale_fee|ml-auth|mercadolibre|ehReembolsoParcial|(?<![A-Z_])STATUS_VENDA(?![A-Z_])|'paid'|partially_refunded/);
      expect(src, f).not.toMatch(/0\.148|14[.,]8|0\.144|14[.,]4/);
    }
  });
});

// ── 2. Autorização ────────────────────────────────────────────────────────
describe('LWA: refresh token e access token', () => {
  it('troca o refresh pelo access, guarda SÓ o access no cache da conta e reaproveita', async () => {
    const amz = usarAmazon({});
    const c = contaCache();
    const t1 = await obterAccessToken(c, credenciais());
    const t2 = await obterAccessToken(c, credenciais());
    expect(t1).toBe(t2);
    expect(amz.trocasLwa).toHaveLength(1);
    expect(amz.trocasLwa[0].get('grant_type')).toBe('refresh_token');
    const tudo = JSON.stringify([...cache.store.entries()]);
    expect(tudo).not.toContain(CREDENCIAIS_TESTE.AMZ_ALEMMAR_REFRESH_TOKEN);
    expect(tudo).not.toContain(CREDENCIAIS_TESTE.AMZ_ALEMMAR_LWA_CLIENT_SECRET);
    expect(cache.store.has('c:alemmar-amazon:' + CHAVES_LWA.access)).toBe(true);
  });
  it('renova perto de expirar, sem trocar o refresh token', async () => {
    const amz = usarAmazon({});
    await obterAccessToken(contaCache(), credenciais());
    vi.setSystemTime(AGORA + 56 * 60_000);
    await obterAccessToken(contaCache(), credenciais());
    expect(amz.trocasLwa).toHaveLength(2);
    expect(amz.trocasLwa.every(t => t.get('refresh_token') === CREDENCIAIS_TESTE.AMZ_ALEMMAR_REFRESH_TOKEN)).toBe(true);
  });
  it('autorização revogada e secret expirado são motivos distintos', async () => {
    usarAmazon({ lwa: 'invalid_grant' });
    await expect(obterAccessToken(contaCache(), credenciais())).rejects.toMatchObject({ motivo: 'autorizacao_invalida' });
    usarAmazon({ lwa: 'invalid_client' });
    await expect(obterAccessToken(contaCache(), credenciais())).rejects.toMatchObject({ motivo: 'credencial_app_invalida' });
  });
  it('access token recusado pela SP-API: renova uma vez e repete a chamada', async () => {
    const amz = usarAmazon({ pedidos: [] });
    const cli = criarClienteSpApi(contaCache(), credenciais());
    await cli.chamar('searchOrders', { query: { lastUpdatedAfter: '2026-09-01T00:00:00Z', marketplaceIds: [BR] } });
    amz.expirarTokens();
    await cli.chamar('searchOrders', { query: { lastUpdatedAfter: '2026-09-01T00:00:00Z', marketplaceIds: [BR] } });
    expect(amz.trocasLwa).toHaveLength(2);
    expect(amz.chamadas.map(c => c.status)).toEqual([200, 403, 200]);
  });
  it('credenciais: só NOMES ausentes, nunca valores', () => {
    delete process.env.AMZ_ALEMMAR_REFRESH_TOKEN;
    expect(variaveisAusentes(conta)).toEqual(['AMZ_ALEMMAR_REFRESH_TOKEN']);
    expect(() => lerCredenciais(conta)).toThrow(/AMZ_ALEMMAR_REFRESH_TOKEN/);
    expect(() => lerCredenciais(conta)).not.toThrow(new RegExp(CREDENCIAIS_TESTE.AMZ_ALEMMAR_LWA_CLIENT_SECRET));
  });
});

// ── 3. Limites ─────────────────────────────────────────────────────────────
describe('limite por operação: balde do contrato, ajustado pelo cabeçalho', () => {
  it('searchOrders: rajada de 20 e depois espera pela reposição (não um intervalo fixo)', async () => {
    usarAmazon({ pedidos: [] });
    const cli = criarClienteSpApi(contaCache(), credenciais(), { esperaMaxMs: 0 });
    const q = { query: { lastUpdatedAfter: '2026-09-01T00:00:00Z', marketplaceIds: [BR] } };
    for (let i = 0; i < 20; i++) await cli.chamar('searchOrders', q);
    const e: any = await cli.chamar('searchOrders', q).catch(x => x);
    expect(e).toBeInstanceOf(ErroSpApi);
    expect(e.motivo).toBe('limite_local');
    expect(e.esperaMs).toBe(Math.ceil(1000 / 0.0056));
    vi.setSystemTime(AGORA + e.esperaMs);
    await expect(cli.chamar('searchOrders', q)).resolves.toBeTruthy();
  });
  it('o valor do cabeçalho x-amzn-RateLimit-Limit substitui o padrão', async () => {
    usarAmazon({ pedidos: [], limiteCabecalho: { searchOrders: 0.05 } });
    const cli = criarClienteSpApi(contaCache(), credenciais(), { esperaMaxMs: 0 });
    await cli.chamar('searchOrders', { query: { lastUpdatedAfter: '2026-09-01T00:00:00Z', marketplaceIds: [BR] } });
    expect((await cli.limites()).searchOrders).toEqual({ rate: 0.05, burst: 20, fonte: 'cabecalho' });
  });
  it('429 da Amazon esvazia o balde e vira "aguardando limite" no passo, sem travar as outras etapas', async () => {
    process.env.MULTI_CONTA_ENABLED = 'true';
    usarAmazon({ pedidos: [pedidoApi('701-0000001-0000001', '2026-09-30T10:00:00Z')], forcar429: { searchOrders: 1 }, anuncios: [], estoqueFba: [], transacoes: [] });
    const r = await executarPassoAmazon(contaCache(), conta);
    expect(r.etapas.pedidos).toMatchObject({ status: 'aguardando_limite', operacao: 'searchOrders' });
    expect(r.etapas.anuncios?.status).toBe('concluida');
    expect(r.etapas.financeiro?.status).toBe('concluida');
    expect(r.concluido).toBe(false);
  });
});

// ── 4. Pedidos ─────────────────────────────────────────────────────────────
describe('pedidos: janela por atualização, retomável', () => {
  const lista = Array.from({ length: 250 }, (_, i) => pedidoApi(`701-${String(i).padStart(7, '0')}-0000001`, new Date(AGORA - (300 - i) * 3600_000).toISOString()));

  it('pagina em várias invocações; o cursor só avança no fim da janela, com limite superior fixo', async () => {
    const amz = usarAmazon({ pedidos: lista });
    const cli = criarClienteSpApi(contaCache(), credenciais());
    const r1 = await sincronizarPedidos(contaCache(), cli, { conta: conta.id, marketplaceId: BR, maxPaginas: 1 });
    expect(r1).toMatchObject({ concluido: false, pedidos: 100, cobertoAte: null });
    vi.setSystemTime(AGORA + 3600_000); // a janela não pode crescer no meio
    const r2 = await sincronizarPedidos(contaCache(), cli, { conta: conta.id, marketplaceId: BR, maxPaginas: 5 });
    expect(r2.concluido).toBe(true);
    expect(r2.janela).toEqual(r1.janela);
    expect(r2.cobertoAte).toBe(r1.janela.ate);
    const antes = amz.chamadas.filter(c => c.operationId === 'searchOrders').map(c => c.url.searchParams.get('lastUpdatedBefore'));
    expect(new Set(antes).size).toBe(1);
    const gravados = await lerColecao<PedidoAmazon>(contaCache(), 'pedidos');
    expect(gravados).toHaveLength(250);
    expect(gravados.every(p => p.conta === 'alemmar-amazon' && p.canal === 'amazon')).toBe(true);
    expect(amz.chamadas.every(c => c.status === 200)).toBe(true);
  });
  it('a janela seguinte começa onde a anterior terminou e atualiza pedido alterado', async () => {
    const pedidos = [pedidoApi('701-0000001-0000001', '2026-09-30T10:00:00Z')];
    usarAmazon({ pedidos });
    const cli = criarClienteSpApi(contaCache(), credenciais());
    const r1 = await sincronizarPedidos(contaCache(), cli, { conta: conta.id, marketplaceId: BR });
    vi.setSystemTime(AGORA + 3 * 3600_000);
    pedidos[0] = pedidoApi('701-0000001-0000001', new Date(AGORA + 3600_000).toISOString(), { fulfillment: { fulfillmentStatus: 'CANCELLED', fulfilledBy: 'MERCHANT' } });
    const r2 = await sincronizarPedidos(contaCache(), cli, { conta: conta.id, marketplaceId: BR });
    expect(r2.janela.de).toBe(r1.janela.ate);
    const g = await lerColecao<PedidoAmazon>(contaCache(), 'pedidos');
    expect(g).toHaveLength(1);
    expect(g[0].statusAtendimento).toBe('CANCELLED');
  });
  it('token de paginação com mais de 24 h: refaz a janela, sem pular pedido', async () => {
    usarAmazon({ pedidos: lista });
    const cli = criarClienteSpApi(contaCache(), credenciais());
    await sincronizarPedidos(contaCache(), cli, { conta: conta.id, marketplaceId: BR, maxPaginas: 1 });
    vi.setSystemTime(AGORA + 25 * 3600_000);
    const r = await sincronizarPedidos(contaCache(), cli, { conta: conta.id, marketplaceId: BR, maxPaginas: 10 });
    expect(r.concluido).toBe(true);
    expect(await lerColecao(contaCache(), 'pedidos')).toHaveLength(250);
    expect(JSON.parse((await contaCache().get(CHAVES_PEDIDOS.cursor))!).ate).toBe(r.janela.ate);
  });
});

// ── 5. Anúncios e estoque ─────────────────────────────────────────────────
describe('anúncios e estoque', () => {
  it('a coleção só é publicada completa; varredura interrompida não aparece', async () => {
    usarAmazon({ anuncios: Array.from({ length: 45 }, (_, i) => anuncioApi(`S${i}`, i)) });
    const cli = criarClienteSpApi(contaCache(), credenciais());
    const r1 = await sincronizarAnuncios(contaCache(), cli, { conta: conta.id, sellerId: CREDENCIAIS_TESTE.AMZ_ALEMMAR_SELLER_ID, marketplaceId: BR, maxPaginas: 2 });
    expect(r1.concluido).toBe(false);
    expect(await lerManifesto(contaCache(), 'anuncios')).toBeNull();
    const r2 = await sincronizarAnuncios(contaCache(), cli, { conta: conta.id, sellerId: CREDENCIAIS_TESTE.AMZ_ALEMMAR_SELLER_ID, marketplaceId: BR });
    expect(r2).toMatchObject({ concluido: true, anuncios: 45 });
    const a = await lerColecao<any>(contaCache(), 'anuncios');
    expect(a).toHaveLength(45);
    expect(a[3]).toMatchObject({ sku: 'S3', asin: 'B0S3', estoqueProprio: 3, preco: { valor: 99.9, moeda: 'BRL' }, status: ['BUYABLE', 'DISCOVERABLE'] });
    expect([...cache.store.keys()].some(k => k.includes(':build:'))).toBe(false);
  });
  it('sem FBA (ou sem a função): estoque FBA indisponível com motivo, nunca zero', async () => {
    usarAmazon({ estoqueFba: 'sem_permissao' });
    const r = await sincronizarEstoqueFba(contaCache(), criarClienteSpApi(contaCache(), credenciais()), { conta: conta.id, marketplaceId: BR });
    expect(r.estado).toMatchObject({ disponivel: false, motivo: 'sem_permissao' });
    expect(await lerManifesto(contaCache(), 'estoque-fba')).toBeNull();
  });
  it('com FBA: disponível, reservado e a caminho separados do estoque próprio', async () => {
    usarAmazon({ estoqueFba: [{ sellerSku: '21003', asin: 'B0X', fnSku: 'X00', totalQuantity: 30, inventoryDetails: { fulfillableQuantity: 20, inboundWorkingQuantity: 5, inboundShippedQuantity: 3, inboundReceivingQuantity: 0, reservedQuantity: { totalReservedQuantity: 2 } } }] });
    const r = await sincronizarEstoqueFba(contaCache(), criarClienteSpApi(contaCache(), credenciais()), { conta: conta.id, marketplaceId: BR });
    expect(r.estado.disponivel).toBe(true);
    expect((await lerColecao<any>(contaCache(), 'estoque-fba'))[0]).toMatchObject({ sku: '21003', disponivel: 20, total: 30, reservado: 2, aCaminho: 8 });
  });
});

// ── 6. Financeiro ─────────────────────────────────────────────────────────
describe('financeiro: o que a Amazon lançou, com a cobertura lida', () => {
  it('janelas de até 180 dias; cobertura só avança com a janela inteira lida', async () => {
    const amz = usarAmazon({ transacoes: [transacaoApi('T1', '701-1', '2026-03-01T00:00:00Z', 80), transacaoApi('T2', '701-2', '2026-09-20T00:00:00Z', 70)] });
    const cli = criarClienteSpApi(contaCache(), credenciais());
    const o = { conta: conta.id, marketplaceId: BR, cargaInicialDias: 365 };
    const r1 = await sincronizarFinanceiro(contaCache(), cli, o);
    const r2 = await sincronizarFinanceiro(contaCache(), cli, o);
    for (const c of amz.chamadas) {
      const d = Date.parse(c.url.searchParams.get('postedBefore')!) - Date.parse(c.url.searchParams.get('postedAfter')!);
      expect(d).toBeLessThanOrEqual(180 * 86_400_000);
    }
    expect(r1.concluido && r2.concluido).toBe(true);
    expect(r2.janela.de).toBe(r1.janela.ate);
    expect(await lerColecao(contaCache(), 'financeiro')).toHaveLength(2);
    expect(r2.cobertura!.desde).toBe(r1.janela.de);
  });
  it('transação retida é relida até ser liberada (a data de lançamento não muda)', async () => {
    const t = [transacaoApi('T9', '701-9', '2026-09-28T00:00:00Z', 50, 'DEFERRED')];
    usarAmazon({ transacoes: t });
    const cli = criarClienteSpApi(contaCache(), credenciais());
    await sincronizarFinanceiro(contaCache(), cli, { conta: conta.id, marketplaceId: BR, cargaInicialDias: 10 });
    t[0] = transacaoApi('T9', '701-9', '2026-09-28T00:00:00Z', 50, 'DEFERRED_RELEASED');
    vi.setSystemTime(AGORA + 3600_000);
    const r = await sincronizarFinanceiro(contaCache(), cli, { conta: conta.id, marketplaceId: BR });
    expect(r.janela.de).toBe('2026-09-28T00:00:00Z');
    expect((await lerColecao<TransacaoAmazon>(contaCache(), 'financeiro'))[0].status).toBe('DEFERRED_RELEASED');
  });
  it('apuração por pedido: fora da cobertura, sem transações até a data lida, recebidas e nunca conciliado', () => {
    const cob = { desde: '2026-09-01T00:00:00Z', ate: '2026-09-30T00:00:00Z' };
    const ts: TransacaoAmazon[] = [
      { ...base('A', '701-1', 85.5), composicao: [{ tipo: 'AmazonFees', valor: { valor: -14.4, moeda: 'BRL' }, partes: [] }] },
      { ...base('B', '701-1', -10), status: 'DEFERRED' },
      base('C', '701-3', 10, 'USD'), base('D', '701-3', 5),
    ];
    // Pedido de 3 dias atrás sem transação: NÃO vira conciliado nem zero por ter passado 48 h.
    expect(apurarPedido({ orderId: '701-2', criadoEm: '2026-09-27T00:00:00Z' }, ts, cob)).toMatchObject({ situacao: 'sem_transacoes', liquidoRecebido: null, conciliado: false, lidoAte: cob.ate });
    expect(apurarPedido({ orderId: '701-5', criadoEm: '2026-10-01T00:00:00Z' }, ts, cob).situacao).toBe('fora_da_cobertura');
    expect(apurarPedido({ orderId: '701-5', criadoEm: '2026-09-10T00:00:00Z' }, ts, null).situacao).toBe('fora_da_cobertura');
    const r = apurarPedido({ orderId: '701-1', criadoEm: '2026-09-10T00:00:00Z' }, ts, cob);
    expect(r).toMatchObject({ situacao: 'transacoes_recebidas', liquidoRecebido: { valor: 75.5, moeda: 'BRL' }, transacoes: 2, retidas: 1, conciliado: false });
    expect(r.porTipo).toEqual([{ tipo: 'AmazonFees', valor: { valor: -14.4, moeda: 'BRL' } }]);
    expect(apurarPedido({ orderId: '701-3', criadoEm: '2026-09-10T00:00:00Z' }, ts, cob)).toMatchObject({ liquidoRecebido: null, moedasMistas: true });
  });
});
function base(id: string, pedido: string, total: number, moeda = 'BRL'): TransacaoAmazon {
  return { canal: 'amazon', conta: 'alemmar-amazon', transactionId: id, tipo: 'Shipment', status: 'RELEASED', descricao: null, lancadaEm: '2026-09-15T00:00:00Z', total: { valor: total, moeda }, pedidoId: pedido, identificadores: [], marketplaceId: BR, composicao: [] };
}

// ── 7. Registro, isolamento e rota ────────────────────────────────────────
describe('alemmar-amazon continua inativa; só a admin a prepara', () => {
  it('registro: inativa, Brasil, leitura e seletor recusam', () => {
    expect(conta).toMatchObject({ ativo: false, canal: 'amazon', prefixo: 'c:alemmar-amazon:', amazon: { marketplaceId: BR, credenciaisEnv: 'AMZ_ALEMMAR' } });
    process.env.MULTI_CONTA_ENABLED = 'true';
    expect(() => resolverContasDeLeitura('alemmar-amazon')).toThrow(ContaInvalidaError);
    expect(descreverContas().contas.find(c => c.id === 'alemmar-amazon')!.selecionavel).toBe(false);
    expect(() => resolverContasDeLeitura('alemmar-amazon')).toThrow(expect.objectContaining({ motivo: 'conta_inativa' }));
    // Ativada por ambiente E com credenciais, a leitura passa a aceitar (é o que a ativação fará).
    process.env.CONTAS_ATIVAS = 'degustar-ml,alemmar-amazon';
    expect(resolverContasDeLeitura('alemmar-amazon')[0].id).toBe('alemmar-amazon');
    // Nenhuma ação que não declare o canal aceita a Amazon (proxy do ML, semeadura, envios).
    expect(() => resolverContaDeAcao('alemmar-amazon')).toThrow(expect.objectContaining({ motivo: 'conta_sem_suporte' }));
  });
  it('rota de admin: inativa sem preparação = 400; preparação sem credencial = 400; nada gravado', async () => {
    process.env.MULTI_CONTA_ENABLED = 'true';
    const r1 = mockRes();
    await syncHandler(mockReq({ method: 'POST', headers: admin(), body: { conta: 'alemmar-amazon' } }), r1);
    expect([r1.statusCode, r1.json().error]).toEqual([400, 'conta_inativa']);
    delete process.env.AMZ_ALEMMAR_SELLER_ID;
    const r2 = mockRes();
    await syncHandler(mockReq({ method: 'POST', headers: admin(), body: { conta: 'alemmar-amazon', preparacao: true } }), r2);
    expect([r2.statusCode, r2.json().error]).toEqual([400, 'conta_sem_credencial']);
    expect([...cache.store.keys()].filter(k => k.startsWith('c:alemmar-amazon:'))).toEqual([]);
  });
  it('rota de admin com preparação: um passo completo, tudo sob o prefixo da conta, nenhuma chave do ML tocada', async () => {
    process.env.MULTI_CONTA_ENABLED = 'true';
    const amz = usarAmazon({
      pedidos: [pedidoApi('701-0000001-0000001', '2026-09-30T10:00:00Z')],
      anuncios: [anuncioApi('21003', 12)], estoqueFba: 'sem_permissao',
      transacoes: [transacaoApi('T1', '701-0000001-0000001', '2026-09-30T20:00:00Z', 84.91)],
    });
    const r = mockRes();
    await syncHandler(mockReq({ method: 'POST', headers: admin(), body: { conta: 'alemmar-amazon', preparacao: true } }), r);
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ ok: true, conta: 'alemmar-amazon', concluido: true });
    expect(b.etapas.estoque_fba).toMatchObject({ status: 'sem_permissao' });
    const chaves = [...cache.store.keys()].filter(k => !k.startsWith('rl:'));
    expect(chaves.length).toBeGreaterThan(0);
    expect(chaves.every(k => k.startsWith('c:alemmar-amazon:'))).toBe(true);
    // Leitura publicada na base da conta, não na do ML.
    expect(chaves).toEqual(expect.arrayContaining(['c:alemmar-amazon:orders:manifest', 'c:alemmar-amazon:items:catalog:manifest']));
    expect(amz.chamadas.every(c => c.status === 200 || c.operationId === 'getInventorySummaries')).toBe(true);
    const corpo = r.body as string;
    for (const v of Object.values(CREDENCIAIS_TESTE)) expect(corpo).not.toContain(v);

    const e = mockRes();
    await syncHandler(mockReq({ method: 'POST', headers: admin(), body: { conta: 'alemmar-amazon', preparacao: true, acao: 'estado' } }), e);
    const est = e.json();
    expect(est).toMatchObject({ ok: true, ativa: false, credenciais: { completas: true, ausentes: [] }, pedidos: { total: 1 }, anuncios: { total: 1 }, financeiro: { transacoes: 1 } });
    for (const v of Object.values(CREDENCIAIS_TESTE)) expect(e.body).not.toContain(v);
  });
  it('etapa desconhecida é 400 antes de qualquer chamada', async () => {
    process.env.MULTI_CONTA_ENABLED = 'true';
    const amz = usarAmazon({});
    const r = mockRes();
    await syncHandler(mockReq({ method: 'POST', headers: admin(), body: { conta: 'alemmar-amazon', preparacao: true, etapas: ['pedidos', 'xpto'] } }), r);
    expect([r.statusCode, r.json().error]).toEqual([400, 'etapa_invalida']);
    expect(amz.chamadas).toHaveLength(0);
  });
  it('dashboard: leitura e refresh com a Amazon continuam recusados', async () => {
    process.env.MULTI_CONTA_ENABLED = 'true';
    const sessao = (await createSession(cache)).id;
    const ler = mockRes();
    await ordersHandler(mockReq({ query: { resource: 'status', alvo: 'ativos', contas: 'alemmar-amazon' }, headers: { authorization: `Bearer ${sessao}` } }), ler);
    expect(ler.statusCode).toBe(400);
    expect(ler.json().error).toBe('conta_inativa');
    const ref = mockRes();
    await refreshHandler(mockReq({ method: 'POST', headers: {}, body: { conta: 'alemmar-amazon' } }), ref);
    expect(ref.statusCode).not.toBe(200);
  });
});

describe('orçamento de tempo da função serverless', () => {
  it('passado o prazo, nenhuma página nova é pedida e o passo fica retomável', async () => {
    process.env.MULTI_CONTA_ENABLED = 'true';
    const amz = usarAmazon({ pedidos: [pedidoApi('701-0000001-0000001', '2026-09-30T10:00:00Z')], anuncios: [], estoqueFba: [], transacoes: [] });
    const r = await executarPassoAmazon(contaCache(), conta, { orcamentoMs: -1 });
    expect(amz.chamadas).toHaveLength(0);
    expect(Object.values(r.etapas).every(e => e?.status === 'nao_executada')).toBe(true);
    expect(r.concluido).toBe(false);
  });
});
