import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { createSession } from '../src/lib/session.js';
import handler from '../api/chat.js';
import {
  publishCatalog, writeCatalogChunk,
  type CatalogManifest, type ItemSlim,
} from '../src/lib/items-store.js';
import {
  publishManifest, writeChunk, type OrdersManifest,
} from '../src/lib/orders-store.js';
import type { OrderSlim } from '../src/services/orders.service.js';
import { hojeBRT } from '../src/lib/datas-brt.js';

// ── mocks mínimos de Vercel req/res (mesmo padrão de chat.route.test) ──
function mockReq(o: Partial<{ method: string; headers: Record<string, unknown>; body: unknown }> = {}) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: {}, ...o } as any;
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

const MODELO = 'gemini-3.5-flash-lite';
function geminiOk(texto: string) {
  return {
    candidates: [{ content: { parts: [{ text: texto }], role: 'model' }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
    modelVersion: MODELO,
  };
}

let fetchCalls: Array<{ url: string; init: any }> = [];
function mockProvedor() {
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => geminiOk('Resposta.') } as any;
  }));
}

/**
 * Contexto 1.0.0 VÁLIDO, com números de estoque propositalmente absurdos: se
 * qualquer um deles aparecer no que vai ao provedor, o caminho de estoque
 * voltou a depender da tela.
 */
function ctxValido() {
  return {
    schema: 'overwine.chat.context',
    schemaVersion: '1.0.0',
    geradoEm: '2026-07-24T18:00:00.000Z',
    periodo: { hojeBRT: '2026-07-24', tz: 'America/Sao_Paulo' },
    origem: { ordersServedFrom: 'snapshot', snapshotVersao: 10, snapshotUpdatedAt: '2026-07-24T10:00:00Z', snapshotPartial: false },
    readiness: { ready: true, ordersLoaded: true, itemsLoaded: true, sourceKnown: true, warnings: [], blockers: [] },
    pedidos: {
      total: 3, pagos: 2, cancelados: 1, parcialmenteReembolsados: 0,
      hoje: { qtd: 1, faturamento: 100 }, ultimos7: { qtd: 2, faturamento: 150 },
      mesAtual: { qtd: 2, faturamento: 150 }, ticketMedioGeral: 75, ticketMedioMesAtual: 75,
    },
    estoque: {
      anunciosTotais: 5, ativos: 4, pausados: 1, encerrados: 0, semEstoque: 0,
      estoqueProprioUnidades: 999999, estoqueFullUnidades: 888888,
      riscoRuptura: { disponivel: true, qtdSkus: 77 },
    },
    avisos: [],
  };
}

function body(message: string) {
  return { message, context: ctxValido(), conversation: { id: 'abc12345' } };
}

// ── fixtures de catálogo ──
function item(o: Partial<ItemSlim> & { id: string }): ItemSlim {
  return {
    title: 'Vinho ' + o.id, status: 'active', price: 100, original_price: null,
    available_quantity: 0, sold_quantity: null, listing_type_id: 'gold_special',
    catalog_listing: false, inventory_id: null, permalink: null, thumbnail: null,
    last_updated: null, seller_custom_field: null, seller_sku: null, tags: [],
    shipping: { logistic_type: 'drop_off' }, attributes: null,
    ...o,
  };
}

const full = (o: Partial<ItemSlim> & { id: string }) =>
  item({ ...o, tags: ['fulfillment'], shipping: { logistic_type: 'fulfillment' } });

/**
 * Cenário. A janela padrão é de 30 dias, e 30 unidades vendidas dão velocidade
 * de 1,00/dia — assim os dias de cobertura são o próprio saldo, e cada faixa da
 * classificação fica óbvia de conferir.
 *
 *   RUP    Arcos do Convento  próprio  10, vende 30 →  10 dias → ruptura
 *   ALE    Carrascal          próprio  60, vende 30 →  60 dias → alerta
 *   OK     Morabitino         próprio 200, vende 30 → 200 dias → ok
 *   EXC    Vitoria Regia      próprio 400, vende 30 → 400 dias → excesso
 *   PARADO Bolota Dourada     próprio  50, sem venda          → sem venda
 *   ZERO   Cajado Real        próprio   0, sem venda          → sem venda, sem saldo
 *   FULLA  Alem do Rio        Full     12, sem venda          → só na lista do Full
 *
 * FULLA aparece na lista PRÓPRIA com saldo 0: `buildEstoquePorSku` não filtra
 * anúncios Full, e o saldo próprio de um SKU que só existe no Full é zero
 * mesmo. É a consequência direta de `classification.basis`.
 */
const CATALOGO: ItemSlim[] = [
  item({ id: 'MLB-RUP', seller_custom_field: 'RUP', title: 'Arcos do Convento 750ml', available_quantity: 10 }),
  item({ id: 'MLB-ALE', seller_custom_field: 'ALE', title: 'Carrascal Tinto', available_quantity: 60 }),
  item({ id: 'MLB-OK', seller_custom_field: 'OK', title: 'Morabitino Reserva', available_quantity: 200 }),
  item({ id: 'MLB-EXC', seller_custom_field: 'EXC', title: 'Vitoria Regia Branco', available_quantity: 400 }),
  item({ id: 'MLB-PAR', seller_custom_field: 'PARADO', title: 'Bolota Dourada', available_quantity: 50 }),
  item({ id: 'MLB-ZER', seller_custom_field: 'ZERO', title: 'Cajado Real', available_quantity: 0 }),
  full({ id: 'MLB-FUL', seller_custom_field: 'FULLA', title: 'Alem do Rio Tinto', available_quantity: 12, inventory_id: 'INVF' }),
];

let cache: FakeCache;

async function publicarCatalogo(itens: ItemSlim[] = CATALOGO) {
  const chave = await writeCatalogChunk(cache, 1, 0, itens);
  const man: CatalogManifest = {
    versao: 1, chunks: [chave],
    counts: {
      total: itens.length,
      active: itens.filter(i => i.status === 'active').length,
      paused: itens.filter(i => i.status === 'paused').length,
      closed: itens.filter(i => i.status === 'closed').length,
    },
    chunkSize: 500, updatedAt: new Date().toISOString(), complete: true,
  };
  await publishCatalog(cache, man);
  return man;
}

/** Vendas dentro da janela padrão de 30 dias (data = hoje BRT). */
async function publicarPedidos(unidades: Record<string, number>) {
  const hoje = hojeBRT();
  const pedidos: OrderSlim[] = [];
  let seq = 1;
  for (const [itemId, n] of Object.entries(unidades)) {
    for (let i = 0; i < n; i++) {
      pedidos.push({
        id: seq++, status: 'paid', date_created: `${hoje}T10:00:00.000-03:00`,
        paid_amount: 100, total_amount: 100,
        order_items: [{ quantity: 1, unit_price: 100, item: { id: itemId, title: 'V', seller_sku: null, variation_id: null } }],
      });
    }
  }
  const chave = await writeChunk(cache, 'ativos', 1, 0, pedidos);
  const man: OrdersManifest = {
    versao: 1, chunks: [chave], totalRegistros: pedidos.length,
    oldestDate: `${hoje}T00:00:00.000-03:00`, newestDate: `${hoje}T23:59:59.999-03:00`,
    chunkSize: 500, updatedAt: new Date().toISOString(), origem: 'full',
  };
  await publishManifest(cache, 'ativos', man);
}

/** 30 unidades na janela de 30 dias => 1,00/dia. Cobertura = saldo. */
const VENDAS_PADRAO = { 'MLB-RUP': 30, 'MLB-ALE': 30, 'MLB-OK': 30, 'MLB-EXC': 30 };

beforeEach(() => {
  cache = new FakeCache();
  setCacheForTests(cache);
  Object.assign(process.env, TEST_ENV, { GEMINI_API_KEY: 'chave-de-teste-com-mais-de-20-chars' });
  resetEnvForTests();
  vi.restoreAllMocks();
  fetchCalls = [];
  mockProvedor();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const comSessao = async () => (await createSession(cache)).id;

async function perguntar(message: string, token?: string) {
  const res = mockRes();
  await handler(mockReq({
    body: body(message),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  }), res);
  return res;
}

/** Contexto que foi realmente enviado ao provedor na última chamada. */
function contextoEnviado(): any {
  const texto = JSON.parse(fetchCalls[fetchCalls.length - 1].init.body).contents[0].parts[0].text;
  const m = /<CONTEXTO>\n([\s\S]*?)\n<\/CONTEXTO>/.exec(texto);
  if (!m) throw new Error('sem bloco <CONTEXTO>');
  return JSON.parse(m[1]);
}

function systemEnviado(): string {
  return JSON.parse(fetchCalls[fetchCalls.length - 1].init.body).systemInstruction.parts[0].text;
}

async function cenario() {
  await publicarCatalogo();
  await publicarPedidos(VENDAS_PADRAO);
  return comSessao();
}

// ══════════════════════════════════════════════════════════════════════════
describe('chat estoque — 1. resumo', () => {
  it('responde com agregados, não com a lista inteira', async () => {
    const t = await cenario();
    const res = await perguntar('como está nosso estoque?', t);
    expect(res.statusCode).toBe(200);

    const c = contextoEnviado();
    expect(c.query.intent).toBe('inventory_summary');
    expect(c.stock.own.skus).toBe(7);
    expect(c.stock.own.units).toBe(10 + 60 + 200 + 400 + 50 + 0 + 0);
    expect(c.stock.full.units).toBe(12);
    expect(c.stock.totalUnits).toBe(720 + 12);
    // FULLA entra como sem venda com saldo próprio 0 — ver a nota do cenário.
    expect(c.classification.counts).toEqual({ ruptura: 1, alerta: 1, ok: 1, excesso: 1, semvenda: 3 });
    // Nenhuma linha de produto vai no resumo.
    expect(c.items).toBeUndefined();
    expect(c.product).toBeUndefined();
  });

  it('declara a base da classificação', async () => {
    const t = await cenario();
    await perguntar('como está nosso estoque?', t);
    expect(contextoEnviado().classification.basis).toBe('own');
  });
});

describe('chat estoque — 2 a 3. ruptura, alerta e baixo', () => {
  it('ruptura lista só o que está em ruptura', async () => {
    const t = await cenario();
    await perguntar('o que está em ruptura?', t);
    const c = contextoEnviado();
    expect(c.query.filter).toBe('ruptura');
    expect(c.total).toBe(1);
    expect(c.items.map((i: any) => i.sku)).toEqual(['RUP']);
    expect(c.items[0].status).toBe('ruptura');
  });

  it('alerta lista só a faixa alerta', async () => {
    const t = await cenario();
    await perguntar('quais produtos estão em alerta?', t);
    const c = contextoEnviado();
    expect(c.items.map((i: any) => i.sku)).toEqual(['ALE']);
  });

  it('estoque baixo é a união de ruptura e alerta, em ordem de prioridade', async () => {
    const t = await cenario();
    await perguntar('o que está com estoque baixo?', t);
    const c = contextoEnviado();
    expect(c.query.filter).toBe('baixo');
    expect(c.items.map((i: any) => i.sku)).toEqual(['RUP', 'ALE']);
  });

  it('prioridade de reposição usa a mesma união, na mesma ordem', async () => {
    const t = await cenario();
    await perguntar('o que eu deveria repor primeiro?', t);
    const c = contextoEnviado();
    expect(c.query.filter).toBe('reposicao');
    expect(c.items.map((i: any) => i.sku)).toEqual(['RUP', 'ALE']);
    // Nenhuma quantidade sugerida de compra: esse número não existe.
    expect(JSON.stringify(c)).not.toContain('suggested');
  });
});

describe('chat estoque — 4. produto e SKU', () => {
  it('SKU exato devolve só aquele produto', async () => {
    const t = await cenario();
    await perguntar('quanto temos do SKU ALE?', t);
    const c = contextoEnviado();
    expect(c.query.intent).toBe('inventory_product');
    expect(c.product.sku).toBe('ALE');
    expect(c.product.own).toBe(60);
    expect(c.product.status).toBe('alerta');
    expect(c.items).toBeUndefined();
  });

  it('nome do produto resolve por título normalizado', async () => {
    const t = await cenario();
    await perguntar('qual o estoque do Arcos do Convento?', t);
    expect(contextoEnviado().product.sku).toBe('RUP');
  });

  it('produto ambíguo responde determinísticamente com candidatos, sem provedor', async () => {
    await publicarCatalogo([
      item({ id: 'MLB-A', seller_custom_field: 'A1', title: 'Ouro Meu Tinto', available_quantity: 5 }),
      item({ id: 'MLB-B', seller_custom_field: 'B2', title: 'Ouro Meu Branco', available_quantity: 5 }),
    ]);
    await publicarPedidos({});
    const t = await comSessao();

    const res = await perguntar('qual o estoque do ouro meu?', t);
    expect(res.statusCode).toBe(200);
    expect(fetchCalls.length).toBe(0);
    expect(res.json().meta.execution).toBe('deterministic');
    expect(res.json().answer).toContain('mais de um produto');
    expect(res.json().answer).toContain('A1');
    expect(res.json().answer).toContain('B2');
  });

  it('produto inexistente responde determinísticamente, sem provedor', async () => {
    const t = await cenario();
    const res = await perguntar('quanto temos do SKU NAOEXISTE?', t);
    expect(fetchCalls.length).toBe(0);
    expect(res.json().answer).toContain('Não encontrei');
    expect(res.json().meta.execution).toBe('deterministic');
  });

  it('SKU exato vence título parecido', async () => {
    await publicarCatalogo([
      item({ id: 'MLB-1', seller_custom_field: 'CARRASCAL', title: 'Outro Vinho', available_quantity: 7 }),
      item({ id: 'MLB-2', seller_custom_field: 'X9', title: 'Carrascal Tinto', available_quantity: 3 }),
    ]);
    await publicarPedidos({});
    const t = await comSessao();
    await perguntar('quanto temos do SKU carrascal?', t);
    expect(contextoEnviado().product.sku).toBe('CARRASCAL');
  });
});

describe('chat estoque — 5 e 6. Full e próprio', () => {
  it('resumo do Full traz só o lado Full', async () => {
    const t = await cenario();
    await perguntar('quanto temos no Full?', t);
    const c = contextoEnviado();
    expect(c.query.scope).toBe('full');
    expect(c.stock.own).toBeNull();
    expect(c.stock.full.units).toBe(12);
    expect(c.stock.totalUnits).toBeNull();
    expect(c.classification.basis).toBe('full');
  });

  it('listagem do Full usa a classificação do Full', async () => {
    const t = await cenario();
    await perguntar('quais produtos estão no Full?', t);
    const c = contextoEnviado();
    expect(c.classification.basis).toBe('full');
    expect(c.items.map((i: any) => i.sku)).toEqual(['FULLA']);
    // own null nas linhas do Full: aquele build não enxerga o saldo próprio.
    expect(c.items[0].own).toBeNull();
    expect(c.items[0].full).toBe(12);
  });

  it('resumo do próprio traz só o lado próprio', async () => {
    const t = await cenario();
    await perguntar('quanto temos em estoque próprio?', t);
    const c = contextoEnviado();
    expect(c.query.scope).toBe('proprio');
    expect(c.stock.full).toBeNull();
    expect(c.stock.own.units).toBe(720);
  });
});

describe('chat estoque — 7. sem venda', () => {
  it('lista apenas quem tem saldo E não vendeu', async () => {
    const t = await cenario();
    await perguntar('o que não vende há 30 dias?', t);
    const c = contextoEnviado();
    expect(c.query.filter).toBe('semvenda');
    // PARADO tem 50 unidades e não vendeu. ZERO não vendeu mas está zerado:
    // alertar sobre ele afogaria a lista com anúncios sem estoque.
    expect(c.items.map((i: any) => i.sku)).toEqual(['PARADO']);
  });

  it('período de 60 dias muda a janela declarada', async () => {
    const t = await cenario();
    await perguntar('quais produtos não venderam nos últimos 60 dias?', t);
    expect(contextoEnviado().sales.windowDays).toBe(60);
  });

  it('período de 90 dias muda a janela declarada', async () => {
    const t = await cenario();
    await perguntar('estoque parado nos últimos 90 dias', t);
    expect(contextoEnviado().sales.windowDays).toBe(90);
  });
});

describe('chat estoque — 8. excesso', () => {
  it('lista só o que está classificado como excesso', async () => {
    const t = await cenario();
    await perguntar('o que está com estoque excessivo?', t);
    const c = contextoEnviado();
    expect(c.items.map((i: any) => i.sku)).toEqual(['EXC']);
  });
});

describe('chat estoque — 10. inconsistências', () => {
  it('reporta saldo negativo normalizado, por tipo e com amostra', async () => {
    await publicarCatalogo([
      item({ id: 'MLB-N', seller_custom_field: 'NEG', title: 'Negativo', available_quantity: -4, inventory_id: 'IN1' }),
      item({ id: 'MLB-S', seller_custom_field: null, title: 'Sem sku nenhum', available_quantity: 3 }),
    ]);
    await publicarPedidos({});
    const t = await comSessao();

    await perguntar('tem algum problema nos dados de estoque?', t);
    const c = contextoEnviado();
    expect(c.query.intent).toBe('inventory_issues');
    const tipos = c.issues.byType.map((x: any) => x.type);
    expect(tipos).toContain('saldo_negativo_normalizado');
    expect(tipos).toContain('anuncio_sem_sku');
    // Só tipo, contagem e amostra: nada de mensagem interna com id de anúncio.
    expect(JSON.stringify(c)).not.toContain('mensagem');
    expect(JSON.stringify(c)).not.toContain('chaveDedup');
  });

  it('saldo negativo no modo seguro vira 0 e não derruba a consulta', async () => {
    await publicarCatalogo([
      item({ id: 'MLB-N', seller_custom_field: 'NEG', title: 'Negativo', available_quantity: -4, inventory_id: 'IN1' }),
    ]);
    await publicarPedidos({});
    const t = await comSessao();
    const res = await perguntar('quanto temos do SKU NEG?', t);
    expect(res.statusCode).toBe(200);
    expect(contextoEnviado().product.own).toBe(0);
  });
});

describe('chat estoque — limite, ordenação e tamanho de contexto', () => {
  it('lista longa é truncada e declara o total encontrado', async () => {
    const muitos = Array.from({ length: 25 }, (_, i) =>
      item({
        id: `MLB-${i}`, seller_custom_field: `S${String(i).padStart(2, '0')}`,
        title: `Vinho ${i}`, available_quantity: 1,
      }));
    await publicarCatalogo(muitos);
    await publicarPedidos(Object.fromEntries(muitos.map(m => [m.id, 30])));
    const t = await comSessao();

    await perguntar('o que está em ruptura?', t);
    const c = contextoEnviado();
    expect(c.total).toBe(25);
    expect(c.items.length).toBe(10);   // padrão da listagem de estoque
  });

  it('top N explícito é respeitado, com teto', async () => {
    const muitos = Array.from({ length: 25 }, (_, i) =>
      item({ id: `MLB-${i}`, seller_custom_field: `S${i}`, title: `V${i}`, available_quantity: 1 }));
    await publicarCatalogo(muitos);
    await publicarPedidos(Object.fromEntries(muitos.map(m => [m.id, 30])));
    const t = await comSessao();

    await perguntar('top 3 produtos em ruptura', t);
    expect(contextoEnviado().items.length).toBe(3);
  });

  it('a ordem é determinística: mesma pergunta, mesma lista', async () => {
    const t = await cenario();
    await perguntar('o que está com estoque baixo?', t);
    const a = contextoEnviado().items.map((i: any) => i.sku);
    await perguntar('o que está com estoque baixo?', t);
    const b = contextoEnviado().items.map((i: any) => i.sku);
    expect(b).toEqual(a);
  });
});

describe('chat estoque — garantias arquiteturais', () => {
  it('NUNCA chama o Mercado Livre', async () => {
    const t = await cenario();
    await perguntar('o que está em ruptura?', t);
    for (const c of fetchCalls) {
      expect(c.url).not.toContain('mercadolibre');
      expect(c.url).not.toContain('mercadolivre');
    }
  });

  it('NÃO usa o contexto 1.0.0 enviado pelo navegador', async () => {
    const t = await cenario();
    await perguntar('como está nosso estoque?', t);
    const bruto = fetchCalls[0].init.body as string;
    expect(bruto).not.toContain('overwine.chat.context');
    // Os números falsos do contexto do frontend não podem vazar para a resposta.
    expect(bruto).not.toContain('999999');
    expect(bruto).not.toContain('888888');
  });

  it('o provedor recebe só o contexto mínimo, sem pedidos nem anúncios crus', async () => {
    const t = await cenario();
    await perguntar('o que está em ruptura?', t);
    const bruto = fetchCalls[0].init.body as string;
    for (const proibido of [
      'order_items', 'buyer', 'nickname', 'paid_amount', 'permalink',
      'available_quantity', 'items:catalog', 'orders:chunk', 'ml:access_token',
    ]) {
      expect(bruto, proibido).not.toContain(proibido);
    }
  });

  it('o cálculo não é delegado ao modelo: o prompt proíbe recalcular', async () => {
    const t = await cenario();
    await perguntar('como está nosso estoque?', t);
    const sys = systemEnviado();
    expect(sys).toContain('MODO ESTOQUE');
    expect(sys).toContain('JÁ FORAM CALCULADOS pelo backend');
    expect(sys).toContain('Não some, não subtraia');
    expect(sys).toContain('Nunca sugira quantidade de compra');
  });

  it('uma só chamada ao provedor por pergunta', async () => {
    const t = await cenario();
    await perguntar('o que está em ruptura?', t);
    expect(fetchCalls.length).toBe(1);
  });

  it('meta.query devolve filtro e escopo entendidos', async () => {
    const t = await cenario();
    const res = await perguntar('quais produtos no Full estão em ruptura?', t);
    expect(res.json().meta.query).toMatchObject({
      intent: 'inventory_list', inventoryFilter: 'ruptura', inventoryScope: 'full',
    });
  });
});

describe('chat estoque — degradação', () => {
  it('sem catálogo publicado responde determinísticamente, sem provedor', async () => {
    await publicarPedidos(VENDAS_PADRAO);
    const t = await comSessao();
    const res = await perguntar('como está nosso estoque?', t);
    expect(res.statusCode).toBe(200);
    expect(fetchCalls.length).toBe(0);
    expect(res.json().answer).toContain('não estão disponíveis');
    expect(res.json().meta.execution).toBe('deterministic');
  });

  it('sem snapshot de pedidos ainda responde saldo, declarando vendas indisponíveis', async () => {
    await publicarCatalogo();
    const t = await comSessao();
    const res = await perguntar('como está nosso estoque?', t);
    expect(res.statusCode).toBe(200);
    const c = contextoEnviado();
    expect(c.sales.available).toBe(false);
    expect(c.warnings).toContain('vendas_indisponiveis');
    expect(c.stock.own.units).toBe(720);
    // Sem vendas não há classificação: todos os contadores em zero.
    expect(c.classification.counts).toMatchObject({ ruptura: 0, alerta: 0, ok: 0, excesso: 0, semvenda: 0 });
  });

  it('catálogo vencido é sinalizado como stale', async () => {
    const chave = await writeCatalogChunk(cache, 1, 0, CATALOGO);
    await publishCatalog(cache, {
      versao: 1, chunks: [chave],
      counts: { total: CATALOGO.length, active: CATALOGO.length, paused: 0, closed: 0 },
      chunkSize: 500,
      updatedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
      complete: true,
    });
    await publicarPedidos(VENDAS_PADRAO);
    const t = await comSessao();

    await perguntar('como está nosso estoque?', t);
    const c = contextoEnviado();
    expect(c.catalog.stale).toBe(true);
    expect(c.warnings).toContain('catalogo_stale');
  });

  it('catálogo vazio responde determinísticamente', async () => {
    await publicarCatalogo([]);
    await publicarPedidos(VENDAS_PADRAO);
    const t = await comSessao();
    const res = await perguntar('como está nosso estoque?', t);
    expect(fetchCalls.length).toBe(0);
    expect(res.json().answer).toContain('não estão disponíveis');
  });

  it('sem sessão continua 401, e nada é lido', async () => {
    const res = await perguntar('como está nosso estoque?');
    expect(res.statusCode).toBe(401);
    expect(fetchCalls.length).toBe(0);
  });
});
