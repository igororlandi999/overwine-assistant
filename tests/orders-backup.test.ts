/**
 * Cópia de segurança e restauração do snapshot de pedidos de uma conta.
 *
 * É a rede de segurança da recarga completa da Degustar. O que fica travado:
 *  - copiar não altera o snapshot publicado;
 *  - a cópia sobrevive a QUALQUER número de publicações seguintes (o
 *    `manifest:previous` do store não sobrevive nem a duas);
 *  - restaurar devolve exatamente os pedidos copiados, numa versão MAIOR;
 *  - cópia e restauração são da conta: a outra não é tocada;
 *  - não rodam por cima de uma sincronização em andamento.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests, type Cache } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { contaPorId } from '../src/config/contas.js';
import { cacheDaConta } from '../src/lib/cache/conta-cache.js';
import { runSyncStep, ORDERS_SYNC_LOCK_KEY, type FetchOrdersPage } from '../src/services/orders-sync.service.js';
import { readManifest, readSnapshot } from '../src/lib/orders-store.js';
import { criarBackup, restaurarBackup, lerBackup, BACKUP_TTL_S } from '../src/services/orders-backup.service.js';
import type { OrderInput } from '../src/services/orders.service.js';
import syncHandler from '../api/admin/orders-sync.js';

const DG = 'degustar-ml';
const FULL = { alvo: 'ativos' as const, modo: 'full' as const };

function pedido(id: number, fee?: number): OrderInput {
  const oi: Record<string, unknown> = { quantity: 2, unit_price: 99.9, item: { id: 'MLB-DG1', title: 'Vinho', seller_sku: '21003', variation_id: null } };
  if (typeof fee === 'number') oi.sale_fee = fee;
  return {
    id, status: 'paid', date_created: new Date(Date.UTC(2026, 7, 1) + id * 3600_000).toISOString(),
    paid_amount: 199.8, total_amount: 199.8, buyer: { nickname: 'C' + id }, shipping: { id: 900000 + id, logistic_type: null },
    order_items: [oi],
  } as unknown as OrderInput;
}
const lista = (n: number, fee?: number) => Array.from({ length: n }, (_, i) => pedido(n - i, fee));
const fetcher = (todos: OrderInput[]): FetchOrdersPage =>
  async ({ offset, limit }) => ({ results: todos.slice(offset, offset + limit), total: todos.length });

let base: FakeCache;
let cache: Cache;
beforeEach(async () => {
  base = new FakeCache();
  setCacheForTests(base);
  Object.assign(process.env, TEST_ENV, {
    ORDERS_CHUNK_SIZE: '10', ORDERS_SYNC_MAX_PAGES: '10', ORDERS_SYNC_MAX_TOTAL: '50000',
    ORDERS_SYNC_LOCK_TTL_S: '120', ORDERS_PAGE_RETRIES: '1',
    MULTI_CONTA_ENABLED: 'true', CONTAS_ATIVAS: DG, ML_DEGUSTAR_USER_ID: '3642371174',
  });
  resetEnvForTests();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  cache = cacheDaConta(base, contaPorId(DG)!);
  expect((await runSyncStep(cache, fetcher(lista(21)), FULL)).concluido).toBe(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CONTAS_ATIVAS; delete process.env.MULTI_CONTA_ENABLED; delete process.env.ML_DEGUSTAR_USER_ID;
});

const publicado = async (c: Cache) => ({ man: await readManifest(c, 'ativos'), snap: await readSnapshot(c, 'ativos') });

describe('copiar', () => {
  it('guarda os 21 pedidos e NAO altera o snapshot publicado', async () => {
    const antes = await publicado(cache);
    const r = await criarBackup(cache);
    expect(r).toMatchObject({ ok: true, backup: { versaoOrigem: antes.man!.versao, totalRegistros: 21, conferido: true } });
    expect(await publicado(cache)).toEqual(antes);
    expect(await base.get(ORDERS_SYNC_LOCK_KEY)).toBeNull();
    expect(await base.get('c:degustar-ml:' + ORDERS_SYNC_LOCK_KEY)).toBeNull();   // lock devolvido
  });

  it('a copia tem prazo de validade, e vive no espaco da conta', async () => {
    await criarBackup(cache);
    const chaves = [...base.store.keys()].filter(k => k.includes('orders:backup:'));
    expect(chaves.length).toBeGreaterThan(1);
    for (const k of chaves) {
      expect(k.startsWith('c:degustar-ml:orders:backup:ativos:')).toBe(true);
      const exp = base.store.get(k)!.exp!;
      expect(Math.round((exp - Date.now()) / 1000)).toBeGreaterThan(BACKUP_TTL_S - 5);
    }
  });

  it('sem snapshot nao ha o que copiar', async () => {
    const vazia = cacheDaConta(new FakeCache(), contaPorId(DG)!);
    expect(await criarBackup(vazia)).toEqual({ ok: false, acao: 'backup', motivo: 'sem_snapshot' });
  });

  it('com sincronizacao em andamento, recusa e nao grava nada', async () => {
    await cache.setNX(ORDERS_SYNC_LOCK_KEY, 'outro', 120);
    expect(await criarBackup(cache)).toEqual({ ok: false, acao: 'backup', motivo: 'sync_em_andamento' });
    expect(await lerBackup(cache, 'ativos')).toBeNull();
  });

  it('copia nova substitui a anterior sem deixar blocos orfaos', async () => {
    await criarBackup(cache);
    await runSyncStep(cache, fetcher(lista(25)), FULL);
    const r = await criarBackup(cache);
    expect(r).toMatchObject({ ok: true, backup: { totalRegistros: 25 } });
    const meta = (await lerBackup(cache, 'ativos'))!;
    const blocos = [...base.store.keys()].filter(k => /orders:backup:ativos:[^:]+:\d+$/.test(k));
    expect(blocos.sort()).toEqual(meta.blocos.map(b => 'c:degustar-ml:' + b).sort());
  });
});

describe('restaurar', () => {
  it('perda inesperada: a recarga trouxe 15 de 21; restaurar devolve os 21, em versao maior', async () => {
    const original = await publicado(cache);
    await criarBackup(cache);
    await runSyncStep(cache, fetcher(lista(15, 13.99)), FULL);
    expect((await readSnapshot(cache, 'ativos'))).toHaveLength(15);
    const vPerda = (await readManifest(cache, 'ativos'))!.versao;

    const r = await restaurarBackup(cache);
    expect(r).toMatchObject({ ok: true, totalRegistros: 21, versaoAnterior: vPerda, deVersao: original.man!.versao });
    const depois = await publicado(cache);
    expect(depois.snap).toEqual(original.snap);                       // os mesmos pedidos, campo a campo
    expect(depois.man!.versao).toBeGreaterThan(vPerda);               // a versao so cresce
    expect(depois.man!.totalRegistros).toBe(21);
    expect(depois.man!.chunkCounts!.reduce((s, n) => s + n, 0)).toBe(21);
    expect(new Set(depois.snap.map(o => String(o.id))).size).toBe(21);
  });

  it('a copia sobrevive a VARIAS publicacoes — onde o manifest:previous ja teria sumido', async () => {
    const original = await readSnapshot(cache, 'ativos');
    await criarBackup(cache);
    for (const n of [15, 16, 17, 18]) await runSyncStep(cache, fetcher(lista(n, 13.99)), FULL);
    const r = await restaurarBackup(cache);
    expect(r.ok).toBe(true);
    expect(await readSnapshot(cache, 'ativos')).toEqual(original);
  });

  it('restaurar duas vezes e inofensivo', async () => {
    const original = await readSnapshot(cache, 'ativos');
    await criarBackup(cache);
    await runSyncStep(cache, fetcher(lista(15)), FULL);
    const a = await restaurarBackup(cache);
    const b = await restaurarBackup(cache);
    expect(a.ok && b.ok).toBe(true);
    expect((b as any).versaoPublicada).toBeGreaterThan((a as any).versaoPublicada);
    expect(await readSnapshot(cache, 'ativos')).toEqual(original);
  });

  it('depois de restaurar, a sincronizacao segue normal e uma venda nova entra', async () => {
    await criarBackup(cache);
    await runSyncStep(cache, fetcher(lista(15)), FULL);
    await restaurarBackup(cache);
    const r = await runSyncStep(cache, fetcher(lista(22)), { alvo: 'ativos', modo: 'incremental' });
    expect(r.ok).toBe(true);
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap).toHaveLength(22);
    expect(new Set(snap.map(o => String(o.id))).size).toBe(22);
  });

  it('carga completa pendente e descartada: nao pode ser retomada por cima da restauracao', async () => {
    await criarBackup(cache);
    const grande = lista(70, 13.99);
    const falha: FetchOrdersPage = async ({ offset, limit }) => {
      if (offset === 50) throw new Error('falha');
      return { results: grande.slice(offset, offset + limit), total: grande.length };
    };
    expect((await runSyncStep(cache, falha, FULL)).concluido).toBe(false);
    expect(await cache.get('orders:sync:job:ativos')).not.toBeNull();
    expect((await restaurarBackup(cache)).ok).toBe(true);
    expect(await cache.get('orders:sync:job:ativos')).toBeNull();
    expect(await readSnapshot(cache, 'ativos')).toHaveLength(21);
  });

  it('sem copia: recusa, e o publicado fica como esta', async () => {
    const antes = await publicado(cache);
    expect(await restaurarBackup(cache)).toEqual({ ok: false, acao: 'restaurar', motivo: 'sem_backup' });
    expect(await publicado(cache)).toEqual(antes);
  });

  it('copia com bloco faltando: recusa — nao publica snapshot pela metade', async () => {
    await criarBackup(cache);
    const meta = (await lerBackup(cache, 'ativos'))!;
    await cache.del(meta.blocos[0]);
    const antes = await publicado(cache);
    expect(await restaurarBackup(cache)).toEqual({ ok: false, acao: 'restaurar', motivo: 'backup_incompleto' });
    expect(await publicado(cache)).toEqual(antes);
  });

  it('com sincronizacao em andamento, recusa', async () => {
    await criarBackup(cache);
    await cache.setNX(ORDERS_SYNC_LOCK_KEY, 'outro', 120);
    expect(await restaurarBackup(cache)).toEqual({ ok: false, acao: 'restaurar', motivo: 'sync_em_andamento' });
  });
});

describe('isolamento', () => {
  it('copiar e restaurar a Degustar nao cria, altera nem apaga chave da Overwine', async () => {
    expect((await runSyncStep(base, fetcher(Array.from({ length: 30 }, (_, i) => pedido(5000 - i))), FULL)).concluido).toBe(true);
    const deFora = () => [...base.store.keys()].filter(k => !k.startsWith('c:degustar-ml:')).sort();
    const chaves = deFora();
    const valores = chaves.map(k => base.store.get(k)!.v);
    await criarBackup(cache);
    await runSyncStep(cache, fetcher(lista(15)), FULL);
    await restaurarBackup(cache);
    expect(deFora()).toEqual(chaves);
    expect(chaves.map(k => base.store.get(k)!.v)).toEqual(valores);
    expect(await lerBackup(base, 'ativos')).toBeNull();               // a Overwine nao ganhou copia
  });
});

describe('pela rota administrativa', () => {
  function req(body: unknown, chave = TEST_ENV.ADMIN_KEY) {
    return { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': chave }, query: {}, body, socket: { remoteAddress: '10.0.0.9' } } as any;
  }
  function res() {
    const r: any = { statusCode: 0, body: undefined };
    r.status = (c: number) => { r.statusCode = c; return r; };
    r.setHeader = () => r;
    r.send = (b: any) => { r.body = b; return r; };
    r.end = () => r;
    r.json = () => JSON.parse(r.body);
    return r;
  }
  const chamar = async (body: unknown, chave?: string) => { const r = res(); await syncHandler(req(body, chave), r); return r; };

  it('ver_backup, backup e restaurar, com a conta no corpo', async () => {
    const v0 = (await chamar({ acao: 'ver_backup', conta: DG })).json();
    expect(v0).toMatchObject({ ok: true, conta: DG, atual: { totalRegistros: 21 }, backup: null });

    const b = await chamar({ acao: 'backup', conta: DG });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ ok: true, conta: DG, backup: { totalRegistros: 21, conferido: true } });

    await runSyncStep(cache, fetcher(lista(15)), FULL);
    const r = await chamar({ acao: 'restaurar', conta: DG });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, conta: DG, totalRegistros: 21 });
    expect(await readSnapshot(cache, 'ativos')).toHaveLength(21);
  });

  it('nao vaza pedido, chave Redis nem token na resposta', async () => {
    const b = await chamar({ acao: 'backup', conta: DG });
    for (const proibido of ['orders:backup', 'c:degustar-ml', 'nickname', 'MLB-DG1', 'order_items']) {
      expect(b.body as string).not.toContain(proibido);
    }
  });

  it('sem a chave administrativa: 401, e nada e copiado', async () => {
    const r = await chamar({ acao: 'backup', conta: DG }, 'chave-errada-de-teste-16');
    expect(r.statusCode).toBe(401);
    expect(await lerBackup(cache, 'ativos')).toBeNull();
  });

  it('restaurar sem copia: 409 com o motivo', async () => {
    const r = await chamar({ acao: 'restaurar', conta: DG });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ ok: false, motivo: 'sem_backup', conta: DG });
  });

  it('sem conta no corpo a acao e da conta legada — nunca da Degustar por engano', async () => {
    const r = await chamar({ acao: 'restaurar' });
    expect(r.json()).toMatchObject({ ok: false, motivo: 'sem_backup', conta: 'overwine-ml' });
    expect(await readSnapshot(cache, 'ativos')).toHaveLength(21);
  });
});
