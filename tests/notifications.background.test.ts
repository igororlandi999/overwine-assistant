/**
 * O QUE PROCESSA O PEDIDO DEPOIS DO ACK.
 *
 * Este arquivo responde uma pergunta com prova, e não com afirmação: o ACK
 * rápido transformou a fila de tempo real numa fila que só o GitHub Actions
 * drena?
 *
 * Não. O contrato é:
 *   notificação → ACK 200 em menos de 500 ms → dreno IMEDIATO em segundo
 *   plano, mantido vivo pelo `waitUntil` de `@vercel/functions`.
 *
 * O GitHub Actions é rede de segurança — para o evento que falhou, para o que
 * esbarrou no lock, e para o dreno que não sobreviveu à resposta. Nunca é o
 * caminho normal.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE MOCKAR `waitUntil`, E POR QUE ISSO NÃO ENFRAQUECE O TESTE
 *
 * `waitUntil` é o mecanismo do RUNTIME para não congelar a instância. Fora da
 * Vercel ele não tem o que fazer: o pacote lê o contexto de requisição e, sem
 * ele, vira no-op. Num teste, "não congelar" é o estado natural — o processo
 * continua rodando de qualquer jeito.
 *
 * O que o mock faz é dar ao teste uma ALÇA para a promessa de fundo, para
 * poder esperar por ela deliberadamente. O dreno em si é o real, a rota é a
 * real, o encadeamento entre os dois é o real. O mock não substitui nada do
 * que está sendo verificado; ele só torna observável o que a plataforma faria
 * em silêncio.
 *
 * O teste central não depende do mock para valer: ele prende a busca do pedido
 * e verifica que a resposta saiu antes. Se a rota passasse a aguardar o dreno,
 * ele falharia por timeout — verificado por mutação.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Coletor das promessas entregues ao `waitUntil`. Preenchido pelo mock abaixo
 * e esvaziado a cada teste. `vi.hoisted` porque `vi.mock` sobe para o topo do
 * módulo, antes de qualquer declaração comum.
 */
const bg = vi.hoisted(() => {
  const agendadas: Promise<unknown>[] = [];
  return {
    agendadas,
    waitUntil: vi.fn((p: Promise<unknown>) => { agendadas.push(p); }),
  };
});
vi.mock('@vercel/functions', () => ({ waitUntil: bg.waitUntil }));

import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { tamanhoFila, lerObsRecebimento, lerObsProcessamento } from '../src/lib/orders-events.js';
import {
  type OrdersManifest, readManifest, readSnapshot, writeChunk, publishManifest,
} from '../src/lib/orders-store.js';
import { ORDERS_SYNC_LOCK_KEY } from '../src/services/orders-sync.service.js';
import type { OrderSlim } from '../src/services/orders.service.js';
import handler from '../api/notifications/ml.js';

const SEGREDO = 'segredo-de-webhook-bem-longo';
const UID = TEST_ENV.ML_USER_ID;

function mockReq(o: Partial<{ method: string; headers: Record<string, unknown>; query: Record<string, unknown>; body: unknown }> = {}) {
  return { method: 'POST', headers: {}, query: {}, body: undefined, ...o } as any;
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

const corpo = (over: Record<string, unknown> = {}) => ({
  _id: 'notif-1',
  topic: 'orders_v2',
  resource: '/orders/2000012345',
  user_id: Number(UID),
  application_id: Number(TEST_ENV.ML_CLIENT_ID),
  attempts: 1,
  sent: '2026-08-27T09:00:00.000Z',
  ...over,
});

let cache: FakeCache;
beforeEach(() => {
  cache = new FakeCache();
  setCacheForTests(cache);
  Object.assign(process.env, TEST_ENV, { ML_WEBHOOK_SECRET: SEGREDO });
  resetEnvForTests();
  bg.agendadas.length = 0;
  vi.restoreAllMocks();
  // Depois do restore: o coletor precisa voltar a coletar em todo teste.
  bg.waitUntil.mockImplementation((p: Promise<unknown>) => { bg.agendadas.push(p); });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.ML_WEBHOOK_SECRET;
  resetEnvForTests();
  vi.restoreAllMocks();
});

async function chamar(o: Parameters<typeof mockReq>[0] = {}) {
  const res = mockRes();
  await handler(mockReq(o), res);
  return res;
}

/** Espera o trabalho de fundo que a rota agendou nesta chamada. */
async function esperarFundo() {
  await Promise.all(bg.agendadas);
}

/** Snapshot base mínimo: sem ele o upsert recusa e não há o que provar. */
async function publicarBase(): Promise<OrdersManifest> {
  const pedidos: OrderSlim[] = Array.from({ length: 3 }, (_, i) => ({
    id: i + 1, status: 'paid', date_created: `2026-08-2${i}T10:00:00.000Z`,
    paid_amount: 100, total_amount: 100,
    order_items: [{ quantity: 1, unit_price: 100, item: { id: 'MLB1', title: 'V', seller_sku: 'S', variation_id: null } }],
  }));
  const chave = await writeChunk(cache, 'ativos', 1, 0, pedidos);
  const man: OrdersManifest = {
    versao: 1, chunks: [chave], totalRegistros: 3,
    newestDate: pedidos[0].date_created, oldestDate: pedidos[2].date_created,
    chunkSize: 500, updatedAt: '2026-08-20T12:00:00.000Z', origem: 'full',
    chunkCounts: [3],
  };
  await publishManifest(cache, 'ativos', man);
  return man;
}

/** Token válido em cache: o dreno não deve gastar o teste em OAuth. */
async function semearToken() {
  await cache.set('ml:access_token', JSON.stringify({
    token: 'token-de-teste', expiresAt: Date.now() + 3600_000,
  }));
}

const PEDIDO_CRU = {
  id: 2000012345, status: 'paid', date_created: '2026-08-27T09:00:00.000Z',
  paid_amount: 250, total_amount: 250,
  order_items: [{ quantity: 1, unit_price: 250, item: { id: 'MLB9', title: 'Vinho', seller_sku: 'SKU9', variation_id: null } }],
  buyer: { nickname: 'comprador' },
  shipping: { id: 77, logistic_type: 'fulfillment' },
};

function respostaDoPedido() {
  return new Response(JSON.stringify(PEDIDO_CRU), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
describe('o ACK não espera o processamento', () => {
  it('o HTTP 200 sai ANTES de o GET /orders/{id} terminar', async () => {
    await publicarBase();
    await semearToken();

    // A busca do pedido fica PRESA até liberarmos. Se a resposta esperasse por
    // ela, o handler não retornaria e o teste travaria no próprio await.
    let liberar!: () => void;
    const preso = new Promise<void>(r => { liberar = r; });
    let buscaTerminou = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await preso;
      buscaTerminou = true;
      return respostaDoPedido();
    });

    const res = await chamar({ query: { k: SEGREDO }, body: corpo() });

    // Já respondemos, e a busca do pedido AINDA não terminou.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(buscaTerminou).toBe(false);
    // O snapshot também não mudou ainda: nada de publicar antes de responder.
    expect((await readManifest(cache, 'ativos'))!.versao).toBe(1);

    // ...e o trabalho está agendado, não perdido.
    expect(bg.agendadas).toHaveLength(1);

    liberar();
    await esperarFundo();
    expect(buscaTerminou).toBe(true);
  });

  it('o trabalho de fundo vai para o waitUntil de @vercel/functions', async () => {
    await publicarBase();
    await semearToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDoPedido());

    await chamar({ query: { k: SEGREDO }, body: corpo() });

    expect(bg.agendadas).toHaveLength(1);
    expect((await lerObsRecebimento(cache)).ultimoDrenoPedidoEm).toBeTypeOf('string');
  });

  it('waitUntil recusando o agendamento NAO altera o ACK', async () => {
    await publicarBase();
    await semearToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDoPedido());
    // Runtime hostil: a extensão é recusada. O trabalho já começou de qualquer
    // forma, e a resposta ao Mercado Livre não pode mudar por causa disso.
    bg.waitUntil.mockImplementationOnce(() => { throw new Error('sem contexto'); });

    const res = await chamar({ query: { k: SEGREDO }, body: corpo() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('o dreno de fundo atualiza o pedido sozinho', () => {
  it('o pedido entra no snapshot SEM depender do cron horario', async () => {
    const base = await publicarBase();
    await semearToken();
    const espiao = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDoPedido());

    await chamar({ query: { k: SEGREDO }, body: corpo() });
    await esperarFundo();   // é só isto: nenhum passo de sincronizacao

    const snap = await readSnapshot(cache, 'ativos');
    expect(snap.some(o => String(o.id) === '2000012345')).toBe(true);
    expect(snap).toHaveLength(4);

    const man = await readManifest(cache, 'ativos');
    expect(man!.versao).toBe(base.versao + 1);
    expect(man!.origem).toBe('webhook');
    expect(await tamanhoFila(cache)).toBe(0);

    // A única chamada ao ML foi a do pedido. Nenhum /orders/search — ou seja,
    // nada aqui passou pela varredura periódica.
    const urls = espiao.mock.calls.map(c => String(c[0]));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/orders/2000012345');
    expect(urls.some(u => u.includes('/orders/search'))).toBe(false);
  });

  it('a latencia medida cobre da notificacao ate a publicacao', async () => {
    await publicarBase();
    await semearToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDoPedido());

    const sent = new Date(Date.now() - 800).toISOString();
    await chamar({ query: { k: SEGREDO }, body: corpo({ sent }) });
    await esperarFundo();

    const obs = await lerObsProcessamento(cache);
    expect(obs.ultimaVersaoPublicada).toBe(2);
    expect(obs.ultimaLatenciaTotalMs).toBeGreaterThanOrEqual(800);
    expect(obs.ultimoDrenoEm).toBeTypeOf('string');
  });

  it('varios eventos do mesmo pedido colapsam numa unica busca', async () => {
    await publicarBase();
    await semearToken();
    const espiao = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDoPedido());
    // Uma reconciliacao segura o lock: as tres notificacoes se acumulam.
    await cache.setNX(ORDERS_SYNC_LOCK_KEY, 'reconciliacao', 120);

    for (const id of ['a', 'b', 'c']) await chamar({ query: { k: SEGREDO }, body: corpo({ _id: id }) });
    await esperarFundo();
    expect(await tamanhoFila(cache)).toBe(3);
    expect(espiao).not.toHaveBeenCalled();

    // Liberado o lock, o proximo dreno resolve as tres com UMA chamada.
    await cache.del(ORDERS_SYNC_LOCK_KEY);
    bg.agendadas.length = 0;
    await chamar({ query: { k: SEGREDO }, body: corpo({ _id: 'd' }) });
    await esperarFundo();

    expect(espiao.mock.calls).toHaveLength(1);
    expect(await tamanhoFila(cache)).toBe(0);
  });
});

describe('falha no fundo não contamina o ACK nem perde o evento', () => {
  it('falha no processamento NAO vira 500: o ACK ja foi dado', async () => {
    await publicarBase();
    await semearToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('indisponivel', { status: 500 }));

    const res = await chamar({ query: { k: SEGREDO }, body: corpo() });
    expect(res.statusCode).toBe(200);

    // O trabalho de fundo tambem NAO pode rejeitar: ninguem esta ouvindo.
    await expect(esperarFundo()).resolves.toBeUndefined();
  });

  it('falha no processamento REENFILEIRA o evento — nada se perde', async () => {
    await publicarBase();
    await semearToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('erro', { status: 500 }));

    await chamar({ query: { k: SEGREDO }, body: corpo() });
    await esperarFundo();

    expect(await tamanhoFila(cache)).toBe(1);
    expect((await readSnapshot(cache, 'ativos')).some(o => String(o.id) === '2000012345')).toBe(false);
    expect((await lerObsProcessamento(cache)).ultimoErro).toContain('HTTP 500');
  });

  it('o evento reenfileirado e reprocessado quando a busca volta a funcionar', async () => {
    await publicarBase();
    await semearToken();
    const espiao = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('erro', { status: 500 }));

    await chamar({ query: { k: SEGREDO }, body: corpo({ _id: 'falha' }) });
    await esperarFundo();
    expect(await tamanhoFila(cache)).toBe(1);

    // O ML volta. Uma notificacao nova (ou o job de fallback) drena a fila
    // inteira — inclusive o evento que tinha falhado.
    espiao.mockResolvedValue(respostaDoPedido());
    bg.agendadas.length = 0;
    await chamar({ query: { k: SEGREDO }, body: corpo({ _id: 'retorno' }) });
    await esperarFundo();

    expect(await tamanhoFila(cache)).toBe(0);
    expect((await readSnapshot(cache, 'ativos')).filter(o => String(o.id) === '2000012345')).toHaveLength(1);
  });
});

describe('o lock da reconciliação preserva o evento', () => {
  it('lock ocupado PRESERVA o evento e nao chama o Mercado Livre', async () => {
    await publicarBase();
    await semearToken();
    const espiao = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDoPedido());
    // Uma reconciliacao esta publicando agora.
    await cache.setNX(ORDERS_SYNC_LOCK_KEY, 'sincronizacao-em-andamento', 120);

    const res = await chamar({ query: { k: SEGREDO }, body: corpo() });
    await esperarFundo();

    expect(res.statusCode).toBe(200);
    expect(await tamanhoFila(cache)).toBe(1);   // preservado
    expect(espiao).not.toHaveBeenCalled();
    // E o lock da sincronizacao continua com o dono dela.
    expect(await cache.get(ORDERS_SYNC_LOCK_KEY)).toBe('sincronizacao-em-andamento');
  });

  it('liberado o lock, o proximo dreno aplica o evento que ficou esperando', async () => {
    await publicarBase();
    await semearToken();
    const espiao = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDoPedido());
    await cache.setNX(ORDERS_SYNC_LOCK_KEY, 'dona', 120);

    await chamar({ query: { k: SEGREDO }, body: corpo({ _id: 'travado' }) });
    await esperarFundo();
    expect(await tamanhoFila(cache)).toBe(1);

    await cache.del(ORDERS_SYNC_LOCK_KEY);
    bg.agendadas.length = 0;
    await chamar({ query: { k: SEGREDO }, body: corpo({ _id: 'depois' }) });
    await esperarFundo();

    expect(await tamanhoFila(cache)).toBe(0);
    expect(espiao).toHaveBeenCalled();
    expect((await readSnapshot(cache, 'ativos')).some(o => String(o.id) === '2000012345')).toBe(true);
  });
});
