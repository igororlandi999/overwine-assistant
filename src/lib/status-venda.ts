/**
 * status-venda — fonte ÚNICA do que conta como venda.
 *
 * Módulo sem dependências, de propósito: qualquer serviço pode importar sem
 * risco de ciclo.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE ISTO EXISTE
 *
 * O código tinha DUAS convenções vivas ao mesmo tempo:
 *
 *   `status !== 'cancelled'`   em vendasPorItem, buildConsolidado e no dashboard
 *   `status === 'paid'`        em sales-metrics, margin-metrics e no ranking
 *
 * Elas divergem por construção, e um número calculado por um caminho não batia
 * com o mesmo número calculado pelo outro. Pior: a divergência era silenciosa —
 * nada no sistema apontava para ela.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A DECISÃO (proprietário, 18/08/2026)
 *
 * "Deve entrar sim, se caiu grana tem que considerar."
 *
 * `partially_refunded` é uma venda que aconteceu e cujo dinheiro entrou, ainda
 * que parte tenha voltado depois. O `paid_amount` desses pedidos JÁ VEM LÍQUIDO
 * do estorno — verificado nos dados reais: o pedido 2000017362256606 registra
 * R$ 30,51 num produto cujo preço unitário é R$ 34,29, valor impossível se o
 * campo fosse o bruto. Somar `paid_amount` é, portanto, somar o que entrou.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LISTA DE PERMISSÃO, NÃO DE EXCLUSÃO
 *
 * `!== 'cancelled'` transforma TODO status desconhecido em receita. Se o
 * Mercado Livre introduzir um status novo — ou se um pedido pendente aparecer
 * na base, o que hoje não acontece —, ele entraria no faturamento sozinho, sem
 * ninguém decidir. A lista de permissão erra para o lado seguro: um status novo
 * fica de fora até alguém olhar e decidir.
 *
 * Nos dados de 18/08/2026 (4.083 pedidos) existem exatamente três status:
 * `paid` (3.767), `cancelled` (300, todos com paid_amount zero) e
 * `partially_refunded` (16). Com esta lista, as duas convenções antigas passam
 * a produzir o MESMO conjunto — nenhum número de dashboard muda hoje.
 */

/** Status que representam dinheiro que entrou. Ver a nota acima. */
export const STATUS_VENDA: ReadonlySet<string> = new Set([
  'paid',
  'partially_refunded',
]);

/**
 * AMAZON — regra de EXCLUSÃO, própria da Amazon (decisão do proprietário,
 * 21/10/2026): "todo pedido Amazon entra no faturamento, exceto CANCELADO".
 *
 * Diferente do Mercado Livre (lista de permissão acima), na Amazon pendente,
 * a enviar, enviado, pré-venda, não atendível e até status desconhecido
 * entram; só `amazon:cancelled` fica fora. Os pedidos da Amazon chegam à
 * leitura com o status prefixado (`amazon:`), então a regra nunca alcança um
 * pedido do Mercado Livre.
 *
 * Vale só para o cálculo comercial: o status bruto é preservado e exibido
 * como veio ("Pendente" continua "Pendente"). Os lançamentos financeiros da
 * Amazon seguem sendo só o dinheiro que a Amazon lançou.
 */
export const PREFIXO_STATUS_AMAZON = 'amazon:';
export const STATUS_CANCELADO_AMAZON = 'amazon:cancelled';

/** Pedido da Amazon (status prefixado) que conta como venda: qualquer um, menos cancelado. */
export function contaComoVendaAmazon(status: string | null | undefined): boolean {
  return typeof status === 'string' && status.startsWith(PREFIXO_STATUS_AMAZON) && status !== STATUS_CANCELADO_AMAZON;
}

/**
 * Único predicado de status do sistema. Use SEMPRE isto — nunca compare
 * `status` com string solta. Mercado Livre: lista de permissão (STATUS_VENDA).
 * Amazon: tudo menos cancelado (contaComoVendaAmazon).
 */
export function contaComoVenda(status: string | null | undefined): boolean {
  return typeof status === 'string' && (STATUS_VENDA.has(status) || contaComoVendaAmazon(status));
}

/**
 * Venda que teve parte do valor devolvida. Continua sendo venda (o que ficou
 * pago é receita), mas o que o pedido traz de tarifa é o da quantidade
 * ORIGINAL — quem apura tarifa real precisa saber que este é o caso.
 */
export function ehReembolsoParcial(status: string | null | undefined): boolean {
  return status === 'partially_refunded';
}