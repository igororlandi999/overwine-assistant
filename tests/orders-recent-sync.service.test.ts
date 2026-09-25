/**
 * Contrato do passo RÁPIDO de sincronização (orders-recent-sync.service).
 *
 * É o passo que uma aba aberta dispara a cada meio minuto, então o que estes
 * testes travam é sobretudo CUSTO e CORREÇÃO sob repetição: uma checagem sem
 * venda custa uma chamada ao Mercado Livre e nenhuma leitura de chunk; uma
 * venda custa uma chamada e o upsert daquela venda; o snapshot nunca perde
 * pedido nem duplica; o lock é o mesmo dos outros escritores.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import {
  type OrdersManifest, readManifest, readSnapshot, writeChunk, publishManifest,
} from '../src/lib/orders-store.js';
import { ORDERS_SYNC_LOCK_KEY, readStatus, runSyncStep, type FetchOrdersPage } from '../src/services/orders-sync.service.js';
import { sincronizarRecentes, CHAVE_HEAD } from '../src/services/orders-recent-sync.service.js';
import { upsertPedido } from '../src/services/orders-webhook.service.js';
import type { OrderInput, OrderSlim } from '../src/services/orders.service.js';

/** Cache que conta leituras de chunk — a prova de custo. */
class CacheContador extends FakeCache {
  leiturasChunk = 0;
  override async get(k: string) {
    if (k.startsWith('orders:chunk:')) this.leiturasChunk++;
    return super.get(k);
  }
}

let cache: CacheContador;
beforeEach(() => {
  cache = new CacheContador();
  Object.assign(process.env, TEST_ENV);
  resetEnvForTests();
});

function data(i: number): string {
  return new Date(Date.UTC(2026, 8, 23, 12, 0, 0) - i * 60_000).toISOString();
}
function pedido(id: number | string, i: number, over: Partial<OrderSlim> = {}): OrderSlim {
  return {
    id, status: 'paid', date_created: data(i), paid_amount: 100, total_amount: 100,
    order_items: [{ quantity: 1, unit_price: 100, item: { id: 'MLB1', title: 'V', seller_sku: 'S', variation_id: null } }],
    ...over,
  };
}
function fetcher(lista: OrderSlim[]) {
  const chamadas: number[] = [];
  const fn: FetchOrdersPage = async ({ offset, limit }) => {
    chamadas.push(offset);
    return { results: lista.slice(offset, offset + limit) as unknown as OrderInput[], total: lista.length };
  };
  return { fn, chamadas };
}
/** Snapshot base em DOIS chunks, como em produção (o mais recente primeiro). */
async function base(n: number, chunkSize = 500) {
  const pedidos = Array.from({ length: n }, (_, i) => pedido(i + 1, i));
  const chunks: string[] = [];
  const counts: number[] = [];
  for (let i = 0, c = 0; i < n; i += chunkSize, c++) {
    const fatia = pedidos.slice(i, i + chunkSize);
    chunks.push(await writeChunk(cache, 'ativos', 1, c, fatia));
    counts.push(fatia.length);
  }
  const man: OrdersManifest = {
    versao: 1, chunks, totalRegistros: n,
    newestDate: pedidos[0].date_created, oldestDate: pedidos[n - 1].date_created,
    chunkSize, updatedAt: new Date(Date.now() - 3600_000).toISOString(), origem: 'full', chunkCounts: counts,
  };
  await publishManifest(cache, 'ativos', man);
  return pedidos;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('1. pedido novo entra, e entra barato', () => {
  it('uma venda: 1 chamada ao ML, publica versao nova, o pedido esta no snapshot', async () => {
    const pedidos = await base(700);
    const { fn, chamadas } = fetcher([pedido('9999', -1), ...pedidos]);

    const r = await sincronizarRecentes(cache, fn);

    expect(r.acao).toBe('sincronizado');
    if (r.acao !== 'sincronizado') return;
    expect(r.publicou).toBe(true);
    expect(r.novos).toBe(1);
    expect(r.atualizados).toBe(0);
    expect(r.versao).toBe(2);
    expect(r.chamadasML).toBe(1);
    expect(chamadas).toEqual([0]);

    const snap = await readSnapshot(cache, 'ativos');
    expect(snap).toHaveLength(701);
    expect(snap[0].id).toBe('9999');   // date_desc: o mais novo na frente
    expect(new Set(snap.map(o => String(o.id))).size).toBe(701);
    expect((await readManifest(cache, 'ativos'))!.origem).toBe('dashboard_refresh');
  });

  it('a venda custa o upsert DELA: um chunk lido para comparar, um para inserir — nunca o historico', async () => {
    const pedidos = await base(2000);   // 4 chunks
    const { fn } = fetcher([pedido('9999', -1), ...pedidos]);
    cache.leiturasChunk = 0;

    await sincronizarRecentes(cache, fn);

    expect(cache.leiturasChunk).toBeLessThanOrEqual(2);
  });

  it('tres vendas de uma vez: as tres entram, numa unica chamada ao ML', async () => {
    const pedidos = await base(100);
    const novos = [pedido('9001', -3), pedido('9002', -2), pedido('9003', -1)];
    const { fn, chamadas } = fetcher([...novos, ...pedidos]);

    const r = await sincronizarRecentes(cache, fn);

    expect(r.acao).toBe('sincronizado');
    if (r.acao === 'sincronizado') { expect(r.novos).toBe(3); expect(r.publicou).toBe(true); }
    expect(chamadas).toHaveLength(1);
    const ids = new Set((await readSnapshot(cache, 'ativos')).map(o => String(o.id)));
    expect(ids.has('9001') && ids.has('9002') && ids.has('9003')).toBe(true);
  });

  it('status grava lastSyncAt novo, lastResult ok e a versao publicada', async () => {
    const pedidos = await base(10);
    const { fn } = fetcher([pedido('9999', -1), ...pedidos]);
    const antes = Date.now();

    await sincronizarRecentes(cache, fn);

    const st = await readStatus(cache, 'ativos');
    expect(st!.lastResult).toBe('ok');
    expect(Date.parse(st!.lastSyncAt!)).toBeGreaterThanOrEqual(antes);
    expect(st!.ultimaVersao).toBe(2);
    expect(st!.totalRegistros).toBe(11);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('2. nenhum pedido novo: o caso comum tem que ser quase de graca', () => {
  it('primeira checagem sem novidade: compara com o chunk recente, NAO publica, grava a assinatura', async () => {
    const pedidos = await base(700);
    const { fn } = fetcher(pedidos);

    const r = await sincronizarRecentes(cache, fn);

    expect(r.acao).toBe('sincronizado');
    if (r.acao === 'sincronizado') { expect(r.publicou).toBe(false); expect(r.novos).toBe(0); }
    expect((await readManifest(cache, 'ativos'))!.versao).toBe(1);
    expect(await cache.get(CHAVE_HEAD)).not.toBeNull();
    expect((await readStatus(cache, 'ativos'))!.lastResult).toBe('sem_novos');
  });

  it('checagens seguintes sem novidade: 1 chamada ao ML e ZERO leituras de chunk', async () => {
    const pedidos = await base(700);
    const { fn, chamadas } = fetcher(pedidos);
    await sincronizarRecentes(cache, fn);
    cache.leiturasChunk = 0;
    const antes = chamadas.length;

    for (let i = 0; i < 20; i++) {
      const r = await sincronizarRecentes(cache, fn);
      expect(r.acao).toBe('sem_novos');
    }

    expect(chamadas.length - antes).toBe(20);
    expect(cache.leiturasChunk).toBe(0);
    expect((await readManifest(cache, 'ativos'))!.versao).toBe(1);
  });

  it('cada checagem avanca lastSyncAt — e a medida de "checamos", mesmo sem venda', async () => {
    const pedidos = await base(10);
    const { fn } = fetcher(pedidos);
    await sincronizarRecentes(cache, fn);
    const a = (await readStatus(cache, 'ativos'))!.lastSyncAt!;
    await new Promise(r => setTimeout(r, 5));
    await sincronizarRecentes(cache, fn);
    const b = (await readStatus(cache, 'ativos'))!.lastSyncAt!;
    expect(Date.parse(b)).toBeGreaterThan(Date.parse(a));
  });

  it('NAO apaga ultimaRevisaoEm gravado pela revisao profunda', async () => {
    const pedidos = await base(10);
    const { fn } = fetcher(pedidos);
    await cache.set('orders:sync:status:ativos', JSON.stringify({
      ultimaVersao: 1, totalRegistros: 10, newestDate: null, lastSyncAt: null,
      lastResult: 'ok', emAndamento: false, ultimaRevisaoEm: '2026-09-23T10:00:00.000Z',
    }));
    await sincronizarRecentes(cache, fn);
    expect((await readStatus(cache, 'ativos'))!.ultimaRevisaoEm).toBe('2026-09-23T10:00:00.000Z');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('3. pedido muda de status', () => {
  it('pago → cancelado na primeira pagina: atualiza, publica, nao duplica', async () => {
    const pedidos = await base(100);
    const { fn } = fetcher(pedidos);
    await sincronizarRecentes(cache, fn);   // assinatura gravada

    const mudado = pedidos.map(p => (p.id === 3 ? { ...p, status: 'cancelled' } : p));
    const r = await sincronizarRecentes(cache, fetcher(mudado).fn);

    expect(r.acao).toBe('sincronizado');
    if (r.acao === 'sincronizado') { expect(r.atualizados).toBe(1); expect(r.novos).toBe(0); expect(r.publicou).toBe(true); }
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap).toHaveLength(100);
    expect(snap.find(o => o.id === 3)!.status).toBe('cancelled');
  });

  it('valor pago alterado tambem conta como mudanca', async () => {
    const pedidos = await base(60);
    const { fn } = fetcher(pedidos);
    await sincronizarRecentes(cache, fn);
    const mudado = pedidos.map(p => (p.id === 1 ? { ...p, paid_amount: 250 } : p));
    const r = await sincronizarRecentes(cache, fetcher(mudado).fn);
    expect(r.acao === 'sincronizado' && r.atualizados === 1).toBe(true);
    expect((await readSnapshot(cache, 'ativos')).find(o => o.id === 1)!.paid_amount).toBe(250);
  });

  it('mudanca de novo para o MESMO estado nao publica de novo (idempotente)', async () => {
    const pedidos = await base(60);
    const mudado = pedidos.map(p => (p.id === 1 ? { ...p, status: 'cancelled' } : p));
    await sincronizarRecentes(cache, fetcher(pedidos).fn);
    await sincronizarRecentes(cache, fetcher(mudado).fn);
    const v = (await readManifest(cache, 'ativos'))!.versao;
    const r = await sincronizarRecentes(cache, fetcher(mudado).fn);
    expect(r.acao).toBe('sem_novos');
    expect((await readManifest(cache, 'ativos'))!.versao).toBe(v);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('4. a versao publicada mudou por fora (webhook, reconciliacao)', () => {
  it('assinatura de versao antiga nao vale: reconcilia UMA vez, sem publicar a toa', async () => {
    const pedidos = await base(700);
    const { fn, chamadas } = fetcher(pedidos);
    await sincronizarRecentes(cache, fn);

    // O webhook publica a versao 2 com um pedido que a primeira pagina ja
    // vai trazer na proxima checagem.
    const novo = pedido('9999', -1);
    await upsertPedido(cache, novo, 'ativos', 'webhook');
    expect((await readManifest(cache, 'ativos'))!.versao).toBe(2);

    cache.leiturasChunk = 0;
    const r = await sincronizarRecentes(cache, fetcher([novo, ...pedidos]).fn);

    expect(r.acao).toBe('sincronizado');
    if (r.acao === 'sincronizado') { expect(r.publicou).toBe(false); expect(r.novos).toBe(0); }
    expect((await readManifest(cache, 'ativos'))!.versao).toBe(2);   // nada republicado
    expect(cache.leiturasChunk).toBe(1);                              // um chunk, para comparar
    expect(chamadas.length).toBe(1);

    // E a partir dai volta ao caminho de graca.
    cache.leiturasChunk = 0;
    expect((await sincronizarRecentes(cache, fetcher([novo, ...pedidos]).fn)).acao).toBe('sem_novos');
    expect(cache.leiturasChunk).toBe(0);
  });

  it('o passo profundo depois do rapido encontra tudo em ordem (sem_novos)', async () => {
    const pedidos = await base(100);
    const novo = pedido('9999', -1);
    await sincronizarRecentes(cache, fetcher([novo, ...pedidos]).fn);

    const r = await runSyncStep(cache, fetcher([novo, ...pedidos]).fn, { modo: 'incremental' });

    expect(r.motivo).toBe('sem_novos');
    expect((await readSnapshot(cache, 'ativos')).filter(o => String(o.id) === '9999')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('5. muitas vendas de uma vez', () => {
  it('primeira pagina INTEIRA de pedidos novos: segue para a proxima, ate o teto', async () => {
    const pedidos = await base(100);
    const novos = Array.from({ length: 120 }, (_, i) => pedido(`n${i}`, -200 + i));
    const { fn, chamadas } = fetcher([...novos, ...pedidos]);

    const r = await sincronizarRecentes(cache, fn, { maxPaginas: 3 });

    expect(r.acao).toBe('sincronizado');
    if (r.acao === 'sincronizado') { expect(r.novos).toBe(120); expect(r.chamadasML).toBe(3); }
    expect(chamadas).toEqual([0, 50, 100]);
    expect(await readSnapshot(cache, 'ativos')).toHaveLength(220);
  });

  it('acima do teto de paginas: aplica o que leu e para — a revisao profunda cobre o resto', async () => {
    const pedidos = await base(100);
    const novos = Array.from({ length: 160 }, (_, i) => pedido(`n${i}`, -200 + i));
    const { fn, chamadas } = fetcher([...novos, ...pedidos]);

    const r = await sincronizarRecentes(cache, fn, { maxPaginas: 2 });

    expect(chamadas).toEqual([0, 50]);
    if (r.acao === 'sincronizado') expect(r.novos).toBe(100);
    expect(await readSnapshot(cache, 'ativos')).toHaveLength(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('6. travas e falhas', () => {
  it('lock ocupado: nao toca no ML, nao publica, devolve sync_em_andamento', async () => {
    const pedidos = await base(10);
    const { fn, chamadas } = fetcher([pedido('9999', -1), ...pedidos]);
    await cache.setNX(ORDERS_SYNC_LOCK_KEY, 'reconciliacao', 120);

    const r = await sincronizarRecentes(cache, fn);

    expect(r.acao).toBe('sync_em_andamento');
    expect(chamadas).toHaveLength(0);
    expect(await cache.get(ORDERS_SYNC_LOCK_KEY)).toBe('reconciliacao');
  });

  it('libera o lock ao terminar, inclusive em erro', async () => {
    await base(10);
    const fn: FetchOrdersPage = async () => { throw new Error('ML fora'); };
    await sincronizarRecentes(cache, fn);
    expect(await cache.get(ORDERS_SYNC_LOCK_KEY)).toBeNull();
  });

  it('erro do ML: { acao: erro }, snapshot e status intactos, sem assinatura gravada', async () => {
    await base(10);
    const antes = await readManifest(cache, 'ativos');
    const fn: FetchOrdersPage = async () => { throw new Error('ML /orders/search HTTP 500 (offset 0).'); };

    const r = await sincronizarRecentes(cache, fn);

    expect(r.acao).toBe('erro');
    if (r.acao === 'erro') expect(r.motivo).toContain('HTTP 500');
    expect((await readManifest(cache, 'ativos'))!.versao).toBe(antes!.versao);
    expect(await cache.get(CHAVE_HEAD)).toBeNull();
    expect(await readStatus(cache, 'ativos')).toBeNull();
  });

  it('429 do ML e um erro como outro qualquer aqui — quem alonga o cooldown e o refresh', async () => {
    await base(10);
    const fn: FetchOrdersPage = async () => { throw new Error('ML /orders/search HTTP 429 (offset 0).'); };
    const r = await sincronizarRecentes(cache, fn);
    expect(r.acao === 'erro' && /429/.test(r.motivo)).toBe(true);
  });

  it('Redis falhando no meio do upsert: nao lanca, devolve erro, libera o lock', async () => {
    const pedidos = await base(10);
    const { fn } = fetcher([pedido('9999', -1), ...pedidos]);
    const setOriginal = cache.set.bind(cache);
    let escritas = 0;
    cache.set = async (k: string, v: string, ttl?: number) => {
      if (k.startsWith('orders:chunk:') && ++escritas === 1) throw new Error('Redis indisponivel');
      return setOriginal(k, v, ttl);
    };
    const r = await sincronizarRecentes(cache, fn);
    expect(r.acao).toBe('erro');
    if (r.acao === 'erro') expect(r.motivo).toContain('Redis indisponivel');
    expect(await cache.get(ORDERS_SYNC_LOCK_KEY)).toBeNull();
    expect(await cache.get(CHAVE_HEAD)).toBeNull();
  });

  it('resposta malformada do ML nao vira "nada novo"', async () => {
    await base(10);
    const fn = (async () => ({ results: null, total: 10 })) as unknown as FetchOrdersPage;
    const r = await sincronizarRecentes(cache, fn);
    expect(r.acao).toBe('erro');
  });

  it('sem snapshot base: sem_snapshot, e o ML nao e tocado', async () => {
    const { fn, chamadas } = fetcher([pedido('9999', -1)]);
    const r = await sincronizarRecentes(cache, fn);
    expect(r.acao).toBe('sem_snapshot');
    expect(chamadas).toHaveLength(0);
  });

  it('erro na segunda pagina: o que a primeira trouxe ja esta publicado', async () => {
    const pedidos = await base(100);
    const novos = Array.from({ length: 60 }, (_, i) => pedido(`n${i}`, -100 + i));
    let n = 0;
    const fn: FetchOrdersPage = async ({ offset, limit }) => {
      if (++n > 1) throw new Error('ML caiu');
      const lista = [...novos, ...pedidos];
      return { results: lista.slice(offset, offset + limit) as unknown as OrderInput[], total: lista.length };
    };
    const r = await sincronizarRecentes(cache, fn, { maxPaginas: 3 });
    expect(r.acao).toBe('erro');
    expect(await readSnapshot(cache, 'ativos')).toHaveLength(150);
  });
});
