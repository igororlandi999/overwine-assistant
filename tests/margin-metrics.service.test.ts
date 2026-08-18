import { describe, it, expect } from 'vitest';
import {
  calcularMargem,
  melhoresMargens,
  pioresMargens,
  LIMITE_SEM_CUSTO,
  WARN_CUSTO_PARCIAL,
  WARN_CUSTO_INSUFICIENTE,
  WARN_ANTES_DE_PUBLICIDADE,
} from '../src/services/margin-metrics.service.js';
import type { OrderSlim } from '../src/services/orders.service.js';
import type { CoberturaSnapshot } from '../src/services/sales-metrics.service.js';

// ── Fixtures ────────────────────────────────────────────────────────────────
// Custos vigentes usados nos calculos esperados (custos.json v2):
//   arcos_750       12.80   -> proprio 17.29 | full 14.29
//   ouro_meu_base   13.78   -> proprio 18.27 | full 15.27
// Taxas: ML 14.8% + envio 14.4% sobre a receita de produtos.
const TAXAS = { taxaML: 0.148, taxaEnv: 0.144 };

const COBERTURA: CoberturaSnapshot = {
  oldestDate: '2026-07-01T00:00:00.000Z',
  newestDate: '2026-08-31T23:59:59.999Z',
  partial: false,
};

const PERIODO = { fromYmd: '2026-08-01', toYmd: '2026-08-31' };

function pedido(
  itens: Array<{ titulo: string; preco: number; qtd: number; sku?: string; id?: string }>,
  opcoes: { logisticType?: string | null; status?: string; data?: string } = {}
): OrderSlim {
  return {
    id: Math.random().toString(36).slice(2),
    status: opcoes.status ?? 'paid',
    date_created: opcoes.data ?? '2026-08-10T15:00:00.000Z',
    paid_amount: itens.reduce((s, i) => s + i.preco * i.qtd, 0) + 12, // +frete do comprador
    total_amount: null,
    order_items: itens.map(i => ({
      quantity: i.qtd,
      unit_price: i.preco,
      item: {
        id: i.id ?? 'MLB1',
        title: i.titulo,
        seller_sku: i.sku ?? null,
        variation_id: null,
      },
    })),
    shipping: { id: 1, logistic_type: opcoes.logisticType ?? 'drop_off' },
  };
}

const ARCOS = 'Vinho Arcos do Convento Tinto 750ml';
const OURO = 'Vinho Ouro Meu Tinto Seco 750ml';
const DESCONHECIDO = 'Vinho Fantasma da Serra Reserva';

// ══════════════════════════════════════════════════════════════════════════
describe('calcularMargem — conta basica', () => {
  it('venda propria: receita, tarifas, custo com embalagem e margem', () => {
    const r = calcularMargem([pedido([{ titulo: ARCOS, preco: 40, qtd: 2 }])], PERIODO, COBERTURA, TAXAS);
    expect(r.disponivel).toBe(true);
    const t = r.total!;
    expect(t.receitaProdutos).toBeCloseTo(80, 2);
    expect(t.tarifaML).toBeCloseTo(11.84, 2);
    expect(t.tarifaEnvio).toBeCloseTo(11.52, 2);
    expect(t.custoTotal).toBeCloseTo(34.58, 2);       // 17.29 x 2
    expect(t.margem).toBeCloseTo(22.06, 2);
    expect(t.margemPct).toBeCloseTo(0.2758, 3);
    expect(t.unidades).toBe(2);
  });

  it('venda pelo Full custa 3,00 menos por unidade e a margem sobe na mesma medida', () => {
    const base = [{ titulo: ARCOS, preco: 40, qtd: 2 }];
    const proprio = calcularMargem([pedido(base, { logisticType: 'drop_off' })], PERIODO, COBERTURA, TAXAS);
    const full = calcularMargem([pedido(base, { logisticType: 'fulfillment' })], PERIODO, COBERTURA, TAXAS);
    expect(full.total!.custoTotal).toBeCloseTo(proprio.total!.custoTotal - 6, 2);
    expect(full.total!.margem).toBeCloseTo(proprio.total!.margem + 6, 2);
  });

  it('NAO usa paid_amount: o frete cobrado do comprador fica fora da receita', () => {
    const p = pedido([{ titulo: ARCOS, preco: 40, qtd: 1 }]);
    expect(p.paid_amount).toBe(52);                    // 40 + 12 de frete
    const r = calcularMargem([p], PERIODO, COBERTURA, TAXAS);
    expect(r.total!.receitaProdutos).toBeCloseTo(40, 2);
  });

  it('margem negativa e reportada como negativa, nunca zerada', () => {
    const r = calcularMargem([pedido([{ titulo: ARCOS, preco: 15, qtd: 1 }])], PERIODO, COBERTURA, TAXAS);
    expect(r.total!.margem).toBeLessThan(0);
    expect(r.total!.margemPct).toBeLessThan(0);
  });

  it('sempre marcado como estimativa e antes de publicidade', () => {
    const r = calcularMargem([pedido([{ titulo: ARCOS, preco: 40, qtd: 1 }])], PERIODO, COBERTURA, TAXAS);
    expect(r.estimado).toBe(true);
    expect(r.antesDePublicidade).toBe(true);
    expect(r.warnings).toContain(WARN_ANTES_DE_PUBLICIDADE);
  });
});

describe('calcularMargem — filtros de pedido', () => {
  it('cancelados e pendentes ficam de fora', () => {
    const orders = [
      pedido([{ titulo: ARCOS, preco: 40, qtd: 1 }], { status: 'cancelled' }),
      pedido([{ titulo: ARCOS, preco: 40, qtd: 1 }], { status: 'payment_required' }),
    ];
    const r = calcularMargem(orders, PERIODO, COBERTURA, TAXAS);
    expect(r.total!.unidades).toBe(0);
    expect(r.total!.receitaProdutos).toBe(0);
  });

  it('pedido fora do periodo nao entra', () => {
    const r = calcularMargem(
      [pedido([{ titulo: ARCOS, preco: 40, qtd: 1 }], { data: '2026-07-10T15:00:00.000Z' })],
      PERIODO, COBERTURA, TAXAS
    );
    expect(r.total!.unidades).toBe(0);
  });

  it('todos os order_items entram, nao apenas o primeiro', () => {
    const r = calcularMargem(
      [pedido([{ titulo: ARCOS, preco: 40, qtd: 1 }, { titulo: OURO, preco: 30, qtd: 3 }])],
      PERIODO, COBERTURA, TAXAS
    );
    expect(r.total!.unidades).toBe(4);
    expect(r.total!.receitaProdutos).toBeCloseTo(130, 2);
  });
});

describe('calcularMargem — custo desconhecido', () => {
  it('item sem regra de custo NAO vira zero: sai da conta e vai para semCusto', () => {
    const r = calcularMargem(
      [pedido([{ titulo: ARCOS, preco: 40, qtd: 9 }, { titulo: DESCONHECIDO, preco: 50, qtd: 1 }])],
      PERIODO, COBERTURA, TAXAS
    );
    expect(r.disponivel).toBe(true);
    expect(r.total!.unidades).toBe(9);                  // o desconhecido nao entrou
    expect(r.total!.receitaProdutos).toBeCloseTo(360, 2);
    expect(r.semCusto.receitaProdutos).toBeCloseTo(50, 2);
    expect(r.semCusto.unidades).toBe(1);
    expect(r.semCusto.titulos).toEqual([DESCONHECIDO]);
    expect(r.warnings).toContain(WARN_CUSTO_PARCIAL);
  });

  it('custo desconhecido nunca aparece como custo 0 na margem', () => {
    const so = calcularMargem([pedido([{ titulo: DESCONHECIDO, preco: 50, qtd: 1 }])], PERIODO, COBERTURA, TAXAS);
    // 100% sem custo: acima do limite -> indisponivel, e nao margem = receita.
    expect(so.disponivel).toBe(false);
    expect(so.total).toBeNull();
    expect(so.warnings).toContain(WARN_CUSTO_INSUFICIENTE);
  });

  it(`acima de ${LIMITE_SEM_CUSTO * 100}% da receita sem custo, o resultado e declarado indisponivel`, () => {
    const r = calcularMargem(
      [pedido([{ titulo: ARCOS, preco: 70, qtd: 1 }, { titulo: DESCONHECIDO, preco: 30, qtd: 1 }])],
      PERIODO, COBERTURA, TAXAS
    );
    expect(r.semCusto.fracaoReceita).toBeCloseTo(0.3, 2);
    expect(r.disponivel).toBe(false);
    expect(r.total).toBeNull();
    // O diagnostico sobrevive: o usuario descobre QUAIS titulos cadastrar.
    expect(r.semCusto.titulos).toEqual([DESCONHECIDO]);
  });

  it('exatamente no limite ainda e considerado disponivel', () => {
    const r = calcularMargem(
      [pedido([{ titulo: ARCOS, preco: 80, qtd: 1 }, { titulo: DESCONHECIDO, preco: 20, qtd: 1 }])],
      PERIODO, COBERTURA, TAXAS
    );
    expect(r.semCusto.fracaoReceita).toBeCloseTo(LIMITE_SEM_CUSTO, 6);
    expect(r.disponivel).toBe(true);
  });
});

describe('calcularMargem — por SKU e rankings', () => {
  const orders = [
    // SKUs REAIS e coerentes com o titulo: desde a v3 do custos.json o
    // seller_sku resolve a regra de custo, entao parear '21003' (Bag in Box,
    // R$ 51,88) com um titulo de 750ml passou a ser uma fixture contraditoria.
    pedido([{ titulo: ARCOS, preco: 40, qtd: 5, sku: '21002', id: 'MLB1' }]),
    pedido([{ titulo: OURO, preco: 30, qtd: 1, sku: '21010', id: 'MLB2' }]),
  ];

  it('agrupa por SKU e ordena por margem desc', () => {
    const r = calcularMargem(orders, PERIODO, COBERTURA, TAXAS);
    expect(r.porSku.map(l => l.sku)).toEqual(['21002', '21010']);
    expect(r.porSku[0].unidades).toBe(5);
  });

  it('anuncios distintos com o MESMO SKU caem na mesma linha', () => {
    const r = calcularMargem(
      [
        pedido([{ titulo: ARCOS, preco: 40, qtd: 2, sku: '21002', id: 'MLB1' }]),
        pedido([{ titulo: ARCOS + ' Premium', preco: 45, qtd: 1, sku: '21002', id: 'MLB9' }]),
      ],
      PERIODO, COBERTURA, TAXAS
    );
    expect(r.porSku).toHaveLength(1);
    expect(r.porSku[0].unidades).toBe(3);
    expect(r.porSku[0].label).toBe(ARCOS);              // titulo mais curto
  });

  it('item sem SKU vira grupo proprio, sem colidir com outros', () => {
    const r = calcularMargem(
      [
        pedido([{ titulo: ARCOS, preco: 40, qtd: 1, id: 'MLB1' }]),
        pedido([{ titulo: OURO, preco: 30, qtd: 1, id: 'MLB2' }]),
      ],
      PERIODO, COBERTURA, TAXAS
    );
    expect(r.porSku.map(l => l.sku).sort()).toEqual(['sem-sku-MLB1', 'sem-sku-MLB2']);
  });

  it('a soma das linhas por SKU reconstitui o total', () => {
    const r = calcularMargem(orders, PERIODO, COBERTURA, TAXAS);
    const soma = r.porSku.reduce((s, l) => s + l.margem, 0);
    expect(soma).toBeCloseTo(r.total!.margem, 6);
  });

  it('melhores e piores sao pontas opostas da mesma lista', () => {
    const r = calcularMargem(orders, PERIODO, COBERTURA, TAXAS);
    expect(melhoresMargens(r, 1)[0].sku).toBe('21002');
    expect(pioresMargens(r, 1)[0].sku).toBe('21010');
    expect(melhoresMargens(r, 99)).toHaveLength(2);
    expect(melhoresMargens(r, 0)).toHaveLength(0);
  });
});

describe('calcularMargem — cobertura e bordas', () => {
  it('periodo fora da janela: indisponivel com total null, nunca zero', () => {
    const r = calcularMargem([], { fromYmd: '2020-01-01', toYmd: '2020-01-31' }, COBERTURA, TAXAS);
    expect(r.disponivel).toBe(false);
    expect(r.total).toBeNull();
    expect(r.cobertura).toBe('indisponivel');
  });

  it('periodo invalido e recusado', () => {
    const r = calcularMargem([], { fromYmd: '2026-08-31', toYmd: '2026-08-01' }, COBERTURA, TAXAS);
    expect(r.disponivel).toBe(false);
    expect(r.warnings).toContain('periodo_invalido');
  });

  it('periodo coberto sem vendas: disponivel com zeros reais e margemPct null', () => {
    const r = calcularMargem([], PERIODO, COBERTURA, TAXAS);
    expect(r.disponivel).toBe(true);
    expect(r.total!.receitaProdutos).toBe(0);
    expect(r.total!.margemPct).toBeNull();
    expect(r.porSku).toHaveLength(0);
  });

  it('quantity nula cai para 1; quantity zero permanece zero', () => {
    const comNull = calcularMargem(
      [pedido([{ titulo: ARCOS, preco: 40, qtd: null as unknown as number }])],
      PERIODO, COBERTURA, TAXAS
    );
    expect(comNull.total!.unidades).toBe(1);
    const comZero = calcularMargem(
      [pedido([{ titulo: ARCOS, preco: 40, qtd: 0 }])],
      PERIODO, COBERTURA, TAXAS
    );
    expect(comZero.total!.unidades).toBe(0);
  });

  it('shipping ausente e tratado como venda propria (lado conservador)', () => {
    const p = pedido([{ titulo: ARCOS, preco: 40, qtd: 1 }]);
    delete (p as { shipping?: unknown }).shipping;
    const semShipping = calcularMargem([p], PERIODO, COBERTURA, TAXAS);
    const proprio = calcularMargem(
      [pedido([{ titulo: ARCOS, preco: 40, qtd: 1 }], { logisticType: 'drop_off' })],
      PERIODO, COBERTURA, TAXAS
    );
    expect(semShipping.total!.custoTotal).toBeCloseTo(proprio.total!.custoTotal, 6);
  });
});