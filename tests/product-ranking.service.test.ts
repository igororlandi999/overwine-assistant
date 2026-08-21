import { describe, it, expect } from 'vitest';
import {
  calcularRanking,
  normalizarLimite,
  RANKING_LIMITE_MAX,
  RANKING_LIMITE_PADRAO,
  WARN_CUSTO_PARCIAL,
  WARN_ANTES_DE_PUBLICIDADE,
  WARN_MARGEM_COBERTURA_PARCIAL,
  WARN_FRETE_ESTIMADO,
} from '../src/services/product-ranking.service.js';
import { calcularMargem } from '../src/services/margin-metrics.service.js';
import { WARN_SEM_DADOS_NO_PERIODO } from '../src/services/sales-metrics.service.js';
import type { OrderSlim } from '../src/services/orders.service.js';
import type { CoberturaSnapshot } from '../src/services/sales-metrics.service.js';
import type { EnvioInfo } from '../src/lib/shipping-store.js';

// ── Fixtures ────────────────────────────────────────────────────────────────
// Custos vigentes (custos.json v3, Patch O3: frete ZERADO no custos.json —
// ele passou a ser o custo real do envio). Embalagem 3,00, so em venda propria:
//   arcos_750       12.80  -> proprio 15.80 | full 12.80
//   ouro_meu_base   13.78  -> proprio 16.78 | full 13.78
// Tarifa ML: 14,8% da receita de produtos.
// Frete: custo real do envio rateado por receita; sem mapa de envios cai no
// percentual taxaEnv de 14,4% e o resultado declara isso em `frete`.
const TAXAS = { taxaML: 0.148, taxaEnv: 0.144 };

const COBERTURA: CoberturaSnapshot = {
  oldestDate: '2026-07-01T00:00:00.000Z',
  newestDate: '2026-08-31T23:59:59.999Z',
  partial: false,
};

const PERIODO = { fromYmd: '2026-08-01', toYmd: '2026-08-31' };

let seq = 0;
function pedido(
  itens: Array<{ titulo: string; preco: number; qtd: number; sku?: string; id?: string }>,
  opcoes: { logisticType?: string | null; status?: string; data?: string; id?: string } = {}
): OrderSlim {
  return {
    id: opcoes.id ?? `ORD${++seq}`,
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

function rank(orders: OrderSlim[], opcoes: Parameters<typeof calcularRanking>[3] = {}) {
  return calcularRanking(orders, PERIODO, COBERTURA, { taxas: TAXAS, ...opcoes });
}

// ══════════════════════════════════════════════════════════════════════════
describe('calcularRanking — ordenacao por criterio', () => {
  const base = [
    pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC' }]),                 // 40, 1un
    pedido([{ titulo: OURO, preco: 10, qtd: 9, sku: 'OUR', id: 'MLB2' }]),      // 90, 9un
  ];

  it('revenue ordena por receita de produtos desc', () => {
    const r = rank(base, { criterio: 'revenue' });
    expect(r.linhas.map(l => l.sku)).toEqual(['OUR', 'ARC']);
    expect(r.linhas[0].posicao).toBe(1);
    expect(r.linhas[0].receitaProdutos).toBe(90);
    expect(r.linhas[1].receitaProdutos).toBe(40);
  });

  it('units ordena por unidades desc (ordem diferente de revenue)', () => {
    const r = rank(base, { criterio: 'units' });
    expect(r.linhas.map(l => l.sku)).toEqual(['OUR', 'ARC']);
    expect(r.linhas[0].unidades).toBe(9);
  });

  it('units e revenue podem divergir', () => {
    const orders = [
      pedido([{ titulo: ARCOS, preco: 100, qtd: 1, sku: 'ARC' }]),              // 100, 1un
      pedido([{ titulo: OURO, preco: 10, qtd: 5, sku: 'OUR', id: 'MLB2' }]),    // 50, 5un
    ];
    expect(rank(orders, { criterio: 'revenue' }).linhas.map(l => l.sku)).toEqual(['ARC', 'OUR']);
    expect(rank(orders, { criterio: 'units' }).linhas.map(l => l.sku)).toEqual(['OUR', 'ARC']);
  });

  it('empate exato desempata por sku asc (deterministico)', () => {
    const orders = [
      pedido([{ titulo: OURO, preco: 50, qtd: 1, sku: 'ZZZ', id: 'MLB9' }]),
      pedido([{ titulo: OURO, preco: 50, qtd: 1, sku: 'AAA', id: 'MLB8' }]),
    ];
    expect(rank(orders, { criterio: 'revenue' }).linhas.map(l => l.sku)).toEqual(['AAA', 'ZZZ']);
    // Ordem de entrada invertida NAO muda o resultado.
    expect(rank([...orders].reverse(), { criterio: 'revenue' }).linhas.map(l => l.sku))
      .toEqual(['AAA', 'ZZZ']);
  });

  it('posicao e 1-based e continua na ordem do criterio', () => {
    const r = rank(base, { criterio: 'revenue' });
    expect(r.linhas.map(l => l.posicao)).toEqual([1, 2]);
  });
});

describe('calcularRanking — agrupamento por SKU', () => {
  it('classico e premium do MESMO sku viram UMA linha', () => {
    const r = rank([
      pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC', id: 'MLB1' }]),
      pedido([{ titulo: ARCOS + ' Premium', preco: 45, qtd: 1, sku: 'ARC', id: 'MLB2' }]),
    ]);
    expect(r.linhas.length).toBe(1);
    expect(r.linhas[0].receitaProdutos).toBe(85);
    expect(r.linhas[0].unidades).toBe(2);
    expect(r.linhas[0].itemIds).toEqual(['MLB1', 'MLB2']);
    // Label: o titulo de MAIOR receita do grupo (45 > 40), nao o mais curto.
    expect(r.linhas[0].label).toBe(ARCOS + ' Premium');
  });

  it('sem sku vira grupo proprio sem-sku-<itemId> com semSku true', () => {
    const r = rank([pedido([{ titulo: ARCOS, preco: 40, qtd: 1, id: 'MLB7' }])]);
    expect(r.linhas[0].sku).toBe('sem-sku-MLB7');
    expect(r.linhas[0].semSku).toBe(true);
  });

  it('anuncios sem sku e com ids diferentes NAO se fundem', () => {
    const r = rank([
      pedido([{ titulo: ARCOS, preco: 40, qtd: 1, id: 'MLB1' }]),
      pedido([{ titulo: ARCOS, preco: 40, qtd: 1, id: 'MLB2' }]),
    ]);
    expect(r.linhas.length).toBe(2);
  });
});

describe('calcularRanking — filtros de pedido', () => {
  it('somente status paid entra', () => {
    const r = rank([
      pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC' }]),
      pedido([{ titulo: ARCOS, preco: 999, qtd: 5, sku: 'ARC' }], { status: 'cancelled' }),
      pedido([{ titulo: ARCOS, preco: 999, qtd: 5, sku: 'ARC' }], { status: 'payment_required' }),
    ]);
    expect(r.linhas.length).toBe(1);
    expect(r.linhas[0].receitaProdutos).toBe(40);
    expect(r.linhas[0].unidades).toBe(1);
  });

  it('pedido fora do periodo nao entra', () => {
    const r = rank([
      pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC' }]),
      pedido([{ titulo: ARCOS, preco: 999, qtd: 1, sku: 'ARC' }], { data: '2026-07-15T12:00:00.000Z' }),
    ]);
    expect(r.linhas[0].receitaProdutos).toBe(40);
  });
});

describe('calcularRanking — multi-item e quantidades', () => {
  it('conta TODOS os order_items, nao apenas o primeiro', () => {
    // A producao atual nao tem pedidos multi-item; o caso e sintetico de
    // proposito, porque e exatamente o que quebraria em silencio.
    const r = rank([
      pedido([
        { titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC', id: 'MLB1' },
        { titulo: OURO, preco: 30, qtd: 2, sku: 'OUR', id: 'MLB2' },
      ]),
    ], { criterio: 'revenue' });
    expect(r.linhas.map(l => [l.sku, l.receitaProdutos])).toEqual([['OUR', 60], ['ARC', 40]]);
    expect(r.totais.unidades).toBe(3);
  });

  it('quantity 0 permanece 0 (fallback ?? 1 so cobre null/undefined)', () => {
    const r = rank([pedido([{ titulo: ARCOS, preco: 40, qtd: 0, sku: 'ARC' }])]);
    expect(r.linhas[0].unidades).toBe(0);
    expect(r.linhas[0].receitaProdutos).toBe(0);
  });

  it('quantity null cai para 1', () => {
    const o = pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC' }]);
    o.order_items[0].quantity = null;
    expect(rank([o]).linhas[0].unidades).toBe(1);
  });

  it('pedidos conta pedidos DISTINTOS (mesmo sku 2x no pedido = 1)', () => {
    const r = rank([
      pedido([
        { titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC', id: 'MLB1' },
        { titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC', id: 'MLB1' },
      ], { id: 'P1' }),
      pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC', id: 'MLB1' }], { id: 'P2' }),
    ]);
    expect(r.linhas[0].pedidos).toBe(2);
    expect(r.linhas[0].unidades).toBe(3);
  });
});

describe('calcularRanking — custo desconhecido NUNCA vira zero', () => {
  it('produto sem custo APARECE no ranking de receita, com margem null', () => {
    const r = rank([
      pedido([{ titulo: DESCONHECIDO, preco: 200, qtd: 1, sku: 'FAN', id: 'MLB9' }]),
      pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC' }]),
    ], { criterio: 'revenue' });
    expect(r.linhas.map(l => l.sku)).toEqual(['FAN', 'ARC']);
    const fantasma = r.linhas[0];
    expect(fantasma.custoCobertura).toBe('ausente');
    expect(fantasma.custoTotal).toBeNull();
    expect(fantasma.margem).toBeNull();
    expect(fantasma.margemPct).toBeNull();
    expect(fantasma.tarifaML).toBeNull();
    // A receita e as unidades continuam reais.
    expect(fantasma.receitaProdutos).toBe(200);
    expect(fantasma.unidades).toBe(1);
  });

  it('produto sem custo aparece tambem no ranking de quantidade', () => {
    const r = rank([
      pedido([{ titulo: DESCONHECIDO, preco: 10, qtd: 50, sku: 'FAN', id: 'MLB9' }]),
      pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC' }]),
    ], { criterio: 'units' });
    expect(r.linhas[0].sku).toBe('FAN');
    expect(r.linhas[0].unidades).toBe(50);
  });

  it('semCusto declara skus, receita, unidades, fracao e titulos', () => {
    const r = rank([
      pedido([{ titulo: DESCONHECIDO, preco: 60, qtd: 1, sku: 'FAN', id: 'MLB9' }]),
      pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC' }]),
    ]);
    expect(r.semCusto.skus).toBe(1);
    expect(r.semCusto.receitaProdutos).toBe(60);
    expect(r.semCusto.unidades).toBe(1);
    expect(r.semCusto.fracaoReceita).toBeCloseTo(60 / 100, 10);
    expect(r.semCusto.titulos).toEqual([DESCONHECIDO]);
    expect(r.warnings).toContain(WARN_CUSTO_PARCIAL);
  });

  it('LIMITE_SEM_CUSTO NAO derruba o ranking (contraste com calcularMargem)', () => {
    // 100% da receita sem custo: calcularMargem fica indisponivel; o ranking de
    // receita continua valido, porque nao depende de custo algum.
    const orders = [pedido([{ titulo: DESCONHECIDO, preco: 500, qtd: 1, sku: 'FAN', id: 'MLB9' }])];
    expect(calcularMargem(orders, PERIODO, COBERTURA, TAXAS).disponivel).toBe(false);
    const r = rank(orders, { criterio: 'revenue' });
    expect(r.disponivel).toBe(true);
    expect(r.linhas[0].receitaProdutos).toBe(500);
  });

  it('linha com custo PARCIAL calcula margem so sobre a parcela conhecida', () => {
    // Mesmo SKU agrupando um titulo com custo e outro sem.
    const r = rank([
      pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'MIX', id: 'MLB1' }]),
      pedido([{ titulo: DESCONHECIDO, preco: 60, qtd: 1, sku: 'MIX', id: 'MLB2' }]),
    ]);
    const l = r.linhas[0];
    expect(l.custoCobertura).toBe('parcial');
    expect(l.receitaProdutos).toBe(100);   // total real
    expect(l.receitaComCusto).toBe(40);    // base da margem
    expect(l.unidadesComCusto).toBe(1);
    expect(l.custoTotal).toBeCloseTo(15.80, 10);
    // margemPct usa receitaComCusto, nao receitaProdutos.
    expect(l.margemPct).toBeCloseTo((l.margem as number) / 40, 10);
  });
});

describe('calcularRanking — ranking por margem', () => {
  it('ordena por margem absoluta desc', () => {
    const r = rank([
      pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC', id: 'MLB1' }]),
      pedido([{ titulo: OURO, preco: 100, qtd: 1, sku: 'OUR', id: 'MLB2' }]),
    ], { criterio: 'margin' });
    expect(r.linhas.map(l => l.sku)).toEqual(['OUR', 'ARC']);
    expect(r.linhas[0].margem).toBeGreaterThan(r.linhas[1].margem as number);
  });

  it('conta de margem confere: receita - tarifas - custo (venda propria)', () => {
    const r = rank([pedido([{ titulo: ARCOS, preco: 40, qtd: 2, sku: 'ARC' }])], { criterio: 'margin' });
    const l = r.linhas[0];
    expect(l.receitaComCusto).toBe(80);
    expect(l.tarifaML).toBeCloseTo(80 * 0.148, 10);
    expect(l.tarifaEnvio).toBeCloseTo(80 * 0.144, 10);
    expect(l.custoTotal).toBeCloseTo(15.80 * 2, 10);   // 12.80 + 3.00
    expect(l.margem).toBeCloseTo(80 - 80 * 0.148 - 80 * 0.144 - 31.60, 10);
  });

  it('venda Full nao soma embalagem', () => {
    const r = rank(
      [pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC' }], { logisticType: 'fulfillment' })],
      { criterio: 'margin' }
    );
    expect(r.linhas[0].custoTotal).toBeCloseTo(12.80, 10); // so o produto
  });

  it('margem negativa e resultado legitimo e ordena por ultimo', () => {
    const r = rank([
      pedido([{ titulo: ARCOS, preco: 15, qtd: 1, sku: 'ARC', id: 'MLB1' }]),  // prejuizo
      pedido([{ titulo: OURO, preco: 100, qtd: 1, sku: 'OUR', id: 'MLB2' }]),
    ], { criterio: 'margin' });
    expect(r.linhas[1].sku).toBe('ARC');
    expect(r.linhas[1].margem).toBeLessThan(0);
  });

  it('EXCLUI do ranking de margem as linhas sem custo integral, e declara', () => {
    const r = rank([
      pedido([{ titulo: DESCONHECIDO, preco: 500, qtd: 1, sku: 'FAN', id: 'MLB9' }]),
      pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC', id: 'MLB1' }]),
    ], { criterio: 'margin' });
    expect(r.linhas.map(l => l.sku)).toEqual(['ARC']);
    expect(r.margemCobertura).not.toBeNull();
    expect(r.margemCobertura!.skusExcluidos).toBe(1);
    expect(r.margemCobertura!.fracaoReceitaComCusto).toBeCloseTo(40 / 540, 10);
    expect(r.warnings).toContain(WARN_MARGEM_COBERTURA_PARCIAL);
  });

  it('margemCobertura e null quando o criterio nao e margin', () => {
    const r = rank([pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC' }])], { criterio: 'revenue' });
    expect(r.margemCobertura).toBeNull();
  });
});

describe('calcularRanking — limite', () => {
  const muitos = Array.from({ length: 8 }, (_, i) =>
    pedido([{ titulo: ARCOS, preco: 10 * (i + 1), qtd: 1, sku: `S${i}`, id: `MLB${i}` }]));

  it('limite padrao e 5', () => {
    expect(rank(muitos).linhas.length).toBe(RANKING_LIMITE_PADRAO);
    expect(rank(muitos).limite).toBe(RANKING_LIMITE_PADRAO);
  });

  it('limite explicito corta na quantidade pedida', () => {
    expect(rank(muitos, { limite: 3 }).linhas.length).toBe(3);
  });

  it('limite maior que o numero de skus devolve todos', () => {
    expect(rank(muitos, { limite: 50 }).linhas.length).toBe(8);
  });

  it('normalizarLimite clampa nas bordas', () => {
    expect(normalizarLimite(0)).toBe(1);
    expect(normalizarLimite(-3)).toBe(1);
    expect(normalizarLimite(999)).toBe(RANKING_LIMITE_MAX);
    expect(normalizarLimite(undefined)).toBe(RANKING_LIMITE_PADRAO);
    expect(normalizarLimite(NaN)).toBe(RANKING_LIMITE_PADRAO);
    expect(normalizarLimite(3.7)).toBe(3);
  });

  it('totais refletem TODOS os skus, nao apenas o top N', () => {
    const r = rank(muitos, { limite: 2 });
    expect(r.linhas.length).toBe(2);
    expect(r.totais.skusDistintos).toBe(8);
    expect(r.totais.receitaProdutos).toBe(10 + 20 + 30 + 40 + 50 + 60 + 70 + 80);
  });
});

describe('calcularRanking — cobertura', () => {
  it('periodo fora da janela: disponivel false, linhas vazias, nunca zeros', () => {
    const r = calcularRanking(
      [pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC' }])],
      { fromYmd: '2025-01-01', toYmd: '2025-01-31' },
      COBERTURA,
      { taxas: TAXAS }
    );
    expect(r.disponivel).toBe(false);
    expect(r.linhas).toEqual([]);
    expect(r.cobertura).toBe('indisponivel');
    expect(r.margemCobertura).toBeNull();
  });

  it('periodo invalido e recusado', () => {
    const r = calcularRanking([], { fromYmd: '2026-08-31', toYmd: '2026-08-01' }, COBERTURA);
    expect(r.disponivel).toBe(false);
    expect(r.warnings).toContain('periodo_invalido');
  });

  it('periodo coberto mas sem vendas: disponivel true com aviso (zero real)', () => {
    const r = rank([]);
    expect(r.disponivel).toBe(true);
    expect(r.linhas).toEqual([]);
    expect(r.warnings).toContain(WARN_SEM_DADOS_NO_PERIODO);
  });

  it('cobertura parcial recorta o periodo e propaga o aviso', () => {
    const r = calcularRanking(
      [pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC' }])],
      { fromYmd: '2026-06-01', toYmd: '2026-08-31' },
      COBERTURA,
      { taxas: TAXAS }
    );
    expect(r.cobertura).toBe('parcial');
    // oldestDate e um TIMESTAMP UTC: 2026-07-01T00:00Z e 30/06 21:00 em BRT,
    // entao o dia civil do primeiro pedido e 30/06. O recorte segue o dia BRT,
    // nao a data lida do ISO — mesma regra ja documentada em sales-metrics.
    expect(r.periodoCalculado).toEqual({ fromYmd: '2026-06-30', toYmd: '2026-08-31' });
    expect(r.linhas.length).toBe(1);
  });

  it('marcadores estimado / antesDePublicidade sempre presentes', () => {
    const r = rank([pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC' }])]);
    expect(r.estimado).toBe(true);
    expect(r.antesDePublicidade).toBe(true);
    expect(r.warnings).toContain(WARN_ANTES_DE_PUBLICIDADE);
  });
});

describe('calcularRanking — consistencia com calcularMargem', () => {
  it('soma das margens das linhas com custo TOTAL bate com calcularMargem', () => {
    // Guarda contra deriva entre as duas acumulacoes independentes: se as
    // formulas divergirem no futuro, este teste quebra.
    const orders = [
      pedido([{ titulo: ARCOS, preco: 40, qtd: 2, sku: 'ARC', id: 'MLB1' }]),
      pedido([{ titulo: OURO, preco: 33.5, qtd: 3, sku: 'OUR', id: 'MLB2' }], { logisticType: 'fulfillment' }),
      pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC', id: 'MLB1' }], { logisticType: 'fulfillment' }),
    ];
    const r = rank(orders, { criterio: 'margin', limite: RANKING_LIMITE_MAX });
    const m = calcularMargem(orders, PERIODO, COBERTURA, TAXAS);

    expect(m.disponivel).toBe(true);
    const somaRanking = r.linhas
      .filter(l => l.custoCobertura === 'total')
      .reduce((s, l) => s + (l.margem as number), 0);
    expect(somaRanking).toBeCloseTo(m.total!.margem, 8);

    const somaReceita = r.linhas.reduce((s, l) => s + l.receitaComCusto, 0);
    expect(somaReceita).toBeCloseTo(m.total!.receitaProdutos, 8);

    const somaCusto = r.linhas.reduce((s, l) => s + (l.custoTotal ?? 0), 0);
    expect(somaCusto).toBeCloseTo(m.total!.custoTotal, 8);
  });

  it('a mesma linha tem a mesma margem nos dois servicos', () => {
    const orders = [pedido([{ titulo: ARCOS, preco: 40, qtd: 2, sku: 'ARC' }])];
    const r = rank(orders, { criterio: 'margin' });
    const m = calcularMargem(orders, PERIODO, COBERTURA, TAXAS);
    expect(r.linhas[0].margem).toBeCloseTo(m.porSku[0].margem, 10);
    expect(r.linhas[0].margemPct).toBeCloseTo(m.porSku[0].margemPct as number, 10);
  });

  it('receita do ranking e MENOR que o faturamento (frete do comprador fora)', () => {
    // Consequencia documentada da convencao 2. paid_amount inclui +12 de frete.
    const orders = [pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC' }])];
    const r = rank(orders);
    expect(r.totais.receitaProdutos).toBe(40);
    expect(orders[0].paid_amount).toBe(52);
  });
});

describe('calcularRanking — pureza', () => {
  it('nao muta o array de pedidos nem os pedidos', () => {
    const orders = [pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC' }])];
    const antes = JSON.stringify(orders);
    rank(orders, { criterio: 'margin' });
    rank(orders, { criterio: 'units' });
    expect(JSON.stringify(orders)).toBe(antes);
  });

  it('mesma entrada, mesma saida', () => {
    const orders = [
      pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC', id: 'MLB1' }], { id: 'A' }),
      pedido([{ titulo: OURO, preco: 40, qtd: 1, sku: 'OUR', id: 'MLB2' }], { id: 'B' }),
    ];
    expect(JSON.stringify(rank(orders))).toBe(JSON.stringify(rank(orders)));
  });

  it('pedido nulo no array nao derruba o calculo', () => {
    const orders = [
      null as unknown as OrderSlim,
      pedido([{ titulo: ARCOS, preco: 40, qtd: 1, sku: 'ARC' }]),
    ];
    expect(rank(orders).linhas.length).toBe(1);
  });
});

describe('calcularRanking — kits', () => {
  const KIT6 = 'Kit Com 6 Un Vinho Ouro Meu Tinto Seco 750ml';

  it('kit de 6 e custeado com SEIS garrafas, nao uma', () => {
    // 13.78 x 6 + 3.00 = 85.68 por kit vendido; 2 kits = 171.36
    const r = rank([pedido([{ titulo: KIT6, preco: 240, qtd: 2, sku: 'K6' }])], { criterio: 'margin' });
    expect(r.linhas[0].custoTotal).toBeCloseTo(171.36, 2);
  });

  it('REGRESSAO: a margem do kit nao e mais inflada', () => {
    // Antes desta correcao o kit custava uma garrafa por venda (16.78), e a
    // margem saia ~R$ 138 maior a cada dois kits.
    const kit = rank([pedido([{ titulo: KIT6, preco: 240, qtd: 2, sku: 'K6' }])], { criterio: 'margin' });
    const comoUmaGarrafa = 16.78 * 2;
    expect(kit.linhas[0].custoTotal).toBeGreaterThan(comoUmaGarrafa * 5);
  });

  it('embalagem entra UMA vez por kit, nao por garrafa', () => {
    const proprio = rank([pedido([{ titulo: KIT6, preco: 240, qtd: 1, sku: 'K6' }])], { criterio: 'margin' });
    const full = rank(
      [pedido([{ titulo: KIT6, preco: 240, qtd: 1, sku: 'K6' }], { logisticType: 'fulfillment' })],
      { criterio: 'margin' }
    );
    // A diferenca entre proprio e Full e exatamente UMA embalagem (3.00).
    expect((proprio.linhas[0].custoTotal as number) - (full.linhas[0].custoTotal as number))
      .toBeCloseTo(3.00, 2);
  });

  it('Bag In Box NAO e tratado como kit', () => {
    // 51.88 + 1.49 + 3.00 = 56.37 — uma unidade, nao cinco.
    const r = rank([pedido([
      { titulo: 'Vinho Tinto Arcos do Convento Bag In Box 5 Litros', preco: 140, qtd: 1, sku: 'BIB' },
    ])], { criterio: 'margin' });
    expect(r.linhas[0].custoTotal).toBeCloseTo(54.88, 2);  // 51.88 + 3.00
  });

  it('unidades continuam contando VENDAS, nao garrafas', () => {
    // Decisao explicita: 2 kits sao 2 unidades vendidas. Contar 12 garrafas
    // misturaria as bases e quebraria a comparacao com o ticket medio.
    const r = rank([pedido([{ titulo: KIT6, preco: 240, qtd: 2, sku: 'K6' }])]);
    expect(r.linhas[0].unidades).toBe(2);
  });
});

describe('calcularRanking — label representativo', () => {
  it('REGRESSAO: codigo interno de anuncio secundario nao vira o nome', () => {
    // Caso real observado em producao no SKU 25101: o anuncio principal fatura
    // ~46 mil e a variante "...3571" fatura ~388, mas o titulo dela e um
    // caractere mais curto e virava o nome exibido no ranking.
    const principal = 'Vinho Tinto Seco Portugues Ouro Meu Exclusive Edition 750ml';
    const variante  = 'Vinho Tinto Seco Portugues Ouro Meu Exclusive Edition 3571';
    expect(variante.length).toBeLessThan(principal.length);   // a armadilha
    const r = rank([
      pedido([{ titulo: principal, preco: 46000, qtd: 1, sku: '25101', id: 'MLB1' }]),
      pedido([{ titulo: variante,  preco: 388,   qtd: 1, sku: '25101', id: 'MLB2' }]),
    ]);
    expect(r.linhas[0].label).toBe(principal);
  });

  it('soma a receita do MESMO titulo em anuncios diferentes', () => {
    const a = 'Vinho Curto';
    const b = 'Vinho Com Nome Bem Mais Longo';
    const r = rank([
      pedido([{ titulo: b, preco: 30, qtd: 1, sku: 'S', id: 'MLB1' }]),
      pedido([{ titulo: b, preco: 30, qtd: 1, sku: 'S', id: 'MLB2' }]),  // b = 60
      pedido([{ titulo: a, preco: 50, qtd: 1, sku: 'S', id: 'MLB3' }]),  // a = 50
    ]);
    expect(r.linhas[0].label).toBe(b);
  });

  it('empate de receita resolve pelo mais curto, e nao depende da ordem', () => {
    const curto = 'Vinho A';
    const longo = 'Vinho A Reserva Especial';
    const orders = [
      pedido([{ titulo: longo, preco: 40, qtd: 1, sku: 'S', id: 'MLB1' }]),
      pedido([{ titulo: curto, preco: 40, qtd: 1, sku: 'S', id: 'MLB2' }]),
    ];
    expect(rank(orders).linhas[0].label).toBe(curto);
    expect(rank([...orders].reverse()).linhas[0].label).toBe(curto);
  });

  it('titulo vazio nao vira label quando ha alternativa', () => {
    const r = rank([
      pedido([{ titulo: '', preco: 100, qtd: 1, sku: 'S', id: 'MLB1' }]),
      pedido([{ titulo: 'Vinho Real', preco: 10, qtd: 1, sku: 'S', id: 'MLB2' }]),
    ]);
    expect(r.linhas[0].label).toBe('Vinho Real');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// FRETE REAL POR ENVIO (Patch O3) — convencao 10
// ══════════════════════════════════════════════════════════════════════════
describe('calcularRanking — frete real por envio', () => {
  function mapa(...pares: Array<[string, string, number | null]>) {
    return new Map<string, EnvioInfo>(
      pares.map(([id, lt, c]) => [id, { logisticType: lt, custoFrete: c }])
    );
  }

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

  it('tarifaEnvio da linha e o frete REAL, nao 14,4% da receita', () => {
    const r = rank([pedEnvio(700, [{ titulo: ARCOS, preco: 40, qtd: 2, sku: '21002' }])], {
      criterio: 'margin',
      mapaLogistica: mapa(['700', 'fulfillment', 18.40]),
    });
    expect(r.linhas[0].tarifaEnvio).toBeCloseTo(18.40, 10);   // seriam 11,52
    expect(r.frete.fracaoReceitaReal).toBe(1);
    expect(r.warnings).not.toContain(WARN_FRETE_ESTIMADO);
  });

  it('a margem da linha usa o frete real', () => {
    const r = rank([pedEnvio(700, [{ titulo: ARCOS, preco: 40, qtd: 2, sku: '21002' }])], {
      criterio: 'margin',
      mapaLogistica: mapa(['700', 'fulfillment', 18.40]),
    });
    const l = r.linhas[0];
    // 80 - 11,84 (ML) - 18,40 (frete real) - 25,60 (12,80 x 2, Full sem embalagem)
    expect(l.margem).toBeCloseTo(24.16, 10);
    expect(l.margem).toBeCloseTo(l.receitaComCusto - l.tarifaML! - l.tarifaEnvio! - l.custoTotal!, 10);
  });

  it('pedido com dois produtos: o frete e rateado, nao duplicado', () => {
    const r = rank([pedEnvio(700, [
      { titulo: ARCOS, preco: 80, qtd: 1, sku: '21002', id: 'MLB1' },
      { titulo: OURO, preco: 20, qtd: 1, sku: '25001', id: 'MLB2' },
    ])], { criterio: 'margin', mapaLogistica: mapa(['700', 'fulfillment', 30]) });
    const soma = r.linhas.reduce((s, l) => s + (l.tarifaEnvio ?? 0), 0);
    expect(soma).toBeCloseTo(30, 10);
    expect(r.linhas.find(l => l.sku === '21002')!.tarifaEnvio).toBeCloseTo(24, 10);
    expect(r.linhas.find(l => l.sku === '25001')!.tarifaEnvio).toBeCloseTo(6, 10);
  });

  it('envio sem custo apurado cai no percentual e o resultado DECLARA', () => {
    const r = rank([pedEnvio(700, [{ titulo: ARCOS, preco: 40, qtd: 2, sku: '21002' }])], {
      criterio: 'margin',
      mapaLogistica: mapa(['700', 'fulfillment', null]),
    });
    expect(r.linhas[0].tarifaEnvio).toBeCloseTo(11.52, 10);
    expect(r.frete.estimado).toBeCloseTo(11.52, 10);
    expect(r.frete.fracaoReceitaReal).toBe(0);
    expect(r.warnings).toContain(WARN_FRETE_ESTIMADO);
  });

  it('o frete real REORDENA o ranking por margem', () => {
    // Este e o motivo de o Patch O3 existir. O percentual cobra proporcional ao
    // preco; o frete real depende de peso e distancia. Os dois valores de frete
    // sao de envios reais medidos em 19/08/2026 (R$ 2,50 e R$ 16,65).
    const envioBarato = pedEnvio(700, [{ titulo: ARCOS, preco: 100, qtd: 1, sku: 'FRETE-BARATO', id: 'MLB1' }]);
    const envioCaro = pedEnvio(701, [{ titulo: OURO, preco: 104, qtd: 1, sku: 'FRETE-CARO', id: 'MLB2' }]);
    const comReal = rank([envioBarato, envioCaro], {
      criterio: 'margin',
      mapaLogistica: mapa(['700', 'fulfillment', 2.50], ['701', 'fulfillment', 16.65]),
    });
    const comPercentual = rank([envioBarato, envioCaro], { criterio: 'margin' });
    // Com o frete de verdade, quem manda menos peso lucra mais. Com o
    // percentual, quem fatura mais aparecia na frente — classificacao falsa.
    expect(comReal.linhas[0].sku).toBe('FRETE-BARATO');
    expect(comPercentual.linhas[0].sku).toBe('FRETE-CARO');
  });

  it('linha sem custo nenhum nao ganha frete: tarifaEnvio continua null', () => {
    const r = rank([pedEnvio(700, [{ titulo: DESCONHECIDO, preco: 40, qtd: 1, sku: 'ZZZ' }])], {
      criterio: 'revenue',
      mapaLogistica: mapa(['700', 'fulfillment', 18.40]),
    });
    expect(r.linhas[0].custoCobertura).toBe('ausente');
    expect(r.linhas[0].tarifaEnvio).toBeNull();
    expect(r.frete.real).toBe(0);
  });

  it('ranking indisponivel devolve cobertura de frete neutra', () => {
    const r = calcularRanking([], { fromYmd: '2020-01-01', toYmd: '2020-01-31' }, COBERTURA, { taxas: TAXAS });
    expect(r.disponivel).toBe(false);
    expect(r.frete).toEqual({ real: 0, estimado: 0, receitaReal: 0, receitaEstimada: 0, fracaoReceitaReal: 1 });
  });

  it('ranking e margem concordam no frete do mesmo periodo', () => {
    // Duas contas de frete no mesmo sistema divergindo seria repetir o erro de
    // `!== cancelled` vs `=== paid`.
    const pedidos = [
      pedEnvio(700, [{ titulo: ARCOS, preco: 80, qtd: 1, sku: '21002', id: 'MLB1' }]),
      pedEnvio(701, [{ titulo: OURO, preco: 20, qtd: 2, sku: '25001', id: 'MLB2' }], 'drop_off'),
    ];
    const m = mapa(['700', 'fulfillment', 12], ['701', 'drop_off', null]);
    const rk = rank(pedidos, { criterio: 'margin', mapaLogistica: m, todos: true });
    const mg = calcularMargem(pedidos, PERIODO, COBERTURA, TAXAS, m);
    expect(rk.frete.real).toBeCloseTo(mg.frete.real, 10);
    expect(rk.frete.estimado).toBeCloseTo(mg.frete.estimado, 10);
    expect(rk.frete.fracaoReceitaReal).toBeCloseTo(mg.frete.fracaoReceitaReal, 10);
  });
});