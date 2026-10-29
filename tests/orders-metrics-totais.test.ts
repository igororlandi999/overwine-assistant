/**
 * FASE A2b — `periodo.pedidos` e `periodo.unidades` em GET /api/orders/metrics.
 *
 * O que este arquivo trava:
 *  - os dois campos sao os TOTAIS oficiais do periodo selecionado, sobre a
 *    mesma populacao de `periodo.faturamento`: contaComoVenda (lib/status-venda)
 *    na mesma janela BRT [from 00:00, to 23:59:59.999];
 *  - pedido conta UMA vez; unidades somam TODOS os order_items com a convencao
 *    do sales-metrics (`quantity ?? 1`; 0 permanece 0);
 *  - pedido valido sem item.id continua contando como pedido — e por isso
 *    `periodo.porItem` (vendasPorItem, so order_items[0]) NAO substitui os
 *    novos campos;
 *  - a mudanca e ADITIVA: porItem, faturamento, janelas e demais blocos ficam
 *    byte a byte como as funcoes de sempre os produzem;
 *  - multi-conta (metricsDaSelecao): conta isolada, consolidado e Amazon saem
 *    da uniao dos pedidos, nunca da soma de agregados prontos.
 */
import { describe, it, expect } from 'vitest';
import {
  montarMetrics, type StatusSnapshot,
} from '../src/services/orders-metrics.service.js';
import {
  faturamentoPeriodo, vendasPorItem, faturamentoMensal, unidadesPorItem, type OrderSlim,
} from '../src/services/orders.service.js';
import { calcularConsulta, calcularMetricas } from '../src/services/sales-metrics.service.js';
import { metricsDaSelecao, marcar, type BaseLida } from '../src/services/orders-consolidado.service.js';
import { contaPorId, type Conta } from '../src/config/contas.js';
import { brtStartOfDay, brtEndOfDay } from '../src/lib/datas-brt.js';

// Relógio fixo: 24/07/2026 15:00 BRT.
const AGORA = new Date('2026-07-24T18:00:00.000Z');
const PERIODO = { fromYmd: '2026-07-01', toYmd: '2026-07-24' };
const emBRT = (ymd: string, hora = '12:00:00.000') => `${ymd}T${hora}-03:00`;

type Item = { id: string | null; qtd?: number | null; preco?: number };
function ped(id: number | string, quando: string, status: string, paid: number, itens: Item[]): OrderSlim {
  return {
    id, status, date_created: quando, paid_amount: paid, total_amount: paid,
    order_items: itens.map(i => ({
      quantity: i.qtd === undefined ? 1 : i.qtd,
      unit_price: i.preco ?? 10,
      item: { id: i.id, title: 'Vinho', seller_sku: i.id ? 'SKU-' + i.id : null, variation_id: null },
    })),
  };
}

// ── Fixture: um caso por linha, todos dentro de julho/2026 salvo indicado ──
const P = {
  mlPaid:        ped(1, emBRT('2026-07-10'), 'paid', 100, [{ id: 'MLB1', qtd: 1 }]),
  mlParcial:     ped(2, emBRT('2026-07-10'), 'partially_refunded', 30.51, [{ id: 'MLB1', qtd: 1 }]),
  mlPending:     ped(3, emBRT('2026-07-10'), 'pending', 0, [{ id: 'MLB1', qtd: 4 }]),
  mlCancelado:   ped(4, emBRT('2026-07-10'), 'cancelled', 0, [{ id: 'MLB1', qtd: 5 }]),
  amzPending:    ped('AMZ-1', '2026-07-11T15:00:00.000Z', 'amazon:pending', 60, [{ id: 'B0X', qtd: 1 }]),
  amzEnviado:    ped('AMZ-2', '2026-07-11T15:00:00.000Z', 'amazon:shipped', 120, [{ id: 'B0X', qtd: 2 }]),
  amzCancelado:  ped('AMZ-3', '2026-07-11T15:00:00.000Z', 'amazon:cancelled', 0, [{ id: 'B0X', qtd: 3 }]),
  multiItem:     ped(5, emBRT('2026-07-12'), 'paid', 250, [{ id: 'MLB1', qtd: 1 }, { id: 'MLB2', qtd: 3 }]),
  semItemId:     ped(6, emBRT('2026-07-13'), 'paid', 40, [{ id: null, qtd: 2 }]),
  qtdAusente:    ped(7, emBRT('2026-07-14'), 'paid', 10, [{ id: 'MLB3', qtd: null }]),
  qtdZero:       ped(8, emBRT('2026-07-14'), 'paid', 10, [{ id: 'MLB3', qtd: 0 }]),
  foraAntes:     ped(9, emBRT('2026-06-30', '23:59:59.999'), 'paid', 999, [{ id: 'MLB1', qtd: 9 }]),
  bordaInicio:   ped(10, emBRT('2026-07-01', '00:00:00.000'), 'paid', 11, [{ id: 'MLB1', qtd: 1 }]),
  bordaFim:      ped(11, emBRT('2026-07-24', '23:59:59.999'), 'paid', 12, [{ id: 'MLB1', qtd: 1 }]),
  foraDepois:    ped(12, emBRT('2026-07-25', '00:00:00.000'), 'paid', 999, [{ id: 'MLB1', qtd: 9 }]),
};
const TODOS = Object.values(P);

const STATUS: StatusSnapshot = {
  versao: 1, totalRegistros: TODOS.length,
  oldestDate: emBRT('2026-06-01', '00:00:00.000'), newestDate: emBRT('2026-07-25', '23:59:59.999'),
  updatedAt: '2026-07-24T17:00:00.000Z', origem: 'full', partial: false,
};
const metrics = (pedidos: OrderSlim[], periodo = PERIODO) => montarMetrics(pedidos, STATUS, periodo, AGORA);
const so = (...ps: OrderSlim[]) => metrics(ps).periodo;

describe('periodo.pedidos / periodo.unidades — status (contaComoVenda)', () => {
  it('1. ML paid entra', () => {
    expect(so(P.mlPaid)).toMatchObject({ pedidos: 1, unidades: 1 });
  });
  it('2. ML partially_refunded entra', () => {
    expect(so(P.mlParcial)).toMatchObject({ pedidos: 1, unidades: 1 });
  });
  it('3. ML pending nao entra', () => {
    expect(so(P.mlPending)).toMatchObject({ pedidos: 0, unidades: 0 });
  });
  it('4. ML cancelled nao entra', () => {
    expect(so(P.mlCancelado)).toMatchObject({ pedidos: 0, unidades: 0 });
  });
  it('5. Amazon amazon:pending entra', () => {
    expect(so(P.amzPending)).toMatchObject({ pedidos: 1, unidades: 1 });
  });
  it('6. Amazon aprovado (amazon:shipped) entra', () => {
    expect(so(P.amzEnviado)).toMatchObject({ pedidos: 1, unidades: 2 });
  });
  it('7. Amazon amazon:cancelled nao entra', () => {
    expect(so(P.amzCancelado)).toMatchObject({ pedidos: 0, unidades: 0 });
  });
});

describe('periodo.pedidos / periodo.unidades — itens e quantidades', () => {
  it('8. multi-item: 1 pedido, unidades = soma de todos os itens, faturamento uma vez', () => {
    const p = so(P.multiItem);
    expect(p).toMatchObject({ pedidos: 1, unidades: 4 });
    expect(p.faturamento.bruto).toBe(250);
    // porItem segue o contrato legado: so o 1o item, com o paid_amount inteiro.
    expect(p.porItem).toEqual([{ itemId: 'MLB1', pedidos: 1, unidades: 1, receita: 250 }]);
  });

  it('9. pedido valido sem item.id conta como pedido — e por isso porItem nao e total', () => {
    const p = so(P.semItemId);
    expect(p.pedidos).toBe(1);
    expect(p.unidades).toBe(2);                 // a quantidade do item existe; so o id falta
    expect(p.faturamento.bruto).toBe(40);       // o faturamento ja contava este pedido
    expect(p.porItem).toEqual([]);              // porItem perde o pedido inteiro
    const somaPorItem = p.porItem.reduce((s, l) => s + l.pedidos, 0);
    expect(somaPorItem).not.toBe(p.pedidos);
  });

  it('9b. pedido valido sem nenhum order_item: conta como pedido, contribui 0 unidades', () => {
    const vazio: OrderSlim = { ...P.mlPaid, id: 99, order_items: [] };
    expect(so(vazio)).toMatchObject({ pedidos: 1, unidades: 0 });
  });

  it('10. quantity ausente vira 1 (convencao do sales-metrics: ?? 1)', () => {
    expect(so(P.qtdAusente)).toMatchObject({ pedidos: 1, unidades: 1 });
  });

  it('11. quantity 0 permanece 0 (nao vira 1)', () => {
    expect(so(P.qtdZero)).toMatchObject({ pedidos: 1, unidades: 0 });
  });
});

describe('periodo.pedidos / periodo.unidades — janela', () => {
  it('12. pedido fora do periodo nao entra (antes e depois)', () => {
    expect(so(P.foraAntes)).toMatchObject({ pedidos: 0, unidades: 0 });
    expect(so(P.foraDepois)).toMatchObject({ pedidos: 0, unidades: 0 });
  });

  it('13. limites de dia em BRT: 00:00:00.000 do from e 23:59:59.999 do to entram; 1 ms fora nao', () => {
    expect(so(P.bordaInicio, P.bordaFim)).toMatchObject({ pedidos: 2, unidades: 2 });
    // 30/06 23:59:59.999 BRT = 01/07 02:59:59.999 UTC: mesmo dia UTC do periodo, mas fora em BRT.
    expect(so(P.foraAntes).pedidos).toBe(0);
  });

  it('mesma janela de periodo.faturamento: o conjunto que entra no bruto e o mesmo que entra em pedidos', () => {
    for (const original of TODOS) {
      // Valor 1 em todos: o bruto passa a dizer exatamente "entrou ou nao".
      const o = { ...original, paid_amount: 1, total_amount: 1 };
      const noBruto = faturamentoPeriodo([o], brtStartOfDay(PERIODO.fromYmd), brtEndOfDay(PERIODO.toYmd)).bruto === 1;
      expect(metrics([o]).periodo.pedidos === 1, String(o.id)).toBe(noBruto);
    }
  });

  it('nao depende de cobertura: igual a calcularMetricas no periodo exato, mesmo com snapshot parcial', () => {
    const esperado = calcularMetricas(TODOS, PERIODO);
    const parcial = montarMetrics(TODOS, { ...STATUS, partial: true, oldestDate: emBRT('2026-07-20') }, PERIODO, AGORA);
    expect(parcial.periodo).toMatchObject({ pedidos: esperado.pedidos, unidades: esperado.unidades });
  });
});

describe('fixture completa — comparacao entre os campos', () => {
  const m = metrics(TODOS);
  // Vendas no periodo: mlPaid, mlParcial, amzPending, amzEnviado, multiItem,
  // semItemId, qtdAusente, qtdZero, bordaInicio, bordaFim = 10 pedidos.
  // Unidades: 1+1+1+2+4+2+1+0+1+1 = 14.
  it('totais oficiais', () => {
    expect(m.periodo.pedidos).toBe(10);
    expect(m.periodo.unidades).toBe(14);
    expect(m.periodo.faturamento.bruto).toBeCloseTo(100 + 30.51 + 60 + 120 + 250 + 40 + 10 + 10 + 11 + 12, 6);
  });

  it('porItem diverge por construcao (so o 1o item; sem item.id fica fora) e nao e total', () => {
    const somaPed = m.periodo.porItem.reduce((s, l) => s + l.pedidos, 0);
    const somaUn = m.periodo.porItem.reduce((s, l) => s + l.unidades, 0);
    expect(somaPed).toBe(9);                   // perde o pedido sem item.id
    // 14 - 3 (2o item do multi-item) - 2 (pedido sem item.id) + 1 (quantity 0 vira 1 no `|| 1` legado) = 10:
    // porItem erra para os DOIS lados, entao nem como limite inferior serve.
    expect(somaUn).toBe(10);
    expect(somaPed).toBeLessThan(m.periodo.pedidos);
    expect(somaUn).not.toBe(m.periodo.unidades);
  });

  it('janelas seguem a mesma regra; a diferenca para periodo e so de janela e de cobertura', () => {
    const cob = { oldestDate: STATUS.oldestDate, newestDate: STATUS.newestDate, partial: false };
    const mes = calcularConsulta(TODOS, { fromYmd: '2026-07-01', toYmd: '2026-07-24' }, cob);
    // janelas.mesAtual cobre 01..24/07 = o mesmo periodo desta fixture.
    expect(m.janelas.mesAtual.pedidos).toBe(mes.metricas!.pedidos);
    expect(m.janelas.mesAtual.pedidos).toBe(m.periodo.pedidos);
    expect(m.janelas.mesAtual.unidades).toBe(m.periodo.unidades);
  });
});

describe('contrato: aditivo — nada existente muda', () => {
  const m = metrics(TODOS);
  const ini = brtStartOfDay(PERIODO.fromYmd), fim = brtEndOfDay(PERIODO.toYmd);

  it('periodo.porItem permanece EXATAMENTE vendasPorItem (distribuicao por item, nao total)', () => {
    const esperado = Array.from(vendasPorItem(TODOS, ini, fim).values())
      .map(v => ({ itemId: v.itemId, pedidos: v.pedidos, unidades: v.unidades, receita: v.receita }))
      .sort((a, b) => (b.receita - a.receita) || a.itemId.localeCompare(b.itemId));
    expect(m.periodo.porItem).toEqual(esperado);
    for (const l of m.periodo.porItem) expect(Object.keys(l).sort()).toEqual(['itemId', 'pedidos', 'receita', 'unidades']);
  });

  it('periodo.faturamento permanece EXATAMENTE faturamentoPeriodo', () => {
    const f = faturamentoPeriodo(TODOS, ini, fim);
    expect(m.periodo.faturamento).toEqual({ ...f, estimado: true });
  });

  it('periodo tem exatamente os campos antigos + pedidos + unidades', () => {
    expect(Object.keys(m.periodo).sort()).toEqual(['faturamento', 'fromYmd', 'pedidos', 'porItem', 'toYmd', 'unidades']);
  });

  it('demais blocos inalterados', () => {
    expect(m.faturamentoMensal).toEqual(faturamentoMensal(TODOS));
    const est = Array.from(unidadesPorItem(TODOS, brtStartOfDay(m.estoque30d.fromYmd), brtEndOfDay(m.estoque30d.toYmd)).entries())
      .map(([itemId, unidades]) => ({ itemId, unidades }))
      .sort((a, b) => (b.unidades - a.unidades) || a.itemId.localeCompare(b.itemId));
    expect(m.estoque30d.porItem).toEqual(est);
    expect(Object.keys(m).sort()).toEqual([
      'cancelados', 'coverage', 'estoque30d', 'faturamentoMensal', 'janelas', 'origem',
      'periodo', 'porStatus', 'reputacao60d', 'updatedAt', 'versao', 'warnings',
    ]);
  });
});

// ── Multi-conta ────────────────────────────────────────────────────────────

function base(id: string, pedidos: OrderSlim[]): BaseLida {
  const conta = contaPorId(id) as Conta;
  expect(conta, id).toBeTruthy();
  return {
    conta,
    cache: {} as BaseLida['cache'],
    status: {
      alvo: 'ativos', versao: 1, totalRegistros: pedidos.length,
      oldestDate: STATUS.oldestDate, newestDate: STATUS.newestDate,
      updatedAt: STATUS.updatedAt, origem: 'full', partial: false,
      lastResult: 'ok', lastSyncAt: STATUS.updatedAt,
    } as BaseLida['status'],
    pedidos: marcar(pedidos, conta),
    envios: new Map(),
    ...(conta.canal === 'amazon' ? { amazon: { transacoes: [], cobertura: null } } : {}),
  };
}

describe('14. multi-conta (metricsDaSelecao) — mesmos totais esperados', () => {
  const OW = [P.mlPaid, P.mlParcial, P.mlPending, P.mlCancelado, P.multiItem, P.semItemId];      // 4 vendas, 1+1+4+2 = 8 un
  const DG = [ped(2001, emBRT('2026-07-15'), 'paid', 50, [{ id: 'MLB-DG', qtd: 2 }])];           // 1 venda, 2 un
  const AMZ = [P.amzPending, P.amzEnviado, P.amzCancelado];                                        // 2 vendas, 1+2 = 3 un

  it('conta isolada: Overwine, Degustar e Amazon', () => {
    expect(metricsDaSelecao([base('overwine-ml', OW)], PERIODO, AGORA).periodo).toMatchObject({ pedidos: 4, unidades: 8 });
    expect(metricsDaSelecao([base('degustar-ml', DG)], PERIODO, AGORA).periodo).toMatchObject({ pedidos: 1, unidades: 2 });
    expect(metricsDaSelecao([base('alemmar-amazon', AMZ)], PERIODO, AGORA).periodo).toMatchObject({ pedidos: 2, unidades: 3 });
  });

  it('consolidado ML + ML + Amazon: uniao dos pedidos, igual a soma das partes (nenhum pedido em duas contas)', () => {
    const c = metricsDaSelecao([base('overwine-ml', OW), base('degustar-ml', DG), base('alemmar-amazon', AMZ)], PERIODO, AGORA);
    expect(c.periodo).toMatchObject({ pedidos: 7, unidades: 13 });
    expect(c.consolidado).toBe(true);
    // Mesma populacao do faturamento consolidado: os 7 pedidos sao os que somam o bruto.
    expect(c.periodo.faturamento.bruto).toBeCloseTo(100 + 30.51 + 250 + 40 + 50 + 60 + 120, 6);
  });

  it('o consolidado nao soma agregados prontos: e montarMetrics sobre a uniao', () => {
    const bases = [base('overwine-ml', OW), base('degustar-ml', DG)];
    const c = metricsDaSelecao(bases, PERIODO, AGORA);
    const uniao = montarMetrics([...bases[0].pedidos, ...bases[1].pedidos], STATUS, PERIODO, AGORA);
    expect(c.periodo.pedidos).toBe(uniao.periodo.pedidos);
    expect(c.periodo.unidades).toBe(uniao.periodo.unidades);
  });
});
