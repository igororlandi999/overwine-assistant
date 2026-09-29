/**
 * Carga COMPLETA (`modo: full`) sobre um snapshot que JÁ EXISTE.
 *
 * É o procedimento que será executado na Degustar para que os pedidos já
 * carregados ganhem `sale_fee`. O que fica travado:
 *  - nenhum pedido duplicado, nenhum perdido, campos preservados;
 *  - a versão anterior continua legível depois da publicação;
 *  - se a carga falha no meio, o snapshot publicado NÃO muda — nem o
 *    manifesto, nem um byte dos chunks — e a retomada conclui;
 *  - a carga de uma conta não toca em nenhuma chave da outra.
 *
 * E um limite que o teste DOCUMENTA em vez de esconder: a carga completa
 * publica o que o Mercado Livre devolve. Pedido que ele deixar de devolver
 * sai do snapshot. Por isso o procedimento confere o total antes e depois.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { contaPorId } from '../src/config/contas.js';
import { cacheDaConta } from '../src/lib/cache/conta-cache.js';
import type { Cache } from '../src/lib/cache/cache.js';
import { runSyncStep, type FetchOrdersPage } from '../src/services/orders-sync.service.js';
import { readManifest, readPreviousManifest, readSnapshot, readChunkByKey } from '../src/lib/orders-store.js';
import type { OrderInput, OrderSlim } from '../src/services/orders.service.js';

const DG = 'degustar-ml';

function pedido(id: number, o: { fee?: number; status?: string; valor?: number } = {}): OrderInput {
  const oi: Record<string, unknown> = {
    quantity: 2, unit_price: 99.9,
    item: { id: 'MLB-DG1', title: 'Vinho', seller_sku: '21003', variation_id: null },
  };
  if (typeof o.fee === 'number') oi.sale_fee = o.fee;
  return {
    id, status: o.status ?? 'paid',
    // mais novo primeiro: id maior = data mais recente
    date_created: new Date(Date.UTC(2026, 7, 1) + id * 3600_000).toISOString(),
    paid_amount: o.valor ?? 199.8, total_amount: o.valor ?? 199.8,
    buyer: { nickname: 'COMPRADOR' + id },
    shipping: { id: 900000 + id, logistic_type: null },
    order_items: [oi],
  } as unknown as OrderInput;
}
const lista = (n: number, o: { fee?: number } = {}) => Array.from({ length: n }, (_, i) => pedido(n - i, o));

function fetcher(todos: OrderInput[], opts: { falharEm?: number; chamadas?: number[] } = {}): FetchOrdersPage {
  return async ({ offset, limit }) => {
    opts.chamadas?.push(offset);
    if (opts.falharEm !== undefined && offset === opts.falharEm) throw new Error(`falha simulada no offset ${offset}`);
    return { results: todos.slice(offset, offset + limit), total: todos.length };
  };
}

let base: FakeCache;
let cache: Cache;
const FULL = { alvo: 'ativos' as const, modo: 'full' as const };

/** Tudo o que esta publicado: manifesto e o conteudo bruto de cada chunk. */
async function fotografia(c: Cache) {
  const man = await readManifest(c, 'ativos');
  const chunks: Record<string, OrderSlim[]> = {};
  for (const k of man?.chunks ?? []) chunks[k] = await readChunkByKey(c, k);
  return { man, chunks };
}
const chavesDe = (prefixo: string, dentro: boolean) =>
  [...base.store.keys()].filter(k => k.startsWith(prefixo) === dentro && !k.startsWith('rl:')).sort();

beforeEach(async () => {
  base = new FakeCache();
  Object.assign(process.env, TEST_ENV, {
    ORDERS_CHUNK_SIZE: '10', ORDERS_SYNC_MAX_PAGES: '10', ORDERS_SYNC_MAX_TOTAL: '50000',
    ORDERS_SYNC_LOCK_TTL_S: '120', ORDERS_PAGE_RETRIES: '1',
    MULTI_CONTA_ENABLED: 'true', CONTAS_ATIVAS: DG, ML_DEGUSTAR_USER_ID: '3642371174',
  });
  resetEnvForTests();
  cache = cacheDaConta(base, contaPorId(DG)!);
  // Estado de partida: a carga inicial, feita ANTES de o snapshot guardar sale_fee.
  const r = await runSyncStep(cache, fetcher(lista(21)), FULL);
  expect(r.concluido).toBe(true);
});

describe('carga completa sobre snapshot existente', () => {
  it('partida: 21 pedidos publicados, nenhum com sale_fee', async () => {
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap).toHaveLength(21);
    expect(snap.every(o => !('sale_fee' in o.order_items[0]))).toBe(true);
  });

  it('recarga: mesmos 21 pedidos, sem duplicar, agora com sale_fee, e o resto intacto', async () => {
    const antes = await readSnapshot(cache, 'ativos');
    const vAntes = (await readManifest(cache, 'ativos'))!.versao;

    const r = await runSyncStep(cache, fetcher(lista(21, { fee: 13.99 })), FULL);
    expect(r).toMatchObject({ ok: true, concluido: true });

    const depois = await readSnapshot(cache, 'ativos');
    const man = (await readManifest(cache, 'ativos'))!;
    expect(man.versao).toBe(vAntes + 1);
    expect(man.totalRegistros).toBe(21);
    expect(depois).toHaveLength(21);
    expect(new Set(depois.map(o => String(o.id))).size).toBe(21);
    expect(depois.map(o => o.id)).toEqual(antes.map(o => o.id));           // mesma ordem, mais novo primeiro
    expect(depois.every(o => o.order_items[0].sale_fee === 13.99)).toBe(true);
    // nada mais mudou em nenhum pedido
    const semFee = depois.map(o => ({ ...o, order_items: o.order_items.map(({ sale_fee: _f, ...oi }) => oi) }));
    expect(semFee).toEqual(antes);
    expect(man.chunkCounts?.reduce((s, n) => s + n, 0)).toBe(21);
  });

  it('a versao anterior continua legivel depois da publicacao', async () => {
    const foto = await fotografia(cache);
    await runSyncStep(cache, fetcher(lista(21, { fee: 13.99 })), FULL);
    const previous = (await readPreviousManifest(cache, 'ativos'))!;
    expect(previous.versao).toBe(foto.man!.versao);
    expect(previous.chunks).toEqual(foto.man!.chunks);
    for (const k of previous.chunks) expect(await readChunkByKey(cache, k)).toEqual(foto.chunks[k]);
  });

  it('pedido novo e mudanca de status entram; os demais ficam como estavam', async () => {
    const ml = [pedido(22, { fee: 13.99 }), ...lista(21, { fee: 13.99 })];
    ml[5] = pedido(Number(ml[5].id), { fee: 13.99, status: 'cancelled' });
    const r = await runSyncStep(cache, fetcher(ml), FULL);
    expect(r.concluido).toBe(true);
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap).toHaveLength(22);
    expect(new Set(snap.map(o => String(o.id))).size).toBe(22);
    expect(snap[0].id).toBe(22);
    expect(snap.find(o => o.id === ml[5].id)!.status).toBe('cancelled');
  });

  it('rodar duas vezes seguidas nao duplica nada', async () => {
    await runSyncStep(cache, fetcher(lista(21, { fee: 13.99 })), FULL);
    await runSyncStep(cache, fetcher(lista(21, { fee: 13.99 })), FULL);
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap).toHaveLength(21);
    expect(new Set(snap.map(o => String(o.id))).size).toBe(21);
  });
});

describe('falha no meio da carga', () => {
  // 70 pedidos = duas paginas de 50: da para falhar na segunda.
  beforeEach(async () => {
    const r = await runSyncStep(cache, fetcher(lista(70)), FULL);
    expect(r.concluido).toBe(true);
  });

  it('o snapshot publicado nao muda: nem o manifesto, nem os chunks', async () => {
    const foto = await fotografia(cache);
    const r = await runSyncStep(cache, fetcher(lista(70, { fee: 13.99 }), { falharEm: 50 }), FULL);
    expect(r.concluido).toBe(false);
    expect(r.retomavel).toBe(true);

    const agora = await fotografia(cache);
    expect(agora.man).toEqual(foto.man);
    expect(agora.chunks).toEqual(foto.chunks);
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap).toHaveLength(70);
    expect(snap.every(o => !('sale_fee' in o.order_items[0]))).toBe(true);   // ainda a versao antiga, inteira
  });

  it('falhas repetidas continuam sem tocar no publicado', async () => {
    const foto = await fotografia(cache);
    for (let i = 0; i < 3; i++) {
      const r = await runSyncStep(cache, fetcher(lista(70, { fee: 13.99 }), { falharEm: 50 }), FULL);
      expect(r.concluido).toBe(false);
    }
    expect(await fotografia(cache)).toEqual(foto);
  });

  it('a retomada conclui de onde parou: 70 pedidos, sem duplicar nem perder', async () => {
    const vAntes = (await readManifest(cache, 'ativos'))!.versao;
    await runSyncStep(cache, fetcher(lista(70, { fee: 13.99 }), { falharEm: 50 }), FULL);
    const chamadas: number[] = [];
    const r = await runSyncStep(cache, fetcher(lista(70, { fee: 13.99 }), { chamadas }), FULL);
    expect(r.concluido).toBe(true);
    expect(chamadas).toEqual([50]);                       // nao refaz a primeira pagina
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap).toHaveLength(70);
    expect(new Set(snap.map(o => String(o.id))).size).toBe(70);
    expect(snap.every(o => o.order_items[0].sale_fee === 13.99)).toBe(true);
    expect((await readManifest(cache, 'ativos'))!.versao).toBe(vAntes + 1);
  });

  it('carga incompleta pendente: um passo incremental nao passa por cima dela', async () => {
    const foto = await fotografia(cache);
    await runSyncStep(cache, fetcher(lista(70, { fee: 13.99 }), { falharEm: 50 }), FULL);
    const r = await runSyncStep(cache, fetcher(lista(70, { fee: 13.99 })), { alvo: 'ativos', modo: 'incremental' });
    expect(r.motivo).toBe('job_em_andamento');
    expect(await fotografia(cache)).toEqual(foto);
  });
});

describe('isolamento — a recarga da Degustar nao toca na Overwine', () => {
  it('nenhuma chave da conta legada e criada, alterada ou apagada', async () => {
    // Overwine com snapshot proprio, no espaco sem prefixo.
    const r0 = await runSyncStep(base, fetcher(Array.from({ length: 30 }, (_, i) => pedido(5000 - i))), FULL);
    expect(r0.concluido).toBe(true);
    const chaves = chavesDe('c:degustar-ml:', false);
    const valores = chaves.map(k => base.store.get(k)!.v);

    await runSyncStep(cache, fetcher(lista(21, { fee: 13.99 })), FULL);
    await runSyncStep(cache, fetcher(lista(21, { fee: 13.99 }), { falharEm: 0 }), FULL);

    expect(chavesDe('c:degustar-ml:', false)).toEqual(chaves);
    expect(chaves.map(k => base.store.get(k)!.v)).toEqual(valores);
    expect((await readSnapshot(base, 'ativos')).every(o => Number(o.id) > 4000)).toBe(true);
    expect((await readSnapshot(cache, 'ativos')).every(o => Number(o.id) <= 21)).toBe(true);
  });
});

describe('limite conhecido — a carga completa publica o que o Mercado Livre devolve', () => {
  it('pedido que o ML deixa de devolver SAI do snapshot; a versao anterior guarda os 21', async () => {
    const r = await runSyncStep(cache, fetcher(lista(15, { fee: 13.99 })), FULL);
    expect(r.concluido).toBe(true);
    expect(await readSnapshot(cache, 'ativos')).toHaveLength(15);
    const previous = (await readPreviousManifest(cache, 'ativos'))!;
    expect(previous.totalRegistros).toBe(21);
    let n = 0;
    for (const k of previous.chunks) n += (await readChunkByKey(cache, k)).length;
    expect(n).toBe(21);
  });
});
