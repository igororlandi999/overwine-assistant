import { describe, it, expect } from 'vitest';
import {
  montarMetrics, resolverPeriodo, ymdMenosDias,
  DIAS_MAX, ESTOQUE_DIAS, REPUTACAO_DIAS,
  type StatusSnapshot,
} from '../src/services/orders-metrics.service.js';
import {
  contarPorStatus, faturamentoMensal, faturamentoPeriodo, unidadesPorItem, vendasPorItem,
  type OrderSlim,
} from '../src/services/orders.service.js';
import { calcularConsulta } from '../src/services/sales-metrics.service.js';
import { brtStartOfDay, brtEndOfDay } from '../src/lib/datas-brt.js';

// Relógio fixo: 24/07/2026 15:00 BRT (18:00 UTC).
const AGORA = new Date('2026-07-24T18:00:00.000Z');
const HOJE = '2026-07-24';
const emBRT = (ymd: string, hora: string) => `${ymd}T${hora}-03:00`;

function ped(
  id: number, ymd: string, status: string,
  paid: number | null, total: number | null,
  itens: Array<[string, number]>
): OrderSlim {
  return {
    id, status, date_created: emBRT(ymd, '12:00:00.000'),
    paid_amount: paid, total_amount: total,
    order_items: itens.map(([itemId, q]) => ({
      quantity: q, unit_price: 10,
      item: { id: itemId, title: 'Vinho', seller_sku: 'SKU-' + itemId, variation_id: null },
    })),
    buyer: { nickname: 'comprador_secreto' },
    shipping: { id: 999, logistic_type: 'fulfillment' },
  };
}

// Conjunto base:
//  hoje    : 1 pago 80 (MLB1 x1)
//  ontem   : 2 pagos (150,5 = MLB1 x1 + MLB2 x2) e (49,5 = MLB2 x1)
//  ontem   : 1 cancelado e 1 pendente
//  D-40    : 1 pago 300 (MLB3 x5)  → dentro de 60d, fora de 30d
//  D-200   : 1 pago 500 (MLB1 x1)  → só no histórico e no mensal
const ONTEM = '2026-07-23';
const D40 = '2026-06-14';
const D200 = '2026-01-05';

function base(): OrderSlim[] {
  return [
    ped(1, HOJE, 'paid', 80, 80, [['MLB1', 1]]),
    ped(2, ONTEM, 'paid', 150.5, 150.5, [['MLB1', 1], ['MLB2', 2]]),
    ped(3, ONTEM, 'paid', 49.5, 49.5, [['MLB2', 1]]),
    ped(4, ONTEM, 'cancelled', 999, 999, [['MLB9', 9]]),
    ped(5, ONTEM, 'payment_required', 0, 777, [['MLB4', 3]]),
    ped(6, D40, 'paid', 300, 300, [['MLB3', 5]]),
    ped(7, D200, 'paid', 500, 500, [['MLB1', 1]]),
  ];
}

const STATUS: StatusSnapshot = {
  versao: 12,
  totalRegistros: 7,
  oldestDate: emBRT(D200, '00:00:00.000'),
  newestDate: emBRT(HOJE, '23:59:59.999'),
  updatedAt: '2026-07-24T17:00:00.000Z',
  origem: 'full',
  partial: false,
};

const PERIODO7 = { fromYmd: ymdMenosDias(HOJE, 6), toYmd: HOJE };

describe('orders-metrics — helpers de data', () => {
  it('ymdMenosDias anda em dias civis BRT', () => {
    expect(ymdMenosDias('2026-07-24', 0)).toBe('2026-07-24');
    expect(ymdMenosDias('2026-07-24', 6)).toBe('2026-07-18');
    expect(ymdMenosDias('2026-03-01', 1)).toBe('2026-02-28');
    expect(ymdMenosDias('2026-01-01', 1)).toBe('2025-12-31');
  });

  it('constantes espelham o dashboard', () => {
    expect(REPUTACAO_DIAS).toBe(60);
    expect(ESTOQUE_DIAS).toBe(30);
  });
});

describe('orders-metrics — paridade com as funcoes existentes', () => {
  const m = montarMetrics(base(), STATUS, PERIODO7, AGORA);

  it('janelas usam EXATAMENTE calcularConsulta', () => {
    const cob = { oldestDate: STATUS.oldestDate, newestDate: STATUS.newestDate, partial: false };
    const hoje = calcularConsulta(base(), { fromYmd: HOJE, toYmd: HOJE }, cob);
    expect(m.janelas.hoje.receita).toBe(hoje.metricas!.receita);
    expect(m.janelas.hoje.pedidos).toBe(hoje.metricas!.pedidos);
    expect(m.janelas.hoje.unidades).toBe(hoje.metricas!.unidades);
    expect(m.janelas.hoje.ticketMedio).toBe(hoje.metricas!.ticketMedio);
  });

  it('janela hoje: 80 / 1 pedido / 1 unidade', () => {
    expect(m.janelas.hoje.receita).toBe(80);
    expect(m.janelas.hoje.pedidos).toBe(1);
    expect(m.janelas.hoje.unidades).toBe(1);
    expect(m.janelas.hoje.ticketMedio).toBe(80);
  });

  it('janela ultimos7: 280 / 3 pedidos / 5 unidades (cancelado e pendente fora)', () => {
    expect(m.janelas.ultimos7.receita).toBe(280);
    expect(m.janelas.ultimos7.pedidos).toBe(3);
    expect(m.janelas.ultimos7.unidades).toBe(5);
  });

  it('janela mesAtual cobre 01..hoje', () => {
    expect(m.janelas.mesAtual.fromYmd).toBe('2026-07-01');
    expect(m.janelas.mesAtual.toYmd).toBe(HOJE);
    expect(m.janelas.mesAtual.receita).toBe(280);
  });

  it('janela historico cobre a janela inteira do snapshot', () => {
    expect(m.janelas.historico.fromYmd).toBe(D200);
    expect(m.janelas.historico.toYmd).toBe(HOJE);
    expect(m.janelas.historico.receita).toBe(1080);   // 80+150,5+49,5+300+500
    expect(m.janelas.historico.pedidos).toBe(5);
    expect(m.janelas.historico.ticketMedio).toBe(216);
  });

  it('periodo.faturamento usa EXATAMENTE faturamentoPeriodo', () => {
    const f = faturamentoPeriodo(base(), brtStartOfDay(PERIODO7.fromYmd), brtEndOfDay(PERIODO7.toYmd));
    expect(m.periodo.faturamento.bruto).toBe(f.bruto);
    expect(m.periodo.faturamento.tarifaML).toBe(f.tarifaML);
    expect(m.periodo.faturamento.tarifaEnv).toBe(f.tarifaEnv);
    expect(m.periodo.faturamento.liquido).toBe(f.liquido);
    expect(m.periodo.faturamento.estimado).toBe(true);
  });

  it('taxas nao sao recalculadas: liquido = bruto + tarifas (negativas)', () => {
    const f = m.periodo.faturamento;
    expect(f.tarifaML).toBeLessThanOrEqual(0);
    expect(f.tarifaEnv).toBeLessThanOrEqual(0);
    expect(f.liquido).toBeCloseTo(f.bruto + f.tarifaML + f.tarifaEnv, 10);
    expect(f.tarifaML).toBeCloseTo(-(f.bruto * 0.148), 10);
    expect(f.tarifaEnv).toBeCloseTo(-(f.bruto * 0.144), 10);
  });

  it('periodo.porItem usa EXATAMENTE vendasPorItem (quirk do primeiro order_item)', () => {
    const esperado = vendasPorItem(base(), brtStartOfDay(PERIODO7.fromYmd), brtEndOfDay(PERIODO7.toYmd));
    expect(m.periodo.porItem.length).toBe(esperado.size);
    for (const linha of m.periodo.porItem) {
      const e = esperado.get(linha.itemId)!;
      expect(linha.pedidos).toBe(e.pedidos);
      expect(linha.unidades).toBe(e.unidades);
      expect(linha.receita).toBe(e.receita);
    }
  });

  it('periodo.porItem segue a lista de permissao, igual as janelas', () => {
    // Antes este agregado usava `!== cancelled` e contava pendente, enquanto as
    // janelas usavam `=== paid`. Eram duas convencoes vivas ao mesmo tempo, e o
    // mesmo numero divergia conforme o caminho. Agora ha uma so.
    const ids = m.periodo.porItem.map(i => i.itemId);
    expect(ids).not.toContain('MLB4');       // payment_required fica fora
    expect(ids).not.toContain('MLB9');       // cancelled fica fora
  });

  it('periodo.porItem vem ordenado por receita desc, deterministico', () => {
    const rec = m.periodo.porItem.map(i => i.receita);
    expect([...rec].sort((a, b) => b - a)).toEqual(rec);
  });

  it('reputacao60d usa faturamentoPeriodo na janela de 60 dias', () => {
    const de = ymdMenosDias(HOJE, 60);
    const f = faturamentoPeriodo(base(), brtStartOfDay(de), brtEndOfDay(HOJE));
    expect(m.reputacao60d.fromYmd).toBe(de);
    expect(m.reputacao60d.toYmd).toBe(HOJE);
    expect(m.reputacao60d.bruto).toBe(f.bruto);
    expect(m.reputacao60d.bruto).toBe(580);  // 80+150,5+49,5+300 (o de D-200 fica fora)
  });

  it('estoque30d usa unidadesPorItem sobre TODOS os order_items', () => {
    const de = ymdMenosDias(HOJE, 30);
    const esperado = unidadesPorItem(base(), brtStartOfDay(de), brtEndOfDay(HOJE));
    const obtido = new Map(m.estoque30d.porItem.map(i => [i.itemId, i.unidades]));
    expect(obtido).toEqual(esperado);
    expect(obtido.get('MLB1')).toBe(2);   // hoje 1 + ontem 1
    expect(obtido.get('MLB2')).toBe(3);   // 2 + 1 — segundo order_item CONTA
    expect(obtido.has('MLB4')).toBe(false); // pendente NAO conta mais
    expect(obtido.has('MLB9')).toBe(false); // cancelado nao conta
    expect(obtido.has('MLB3')).toBe(false); // D-40 esta fora dos 30 dias
  });

  it('faturamentoMensal usa EXATAMENTE faturamentoMensal', () => {
    expect(m.faturamentoMensal).toEqual(faturamentoMensal(base()));
    expect(m.faturamentoMensal.map(x => x.mes)).toEqual(['2026-01', '2026-06', '2026-07']);
    expect(m.faturamentoMensal.find(x => x.mes === '2026-07')!.total).toBe(280);
  });
});

describe('orders-metrics — cancelados NAO sao apresentados como completos', () => {
  const m = montarMetrics(base(), STATUS, PERIODO7, AGORA);

  it('porStatus NUNCA traz a chave cancelled, nem como zero', () => {
    expect(Object.keys(m.porStatus)).not.toContain('cancelled');
    expect((m.porStatus as Record<string, number>).cancelled).toBeUndefined();
  });

  it('porStatus traz os estados efetivamente cobertos', () => {
    const c = contarPorStatus(base());
    expect(m.porStatus.paid).toBe(c.paid);
    expect(m.porStatus.payment_required).toBe(c.payment_required);
  });

  it('bloco cancelados declara indisponibilidade explicita, nunca zero', () => {
    expect(m.cancelados.disponivel).toBe(false);
    expect(m.cancelados.total).toBeNull();
    expect(m.cancelados.motivo).toBe('fora_do_escopo_do_snapshot_ativos');
    expect(m.cancelados.fonte).toBe('carga_sob_demanda_no_dashboard');
  });

  it('mesmo havendo cancelados no snapshot, o total nao e publicado', () => {
    const comMuitos = [...base(), ped(8, ONTEM, 'cancelled', 10, 10, [['MLB5', 1]])];
    const m2 = montarMetrics(comMuitos, STATUS, PERIODO7, AGORA);
    expect(Object.keys(m2.porStatus)).not.toContain('cancelled');
    expect(m2.cancelados.total).toBeNull();
  });
});

describe('orders-metrics — cobertura', () => {
  it('cobertura total quando a janela cobre os dias inteiros', () => {
    const m = montarMetrics(base(), STATUS, PERIODO7, AGORA);
    expect(m.janelas.ultimos7.cobertura).toBe('total');
    expect(m.janelas.ultimos7.disponivel).toBe(true);
  });

  it('cobertura parcial quando o ultimo dia do snapshot esta incompleto', () => {
    const st = { ...STATUS, newestDate: emBRT(HOJE, '12:00:00.000') };
    const m = montarMetrics(base(), st, PERIODO7, AGORA);
    expect(m.janelas.hoje.cobertura).toBe('parcial');
    expect(m.warnings).toContain('cobertura_parcial_fim');
  });

  it('periodo fora da janela: valores null, nunca zero', () => {
    const st = { ...STATUS, oldestDate: emBRT('2026-07-20', '00:00:00.000') };
    const m = montarMetrics(base(), st, { fromYmd: '2020-01-01', toYmd: '2020-01-31' }, AGORA);
    expect(m.janelas.hoje.disponivel).toBe(true);
    const antigo = calcularConsulta(base(), { fromYmd: '2020-01-01', toYmd: '2020-01-31' }, {
      oldestDate: st.oldestDate, newestDate: st.newestDate, partial: false,
    });
    expect(antigo.disponivel).toBe(false);
    expect(antigo.metricas).toBeNull();
  });

  it('snapshot marcado partial gera warning neutro', () => {
    const m = montarMetrics(base(), { ...STATUS, partial: true }, PERIODO7, AGORA);
    expect(m.warnings).toContain('snapshot_parcial');
    expect(m.coverage.partial).toBe(true);
  });

  it('coverage expoe versao, updatedAt, totalRegistros e alvo ativos', () => {
    const m = montarMetrics(base(), STATUS, PERIODO7, AGORA);
    expect(m.versao).toBe(12);
    expect(m.updatedAt).toBe('2026-07-24T17:00:00.000Z');
    expect(m.coverage.totalRegistros).toBe(7);
    expect(m.coverage.alvo).toBe('ativos');
    expect(m.coverage.dataFromYmd).toBe(D200);
    expect(m.coverage.dataToYmd).toBe(HOJE);
  });

  it('snapshot sem vendas no periodo retorna zero real (nao null)', () => {
    const so200 = [ped(7, D200, 'paid', 500, 500, [['MLB1', 1]])];
    const st = { ...STATUS, totalRegistros: 1 };
    const m = montarMetrics(so200, st, PERIODO7, AGORA);
    expect(m.janelas.ultimos7.disponivel).toBe(true);
    expect(m.janelas.ultimos7.receita).toBe(0);
    expect(m.janelas.ultimos7.ticketMedio).toBeNull();
  });
});

describe('orders-metrics — ausencia de PII na serializacao', () => {
  const bruto = JSON.stringify(montarMetrics(base(), STATUS, PERIODO7, AGORA));

  it('nao vaza buyer, nickname nem shipping', () => {
    expect(bruto).not.toContain('buyer');
    expect(bruto).not.toContain('nickname');
    expect(bruto).not.toContain('comprador_secreto');
    expect(bruto).not.toContain('shipping');
    expect(bruto).not.toContain('logistic_type');
  });

  it('nao vaza order_items brutos, unit_price nem seller_sku', () => {
    expect(bruto).not.toContain('order_items');
    expect(bruto).not.toContain('unit_price');
    expect(bruto).not.toContain('seller_sku');
    expect(bruto).not.toContain('SKU-MLB1');
  });

  it('nao vaza ids de pedido nem datas individuais', () => {
    expect(bruto).not.toContain('paid_amount');
    expect(bruto).not.toContain('date_created');
    expect(bruto).not.toContain('12:00:00.000');
    expect(bruto).not.toContain('"id"');
  });

  it('itemId e permitido (nao e PII) e aparece nos agregados', () => {
    expect(bruto).toContain('MLB1');
    expect(bruto).toContain('itemId');
  });
});

describe('orders-metrics — resolverPeriodo', () => {
  const ok = (q: Record<string, unknown>) => resolverPeriodo(q, AGORA);

  it('sem parametros usa o padrao de 7 dias do dashboard (hoje-7 ate hoje, como loadPeriodoData)', () => {
    const r = ok({ resource: 'metrics' });
    expect(r).toEqual({ ok: true, periodo: { fromYmd: '2026-07-17', toYmd: HOJE } });
  });

  it('dias=30 resolve hoje-30 ate hoje', () => {
    const r = ok({ dias: '30' });
    expect(r.ok && r.periodo).toEqual({ fromYmd: '2026-06-24', toYmd: HOJE });
  });

  it('from/to explicitos sao respeitados', () => {
    const r = ok({ from: '2026-07-01', to: '2026-07-31' });
    expect(r.ok && r.periodo).toEqual({ fromYmd: '2026-07-01', toYmd: '2026-07-31' });
  });

  it('from == to e valido (um unico dia)', () => {
    const r = ok({ from: '2026-07-10', to: '2026-07-10' });
    expect(r.ok).toBe(true);
  });

  const invalidos: Array<[string, Record<string, unknown>, string]> = [
    ['parametro desconhecido', { foo: '1' }, 'parametro_desconhecido'],
    ['dias nao numerico', { dias: 'abc' }, 'dias_invalido'],
    ['dias negativo', { dias: '-5' }, 'dias_invalido'],
    ['dias decimal', { dias: '7.5' }, 'dias_invalido'],
    ['dias zero', { dias: '0' }, 'dias_fora_do_limite'],
    ['dias acima do limite', { dias: String(DIAS_MAX + 1) }, 'dias_fora_do_limite'],
    ['dias junto de from', { dias: '7', from: '2026-07-01' }, 'combinacao_invalida'],
    ['dias junto de to', { dias: '7', to: '2026-07-01' }, 'combinacao_invalida'],
    ['intervalo so com from', { from: '2026-07-01' }, 'intervalo_incompleto'],
    ['intervalo so com to', { to: '2026-07-01' }, 'intervalo_incompleto'],
    ['formato errado', { from: '01/07/2026', to: '31/07/2026' }, 'data_invalida'],
    ['data inexistente', { from: '2026-02-31', to: '2026-03-01' }, 'data_invalida'],
    ['mes 13', { from: '2026-13-01', to: '2026-13-02' }, 'data_invalida'],
    ['dia 00', { from: '2026-07-00', to: '2026-07-05' }, 'data_invalida'],
    ['intervalo invertido', { from: '2026-07-31', to: '2026-07-01' }, 'intervalo_invertido'],
    ['intervalo excessivo', { from: '2020-01-01', to: '2026-07-31' }, 'intervalo_excessivo'],
  ];
  for (const [nome, q, erro] of invalidos) {
    it(`rejeita: ${nome}`, () => {
      const r = ok(q);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.erro).toBe(erro);
    });
  }

  it('29/02 e aceito em ano bissexto e rejeitado fora dele', () => {
    expect(ok({ from: '2024-02-29', to: '2024-03-01' }).ok).toBe(true);
    expect(ok({ from: '2026-02-29', to: '2026-03-01' }).ok).toBe(false);
  });

  it('alvo e resource nao sao tratados como desconhecidos', () => {
    expect(ok({ resource: 'metrics', alvo: 'ativos', dias: '7' }).ok).toBe(true);
  });
});