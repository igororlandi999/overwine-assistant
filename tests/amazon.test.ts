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
import { lerCredenciais, marketplaceDaConta, variaveisAusentes } from '../src/amazon/credenciais.js';
import { obterAccessToken, descartarAccessToken, FalhaLwa, CHAVES_LWA } from '../src/amazon/lwa.js';
import type { CredenciaisAmazon } from '../src/amazon/credenciais.js';
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
// O access token vive na memória do módulo: um cache desconhecido zera tudo.
beforeEach(() => descartarAccessToken(new FakeCache()));
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
  it('troca o refresh pelo access, guarda o access SÓ em memória e reaproveita', async () => {
    const amz = usarAmazon({});
    const c = contaCache();
    const t1 = await obterAccessToken(c, credenciais());
    const t2 = await obterAccessToken(c, credenciais());
    expect(t1).toBe(t2);
    expect(amz.trocasLwa).toHaveLength(1);
    expect(amz.trocasLwa[0].get('grant_type')).toBe('refresh_token');
    const tudo = JSON.stringify([...cache.store.entries()]);
    expect(tudo).not.toContain(t1);
    expect(tudo).not.toContain(CREDENCIAIS_TESTE.AMZ_ALEMMAR_REFRESH_TOKEN);
    expect(tudo).not.toContain(CREDENCIAIS_TESTE.AMZ_ALEMMAR_LWA_CLIENT_SECRET);
    expect(cache.store.has('c:alemmar-amazon:' + CHAVES_LWA.access)).toBe(false);
    expect(cache.store.has('c:alemmar-amazon:' + CHAVES_LWA.lock)).toBe(false);
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

// ── 2a. Marketplace: AMZ_ALEMMAR_MARKETPLACE_ID com fallback no registro ──
describe('marketplace da conta', () => {
  afterEach(() => { delete process.env.AMZ_ALEMMAR_MARKETPLACE_ID; });
  const ES = 'A1RKKUPIHCS9HS';
  it('sem a variável, usa o registro (Brasil) e marca a origem', () => {
    delete process.env.AMZ_ALEMMAR_MARKETPLACE_ID;
    expect(marketplaceDaConta(conta)).toEqual({ id: BR, origem: 'registro' });
    expect(lerCredenciais(conta).marketplaceId).toBe(BR);
  });
  it('variável vazia ou só espaços também cai no registro', () => {
    process.env.AMZ_ALEMMAR_MARKETPLACE_ID = '   ';
    expect(marketplaceDaConta(conta)).toEqual({ id: BR, origem: 'registro' });
  });
  it('com a variável válida, ela vence o registro (com trim)', () => {
    process.env.AMZ_ALEMMAR_MARKETPLACE_ID = ` ${BR} `;
    expect(marketplaceDaConta(conta)).toEqual({ id: BR, origem: 'ambiente' });
    process.env.AMZ_ALEMMAR_MARKETPLACE_ID = ES;
    expect(lerCredenciais(conta).marketplaceId).toBe(ES);
  });
  it('variável malformada é erro com o NOME, sem o valor, e não vira ausência de credencial', () => {
    process.env.AMZ_ALEMMAR_MARKETPLACE_ID = 'brasil-xyz';
    expect(() => marketplaceDaConta(conta)).toThrow(/AMZ_ALEMMAR_MARKETPLACE_ID/);
    expect(() => marketplaceDaConta(conta)).not.toThrow(/brasil-xyz/);
    expect(() => lerCredenciais(conta)).toThrow(/AMZ_ALEMMAR_MARKETPLACE_ID/);
    expect(variaveisAusentes(conta)).toEqual([]);
  });
  it('passo com marketplace malformado para antes de qualquer chamada (nem LWA)', async () => {
    process.env.MULTI_CONTA_ENABLED = 'true';
    process.env.AMZ_ALEMMAR_MARKETPLACE_ID = 'invalido';
    const amz = usarAmazon({ pedidos: [], anuncios: [], estoqueFba: [], transacoes: [] });
    const r = await executarPassoAmazon(contaCache(), conta);
    expect(r).toMatchObject({ ok: false, motivo: 'marketplace_invalido', concluido: false });
    expect(amz.trocasLwa).toHaveLength(0);
    expect(amz.chamadas).toHaveLength(0);
  });
  it('passo usa o marketplace da variável em TODAS as chamadas', async () => {
    process.env.MULTI_CONTA_ENABLED = 'true';
    process.env.AMZ_ALEMMAR_MARKETPLACE_ID = ES;
    const amz = usarAmazon({ pedidos: [pedidoApi('701-0000001-0000009', '2026-09-30T10:00:00Z')], anuncios: [], estoqueFba: [], transacoes: [] });
    const r = await executarPassoAmazon(contaCache(), conta);
    expect(r.ok).toBe(true);
    expect(amz.chamadas.length).toBeGreaterThan(0);
    for (const c of amz.chamadas) {
      const ids = [c.url.searchParams.get('marketplaceIds'), c.url.searchParams.get('marketplaceId'), c.url.searchParams.get('granularityId')].filter(Boolean);
      expect(ids.length).toBeGreaterThan(0);
      for (const v of ids) expect(v).toBe(ES);
    }
  });
});

// ── 2b. Access token só em memória (A6) ───────────────────────────────────
describe('LWA: access token só na memória da instância', () => {
  type RespostaLwa = { status: number; corpo?: unknown; texto?: string } | 'rede';
  const credA = (o: Partial<CredenciaisAmazon> = {}): CredenciaisAmazon =>
    ({ clientId: 'amzn1.app.A', clientSecret: 'segredo-A', refreshToken: 'Atzr|refresh-A', sellerId: 'SA', marketplaceId: BR, ...o });
  const credB = () => credA({ clientId: 'amzn1.app.B', clientSecret: 'segredo-B', refreshToken: 'Atzr|refresh-B', sellerId: 'SB' });
  const ok = (n: number, corpo: URLSearchParams, expires_in: unknown = 3600): RespostaLwa =>
    ({ status: 200, corpo: { access_token: `Atza|${corpo.get('client_id')}-${n}`, token_type: 'bearer', expires_in } });

  /** LWA falsa: conta as trocas; `responder` decide cada resposta (padrão: token novo, 3600 s). */
  function lwa(responder: (n: number, corpo: URLSearchParams) => RespostaLwa | Promise<RespostaLwa> = ok) {
    const trocas: URLSearchParams[] = [];
    globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
      const corpo = new URLSearchParams(String(init.body));
      trocas.push(corpo);
      const r = await responder(trocas.length, corpo);
      if (r === 'rede') throw new TypeError('fetch failed');
      return new Response(r.texto ?? JSON.stringify(r.corpo ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return trocas;
  }
  function portao() {
    let abrir!: () => void;
    const p = new Promise<void>(r => { abrir = r; });
    return { p, abrir };
  }
  /** Cache que registra toda operação, para provar que a LWA não toca o Redis. */
  function espiar(base: FakeCache) {
    const ops: string[] = [];
    const c = new Proxy(base, {
      get(t, k, r) {
        const v = Reflect.get(t, k, r);
        return typeof v === 'function' ? (...a: unknown[]) => { ops.push(`${String(k)} ${String(a[0])}`); return v.apply(t, a); } : v;
      },
    });
    return { c, ops };
  }

  it('nenhuma operação no Redis: nem leitura, nem escrita, nem trava', async () => {
    lwa();
    const { c, ops } = espiar(new FakeCache());
    await obterAccessToken(c, credA());
    await obterAccessToken(c, credA(), { forcar: true });
    await descartarAccessToken(c);
    await obterAccessToken(c, credA());
    expect(ops).toEqual([]);
  });
  it('um access token deixado no Redis por versão antiga é ignorado', async () => {
    const trocas = lwa();
    const c = new FakeCache();
    await c.set(CHAVES_LWA.access, JSON.stringify({ token: 'Atza|antigo-do-redis', expiraEm: Date.now() + 3600_000 }), 3600);
    const t = await obterAccessToken(c, credA());
    expect(t).not.toBe('Atza|antigo-do-redis');
    expect(trocas).toHaveLength(1);
  });
  it('o código do módulo não chama nenhum método do cache', () => {
    const src = readFileSync('src/amazon/lwa.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/cache\s*\.\s*(get|set|setNX|del|delIfEquals|incr|rpush|lpopMany|llen)\s*\(/);
    // A chave da memória é um hash; nenhum segredo vira chave em texto puro.
    expect(src).toMatch(/createHash\('sha256'\)/);
  });
  it('reaproveita o token entre wrappers e caches diferentes da mesma credencial', async () => {
    const trocas = lwa();
    const t1 = await obterAccessToken(new FakeCache(), credA());
    const t2 = await obterAccessToken(new FakeCache(), credA());
    const t3 = await obterAccessToken(contaCache(), credA());
    expect(new Set([t1, t2, t3]).size).toBe(1);
    expect(trocas).toHaveLength(1);
  });
  it('renova antes do vencimento: reaproveita com 5 min + 1 s restantes, renova com 5 min', async () => {
    const trocas = lwa();
    const t1 = await obterAccessToken(new FakeCache(), credA());
    vi.setSystemTime(AGORA + 55 * 60_000 - 1000);
    expect(await obterAccessToken(new FakeCache(), credA())).toBe(t1);
    vi.setSystemTime(AGORA + 55 * 60_000);
    const t2 = await obterAccessToken(new FakeCache(), credA());
    expect(t2).not.toBe(t1);
    expect(trocas).toHaveLength(2);
  });
  it('token já expirado nunca é devolvido', async () => {
    const trocas = lwa();
    const t1 = await obterAccessToken(new FakeCache(), credA());
    vi.setSystemTime(AGORA + 2 * 3600_000);
    expect(await obterAccessToken(new FakeCache(), credA())).not.toBe(t1);
    expect(trocas).toHaveLength(2);
  });
  it('expires_in ausente, zero, negativo ou inválido vale 3600 s', async () => {
    for (const exp of [undefined, 0, -5, 'abc']) {
      await descartarAccessToken(new FakeCache());
      vi.setSystemTime(AGORA);
      const trocas = lwa((n, corpo) => ok(n, corpo, exp));
      await obterAccessToken(new FakeCache(), credA());
      vi.setSystemTime(AGORA + 54 * 60_000);
      await obterAccessToken(new FakeCache(), credA());
      expect(trocas, String(exp)).toHaveLength(1);
    }
  });
  it('expires_in menor que a margem não renova a cada chamada: reusa até a metade da vida', async () => {
    const trocas = lwa((n, corpo) => ok(n, corpo, 120));
    const t1 = await obterAccessToken(new FakeCache(), credA());
    expect(await obterAccessToken(new FakeCache(), credA())).toBe(t1);
    vi.setSystemTime(AGORA + 59_000);
    expect(await obterAccessToken(new FakeCache(), credA())).toBe(t1);
    expect(trocas).toHaveLength(1);
    vi.setSystemTime(AGORA + 61_000);
    expect(await obterAccessToken(new FakeCache(), credA())).not.toBe(t1);
    expect(trocas).toHaveLength(2);
  });
  it('10 chamadas simultâneas compartilham UMA renovação', async () => {
    const g = portao();
    const trocas = lwa(async (n, corpo) => { await g.p; return ok(n, corpo); });
    const todas = Array.from({ length: 10 }, () => obterAccessToken(new FakeCache(), credA()));
    g.abrir();
    const tokens = await Promise.all(todas);
    expect(new Set(tokens).size).toBe(1);
    expect(trocas).toHaveLength(1);
  });
  it('falha compartilhada rejeita todas e não deixa renovação presa', async () => {
    const g = portao();
    let falhar = true;
    const trocas = lwa(async (n, corpo) => { await g.p; return falhar ? { status: 503, corpo: {} } : ok(n, corpo); });
    const todas = Array.from({ length: 5 }, () => obterAccessToken(new FakeCache(), credA()));
    g.abrir();
    const r = await Promise.allSettled(todas);
    expect(r.every(x => x.status === 'rejected' && x.reason instanceof FalhaLwa && x.reason.motivo === 'lwa_indisponivel')).toBe(true);
    expect(trocas).toHaveLength(1);
    falhar = false;
    await expect(obterAccessToken(new FakeCache(), credA())).resolves.toMatch(/^Atza\|/);
    expect(trocas).toHaveLength(2);
  });
  it('credenciais diferentes ficam isoladas, e o descarte de uma não afeta a outra', async () => {
    const trocas = lwa();
    const cA = new FakeCache(); const cB = new FakeCache();
    const [a1, b1] = await Promise.all([obterAccessToken(cA, credA()), obterAccessToken(cB, credB())]);
    expect(a1).not.toBe(b1);
    expect(a1).toContain('amzn1.app.A');
    expect(b1).toContain('amzn1.app.B');
    expect(trocas).toHaveLength(2);
    await descartarAccessToken(cA);
    const a2 = await obterAccessToken(cA, credA());
    expect(a2).not.toBe(a1);
    expect(await obterAccessToken(cB, credB())).toBe(b1);
    expect(trocas).toHaveLength(3);
  });
  it('secret ou refresh token rotacionado não usa o token da credencial anterior', async () => {
    const trocas = lwa();
    const t1 = await obterAccessToken(new FakeCache(), credA());
    expect(await obterAccessToken(new FakeCache(), credA({ clientSecret: 'segredo-A2' }))).not.toBe(t1);
    expect(await obterAccessToken(new FakeCache(), credA({ refreshToken: 'Atzr|refresh-A2' }))).not.toBe(t1);
    expect(trocas).toHaveLength(3);
  });
  it('forcar troca um token ainda válido e o novo passa a ser o reaproveitado', async () => {
    const trocas = lwa();
    const t1 = await obterAccessToken(new FakeCache(), credA());
    const t2 = await obterAccessToken(new FakeCache(), credA(), { forcar: true });
    expect(t2).not.toBe(t1);
    expect(await obterAccessToken(new FakeCache(), credA())).toBe(t2);
    expect(trocas).toHaveLength(2);
  });
  it('descartar com OUTRO wrapper do mesmo cache também obriga a renovar', async () => {
    const trocas = lwa();
    const t1 = await obterAccessToken(contaCache(), credA());
    await descartarAccessToken(contaCache());
    expect(await obterAccessToken(contaCache(), credA())).not.toBe(t1);
    expect(trocas).toHaveLength(2);
  });
  it('renovação que falha depois de descarte ou forcar nunca devolve o token antigo', async () => {
    let erro: string | null = null;
    const trocas = lwa((n, corpo) => erro ? { status: 400, corpo: { error: erro } } : ok(n, corpo));
    const c = new FakeCache();
    const t1 = await obterAccessToken(c, credA());
    erro = 'invalid_grant';
    await descartarAccessToken(c);
    await expect(obterAccessToken(c, credA())).rejects.toMatchObject({ motivo: 'autorizacao_invalida' });
    await expect(obterAccessToken(c, credA())).rejects.toMatchObject({ motivo: 'autorizacao_invalida' });
    erro = null;
    const t2 = await obterAccessToken(c, credA());
    erro = 'invalid_client';
    await expect(obterAccessToken(c, credA(), { forcar: true })).rejects.toMatchObject({ motivo: 'credencial_app_invalida' });
    await expect(obterAccessToken(c, credA())).rejects.toMatchObject({ motivo: 'credencial_app_invalida' });
    expect([t1, t2]).toHaveLength(2);
    expect(trocas).toHaveLength(6);
  });
  it('renovação na margem que falha não devolve o token em cache', async () => {
    let falhar = false;
    const trocas = lwa((n, corpo) => falhar ? { status: 500, corpo: {} } : ok(n, corpo));
    await obterAccessToken(new FakeCache(), credA());
    vi.setSystemTime(AGORA + 57 * 60_000);
    falhar = true;
    await expect(obterAccessToken(new FakeCache(), credA())).rejects.toBeInstanceOf(FalhaLwa);
    await expect(obterAccessToken(new FakeCache(), credA())).rejects.toBeInstanceOf(FalhaLwa);
    expect(trocas).toHaveLength(3);
  });
  it('forcar durante uma renovação em voo junta-se a ela e recebe o token novo', async () => {
    let g: ReturnType<typeof portao> | null = null;
    const trocas = lwa(async (n, corpo) => { if (g) await g.p; return ok(n, corpo); });
    const t1 = await obterAccessToken(new FakeCache(), credA());
    vi.setSystemTime(AGORA + 56 * 60_000);
    g = portao();
    const p1 = obterAccessToken(new FakeCache(), credA());
    const p2 = obterAccessToken(new FakeCache(), credA(), { forcar: true });
    g.abrir();
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(b);
    expect(a).not.toBe(t1);
    expect(trocas).toHaveLength(2);
  });
  it('descarte durante uma renovação em voo: o token recém-emitido é guardado', async () => {
    let g: ReturnType<typeof portao> | null = null;
    const trocas = lwa(async (n, corpo) => { if (g) await g.p; return ok(n, corpo); });
    const c = new FakeCache();
    const t1 = await obterAccessToken(c, credA());
    g = portao();
    const p = obterAccessToken(c, credA(), { forcar: true });
    await descartarAccessToken(c);
    g.abrir();
    const t2 = await p;
    expect(t2).not.toBe(t1);
    expect(await obterAccessToken(c, credA())).toBe(t2);
    expect(trocas).toHaveLength(2);
  });
  it('cada erro da LWA vira o motivo certo e nada fica guardado', async () => {
    const casos: Array<[RespostaLwa, string]> = [
      [{ status: 400, corpo: { error: 'invalid_grant' } }, 'autorizacao_invalida'],
      [{ status: 401, corpo: { error: 'invalid_client' } }, 'credencial_app_invalida'],
      [{ status: 400, corpo: { error: 'unauthorized_client' } }, 'credencial_app_invalida'],
      [{ status: 503, corpo: {} }, 'lwa_indisponivel'],
      [{ status: 200, corpo: { token_type: 'bearer' } }, 'lwa_indisponivel'],
      [{ status: 502, texto: '<html>Bad Gateway</html>' }, 'lwa_indisponivel'],
      ['rede', 'lwa_indisponivel'],
    ];
    for (const [resp, motivo] of casos) {
      let falhar = true;
      const trocas = lwa((n, corpo) => falhar ? resp : ok(n, corpo));
      const e = await obterAccessToken(new FakeCache(), credA()).catch(x => x);
      expect(e, motivo).toBeInstanceOf(FalhaLwa);
      expect(e.name).toBe('FalhaLwa');
      expect(e.motivo, JSON.stringify(resp)).toBe(motivo);
      falhar = false;
      await obterAccessToken(new FakeCache(), credA());
      expect(trocas).toHaveLength(2);
      await descartarAccessToken(new FakeCache());
    }
  });
  it('timeout da LWA vira lwa_indisponivel e libera a próxima tentativa', async () => {
    // Captura o timer do módulo para dispará-lo na hora, sem esperar 10 s de verdade.
    const timers: Array<{ fn: () => void; ms: number }> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => { timers.push({ fn, ms }); return 0; }) as unknown as typeof setTimeout);
    let pendurar = true;
    let trocas = 0;
    globalThis.fetch = ((_u: unknown, init: RequestInit = {}) => {
      trocas++;
      if (!pendurar) return Promise.resolve(new Response(JSON.stringify({ access_token: 'Atza|depois', expires_in: 3600 }), { status: 200 }));
      return new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('abortado', 'AbortError'))));
    }) as typeof fetch;
    const p = obterAccessToken(new FakeCache(), credA()).catch(x => x);
    expect(timers.map(t => t.ms)).toEqual([10_000]);
    timers[0].fn();
    expect(await p).toMatchObject({ motivo: 'lwa_indisponivel' });
    pendurar = false;
    expect(await obterAccessToken(new FakeCache(), credA())).toBe('Atza|depois');
    expect(trocas).toBe(2);
  });
  it('nenhum token, segredo ou corpo da LWA aparece em erro ou log', async () => {
    const segredos = ['Atzr|refresh-A', 'segredo-A', 'DESCRICAO-SENSIVEL'];
    let erro: string | null = null;
    lwa((n, corpo) => erro ? { status: 400, corpo: { error: erro, error_description: 'DESCRICAO-SENSIVEL Atzr|refresh-A' } } : ok(n, corpo));
    const t = await obterAccessToken(new FakeCache(), credA());
    const mensagens: string[] = [];
    for (const e of ['invalid_grant', 'invalid_client', 'server_error']) {
      erro = e;
      const x = await obterAccessToken(new FakeCache(), credA(), { forcar: true }).catch(y => y);
      mensagens.push(String(x.message), String(x.stack));
    }
    const logs = (['info', 'warn', 'error'] as const).flatMap(m => (console[m] as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().map(String));
    for (const s of [...segredos, t]) for (const m of [...mensagens, ...logs]) expect(m).not.toContain(s);
  });
  it('outra instância (módulo novo) renova sozinha, sem compartilhar o token', async () => {
    const trocas = lwa();
    const t1 = await obterAccessToken(new FakeCache(), credA());
    vi.resetModules();
    const outra = await import('../src/amazon/lwa.js');
    const t2 = await outra.obterAccessToken(new FakeCache(), credA());
    expect(t2).not.toBe(t1);
    expect(trocas).toHaveLength(2);
    expect(await obterAccessToken(new FakeCache(), credA())).toBe(t1);
  });
  it('403 de token inválido na SP-API: exatamente UMA troca extra e nada no Redis', async () => {
    const amz = usarAmazon({ pedidos: [] });
    const cli = criarClienteSpApi(contaCache(), credenciais());
    await cli.chamar('searchOrders', { query: { lastUpdatedAfter: '2026-09-01T00:00:00Z', marketplaceIds: [BR] } });
    amz.expirarTokens();
    await cli.chamar('searchOrders', { query: { lastUpdatedAfter: '2026-09-01T00:00:00Z', marketplaceIds: [BR] } });
    expect(amz.trocasLwa).toHaveLength(2);
    expect(amz.chamadas.map(c => c.status)).toEqual([200, 403, 200]);
    expect([...cache.store.keys()].filter(k => k.includes('amz:lwa'))).toEqual([]);
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
