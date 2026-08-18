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
 * Único predicado de status do sistema. Use SEMPRE isto — nunca compare
 * `status` com string solta, e nunca escreva `!== 'cancelled'`.
 */
export function contaComoVenda(status: string | null | undefined): boolean {
  return typeof status === 'string' && STATUS_VENDA.has(status);
}