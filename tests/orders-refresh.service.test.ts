/**
 * Contrato do auto-refresh pedido pelo dashboard.
 *
 * Este mecanismo existe porque os dois caminhos de atualização falharam ao
 * mesmo tempo — o agendador do GitHub Actions descartando ticks e a callback
 * do Mercado Livre sem autenticar. Ele é o piso de confiabilidade, e o risco
 * óbvio de um piso acionado pelo NAVEGADOR é carga: cada aba aberta pode virar
 * uma sincronização.
 *
 * Por isso a maior parte destes testes não é sobre o caminho feliz. É sobre as
 * travas: cooldown global, lock compartilhado e a medida certa de "velho".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import {
  type OrdersManifest, readManifest, writeChunk, publishManifest, readSnapshot,
} from '../src/lib/orders-store.js';
import { ORDERS_SYNC_LOCK_KEY, runSyncStep, type FetchOrdersPage } from '../src/services/orders-sync.service.js';
import { refrescarSeVelho, CHAVE_COOLDOWN_REFRESH } from '../src/services/orders-refresh.service.js';
import type { OrderInput, OrderSlim } from '../src/services/orders.service.js';

let cache: FakeCache;
beforeEach(() => {
  cache = new FakeCache();
  Object.assign(process.env, TEST_ENV);
  resetEnvForTests();
});

// ── helpers ────────────────────────────────────────────────────────────────

function data(i: number): string {
  return new Date(Date.UTC(2026, 7, 28, 12, 0, 0) - i * 60_000).toISOString();
}

function pedido(id: number | string, i: number, over: Partial<OrderSlim> = {}): OrderSlim {
  return {
    id, status: 'paid', date_created: data(i), paid_amount: 100, total_amount: 100,
    order_items: [{ quantity: 1, unit_price: 100, item: { id: 'MLB1', title: 'V', seller_sku: 'S', variation_id: null } }],
    ...over,
  };
}

/** Fetcher de página que conta quantas vezes o Mercado Livre foi tocado. */
function fetcher(lista: OrderSlim[]) {
  const chamadas: number[] = [];
  const fn: FetchOrdersPage = async ({ offset, limit }) => {
    chamadas.push(offset);
    return { results: lista.slice(offset, offset + limit) as unknown as OrderInput[], total: lista.length };
  };
  return { fn, chamadas };
}

/** Publica snapshot base e grava um `lastSyncAt` com a idade que o teste quer. */
async function base(n: number, idadeSegundos: number, agoraMs = Date.now()) {
  const pedidos = Array.from({ length: n }, (_, i) => pedido(i + 1, i));
  const chave = await writeChunk(cache, 'ativos', 1, 0, pedidos);
  const man: OrdersManifest = {
    versao: 1, chunks: [chave], totalRegistros: n,
    newestDate: pedidos[0].date_created, oldestDate: pedidos[n - 1].date_created,
    chunkSize: 500, updatedAt: new Date(agoraMs - 6 * 3600_000).toISOString(),
    origem: 'full', chunkCounts: [n],
  };
  await publishManifest(cache, 'ativos', man);
  await cache.set('orders:sync:status:ativos', JSON.stringify({
    ultimaVersao: 1, totalRegistros: n, newestDate: man.newestDate,
    lastSyncAt: new Date(agoraMs - idadeSegundos * 1000).toISOString(),
    lastResult: 'ok', emAndamento: false,
  }));
  return pedidos;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('1. o que conta como "velho"', () => {
  it('snapshot checado ha pouco NAO toca no Mercado Livre', async () => {
    await base(10, 30);
    const { fn, chamadas } = fetcher([]);

    const r = await refrescarSeVelho(cache, fn);

    expect(r.acao).toBe('fresco');
    if (r.acao === 'fresco') expect(r.idadeSegundos).toBeCloseTo(30, -1);
    expect(chamadas).toHaveLength(0);
  });

  /**
   * A distincao que da nome ao servico. `manifest.updatedAt` so avanca quando
   * uma versao e PUBLICADA, entao num dia sem vendas ele fica parado para
   * sempre. Se a idade fosse medida por ele, o dashboard pediria sincronizacao
   * a cada rodada, eternamente, para nunca achar nada.
   */
  it('a idade vem de lastSyncAt (quando checamos), nao de updatedAt (quando mudou)', async () => {
    const agora = Date.now();
    // updatedAt de 6 horas atras — mas acabamos de checar ha 10 segundos.
    await base(10, 10, agora);
    const man = await readManifest(cache, 'ativos');
    const idadeDoUpdatedAt = (agora - Date.parse(man!.updatedAt)) / 1000;
    expect(idadeDoUpdatedAt).toBeGreaterThan(20_000); // horas

    const { fn, chamadas } = fetcher([]);
    const r = await refrescarSeVelho(cache, fn, { agoraMs: agora });

    expect(r.acao).toBe('fresco');   // e nao "velho por causa do updatedAt"
    expect(chamadas).toHaveLength(0);
  });

  it('snapshot velho executa UM passo incremental', async () => {
    const pedidos = await base(10, 600);
    const novo = pedido('9999', -1);
    const { fn, chamadas } = fetcher([novo, ...pedidos]);

    const r = await refrescarSeVelho(cache, fn);

    expect(r.acao).toBe('sincronizado');
    if (r.acao === 'sincronizado') {
      expect(r.publicou).toBe(true);
      expect(r.novosPedidos).toBe(1);
    }
    expect(chamadas.length).toBeGreaterThan(0);
    expect((await readSnapshot(cache, 'ativos')).some(o => String(o.id) === '9999')).toBe(true);
  });

  it('sem lastSyncAt registrado, trata como velho — e o estado em que mais precisamos', async () => {
    await base(10, 600);
    await cache.del('orders:sync:status:ativos');
    const { fn, chamadas } = fetcher(Array.from({ length: 10 }, (_, i) => pedido(i + 1, i)));

    const r = await refrescarSeVelho(cache, fn);
    expect(r.acao).toBe('sincronizado');
    expect(chamadas.length).toBeGreaterThan(0);
  });

  it('sem snapshot base NAO dispara carga inicial pelo navegador', async () => {
    const { fn, chamadas } = fetcher([]);
    const r = await refrescarSeVelho(cache, fn);
    expect(r.acao).toBe('sem_snapshot');
    expect(chamadas).toHaveLength(0);
    expect(await readManifest(cache, 'ativos')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('2. carga: N abas nao viram N sincronizacoes', () => {
  it('10 abas abertas produzem UMA sincronizacao', async () => {
    const pedidos = await base(10, 600);
    const { fn, chamadas } = fetcher([pedido('9999', -1), ...pedidos]);

    const rs = await Promise.all(
      Array.from({ length: 10 }, () => refrescarSeVelho(cache, fn))
    );

    const sincronizaram = rs.filter(r => r.acao === 'sincronizado');
    const emCooldown = rs.filter(r => r.acao === 'cooldown');
    expect(sincronizaram).toHaveLength(1);
    expect(emCooldown).toHaveLength(9);
    // e o Mercado Livre so foi tocado pela que passou
    expect(chamadas.length).toBeGreaterThan(0);
  });

  /**
   * Duas barreiras, em ordem. A primeira e a frescura: depois de um passo bem
   * sucedido o proprio runSyncStep grava `lastSyncAt` novo, entao a chamada
   * seguinte nem chega ao cooldown — sai em `fresco`. A segunda e o cooldown,
   * que existe para o caso em que o snapshot CONTINUA velho: passo parcial,
   * lock ocupado, ML instavel. Sem ele, cada rodada do poll de cada aba
   * pediria uma sincronizacao nova.
   */
  it('depois de sincronizar, a proxima chamada sai em fresco — e o cooldown fica de pe', async () => {
    const pedidos = await base(10, 600);
    const { fn } = fetcher([pedido('9999', -1), ...pedidos]);

    expect((await refrescarSeVelho(cache, fn)).acao).toBe('sincronizado');
    expect((await refrescarSeVelho(cache, fn)).acao).toBe('fresco');
    expect(await cache.get(CHAVE_COOLDOWN_REFRESH)).not.toBeNull();
  });

  it('snapshot AINDA velho depois do passo: o cooldown e quem barra', async () => {
    const pedidos = await base(10, 600);
    const { fn, chamadas } = fetcher([pedido('9999', -1), ...pedidos]);

    expect((await refrescarSeVelho(cache, fn)).acao).toBe('sincronizado');
    const apos = chamadas.length;

    // Simula o desfecho ruim: o passo rodou mas o snapshot segue velho.
    await cache.set('orders:sync:status:ativos', JSON.stringify({
      ultimaVersao: 2, totalRegistros: 11, newestDate: null,
      lastSyncAt: new Date(Date.now() - 600_000).toISOString(),
      lastResult: 'parcial', emAndamento: false,
    }));

    const segunda = await refrescarSeVelho(cache, fn);
    expect(segunda.acao).toBe('cooldown');
    expect(chamadas.length).toBe(apos);   // e o ML nao foi tocado de novo
  });

  it('expirado o cooldown, uma nova sincronizacao e permitida', async () => {
    const pedidos = await base(10, 600);
    const { fn } = fetcher([pedido('9999', -1), ...pedidos]);

    await refrescarSeVelho(cache, fn, { cooldownS: 1 });
    await new Promise(r => setTimeout(r, 1100));
    await cache.set('orders:sync:status:ativos', JSON.stringify({
      ultimaVersao: 2, totalRegistros: 11, newestDate: null,
      lastSyncAt: new Date(Date.now() - 600_000).toISOString(),
      lastResult: 'ok', emAndamento: false,
    }));

    const r = await refrescarSeVelho(cache, fn, { cooldownS: 1 });
    expect(r.acao).not.toBe('cooldown');
  });

  it('o cooldown NAO e consumido quando o snapshot esta fresco', async () => {
    await base(10, 30);
    const { fn } = fetcher([]);
    await refrescarSeVelho(cache, fn);
    // Nada de queimar a janela a toa: quem chega logo depois, ja velho, roda.
    expect(await cache.get(CHAVE_COOLDOWN_REFRESH)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('3. concorrencia com os outros escritores do snapshot', () => {
  it('lock do GitHub Actions ocupado: nao inicia outro sync', async () => {
    const pedidos = await base(10, 600);
    const { fn, chamadas } = fetcher([pedido('9999', -1), ...pedidos]);
    await cache.setNX(ORDERS_SYNC_LOCK_KEY, 'reconciliacao-github-actions', 120);

    const r = await refrescarSeVelho(cache, fn);

    expect(r.acao).toBe('sync_em_andamento');
    expect(chamadas).toHaveLength(0);
    // e o lock continua com o dono original
    expect(await cache.get(ORDERS_SYNC_LOCK_KEY)).toBe('reconciliacao-github-actions');
  });

  it('lock do dreno de notificacoes ocupado: idem', async () => {
    const pedidos = await base(10, 600);
    const { fn, chamadas } = fetcher([pedido('9999', -1), ...pedidos]);
    await cache.setNX(ORDERS_SYNC_LOCK_KEY, 'dreno-webhook', 120);

    const r = await refrescarSeVelho(cache, fn);

    expect(r.acao).toBe('sync_em_andamento');
    expect(chamadas).toHaveLength(0);
    expect(await cache.get(ORDERS_SYNC_LOCK_KEY)).toBe('dreno-webhook');
  });

  it('usa o MESMO lock da sincronizacao — nao um lock proprio', async () => {
    const pedidos = await base(10, 600);
    const { fn } = fetcher([pedido('9999', -1), ...pedidos]);
    await refrescarSeVelho(cache, fn);
    // Liberado ao final pelo proprio runSyncStep.
    expect(await cache.get(ORDERS_SYNC_LOCK_KEY)).toBeNull();
  });

  it('o refresh nao atrapalha a reconciliacao seguinte', async () => {
    const pedidos = await base(10, 600);
    const novo = pedido('9999', -1);
    const { fn } = fetcher([novo, ...pedidos]);

    await refrescarSeVelho(cache, fn);
    const r = await runSyncStep(cache, fn, { modo: 'incremental' });

    expect(r.motivo).toBe('sem_novos');   // o refresh ja tinha trazido tudo
    expect((await readSnapshot(cache, 'ativos')).filter(o => String(o.id) === '9999')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('4. falha do Mercado Livre nao derruba o dashboard', () => {
  it('erro na busca vira { acao: erro } e o snapshot anterior continua intacto', async () => {
    await base(10, 600);
    const antes = await readManifest(cache, 'ativos');
    const fn: FetchOrdersPage = async () => { throw new Error('ML fora do ar'); };

    const r = await refrescarSeVelho(cache, fn);

    expect(r.acao).toBe('erro');
    const depois = await readManifest(cache, 'ativos');
    expect(depois!.versao).toBe(antes!.versao);
    expect(await readSnapshot(cache, 'ativos')).toHaveLength(10);
  });

  it('refrescarSeVelho NUNCA lanca — o dashboard nao pode quebrar por causa do ML', async () => {
    await base(10, 600);
    const fn: FetchOrdersPage = async () => { throw new Error('explosao'); };
    await expect(refrescarSeVelho(cache, fn)).resolves.toBeDefined();
  });

  it('nada novo no ML: sincroniza, nao publica, e nao inventa versao', async () => {
    const pedidos = await base(10, 600);
    const { fn } = fetcher(pedidos);
    const antes = await readManifest(cache, 'ativos');

    const r = await refrescarSeVelho(cache, fn);

    expect(r.acao).toBe('sincronizado');
    if (r.acao === 'sincronizado') {
      expect(r.publicou).toBe(false);
      expect(r.motivo).toBe('sem_novos');
    }
    expect((await readManifest(cache, 'ativos'))!.versao).toBe(antes!.versao);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('5. so o passo incremental, nunca reconstrucao', () => {
  it('nao varre o historico inteiro: para na janela de revisao', async () => {
    // 400 pedidos ja conhecidos; o incremental revisa a janela e encerra.
    const pedidos = await base(400, 600);
    const { fn, chamadas } = fetcher(pedidos);

    await refrescarSeVelho(cache, fn);

    // 50 por pagina; um full varreria as 8 paginas. O incremental para antes.
    expect(chamadas.length).toBeLessThan(8);
    expect(Math.max(...chamadas)).toBeLessThan(400);
  });

  it('o snapshot publicado continua completo depois do refresh', async () => {
    const pedidos = await base(120, 600);
    const { fn } = fetcher([pedido('9999', -1), ...pedidos]);

    await refrescarSeVelho(cache, fn);

    const snap = await readSnapshot(cache, 'ativos');
    expect(snap).toHaveLength(121);
    expect(new Set(snap.map(o => String(o.id))).size).toBe(121);
  });
});
