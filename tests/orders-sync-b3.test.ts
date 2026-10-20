/**
 * B3 (10/2026) — passo de reconciliação sem regravação redundante.
 *
 * Uma invocação que CONCLUI a varredura decide com as páginas em memória:
 * sem build chunks, sem job, sem releitura de manifesto. Só uma invocação que
 * termina parcial ou com erro grava build chunks e job (estado retomável
 * idêntico ao de antes). Estes testes usam os defaults reais de produção
 * (chunk 500, 5 páginas por passo) e contam comandos no cache.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { runSyncStep, readStatus, type FetchOrdersPage } from '../src/services/orders-sync.service.js';
import { readManifest, readSnapshot } from '../src/lib/orders-store.js';
import { cacheDaConta } from '../src/lib/cache/conta-cache.js';
import { contaLegada, contaPorId } from '../src/config/contas.js';
import type { Cache } from '../src/lib/cache/cache.js';
import type { OrderInput } from '../src/services/orders.service.js';

function setEnv(over: Record<string, string> = {}) {
  Object.assign(process.env, TEST_ENV, {
    ORDERS_CHUNK_SIZE: '500',
    ORDERS_SYNC_MAX_PAGES: '5',
    ORDERS_SYNC_MAX_TOTAL: '50000',
    ORDERS_SYNC_LOCK_TTL_S: '120',
    ORDERS_PAGE_RETRIES: '0',
    MULTI_CONTA_ENABLED: 'true',
    CONTAS_ATIVAS: 'degustar-ml',
    ML_DEGUSTAR_USER_ID: '999',
    ...over,
  });
  resetEnvForTests();
}

/** Cache que conta comandos e registra as chaves gravadas/apagadas. */
class Contador implements Cache {
  n: Record<string, number> = {};
  escritas: string[] = [];
  apagadas: string[] = [];
  falharSetEm: ((k: string) => boolean) | null = null;
  constructor(readonly base: FakeCache) {}
  get total() { return Object.values(this.n).reduce((a, b) => a + b, 0); }
  zerar() { this.n = {}; this.escritas = []; this.apagadas = []; }
  private c(m: string) { this.n[m] = (this.n[m] ?? 0) + 1; }
  get(k: string) { this.c('get'); return this.base.get(k); }
  async set(k: string, v: string, t?: number) {
    this.c('set');
    if (this.falharSetEm?.(k)) throw new Error('queda simulada');
    this.escritas.push(k);
    return this.base.set(k, v, t);
  }
  del(k: string) { this.c('del'); this.apagadas.push(k); return this.base.del(k); }
  setNX(k: string, v: string, t: number) { this.c('setNX'); return this.base.setNX(k, v, t); }
  delIfEquals(k: string, v: string) { this.c('delIfEquals'); return this.base.delIfEquals(k, v); }
  incr(k: string, t: number) { this.c('incr'); return this.base.incr(k, t); }
  rpush(k: string, ...v: string[]) { this.c('rpush'); return this.base.rpush(k, ...v); }
  lpopMany(k: string, m: number) { this.c('lpopMany'); return this.base.lpopMany(k, m); }
  llen(k: string) { this.c('llen'); return this.base.llen(k); }
}

/** id maior = mais antigo, para a lista sair em date_desc como na API. */
const ped = (id: number, over: Partial<OrderInput> = {}): OrderInput => ({
  id,
  status: 'paid',
  date_created: new Date(Date.UTC(2026, 9, 20) - id * 3600_000).toISOString(),
  paid_amount: 100,
  total_amount: 100,
  order_items: [{ quantity: 1, unit_price: 100, item: { id: 'MLB1', title: 'V', seller_sku: 'S', variation_id: 1 } }],
  ...over,
} as OrderInput);

const lista = (n: number, inicio = 1) => Array.from({ length: n }, (_, i) => ped(inicio + i));

function fetcher(todos: OrderInput[], opts: { falharEm?: number } = {}): FetchOrdersPage {
  return async ({ offset, limit }) => {
    if (opts.falharEm !== undefined && offset === opts.falharEm) throw new Error(`falha simulada no offset ${offset}`);
    return { results: todos.slice(offset, offset + limit), total: todos.length };
  };
}

/** Repete o passo até não ser mais retomável — o que o workflow faz (MAX_PASSOS). */
async function ateConcluir(c: Cache, todos: OrderInput[], modo?: 'full' | 'incremental') {
  for (let i = 0; i < 200; i++) {
    const r = await runSyncStep(c, fetcher(todos), { alvo: 'ativos', ...(i === 0 && modo ? { modo } : {}) });
    if (!r.retomavel) return r;
  }
  throw new Error('sincronização não concluiu');
}
const cargaInicial = (c: Cache, todos: OrderInput[]) => ateConcluir(c, todos);

const ehBuild = (k: string) => k.includes('orders:build:chunk:');
const ehJob = (k: string) => k.endsWith('orders:sync:job:ativos');
const ids = (snap: { id: unknown }[]) => snap.map(o => Number(o.id)).sort((a, b) => a - b);

let base: FakeCache;
let cont: Contador;
beforeEach(() => { setEnv(); base = new FakeCache(); cont = new Contador(base); });

const CONTAS = [
  { nome: 'Overwine ML (legada)', cache: () => cacheDaConta(cont, contaLegada()), pedidos: 5985, prefixo: '' },
  { nome: 'Degustar', cache: () => cacheDaConta(cont, contaPorId('degustar-ml')!), pedidos: 150, prefixo: 'c:degustar-ml:' },
];

describe.each(CONTAS)('B3 — $nome', ({ cache, pedidos, prefixo }) => {
  it('1. sem pedido novo: nenhum build chunk, job ou manifesto regravado; só o status', async () => {
    const c = cache();
    const todos = lista(pedidos);
    await cargaInicial(c, todos);
    const manAntes = await readManifest(c, 'ativos');
    const snapAntes = await readSnapshot(c, 'ativos');
    const statusAntes = await readStatus(c, 'ativos');
    cont.zerar();

    const r = await runSyncStep(c, fetcher(todos), { alvo: 'ativos' });

    expect(r.motivo).toBe('sem_novos');
    expect(r.ok).toBe(true);
    expect(r.retomavel).toBe(false);
    // Única gravação: o status (lastSyncAt/ultimaRevisaoEm avançam).
    expect(cont.escritas).toEqual([`${prefixo}orders:sync:status:ativos`]);
    expect(cont.apagadas).toEqual([]);
    expect(cont.n.del ?? 0).toBe(0);
    // Leituras: lock + job + manifesto + chunks do snapshot (1 por chunk).
    expect(cont.n.get).toBe(2 + manAntes!.chunks.length);
    expect(cont.total).toBe(2 + manAntes!.chunks.length + 1 /* set status */ + 1 /* setNX */ + 1 /* delIfEquals */);
    // Nada publicado, nada perdido.
    expect(await readManifest(c, 'ativos')).toEqual(manAntes);
    expect(await readSnapshot(c, 'ativos')).toEqual(snapAntes);
    const st = await readStatus(c, 'ativos');
    expect(st?.lastResult).toBe('sem_novos');
    expect(st?.ultimaVersao).toBe(manAntes!.versao);
    expect(st?.totalRegistros).toBe(statusAntes?.totalRegistros);
    expect(st?.ultimaRevisaoEm).not.toBeNull();
    expect([...base.store.keys()].some(ehBuild)).toBe(false);
    expect([...base.store.keys()].some(ehJob)).toBe(false);
  });

  it('2. pedido novo: publica versão nova com o pedido, preserva os antigos', async () => {
    const c = cache();
    const todos = lista(pedidos, 2);
    await cargaInicial(c, todos);
    const versaoAntes = (await readManifest(c, 'ativos'))!.versao;

    const comNovo = [ped(1), ...todos];
    // Overwine: 1 novo + 249 conhecidos nas 5 páginas não fecham a janela de
    // 250 → 1ª invocação parcial (grava), 2ª conclui. Degustar conclui na 1ª.
    const r = await ateConcluir(c, comNovo);

    expect(r.concluido).toBe(true);
    expect(r.novosPedidos).toBe(1);
    const man = await readManifest(c, 'ativos');
    expect(man!.versao).toBe(versaoAntes + 1);
    expect(man!.totalRegistros).toBe(pedidos + 1);
    expect(ids(await readSnapshot(c, 'ativos'))).toEqual(ids(comNovo));
    expect((await readStatus(c, 'ativos'))?.lastResult).toBe('ok');
    // Concluiu na mesma invocação: nada de build chunk nem job sobrando.
    expect([...base.store.keys()].some(ehBuild)).toBe(false);
    expect([...base.store.keys()].some(ehJob)).toBe(false);
  });

  it('3. mudança de status (paid → cancelled) é publicada', async () => {
    const c = cache();
    const todos = lista(pedidos);
    await cargaInicial(c, todos);
    const versaoAntes = (await readManifest(c, 'ativos'))!.versao;

    const alterados = todos.map(o => (o.id === 3 ? ped(3, { status: 'cancelled' }) : o));
    const r = await ateConcluir(c, alterados);

    expect(r.concluido).toBe(true);
    expect(r.novosPedidos).toBe(0);
    expect((await readManifest(c, 'ativos'))!.versao).toBe(versaoAntes + 1);
    const snap = await readSnapshot(c, 'ativos');
    expect(snap.find(o => o.id === 3)?.status).toBe('cancelled');
    expect(snap).toHaveLength(pedidos);
  });

  it('7. rodar de novo após publicar não perde nem duplica nada', async () => {
    const c = cache();
    const todos = lista(pedidos, 2);
    await cargaInicial(c, todos);
    const comNovo = [ped(1), ...todos.map(o => (o.id === 5 ? ped(5, { paid_amount: 90 }) : o))];

    const r1 = await ateConcluir(c, comNovo);
    expect(r1.concluido).toBe(true);
    const man1 = await readManifest(c, 'ativos');
    const snap1 = await readSnapshot(c, 'ativos');

    const r2 = await runSyncStep(c, fetcher(comNovo), { alvo: 'ativos' });
    expect(r2.motivo).toBe('sem_novos');
    expect(await readManifest(c, 'ativos')).toEqual(man1);
    expect(await readSnapshot(c, 'ativos')).toEqual(snap1);
    expect(new Set(snap1.map(o => o.id)).size).toBe(pedidos + 1);
    expect(snap1.find(o => o.id === 5)?.paid_amount).toBe(90);
  });

  it('isolamento: o passo só toca chaves da própria conta', async () => {
    const c = cache();
    const todos = lista(pedidos);
    await cargaInicial(c, todos);
    cont.zerar();
    await ateConcluir(c, [ped(0), ...todos]);
    const tocadas = [...cont.escritas, ...cont.apagadas];
    expect(tocadas.length).toBeGreaterThan(0);
    for (const k of tocadas) {
      if (prefixo) expect(k.startsWith(prefixo)).toBe(true);
      else expect(k.startsWith('c:')).toBe(false);
    }
  });
});

describe('B3 — 6. recuperação e reconciliação profunda continuam funcionando', () => {
  const c = () => cacheDaConta(cont, contaLegada());

  it('backlog maior que um passo: 1ª invocação grava build chunks + job (retomável), 2ª conclui', async () => {
    const cc = c();
    await cargaInicial(cc, [ped(1000)]);
    const manAntes = await readManifest(cc, 'ativos');
    const novos = lista(320);
    const todos = [...novos, ped(1000)];

    const r1 = await runSyncStep(cc, fetcher(todos), { alvo: 'ativos' });
    expect(r1.motivo).toBe('parcial');
    expect(r1.retomavel).toBe(true);
    expect(r1.committedOffset).toBe(250);
    const job = JSON.parse((await base.get('orders:sync:job:ativos'))!);
    expect(job.committedOffset).toBe(250);
    expect(job.chunkKeys).toHaveLength(5);
    expect([...base.store.keys()].filter(ehBuild)).toHaveLength(5);
    expect(await readManifest(cc, 'ativos')).toEqual(manAntes);

    const r2 = await runSyncStep(cc, fetcher(todos), { alvo: 'ativos' });
    expect(r2.concluido).toBe(true);
    expect(ids(await readSnapshot(cc, 'ativos'))).toEqual(ids(todos));
    expect([...base.store.keys()].some(ehBuild)).toBe(false);
    expect(await base.get('orders:sync:job:ativos')).toBeNull();
  });

  it('erro de página no meio: páginas anteriores ficam gravadas e a retomada conclui sem perder/duplicar', async () => {
    const cc = c();
    const todos = lista(300);
    const r1 = await runSyncStep(cc, fetcher(todos, { falharEm: 100 }), { alvo: 'ativos', modo: 'full' });
    expect(r1.ok).toBe(false);
    expect(r1.retomavel).toBe(true);
    expect(r1.committedOffset).toBe(100);
    const job = JSON.parse((await base.get('orders:sync:job:ativos'))!);
    expect(job.committedOffset).toBe(100);
    expect(job.chunkKeys).toHaveLength(2);

    setEnv({ ORDERS_SYNC_MAX_PAGES: '10' });
    const r2 = await runSyncStep(cc, fetcher(todos), { alvo: 'ativos' });
    expect(r2.concluido).toBe(true);
    const snap = await readSnapshot(cc, 'ativos');
    expect(snap).toHaveLength(300);
    expect(new Set(snap.map(o => o.id)).size).toBe(300);
  });

  it('full explícito (recarga) sobre snapshot existente republica tudo', async () => {
    const cc = c();
    const todos = lista(200);
    await cargaInicial(cc, todos);
    const v = (await readManifest(cc, 'ativos'))!.versao;
    const r = await ateConcluir(cc, todos, 'full');
    expect(r.concluido).toBe(true);
    expect((await readManifest(cc, 'ativos'))!.versao).toBe(v + 1);
    expect(ids(await readSnapshot(cc, 'ativos'))).toEqual(ids(todos));
  });

  it('job retomado conclui juntando build chunks gravados + páginas em memória, na ordem', async () => {
    const cc = c();
    await cargaInicial(cc, [ped(1000)]);
    // pedido 1 aparece na 1ª página como pago e de novo na 7ª como cancelado:
    // o primeiro visto vence (build chunk gravado antes das páginas em memória).
    const todos = [...lista(320), ped(1, { status: 'cancelled' }), ped(1000)];
    expect((await runSyncStep(cc, fetcher(todos), { alvo: 'ativos' })).motivo).toBe('parcial');
    const r2 = await runSyncStep(cc, fetcher(todos), { alvo: 'ativos' });
    expect(r2.concluido).toBe(true);
    const snap = await readSnapshot(cc, 'ativos');
    expect(snap.filter(o => o.id === 1)).toHaveLength(1);
    expect(snap.find(o => o.id === 1)?.status).toBe('paid');
  });

  it('7b. queda no meio da publicação: snapshot anterior intacto, job preservado, próxima invocação conclui', async () => {
    const cc = c();
    const todos = lista(5985, 2);
    await cargaInicial(cc, todos);
    const manAntes = await readManifest(cc, 'ativos');
    const comNovo = [ped(1), ...todos];

    // 1ª invocação: parcial (1 novo + 249 conhecidos) → grava build chunks + job.
    expect((await runSyncStep(cc, fetcher(comNovo), { alvo: 'ativos' })).motivo).toBe('parcial');
    // 2ª invocação cai ao gravar o primeiro chunk publicado.
    cont.falharSetEm = k => /^orders:chunk:/.test(k);
    await expect(runSyncStep(cc, fetcher(comNovo), { alvo: 'ativos' })).rejects.toThrow('queda simulada');
    cont.falharSetEm = null;
    expect(await readManifest(cc, 'ativos')).toEqual(manAntes);
    expect(await base.get('orders:sync:job:ativos')).not.toBeNull(); // progresso não se perdeu

    // O lock foi liberado no finally; a próxima invocação retoma e publica.
    const r = await ateConcluir(cc, comNovo);
    expect(r.concluido).toBe(true);
    expect(ids(await readSnapshot(cc, 'ativos'))).toEqual(ids(comNovo));
    expect([...base.store.keys()].some(ehBuild)).toBe(false);
  });
});
