import { describe, it, expect, beforeEach } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { runSyncStep, readStatus, type FetchOrdersPage } from '../src/services/orders-sync.service.js';
import { readManifest, readSnapshot } from '../src/lib/orders-store.js';
import type { OrderInput } from '../src/services/orders.service.js';

// env com chunk pequeno para exercitar chunking sem milhares de pedidos.
function setEnv(over: Record<string, string> = {}) {
  Object.assign(process.env, TEST_ENV, {
    ORDERS_CHUNK_SIZE: '2',
    ORDERS_SYNC_MAX_PAGES: '10',
    ORDERS_SYNC_MAX_TOTAL: '50000',
    ORDERS_SYNC_LOCK_TTL_S: '120',
    ORDERS_PAGE_RETRIES: '2',
    ...over,
  });
  resetEnvForTests();
}

const ped = (id: number): OrderInput => ({
  id,
  status: 'paid',
  date_created: `2026-07-${String((id % 27) + 1).padStart(2, '0')}T12:00:00.000-03:00`,
  paid_amount: 100,
  total_amount: 100,
  order_items: [{ quantity: 1, unit_price: 100, item: { id: 'MLB1', title: 'V', seller_sku: 'S', variation_id: 1 }, extra: 'x' } as never],
});

/** Fetcher fake sobre uma lista fixa (date_desc já assumido pela ordem dada). */
function fakeFetcher(todos: OrderInput[], opts: { falharEm?: number; contador?: { n: number } } = {}): FetchOrdersPage {
  return async ({ offset, limit }) => {
    if (opts.contador) opts.contador.n++;
    if (opts.falharEm !== undefined && offset === opts.falharEm) {
      throw new Error(`falha simulada no offset ${offset}`);
    }
    return { results: todos.slice(offset, offset + limit), total: todos.length };
  };
}

let cache: FakeCache;
beforeEach(() => { cache = new FakeCache(); setEnv(); });

describe('runSyncStep — carga inicial', () => {
  it('8/16. carga completa publica snapshot; toSlim remove campos extras', async () => {
    setEnv({ ORDERS_SYNC_MAX_PAGES: '10' });
    const todos = [ped(1), ped(2), ped(3)];
    const r = await runSyncStep(cache, fakeFetcher(todos), { alvo: 'ativos', modo: 'full' });
    expect(r.concluido).toBe(true);
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap.map(o => o.id).sort()).toEqual([1, 2, 3]);
    // toSlim: order_items[0].item não tem 'extra'
    expect(Object.keys(snap[0].order_items[0].item).sort()).toEqual(['id', 'seller_sku', 'title', 'variation_id'].sort());
    expect(snap[0]).not.toHaveProperty('extra');
  });

  it('9. página vazia encerra com segurança (total 0)', async () => {
    const r = await runSyncStep(cache, fakeFetcher([]), { alvo: 'ativos', modo: 'full' });
    expect(r.concluido).toBe(true);
    expect(await readSnapshot(cache, 'ativos')).toEqual([]);
  });

  it('10. dedup primeiro visto vence (id repetido em páginas)', async () => {
    // limit interno = 50; forço repetição na mesma lista
    const todos = [ped(1), ped(2), ped(1)];
    const r = await runSyncStep(cache, fakeFetcher(todos), { alvo: 'ativos', modo: 'full' });
    expect(r.concluido).toBe(true);
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap.filter(o => o.id === 1)).toHaveLength(1);
  });
});

describe('runSyncStep — erro parcial e retomada', () => {
  it('6/7. falha de página mantém committedOffset; retomada conclui sem perder/duplicar', async () => {
    // 5 páginas de 50? Usamos limit real 50, então preciso de > 50 pedidos e falha no offset 50.
    setEnv({ ORDERS_CHUNK_SIZE: '25', ORDERS_SYNC_MAX_PAGES: '10' });
    const todos = Array.from({ length: 120 }, (_, i) => ped(i + 1));

    // 1º passo: falha no offset 50 (2ª página) após esgotar retries.
    const r1 = await runSyncStep(cache, fakeFetcher(todos, { falharEm: 50 }), { alvo: 'ativos', modo: 'full' });
    expect(r1.ok).toBe(false);
    expect(r1.retomavel).toBe(true);
    expect(r1.motivo).toMatch(/erro_parcial/);
    // manifesto NÃO publicado
    expect(await readManifest(cache, 'ativos')).toBeNull();

    // 2º passo: fetcher são retoma e conclui
    const r2 = await runSyncStep(cache, fakeFetcher(todos), { alvo: 'ativos', modo: 'full' });
    expect(r2.concluido).toBe(true);
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap).toHaveLength(120);
    expect(new Set(snap.map(o => o.id)).size).toBe(120); // sem duplicatas
  });

  it('5. rebuild interrompido (max_pages) NÃO altera o manifesto atual', async () => {
    // publica uma versão inicial
    setEnv({ ORDERS_CHUNK_SIZE: '25', ORDERS_SYNC_MAX_PAGES: '10' });
    await runSyncStep(cache, fakeFetcher([ped(1), ped(2)]), { alvo: 'ativos', modo: 'full' });
    const antes = await readManifest(cache, 'ativos');
    expect(antes?.versao).toBe(1);

    // força rebuild com poucas páginas sobre um conjunto grande → parcial
    setEnv({ ORDERS_CHUNK_SIZE: '25', ORDERS_SYNC_MAX_PAGES: '1' });
    const todos = Array.from({ length: 200 }, (_, i) => ped(i + 1));
    const r = await runSyncStep(cache, fakeFetcher(todos), { alvo: 'ativos', modo: 'full' });
    expect(r.concluido).toBe(false);
    expect(r.retomavel).toBe(true);
    // manifesto publicado continua a versão 1
    const depois = await readManifest(cache, 'ativos');
    expect(depois?.versao).toBe(1);
    expect(depois).toEqual(antes);
  });

  it('erro de página é retomável, sem publicar (falha em todas as tentativas)', async () => {
    setEnv({ ORDERS_PAGE_RETRIES: '1' });
    // falha logo no offset 0 → retorna retomável (não lança); lock liberado.
    const r = await runSyncStep(cache, fakeFetcher([ped(1)], { falharEm: 0 }), { alvo: 'ativos', modo: 'full' });
    expect(r.ok).toBe(false);
    expect(r.retomavel).toBe(true);
    expect(r.motivo).toMatch(/erro_parcial/);
    expect(await readManifest(cache, 'ativos')).toBeNull();
    // lock foi liberado: uma nova chamada consegue rodar
    const r2 = await runSyncStep(cache, fakeFetcher([ped(1)]), { alvo: 'ativos', modo: 'full' });
    expect(r2.concluido).toBe(true);
  });
});

describe('runSyncStep — incremental', () => {
  it('11. incremental adiciona novos e preserva antigos', async () => {
    await runSyncStep(cache, fakeFetcher([ped(10), ped(11)]), { alvo: 'ativos', modo: 'full' });
    // novos pedidos entram no topo (date_desc): 12, 13 antes dos conhecidos
    const comNovos = [ped(13), ped(12), ped(11), ped(10)];
    const r = await runSyncStep(cache, fakeFetcher(comNovos), { alvo: 'ativos', modo: 'incremental' });
    expect(r.concluido).toBe(true);
    expect(r.novosPedidos).toBe(2);
    const snap = await readSnapshot(cache, 'ativos');
    expect(new Set(snap.map(o => o.id))).toEqual(new Set([10, 11, 12, 13]));
  });

  it('12. incremental sem novos NÃO publica versão nova', async () => {
    await runSyncStep(cache, fakeFetcher([ped(10), ped(11)]), { alvo: 'ativos', modo: 'full' });
    const versaoAntes = (await readManifest(cache, 'ativos'))?.versao;
    const r = await runSyncStep(cache, fakeFetcher([ped(10), ped(11)]), { alvo: 'ativos', modo: 'incremental' });
    expect(r.concluido).toBe(false);
    expect(r.motivo).toBe('sem_novos');
    expect((await readManifest(cache, 'ativos'))?.versao).toBe(versaoAntes);
    expect((await readStatus(cache, 'ativos'))?.lastResult).toBe('sem_novos');
  });

  it('incremental para ao achar id conhecido (não varre tudo)', async () => {
    await runSyncStep(cache, fakeFetcher([ped(10)]), { alvo: 'ativos', modo: 'full' });
    const contador = { n: 0 };
    const comNovos = [ped(11), ped(10)]; // acha 10 na primeira página
    await runSyncStep(cache, fakeFetcher(comNovos, { contador }), { alvo: 'ativos', modo: 'incremental' });
    expect(contador.n).toBe(1); // uma página só
  });
});

describe('runSyncStep — lock', () => {
  it('13. lock impede segunda sincronização simultânea', async () => {
    // ocupa o lock manualmente
    await cache.setNX('orders:sync:lock', 'outro-dono', 120);
    const r = await runSyncStep(cache, fakeFetcher([ped(1)]), { alvo: 'ativos', modo: 'full' });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('sync_em_andamento');
    expect(await readManifest(cache, 'ativos')).toBeNull();
  });

  it('14. lock é liberado em sucesso e em erro', async () => {
    // sucesso
    await runSyncStep(cache, fakeFetcher([ped(1)]), { alvo: 'ativos', modo: 'full' });
    expect(await cache.get('orders:sync:lock')).toBeNull();
    // erro
    setEnv({ ORDERS_PAGE_RETRIES: '0' });
    const r = await runSyncStep(cache, fakeFetcher([ped(1)], { falharEm: 0 }), { alvo: 'ativos', modo: 'full' });
    expect(r.ok).toBe(false);
    expect(await cache.get('orders:sync:lock')).toBeNull();
  });
});

describe('runSyncStep — cancelados independentes', () => {
  it('15. cancelados usam manifesto e chaves próprios, sem afetar ativos', async () => {
    await runSyncStep(cache, fakeFetcher([ped(1), ped(2)]), { alvo: 'ativos', modo: 'full' });
    await runSyncStep(cache, fakeFetcher([ped(90), ped(91)]), { alvo: 'cancelados', modo: 'full' });

    expect((await readSnapshot(cache, 'ativos')).map(o => o.id).sort()).toEqual([1, 2]);
    expect((await readSnapshot(cache, 'cancelados')).map(o => o.id).sort()).toEqual([90, 91]);
    // chaves independentes
    expect(await cache.get('orders:manifest')).not.toBeNull();
    expect(await cache.get('orders:cancel:manifest')).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// CORREÇÃO DE BUGS — defaults reais, build chunks, incremental retomável
// ══════════════════════════════════════════════════════════════════════════
async function chavesBuild(cache: FakeCache): Promise<string[]> {
  return [...cache.store.keys()].filter(k => k.startsWith('orders:build:chunk:'));
}

describe('BUG 1 — full progride com os defaults reais (chunk 500, maxPages 5)', () => {
  it('1. três invocações de 250 concluem 600 pedidos únicos', async () => {
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '5' });
    const todos = Array.from({ length: 600 }, (_, i) => ped(i + 1));
    const fetcher = fakeFetcher(todos);

    // 1ª: 5 páginas × 50 = 250; parcial; committedOffset 250
    const r1 = await runSyncStep(cache, fetcher, { alvo: 'ativos', modo: 'full' });
    expect(r1.concluido).toBe(false);
    expect(r1.retomavel).toBe(true);
    expect(r1.committedOffset).toBe(250);
    expect(await readManifest(cache, 'ativos')).toBeNull(); // nada publicado ainda

    // 2ª: retoma → 500
    const r2 = await runSyncStep(cache, fetcher, { alvo: 'ativos' }); // sem modo: retoma o job
    expect(r2.concluido).toBe(false);
    expect(r2.committedOffset).toBe(500);
    expect(await readManifest(cache, 'ativos')).toBeNull();

    // 3ª: conclui (500→600, depois offset >= total)
    const r3 = await runSyncStep(cache, fetcher, { alvo: 'ativos' });
    expect(r3.concluido).toBe(true);
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap).toHaveLength(600);
    expect(new Set(snap.map(o => o.id)).size).toBe(600);
  });

  it('2/3. chunks parciais usam prefixo orders:build:chunk: e somem após conclusão', async () => {
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '5' });
    const todos = Array.from({ length: 600 }, (_, i) => ped(i + 1));
    const fetcher = fakeFetcher(todos);

    await runSyncStep(cache, fetcher, { alvo: 'ativos', modo: 'full' });
    // durante o job parcial, existem build chunks
    expect((await chavesBuild(cache)).length).toBeGreaterThan(0);
    // e nenhum chunk publicado
    expect([...cache.store.keys()].some(k => /^orders:chunk:\d+:\d+$/.test(k))).toBe(false);

    await runSyncStep(cache, fetcher, { alvo: 'ativos' });
    await runSyncStep(cache, fetcher, { alvo: 'ativos' });
    // após conclusão, nenhum build chunk permanece
    expect(await chavesBuild(cache)).toEqual([]);
    // o job foi limpo
    expect(await cache.get('orders:sync:job:ativos')).toBeNull();
  });
});

describe('BUG 2 — incremental é retomável e não publica parcial', () => {
  it('4/5. incremental com 320 novos: 1ª parcial (manifesto intacto), retoma e conclui', async () => {
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '5' });
    // snapshot base com 1 pedido conhecido (id 1000)
    await runSyncStep(cache, fakeFetcher([ped(1000)]), { alvo: 'ativos', modo: 'full' });
    const manifestoAntes = await readManifest(cache, 'ativos');
    expect(manifestoAntes?.versao).toBe(1);

    // 320 novos no topo (date_desc) + o conhecido no fim
    const novos = Array.from({ length: 320 }, (_, i) => ped(i + 1));
    const comNovos = [...novos, ped(1000)];
    const fetcher = fakeFetcher(comNovos);

    // 1ª: 5 páginas × 50 = 250 novos; não achou o conhecido ainda → parcial
    const r1 = await runSyncStep(cache, fetcher, { alvo: 'ativos', modo: 'incremental' });
    expect(r1.concluido).toBe(false);
    expect(r1.retomavel).toBe(true);
    expect(r1.motivo).toBe('parcial');
    // manifesto atual permanece EXATAMENTE igual
    expect(await readManifest(cache, 'ativos')).toEqual(manifestoAntes);

    // 2ª: retoma do committedOffset; acha o conhecido; publica
    const r2 = await runSyncStep(cache, fetcher, { alvo: 'ativos' });
    expect(r2.concluido).toBe(true);
    const snap = await readSnapshot(cache, 'ativos');
    expect(new Set(snap.map(o => o.id)).size).toBe(321); // 320 novos + o antigo
    expect(snap.some(o => o.id === 1000)).toBe(true);
    expect(await chavesBuild(cache)).toEqual([]); // build chunks limpos
  });
});

describe('CONTROLE DE MODO — job em andamento manda', () => {
  it('6. full parcial + incremental explícito → recusado; full retoma e conclui', async () => {
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '5' });
    const todos = Array.from({ length: 600 }, (_, i) => ped(i + 1));
    const fetcher = fakeFetcher(todos);

    // full parcial
    const r1 = await runSyncStep(cache, fetcher, { alvo: 'ativos', modo: 'full' });
    expect(r1.concluido).toBe(false);
    const buildAntes = (await chavesBuild(cache)).sort();

    // incremental explícito enquanto o full está em andamento → recusado
    const rInc = await runSyncStep(cache, fetcher, { alvo: 'ativos', modo: 'incremental' });
    expect(rInc.motivo).toBe('job_em_andamento');
    expect(rInc.concluido).toBe(false);
    // nenhum build chunk sobrescrito/alterado
    expect((await chavesBuild(cache)).sort()).toEqual(buildAntes);

    // full retoma e conclui
    await runSyncStep(cache, fetcher, { alvo: 'ativos' });
    const r3 = await runSyncStep(cache, fetcher, { alvo: 'ativos' });
    expect(r3.concluido).toBe(true);
    expect(await readSnapshot(cache, 'ativos')).toHaveLength(600);
  });
});

describe('BUG persistência — falha após página persistida', () => {
  it('7. committedOffset mantém o ponto persistido; retomada sem perder/duplicar', async () => {
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '10' });
    const todos = Array.from({ length: 300 }, (_, i) => ped(i + 1));

    // falha no offset 100 (3ª página): páginas 0 e 50 persistidas em build chunks
    const r1 = await runSyncStep(cache, fakeFetcher(todos, { falharEm: 100 }), { alvo: 'ativos', modo: 'full' });
    expect(r1.ok).toBe(false);
    expect(r1.retomavel).toBe(true);
    expect(r1.committedOffset).toBe(100); // offsets 0 e 50 confirmados
    const job = JSON.parse((await cache.get('orders:sync:job:ativos'))!);
    expect(job.committedOffset).toBe(100);
    expect(job.chunkKeys.length).toBe(2); // duas páginas persistidas
    expect(await readManifest(cache, 'ativos')).toBeNull();

    // retomada com fetcher são → conclui do offset 100 em diante
    const r2 = await runSyncStep(cache, fakeFetcher(todos), { alvo: 'ativos' });
    expect(r2.concluido).toBe(true);
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap).toHaveLength(300);
    expect(new Set(snap.map(o => o.id)).size).toBe(300); // nada perdido nem duplicado
  });
});

// ══════════════════════════════════════════════════════════════════════════
// INTEGRIDADE — MAX_TOTAL como limite de segurança e resposta inválida
// ══════════════════════════════════════════════════════════════════════════
describe('MAX_TOTAL é limite de segurança, nunca conclusão', () => {
  it('1. full com total > maxTotal: não publica, motivo limite_seguranca_excedido', async () => {
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '5', ORDERS_SYNC_MAX_TOTAL: '100' });
    // fetcher reporta total 60000 (bem acima do teto 100)
    const fetcher: FetchOrdersPage = async ({ offset, limit }) => ({
      results: Array.from({ length: Math.min(limit, 60000 - offset) }, (_, i) => ped(offset + i + 1)),
      total: 60000,
    });
    const r = await runSyncStep(cache, fetcher, { alvo: 'ativos', modo: 'full' });
    expect(r.concluido).toBe(false);
    expect(r.retomavel).toBe(false);
    expect(r.motivo).toMatch(/limite_seguranca_excedido/);
    expect(r.motivo).toContain('60000');
    expect(r.motivo).toContain('100');
    expect(await readManifest(cache, 'ativos')).toBeNull(); // nada publicado
    expect(await chavesBuild(cache)).toEqual([]); // build chunks limpos
    expect((await readStatus(cache, 'ativos'))?.emAndamento).toBe(false);
  });

  it('1b. snapshot anterior permanece intacto quando o limite é excedido', async () => {
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '5', ORDERS_SYNC_MAX_TOTAL: '50000' });
    // publica uma versão válida primeiro
    await runSyncStep(cache, fakeFetcher([ped(1), ped(2)]), { alvo: 'ativos', modo: 'full' });
    const manifestoAntes = await readManifest(cache, 'ativos');
    expect(manifestoAntes?.versao).toBe(1);

    // agora um full novo cujo total estoura o teto
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '5', ORDERS_SYNC_MAX_TOTAL: '100' });
    const fetcher: FetchOrdersPage = async ({ offset, limit }) => ({
      results: Array.from({ length: Math.min(limit, 60000 - offset) }, (_, i) => ped(offset + i + 100)),
      total: 60000,
    });
    const r = await runSyncStep(cache, fetcher, { alvo: 'ativos', modo: 'full' });
    expect(r.motivo).toMatch(/limite_seguranca_excedido/);
    // snapshot anterior EXATAMENTE igual
    expect(await readManifest(cache, 'ativos')).toEqual(manifestoAntes);
    expect((await readSnapshot(cache, 'ativos')).map(o => o.id).sort()).toEqual([1, 2]);
  });

  it('2. incremental com total > maxTotal: não publica nova versão, base intacta', async () => {
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '5', ORDERS_SYNC_MAX_TOTAL: '50000' });
    await runSyncStep(cache, fakeFetcher([ped(1000)]), { alvo: 'ativos', modo: 'full' });
    const manifestoAntes = await readManifest(cache, 'ativos');

    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '5', ORDERS_SYNC_MAX_TOTAL: '100' });
    const fetcher: FetchOrdersPage = async ({ offset, limit }) => ({
      results: Array.from({ length: Math.min(limit, 60000 - offset) }, (_, i) => ped(offset + i + 1)),
      total: 60000,
    });
    const r = await runSyncStep(cache, fetcher, { alvo: 'ativos', modo: 'incremental' });
    expect(r.concluido).toBe(false);
    expect(r.motivo).toMatch(/limite_seguranca_excedido/);
    expect(await readManifest(cache, 'ativos')).toEqual(manifestoAntes); // base intacta
  });
});

describe('resposta inválida da API vira erro_parcial retomável', () => {
  it('3. total inválido (NaN) não publica; erro_parcial retomável', async () => {
    setEnv({ ORDERS_PAGE_RETRIES: '1' });
    const fetcher = (async () => ({ results: [ped(1)], total: NaN })) as unknown as FetchOrdersPage;
    const r = await runSyncStep(cache, fetcher, { alvo: 'ativos', modo: 'full' });
    expect(r.ok).toBe(false);
    expect(r.retomavel).toBe(true);
    expect(r.motivo).toMatch(/erro_parcial/);
    expect(await readManifest(cache, 'ativos')).toBeNull();
  });

  it('3b. total negativo não publica; erro_parcial retomável', async () => {
    setEnv({ ORDERS_PAGE_RETRIES: '0' });
    const fetcher = (async () => ({ results: [ped(1)], total: -5 })) as unknown as FetchOrdersPage;
    const r = await runSyncStep(cache, fetcher, { alvo: 'ativos', modo: 'full' });
    expect(r.ok).toBe(false);
    expect(r.retomavel).toBe(true);
    expect(r.motivo).toMatch(/erro_parcial/);
    expect(await readManifest(cache, 'ativos')).toBeNull();
  });

  it('4. results que não é array não publica; erro_parcial retomável', async () => {
    setEnv({ ORDERS_PAGE_RETRIES: '1' });
    const fetcher = (async () => ({ results: 'nao-array', total: 10 })) as unknown as FetchOrdersPage;
    const r = await runSyncStep(cache, fetcher, { alvo: 'ativos', modo: 'full' });
    expect(r.ok).toBe(false);
    expect(r.retomavel).toBe(true);
    expect(r.motivo).toMatch(/erro_parcial/);
    expect(await readManifest(cache, 'ativos')).toBeNull();
    // lock liberado
    expect(await cache.get('orders:sync:lock')).toBeNull();
  });
});