import { describe, it, expect } from 'vitest';
import {
  dedupById,
  toSlim,
  faturamentoPeriodo,
  vendasPorItem,
  vendasPorSkuDetalhado,
  vendasPorSkuAgregado,
  faturamentoMensal,
  faturamentoPorDia,
  cancelMotivos,
  contarPorStatus,
  type OrderInput,
} from '../src/services/orders.service.js';
import { brtStartOfDay, brtEndOfDay } from '../src/lib/datas-brt.js';

const order = (over: Partial<OrderInput> & { id: number | string }): OrderInput => ({
  status: 'paid',
  date_created: '2026-07-10T12:00:00.000-03:00',
  paid_amount: 100,
  order_items: [{ quantity: 1, unit_price: 100, item: { id: 'MLB1', title: 'Vinho A' } }],
  ...over,
});

// ══════════════════════════════════════════════════════════════════════════
// 1. dedupById
// ══════════════════════════════════════════════════════════════════════════
describe('dedupById', () => {
  it('remove ids repetidos; primeiro vence; ordem preservada', () => {
    const out = dedupById([
      order({ id: 1, paid_amount: 10 }),
      order({ id: 2, paid_amount: 20 }),
      order({ id: 1, paid_amount: 999 }),
    ]);
    expect(out.map(o => o.id)).toEqual([1, 2]);
    expect(out[0].paid_amount).toBe(10); // primeiro venceu
  });
  it('trata id numérico e string como o mesmo pedido', () => {
    const out = dedupById([order({ id: 123 }), order({ id: '123' })]);
    expect(out).toHaveLength(1);
  });
  it('lista vazia → vazia', () => {
    expect(dedupById([])).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. toSlim
// ══════════════════════════════════════════════════════════════════════════
describe('toSlim', () => {
  it('mantém apenas os campos do slim map, sem extras', () => {
    const full: OrderInput = {
      id: 1,
      status: 'paid',
      date_created: '2026-07-10T12:00:00.000-03:00',
      paid_amount: 100,
      total_amount: 110,
      order_items: [{ quantity: 2, unit_price: 50, item: { id: 'MLB1', title: 'V', seller_sku: 'SK', variation_id: 7 } }],
      buyer: { nickname: 'joao' },
      shipping: { id: 555, logistic_type: 'fulfillment' },
      // campos extras que NÃO devem passar:
      cancel_detail: { group: 'seller', code: 'x' },
    };
    const slim = toSlim(full);
    expect(Object.keys(slim).sort()).toEqual(
      ['buyer', 'date_created', 'id', 'order_items', 'paid_amount', 'shipping', 'status', 'total_amount'].sort()
    );
    expect(slim).not.toHaveProperty('cancel_detail');
    expect(Object.keys(slim.order_items[0]).sort()).toEqual(['item', 'quantity', 'unit_price'].sort());
    expect(Object.keys(slim.order_items[0].item).sort()).toEqual(
      ['id', 'seller_sku', 'title', 'variation_id'].sort()
    );
    expect(slim.buyer).toEqual({ nickname: 'joao' });
  });
  it('buyer/shipping ausentes ficam ausentes (não viram objeto vazio)', () => {
    const slim = toSlim({ id: 1, status: 'paid' });
    expect(slim).not.toHaveProperty('buyer');
    expect(slim).not.toHaveProperty('shipping');
    expect(slim.order_items).toEqual([]);
    expect(slim.paid_amount).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. faturamentoPeriodo
// ══════════════════════════════════════════════════════════════════════════
describe('faturamentoPeriodo', () => {
  const ini = brtStartOfDay('2026-07-10');
  const fim = brtEndOfDay('2026-07-17');

  it('só pagos no período entram; cancelado e pendente ignorados', () => {
    const r = faturamentoPeriodo(
      [
        order({ id: 1, paid_amount: 100 }),
        order({ id: 2, paid_amount: 999, status: 'cancelled' }),
        order({ id: 3, paid_amount: 999, status: 'payment_required' }),
        order({ id: 4, paid_amount: 999, date_created: '2026-08-01T12:00:00.000-03:00' }), // fora
      ],
      ini,
      fim
    );
    expect(r.bruto).toBe(100);
  });

  it('paid_amount 0 usa fallback total_amount (operador || legado)', () => {
    const r = faturamentoPeriodo(
      [order({ id: 1, paid_amount: 0, total_amount: 80 })],
      ini,
      fim
    );
    expect(r.bruto).toBe(80);
  });

  it('tarifas negativas, líquido = bruto + tarifas, e metadados de estimativa', () => {
    const r = faturamentoPeriodo([order({ id: 1, paid_amount: 1000 })], ini, fim);
    expect(r.bruto).toBe(1000);
    expect(r.tarifaML).toBeCloseTo(-148, 10);
    expect(r.tarifaEnv).toBeCloseTo(-144, 10);
    expect(r.liquido).toBeCloseTo(708, 10);
    expect(r.estimado).toBe(true);
    expect(r.fonte).toBe('dashboard_legado');
    expect(typeof r.metodologia).toBe('string');
  });

  it('bordas de período BRT são inclusivas', () => {
    const dentroIni = order({ id: 1, date_created: '2026-07-10T00:00:00.000-03:00', paid_amount: 10 });
    const foraIni = order({ id: 2, date_created: '2026-07-09T23:59:59.999-03:00', paid_amount: 10 });
    const dentroFim = order({ id: 3, date_created: '2026-07-17T23:59:59.999-03:00', paid_amount: 10 });
    const foraFim = order({ id: 4, date_created: '2026-07-18T00:00:00.000-03:00', paid_amount: 10 });
    const r = faturamentoPeriodo([dentroIni, foraIni, dentroFim, foraFim], ini, fim);
    expect(r.bruto).toBe(20); // só os dois dentro
  });

  it('limites nulos = sem filtro daquele lado', () => {
    const r = faturamentoPeriodo([order({ id: 1, paid_amount: 50, date_created: '1999-01-01T00:00:00.000-03:00' })], null, null);
    expect(r.bruto).toBe(50);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 4 vs 6. DIVERGÊNCIA LEGADA — primeiro order_item vs todos
// ══════════════════════════════════════════════════════════════════════════
describe('DIVERGÊNCIA legada: vendasPorItem (primeiro order_item) vs vendasPorSkuAgregado (todos)', () => {
  // Pedido com DOIS order_items distintos.
  const multi = order({
    id: 1,
    paid_amount: 300,
    order_items: [
      { quantity: 1, unit_price: 100, item: { id: 'MLB1', title: 'A' } },
      { quantity: 4, unit_price: 50, item: { id: 'MLB2', title: 'B' } },
    ],
  });

  it('vendasPorItem conta SÓ o primeiro order_item e usa paid_amount do pedido inteiro', () => {
    const m = vendasPorItem([multi]);
    expect([...m.keys()]).toEqual(['MLB1']);        // MLB2 não indexado
    const a = m.get('MLB1')!;
    expect(a.pedidos).toBe(1);
    expect(a.unidades).toBe(1);                      // só a qtd do primeiro item
    expect(a.receita).toBe(300);                     // paid_amount do PEDIDO inteiro
    expect(m.get('MLB2')).toBeUndefined();
  });

  it('vendasPorSkuAgregado percorre TODOS os order_items com unit_price real', () => {
    const skuMap = { MLB1: 'SKU-A', MLB2: 'SKU-B' };
    const m = vendasPorSkuAgregado([multi], skuMap);
    expect(new Set(m.keys())).toEqual(new Set(['SKU-A', 'SKU-B']));
    expect(m.get('SKU-A')!.totalQty).toBe(1);
    expect(m.get('SKU-A')!.totalRev).toBe(100);      // 100 * 1
    expect(m.get('SKU-B')!.totalQty).toBe(4);
    expect(m.get('SKU-B')!.totalRev).toBe(200);      // 50 * 4
  });

  it('a divergência é real: MLB2 some em vendasPorItem mas aparece no agregado', () => {
    const porItem = vendasPorItem([multi]);
    const agregado = vendasPorSkuAgregado([multi], { MLB1: 'SKU-A', MLB2: 'SKU-B' });
    expect(porItem.has('MLB2')).toBe(false);
    expect([...agregado.keys()]).toContain('SKU-B');
  });
});

describe('vendasPorItem — filtros e defaults', () => {
  it('exclui cancelled; pendente CONTA', () => {
    const m = vendasPorItem([
      order({ id: 1, paid_amount: 100 }),
      order({ id: 2, paid_amount: 100, status: 'cancelled' }),
      order({ id: 3, paid_amount: 100, status: 'payment_required' }),
    ]);
    expect(m.get('MLB1')!.pedidos).toBe(2); // paid + pendente
  });
  it('quantity ausente → 1', () => {
    const m = vendasPorItem([order({ id: 1, order_items: [{ item: { id: 'MLB1' } }] })]);
    expect(m.get('MLB1')!.unidades).toBe(1);
  });
  it('respeita período quando fornecido', () => {
    const ini = brtStartOfDay('2026-07-10');
    const fim = brtEndOfDay('2026-07-17');
    const m = vendasPorItem(
      [order({ id: 1 }), order({ id: 2, date_created: '2026-08-01T12:00:00.000-03:00' })],
      ini,
      fim
    );
    expect(m.get('MLB1')!.pedidos).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 5. vendasPorSkuDetalhado
// ══════════════════════════════════════════════════════════════════════════
describe('vendasPorSkuDetalhado', () => {
  const skuMap = { MLB1: 'SKU-A', MLB2: 'SKU-B' };

  it('só paid; filtra por SKU; usa unit_price real', () => {
    const vendas = vendasPorSkuDetalhado(
      [
        order({ id: 1, order_items: [{ quantity: 2, unit_price: 40, item: { id: 'MLB1', title: 'A' } }] }),
        order({ id: 2, status: 'cancelled', order_items: [{ quantity: 9, unit_price: 40, item: { id: 'MLB1' } }] }),
      ],
      skuMap,
      'SKU-A'
    );
    expect(vendas).toHaveLength(1);
    expect(vendas[0]).toMatchObject({ orderId: 1, itemId: 'MLB1', qtd: 2, precoUnit: 40, valorTotal: 80 });
  });

  it('dedup por order:item:idx (mesmo item repetido em índices distintos NÃO é deduplicado; mesmo idx sim)', () => {
    // dois order_items do mesmo item em índices diferentes → duas linhas
    const vendas = vendasPorSkuDetalhado(
      [order({ id: 1, order_items: [
        { quantity: 1, unit_price: 40, item: { id: 'MLB1' } },
        { quantity: 1, unit_price: 45, item: { id: 'MLB1' } },
      ] })],
      skuMap,
      'SKU-A'
    );
    expect(vendas).toHaveLength(2);
  });

  it('ordenação determinística: mesma saída com entrada invertida', () => {
    const orders = [
      order({ id: 3, date_created: '2026-07-12T10:00:00.000-03:00', order_items: [{ quantity: 1, unit_price: 10, item: { id: 'MLB1' } }] }),
      order({ id: 1, date_created: '2026-07-10T10:00:00.000-03:00', order_items: [{ quantity: 1, unit_price: 10, item: { id: 'MLB1' } }] }),
      order({ id: 2, date_created: '2026-07-11T10:00:00.000-03:00', order_items: [{ quantity: 1, unit_price: 10, item: { id: 'MLB1' } }] }),
    ];
    const a = vendasPorSkuDetalhado(orders, skuMap, 'SKU-A');
    const b = vendasPorSkuDetalhado([...orders].reverse(), skuMap, 'SKU-A');
    expect(a.map(v => v.orderId)).toEqual([1, 2, 3]); // data asc
    expect(a).toEqual(b);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 6. vendasPorSkuAgregado — semana
// ══════════════════════════════════════════════════════════════════════════
describe('vendasPorSkuAgregado — quebra semanal', () => {
  it('usa a função semanaDe fornecida pelo chamador', () => {
    const skuMap = { MLB1: 'SKU-A' };
    const orders = [
      order({ id: 1, date_created: '2026-07-01T10:00:00.000-03:00', order_items: [{ quantity: 2, unit_price: 10, item: { id: 'MLB1' } }] }),
      order({ id: 2, date_created: '2026-07-10T10:00:00.000-03:00', order_items: [{ quantity: 3, unit_price: 10, item: { id: 'MLB1' } }] }),
    ];
    const semanaDe = (iso: string) => (iso.startsWith('2026-07-01') ? 1 : 2);
    const m = vendasPorSkuAgregado(orders, skuMap, null, null, semanaDe);
    expect(m.get('SKU-A')!.porSemana).toEqual({ 1: 2, 2: 3 });
    expect(m.get('SKU-A')!.totalQty).toBe(5);
  });
  it('sem semanaDe, tudo cai na semana 1', () => {
    const m = vendasPorSkuAgregado([order({ id: 1 })], { MLB1: 'SKU-A' });
    expect(m.get('SKU-A')!.porSemana).toEqual({ 1: 1 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 7. faturamentoMensal
// ══════════════════════════════════════════════════════════════════════════
describe('faturamentoMensal', () => {
  it('agrupa por YYYY-MM, só pagos, ordenado asc', () => {
    const s = faturamentoMensal([
      order({ id: 1, date_created: '2026-06-15T10:00:00.000-03:00', paid_amount: 100 }),
      order({ id: 2, date_created: '2026-07-15T10:00:00.000-03:00', paid_amount: 200 }),
      order({ id: 3, date_created: '2026-07-20T10:00:00.000-03:00', paid_amount: 50 }),
      order({ id: 4, date_created: '2026-07-20T10:00:00.000-03:00', paid_amount: 999, status: 'cancelled' }),
    ]);
    expect(s).toEqual([
      { mes: '2026-06', total: 100 },
      { mes: '2026-07', total: 250 },
    ]);
  });
  it('date_created ausente é ignorado', () => {
    expect(faturamentoMensal([order({ id: 1, date_created: null })])).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 8. faturamentoPorDia
// ══════════════════════════════════════════════════════════════════════════
describe('faturamentoPorDia', () => {
  it('agrupa por dia BRT, filtra mês/ano, só pagos', () => {
    const p = faturamentoPorDia(
      [
        order({ id: 1, date_created: '2026-07-10T12:00:00.000-03:00', paid_amount: 100 }),
        order({ id: 2, date_created: '2026-07-10T15:00:00.000-03:00', paid_amount: 50 }),
        order({ id: 3, date_created: '2026-07-11T12:00:00.000-03:00', paid_amount: 30 }),
        order({ id: 4, date_created: '2026-08-01T12:00:00.000-03:00', paid_amount: 999 }), // outro mês
      ],
      7,
      2026
    );
    expect(p).toEqual({ 10: 150, 11: 30 });
  });
  it('madrugada UTC que ainda é dia anterior em BRT cai no dia certo', () => {
    // 02:00Z de 11/07 = 23:00 BRT de 10/07
    const p = faturamentoPorDia([order({ id: 1, date_created: '2026-07-11T02:00:00.000Z', paid_amount: 40 })], 7, 2026);
    expect(p).toEqual({ 10: 40 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 9. cancelMotivos
// ══════════════════════════════════════════════════════════════════════════
describe('cancelMotivos', () => {
  it('agrupa por group::code, soma total, ordena por count desc', () => {
    const m = cancelMotivos([
      { id: 1, cancel_detail: { group: 'seller', code: 'out_of_stock' }, total_amount: 100 },
      { id: 2, cancel_detail: { group: 'seller', code: 'out_of_stock' }, total_amount: 50 },
      { id: 3, cancel_detail: { group: 'buyer', code: 'regret' }, total_amount: 30 },
    ]);
    expect(m[0]).toMatchObject({ group: 'seller', code: 'out_of_stock', count: 2, total: 150 });
    expect(m[1]).toMatchObject({ group: 'buyer', code: 'regret', count: 1, total: 30 });
  });
  it('cancel_detail ausente → desconhecido::sem_detalhe', () => {
    const m = cancelMotivos([{ id: 1, total_amount: 10 }]);
    expect(m[0]).toMatchObject({ group: 'desconhecido', code: 'sem_detalhe' });
  });
  it('usa labelDeCodigo com fallback para description', () => {
    const m = cancelMotivos(
      [{ id: 1, cancel_detail: { group: 'seller', code: 'x', description: 'desc api' }, total_amount: 0 }],
      code => (code === 'x' ? 'Rótulo Amigável' : undefined)
    );
    expect(m[0].desc).toBe('Rótulo Amigável');
    const semLabel = cancelMotivos([{ id: 1, cancel_detail: { group: 'seller', code: 'y', description: 'desc api' }, total_amount: 0 }]);
    expect(semLabel[0].desc).toBe('desc api');
  });
  it('ordenação determinística no empate de count (por group::code)', () => {
    const orders: OrderInput[] = [
      { id: 1, cancel_detail: { group: 'seller', code: 'b' }, total_amount: 0 },
      { id: 2, cancel_detail: { group: 'buyer', code: 'a' }, total_amount: 0 },
    ];
    const a = cancelMotivos(orders);
    const b = cancelMotivos([...orders].reverse());
    expect(a.map(m => `${m.group}::${m.code}`)).toEqual(b.map(m => `${m.group}::${m.code}`));
    expect(a[0].group).toBe('buyer'); // buyer::a < seller::b
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 10. contarPorStatus
// ══════════════════════════════════════════════════════════════════════════
describe('contarPorStatus', () => {
  it('conta por status; ausente → desconhecido', () => {
    const c = contarPorStatus([
      order({ id: 1, status: 'paid' }),
      order({ id: 2, status: 'paid' }),
      order({ id: 3, status: 'cancelled' }),
      order({ id: 4, status: null }),
    ]);
    expect(c).toEqual({ paid: 2, cancelled: 1, desconhecido: 1 });
  });
});