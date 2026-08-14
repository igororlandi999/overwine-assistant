import { describe, it, expect } from 'vitest';
import {
  calcularMetricas,
  calcularConsulta,
  calcularComparacao,
  avaliarCobertura,
  periodoValido,
  WARN_COBERTURA_PARCIAL_INICIO,
  WARN_COBERTURA_PARCIAL_FIM,
  WARN_SNAPSHOT_PARCIAL,
  WARN_SEM_DADOS_NO_PERIODO,
  WARN_COMPARACAO_DESIGUAL,
  COBERTURA_MINIMA_COMPARACAO,
  type CoberturaSnapshot,
} from '../src/services/sales-metrics.service.js';
import type { OrderSlim } from '../src/services/orders.service.js';

// ── Cobertura REAL do snapshot (GET /api/orders/status?alvo=ativos) ──
// oldestDate 2025-07-21T10:30:37.000-04:00 => dia BRT 2025-07-21
// newestDate 2026-08-03T02:02:28.000-04:00 => dia BRT 2026-08-03
const COBERTURA_REAL: CoberturaSnapshot = {
  oldestDate: '2025-07-21T10:30:37.000-04:00',
  newestDate: '2026-08-03T02:02:28.000-04:00',
  partial: false,
};

/** Pedido slim mínimo; por padrão pago, 1 item, R$ 100. */
const ped = (over: Partial<OrderSlim> & { id: number | string }): OrderSlim => ({
  status: 'paid',
  date_created: '2026-07-10T12:00:00.000-03:00',
  paid_amount: 100,
  total_amount: 100,
  order_items: [{ quantity: 1, unit_price: 100, item: { id: 'MLB1', title: 'V', seller_sku: 'S', variation_id: null } }],
  ...over,
});

const item = (quantity: number, unit_price = 50) => ({
  quantity, unit_price, item: { id: 'MLB1', title: 'V', seller_sku: 'S', variation_id: null },
});

const P = (fromYmd: string, toYmd: string) => ({ fromYmd, toYmd });

describe('sales-metrics — calcularMetricas (status e valores)', () => {
  it('considera SOMENTE status paid: exclui cancelados e pendentes', () => {
    const orders = [
      ped({ id: 1, status: 'paid', paid_amount: 100 }),
      ped({ id: 2, status: 'cancelled', paid_amount: 999 }),
      ped({ id: 3, status: 'payment_required', paid_amount: 888 }),
      ped({ id: 4, status: 'payment_in_process', paid_amount: 777 }),
      ped({ id: 5, status: 'partially_refunded', paid_amount: 666 }),
      ped({ id: 6, status: null, paid_amount: 555 }),
    ];
    const m = calcularMetricas(orders, P('2026-07-10', '2026-07-10'));
    expect(m.pedidos).toBe(1);
    expect(m.receita).toBe(100);
  });

  it('receita usa paid_amount || 0 e NAO cai para total_amount', () => {
    const orders = [
      ped({ id: 1, paid_amount: 50, total_amount: 999 }),
      ped({ id: 2, paid_amount: null, total_amount: 999 }), // conta 0, nao 999
    ];
    const m = calcularMetricas(orders, P('2026-07-10', '2026-07-10'));
    expect(m.pedidos).toBe(2);
    expect(m.receita).toBe(50);
  });

  it('unidades somam TODOS os order_items (pedido multi-item)', () => {
    const orders = [
      ped({ id: 1, order_items: [item(2), item(3), item(5)] }), // 10
      ped({ id: 2, order_items: [item(1)] }),                   // 1
    ];
    const m = calcularMetricas(orders, P('2026-07-10', '2026-07-10'));
    expect(m.unidades).toBe(11);
    expect(m.pedidos).toBe(2);
  });

  it('quantity null usa fallback 1', () => {
    const orders = [ped({ id: 1, order_items: [{ ...item(1), quantity: null }, item(4)] })];
    expect(calcularMetricas(orders, P('2026-07-10', '2026-07-10')).unidades).toBe(5);
  });

  it('quantity ausente (undefined) usa fallback 1', () => {
    const semQty = { unit_price: 50, item: { id: 'MLB1', title: 'V', seller_sku: 'S', variation_id: null } } as never;
    const orders = [ped({ id: 1, order_items: [semQty, item(4)] })];
    expect(calcularMetricas(orders, P('2026-07-10', '2026-07-10')).unidades).toBe(5);
  });

  it('quantity 0 PERMANECE 0 (nao vira 1)', () => {
    const orders = [ped({ id: 1, order_items: [item(0), item(3)] })];
    expect(calcularMetricas(orders, P('2026-07-10', '2026-07-10')).unidades).toBe(3);
  });

  it('todos os itens com quantity 0 => unidades 0, mas pedido conta', () => {
    const orders = [ped({ id: 1, order_items: [item(0), item(0)] })];
    const m = calcularMetricas(orders, P('2026-07-10', '2026-07-10'));
    expect(m.unidades).toBe(0);
    expect(m.pedidos).toBe(1);
  });

  it('pedido sem order_items nao quebra e conta 0 unidades', () => {
    const orders = [ped({ id: 1, order_items: [] })];
    const m = calcularMetricas(orders, P('2026-07-10', '2026-07-10'));
    expect(m.pedidos).toBe(1);
    expect(m.unidades).toBe(0);
  });

  it('ticket medio = receita / pedidos pagos', () => {
    const orders = [
      ped({ id: 1, paid_amount: 100 }),
      ped({ id: 2, paid_amount: 50 }),
      ped({ id: 3, status: 'cancelled', paid_amount: 1000 }),
    ];
    const m = calcularMetricas(orders, P('2026-07-10', '2026-07-10'));
    expect(m.ticketMedio).toBe(75);
  });

  it('ausencia de pedidos: zeros e ticket null (sem divisao por zero)', () => {
    const m = calcularMetricas([], P('2026-07-10', '2026-07-10'));
    expect(m).toEqual({ receita: 0, pedidos: 0, ticketMedio: null, unidades: 0 });
  });

  it('pedido sem date_created nunca entra no periodo', () => {
    const orders = [ped({ id: 1, date_created: null })];
    expect(calcularMetricas(orders, P('2026-07-10', '2026-07-10')).pedidos).toBe(0);
  });
});

describe('sales-metrics — periodo BRT inclusivo', () => {
  it('range inclusivo nas DUAS bordas', () => {
    const orders = [
      ped({ id: 1, date_created: '2026-07-20T00:00:00.000-03:00', paid_amount: 10 }), // borda inicial
      ped({ id: 2, date_created: '2026-07-22T12:00:00.000-03:00', paid_amount: 20 }),
      ped({ id: 3, date_created: '2026-07-25T23:59:59.000-03:00', paid_amount: 30 }), // borda final
      ped({ id: 4, date_created: '2026-07-19T23:59:59.000-03:00', paid_amount: 99 }), // fora (antes)
      ped({ id: 5, date_created: '2026-07-26T00:00:00.000-03:00', paid_amount: 99 }), // fora (depois)
    ];
    const m = calcularMetricas(orders, P('2026-07-20', '2026-07-25'));
    expect(m.pedidos).toBe(3);
    expect(m.receita).toBe(60);
  });

  it('dia unico: from === to captura o dia inteiro em BRT', () => {
    const orders = [
      ped({ id: 1, date_created: '2026-07-22T00:00:00.000-03:00', paid_amount: 10 }),
      ped({ id: 2, date_created: '2026-07-22T23:59:59.999-03:00', paid_amount: 20 }),
      ped({ id: 3, date_created: '2026-07-23T00:00:00.000-03:00', paid_amount: 99 }),
    ];
    const m = calcularMetricas(orders, P('2026-07-22', '2026-07-22'));
    expect(m.pedidos).toBe(2);
    expect(m.receita).toBe(30);
  });

  it('timezone: instante UTC que ainda e o dia anterior em Sao Paulo', () => {
    // 2026-07-23T02:00:00Z == 2026-07-22 23:00 em BRT (-03:00) => pertence ao dia 22
    const orders = [ped({ id: 1, date_created: '2026-07-23T02:00:00.000Z', paid_amount: 40 })];
    expect(calcularMetricas(orders, P('2026-07-22', '2026-07-22')).pedidos).toBe(1);
    expect(calcularMetricas(orders, P('2026-07-23', '2026-07-23')).pedidos).toBe(0);
  });

  it('timezone: offset -04:00 do payload real e convertido corretamente', () => {
    // 2026-08-03T02:02:28-04:00 == 2026-08-03T03:02:28-03:00 => dia 03 em BRT
    const orders = [ped({ id: 1, date_created: '2026-08-03T02:02:28.000-04:00', paid_amount: 70 })];
    expect(calcularMetricas(orders, P('2026-08-03', '2026-08-03')).pedidos).toBe(1);
    expect(calcularMetricas(orders, P('2026-08-02', '2026-08-02')).pedidos).toBe(0);
  });
});

describe('sales-metrics — periodoValido', () => {
  it('aceita periodo bem formado', () => {
    expect(periodoValido(P('2026-07-01', '2026-07-31'))).toBe(true);
    expect(periodoValido(P('2026-07-10', '2026-07-10'))).toBe(true);
  });
  it('rejeita from > to', () => {
    expect(periodoValido(P('2026-07-31', '2026-07-01'))).toBe(false);
  });
  it('rejeita data inexistente no calendario', () => {
    expect(periodoValido(P('2026-02-30', '2026-03-01'))).toBe(false);
    expect(periodoValido(P('2026-13-01', '2026-13-02'))).toBe(false);
  });
  it('rejeita formato invalido e nulo', () => {
    expect(periodoValido(P('10/07/2026', '2026-07-11'))).toBe(false);
    expect(periodoValido(null)).toBe(false);
  });
});

describe('sales-metrics — cobertura (dados reais do snapshot)', () => {
  it('periodo dentro da janela e partial false => total', () => {
    const c = avaliarCobertura(P('2026-07-20', '2026-07-25'), COBERTURA_REAL);
    expect(c.tipo).toBe('total');
    expect(c.periodoEfetivo).toEqual(P('2026-07-20', '2026-07-25'));
    expect(c.warnings).toEqual([]);
    expect(c.dadosDesdeYmd).toBe('2025-07-21');
    expect(c.dadosAteYmd).toBe('2026-08-03');
  });

  it('dia do oldestDate NAO e integral: consulta so nesse dia => parcial no inicio', () => {
    // oldestDate 2025-07-21T10:30:37-04:00 == 11:30 BRT: nao ha dados das 00:00 as 11:30
    const c = avaliarCobertura(P('2025-07-21', '2025-07-21'), COBERTURA_REAL);
    expect(c.tipo).toBe('parcial');
    expect(c.primeiroDiaIncompleto).toBe(true);
    expect(c.warnings).toContain(WARN_COBERTURA_PARCIAL_INICIO);
  });

  it('dia do newestDate NAO e integral: consulta so nesse dia => parcial no fim', () => {
    // newestDate 2026-08-03T02:02:28-04:00 == 03:02 BRT: nao ha dados das 03:02 as 23:59
    const c = avaliarCobertura(P('2026-08-03', '2026-08-03'), COBERTURA_REAL);
    expect(c.tipo).toBe('parcial');
    expect(c.ultimoDiaIncompleto).toBe(true);
    expect(c.warnings).toContain(WARN_COBERTURA_PARCIAL_FIM);
  });

  it('intervalo 2025-07-21..2025-07-22 => parcial no inicio', () => {
    const c = avaliarCobertura(P('2025-07-21', '2025-07-22'), COBERTURA_REAL);
    expect(c.tipo).toBe('parcial');
    expect(c.warnings).toContain(WARN_COBERTURA_PARCIAL_INICIO);
    expect(c.warnings).not.toContain(WARN_COBERTURA_PARCIAL_FIM);
  });

  it('intervalo 2026-08-02..2026-08-03 => parcial no fim', () => {
    const c = avaliarCobertura(P('2026-08-02', '2026-08-03'), COBERTURA_REAL);
    expect(c.tipo).toBe('parcial');
    expect(c.warnings).toContain(WARN_COBERTURA_PARCIAL_FIM);
    expect(c.warnings).not.toContain(WARN_COBERTURA_PARCIAL_INICIO);
  });

  it('intervalo 2025-07-22..2026-08-02 (so dias integrais) => total', () => {
    const c = avaliarCobertura(P('2025-07-22', '2026-08-02'), COBERTURA_REAL);
    expect(c.tipo).toBe('total');
    expect(c.warnings).toEqual([]);
  });

  it('dia-limite integral (oldest exatamente a meia-noite) => total', () => {
    const c = avaliarCobertura(P('2025-07-21', '2025-07-21'), {
      oldestDate: '2025-07-21T00:00:00.000-03:00',
      newestDate: '2026-08-03T23:59:59.999-03:00',
      partial: false,
    });
    expect(c.tipo).toBe('total');
    expect(c.primeiroDiaIncompleto).toBe(false);
  });

  it('periodo totalmente ANTES de oldestDate => indisponivel (nunca zero)', () => {
    const c = avaliarCobertura(P('2025-01-01', '2025-01-31'), COBERTURA_REAL);
    expect(c.tipo).toBe('indisponivel');
    expect(c.periodoEfetivo).toBeNull();
  });

  it('periodo totalmente DEPOIS de newestDate => indisponivel', () => {
    const c = avaliarCobertura(P('2026-09-01', '2026-09-30'), COBERTURA_REAL);
    expect(c.tipo).toBe('indisponivel');
    expect(c.periodoEfetivo).toBeNull();
  });

  it('comeca antes de oldestDate e termina dentro => parcial recortado + warning', () => {
    const c = avaliarCobertura(P('2025-06-01', '2025-08-01'), COBERTURA_REAL);
    expect(c.tipo).toBe('parcial');
    expect(c.periodoEfetivo).toEqual(P('2025-07-21', '2025-08-01'));
    expect(c.warnings).toContain(WARN_COBERTURA_PARCIAL_INICIO);
  });

  it('termina depois de newestDate => parcial recortado + warning', () => {
    const c = avaliarCobertura(P('2026-08-01', '2026-08-31'), COBERTURA_REAL);
    expect(c.tipo).toBe('parcial');
    expect(c.periodoEfetivo).toEqual(P('2026-08-01', '2026-08-03'));
    expect(c.warnings).toContain(WARN_COBERTURA_PARCIAL_FIM);
  });

  it('extrapola dos DOIS lados => parcial com os dois warnings', () => {
    const c = avaliarCobertura(P('2024-01-01', '2027-01-01'), COBERTURA_REAL);
    expect(c.tipo).toBe('parcial');
    expect(c.periodoEfetivo).toEqual(P('2025-07-21', '2026-08-03'));
    expect(c.warnings).toContain(WARN_COBERTURA_PARCIAL_INICIO);
    expect(c.warnings).toContain(WARN_COBERTURA_PARCIAL_FIM);
  });

  it('partial true adiciona warning sem mudar o tipo', () => {
    const c = avaliarCobertura(P('2026-07-20', '2026-07-25'), { ...COBERTURA_REAL, partial: true });
    expect(c.tipo).toBe('total');
    expect(c.warnings).toContain(WARN_SNAPSHOT_PARCIAL);
  });

  it('janela desconhecida (sem oldest/newest) => indisponivel', () => {
    const c = avaliarCobertura(P('2026-07-20', '2026-07-25'), { oldestDate: null, newestDate: null, partial: false });
    expect(c.tipo).toBe('indisponivel');
  });
});

describe('sales-metrics — calcularConsulta', () => {
  const orders = [
    ped({ id: 1, date_created: '2026-07-22T12:00:00.000-03:00', paid_amount: 100, order_items: [item(2)] }),
    ped({ id: 2, date_created: '2026-07-23T12:00:00.000-03:00', paid_amount: 200, order_items: [item(1), item(2)] }),
    ped({ id: 3, date_created: '2026-07-23T12:00:00.000-03:00', status: 'cancelled', paid_amount: 999 }),
  ];

  it('periodo coberto: metricas completas', () => {
    const r = calcularConsulta(orders, P('2026-07-22', '2026-07-23'), COBERTURA_REAL);
    expect(r.disponivel).toBe(true);
    expect(r.cobertura).toBe('total');
    expect(r.metricas).toEqual({ receita: 300, pedidos: 2, ticketMedio: 150, unidades: 5 });
    expect(r.periodoCalculado).toEqual(P('2026-07-22', '2026-07-23'));
  });

  it('periodo fora da janela: indisponivel com metricas NULL (nunca zero)', () => {
    const r = calcularConsulta(orders, P('2025-01-01', '2025-01-31'), COBERTURA_REAL);
    expect(r.disponivel).toBe(false);
    expect(r.metricas).toBeNull();
    expect(r.cobertura).toBe('indisponivel');
  });

  it('cobertura parcial: calcula so a parte disponivel e avisa', () => {
    const r = calcularConsulta(orders, P('2026-08-01', '2026-08-31'), COBERTURA_REAL);
    expect(r.disponivel).toBe(true);
    expect(r.cobertura).toBe('parcial');
    expect(r.periodoCalculado).toEqual(P('2026-08-01', '2026-08-03'));
    expect(r.warnings).toContain(WARN_COBERTURA_PARCIAL_FIM);
  });

  it('periodo coberto sem pedidos: zero REAL sinalizado com warning proprio', () => {
    const r = calcularConsulta(orders, P('2026-07-01', '2026-07-02'), COBERTURA_REAL);
    expect(r.disponivel).toBe(true);
    expect(r.metricas).toEqual({ receita: 0, pedidos: 0, ticketMedio: null, unidades: 0 });
    expect(r.warnings).toContain(WARN_SEM_DADOS_NO_PERIODO);
  });

  it('consulta no dia do oldestDate => disponivel, porem cobertura parcial', () => {
    const r = calcularConsulta(orders, P('2025-07-21', '2025-07-21'), COBERTURA_REAL);
    expect(r.disponivel).toBe(true);
    expect(r.cobertura).toBe('parcial');
    expect(r.warnings).toContain(WARN_COBERTURA_PARCIAL_INICIO);
  });

  it('consulta no dia do newestDate => disponivel, porem cobertura parcial', () => {
    const r = calcularConsulta(orders, P('2026-08-03', '2026-08-03'), COBERTURA_REAL);
    expect(r.disponivel).toBe(true);
    expect(r.cobertura).toBe('parcial');
    expect(r.warnings).toContain(WARN_COBERTURA_PARCIAL_FIM);
  });

  it('periodo invalido => indisponivel com warning periodo_invalido', () => {
    const r = calcularConsulta(orders, P('2026-02-30', '2026-03-01'), COBERTURA_REAL);
    expect(r.disponivel).toBe(false);
    expect(r.warnings).toContain('periodo_invalido');
  });

  it('from > to => periodo invalido', () => {
    const r = calcularConsulta(orders, P('2026-07-25', '2026-07-20'), COBERTURA_REAL);
    expect(r.disponivel).toBe(false);
    expect(r.warnings).toContain('periodo_invalido');
  });

  it('partial true propaga warning mantendo os numeros', () => {
    const r = calcularConsulta(orders, P('2026-07-22', '2026-07-23'), { ...COBERTURA_REAL, partial: true });
    expect(r.disponivel).toBe(true);
    expect(r.metricas?.pedidos).toBe(2);
    expect(r.warnings).toContain(WARN_SNAPSHOT_PARCIAL);
  });
});

describe('sales-metrics — calcularComparacao', () => {
  // semana atual (seg-dom): 2026-07-20 a 2026-07-26
  // semana anterior:        2026-07-13 a 2026-07-19
  const orders = [
    ped({ id: 1, date_created: '2026-07-21T12:00:00.000-03:00', paid_amount: 300, order_items: [item(3)] }),
    ped({ id: 2, date_created: '2026-07-14T12:00:00.000-03:00', paid_amount: 100, order_items: [item(1)] }),
    ped({ id: 3, date_created: '2026-07-15T12:00:00.000-03:00', paid_amount: 100, order_items: [item(1)] }),
  ];

  it('compara duas semanas com variacao absoluta e percentual', () => {
    const c = calcularComparacao(orders, P('2026-07-20', '2026-07-26'), P('2026-07-13', '2026-07-19'), COBERTURA_REAL);
    expect(c.atual.metricas).toEqual({ receita: 300, pedidos: 1, ticketMedio: 300, unidades: 3 });
    expect(c.anterior.metricas).toEqual({ receita: 200, pedidos: 2, ticketMedio: 100, unidades: 2 });
    expect(c.variacao?.receitaAbs).toBe(100);
    expect(c.variacao?.receitaPct).toBeCloseTo(50, 6);
    expect(c.variacao?.pedidosAbs).toBe(-1);
    expect(c.variacao?.pedidosPct).toBeCloseTo(-50, 6);
    expect(c.variacao?.unidadesAbs).toBe(1);
  });

  it('base zero => percentual null (sem Infinity nem 100% inventado)', () => {
    const c = calcularComparacao(orders, P('2026-07-20', '2026-07-26'), P('2026-07-06', '2026-07-12'), COBERTURA_REAL);
    expect(c.anterior.metricas?.receita).toBe(0);
    expect(c.variacao?.receitaAbs).toBe(300);
    expect(c.variacao?.receitaPct).toBeNull();
  });

  it('lado indisponivel => variacao null (nao compara contra lacuna)', () => {
    const c = calcularComparacao(orders, P('2026-07-20', '2026-07-26'), P('2025-01-01', '2025-01-07'), COBERTURA_REAL);
    expect(c.anterior.disponivel).toBe(false);
    expect(c.variacao).toBeNull();
  });
});

describe('sales-metrics — pureza e nao-mutacao', () => {
  it('nao muta a lista de pedidos recebida', () => {
    const orders = [ped({ id: 1, paid_amount: 100 })];
    const copia = JSON.parse(JSON.stringify(orders));
    calcularConsulta(orders, P('2026-07-10', '2026-07-10'), COBERTURA_REAL);
    expect(orders).toEqual(copia);
  });

  it('nao expoe PII: o resultado contem apenas numeros e metadados', () => {
    const orders = [ped({ id: 1, buyer: { nickname: 'COMPRADOR_X' }, shipping: { id: 9, logistic_type: 'full' } })];
    const r = calcularConsulta(orders, P('2026-07-10', '2026-07-10'), COBERTURA_REAL);
    const s = JSON.stringify(r);
    expect(s).not.toContain('COMPRADOR_X');
    expect(s).not.toContain('nickname');
    expect(s).not.toContain('shipping');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Janela conhecida = ultimo pedido OU ultima sincronizacao bem-sucedida
// ──────────────────────────────────────────────────────────────────────────
// O caso que motivou isto: de manha, antes da primeira venda do dia, o ultimo
// pedido e de ontem. Sem lastSyncAt, "quanto vendi hoje?" respondia cobertura
// indisponivel — "nao sei" — quando a resposta correta e "nada ainda".
// ══════════════════════════════════════════════════════════════════════════
describe('avaliarCobertura — janela estendida pela sincronizacao', () => {
  // Ultimo pedido em 03/08; sincronizacao concluida em 05/08 as 10:29 BRT.
  const SINCRONIZADO_ATE_05: CoberturaSnapshot = {
    ...COBERTURA_REAL,
    lastSyncAt: '2026-08-05T13:29:00.000Z',
    lastResult: 'sem_novos',
  };

  it('dia varrido SEM vendas e coberto (parcial), nao indisponivel', () => {
    const r = avaliarCobertura({ fromYmd: '2026-08-05', toYmd: '2026-08-05' }, SINCRONIZADO_ATE_05);
    expect(r.tipo).toBe('parcial');
    expect(r.periodoEfetivo).toEqual({ fromYmd: '2026-08-05', toYmd: '2026-08-05' });
    // Parcial porque o dia ainda nao terminou quando a varredura rodou.
    expect(r.ultimoDiaIncompleto).toBe(true);
    expect(r.warnings).toContain(WARN_COBERTURA_PARCIAL_FIM);
  });

  it('sem lastSyncAt o MESMO dia continua indisponivel (comportamento anterior)', () => {
    const r = avaliarCobertura({ fromYmd: '2026-08-05', toYmd: '2026-08-05' }, COBERTURA_REAL);
    expect(r.tipo).toBe('indisponivel');
    expect(r.periodoEfetivo).toBeNull();
  });

  it('dia entre o ultimo pedido e a sincronizacao tambem e coberto', () => {
    const r = avaliarCobertura({ fromYmd: '2026-08-04', toYmd: '2026-08-04' }, SINCRONIZADO_ATE_05);
    expect(r.tipo).toBe('total');            // dia inteiro varrido, sem vendas
    expect(r.periodoEfetivo).toEqual({ fromYmd: '2026-08-04', toYmd: '2026-08-04' });
  });

  it('lastResult de FALHA nao estende a janela — nunca afirmar cobertura inexistente', () => {
    for (const lastResult of ['erro_parcial', 'parcial', 'sync_em_andamento', 'job_em_andamento']) {
      const r = avaliarCobertura(
        { fromYmd: '2026-08-05', toYmd: '2026-08-05' },
        { ...SINCRONIZADO_ATE_05, lastResult }
      );
      expect(r.tipo, lastResult).toBe('indisponivel');
    }
  });

  it("'ok' e 'sem_novos' sao ambos sucesso e estendem a janela", () => {
    for (const lastResult of ['ok', 'sem_novos']) {
      const r = avaliarCobertura(
        { fromYmd: '2026-08-05', toYmd: '2026-08-05' },
        { ...SINCRONIZADO_ATE_05, lastResult }
      );
      expect(r.tipo, lastResult).not.toBe('indisponivel');
    }
  });

  it('sincronizacao ANTERIOR ao ultimo pedido nao encurta a janela', () => {
    const r = avaliarCobertura(
      { fromYmd: '2026-08-03', toYmd: '2026-08-03' },
      { ...COBERTURA_REAL, lastSyncAt: '2026-07-01T12:00:00.000Z', lastResult: 'ok' }
    );
    expect(r.tipo).not.toBe('indisponivel');
    expect(r.dadosAteYmd).toBe('2026-08-03');
  });

  it('dia POSTERIOR a sincronizacao continua indisponivel', () => {
    const r = avaliarCobertura({ fromYmd: '2026-08-06', toYmd: '2026-08-06' }, SINCRONIZADO_ATE_05);
    expect(r.tipo).toBe('indisponivel');
  });

  it('sem pedido algum, a sincronizacao sozinha nao inventa janela de inicio', () => {
    const r = avaliarCobertura(
      { fromYmd: '2026-08-05', toYmd: '2026-08-05' },
      { oldestDate: null, newestDate: null, partial: false, lastSyncAt: '2026-08-05T13:29:00.000Z', lastResult: 'ok' }
    );
    expect(r.tipo).toBe('indisponivel');
  });

  it('metricas do dia varrido sem vendas: zero de verdade, nao ausencia de dado', () => {
    const r = calcularConsulta([], { fromYmd: '2026-08-05', toYmd: '2026-08-05' }, SINCRONIZADO_ATE_05);
    expect(r.disponivel).toBe(true);
    expect(r.metricas?.receita).toBe(0);
    expect(r.metricas?.pedidos).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Comparacao com cobertura DESIGUAL — o caso dos +160.030,95%
// ──────────────────────────────────────────────────────────────────────────
// O snapshot comeca em 13/08/2025. "Este ano vs ano passado" comparava 8 meses
// de 2026 contra DOIS DIAS de 2025 e devolvia uma variacao de seis digitos:
// aritmeticamente correta, informativamente falsa. Aqui a variacao e suprimida.
// ══════════════════════════════════════════════════════════════════════════
describe('calcularComparacao — cobertura desigual suprime a variacao', () => {
  // Dados a partir de 13/08/2025, como no snapshot real.
  const DESDE_AGOSTO: CoberturaSnapshot = {
    oldestDate: '2025-08-13T18:12:01.000-04:00',
    newestDate: '2026-08-13T09:13:15.000-04:00',
    partial: false,
  };
  const pedido = (data: string, valor: number): OrderSlim => ({
    id: 'o' + data + valor, status: 'paid', date_created: data,
    paid_amount: valor, total_amount: null,
    order_items: [{ quantity: 1, unit_price: valor, item: { id: 'MLB1', title: 'X', seller_sku: null, variation_id: null } }],
  } as OrderSlim);

  const ANO_ATUAL = { fromYmd: '2026-01-01', toYmd: '2026-08-14' };
  const ANO_ANTERIOR = { fromYmd: '2025-01-01', toYmd: '2025-08-14' };

  it('ano inteiro contra dois dias NAO produz variacao percentual', () => {
    const orders = [pedido('2026-03-01T12:00:00.000Z', 345242), pedido('2025-08-14T12:00:00.000Z', 215)];
    const r = calcularComparacao(orders, ANO_ATUAL, ANO_ANTERIOR, DESDE_AGOSTO);
    expect(r.comparavel).toBe(false);
    expect(r.variacao).toBeNull();
    expect(r.warnings).toContain(WARN_COMPARACAO_DESIGUAL);
  });

  it('os valores absolutos dos DOIS lados continuam disponiveis', () => {
    const orders = [pedido('2026-03-01T12:00:00.000Z', 345242), pedido('2025-08-14T12:00:00.000Z', 215)];
    const r = calcularComparacao(orders, ANO_ATUAL, ANO_ANTERIOR, DESDE_AGOSTO);
    // Suprimir a variacao NAO pode esconder os fatos.
    expect(r.atual.metricas?.receita).toBe(345242);
    expect(r.anterior.metricas?.receita).toBe(215);
  });

  it('a fracao coberta de cada lado e reportada, para explicar a recusa', () => {
    const r = calcularComparacao([], ANO_ATUAL, ANO_ANTERIOR, DESDE_AGOSTO);
    expect(r.cobertura.atual).toBeGreaterThan(0.99);
    expect(r.cobertura.anterior).toBeLessThan(0.02);   // 2 dias de ~226
  });

  it('periodos AMBOS bem cobertos continuam comparaveis normalmente', () => {
    const orders = [pedido('2026-07-10T12:00:00.000Z', 200), pedido('2026-06-10T12:00:00.000Z', 100)];
    const r = calcularComparacao(
      orders, { fromYmd: '2026-07-01', toYmd: '2026-07-31' }, { fromYmd: '2026-06-01', toYmd: '2026-06-30' },
      DESDE_AGOSTO
    );
    expect(r.comparavel).toBe(true);
    expect(r.variacao?.receitaPct).toBeCloseTo(100, 6);
    expect(r.warnings).toHaveLength(0);
  });

  it('no limite exato de cobertura a comparacao AINDA vale', () => {
    // Lado anterior coberto em 70% dos dias solicitados.
    const cobertura: CoberturaSnapshot = {
      oldestDate: '2026-06-08T00:00:00.000-03:00',   // dia 8 => 23 de 30 dias ~ 76%
      newestDate: '2026-07-31T23:59:59.999-03:00',
      partial: false,
    };
    const r = calcularComparacao(
      [], { fromYmd: '2026-07-01', toYmd: '2026-07-31' }, { fromYmd: '2026-06-01', toYmd: '2026-06-30' },
      cobertura
    );
    expect(r.cobertura.anterior).toBeGreaterThanOrEqual(COBERTURA_MINIMA_COMPARACAO);
    expect(r.comparavel).toBe(true);
  });

  it('lado indisponivel continua sem variacao e marcado como nao comparavel', () => {
    const r = calcularComparacao([], ANO_ATUAL, { fromYmd: '2020-01-01', toYmd: '2020-12-31' }, DESDE_AGOSTO);
    expect(r.variacao).toBeNull();
    expect(r.comparavel).toBe(false);
  });
});