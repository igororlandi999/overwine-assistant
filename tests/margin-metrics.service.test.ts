import { describe, it, expect } from 'vitest';
import {
  calcularMargem,
  melhoresMargens,
  pioresMargens,
  LIMITE_SEM_CUSTO,
  WARN_CUSTO_PARCIAL,
  WARN_CUSTO_INSUFICIENTE,
  WARN_ANTES_DE_PUBLICIDADE,
  WARN_FRETE_ESTIMADO,
} from '../src/services/margin-metrics.service.js';
import type { OrderSlim } from '../src/services/orders.service.js';
import type { EnvioInfo } from '../src/lib/shipping-store.js';
import type { CoberturaSnapshot } from '../src/services/sales-metrics.service.js';

// ── Fixtures ────────────────────────────────────────────────────────────────
// Custos vigentes usados nos calculos esperados (custos.json v3, Patch O3:
// frete ZERADO no custos.json — ele agora vem do custo real do envio):
//   arcos_750       12.80   -> proprio 15.80 (12.80 + 3.00 embalagem) | full 12.80
//   ouro_meu_base   13.78   -> proprio 16.78                          | full 13.78
// Tarifa ML: 14.8% da receita de produtos.
// Frete: custo real do envio rateado por receita. Sem mapa de envios, cai no
// percentual taxaEnv de 14.4% e o resultado declara isso em `frete`.
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
    expect(t.custoTotal).toBeCloseTo(31.60, 2);       // 15.80 x 2 (sem frete)
    expect(t.margem).toBeCloseTo(25.04, 2);          // 80 - 11.84 - 11.52 - 31.60
    expect(t.margemPct).toBeCloseTo(0.313, 3);
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

// ══════════════════════════════════════════════════════════════════════════
// FRETE REAL POR ENVIO (Patch O3)
//
// Antes: R$ 1,49 por garrafa dentro do custo MAIS 14,4% da receita como tarifa
// de envio — o mesmo frete cobrado duas vezes, e nenhuma das duas medindo o que
// o envio custou. Agora: custo real do envio, rateado por receita.
// ══════════════════════════════════════════════════════════════════════════
describe('calcularMargem — frete real por envio', () => {
  function mapa(...pares: Array<[string, string, number | null]>) {
    return new Map<string, EnvioInfo>(
      pares.map(([id, lt, c]) => [id, { logisticType: lt, custoFrete: c }])
    );
  }

  /** Pedido com shipping.id explícito, para o mapa poder resolver. */
  function pedEnvio(
    shipId: number,
    itens: Array<{ titulo: string; preco: number; qtd: number; sku?: string; id?: string }>,
    logisticType = 'fulfillment'
  ): OrderSlim {
    const o = pedido(itens, { logisticType });
    (o as { shipping: { id: number; logistic_type: string } }).shipping = {
      id: shipId, logistic_type: logisticType,
    };
    return o;
  }

  it('usa o custo REAL do envio no lugar do percentual', () => {
    const o = pedEnvio(700, [{ titulo: ARCOS, preco: 40, qtd: 2 }]);
    const r = calcularMargem([o], PERIODO, COBERTURA, TAXAS, mapa(['700', 'fulfillment', 18.40]));
    // 14,4% de R$ 80 seriam R$ 11,52. O envio custou R$ 18,40.
    expect(r.total!.tarifaEnvio).toBeCloseTo(18.40, 10);
    expect(r.frete.real).toBeCloseTo(18.40, 10);
    expect(r.frete.estimado).toBe(0);
    expect(r.frete.fracaoReceitaReal).toBe(1);
    expect(r.warnings).not.toContain(WARN_FRETE_ESTIMADO);
  });

  it('o custo do produto NAO carrega mais frete embutido', () => {
    // Full: 12,80 de aquisicao, sem embalagem e sem os antigos R$ 1,49.
    const o = pedEnvio(700, [{ titulo: ARCOS, preco: 40, qtd: 2 }]);
    const r = calcularMargem([o], PERIODO, COBERTURA, TAXAS, mapa(['700', 'fulfillment', 18.40]));
    expect(r.total!.custoTotal).toBeCloseTo(25.60, 10);
  });

  it('pedido com dois itens: UM frete, rateado por receita', () => {
    const o = pedEnvio(700, [
      { titulo: ARCOS, preco: 80, qtd: 1, sku: '21002', id: 'MLB1' },
      { titulo: OURO, preco: 20, qtd: 1, sku: '25001', id: 'MLB2' },
    ]);
    const r = calcularMargem([o], PERIODO, COBERTURA, TAXAS, mapa(['700', 'fulfillment', 30]));
    // O frete do pedido inteiro entra UMA vez, nao uma por item.
    expect(r.total!.tarifaEnvio).toBeCloseTo(30, 10);
    const arcos = r.porSku.find(l => l.label === ARCOS)!;
    const ouro = r.porSku.find(l => l.label === OURO)!;
    expect(arcos.tarifaEnvio).toBeCloseTo(24, 10);   // 80 de 100
    expect(ouro.tarifaEnvio).toBeCloseTo(6, 10);     // 20 de 100
  });

  it('envio sem custo apurado cai no percentual e DECLARA a estimativa', () => {
    const o = pedEnvio(700, [{ titulo: ARCOS, preco: 40, qtd: 2 }]);
    const r = calcularMargem([o], PERIODO, COBERTURA, TAXAS, mapa(['700', 'fulfillment', null]));
    expect(r.total!.tarifaEnvio).toBeCloseTo(11.52, 10);   // 14,4% de 80
    expect(r.frete.real).toBe(0);
    expect(r.frete.estimado).toBeCloseTo(11.52, 10);
    expect(r.frete.fracaoReceitaReal).toBe(0);
    expect(r.warnings).toContain(WARN_FRETE_ESTIMADO);
  });

  it('sem mapa nenhum: tudo estimado, e o resultado diz isso', () => {
    const r = calcularMargem([pedido([{ titulo: ARCOS, preco: 40, qtd: 2 }])], PERIODO, COBERTURA, TAXAS);
    expect(r.frete.fracaoReceitaReal).toBe(0);
    expect(r.warnings).toContain(WARN_FRETE_ESTIMADO);
  });

  it('mistura: a fracao mede RECEITA, nao numero de envios', () => {
    const a = pedEnvio(700, [{ titulo: ARCOS, preco: 40, qtd: 2 }]);   // 80, real
    const b = pedEnvio(701, [{ titulo: OURO, preco: 20, qtd: 1 }]);    // 20, estimado
    const r = calcularMargem([a, b], PERIODO, COBERTURA, TAXAS,
      mapa(['700', 'fulfillment', 18.40], ['701', 'fulfillment', null]));
    expect(r.frete.fracaoReceitaReal).toBeCloseTo(0.8, 10);
    expect(r.frete.real).toBeCloseTo(18.40, 10);
    expect(r.frete.estimado).toBeCloseTo(2.88, 10);        // 14,4% de 20
    expect(r.total!.tarifaEnvio).toBeCloseTo(21.28, 10);
  });

  it('frete gratis apurado e ZERO, e continua sendo frete real', () => {
    const o = pedEnvio(700, [{ titulo: ARCOS, preco: 40, qtd: 2 }]);
    const r = calcularMargem([o], PERIODO, COBERTURA, TAXAS, mapa(['700', 'fulfillment', 0]));
    expect(r.total!.tarifaEnvio).toBe(0);
    expect(r.frete.fracaoReceitaReal).toBe(1);
    expect(r.warnings).not.toContain(WARN_FRETE_ESTIMADO);
  });

  it('item SEM custo de produto fica fora da cobertura de frete', () => {
    // Ele ja saiu da margem inteira; contar o frete dele distorceria a fracao.
    const o = pedEnvio(700, [
      { titulo: ARCOS, preco: 40, qtd: 1, sku: '21002', id: 'MLB1' },
      { titulo: DESCONHECIDO, preco: 10, qtd: 1, sku: 'ZZZ', id: 'MLB2' },
    ]);
    const r = calcularMargem([o], PERIODO, COBERTURA, TAXAS, mapa(['700', 'fulfillment', 25]));
    // O rateio usa a receita do envio INTEIRA (50), entao o item conhecido leva
    // 40/50 do frete. A fatia do item sem custo simplesmente nao entra.
    expect(r.total!.tarifaEnvio).toBeCloseTo(20, 10);
    expect(r.frete.real).toBeCloseTo(20, 10);
    expect(r.frete.receitaReal).toBe(40);
  });

  it('periodo indisponivel devolve cobertura de frete neutra, nunca numeros', () => {
    const r = calcularMargem([], { fromYmd: '2020-01-01', toYmd: '2020-01-31' }, COBERTURA, TAXAS);
    expect(r.disponivel).toBe(false);
    expect(r.frete).toEqual({ real: 0, estimado: 0, receitaReal: 0, receitaEstimada: 0, fracaoReceitaReal: 1 });
  });
});