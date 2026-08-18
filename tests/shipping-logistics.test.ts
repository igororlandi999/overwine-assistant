import { describe, it, expect, beforeEach } from 'vitest';
import { FakeCache } from './fake-cache.js';
import {
  lerManifesto,
  lerMapaLogistica,
  publicarMapaLogistica,
  CHAVE_MANIFESTO,
  CHUNK_SIZE,
} from '../src/lib/shipping-store.js';
import {
  idsPendentes,
  mesclarResolvidos,
  logisticaDoPedido,
  coberturaLogistica,
  executarPasso,
  LOTE_PADRAO,
  LOTE_MAX,
  CONCORRENCIA,
  type BuscarLogistica,
} from '../src/services/shipping-logistics.service.js';
import { custoUnitarioVendido } from '../src/services/products.service.js';
import type { OrderSlim } from '../src/services/orders.service.js';

function ped(over: Partial<OrderSlim> & { shipId?: number | string | null } = {}): OrderSlim {
  const { shipId, ...resto } = over;
  return {
    id: 1,
    status: 'paid',
    date_created: '2026-08-10T12:00:00.000Z',
    paid_amount: 100,
    total_amount: null,
    order_items: [],
    shipping: shipId === null ? undefined : { id: (shipId ?? 999) as number, logistic_type: null },
    ...resto,
  } as unknown as OrderSlim;
}

// ══════════════════════════════════════════════════════════════════════════
describe('shipping-store', () => {
  let cache: FakeCache;
  beforeEach(() => { cache = new FakeCache(); });

  it('mapa vazio quando nao ha manifesto — nunca lanca', async () => {
    expect(await lerManifesto(cache)).toBeNull();
    expect((await lerMapaLogistica(cache)).size).toBe(0);
  });

  it('publica e le de volta', async () => {
    const mapa = new Map([['111', 'fulfillment'], ['222', 'xd_drop_off']]);
    const m = await publicarMapaLogistica(cache, mapa);
    expect(m.versao).toBe(1);
    expect(m.total).toBe(2);
    expect(await lerMapaLogistica(cache)).toEqual(mapa);
  });

  it('cada publicacao cria versao nova; a anterior nao e apagada', async () => {
    const m1 = await publicarMapaLogistica(cache, new Map([['111', 'fulfillment']]));
    const m2 = await publicarMapaLogistica(cache, new Map([['111', 'fulfillment'], ['222', 'self_service']]));
    expect(m2.versao).toBe(2);
    // Uma leitura concorrente que ja tinha o manifesto v1 ainda acha os chunks.
    expect(await cache.get(m1.chunks[0])).not.toBeNull();
  });

  it('divide em chunks e le todos de volta', async () => {
    const grande = new Map<string, string>();
    for (let i = 0; i < CHUNK_SIZE * 2 + 7; i++) grande.set(`ship${i}`, 'fulfillment');
    const m = await publicarMapaLogistica(cache, grande);
    expect(m.chunks.length).toBe(3);
    expect(m.total).toBe(grande.size);
    expect((await lerMapaLogistica(cache)).size).toBe(grande.size);
  });

  it('ordem estavel: o mesmo mapa produz os mesmos chunks', async () => {
    const a = new Map([['333', 'x'], ['111', 'y'], ['222', 'z']]);
    const b = new Map([['222', 'z'], ['333', 'x'], ['111', 'y']]);
    const c1 = new FakeCache(), c2 = new FakeCache();
    const m1 = await publicarMapaLogistica(c1, a);
    const m2 = await publicarMapaLogistica(c2, b);
    expect(await c1.get(m1.chunks[0])).toBe(await c2.get(m2.chunks[0]));
  });

  it('manifesto corrompido e tratado como ausente', async () => {
    await cache.set(CHAVE_MANIFESTO, 'isto nao e json');
    expect(await lerManifesto(cache)).toBeNull();
    expect((await lerMapaLogistica(cache)).size).toBe(0);
  });

  it('manifesto com forma invalida e recusado', async () => {
    await cache.set(CHAVE_MANIFESTO, JSON.stringify({ versao: 0, chunks: [], total: 1, chunkSize: 1, updatedAt: 'x' }));
    expect(await lerManifesto(cache)).toBeNull();
  });

  it('chunk faltando NAO derruba a leitura — devolve o que sobrou', async () => {
    const mapa = new Map<string, string>();
    for (let i = 0; i < CHUNK_SIZE + 5; i++) mapa.set(`s${String(i).padStart(6, '0')}`, 'fulfillment');
    const m = await publicarMapaLogistica(cache, mapa);
    await cache.del(m.chunks[1]);
    const lido = await lerMapaLogistica(cache);
    expect(lido.size).toBe(CHUNK_SIZE);
    expect(lido.size).toBeLessThan(mapa.size);
  });

  it('entrada malformada dentro do chunk e ignorada', async () => {
    const m = await publicarMapaLogistica(cache, new Map([['111', 'fulfillment']]));
    await cache.set(m.chunks[0], JSON.stringify([
      ['111', 'fulfillment'], ['222'], 'texto solto', [null, 'x'], ['333', ''], ['444', 'self_service'],
    ]));
    expect(await lerMapaLogistica(cache)).toEqual(new Map([['111', 'fulfillment'], ['444', 'self_service']]));
  });

  it('mapa vazio publica manifesto sem chunks', async () => {
    const m = await publicarMapaLogistica(cache, new Map());
    expect(m.chunks).toEqual([]);
    expect(m.total).toBe(0);
    expect((await lerMapaLogistica(cache)).size).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('idsPendentes', () => {
  it('so considera pedidos que contam como venda', () => {
    const r = idsPendentes([
      ped({ id: 1, status: 'paid', shipId: 111 }),
      ped({ id: 2, status: 'cancelled', shipId: 222 }),
      ped({ id: 3, status: 'partially_refunded', shipId: 333 }),
      ped({ id: 4, status: 'payment_required', shipId: 444 }),
    ], new Map());
    expect(r.ids.sort()).toEqual(['111', '333']);
    expect(r.totalDistintos).toBe(2);
  });

  it('deduplica envio compartilhado por varios pedidos', () => {
    // Em producao: 3.783 vendas para 3.521 envios distintos.
    const r = idsPendentes([
      ped({ id: 1, shipId: 111 }), ped({ id: 2, shipId: 111 }), ped({ id: 3, shipId: 222 }),
    ], new Map());
    expect(r.ids.sort()).toEqual(['111', '222']);
    expect(r.totalDistintos).toBe(2);
  });

  it('pula os que ja estao no mapa e os contabiliza', () => {
    const r = idsPendentes(
      [ped({ id: 1, shipId: 111 }), ped({ id: 2, shipId: 222 })],
      new Map([['111', 'fulfillment']])
    );
    expect(r.ids).toEqual(['222']);
    expect(r.jaResolvidos).toBe(1);
  });

  it('mais RECENTES primeiro: a margem melhora desde a primeira rodada', () => {
    const r = idsPendentes([
      ped({ id: 1, shipId: 111, date_created: '2025-01-01T00:00:00.000Z' }),
      ped({ id: 2, shipId: 222, date_created: '2026-08-18T00:00:00.000Z' }),
      ped({ id: 3, shipId: 333, date_created: '2026-03-15T00:00:00.000Z' }),
    ], new Map());
    expect(r.ids).toEqual(['222', '333', '111']);
  });

  it('data ausente vai para o fim, sem quebrar a ordenacao', () => {
    const r = idsPendentes([
      ped({ id: 1, shipId: 111, date_created: null as unknown as string }),
      ped({ id: 2, shipId: 222, date_created: '2026-08-18T00:00:00.000Z' }),
    ], new Map());
    expect(r.ids).toEqual(['222', '111']);
  });

  it('corta no limite e informa quantos restam', () => {
    const pedidos = Array.from({ length: 10 }, (_, i) => ped({ id: i, shipId: 100 + i }));
    const r = idsPendentes(pedidos, new Map(), 4);
    expect(r.ids.length).toBe(4);
    expect(r.restantes).toBe(6);
  });

  it('limite invalido cai no padrao; acima do teto e clampado', () => {
    const pedidos = Array.from({ length: 5 }, (_, i) => ped({ id: i, shipId: 100 + i }));
    expect(idsPendentes(pedidos, new Map(), 0).ids.length).toBe(5);
    expect(idsPendentes(pedidos, new Map(), -1).ids.length).toBe(5);
    expect(idsPendentes(pedidos, new Map(), NaN).ids.length).toBe(5);
    expect(idsPendentes(pedidos, new Map(), 99999).ids.length).toBe(5);
    expect(LOTE_PADRAO).toBeLessThanOrEqual(LOTE_MAX);
  });

  it('pedido sem envio e ignorado sem quebrar', () => {
    const r = idsPendentes([
      ped({ id: 1, shipId: null }),
      ped({ id: 2, shipId: 222 }),
      null as unknown as OrderSlim,
    ], new Map());
    expect(r.ids).toEqual(['222']);
  });

  it('id numerico e id string convergem para a mesma chave', () => {
    const r = idsPendentes([ped({ id: 1, shipId: 111 }), ped({ id: 2, shipId: ' 111 ' })], new Map());
    expect(r.ids).toEqual(['111']);
  });

  it('nao muta o array de pedidos ao ordenar', () => {
    const pedidos = [
      ped({ id: 1, shipId: 111, date_created: '2025-01-01T00:00:00.000Z' }),
      ped({ id: 2, shipId: 222, date_created: '2026-08-18T00:00:00.000Z' }),
    ];
    const antes = pedidos.map(p => p.id);
    idsPendentes(pedidos, new Map());
    expect(pedidos.map(p => p.id)).toEqual(antes);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('mesclarResolvidos', () => {
  it('acrescenta sem mutar a entrada', () => {
    const antes = new Map([['111', 'fulfillment']]);
    const depois = mesclarResolvidos(antes, [{ shipmentId: '222', logisticType: 'xd_drop_off' }]);
    expect(antes.size).toBe(1);
    expect(depois.get('222')).toBe('xd_drop_off');
  });

  it('CRITICO: valor vazio e DESCARTADO, nao gravado', () => {
    // Gravar string vazia faria ehVendaFull responder false para sempre, e o
    // envio nunca mais seria buscado — erro silencioso e permanente.
    const r = mesclarResolvidos(new Map(), [
      { shipmentId: '111', logisticType: '' },
      { shipmentId: '222', logisticType: '   ' },
      { shipmentId: '333', logisticType: null as unknown as string },
      { shipmentId: '', logisticType: 'fulfillment' },
      { shipmentId: '444', logisticType: 'fulfillment' },
    ]);
    expect([...r.keys()]).toEqual(['444']);
  });

  it('id descartado CONTINUA pendente para a proxima rodada', () => {
    const mapa = mesclarResolvidos(new Map(), [{ shipmentId: '111', logisticType: '' }]);
    expect(idsPendentes([ped({ shipId: 111 })], mapa).ids).toEqual(['111']);
  });

  it('sobrescreve valor anterior do mesmo id', () => {
    const r = mesclarResolvidos(new Map([['111', 'self_service']]), [
      { shipmentId: '111', logisticType: 'fulfillment' },
    ]);
    expect(r.get('111')).toBe('fulfillment');
  });

  it('lista vazia devolve copia equivalente', () => {
    const antes = new Map([['111', 'fulfillment']]);
    expect(mesclarResolvidos(antes, [])).toEqual(antes);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('logisticaDoPedido', () => {
  it('o campo do PROPRIO pedido tem prioridade sobre o mapa', () => {
    const o = ped({ shipId: 111 });
    (o as { shipping: { logistic_type: string } }).shipping.logistic_type = 'self_service';
    expect(logisticaDoPedido(o, new Map([['111', 'fulfillment']]))).toBe('self_service');
  });

  it('usa o mapa quando o pedido nao traz o campo (caso real de hoje)', () => {
    expect(logisticaDoPedido(ped({ shipId: 111 }), new Map([['111', 'fulfillment']])))
      .toBe('fulfillment');
  });

  it('null quando nao se sabe — nunca chuta', () => {
    expect(logisticaDoPedido(ped({ shipId: 111 }), new Map())).toBeNull();
    expect(logisticaDoPedido(ped({ shipId: null }), new Map([['111', 'fulfillment']]))).toBeNull();
    expect(logisticaDoPedido(ped({ shipId: 111 }), null)).toBeNull();
    expect(logisticaDoPedido(null, new Map())).toBeNull();
  });

  it('EFEITO REAL: mapa conhecido remove a embalagem indevida do Full', () => {
    // Este e o bug que motivou o modulo. Sem o mapa, logistic_type e null,
    // ehVendaFull(null) e false e o calculo soma R$ 3,00 de embalagem numa
    // venda em que o Mercado Livre e quem embala.
    const taxas = { frete: 1.49, embalagem: 3.00 };
    const o = ped({ shipId: 111 });

    const semMapa = custoUnitarioVendido(13.78, logisticaDoPedido(o, new Map()), taxas) as number;
    const comMapa = custoUnitarioVendido(13.78, logisticaDoPedido(o, new Map([['111', 'fulfillment']])), taxas) as number;

    expect(semMapa).toBeCloseTo(18.27, 2);
    expect(comMapa).toBeCloseTo(15.27, 2);
    expect(semMapa - comMapa).toBeCloseTo(3.00, 2);
  });

  it('xd_drop_off NAO e Full: continua somando embalagem', () => {
    // Valor real observado no historico. Se um dia entrar na lista de Full por
    // engano, a margem passa a ser SUPERestimada — pior que o bug original.
    const taxas = { frete: 1.49, embalagem: 3.00 };
    const o = ped({ shipId: 111 });
    const custo = custoUnitarioVendido(13.78, logisticaDoPedido(o, new Map([['111', 'xd_drop_off']])), taxas);
    expect(custo).toBeCloseTo(18.27, 2);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('coberturaLogistica', () => {
  it('mede o quanto do historico ja tem logistica conhecida', () => {
    const pedidos = [ped({ id: 1, shipId: 111 }), ped({ id: 2, shipId: 222 }), ped({ id: 3, shipId: 333 })];
    const c = coberturaLogistica(pedidos, new Map([['111', 'fulfillment']]));
    expect(c.totalDistintos).toBe(3);
    expect(c.resolvidos).toBe(1);
    expect(c.pendentes).toBe(2);
    expect(c.fracao).toBeCloseTo(1 / 3, 10);
  });

  it('sem pedidos, cobertura e total (nao ha o que desconhecer)', () => {
    const c = coberturaLogistica([], new Map());
    expect(c.fracao).toBe(1);
    expect(c.pendentes).toBe(0);
  });

  it('cancelados nao contam na cobertura', () => {
    const c = coberturaLogistica(
      [ped({ id: 1, status: 'cancelled', shipId: 111 }), ped({ id: 2, shipId: 222 })],
      new Map([['222', 'fulfillment']])
    );
    expect(c.totalDistintos).toBe(1);
    expect(c.fracao).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('executarPasso', () => {
  const pedidos = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      ped({ id: i, shipId: 1000 + i, date_created: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T12:00:00.000Z` }));

  const sempre = (tipo: string): BuscarLogistica => async () => tipo;

  it('resolve tudo e marca concluido quando cabe no lote', async () => {
    const { mapa, resultado } = await executarPasso(pedidos(5), new Map(), sempre('fulfillment'));
    expect(resultado.concluido).toBe(true);
    expect(resultado.buscados).toBe(5);
    expect(resultado.resolvidos).toBe(5);
    expect(resultado.restantes).toBe(0);
    expect(resultado.cobertura).toBe(1);
    expect(mapa.size).toBe(5);
  });

  it('nao concluido quando sobra: chamadas sucessivas terminam o backfill', async () => {
    // Reproduz o backfill real: 3.521 envios em lotes, uma chamada por vez.
    const todos = pedidos(25);
    let mapa = new Map<string, string>();
    let voltas = 0;
    let r;
    do {
      const passo = await executarPasso(todos, mapa, sempre('fulfillment'), { limite: 10 });
      mapa = passo.mapa;
      r = passo.resultado;
      voltas++;
      expect(voltas, 'laco infinito').toBeLessThan(10);
    } while (!r.concluido);
    expect(voltas).toBe(3);
    expect(mapa.size).toBe(25);
  });

  it('falha isolada NAO derruba o passo; o id continua pendente', async () => {
    const buscar: BuscarLogistica = async id => (id === '1002' ? null : 'fulfillment');
    const { mapa, resultado } = await executarPasso(pedidos(5), new Map(), buscar);
    expect(resultado.resolvidos).toBe(4);
    expect(resultado.falhas).toBe(1);
    expect(resultado.concluido).toBe(false);
    expect(resultado.restantes).toBe(1);
    expect(mapa.has('1002')).toBe(false);
    // A rodada seguinte tenta de novo — e agora funciona.
    const dois = await executarPasso(pedidos(5), mapa, sempre('xd_drop_off'));
    expect(dois.resultado.concluido).toBe(true);
    expect(dois.mapa.get('1002')).toBe('xd_drop_off');
  });

  it('excecao na busca e tratada como falha, nao propaga', async () => {
    const buscar: BuscarLogistica = async id => {
      if (id === '1001') throw new Error('ML fora do ar');
      return 'fulfillment';
    };
    const { resultado } = await executarPasso(pedidos(3), new Map(), buscar);
    expect(resultado.falhas).toBe(1);
    expect(resultado.resolvidos).toBe(2);
  });

  it('passo em que TUDO falha nao resolve nada e nao conclui', async () => {
    const { mapa, resultado } = await executarPasso(pedidos(4), new Map(), async () => null);
    expect(resultado.resolvidos).toBe(0);
    expect(resultado.falhas).toBe(4);
    expect(resultado.concluido).toBe(false);
    expect(mapa.size).toBe(0);
  });

  it('nunca passa de `concorrencia` requisicoes em voo', async () => {
    let emVoo = 0, pico = 0;
    const buscar: BuscarLogistica = async () => {
      emVoo++; pico = Math.max(pico, emVoo);
      await new Promise(r => setTimeout(r, 1));
      emVoo--;
      return 'fulfillment';
    };
    await executarPasso(pedidos(40), new Map(), buscar, { concorrencia: 5 });
    expect(pico).toBeLessThanOrEqual(5);
    expect(pico).toBeGreaterThan(1);   // paralelo de verdade, nao sequencial
  });

  it('concorrencia e limitada mesmo com valor absurdo', async () => {
    let emVoo = 0, pico = 0;
    const buscar: BuscarLogistica = async () => {
      emVoo++; pico = Math.max(pico, emVoo);
      await new Promise(r => setTimeout(r, 1));
      emVoo--; return 'fulfillment';
    };
    await executarPasso(pedidos(60), new Map(), buscar, { concorrencia: 9999 });
    expect(pico).toBeLessThanOrEqual(32);
    expect(CONCORRENCIA).toBeLessThanOrEqual(32);
  });

  it('nao busca envio que ja esta no mapa', async () => {
    const buscados: string[] = [];
    const buscar: BuscarLogistica = async id => { buscados.push(id); return 'fulfillment'; };
    await executarPasso(pedidos(3), new Map([['1001', 'fulfillment']]), buscar);
    expect(buscados).not.toContain('1001');
    expect(buscados.length).toBe(2);
  });

  it('nada a fazer: concluido, sem buscar', async () => {
    const buscar: BuscarLogistica = async () => { throw new Error('nao deveria buscar'); };
    const { resultado } = await executarPasso([], new Map(), buscar);
    expect(resultado.concluido).toBe(true);
    expect(resultado.buscados).toBe(0);
    expect(resultado.cobertura).toBe(1);
  });

  it('cobertura reflete o acumulado, nao so o passo', async () => {
    const todos = pedidos(10);
    const { resultado } = await executarPasso(todos, new Map([['1001', 'fulfillment']]), sempre('fulfillment'), { limite: 4 });
    // 1 ja conhecido + 4 deste passo = 5 de 10.
    expect(resultado.cobertura).toBeCloseTo(0.5, 10);
    expect(resultado.totalDistintos).toBe(10);
  });

  it('mistura de tipos e preservada por envio', async () => {
    const buscar: BuscarLogistica = async id => (id === '1000' ? 'fulfillment' : 'xd_drop_off');
    const { mapa } = await executarPasso(pedidos(3), new Map(), buscar);
    expect(mapa.get('1000')).toBe('fulfillment');
    expect(mapa.get('1001')).toBe('xd_drop_off');
  });

  it('nao muta o mapa de entrada', async () => {
    const antes = new Map([['1001', 'fulfillment']]);
    await executarPasso(pedidos(3), antes, sempre('xd_drop_off'));
    expect(antes.size).toBe(1);
  });
});