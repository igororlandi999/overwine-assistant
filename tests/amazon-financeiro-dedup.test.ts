/**
 * Financeiro Amazon: uma ocorrência econômica por lançamento.
 *
 * A Finances API representa uma venda retida e depois liberada com duas
 * transações de mesmo valor (DEFERRED_RELEASED + RELEASED). Estes testes
 * fixam que o dinheiro conta uma vez, que retido continua retido, que
 * etiqueta de envio é custo logístico (não reembolso) e que repasse
 * (Transfer/Disbursement) fica fora de receita e despesa.
 *
 * Nenhum dado real da conta está aqui: a regressão de outubro usa pedidos
 * SINTÉTICOS montados para somar os mesmos agregados apurados em produção
 * em 21/10/2026 (80 pedidos, R$ 8.488,87 faturados, R$ 6.644,98 lançados).
 */
import { describe, it, expect } from 'vitest';
import { transacoesEconomicas, categoriaDaTransacao, apurarPedido, type TransacaoAmazon } from '../src/amazon/financeiro.js';
import { financeiroAmazonDoPeriodo, debitosPorPedido } from '../src/amazon/leitura.js';

const BR = 'A2Q3Y263D00KWC';
const PERIODO = { ini: new Date('2026-10-01T03:00:00Z'), fim: new Date('2026-11-01T02:59:59Z') };
const COB = { desde: '2026-04-23T00:00:00Z', ate: '2026-10-21T12:00:00Z' };

interface Opc {
  tipo?: string; status?: string; descricao?: string | null; em?: string;
  liberacao?: string; original?: string; tarifas?: number;
}
function tx(id: string, pedido: string | null, total: number, o: Opc = {}): TransacaoAmazon {
  const ids: Array<{ nome: string; valor: string }> = [];
  if (pedido) ids.push({ nome: 'ORDER_ID', valor: pedido });
  if (o.liberacao) ids.push({ nome: 'RELEASE_TRANSACTION_ID', valor: o.liberacao });
  if (o.original) ids.push({ nome: 'DEFERRED_TRANSACTION_ID', valor: o.original });
  const composicao = o.tarifas === undefined ? [] : [
    { tipo: 'Sales', valor: { valor: Math.round((total - o.tarifas) * 100) / 100, moeda: 'BRL' }, partes: [] },
    { tipo: 'Expenses', valor: { valor: o.tarifas, moeda: 'BRL' }, partes: [
      { tipo: 'AmazonFees', valor: { valor: o.tarifas, moeda: 'BRL' }, partes: [
        { tipo: 'Commission', valor: { valor: o.tarifas, moeda: 'BRL' }, partes: [] },
      ] },
    ] },
  ];
  return {
    canal: 'amazon', conta: 'alemmar-amazon', transactionId: id,
    tipo: o.tipo ?? 'Shipment', status: o.status ?? 'RELEASED', descricao: o.descricao ?? null,
    lancadaEm: o.em ?? '2026-10-10T12:00:00Z', total: { valor: total, moeda: 'BRL' },
    pedidoId: pedido, identificadores: ids, marketplaceId: BR, composicao,
  };
}
/** Par da API: original liberada + liberação, mesmo valor, ligados pelos dois identificadores. */
function par(base: string, pedido: string | null, total: number, o: Omit<Opc, 'status' | 'liberacao' | 'original'> = {}): TransacaoAmazon[] {
  return [
    tx(base + '-orig', pedido, total, { ...o, status: 'DEFERRED_RELEASED', liberacao: base + '-lib' }),
    tx(base + '-lib', pedido, total, { ...o, status: 'RELEASED', original: base + '-orig', em: '2026-10-18T12:00:00Z' }),
  ];
}
const venda = (id: string, pago: number) => ({ id, date_created: '2026-10-10T12:00:00Z', paid_amount: pago });

describe('1. par DEFERRED_RELEASED + RELEASED', () => {
  it('conta o dinheiro uma vez e fica a transação original', () => {
    const ts = par('T1', '701-1', 107.57, { tarifas: -26.19 });
    const e = transacoesEconomicas(ts);
    expect(e.transacoes.map(t => t.transactionId)).toEqual(['T1-orig']);
    expect([e.duplicidadesRemovidas, e.paresDivergentes]).toEqual([1, 0]);
    const f = financeiroAmazonDoPeriodo([venda('701-1', 133.76)], ts, COB, PERIODO);
    expect(f.lancadoDessasVendas).toBe(107.57);
    expect(f.porCategoria).toEqual({ vendas: 107.57, tarifasAmazon: -26.19, reembolsos: 0, custoEnvio: 0, outros: 0 });
    expect(f.retidas).toBe(0);
    expect(apurarPedido({ orderId: '701-1', criadoEm: '2026-10-10T12:00:00Z' }, ts, COB)).toMatchObject({ liquidoRecebido: { valor: 107.57, moeda: 'BRL' }, transacoes: 1 });
  });
  it('liga o par também só por um dos lados (RELEASE_TRANSACTION_ID ou DEFERRED_TRANSACTION_ID)', () => {
    const [orig, lib] = par('T2', '701-2', 50);
    const soOriginal = [orig, { ...lib, identificadores: lib.identificadores.filter(i => i.nome !== 'DEFERRED_TRANSACTION_ID') }];
    const soLiberacao = [{ ...orig, identificadores: orig.identificadores.filter(i => i.nome !== 'RELEASE_TRANSACTION_ID') }, lib];
    expect(transacoesEconomicas(soOriginal).transacoes).toHaveLength(1);
    expect(transacoesEconomicas(soLiberacao).transacoes).toHaveLength(1);
  });
  it('liberação sem a original na coleção (lida fora da janela) fica: dinheiro nunca some', () => {
    const [, lib] = par('T3', '701-3', 80);
    expect(transacoesEconomicas([lib]).transacoes).toEqual([lib]);
  });
  it('par ligado com valor diferente: mantém os dois e aponta, sem escolher por palpite', () => {
    const [orig, lib] = par('T4', '701-4', 80);
    const e = transacoesEconomicas([orig, { ...lib, total: { valor: 79, moeda: 'BRL' } }]);
    expect([e.transacoes.length, e.duplicidadesRemovidas, e.paresDivergentes]).toEqual([2, 0, 1]);
  });
  it('idempotente: deduplicar o resultado não muda nada', () => {
    const e = transacoesEconomicas([...par('T5', '701-5', 10), ...par('T6', '701-6', 20)]);
    expect(transacoesEconomicas(e.transacoes)).toMatchObject({ transacoes: e.transacoes, duplicidadesRemovidas: 0 });
  });
});

describe('2. lançamento apenas retido', () => {
  it('DEFERRED sem liberação conta uma vez e continua retido', () => {
    const ts = [tx('R1', '701-7', 120.5, { status: 'DEFERRED', tarifas: -20 })];
    const f = financeiroAmazonDoPeriodo([venda('701-7', 140.5)], ts, COB, PERIODO);
    expect([f.lancadoDessasVendas, f.retidas, f.duplicidadesRemovidas]).toEqual([120.5, 1, 0]);
  });
  it('retida cuja liberação já chegou mas o status ainda não foi relido: conta uma vez (como retida)', () => {
    const [orig, lib] = par('R2', '701-8', 60);
    const f = financeiroAmazonDoPeriodo([venda('701-8', 70)], [{ ...orig, status: 'DEFERRED' }, lib], COB, PERIODO);
    expect([f.lancadoDessasVendas, f.retidas, f.duplicidadesRemovidas]).toEqual([60, 1, 1]);
  });
});

describe('3. reembolso', () => {
  it('reembolso em par conta uma vez como débito e como reembolso', () => {
    const ts = [tx('V1', '701-9', 100), ...par('D1', '701-9', -89.88, { tipo: 'Refund', descricao: 'Refund' })];
    const f = financeiroAmazonDoPeriodo([venda('701-9', 110)], ts, COB, PERIODO);
    expect(f.debitos).toEqual({ pedidos: 1, valor: -89.88 });
    expect(f.porCategoria.reembolsos).toBe(-89.88);
    expect(f.lancadoDessasVendas).toBe(10.12);
    expect(debitosPorPedido(ts).get('701-9')).toMatchObject({ valor: -89.88, descricoes: ['Refund'] });
  });
});

describe('4. MfnPostageFee', () => {
  it('é custo de envio, entra no lançado e NÃO é débito de reembolso', () => {
    const ts = [tx('V2', '701-10', 90), tx('E1', '701-10', -13, { tipo: 'ServiceFee', descricao: 'MfnPostageFee' })];
    expect(categoriaDaTransacao(ts[1])).toBe('custo_envio');
    const f = financeiroAmazonDoPeriodo([venda('701-10', 100)], ts, COB, PERIODO);
    expect(f.custoEnvio).toEqual({ pedidos: 1, valor: -13 });
    expect(f.porCategoria).toMatchObject({ custoEnvio: -13, reembolsos: 0 });
    expect(f.debitos).toEqual({ pedidos: 0, valor: 0 });
    expect(f.lancadoDessasVendas).toBe(77);
  });
});

describe('5. Transfer / Disbursement', () => {
  it('repasse fica separado: fora dos lançamentos operacionais sem pedido', () => {
    const ts = [
      tx('X1', null, 4136.85, { tipo: 'Transfer', descricao: 'Disbursement' }),
      tx('X2', null, -676.49, { tipo: 'ProductAdsPayment', descricao: 'ProductAdsPayment' }),
      tx('X3', null, 0, { tipo: 'ServiceFee', descricao: 'FBAStorageBilling' }),
    ];
    expect(categoriaDaTransacao(ts[0])).toBe('repasse');
    const f = financeiroAmazonDoPeriodo([], ts, COB, PERIODO);
    expect(f.repasses).toEqual({ quantidade: 1, valor: 4136.85 });
    expect(f.lancamentosSemPedido).toEqual({ quantidade: 2, valor: -676.49 });
  });
});

describe('6. cenário sem duplicação', () => {
  it('só lançamentos independentes: mesmo resultado de antes (soma simples)', () => {
    const ts = [tx('S1', '701-11', 84.91), tx('S2', '701-11', -30), tx('S3', null, -19.9)];
    const f = financeiroAmazonDoPeriodo([venda('701-11', 99.9)], ts, COB, PERIODO);
    expect(f).toMatchObject({
      lancadoDessasVendas: 54.91, debitos: { pedidos: 1, valor: -30 },
      lancamentosSemPedido: { quantidade: 1, valor: -19.9 }, repasses: { quantidade: 0, valor: 0 },
      duplicidadesRemovidas: 0, paresDivergentes: 0, conciliado: false,
    });
  });
});

describe('7. regressão com os dados Amazon atuais (agregados de 21/10/2026, pedidos sintéticos)', () => {
  /**
   * Outubro: faturamento 8.488,87; vendas lançadas 7.044,50 (das quais tarifas
   * −1.690,94); reembolsos −386,52 (3 em par de −89,88 e 1 retido de −116,88);
   * etiqueta −13,00; lançado real 6.644,98. Sem pedido no período: repasse
   * +4.136,85, anúncios −1.352,98 e armazenagem 0.
   */
  const pedidos = [venda('701-A', 3000), venda('701-B', 3000), venda('701-C', 1488.87), venda('701-D', 1000)];
  const ts: TransacaoAmazon[] = [
    ...par('VA', '701-A', 2000, { tarifas: -500 }),
    tx('VB', '701-B', 3634.15, { status: 'DEFERRED', tarifas: -700 }),
    ...par('VC', '701-C', 1000, { tarifas: -300 }),
    tx('VD', '701-D', 410.35, { tarifas: -190.94 }),
    ...par('RA', '701-A', -89.88, { tipo: 'Refund', descricao: 'Refund' }),
    ...par('RC', '701-C', -89.88, { tipo: 'Refund', descricao: 'Refund' }),
    tx('RD', '701-D', -89.88, { tipo: 'Refund', descricao: 'Refund' }),
    tx('RB', '701-B', -116.88, { tipo: 'Refund', status: 'DEFERRED', descricao: 'Refund' }),
    tx('EC', '701-C', -13, { tipo: 'ServiceFee', descricao: 'MfnPostageFee' }),
    tx('X1', null, 4136.85, { tipo: 'Transfer', descricao: 'Disbursement' }),
    tx('X2', null, -676.49, { tipo: 'ProductAdsPayment', descricao: 'ProductAdsPayment' }),
    tx('X3', null, -676.49, { tipo: 'ProductAdsPayment', descricao: 'ProductAdsPayment' }),
    tx('X4', null, 0, { tipo: 'ServiceFee', descricao: 'FBAStorageBilling' }),
  ];

  it('valores de outubro após a correção', () => {
    const f = financeiroAmazonDoPeriodo(pedidos, ts, COB, PERIODO);
    expect(f.faturamentoComTransacoes).toBe(8488.87);
    expect(f.lancadoDessasVendas).toBe(6644.98);
    expect(f.porCategoria).toEqual({ vendas: 7044.5, tarifasAmazon: -1690.94, reembolsos: -386.52, custoEnvio: -13, outros: 0 });
    expect(f.custoEnvio).toEqual({ pedidos: 1, valor: -13 });
    expect(f.debitos).toEqual({ pedidos: 4, valor: -386.52 });
    expect(f.retidas).toBe(2);
    expect(f.repasses).toEqual({ quantidade: 1, valor: 4136.85 });
    expect(f.lancamentosSemPedido).toEqual({ quantidade: 3, valor: -1352.98 });
    expect([f.duplicidadesRemovidas, f.paresDivergentes]).toEqual([4, 0]);
    // Composição fecha: vendas + reembolsos + envio + outros = lançado.
    const c = f.porCategoria;
    expect(Math.round((c.vendas + c.reembolsos + c.custoEnvio + c.outros) * 100) / 100).toBe(f.lancadoDessasVendas);
    // Nada de líquido ou margem: o resultado nunca se declara conciliado.
    expect(f.conciliado).toBe(false);
    expect(f).not.toHaveProperty('liquido');
  });

  it('a soma ingênua (comportamento anterior) seria maior: o par contava duas vezes', () => {
    const ingenuo = ts.filter(t => t.pedidoId).reduce((s, t) => s + t.total!.valor, 0);
    expect(Math.round(ingenuo * 100) / 100).toBe(Math.round((6644.98 + 2000 + 1000 - 89.88 - 89.88) * 100) / 100);
  });

  it('padrões da carga de 180 dias: 502 registros, 162 liberações gêmeas, nenhum par divergente', () => {
    // Mesma forma da coleção real: 156 vendas em par, 1 pedido com venda em par
    // + venda retida, 40 vendas só retidas, 5 reembolsos em par, 6 reembolsos
    // liberados sem par, 1 reembolso retido, e lançamentos sem pedido.
    const l: TransacaoAmazon[] = [];
    for (let i = 0; i < 156; i++) l.push(...par('P' + i, 'O' + i, 90 + i));
    l.push(...par('TRI', 'OT', 120), tx('TRI-r', 'OT', 75, { status: 'DEFERRED' }));
    for (let i = 0; i < 40; i++) l.push(tx('D' + i, 'OD' + i, 60, { status: 'DEFERRED' }));
    for (let i = 0; i < 5; i++) l.push(...par('RP' + i, 'O' + i, -100.2, { tipo: 'Refund' }));
    for (let i = 0; i < 6; i++) l.push(tx('RL' + i, 'O' + (10 + i), -50, { tipo: 'Refund' }));
    l.push(tx('RDf', 'O20', -116.88, { tipo: 'Refund', status: 'DEFERRED' }));
    const extras = 502 - l.length;
    for (let i = 0; i < extras; i++) l.push(tx('S' + i, i % 3 ? null : 'O' + i, i % 2 ? -10 : 10, { tipo: i % 5 ? 'ServiceFee' : 'Transfer' }));
    expect(l).toHaveLength(502);
    const e = transacoesEconomicas(l);
    expect([e.duplicidadesRemovidas, e.paresDivergentes, e.transacoes.length]).toEqual([162, 0, 340]);
    expect(e.transacoes.some(t => t.status === 'RELEASED' && t.identificadores.some(i => i.nome === 'DEFERRED_TRANSACTION_ID'))).toBe(false);
  });
});
