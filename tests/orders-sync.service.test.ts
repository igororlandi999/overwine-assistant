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

/** ped(id) com campos sobrescritos — para simular mudanças de status/valor. */
const pedCom = (id: number, overrides: Partial<OrderInput>): OrderInput => ({
  ...ped(id),
  ...overrides,
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

  it('9. janela limitada: revisa ~250 conhecidos sem varrer todo o histórico', async () => {
    // base grande: 600 conhecidos (ids 1..600), do mais recente ao mais antigo
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '100' });
    const base = Array.from({ length: 600 }, (_, i) => ped(600 - i)); // 600,599,...,1
    await runSyncStep(cache, fakeFetcher(base), { alvo: 'ativos', modo: 'full' });

    // ML retorna 2 novos no topo seguidos de TODOS os conhecidos (mesma ordem)
    const contador = { n: 0 };
    const comNovos = [ped(1001), ped(1002), ...base];
    const r = await runSyncStep(cache, fakeFetcher(comNovos, { contador }), { alvo: 'ativos', modo: 'incremental' });
    expect(r.concluido).toBe(true);
    expect(r.novosPedidos).toBe(2);
    // Não varreu o histórico inteiro: 2 novos + 250 conhecidos = 252 registros
    // → páginas de 50 → ~6 páginas, muito menos que as 13 necessárias p/ 602.
    expect(contador.n).toBeLessThan(8);
    expect(contador.n).toBeGreaterThanOrEqual(6); // revisou pelo menos 250 conhecidos
    // snapshot final mantém todos os 600 conhecidos + 2 novos
    const snap = await readSnapshot(cache, 'ativos');
    expect(new Set(snap.map(o => o.id)).size).toBe(602);
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
// ══════════════════════════════════════════════════════════════════════════
// FASE 5 — incremental ATUALIZA registros conhecidos (janela de revisão)
// ══════════════════════════════════════════════════════════════════════════
/** Retorna o pedido do snapshot com um dado id (ou undefined). */
async function pedNoSnap(cache: FakeCache, id: number) {
  return (await readSnapshot(cache, 'ativos')).find(o => o.id === id);
}

describe('incremental — atualização de conhecidos', () => {
  it('1. adiciona novos e preserva antigos (janela revisa sem apagar)', async () => {
    await runSyncStep(cache, fakeFetcher([ped(10), ped(11)]), { alvo: 'ativos', modo: 'full' });
    const comNovos = [ped(13), ped(12), ped(11), ped(10)];
    const r = await runSyncStep(cache, fakeFetcher(comNovos), { alvo: 'ativos', modo: 'incremental' });
    expect(r.concluido).toBe(true);
    expect(r.novosPedidos).toBe(2);
    const snap = await readSnapshot(cache, 'ativos');
    expect(new Set(snap.map(o => o.id))).toEqual(new Set([10, 11, 12, 13]));
  });

  it('2. paid → cancelled: snapshot final reflete cancelled', async () => {
    await runSyncStep(cache, fakeFetcher([pedCom(10, { status: 'paid' }), ped(11)]), { alvo: 'ativos', modo: 'full' });
    expect((await pedNoSnap(cache, 10))?.status).toBe('paid');
    // ML devolve o MESMO id 10 agora cancelled (mais um novo no topo p/ garantir publicação)
    const ml = [ped(99), pedCom(10, { status: 'cancelled' }), ped(11)];
    const r = await runSyncStep(cache, fakeFetcher(ml), { alvo: 'ativos', modo: 'incremental' });
    expect(r.concluido).toBe(true);
    expect((await pedNoSnap(cache, 10))?.status).toBe('cancelled');
  });

  it('3. cancelled → paid: snapshot final reflete paid', async () => {
    await runSyncStep(cache, fakeFetcher([pedCom(10, { status: 'cancelled' }), ped(11)]), { alvo: 'ativos', modo: 'full' });
    expect((await pedNoSnap(cache, 10))?.status).toBe('cancelled');
    const ml = [pedCom(10, { status: 'paid' }), ped(11)];
    const r = await runSyncStep(cache, fakeFetcher(ml), { alvo: 'ativos', modo: 'incremental' });
    // sem novos, mas 1 atualizado → publica
    expect(r.concluido).toBe(true);
    expect(r.novosPedidos).toBe(0);
    expect((await pedNoSnap(cache, 10))?.status).toBe('paid');
  });

  it('4. paid_amount alterado: snapshot final contém o novo valor', async () => {
    await runSyncStep(cache, fakeFetcher([pedCom(10, { paid_amount: 100 }), ped(11)]), { alvo: 'ativos', modo: 'full' });
    expect((await pedNoSnap(cache, 10))?.paid_amount).toBe(100);
    const ml = [pedCom(10, { paid_amount: 250 }), ped(11)];
    const r = await runSyncStep(cache, fakeFetcher(ml), { alvo: 'ativos', modo: 'incremental' });
    expect(r.concluido).toBe(true);
    expect((await pedNoSnap(cache, 10))?.paid_amount).toBe(250);
  });

  it('5. total_amount alterado: snapshot final contém o novo valor', async () => {
    await runSyncStep(cache, fakeFetcher([pedCom(10, { total_amount: 100 }), ped(11)]), { alvo: 'ativos', modo: 'full' });
    expect((await pedNoSnap(cache, 10))?.total_amount).toBe(100);
    const ml = [pedCom(10, { total_amount: 777 }), ped(11)];
    const r = await runSyncStep(cache, fakeFetcher(ml), { alvo: 'ativos', modo: 'incremental' });
    expect(r.concluido).toBe(true);
    expect((await pedNoSnap(cache, 10))?.total_amount).toBe(777);
  });

  it('6. nada novo e nada alterado → sem_novos, sem nova versão', async () => {
    await runSyncStep(cache, fakeFetcher([ped(10), ped(11)]), { alvo: 'ativos', modo: 'full' });
    const versaoAntes = (await readManifest(cache, 'ativos'))?.versao;
    const r = await runSyncStep(cache, fakeFetcher([ped(10), ped(11)]), { alvo: 'ativos', modo: 'incremental' });
    expect(r.concluido).toBe(false);
    expect(r.motivo).toBe('sem_novos');
    expect(r.novosPedidos).toBe(0);
    expect((await readManifest(cache, 'ativos'))?.versao).toBe(versaoAntes);
    expect((await readStatus(cache, 'ativos'))?.lastResult).toBe('sem_novos');
  });

  it('7. conhecido atualizado publica nova versão mesmo com novosPedidos === 0', async () => {
    await runSyncStep(cache, fakeFetcher([ped(10), ped(11)]), { alvo: 'ativos', modo: 'full' });
    const versaoAntes = (await readManifest(cache, 'ativos'))!.versao;
    const ml = [pedCom(10, { status: 'cancelled' }), ped(11)];
    const r = await runSyncStep(cache, fakeFetcher(ml), { alvo: 'ativos', modo: 'incremental' });
    expect(r.concluido).toBe(true);
    expect(r.novosPedidos).toBe(0);
    expect((await readManifest(cache, 'ativos'))!.versao).toBe(versaoAntes + 1);
  });

  it('8. novosPedidos conta só IDs ausentes (revisar 100 conhecidos + 2 novos = 2)', async () => {
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '100' });
    const base = Array.from({ length: 100 }, (_, i) => ped(100 - i)); // 100..1
    await runSyncStep(cache, fakeFetcher(base), { alvo: 'ativos', modo: 'full' });
    const comNovos = [ped(1001), ped(1002), ...base];
    const r = await runSyncStep(cache, fakeFetcher(comNovos), { alvo: 'ativos', modo: 'incremental' });
    expect(r.concluido).toBe(true);
    expect(r.novosPedidos).toBe(2); // não 102
    expect(new Set((await readSnapshot(cache, 'ativos')).map(o => o.id)).size).toBe(102);
  });

  it('10. backlog > 250 novos: 1ª parcial (base intacta), retoma, revisa janela, publica só no fim', async () => {
    // base: 300 conhecidos (ids 1..300) — publica com folga de páginas
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '100' });
    const base = Array.from({ length: 300 }, (_, i) => ped(300 - i));
    await runSyncStep(cache, fakeFetcher(base), { alvo: 'ativos', modo: 'full' });
    const manifestoAntes = await readManifest(cache, 'ativos');
    expect(manifestoAntes?.versao).toBe(1);

    // agora aperta o limite de páginas para forçar incremental parcial/retomável
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '5' });
    // 320 novos no topo + todos os conhecidos
    const novos = Array.from({ length: 320 }, (_, i) => ped(1000 + i));
    const ml = [...novos, ...base];
    const fetcher = fakeFetcher(ml);

    // 1ª: 250 novos, ainda não cruzou fronteira → parcial, manifesto intacto
    const r1 = await runSyncStep(cache, fetcher, { alvo: 'ativos', modo: 'incremental' });
    expect(r1.concluido).toBe(false);
    expect(r1.retomavel).toBe(true);
    expect(r1.motivo).toBe('parcial');
    expect(await readManifest(cache, 'ativos')).toEqual(manifestoAntes);

    // retomadas até concluir
    let r = await runSyncStep(cache, fetcher, { alvo: 'ativos' });
    let guarda = 0;
    while (!r.concluido && r.retomavel && guarda++ < 20) {
      r = await runSyncStep(cache, fetcher, { alvo: 'ativos' });
    }
    expect(r.concluido).toBe(true);
    expect(r.novosPedidos).toBe(320);
    const snap = await readSnapshot(cache, 'ativos');
    // 320 novos + 300 conhecidos, todos únicos
    expect(new Set(snap.map(o => o.id)).size).toBe(620);
    expect(await chavesBuild(cache)).toEqual([]);
  });

  it('11. deduplicação: nenhum ID duplicado após merge', async () => {
    await runSyncStep(cache, fakeFetcher([ped(10), ped(11), ped(12)]), { alvo: 'ativos', modo: 'full' });
    const ml = [ped(20), pedCom(10, { paid_amount: 999 }), ped(11), ped(12)];
    await runSyncStep(cache, fakeFetcher(ml), { alvo: 'ativos', modo: 'incremental' });
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap.length).toBe(new Set(snap.map(o => o.id)).size);
    // e a versão nova do 10 venceu
    expect((await pedNoSnap(cache, 10))?.paid_amount).toBe(999);
  });

  it('12. falha durante a revisão: permanece retomável, sem publicar parcial, committedOffset preservado', async () => {
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '10' });
    // base: 300 conhecidos
    const base = Array.from({ length: 300 }, (_, i) => ped(300 - i));
    await runSyncStep(cache, fakeFetcher(base), { alvo: 'ativos', modo: 'full' });
    const manifestoAntes = await readManifest(cache, 'ativos');

    // ML: 10 novos + conhecidos; falha no offset 100 (durante a coleta)
    const novos = Array.from({ length: 10 }, (_, i) => ped(2000 + i));
    const ml = [...novos, ...base];
    const r1 = await runSyncStep(cache, fakeFetcher(ml, { falharEm: 100 }), { alvo: 'ativos', modo: 'incremental' });
    expect(r1.ok).toBe(false);
    expect(r1.retomavel).toBe(true);
    expect(r1.motivo).toMatch(/erro_parcial/);
    // manifesto atual intacto (nada publicado)
    expect(await readManifest(cache, 'ativos')).toEqual(manifestoAntes);
    // committedOffset persistido no ponto confirmado (offsets 0 e 50 → 100)
    const job = JSON.parse((await cache.get('orders:sync:job:ativos'))!);
    expect(job.committedOffset).toBe(100);

    // retomada com fetcher são → conclui
    let r = await runSyncStep(cache, fakeFetcher(ml), { alvo: 'ativos' });
    let guarda = 0;
    while (!r.concluido && r.retomavel && guarda++ < 20) {
      r = await runSyncStep(cache, fakeFetcher(ml), { alvo: 'ativos' });
    }
    expect(r.concluido).toBe(true);
    expect(new Set((await readSnapshot(cache, 'ativos')).map(o => o.id)).size).toBe(310);
  });

  it('14. job incremental ANTIGO (sem campos novos) é legível e conclui', async () => {
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '100' });
    // publica base com 2 conhecidos
    await runSyncStep(cache, fakeFetcher([ped(10), ped(11)]), { alvo: 'ativos', modo: 'full' });
    const base = await readManifest(cache, 'ativos');

    // injeta um job incremental "legado" SEM incrementalBoundaryReached/Reviewed
    const jobAntigo = {
      jobId: 'legado01',
      modo: 'incremental',
      alvo: 'ativos',
      committedOffset: 0,
      chunkKeys: [],
      total: null,
      baseManifestVersion: base!.versao,
      iniciadoEm: new Date().toISOString(),
      // NOTE: sem os dois campos opcionais novos
    };
    await cache.set('orders:sync:job:ativos', JSON.stringify(jobAntigo));

    // retoma o job antigo; ML traz 1 novo + os conhecidos
    const ml = [ped(50), ped(11), ped(10)];
    let r = await runSyncStep(cache, fakeFetcher(ml), { alvo: 'ativos' });
    let guarda = 0;
    while (!r.concluido && r.retomavel && guarda++ < 10) {
      r = await runSyncStep(cache, fakeFetcher(ml), { alvo: 'ativos' });
    }
    expect(r.concluido).toBe(true);
    expect(r.novosPedidos).toBe(1);
    expect(new Set((await readSnapshot(cache, 'ativos')).map(o => o.id))).toEqual(new Set([10, 11, 50]));
  });

  it('15. cancelados continuam independentes de ativos no incremental', async () => {
    await runSyncStep(cache, fakeFetcher([ped(1), ped(2)]), { alvo: 'ativos', modo: 'full' });
    await runSyncStep(cache, fakeFetcher([ped(90), ped(91)]), { alvo: 'cancelados', modo: 'full' });
    // incremental em ativos com um novo não deve tocar cancelados
    await runSyncStep(cache, fakeFetcher([ped(3), ped(2), ped(1)]), { alvo: 'ativos', modo: 'incremental' });
    expect((await readSnapshot(cache, 'ativos')).map(o => o.id).sort((a, b) => Number(a) - Number(b))).toEqual([1, 2, 3]);
    expect((await readSnapshot(cache, 'cancelados')).map(o => o.id).sort((a, b) => Number(a) - Number(b))).toEqual([90, 91]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// novosPedidos em PARCIAIS e ERROS conta só ids ausentes da base
// ══════════════════════════════════════════════════════════════════════════
describe('incremental — novosPedidos em parcial/erro', () => {
  it('16. parcial só com conhecidos revisados → novosPedidos = 0', async () => {
    // base: 400 conhecidos (mais que a janela de 250)
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '100' });
    const base = Array.from({ length: 400 }, (_, i) => ped(400 - i));
    await runSyncStep(cache, fakeFetcher(base), { alvo: 'ativos', modo: 'full' });

    // ML devolve SÓ conhecidos (nenhum novo); aperta páginas p/ forçar parcial
    // antes de a janela de 250 fechar (5 páginas × 50 = 250, mas o 1º id já é
    // conhecido → boundary imediato; 250 revisados fecham a janela em 5 páginas,
    // então uso MAX_PAGES:3 p/ garantir parcial: 150 conhecidos revisados < 250).
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '3' });
    const r = await runSyncStep(cache, fakeFetcher(base), { alvo: 'ativos', modo: 'incremental' });
    expect(r.concluido).toBe(false);
    expect(r.motivo).toBe('parcial');
    expect(r.novosPedidos).toBe(0); // nenhum id novo, apesar de 150 revisados
  });

  it('17. erro em página só de conhecidos → novosPedidos = 0', async () => {
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '10' });
    const base = Array.from({ length: 200 }, (_, i) => ped(200 - i));
    await runSyncStep(cache, fakeFetcher(base), { alvo: 'ativos', modo: 'full' });

    // ML devolve só conhecidos e falha no offset 100 (3ª página)
    const r = await runSyncStep(cache, fakeFetcher(base, { falharEm: 100 }), { alvo: 'ativos', modo: 'incremental' });
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/erro_parcial/);
    expect(r.novosPedidos).toBe(0); // só conhecidos foram vistos antes da falha
  });

  it('18. parcial com novos e conhecidos → novosPedidos conta só os novos', async () => {
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '100' });
    const base = Array.from({ length: 300 }, (_, i) => ped(1000 + (300 - i)));
    await runSyncStep(cache, fakeFetcher(base), { alvo: 'ativos', modo: 'full' });

    // 120 novos no topo + conhecidos; aperta p/ 2 páginas (100 registros) →
    // parcial ANTES de terminar. As 2 páginas contêm só novos (120 > 100).
    setEnv({ ORDERS_CHUNK_SIZE: '500', ORDERS_SYNC_MAX_PAGES: '2' });
    const novos = Array.from({ length: 120 }, (_, i) => ped(1 + i)); // ids 1..120 (ausentes da base 1001..1300)
    const ml = [...novos, ...base];
    const r = await runSyncStep(cache, fakeFetcher(ml), { alvo: 'ativos', modo: 'incremental' });
    expect(r.concluido).toBe(false);
    expect(r.motivo).toBe('parcial');
    expect(r.novosPedidos).toBe(100); // 2 páginas × 50 novos; nenhum conhecido ainda
  });
});

// ══════════════════════════════════════════════════════════════════════════
// comparação profunda: buyer / shipping / order_items disparam publicação
// ══════════════════════════════════════════════════════════════════════════
describe('incremental — comparação profunda publica em mudança de campo', () => {
  it('19. buyer.nickname alterado publica nova versão (novosPedidos 0)', async () => {
    await runSyncStep(cache, fakeFetcher([pedCom(10, { buyer: { nickname: 'ANTIGO' } }), ped(11)]), { alvo: 'ativos', modo: 'full' });
    const versaoAntes = (await readManifest(cache, 'ativos'))!.versao;
    const ml = [pedCom(10, { buyer: { nickname: 'NOVO' } }), ped(11)];
    const r = await runSyncStep(cache, fakeFetcher(ml), { alvo: 'ativos', modo: 'incremental' });
    expect(r.concluido).toBe(true);
    expect(r.novosPedidos).toBe(0);
    expect((await readManifest(cache, 'ativos'))!.versao).toBe(versaoAntes + 1);
    expect((await pedNoSnap(cache, 10))?.buyer?.nickname).toBe('NOVO');
  });

  it('20. shipping alterado (id/logistic_type) publica nova versão (novosPedidos 0)', async () => {
    await runSyncStep(cache, fakeFetcher([pedCom(10, { shipping: { id: 1, logistic_type: 'drop_off' } }), ped(11)]), { alvo: 'ativos', modo: 'full' });
    const versaoAntes = (await readManifest(cache, 'ativos'))!.versao;
    const ml = [pedCom(10, { shipping: { id: 2, logistic_type: 'fulfillment' } }), ped(11)];
    const r = await runSyncStep(cache, fakeFetcher(ml), { alvo: 'ativos', modo: 'incremental' });
    expect(r.concluido).toBe(true);
    expect(r.novosPedidos).toBe(0);
    expect((await readManifest(cache, 'ativos'))!.versao).toBe(versaoAntes + 1);
    const p = await pedNoSnap(cache, 10);
    expect(p?.shipping?.id).toBe(2);
    expect(p?.shipping?.logistic_type).toBe('fulfillment');
  });

  it('21. order_items alterado publica nova versão (novosPedidos 0)', async () => {
    await runSyncStep(cache, fakeFetcher([
      pedCom(10, { order_items: [{ quantity: 1, unit_price: 100, item: { id: 'MLB1', title: 'V', seller_sku: 'S', variation_id: 1 } }] }),
      ped(11),
    ]), { alvo: 'ativos', modo: 'full' });
    const versaoAntes = (await readManifest(cache, 'ativos'))!.versao;
    const ml = [
      pedCom(10, { order_items: [{ quantity: 5, unit_price: 100, item: { id: 'MLB1', title: 'V', seller_sku: 'S', variation_id: 1 } }] }),
      ped(11),
    ];
    const r = await runSyncStep(cache, fakeFetcher(ml), { alvo: 'ativos', modo: 'incremental' });
    expect(r.concluido).toBe(true);
    expect(r.novosPedidos).toBe(0);
    expect((await readManifest(cache, 'ativos'))!.versao).toBe(versaoAntes + 1);
    expect((await pedNoSnap(cache, 10))?.order_items[0].quantity).toBe(5);
  });
});