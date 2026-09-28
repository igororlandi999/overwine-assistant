/**
 * cacheDaConta — o unico mecanismo de isolamento entre contas.
 *
 * Tres coisas travadas aqui:
 *  1. COBERTURA: todo metodo do `Cache` e prefixado, e um metodo novo na
 *     interface (medido pelo FakeCache, que a implementa) quebra o teste se
 *     nao for coberto — inclusive os atomicos (setNX, delIfEquals, incr) e a
 *     fila (rpush/lpopMany/llen).
 *  2. LEGADA INTACTA: a conta legada recebe o cache ORIGINAL, sem prefixo —
 *     nenhuma chave de producao muda de nome.
 *  3. ISOLAMENTO REAL: os stores e servicos existentes, rodando com duas contas
 *     sobre o mesmo Redis falso, nao compartilham UMA chave: snapshot, job,
 *     status, lock, cooldown, assinatura, telemetria, fila, tokens do ML.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { cacheDaConta, METODOS_CACHE } from '../src/lib/cache/conta-cache.js';
import { contaLegada, contaPorId } from '../src/config/contas.js';
import { type OrdersManifest, writeChunk, publishManifest, readSnapshot, readManifest } from '../src/lib/orders-store.js';
import { runSyncStep, ORDERS_SYNC_LOCK_KEY, type FetchOrdersPage } from '../src/services/orders-sync.service.js';
import { refrescarSeVelho, CHAVE_COOLDOWN_REFRESH } from '../src/services/orders-refresh.service.js';
import { receberNotificacao, drenarFila, upsertPedido } from '../src/services/orders-webhook.service.js';
import { CHAVE_FILA } from '../src/lib/orders-events.js';
import type { OrderInput, OrderSlim } from '../src/services/orders.service.js';

let base: FakeCache;
beforeEach(() => { base = new FakeCache(); Object.assign(process.env, TEST_ENV); resetEnvForTests(); });

const DEGUSTAR = { id: 'degustar-ml', prefixo: 'c:degustar-ml:', legada: false };
const AMAZON = { id: 'alemmar-amazon', prefixo: 'c:alemmar-amazon:', legada: false };

describe('1. cobertura da interface', () => {
  it('cobre todos os metodos que o FakeCache (implementacao de referencia) expoe', () => {
    const doFake = Object.getOwnPropertyNames(FakeCache.prototype)
      .filter(n => n !== 'constructor' && typeof (FakeCache.prototype as any)[n] === 'function' && !n.startsWith('_') && n !== 'alive');
    for (const m of doFake) expect(METODOS_CACHE as readonly string[]).toContain(m);
    const wrapper = cacheDaConta(base, DEGUSTAR) as any;
    for (const m of METODOS_CACHE) expect(typeof wrapper[m]).toBe('function');
  });

  it('cada metodo grava/le com o prefixo — string, TTL, NX, CAD, incr e fila', async () => {
    const c = cacheDaConta(base, DEGUSTAR);
    await c.set('k', 'v', 60);
    expect(base.store.get('c:degustar-ml:k')!.v).toBe('v');
    expect(base.store.get('k')).toBeUndefined();
    expect(await c.get('k')).toBe('v');
    expect(await c.setNX('lock', 'dono', 10)).toBe(true);
    expect(await base.setNX('lock', 'outro', 10)).toBe(true);          // o lock sem prefixo e OUTRO lock
    expect(await c.delIfEquals('lock', 'errado')).toBe(false);
    expect(await c.delIfEquals('lock', 'dono')).toBe(true);
    expect(base.store.has('lock')).toBe(true);                          // o da legada ficou
    expect(await c.incr('cnt', 60)).toBe(1);
    expect(await c.incr('cnt', 60)).toBe(2);
    expect(base.store.get('c:degustar-ml:cnt')!.v).toBe('2');
    expect(await c.rpush('fila', 'a', 'b')).toBe(2);
    expect(await c.llen('fila')).toBe(2);
    expect(await base.llen('fila')).toBe(0);
    expect(await c.lpopMany('fila', 1)).toEqual(['a']);
    await c.del('k');
    expect(await c.get('k')).toBeNull();
  });

  it('a conta legada recebe o cache ORIGINAL: nenhuma chave muda', async () => {
    const c = cacheDaConta(base, contaLegada());
    expect(c).toBe(base);
    await c.set('orders:manifest', 'x');
    expect(base.store.has('orders:manifest')).toBe(true);
  });

  it('prefixo invalido ou vazio fora da legada e recusado', () => {
    expect(() => cacheDaConta(base, { id: 'x', prefixo: '', legada: false })).toThrow();
    expect(() => cacheDaConta(base, { id: 'x', prefixo: 'sem-dois-pontos', legada: false })).toThrow();
    expect(() => cacheDaConta(base, { id: 'x', prefixo: 'c:X:', legada: false })).toThrow();
  });
});

// ── fixtures ──────────────────────────────────────────────────────────────
const data = (i: number) => new Date(Date.UTC(2026, 8, 20, 12, 0, 0) - i * 60_000).toISOString();
const pedido = (id: number | string, i: number): OrderSlim => ({
  id, status: 'paid', date_created: data(i), paid_amount: 100, total_amount: 100,
  order_items: [{ quantity: 1, unit_price: 100, item: { id: 'MLB1', title: 'V', seller_sku: 'S', variation_id: null } }],
});
const fetcher = (lista: OrderSlim[]): FetchOrdersPage => async ({ offset, limit }) =>
  ({ results: lista.slice(offset, offset + limit) as unknown as OrderInput[], total: lista.length });
async function publicarBase(cache: ReturnType<typeof cacheDaConta>, n: number, marca: string) {
  const pedidos = Array.from({ length: n }, (_, i) => pedido(`${marca}${i + 1}`, i));
  const chave = await writeChunk(cache, 'ativos', 1, 0, pedidos);
  const man: OrdersManifest = { versao: 1, chunks: [chave], totalRegistros: n, newestDate: pedidos[0].date_created, oldestDate: pedidos[n - 1].date_created, chunkSize: 500, updatedAt: data(0), origem: 'full', chunkCounts: [n] };
  await publishManifest(cache, 'ativos', man);
  return pedidos;
}
const chavesCom = (prefixo: string) => [...base.store.keys(), ...base.lists.keys()].filter(k => k.startsWith(prefixo));
const chavesSemPrefixo = () => [...base.store.keys(), ...base.lists.keys()].filter(k => !k.startsWith('c:'));

describe('3. isolamento real entre contas, com os stores e servicos existentes', () => {
  it('duas contas sincronizando sobre o mesmo Redis: snapshots, jobs, status e locks disjuntos', async () => {
    const legada = cacheDaConta(base, contaLegada());
    const degustar = cacheDaConta(base, DEGUSTAR);
    const pl = await publicarBase(legada, 10, 'L');
    const pd = await publicarBase(degustar, 5, 'D');

    const rl = await runSyncStep(legada, fetcher([pedido('L-novo', -1), ...pl]), { modo: 'incremental' });
    const rd = await runSyncStep(degustar, fetcher([pedido('D-novo', -1), ...pd]), { modo: 'incremental' });
    expect(rl.concluido && rd.concluido).toBe(true);

    const snapL = await readSnapshot(legada, 'ativos');
    const snapD = await readSnapshot(degustar, 'ativos');
    expect(snapL.map(o => String(o.id))).toContain('L-novo');
    expect(snapL.map(o => String(o.id))).not.toContain('D-novo');
    expect(snapD.map(o => String(o.id))).toContain('D-novo');
    expect(snapD).toHaveLength(6);
    expect(snapL).toHaveLength(11);

    // tudo da Degustar vive sob o prefixo; nada dela vazou para o espaco legado
    const legadas = chavesSemPrefixo();
    for (const k of legadas) expect(k).not.toMatch(/degustar|D-novo/);
    expect(chavesCom('c:degustar-ml:').some(k => k.includes('orders:manifest'))).toBe(true);
    expect((await readManifest(legada, 'ativos'))!.versao).toBe(2);
    expect((await readManifest(degustar, 'ativos'))!.versao).toBe(2);
  });

  it('lock de uma conta nao bloqueia a outra; cooldown do refresh idem', async () => {
    const legada = cacheDaConta(base, contaLegada());
    const degustar = cacheDaConta(base, DEGUSTAR);
    const pl = await publicarBase(legada, 10, 'L');
    const pd = await publicarBase(degustar, 5, 'D');
    await legada.set('orders:sync:status:ativos', JSON.stringify({ ultimaVersao: 1, totalRegistros: 10, newestDate: null, lastSyncAt: new Date(Date.now() - 600_000).toISOString(), lastResult: 'ok', emAndamento: false, ultimaRevisaoEm: new Date().toISOString() }));
    await degustar.set('orders:sync:status:ativos', JSON.stringify({ ultimaVersao: 1, totalRegistros: 5, newestDate: null, lastSyncAt: new Date(Date.now() - 600_000).toISOString(), lastResult: 'ok', emAndamento: false, ultimaRevisaoEm: new Date().toISOString() }));

    await legada.setNX(ORDERS_SYNC_LOCK_KEY, 'reconciliacao-legada', 120);   // lock SO da legada
    const rd = await refrescarSeVelho(degustar, fetcher([pedido('D-novo', -1), ...pd]));
    expect(rd.acao).toBe('sincronizado');                                      // Degustar nao viu o lock
    const rl = await refrescarSeVelho(legada, fetcher([pedido('L-novo', -1), ...pl]));
    expect(rl.acao).toBe('sync_em_andamento');
    expect(base.store.has(CHAVE_COOLDOWN_REFRESH)).toBe(true);
    expect(base.store.has('c:degustar-ml:' + CHAVE_COOLDOWN_REFRESH)).toBe(true);
  });

  it('fila de notificacoes e upsert por webhook sao por conta', async () => {
    const legada = cacheDaConta(base, contaLegada());
    const amazonComoTeste = cacheDaConta(base, AMAZON);   // qualquer prefixo serve para provar o isolamento
    await publicarBase(legada, 3, 'L');
    await publicarBase(amazonComoTeste, 3, 'A');

    const corpo = { _id: 'n1', topic: 'orders_v2', resource: '/orders/2000000000001', user_id: 1, application_id: 123, sent: data(0) };
    const r = await receberNotificacao(amazonComoTeste, corpo, { mlUserId: '1', applicationId: '123' }, { inicioMs: Date.now() });
    expect(r.aceito).toBe(true);
    expect(await amazonComoTeste.llen(CHAVE_FILA)).toBe(1);
    expect(await legada.llen(CHAVE_FILA)).toBe(0);
    expect(base.lists.has('c:alemmar-amazon:' + CHAVE_FILA)).toBe(true);

    const dreno = await drenarFila(amazonComoTeste, async id => ({ ...pedido(id, -1) } as unknown as OrderInput));
    expect(dreno.novos).toBe(1);
    expect((await readSnapshot(amazonComoTeste, 'ativos')).some(o => String(o.id) === '2000000000001')).toBe(true);
    expect((await readSnapshot(legada, 'ativos')).some(o => String(o.id) === '2000000000001')).toBe(false);
  });

  it('tokens do ML (ml:*) ficam no espaco da conta', async () => {
    const degustar = cacheDaConta(base, DEGUSTAR);
    await degustar.set('ml:refresh_token', 'TG-degustar', 60);
    await base.set('ml:refresh_token', 'TG-legada', 60);
    expect(await degustar.get('ml:refresh_token')).toBe('TG-degustar');
    expect(await cacheDaConta(base, contaLegada()).get('ml:refresh_token')).toBe('TG-legada');
  });

  it('upsert direto: o pedido de uma conta nunca aparece no snapshot da outra', async () => {
    const legada = cacheDaConta(base, contaLegada());
    const degustar = cacheDaConta(base, DEGUSTAR);
    await publicarBase(legada, 3, 'L');
    await publicarBase(degustar, 3, 'D');
    await upsertPedido(degustar, pedido('so-degustar', -1), 'ativos', 'webhook');
    expect((await readSnapshot(degustar, 'ativos')).some(o => o.id === 'so-degustar')).toBe(true);
    expect((await readSnapshot(legada, 'ativos')).some(o => o.id === 'so-degustar')).toBe(false);
    expect(contaPorId('degustar-ml')!.prefixo).toBe(DEGUSTAR.prefixo);
  });
});
