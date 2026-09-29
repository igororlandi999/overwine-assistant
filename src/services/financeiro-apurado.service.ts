/**
 * financeiro-apurado.service — tarifa e frete REAIS de um período, lidos dos
 * próprios pedidos e envios, com a COBERTURA declarada.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TRÊS COISAS DIFERENTES QUE NÃO PODEM SER CONFUNDIDAS
 *
 * 1. VALOR REAL, que o Mercado Livre informa e que é de cada conta:
 *    - `order_items[].sale_fee` — a tarifa de venda cobrada naquele item;
 *    - `custoFrete` do envio — o que o vendedor pagou, lido de
 *      GET /shipments/{id}/costs e guardado no mapa `ship:logi` da conta.
 *    É o que este serviço soma.
 *
 * 2. ESTIMATIVA DA OVERWINE (`config/taxas.json`): 14,8% e 14,4% sobre o
 *    bruto, médias de uma planilha da Overwine. Valem para a Overwine e só
 *    para ela. Este serviço NÃO as usa, nem como reserva.
 *
 * 3. CUSTO DE PRODUTO (`config/custos.json`): quanto a empresa pagou pela
 *    garrafa. Não existe em pedido nem em envio; precisa ser cadastrado. Sem
 *    ele a MARGEM não existe, mas a receita líquida de tarifa e frete existe.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * COBERTURA
 *
 * Um pedido sincronizado antes de o snapshot guardar `sale_fee` não tem a
 * tarifa; um envio ainda não resolvido não tem o frete. O que se conhece é um
 * SUBTOTAL. Ele sai em `conhecida`/`conhecido`, com a fração da receita que
 * cobre, e o total (`valor`) só é preenchido quando a cobertura é de 100%.
 * Um subtotal nunca é apresentado como total.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A TARIFA SÓ É APRESENTADA DEPOIS DE VALIDADA
 *
 * `sale_fee × quantity` ainda NÃO foi comparado com a tarifa que o Mercado
 * Livre mostra no detalhe de uma venda. Enquanto `TARIFA_REAL_VALIDADA` não
 * for `"true"` no ambiente, a tarifa sai como NÃO VALIDADA: `valor` nulo,
 * cobertura zero, `validada: false` — e o líquido, que depende dela, também
 * não sai. O frete real não depende disso e continua sendo apresentado.
 * O snapshot guarda o `sale_fee` de qualquer forma, para que ligar a variável
 * não exija recarregar pedidos.
 *
 * COBERTURA NÃO É VALIDAÇÃO
 *
 * São duas perguntas diferentes, e a resposta sai em campos diferentes:
 *  - COBERTURA: o pedido TRAZ o dado? (`completa`, `fracao`, `pedidosCobertos`)
 *  - VALIDAÇÃO: o cálculo feito com esse dado foi CONFERIDO contra o que o
 *    Mercado Livre mostra? (`ressalvaReembolso`, `integralmenteValidado`)
 *
 * Para venda comum a tarifa foi conferida (29/09/2026, venda com 2 unidades).
 *
 * Pedido com REEMBOLSO PARCIAL NÃO ESTÁ CONCILIADO. O que este serviço soma
 * para ele é o que o pedido e o envio trazem: a tarifa ORIGINAL e o frete de
 * IDA. Numa venda conferida na tela do Mercado Livre (30/09/2026) a tarifa
 * original bateu, mas a tela trazia ainda frete de DEVOLUÇÃO e um débito de
 * "cancelamento de tarifa" que não existem em nenhum campo lido aqui, e o
 * total exibido era NEGATIVO enquanto o calculado aqui era positivo.
 *
 * Consequências, todas deliberadas:
 *  - esses pedidos ficam no total (tirá-los deixaria o total sem eles), e o
 *    líquido da seleção sai marcado PROVISÓRIO;
 *  - a ressalva diz o que ESTÁ incluído e o que NÃO está. Não estima a
 *    diferença nem lhe dá teto: ela não é conhecida;
 *  - o frete também leva a ressalva: o valor é só o de ida;
 *  - nenhuma regra geral e nenhum ajuste fixo saem de uma tela só.
 * `TARIFA_REEMBOLSO_VALIDADA` continua existindo e continua desligada; ligá-la
 * exige conciliar reembolsos por tipo, não um pedido.
 *
 * `sale_fee` É POR UNIDADE
 *
 * O Mercado Livre devolve em `sale_fee` a tarifa de UMA unidade do item; a
 * tarifa da linha é `sale_fee × quantity`. Conferido em 29/09/2026 contra 85
 * pedidos reais com mais de uma unidade: a razão por unidade cai na faixa de
 * comissão (10% a 20%) ou abaixo dela; a razão pelo total da linha, nunca.
 * Detalhe no README, "Perfil financeiro, e o que é real".
 */
import type { EnvioInfo } from '../lib/shipping-store.js';
import { contaComoVenda, ehReembolsoParcial } from '../lib/status-venda.js';
import type { OrderSlim } from './orders.service.js';

export interface ParcelaApurada {
  /**
   * Total do período. `null` enquanto a cobertura não for completa. Sinal
   * NEGATIVO, como em faturamentoPeriodo: é dedução do bruto.
   */
  valor: number | null;
  /** Soma do que se conhece (≤ 0). Subtotal — NÃO é o total quando `completa` é false. */
  conhecida: number;
  /** Receita bruta dos pedidos cuja parcela é conhecida. */
  receitaCoberta: number;
  /** receitaCoberta / bruto. 1 quando o bruto é zero (nada a cobrir). */
  fracao: number;
  completa: boolean;
  /** Pedidos do período com a parcela conhecida, e o total de pedidos. */
  pedidosCobertos: number;
  pedidosTotal: number;
  /**
   * `false` = o cálculo existe mas não foi conferido contra o Mercado Livre,
   * e por isso não é apresentado. Só a tarifa usa; no frete é sempre `true`.
   */
  validada: boolean;
}

/** A tarifa de pedido com reembolso parcial foi conferida contra o Mercado Livre? */
export function tarifaDeReembolsoValidada(): boolean {
  return process.env.TARIFA_REEMBOLSO_VALIDADA === 'true';
}

/**
 * O pedido teve devolução de parte do valor? O status é o sinal principal; a
 * diferença entre pago e total cobre o caso em que o status ainda não mudou.
 * Na dúvida marca: uma ressalva a mais é o lado seguro.
 */
export function teveReembolso(o: Pick<OrderSlim, 'status' | 'paid_amount' | 'total_amount'>): boolean {
  if (ehReembolsoParcial(o.status)) return true;
  const pago = o.paid_amount, total = o.total_amount;
  return typeof pago === 'number' && typeof total === 'number' && pago > 0 && pago < total - 0.005;
}

/** O que o financeiro de um pedido com reembolso NÃO inclui, porque nenhum campo lido o traz. */
export const NAO_INCLUIDO_EM_REEMBOLSO = [
  'frete_de_devolucao',
  'ajustes_de_cancelamento',
] as const;

export interface RessalvaReembolso {
  /** Pedidos do período com reembolso parcial que entraram no total. */
  pedidos: number;
  /** Receita (já líquida do reembolso) desses pedidos. */
  receita: number;
  /** Tarifa ORIGINAL desses pedidos (≤ 0). Está INCLUÍDA no total. Não é a diferença possível. */
  tarifaCalculada: number;
  /** Frete de IDA desses pedidos (≤ 0), onde conhecido. Está INCLUÍDO. Não tem a devolução. */
  freteCalculado: number;
  /** O que falta, por nome. A diferença em dinheiro NÃO é conhecida e não é estimada. */
  naoInclui: readonly string[];
  /** `true` só quando reembolsos foram conciliados: a ressalva não se aplica. */
  validada: boolean;
}

/** A tarifa calculada foi conferida contra o Mercado Livre e pode ser apresentada? */
export function tarifaRealValidada(): boolean {
  return process.env.TARIFA_REAL_VALIDADA === 'true';
}

export interface FinanceiroApurado {
  metodo: 'apurado_pedidos_envios';
  bruto: number;
  pedidos: number;
  tarifaML: ParcelaApurada;
  frete: ParcelaApurada;
  /** bruto + tarifaML + frete. `null` enquanto qualquer das duas não for completa. */
  liquido: number | null;
  /**
   * Líquido só dos pedidos em que tarifa E frete são conhecidos, com a receita
   * deles. Serve para mostrar "o que já se sabe"; nunca substitui `liquido`.
   */
  liquidoConhecido: { valor: number; receitaCoberta: number; fracao: number; pedidos: number };
  /** Pedidos com reembolso parcial dentro do total. `pedidos: 0` = nada a ressalvar. */
  ressalvaReembolso: RessalvaReembolso;
  /**
   * `true` só quando tarifa e líquido estão completos E nenhum valor do total
   * depende de regra ainda não conferida. Cobertura completa com ressalva é
   * `false`: o número existe, mas não é integralmente validado.
   */
  integralmenteValidado: boolean;
  /**
   * `true` quando o líquido existe mas inclui pedido com reembolso não
   * conciliado: é o melhor número disponível, não o definitivo.
   */
  liquidoProvisorio: boolean;
}

function dentro(iso: string | null, inicio: Date | null, fim: Date | null): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  if (inicio && t < inicio.getTime()) return false;
  if (fim && t > fim.getTime()) return false;
  return true;
}

function shipmentId(o: OrderSlim): string | null {
  const id = o.shipping?.id;
  if (id === null || id === undefined) return null;
  const s = String(id).trim();
  return s === '' ? null : s;
}

const receitaDoPedido = (o: OrderSlim): number => o.paid_amount || o.total_amount || 0;
const receitaItens = (o: OrderSlim): number =>
  o.order_items.reduce((s, oi) => s + (oi.unit_price ?? 0) * (oi.quantity ?? 0), 0);

/** Tarifa de venda do pedido, ou `null` se algum item não a traz. */
export function tarifaDoPedido(o: OrderSlim): number | null {
  if (o.order_items.length === 0) return null;
  let total = 0;
  for (const oi of o.order_items) {
    const f = oi.sale_fee;
    if (typeof f !== 'number' || !Number.isFinite(f) || f < 0) return null;
    total += f * (oi.quantity ?? 1);
  }
  return total;
}

/**
 * Apura tarifa e frete do período. `pedidos` é a base INTEIRA da conta (não só
 * a do período): o frete de um envio é rateado entre todos os pedidos dele,
 * por receita, para que um carrinho que atravessa a borda do período não
 * carregue o frete inteiro de um lado só — a mesma regra de
 * shipping-logistics (rateio por envio).
 */
export function apurarFinanceiro(
  pedidos: readonly OrderSlim[],
  inicio: Date | null,
  fim: Date | null,
  mapaEnvios: ReadonlyMap<string, EnvioInfo>
): FinanceiroApurado {
  // Denominador do rateio: receita de itens de TODAS as vendas de cada envio.
  const basePorEnvio = new Map<string, number>();
  const pedidosPorEnvio = new Map<string, number>();
  for (const o of pedidos) {
    if (!contaComoVenda(o.status)) continue;
    const sid = shipmentId(o);
    if (sid === null) continue;
    basePorEnvio.set(sid, (basePorEnvio.get(sid) ?? 0) + receitaItens(o));
    pedidosPorEnvio.set(sid, (pedidosPorEnvio.get(sid) ?? 0) + 1);
  }

  const validada = tarifaRealValidada();
  let bruto = 0, n = 0;
  let tarifa = 0, tarifaReceita = 0, tarifaPedidos = 0;
  let frete = 0, freteReceita = 0, fretePedidos = 0;
  let liqConhecido = 0, liqReceita = 0, liqPedidos = 0;
  let reembPedidos = 0, reembReceita = 0, reembTarifa = 0, reembFrete = 0;

  for (const o of pedidos) {
    if (!contaComoVenda(o.status)) continue;
    if (!dentro(o.date_created, inicio, fim)) continue;
    const receita = receitaDoPedido(o);
    bruto += receita;
    n++;

    const t = validada ? tarifaDoPedido(o) : null;
    if (t !== null) { tarifa += t; tarifaReceita += receita; tarifaPedidos++; }

    // Frete: pedido sem envio não tem frete (0, conhecido). Com envio, vale o
    // custo real do mapa, rateado pela receita dos pedidos daquele envio.
    let f: number | null;
    const sid = shipmentId(o);
    if (sid === null) f = 0;
    else {
      const custo = mapaEnvios.get(sid)?.custoFrete;
      if (typeof custo !== 'number' || !Number.isFinite(custo)) f = null;
      else {
        const base = basePorEnvio.get(sid) ?? 0;
        const partes = pedidosPorEnvio.get(sid) ?? 1;
        f = base > 0 ? custo * (receitaItens(o) / base) : custo / partes;
      }
    }
    if (f !== null) { frete += f; freteReceita += receita; fretePedidos++; }
    // Reembolso: conta o pedido mesmo sem tarifa ou frete conhecidos — o que
    // não está conciliado é o PEDIDO, não uma parcela.
    if (teveReembolso(o)) { reembPedidos++; reembReceita += receita; reembTarifa += t ?? 0; reembFrete += f ?? 0; }

    if (t !== null && f !== null) { liqConhecido += receita - t - f; liqReceita += receita; liqPedidos++; }
  }

  const parcela = (soma: number, receita: number, cobertos: number, ok = true): ParcelaApurada => {
    const completa = ok && cobertos === n;
    return {
      validada: ok,
      valor: completa ? -soma : null,
      conhecida: -soma,
      receitaCoberta: receita,
      fracao: bruto > 0 ? receita / bruto : 1,
      completa,
      pedidosCobertos: cobertos,
      pedidosTotal: n,
    };
  };
  const pT = parcela(tarifa, tarifaReceita, tarifaPedidos, validada);
  const pF = parcela(frete, freteReceita, fretePedidos);

  const reembOk = tarifaDeReembolsoValidada();
  const liquido = pT.completa && pF.completa ? bruto - tarifa - frete : null;
  return {
    metodo: 'apurado_pedidos_envios',
    bruto,
    pedidos: n,
    tarifaML: pT,
    frete: pF,
    ressalvaReembolso: {
      pedidos: reembPedidos, receita: reembReceita, tarifaCalculada: -reembTarifa, freteCalculado: -reembFrete,
      naoInclui: reembPedidos > 0 && !reembOk ? NAO_INCLUIDO_EM_REEMBOLSO : [], validada: reembOk,
    },
    integralmenteValidado: liquido !== null && (reembPedidos === 0 || reembOk),
    liquidoProvisorio: liquido !== null && reembPedidos > 0 && !reembOk,
    liquido,
    liquidoConhecido: {
      valor: liqConhecido,
      receitaCoberta: liqReceita,
      fracao: bruto > 0 ? liqReceita / bruto : 1,
      pedidos: liqPedidos,
    },
  };
}
