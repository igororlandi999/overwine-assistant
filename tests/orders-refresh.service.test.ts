/**
 * Contrato do auto-refresh pedido pelo dashboard.
 *
 * Este mecanismo existe porque os dois caminhos de atualização falharam ao
 * mesmo tempo — o agendador do GitHub Actions descartando ticks e a callback
 * do Mercado Livre recusada por segredo divergente. Ele é o piso de
 * confiabilidade, e o risco óbvio de um piso acionado pelo NAVEGADOR é carga:
 * cada aba aberta pode virar uma sincronização.
 *
 * Por isso a maior parte destes testes não é sobre o caminho feliz. É sobre as
 * travas (cooldown global, lock compartilhado, a medida certa de "velho"), a
 * escolha do passo (rápido na maioria das vezes, profundo de tempos em tempos)
 * e a telemetria que responde "por que parou?" sem abrir log.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import {
  type OrdersManifest, readManifest, writeChunk, publishManifest, readSnapshot,
} from '../src/lib/orders-store.js';
import { ORDERS_SYNC_LOCK_KEY, runSyncStep, readStatus, type FetchOrdersPage } from '../src/services/orders-sync.service.js';
import { refrescarSeVelho, CHAVE_COOLDOWN_REFRESH } from '../src/services/orders-refresh.service.js';
import { lerObsSync } from '../src/lib/sync-telemetry.js';
import type { OrderInput, OrderSlim } from '../src/services/orders.service.js';

let cache: FakeCache;
beforeEach(() => {
  cache = new FakeCache();
  Object.assign(process.env, TEST_ENV);
  resetEnvForTests();
});

// ── helpers ────────────────────────────────────────────────────────────────

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

/** Fetcher de página que conta quantas vezes o Mercado Livre foi tocado. */
function fetcher(lista: OrderSlim[]) {
  const chamadas: number[] = [];
  const fn: FetchOrdersPage = async ({ offset, limit }) => {
    chamadas.push(offset);
    return { results: lista.slice(offset, offset + limit) as unknown as OrderInput[], total: lista.length };
  };
  return { fn, chamadas };
}

/**
 * Publica snapshot base e grava um status com a idade que o teste quer.
 * `revisaoIdadeS` controla a idade da última revisão profunda: por padrão
 * recente, para que o passo escolhido seja o rápido.
 */
async function base(n: number, idadeSegundos: number, opts: { agoraMs?: number; revisaoIdadeS?: number | null } = {}) {
  const agoraMs = opts.agoraMs ?? Date.now();
  const pedidos = Array.from({ length: n }, (_, i) => pedido(i + 1, i));
  const chave = await writeChunk(cache, 'ativos', 1, 0, pedidos);
  const man: OrdersManifest = {
    versao: 1, chunks: [chave], totalRegistros: n,
    newestDate: pedidos[0].date_created, oldestDate: pedidos[n - 1].date_created,
    chunkSize: 500, updatedAt: new Date(agoraMs - 6 * 3600_000).toISOString(),
    origem: 'full', chunkCounts: [n],
  };
  await publishManifest(cache, 'ativos', man);
  const revisaoIdadeS = opts.revisaoIdadeS === undefined ? 60 : opts.revisaoIdadeS;
  await cache.set('orders:sync:status:ativos', JSON.stringify({
    ultimaVersao: 1, totalRegistros: n, newestDate: man.newestDate,
    lastSyncAt: new Date(agoraMs - idadeSegundos * 1000).toISOString(),
    lastResult: 'ok', emAndamento: false,
    ultimaRevisaoEm: revisaoIdadeS === null ? null : new Date(agoraMs - revisaoIdadeS * 1000).toISOString(),
  }));
  return pedidos;
}

async function envelhecer(segundos = 600) {
  const st = (await readStatus(cache, 'ativos'))!;
  await cache.set('orders:sync:status:ativos', JSON.stringify({
    ...st, lastSyncAt: new Date(Date.now() - segundos * 1000).toISOString(),
  }));
  await cache.del(CHAVE_COOLDOWN_REFRESH);
}

// ═══════════════════════════════════════════════════════════════════════════
describe('1. o que conta como "velho"', () => {
  it('snapshot checado ha pouco NAO toca no Mercado Livre', async () => {
    await base(10, 5);
    const { fn, chamadas } = fetcher([]);

    const r = await refrescarSeVelho(cache, fn);

    expect(r.acao).toBe('fresco');
    if (r.acao === 'fresco') { expect(r.idadeSegundos).toBeCloseTo(5, -1); expect(r.versao).toBe(1); }
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
    await base(10, 5, { agoraMs: agora });   // updatedAt de 6 horas atras, checado ha 5s
    const man = await readManifest(cache, 'ativos');
    expect((agora - Date.parse(man!.updatedAt)) / 1000).toBeGreaterThan(20_000);

    const { fn, chamadas } = fetcher([]);
    const r = await refrescarSeVelho(cache, fn, { agoraMs: agora });

    expect(r.acao).toBe('fresco');
    expect(chamadas).toHaveLength(0);
  });

  it('o limiar e o configurado: 25s por padrao, e abaixo dele nada acontece', async () => {
    await base(10, 24);
    expect((await refrescarSeVelho(cache, fetcher([]).fn)).acao).toBe('fresco');
    await envelhecer(26);
    expect((await refrescarSeVelho(cache, fetcher(await readSnapshot(cache, 'ativos')).fn)).acao).toBe('sincronizado');
  });

  it('snapshot velho + pedido novo: UM passo rapido, 1 chamada, publica, devolve a versao nova', async () => {
    const pedidos = await base(10, 600);
    const { fn, chamadas } = fetcher([pedido('9999', -1), ...pedidos]);

    const r = await refrescarSeVelho(cache, fn);

    expect(r.acao).toBe('sincronizado');
    if (r.acao === 'sincronizado') {
      expect(r.modo).toBe('rapido');
      expect(r.publicou).toBe(true);
      expect(r.novosPedidos).toBe(1);
      expect(r.versao).toBe(2);
      expect(r.chamadasML).toBe(1);
      expect(r.duracaoMs).toBeGreaterThanOrEqual(0);
    }
    expect(chamadas).toEqual([0]);
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
describe('2. escolha do passo: rapido quase sempre, profundo de tempos em tempos', () => {
  it('revisao profunda recente → passo rapido (1 pagina)', async () => {
    const pedidos = await base(400, 600, { revisaoIdadeS: 60 });
    const { fn, chamadas } = fetcher(pedidos);
    const r = await refrescarSeVelho(cache, fn);
    expect(r.acao === 'sincronizado' && r.modo === 'rapido').toBe(true);
    expect(chamadas).toEqual([0]);
  });

  it('nunca houve revisao profunda → passo incremental', async () => {
    const pedidos = await base(400, 600, { revisaoIdadeS: null });
    const { fn, chamadas } = fetcher(pedidos);
    const r = await refrescarSeVelho(cache, fn);
    expect(r.acao === 'sincronizado' && r.modo === 'incremental').toBe(true);
    expect(chamadas.length).toBeGreaterThan(1);
  });

  it('revisao profunda mais velha que ORDERS_REFRESH_REVISAO_S → passo incremental', async () => {
    const pedidos = await base(400, 600, { revisaoIdadeS: 601 });
    const r = await refrescarSeVelho(cache, fetcher(pedidos).fn);
    expect(r.acao === 'sincronizado' && r.modo === 'incremental').toBe(true);
    // e a revisao fica registrada, entao a proxima volta ao rapido
    expect((await readStatus(cache, 'ativos'))!.ultimaRevisaoEm).not.toBeNull();
    await envelhecer();
    const r2 = await refrescarSeVelho(cache, fetcher(pedidos).fn);
    expect(r2.acao === 'sincronizado' && r2.modo === 'rapido').toBe(true);
  });

  /**
   * O incremental com um pedido novo nao cabe em 5 paginas (250 conhecidos a
   * revisar + o novo): termina `parcial`, sem publicar. Antes desta fase esse
   * era o UNICO passo do auto-refresh, e por isso uma venda levava duas
   * rodadas para aparecer. Agora o parcial pendente e terminado na chamada
   * seguinte, antes de qualquer outra coisa.
   */
  it('passo incremental parcial pendente e terminado na chamada seguinte, mesmo com revisao recente', async () => {
    const pedidos = await base(400, 600, { revisaoIdadeS: 601 });
    const { fn } = fetcher([pedido('9999', -1), ...pedidos]);

    const r1 = await refrescarSeVelho(cache, fn);
    expect(r1.acao === 'sincronizado' && r1.modo === 'incremental' && r1.publicou === false && r1.motivo === 'parcial').toBe(true);

    await envelhecer();
    const r2 = await refrescarSeVelho(cache, fn);
    expect(r2.acao === 'sincronizado' && r2.modo === 'incremental' && r2.publicou === true).toBe(true);
    expect((await readSnapshot(cache, 'ativos')).some(o => String(o.id) === '9999')).toBe(true);
  });

  it('mudanca de status FORA da primeira pagina e capturada pela revisao profunda', async () => {
    const pedidos = await base(400, 600, { revisaoIdadeS: 601 });
    const mudado = pedidos.map(p => (p.id === 120 ? { ...p, status: 'cancelled' } : p));
    const { fn } = fetcher(mudado);

    let r = await refrescarSeVelho(cache, fn);
    for (let i = 0; i < 3 && r.acao === 'sincronizado' && r.motivo === 'parcial'; i++) {
      await envelhecer();
      r = await refrescarSeVelho(cache, fn);
    }

    expect(r.acao === 'sincronizado' && r.publicou).toBe(true);
    expect((await readSnapshot(cache, 'ativos')).find(o => o.id === 120)!.status).toBe('cancelled');
  });

  it('opts.modo forca o passo', async () => {
    const pedidos = await base(400, 600, { revisaoIdadeS: 60 });
    const r = await refrescarSeVelho(cache, fetcher(pedidos).fn, { modo: 'incremental' });
    expect(r.acao === 'sincronizado' && r.modo === 'incremental').toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('3. carga: N abas nao viram N sincronizacoes', () => {
  it('2 abas pedindo juntas: uma sincroniza, a outra recebe cooldown', async () => {
    const pedidos = await base(10, 600);
    const { fn, chamadas } = fetcher([pedido('9999', -1), ...pedidos]);
    const rs = await Promise.all([refrescarSeVelho(cache, fn), refrescarSeVelho(cache, fn)]);
    expect(rs.map(r => r.acao).sort()).toEqual(['cooldown', 'sincronizado']);
    expect(chamadas).toHaveLength(1);
  });

  it('10 abas abertas produzem UMA sincronizacao e UMA chamada ao ML', async () => {
    const pedidos = await base(10, 600);
    const { fn, chamadas } = fetcher([pedido('9999', -1), ...pedidos]);

    const rs = await Promise.all(
      Array.from({ length: 10 }, () => refrescarSeVelho(cache, fn))
    );

    expect(rs.filter(r => r.acao === 'sincronizado')).toHaveLength(1);
    expect(rs.filter(r => r.acao === 'cooldown')).toHaveLength(9);
    expect(chamadas).toHaveLength(1);
    // as nove ficam sabendo a versao vigente, para nao recarregar a toa
    for (const r of rs) if (r.acao === 'cooldown') expect(r.versao).toBe(1);
    // Telemetria e best-effort (leitura-e-regravacao sem lock): nove
    // incrementos concorrentes podem virar um. O que importa e que o bloqueio
    // ficou visivel.
    expect((await lerObsSync(cache)).cooldown).toBeGreaterThanOrEqual(1);
    expect((await lerObsSync(cache)).ultimoCooldownEm).not.toBeNull();
  });

  /**
   * Duas barreiras, em ordem. A primeira e a frescura: depois de um passo bem
   * sucedido o proprio passo grava `lastSyncAt` novo, entao a chamada
   * seguinte nem chega ao cooldown — sai em `fresco`. A segunda e o cooldown,
   * que existe para o caso em que o snapshot CONTINUA velho: passo parcial,
   * lock ocupado, ML instavel.
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
    const st = (await readStatus(cache, 'ativos'))!;
    await cache.set('orders:sync:status:ativos', JSON.stringify({ ...st, lastSyncAt: new Date(Date.now() - 600_000).toISOString() }));

    const segunda = await refrescarSeVelho(cache, fn);
    expect(segunda.acao).toBe('cooldown');
    expect(chamadas.length).toBe(apos);
  });

  it('expirado o cooldown, uma nova sincronizacao e permitida', async () => {
    const pedidos = await base(10, 600);
    const { fn } = fetcher([pedido('9999', -1), ...pedidos]);

    await refrescarSeVelho(cache, fn, { cooldownS: 1 });
    await new Promise(r => setTimeout(r, 1100));
    const st = (await readStatus(cache, 'ativos'))!;
    await cache.set('orders:sync:status:ativos', JSON.stringify({ ...st, lastSyncAt: new Date(Date.now() - 600_000).toISOString() }));

    const r = await refrescarSeVelho(cache, fn, { cooldownS: 1 });
    expect(r.acao).not.toBe('cooldown');
  });

  it('o cooldown NAO e consumido quando o snapshot esta fresco', async () => {
    await base(10, 5);
    await refrescarSeVelho(cache, fetcher([]).fn);
    expect(await cache.get(CHAVE_COOLDOWN_REFRESH)).toBeNull();
  });

  it('o poll de uma aba por varias rodadas: uma chamada ao ML por janela, e so', async () => {
    const pedidos = await base(10, 600);
    const { fn, chamadas } = fetcher(pedidos);
    // 12 rodadas de 15s = 3 minutos de aba aberta, com o relogio simulado.
    let agora = Date.now();
    const acoes: string[] = [];
    for (let i = 0; i < 12; i++) {
      agora += 15_000;
      // A idade e medida contra `agoraMs`; o cooldown real (15s) expira no relogio de verdade,
      // entao limpamos para simular a passagem de tempo.
      await cache.del(CHAVE_COOLDOWN_REFRESH);
      acoes.push((await refrescarSeVelho(cache, fn, { agoraMs: agora })).acao);
    }
    // Cada sincronizacao grava lastSyncAt = relogio real, e o proximo tick simulado ja esta 15s a frente...
    // O que importa: nunca mais de UMA chamada por rodada, e nenhuma rodada lancou.
    expect(chamadas.length).toBeLessThanOrEqual(12);
    expect(acoes.every(a => a === 'sincronizado' || a === 'fresco')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('4. concorrencia com os outros escritores do snapshot', () => {
  it('lock do GitHub Actions ocupado: nao inicia outro sync, e conta o bloqueio', async () => {
    const pedidos = await base(10, 600);
    const { fn, chamadas } = fetcher([pedido('9999', -1), ...pedidos]);
    await cache.setNX(ORDERS_SYNC_LOCK_KEY, 'reconciliacao-github-actions', 120);

    const r = await refrescarSeVelho(cache, fn);

    expect(r.acao).toBe('sync_em_andamento');
    expect(chamadas).toHaveLength(0);
    expect(await cache.get(ORDERS_SYNC_LOCK_KEY)).toBe('reconciliacao-github-actions');
    const obs = await lerObsSync(cache);
    expect(obs.lockOcupado).toBe(1);
    expect(obs.ultimoLockOcupadoEm).not.toBeNull();
  });

  it('lock do dreno de notificacoes ocupado: idem, no passo profundo tambem', async () => {
    const pedidos = await base(10, 600, { revisaoIdadeS: null });
    const { fn, chamadas } = fetcher([pedido('9999', -1), ...pedidos]);
    await cache.setNX(ORDERS_SYNC_LOCK_KEY, 'dreno-webhook', 120);

    const r = await refrescarSeVelho(cache, fn);

    expect(r.acao).toBe('sync_em_andamento');
    if (r.acao === 'sync_em_andamento') expect(r.modo).toBe('incremental');
    expect(chamadas).toHaveLength(0);
    expect(await cache.get(ORDERS_SYNC_LOCK_KEY)).toBe('dreno-webhook');
  });

  it('usa o MESMO lock da sincronizacao — e o libera ao final', async () => {
    const pedidos = await base(10, 600);
    await refrescarSeVelho(cache, fetcher([pedido('9999', -1), ...pedidos]).fn);
    expect(await cache.get(ORDERS_SYNC_LOCK_KEY)).toBeNull();
  });

  it('o refresh nao atrapalha a reconciliacao seguinte', async () => {
    const pedidos = await base(10, 600);
    const novo = pedido('9999', -1);
    const { fn } = fetcher([novo, ...pedidos]);

    await refrescarSeVelho(cache, fn);
    const r = await runSyncStep(cache, fn, { modo: 'incremental' });

    expect(r.motivo).toBe('sem_novos');
    expect((await readSnapshot(cache, 'ativos')).filter(o => String(o.id) === '9999')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('5. falha do Mercado Livre nao derruba o dashboard', () => {
  it('erro na busca vira { acao: erro } e o snapshot anterior continua intacto', async () => {
    await base(10, 600);
    const antes = await readManifest(cache, 'ativos');
    const fn: FetchOrdersPage = async () => { throw new Error('ML fora do ar'); };

    const r = await refrescarSeVelho(cache, fn);

    expect(r.acao).toBe('erro');
    if (r.acao === 'erro') { expect(r.modo).toBe('rapido'); expect(r.versao).toBe(1); }
    expect((await readManifest(cache, 'ativos'))!.versao).toBe(antes!.versao);
    expect(await readSnapshot(cache, 'ativos')).toHaveLength(10);
    const obs = await lerObsSync(cache);
    expect(obs.totalFalhas).toBe(1);
    expect(obs.ultimaFalhaMotivo).toContain('ML fora do ar');
    expect(obs.ultimaFalhaOrigem).toBe('dashboard_refresh');
  });

  it('erro no passo profundo tambem vira { acao: erro }', async () => {
    await base(10, 600, { revisaoIdadeS: null });
    const fn: FetchOrdersPage = async () => { throw new Error('ML fora do ar'); };
    const r = await refrescarSeVelho(cache, fn);
    expect(r.acao === 'erro' && r.modo === 'incremental').toBe(true);
  });

  it('refrescarSeVelho NUNCA lanca — o dashboard nao pode quebrar por causa do ML', async () => {
    await base(10, 600);
    const fn: FetchOrdersPage = async () => { throw new Error('explosao'); };
    await expect(refrescarSeVelho(cache, fn)).resolves.toBeDefined();
  });

  it('429 do ML alonga o cooldown: a aba nao volta a insistir em segundos', async () => {
    await base(10, 600);
    const fn: FetchOrdersPage = async () => { throw new Error('ML /orders/search HTTP 429 (offset 0).'); };

    const r = await refrescarSeVelho(cache, fn, { cooldownS: 1 });

    expect(r.acao).toBe('erro');
    const exp = cache.store.get(CHAVE_COOLDOWN_REFRESH)!.exp!;
    expect(exp - Date.now()).toBeGreaterThan(60_000);   // 120s por padrao, nao 1s
    await new Promise(x => setTimeout(x, 1100));
    expect((await refrescarSeVelho(cache, fn, { cooldownS: 1 })).acao).toBe('cooldown');
  });

  it('timeout (abort) do ML e tratado como erro comum, com o snapshot intacto', async () => {
    await base(10, 600);
    const fn: FetchOrdersPage = async () => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; throw e; };
    const r = await refrescarSeVelho(cache, fn);
    expect(r.acao).toBe('erro');
    expect(await readSnapshot(cache, 'ativos')).toHaveLength(10);
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
      expect(r.versao).toBe(antes!.versao);
    }
    expect((await readManifest(cache, 'ativos'))!.versao).toBe(antes!.versao);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('6. telemetria: descobrir o problema em uma leitura', () => {
  it('tentativa, conclusao, pedido novo e versao publicada ficam registrados', async () => {
    const pedidos = await base(10, 600);
    const { fn } = fetcher([pedido('9999', -1), ...pedidos]);
    const antes = Date.now();

    await refrescarSeVelho(cache, fn);

    const obs = await lerObsSync(cache);
    expect(obs.totalTentativas).toBe(1);
    expect(obs.totalConcluidos).toBe(1);
    expect(obs.totalPublicacoes).toBe(1);
    expect(obs.ultimaOrigem).toBe('dashboard_refresh');
    expect(obs.ultimoModo).toBe('rapido');
    expect(obs.ultimasChamadasML).toBe(1);
    expect(obs.ultimosPedidosNovos).toBe(1);
    expect(obs.ultimaVersaoPublicada).toBe(2);
    expect(Date.parse(obs.ultimoPedidoNovoEm!)).toBeGreaterThanOrEqual(antes);
    expect(obs.ultimaDuracaoMs).toBeGreaterThanOrEqual(0);
  });

  it('sem novidade: conclusao registrada, publicacao nao', async () => {
    const pedidos = await base(10, 600);
    await refrescarSeVelho(cache, fetcher(pedidos).fn);
    const obs = await lerObsSync(cache);
    expect(obs.totalConcluidos).toBe(1);
    expect(obs.totalPublicacoes).toBe(0);
    expect(obs.ultimoPedidoNovoEm).toBeNull();
  });

  it('o motivo da falha e texto truncado e sem credencial nem query string', async () => {
    await base(10, 600);
    const fn: FetchOrdersPage = async () => {
      throw new Error('fetch falhou https://api.mercadolibre.com/orders/search?seller=1&access_token=APP_USR-abcdef ' + 'x'.repeat(300));
    };
    await refrescarSeVelho(cache, fn);
    const obs = await lerObsSync(cache);
    expect(typeof obs.ultimaFalhaMotivo).toBe('string');
    expect(obs.ultimaFalhaMotivo!.length).toBeLessThanOrEqual(200);
    expect(obs.ultimaFalhaMotivo).not.toContain('APP_USR-abcdef');
    expect(obs.ultimaFalhaMotivo).not.toContain('seller=1');
    expect(obs.ultimaFalhaMotivo).toContain('[redigido]');
  });
});
