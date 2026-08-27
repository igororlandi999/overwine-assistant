/**
 * Contrato do caminho de tempo real: notificação do Mercado Livre → upsert de
 * UM pedido → snapshot novo, sem reconstruir os outros milhares.
 *
 * O que estes testes travam, e por quê:
 *
 * 1. INCREMENTALIDADE — o teste conta quantas chaves de chunk foram escritas.
 *    Se alguém trocar o upsert por uma republicação canônica "porque é mais
 *    simples", a conta explode e o teste quebra. É a propriedade central da
 *    fase: uma venda não pode custar a reescrita do histórico inteiro.
 *
 * 2. INTEGRIDADE DA PAGINAÇÃO — depois de um upsert os chunks deixam de ter
 *    tamanho uniforme. A leitura por offset precisa andar pelos tamanhos
 *    reais (`chunkCounts`), senão cada página pula ou repete um pedido. Os
 *    testes repaginam o snapshot inteiro e comparam com a lista esperada.
 *
 * 3. IDEMPOTÊNCIA — o mesmo evento duas vezes não pode duplicar pedido, e um
 *    evento fora de ordem não pode regredir estado. A garantia não é a
 *    deduplicação por `_id` (isso é economia), é o dreno buscar SEMPRE o
 *    estado atual na API.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import {
  type OrdersManifest,
  readManifest,
  readSnapshot,
  writeChunk,
  publishManifest,
} from '../src/lib/orders-store.js';
import { getPage } from '../src/services/orders-read.service.js';
import { ORDERS_SYNC_LOCK_KEY, runSyncStep, type FetchOrdersPage } from '../src/services/orders-sync.service.js';
import type { OrderInput, OrderSlim } from '../src/services/orders.service.js';
import { toSlim } from '../src/services/orders.service.js';
import {
  interpretarNotificacao,
  receberNotificacao,
  upsertPedido,
  drenarFila,
  TOPICOS_DE_PEDIDO,
} from '../src/services/orders-webhook.service.js';
import { tamanhoFila, lerObsProcessamento, lerObsRecebimento } from '../src/lib/orders-events.js';

const UID = TEST_ENV.ML_USER_ID;
const APP = TEST_ENV.ML_CLIENT_ID;
/** O par que o backend espera em toda notificacao: vendedor e aplicacao. */
const ESPERADO = { mlUserId: UID, applicationId: APP };

let cache: FakeCache;
beforeEach(() => {
  cache = new FakeCache();
  Object.assign(process.env, TEST_ENV);
  resetEnvForTests();
});

// ── helpers ────────────────────────────────────────────────────────────────

/** Data ISO decrescente: i=0 é a mais recente. */
function data(i: number): string {
  const d = new Date(Date.UTC(2026, 7, 20, 12, 0, 0) - i * 60_000);
  return d.toISOString();
}

function pedido(id: number | string, i: number, over: Partial<OrderSlim> = {}): OrderSlim {
  return {
    id,
    status: 'paid',
    date_created: data(i),
    paid_amount: 100,
    total_amount: 100,
    order_items: [
      { quantity: 1, unit_price: 100, item: { id: 'MLB1', title: 'Vinho', seller_sku: 'SKU1', variation_id: null } },
    ],
    buyer: { nickname: 'comprador' },
    shipping: { id: 900 + Number(id), logistic_type: null },
    ...over,
  };
}

/**
 * Publica um snapshot canônico de `n` pedidos com ids 1..n, do mais recente
 * (id 1) ao mais antigo (id n) — a mesma ordem date_desc que o sync produz.
 */
async function publicarBase(n: number, chunkSize: number, comCounts = true): Promise<OrdersManifest> {
  const pedidos = Array.from({ length: n }, (_, i) => pedido(i + 1, i));
  const chunks: string[] = [];
  const counts: number[] = [];
  for (let i = 0; i * chunkSize < n; i++) {
    const fatia = pedidos.slice(i * chunkSize, (i + 1) * chunkSize);
    chunks.push(await writeChunk(cache, 'ativos', 1, i, fatia));
    counts.push(fatia.length);
  }
  const man: OrdersManifest = {
    versao: 1,
    chunks,
    totalRegistros: n,
    newestDate: pedidos[0].date_created,
    oldestDate: pedidos[n - 1].date_created,
    chunkSize,
    updatedAt: '2026-08-20T12:00:00.000Z',
    origem: 'full',
    ...(comCounts ? { chunkCounts: counts } : {}),
  };
  await publishManifest(cache, 'ativos', man);
  return man;
}

/** Quantas chaves de chunk PUBLICADO existem no Redis fake. */
function chavesDeChunk(): string[] {
  return [...cache.store.keys()].filter(k => k.startsWith('orders:chunk:'));
}

/** Repagina o snapshot inteiro pela rota de leitura e devolve os ids na ordem. */
async function repaginar(pageSize: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  // Guarda alta o suficiente para pageSize=1 sobre o maior cenário destes
  // testes. Se ela for atingida, a paginação não terminou — e isso é falha,
  // não um teto do harness.
  let terminou = false;
  for (let guarda = 0; guarda < 5000; guarda++) {
    const r = await getPage(cache, 'ativos', cursor, pageSize);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) break;
    ids.push(...r.value.items.map(o => String(o.id)));
    cursor = r.value.nextCursor;
    if (cursor === null) { terminou = true; break; }
  }
  expect(terminou, 'a paginação não chegou ao fim').toBe(true);
  return ids;
}

function comoInput(o: OrderSlim): OrderInput {
  return o as unknown as OrderInput;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('1. interpretarNotificacao — o que entra e o que é recusado', () => {
  const base = { _id: 'n1', topic: 'orders_v2', resource: '/orders/2000012345', user_id: Number(UID), application_id: Number(APP) };

  it('aceita orders_v2 e extrai o id do pedido', () => {
    const r = interpretarNotificacao(base, ESPERADO);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.evento.orderId).toBe('2000012345');
      expect(r.evento.topico).toBe('orders_v2');
      expect(r.evento.notifId).toBe('n1');
    }
  });

  it('aceita created_orders — o tópico antigo pode estar assinado no painel', () => {
    expect(interpretarNotificacao({ ...base, topic: 'created_orders' }, ESPERADO).ok).toBe(true);
  });

  it('os dois tópicos aceitos são exatamente orders_v2 e created_orders', () => {
    expect([...TOPICOS_DE_PEDIDO].sort()).toEqual(['created_orders', 'orders_v2']);
  });

  it('recusa tópico cujo resource não é um pedido (shipments, payments, items)', () => {
    for (const topic of ['shipments', 'payments', 'items', 'messages', 'questions']) {
      const r = interpretarNotificacao({ ...base, topic, resource: '/shipments/5' }, ESPERADO);
      expect(r.ok, topic).toBe(false);
      if (!r.ok) expect(r.motivo).toBe('topico_ignorado');
    }
  });

  it('recusa notificação de OUTRA conta — a aplicação pode ter mais de um vendedor', () => {
    const r = interpretarNotificacao({ ...base, user_id: 999999999 }, ESPERADO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe('user_id_divergente');
  });

  it('user_id numérico do ML bate com ML_USER_ID em string', () => {
    expect(interpretarNotificacao({ ...base, user_id: Number(UID) }, ESPERADO).ok).toBe(true);
    expect(interpretarNotificacao({ ...base, user_id: UID }, ESPERADO).ok).toBe(true);
  });

  it('recusa resource fora do formato /orders/{digitos}', () => {
    for (const resource of ['/orders/', '/orders/abc', 'orders/1', '/orders/1/x', '']) {
      const r = interpretarNotificacao({ ...base, resource }, ESPERADO);
      expect(r.ok, resource).toBe(false);
    }
  });

  it('recusa corpo que não é objeto', () => {
    for (const body of [null, undefined, 'x', 42, []]) {
      expect(interpretarNotificacao(body, ESPERADO).ok).toBe(false);
    }
  });

  it('notificação sem _id é aceita — a correção não depende da deduplicação', () => {
    const r = interpretarNotificacao(
      { topic: 'orders_v2', resource: '/orders/7', user_id: Number(UID), application_id: Number(APP) },
      ESPERADO
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.evento.notifId).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('2. receberNotificacao — o caminho do ACK não toca no Mercado Livre', () => {
  const notif = (id: string, orderId = '2000012345') => ({
    _id: id, topic: 'orders_v2', resource: `/orders/${orderId}`,
    user_id: Number(UID), application_id: Number(APP),
  });

  it('enfileira uma vez e responde com o tamanho da fila', async () => {
    const r = await receberNotificacao(cache, notif('a'), ESPERADO);
    expect(r).toMatchObject({ aceito: true, duplicada: false, orderId: '2000012345', fila: 1 });
    expect(await tamanhoFila(cache)).toBe(1);
  });

  it('o MESMO _id duas vezes não enfileira duas vezes', async () => {
    await receberNotificacao(cache, notif('a'), ESPERADO);
    const segunda = await receberNotificacao(cache, notif('a'), ESPERADO);
    expect(segunda).toMatchObject({ aceito: true, duplicada: true });
    expect(await tamanhoFila(cache)).toBe(1);
  });

  it('_ids diferentes para o MESMO pedido entram os dois — o dreno é que colapsa', async () => {
    await receberNotificacao(cache, notif('a'), ESPERADO);
    await receberNotificacao(cache, notif('b'), ESPERADO);
    expect(await tamanhoFila(cache)).toBe(2);
  });

  it('notificação recusada não entra na fila e conta como rejeitada', async () => {
    const r = await receberNotificacao(cache, { topic: 'shipments', resource: '/shipments/1' }, ESPERADO);
    expect(r.aceito).toBe(false);
    expect(await tamanhoFila(cache)).toBe(0);
    expect((await lerObsRecebimento(cache)).totalRejeitadas).toBe(1);
  });

  it('a telemetria de recebimento registra quando, qual tópico e qual pedido', async () => {
    await receberNotificacao(cache, notif('a', '777'), ESPERADO);
    const obs = await lerObsRecebimento(cache);
    expect(obs.totalRecebidas).toBe(1);
    expect(obs.ultimaNotificacaoPedido).toBe('777');
    expect(obs.ultimaNotificacaoTopico).toBe('orders_v2');
    expect(obs.ultimaNotificacaoEm).toBeTypeOf('string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('3. upsertPedido — o pedido novo custa UMA escrita de chunk', () => {
  it('pedido novo entra no topo e o snapshot cresce em 1', async () => {
    await publicarBase(1000, 500);
    const novo = pedido(9999, -5); // data mais recente que todas

    const r = await upsertPedido(cache, novo);

    expect(r.acao).toBe('novo');
    expect(r.versao).toBe(2);
    const man = await readManifest(cache, 'ativos');
    expect(man?.totalRegistros).toBe(1001);
    const snap = await readSnapshot(cache, 'ativos');
    expect(String(snap[0].id)).toBe('9999');
    expect(snap).toHaveLength(1001);
  });

  it('REESCREVE 1 chunk e REUSA as chaves dos outros — é isto que é incremental', async () => {
    const base = await publicarBase(2000, 500); // 4 chunks
    const r = await upsertPedido(cache, pedido(9999, -5));

    expect(r.chunksEscritos).toBe(1);
    expect(r.chunksLidos).toBe(1); // só o chunk 0 precisou ser lido

    const man = await readManifest(cache, 'ativos');
    // 3 das 4 chaves da versão 1 continuam sendo as MESMAS no manifesto novo.
    const reusadas = man!.chunks.filter(k => base.chunks.includes(k));
    expect(reusadas).toHaveLength(3);
    expect(man!.chunks[0]).not.toBe(base.chunks[0]);
  });

  it('a versão nova NÃO duplica os chunks intactos no Redis', async () => {
    await publicarBase(2000, 500);
    const antes = chavesDeChunk().length; // 4
    await upsertPedido(cache, pedido(9999, -5));
    // Uma chave nova (o chunk 0 reescrito). As outras três foram reaproveitadas.
    expect(chavesDeChunk().length).toBe(antes + 1);
  });

  it('atualização de pedido já existente não muda o total nem cria pedido', async () => {
    await publicarBase(1000, 500);
    const alterado = pedido(3, 2, { status: 'cancelled', paid_amount: 0 });

    const r = await upsertPedido(cache, alterado);

    expect(r.acao).toBe('atualizado');
    const man = await readManifest(cache, 'ativos');
    expect(man?.totalRegistros).toBe(1000);
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap.filter(o => String(o.id) === '3')).toHaveLength(1);
    expect(snap.find(o => String(o.id) === '3')?.status).toBe('cancelled');
  });

  it('pedido idêntico ao que já está lá NÃO publica versão nova', async () => {
    const base = await publicarBase(1000, 500);
    const r = await upsertPedido(cache, pedido(3, 2));

    expect(r.acao).toBe('sem_mudanca');
    expect(r.versao).toBeNull();
    const man = await readManifest(cache, 'ativos');
    expect(man?.versao).toBe(base.versao); // o dashboard não vai repaginar à toa
  });

  it('pedido antigo alterado é encontrado no chunk certo, e só ele é reescrito', async () => {
    const base = await publicarBase(2000, 500); // ids 1..2000, 4 chunks
    const r = await upsertPedido(cache, pedido(1700, 1699, { status: 'cancelled' }));

    expect(r.acao).toBe('atualizado');
    expect(r.chunksEscritos).toBe(1);
    expect(r.chunksLidos).toBe(4); // precisou varrer até o 4º chunk
    const man = await readManifest(cache, 'ativos');
    expect(man!.chunks.slice(0, 3)).toEqual(base.chunks.slice(0, 3));
  });

  it('sem snapshot base o upsert RECUSA em vez de publicar um snapshot de 1 pedido', async () => {
    const r = await upsertPedido(cache, pedido(1, 0));
    expect(r.acao).toBe('sem_snapshot');
    expect(await readManifest(cache, 'ativos')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('4. integridade da paginação depois do upsert', () => {
  it('a lista completa continua batendo com totalRegistros, sem pulo nem repetição', async () => {
    await publicarBase(1000, 500);
    await upsertPedido(cache, pedido(9999, -5));

    const ids = await repaginar(200);
    expect(ids).toHaveLength(1001);
    expect(new Set(ids).size).toBe(1001);
    expect(ids[0]).toBe('9999');
    expect(ids[1]).toBe('1');
    expect(ids[ids.length - 1]).toBe('1000');
  });

  it('dez upserts seguidos mantêm a paginação exata, com chunks desiguais', async () => {
    await publicarBase(1000, 500);
    for (let i = 1; i <= 10; i++) await upsertPedido(cache, pedido(9000 + i, -i));

    const man = await readManifest(cache, 'ativos');
    expect(man!.chunkCounts).toEqual([510, 500]); // desigual de propósito
    expect(man!.totalRegistros).toBe(1010);

    for (const pageSize of [1, 7, 200, 500]) {
      const ids = await repaginar(pageSize);
      expect(ids, `pageSize=${pageSize}`).toHaveLength(1010);
      expect(new Set(ids).size).toBe(1010);
    }
  });

  it('o pedido mais recente é o PRIMEIRO da primeira página', async () => {
    await publicarBase(600, 500);
    await upsertPedido(cache, pedido('novo', -1));
    const r = await getPage(cache, 'ativos', null, 5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(String(r.value.items[0].id)).toBe('novo');
  });

  it('manifesto ANTIGO sem chunkCounts continua sendo paginado corretamente', async () => {
    await publicarBase(1000, 500, /* comCounts */ false);
    const ids = await repaginar(300);
    expect(ids).toHaveLength(1000);
    expect(new Set(ids).size).toBe(1000);
  });

  it('upsert sobre manifesto legado (sem chunkCounts) deriva os tamanhos e grava o campo', async () => {
    await publicarBase(1000, 500, false);
    const r = await upsertPedido(cache, pedido(9999, -5));
    expect(r.acao).toBe('novo');
    const man = await readManifest(cache, 'ativos');
    expect(man!.chunkCounts).toEqual([501, 500]);
    expect(await repaginar(250)).toHaveLength(1001);
  });

  it('o chunk tocado é dividido ao passar do dobro do tamanho nominal', async () => {
    // chunkSize 10 e um único chunto cheio: 11 upserts levam a 21 > 20.
    await publicarBase(10, 10);
    for (let i = 1; i <= 11; i++) await upsertPedido(cache, pedido(9000 + i, -i));

    const man = await readManifest(cache, 'ativos');
    expect(man!.chunks.length).toBeGreaterThan(1);
    expect(Math.max(...man!.chunkCounts!)).toBeLessThanOrEqual(20);
    expect(man!.chunkCounts!.reduce((s, n) => s + n, 0)).toBe(21);
    expect(await repaginar(4)).toHaveLength(21);
  });

  it('a versão imediatamente anterior continua legível após um upsert (retenção)', async () => {
    const base = await publicarBase(1000, 500);
    await upsertPedido(cache, pedido(9999, -5));
    // Um cursor ancorado na versão 1 ainda deve ser servido pelo `previous`.
    const primeira = await getPage(cache, 'ativos', null, 10);
    expect(primeira.ok).toBe(true);
    const cursorV1 = Buffer.from(JSON.stringify({ v: base.versao, o: 10, a: 'ativos' }))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const r = await getPage(cache, 'ativos', cursorV1, 10);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.servedFrom).toBe('previous');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('5. drenarFila — idempotência, ordem e concorrência', () => {
  /** fetch fake que devolve o estado ATUAL de cada pedido, contando chamadas. */
  function fakeFetch(estado: Map<string, OrderSlim>) {
    const chamadas: string[] = [];
    const fn = async (orderId: string): Promise<OrderInput> => {
      chamadas.push(orderId);
      const o = estado.get(orderId);
      if (!o) throw new Error(`pedido ${orderId} inexistente`);
      return comoInput(o);
    };
    return { fn, chamadas };
  }

  const notif = (id: string, orderId: string) => ({
    _id: id, topic: 'orders_v2', resource: `/orders/${orderId}`,
    user_id: Number(UID), application_id: Number(APP), sent: new Date().toISOString(),
  });

  it('um evento vira um pedido novo no snapshot', async () => {
    await publicarBase(100, 50);
    const estado = new Map([['5000', pedido('5000', -1)]]);
    const { fn } = fakeFetch(estado);

    await receberNotificacao(cache, notif('a', '5000'), ESPERADO);
    const r = await drenarFila(cache, fn);

    expect(r).toMatchObject({ ok: true, processados: 1, novos: 1, falhas: 0, restantes: 0 });
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap.some(o => String(o.id) === '5000')).toBe(true);
  });

  it('o MESMO evento processado duas vezes NÃO duplica o pedido', async () => {
    await publicarBase(100, 50);
    const estado = new Map([['5000', pedido('5000', -1)]]);
    const { fn } = fakeFetch(estado);

    await receberNotificacao(cache, notif('a', '5000'), ESPERADO);
    await drenarFila(cache, fn);
    // Segunda notificação, _id diferente, mesmo pedido, nada mudou no ML.
    await receberNotificacao(cache, notif('b', '5000'), ESPERADO);
    const segunda = await drenarFila(cache, fn);

    expect(segunda.semMudanca).toBe(1);
    expect(segunda.novos).toBe(0);
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap.filter(o => String(o.id) === '5000')).toHaveLength(1);
    expect(snap).toHaveLength(101);
  });

  it('vários eventos do MESMO pedido custam UMA chamada à API', async () => {
    await publicarBase(100, 50);
    const estado = new Map([['5000', pedido('5000', -1)]]);
    const { fn, chamadas } = fakeFetch(estado);

    for (const id of ['a', 'b', 'c']) await receberNotificacao(cache, notif(id, '5000'), ESPERADO);
    expect(await tamanhoFila(cache)).toBe(3);

    await drenarFila(cache, fn);
    expect(chamadas).toEqual(['5000']);
  });

  it('evento FORA DE ORDEM não regride o pedido: vale o estado atual da API', async () => {
    await publicarBase(100, 50);
    // O ML já está em `cancelled`; o evento antigo era do momento `paid`.
    const estado = new Map([['7', pedido(7, 6, { status: 'cancelled', paid_amount: 0 })]]);
    const { fn } = fakeFetch(estado);

    await receberNotificacao(cache, notif('antigo', '7'), ESPERADO);
    await drenarFila(cache, fn);

    const snap = await readSnapshot(cache, 'ativos');
    expect(snap.find(o => String(o.id) === '7')?.status).toBe('cancelled');
  });

  it('falha na busca devolve o evento à fila e registra o erro', async () => {
    await publicarBase(100, 50);
    const fn = async (): Promise<OrderInput> => { throw new Error('ML GET /orders/5000 HTTP 500.'); };

    await receberNotificacao(cache, notif('a', '5000'), ESPERADO);
    const r = await drenarFila(cache, fn);

    expect(r.ok).toBe(false);
    expect(r.falhas).toBe(1);
    expect(r.restantes).toBe(1); // reenfileirado
    const obs = await lerObsProcessamento(cache);
    expect(obs.ultimoErro).toContain('HTTP 500');
  });

  it('a fila reenfileirada é processada quando a busca volta a funcionar', async () => {
    await publicarBase(100, 50);
    let falhar = true;
    const estado = new Map([['5000', pedido('5000', -1)]]);
    const fn = async (id: string): Promise<OrderInput> => {
      if (falhar) throw new Error('indisponivel');
      return comoInput(estado.get(id)!);
    };

    await receberNotificacao(cache, notif('a', '5000'), ESPERADO);
    await drenarFila(cache, fn);
    falhar = false;
    const r = await drenarFila(cache, fn);

    expect(r.novos).toBe(1);
    expect(await tamanhoFila(cache)).toBe(0);
  });

  it('ML devolvendo pedido de OUTRO id é falha, não upsert errado', async () => {
    await publicarBase(100, 50);
    const fn = async (): Promise<OrderInput> => comoInput(pedido('outro', -1));

    await receberNotificacao(cache, notif('a', '5000'), ESPERADO);
    const r = await drenarFila(cache, fn);

    expect(r.falhas).toBe(1);
    expect((await readSnapshot(cache, 'ativos')).some(o => String(o.id) === 'outro')).toBe(false);
  });

  it('lock da sincronização ocupado NÃO é erro: os eventos ficam para o próximo dreno', async () => {
    await publicarBase(100, 50);
    await cache.setNX(ORDERS_SYNC_LOCK_KEY, 'a-sincronizacao', 120);
    const { fn, chamadas } = fakeFetch(new Map([['5000', pedido('5000', -1)]]));

    await receberNotificacao(cache, notif('a', '5000'), ESPERADO);
    const r = await drenarFila(cache, fn);

    expect(r.motivo).toBe('sync_em_andamento');
    expect(r.ok).toBe(true);
    expect(chamadas).toHaveLength(0);
    expect(await tamanhoFila(cache)).toBe(1);
  });

  it('o dreno LIBERA o lock ao terminar', async () => {
    await publicarBase(100, 50);
    const { fn } = fakeFetch(new Map([['5000', pedido('5000', -1)]]));
    await receberNotificacao(cache, notif('a', '5000'), ESPERADO);
    await drenarFila(cache, fn);
    expect(await cache.get(ORDERS_SYNC_LOCK_KEY)).toBeNull();
  });

  it('o dreno libera o lock mesmo quando o processamento falha', async () => {
    await publicarBase(100, 50);
    const fn = async (): Promise<OrderInput> => { throw new Error('boom'); };
    await receberNotificacao(cache, notif('a', '5000'), ESPERADO);
    await drenarFila(cache, fn);
    expect(await cache.get(ORDERS_SYNC_LOCK_KEY)).toBeNull();
  });

  it('respeita o teto de eventos por dreno e deixa o resto na fila', async () => {
    await publicarBase(100, 50);
    const estado = new Map<string, OrderSlim>();
    for (let i = 1; i <= 5; i++) estado.set(String(6000 + i), pedido(6000 + i, -i));
    const { fn } = fakeFetch(estado);

    for (let i = 1; i <= 5; i++) await receberNotificacao(cache, notif(`n${i}`, String(6000 + i)), ESPERADO);
    const r = await drenarFila(cache, fn, { max: 2 });

    expect(r.processados).toBe(2);
    expect(r.restantes).toBe(3);
  });

  it('fila vazia é um dreno legítimo: marca prova de vida e não chama a API', async () => {
    const { fn, chamadas } = fakeFetch(new Map());
    const r = await drenarFila(cache, fn);
    expect(r).toMatchObject({ ok: true, processados: 0, restantes: 0 });
    expect(chamadas).toHaveLength(0);
    expect((await lerObsProcessamento(cache)).ultimoDrenoEm).toBeTypeOf('string');
  });

  it('a telemetria diz qual foi o último pedido atualizado e quando', async () => {
    await publicarBase(100, 50);
    const { fn } = fakeFetch(new Map([['5000', pedido('5000', -1)]]));
    await receberNotificacao(cache, notif('a', '5000'), ESPERADO);
    await drenarFila(cache, fn);

    const obs = await lerObsProcessamento(cache);
    expect(obs.ultimoPedidoAtualizadoId).toBe('5000');
    expect(obs.ultimaAcao).toBe('novo');
    expect(obs.totalNovos).toBe(1);
    expect(obs.ultimoPedidoAtualizadoEm).toBeTypeOf('string');
  });

  it('o pedido gravado passa por toSlim — mesmo normalizador da varredura periódica', async () => {
    await publicarBase(100, 50);
    // Corpo cru do ML, com campos que o snapshot não guarda.
    const cru = {
      id: 5000, status: 'paid', date_created: data(-1), paid_amount: 100, total_amount: 100,
      order_items: [{ quantity: 2, unit_price: 50, item: { id: 'MLB9', title: 'T', seller_sku: 'S9', variation_id: 3 } }],
      buyer: { nickname: 'n', email: 'nao@guardar.com' },
      shipping: { id: 42, logistic_type: 'fulfillment' },
      payments: [{ id: 1 }],
    } as unknown as OrderInput;
    const fn = async (): Promise<OrderInput> => cru;

    await receberNotificacao(cache, notif('a', '5000'), ESPERADO);
    await drenarFila(cache, fn);

    const gravado = (await readSnapshot(cache, 'ativos')).find(o => String(o.id) === '5000')!;
    expect(gravado).toEqual(toSlim(cru));
    expect(Object.keys(gravado)).not.toContain('payments');
    expect(JSON.stringify(gravado)).not.toContain('nao@guardar.com');
  });

  it('sem snapshot base o evento não fica preso em laço: vira falha registrada', async () => {
    const { fn } = fakeFetch(new Map([['5000', pedido('5000', -1)]]));
    await receberNotificacao(cache, notif('a', '5000'), ESPERADO);
    const r = await drenarFila(cache, fn);

    expect(r.falhas).toBe(1);
    expect(r.restantes).toBe(0); // NÃO reenfileirado — repetir daria o mesmo
    expect((await lerObsProcessamento(cache)).ultimoErro).toContain('sem snapshot');
  });
});


// ═══════════════════════════════════════════════════════════════════════════
describe('6. convivência com a reconciliação periódica', () => {
  /** Página do ML sobre uma lista já em ordem date_desc. */
  function paginaDe(lista: OrderSlim[]): FetchOrdersPage {
    return async ({ offset, limit }) => ({
      results: lista.slice(offset, offset + limit) as unknown as OrderInput[],
      total: lista.length,
    });
  }

  it('a sincronização periódica grava chunkCounts — contrato com a leitura', async () => {
    const lista = Array.from({ length: 120 }, (_, i) => pedido(i + 1, i));
    process.env.ORDERS_CHUNK_SIZE = '50';
    resetEnvForTests();

    const r = await runSyncStep(cache, paginaDe(lista), { modo: 'full' });
    expect(r.concluido).toBe(true);

    const man = await readManifest(cache, 'ativos');
    expect(man!.chunkCounts).toEqual([50, 50, 20]);
    delete process.env.ORDERS_CHUNK_SIZE;
    resetEnvForTests();
  });

  it('pedido que entrou por notificação NÃO é duplicado pela reconciliação seguinte', async () => {
    const lista = Array.from({ length: 100 }, (_, i) => pedido(i + 1, i));
    await runSyncStep(cache, paginaDe(lista), { modo: 'full' });

    // Chega uma venda por notificação, antes de o cron rodar de novo.
    const venda = pedido(9999, -1);
    const up = await upsertPedido(cache, venda);
    expect(up.acao).toBe('novo');

    // Agora o cron roda: a API do ML já lista a venda no topo.
    const r = await runSyncStep(cache, paginaDe([venda, ...lista]), { modo: 'incremental' });

    const snap = await readSnapshot(cache, 'ativos');
    expect(snap.filter(o => String(o.id) === '9999'), JSON.stringify(r)).toHaveLength(1);
    expect(snap).toHaveLength(101);
  });

  it('a reconciliação não vê mudança nenhuma quando a notificação já aplicou tudo', async () => {
    const lista = Array.from({ length: 100 }, (_, i) => pedido(i + 1, i));
    await runSyncStep(cache, paginaDe(lista), { modo: 'full' });

    const venda = pedido(9999, -1);
    await upsertPedido(cache, venda);

    const r = await runSyncStep(cache, paginaDe([venda, ...lista]), { modo: 'incremental' });
    expect(r.motivo).toBe('sem_novos');
    expect(r.novosPedidos).toBe(0);
  });

  it('a reconciliação RECUPERA o pedido perdido quando a notificação nunca chegou', async () => {
    const lista = Array.from({ length: 100 }, (_, i) => pedido(i + 1, i));
    await runSyncStep(cache, paginaDe(lista), { modo: 'full' });

    // Notificação perdida: nada entrou pela fila, mas o ML já tem a venda.
    const perdida = pedido(8888, -2);
    const r = await runSyncStep(cache, paginaDe([perdida, ...lista]), { modo: 'incremental' });

    expect(r.concluido).toBe(true);
    expect(r.novosPedidos).toBe(1);
    expect((await readSnapshot(cache, 'ativos')).some(o => String(o.id) === '8888')).toBe(true);
  });

  it('sem nada novo, a reconciliação NÃO republica — os chunks seguem desiguais e a leitura segue certa', async () => {
    const lista = Array.from({ length: 100 }, (_, i) => pedido(i + 1, i));
    process.env.ORDERS_CHUNK_SIZE = '50';
    resetEnvForTests();
    await runSyncStep(cache, paginaDe(lista), { modo: 'full' });

    const novos = [pedido(9003, -3), pedido(9002, -2), pedido(9001, -1)];
    for (const p of [...novos].reverse()) await upsertPedido(cache, p);
    const noML = [...novos, ...lista];

    const r = await runSyncStep(cache, paginaDe(noML), { modo: 'incremental' });
    expect(r.motivo).toBe('sem_novos');

    const man = await readManifest(cache, 'ativos');
    expect(man!.chunkCounts).toEqual([53, 50]); // desigual é um estado NORMAL
    expect(await repaginar(30)).toHaveLength(103);

    delete process.env.ORDERS_CHUNK_SIZE;
    resetEnvForTests();
  });

  it('quando a reconciliação republica, os chunks voltam a ser uniformes sem perder nada', async () => {
    const lista = Array.from({ length: 100 }, (_, i) => pedido(i + 1, i));
    process.env.ORDERS_CHUNK_SIZE = '50';
    resetEnvForTests();
    await runSyncStep(cache, paginaDe(lista), { modo: 'full' });

    const novos = [pedido(9003, -3), pedido(9002, -2), pedido(9001, -1)];
    for (const p of [...novos].reverse()) await upsertPedido(cache, p);
    expect((await readManifest(cache, 'ativos'))!.chunkCounts).toEqual([53, 50]);

    // Uma venda que a notificação NÃO trouxe força a republicação canônica.
    const perdida = pedido(7777, -4);
    await runSyncStep(cache, paginaDe([perdida, ...novos, ...lista]), { modo: 'incremental' });

    const man = await readManifest(cache, 'ativos');
    expect(man!.chunkCounts).toEqual([50, 50, 4]);
    expect(man!.totalRegistros).toBe(104);
    const ids = await repaginar(30);
    expect(ids).toHaveLength(104);
    expect(new Set(ids).size).toBe(104);
    expect(ids[0]).toBe('7777');

    delete process.env.ORDERS_CHUNK_SIZE;
    resetEnvForTests();
  });
});


// ═══════════════════════════════════════════════════════════════════════════
describe('7. portão de pré-merge', () => {
  const notif = (over: Record<string, unknown> = {}) => ({
    _id: 'n1', topic: 'orders_v2', resource: '/orders/2000012345',
    user_id: Number(UID), application_id: Number(APP), ...over,
  });

  it('application_id divergente reprova antes de qualquer coisa', () => {
    const r = interpretarNotificacao(notif({ application_id: 987654321 }), ESPERADO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe('application_id_divergente');
  });

  it('application_id ausente nao reprova; o resto da validacao continua valendo', () => {
    const semApp = notif();
    delete (semApp as Record<string, unknown>).application_id;
    expect(interpretarNotificacao(semApp, ESPERADO).ok).toBe(true);
    // ...mas um user_id errado no MESMO corpo ainda reprova.
    const semAppOutraConta = { ...semApp, user_id: 1 };
    expect(interpretarNotificacao(semAppOutraConta, ESPERADO).ok).toBe(false);
  });

  it('`sent` atravessa a fila; qualquer outro campo do corpo NAO', () => {
    const r = interpretarNotificacao(
      notif({ sent: '2026-08-27T09:00:00.000Z', status: 'cancelled', paid_amount: 1 }),
      ESPERADO
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.evento.sent).toBe('2026-08-27T09:00:00.000Z');
      expect(Object.keys(r.evento).sort()).toEqual(
        ['notifId', 'orderId', 'recebidoEm', 'sent', 'topico']
      );
    }
  });

  it('`sent` fora de formato de data vira null', () => {
    for (const sent of ['ontem', '', 42, null, {}]) {
      const r = interpretarNotificacao(notif({ sent }), ESPERADO);
      expect(r.ok, String(sent)).toBe(true);
      if (r.ok) expect(r.evento.sent).toBeNull();
    }
  });

  /**
   * O ciclo de vida inteiro de um pedido — criacao e mudanca de status — sai
   * de `orders_v2` sozinho. Este teste existe porque a configuracao oficial no
   * painel do ML vai marcar SO esse topico: se algum caminho passasse a
   * depender de `created_orders`, a mudanca de status pararia de chegar e o
   * sintoma apareceria semanas depois, como "as vezes o cancelamento nao
   * atualiza".
   */
  it('orders_v2 sozinho cobre criacao E mudanca de status', async () => {
    const lista = Array.from({ length: 50 }, (_, i) => pedido(i + 1, i));
    const paginaDe = (l: OrderSlim[]) => async ({ offset, limit }: { offset: number; limit: number }) => ({
      results: l.slice(offset, offset + limit) as unknown as OrderInput[],
      total: l.length,
    });
    await runSyncStep(cache, paginaDe(lista), { modo: 'full' });

    const estado = new Map<string, OrderSlim>([['5000', pedido('5000', -1)]]);
    const fn = async (id: string): Promise<OrderInput> => comoInput(estado.get(id)!);

    // 1) criacao, por orders_v2
    await receberNotificacao(cache, { ...notif({ _id: 'a' }), resource: '/orders/5000' }, ESPERADO);
    const criacao = await drenarFila(cache, fn);
    expect(criacao.novos).toBe(1);

    // 2) cancelamento, pelo MESMO topico
    estado.set('5000', pedido('5000', -1, { status: 'cancelled', paid_amount: 0 }));
    await receberNotificacao(cache, { ...notif({ _id: 'b' }), resource: '/orders/5000' }, ESPERADO);
    const mudanca = await drenarFila(cache, fn);
    expect(mudanca.atualizados).toBe(1);

    const gravado = (await readSnapshot(cache, 'ativos')).find(o => String(o.id) === '5000');
    expect(gravado?.status).toBe('cancelled');
  });

  it('a telemetria registra versao publicada e latencia ponta a ponta', async () => {
    const lista = Array.from({ length: 50 }, (_, i) => pedido(i + 1, i));
    const paginaDe = async ({ offset, limit }: { offset: number; limit: number }) => ({
      results: lista.slice(offset, offset + limit) as unknown as OrderInput[],
      total: lista.length,
    });
    await runSyncStep(cache, paginaDe, { modo: 'full' });
    const versaoAntes = (await readManifest(cache, 'ativos'))!.versao;

    const estado = new Map([['5000', pedido('5000', -1)]]);
    const fn = async (id: string): Promise<OrderInput> => comoInput(estado.get(id)!);

    const sent = new Date(Date.now() - 1500).toISOString();
    await receberNotificacao(
      cache, { ...notif({ _id: 'a', sent }), resource: '/orders/5000' }, ESPERADO
    );
    await drenarFila(cache, fn);

    const obs = await lerObsProcessamento(cache);
    expect(obs.ultimaVersaoPublicada).toBe(versaoAntes + 1);
    expect(obs.ultimaLatenciaTotalMs).toBeGreaterThanOrEqual(1500);
    expect(obs.ultimaLatenciaTotalMs).toBeLessThan(60_000);
  });

  it('sem `sent` a latencia fica null em vez de um numero inventado', async () => {
    const lista = Array.from({ length: 50 }, (_, i) => pedido(i + 1, i));
    const paginaDe = async ({ offset, limit }: { offset: number; limit: number }) => ({
      results: lista.slice(offset, offset + limit) as unknown as OrderInput[],
      total: lista.length,
    });
    await runSyncStep(cache, paginaDe, { modo: 'full' });

    const estado = new Map([['5000', pedido('5000', -1)]]);
    const fn = async (id: string): Promise<OrderInput> => comoInput(estado.get(id)!);
    await receberNotificacao(cache, { ...notif({ _id: 'a' }), resource: '/orders/5000' }, ESPERADO);
    await drenarFila(cache, fn);

    expect((await lerObsProcessamento(cache)).ultimaLatenciaTotalMs).toBeNull();
  });

  it('o ack registra ackMs quando recebe o inicio da medicao', async () => {
    await receberNotificacao(
      cache, notif(), ESPERADO, { inicioMs: Date.now() - 30, waitUntilDisponivel: true }
    );
    const obs = await lerObsRecebimento(cache);
    expect(obs.ultimoAckMs).toBeGreaterThanOrEqual(30);
    expect(obs.waitUntilDisponivel).toBe(true);
  });
});
