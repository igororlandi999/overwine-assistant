/**
 * Contrato da Selling Partner API usado pela integração Amazon.
 *
 * Tudo aqui vem dos modelos OFICIAIS (amzn/selling-partner-api-models, cópia
 * em tests/contratos/amazon/, conferida em 2026-10-01). Os testes de contrato
 * comparam estas constantes com os modelos: mudar um sem o outro quebra.
 *
 * Versões escolhidas (a anterior de cada uma está descontinuada):
 *   - Orders v2026-01-01  (v0 removida em 2027-03-27)
 *   - Finances v2024-06-19 (v0 removida em 2027-08-27)
 *   - Listings Items v2021-08-01
 *   - FBA Inventory v1
 *
 * LIMITES: rate/burst abaixo são os PADRÕES do contrato. A Amazon pode
 * conceder outros por conta, e devolve o valor aplicado no cabeçalho
 * `x-amzn-RateLimit-Limit`. O limitador (cliente.ts) começa pelo padrão e
 * passa a usar o valor observado. Nenhum intervalo fixo ("uma chamada a cada
 * N minutos") é regra: o ritmo sai do balde de cada operação.
 */

/** Região NA (inclui o Brasil). */
export const SP_API_HOST = 'https://sellingpartnerapi-na.amazon.com';
/** Login with Amazon: troca do refresh token por access token. */
export const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

export const MARKETPLACE_BRASIL = 'A2Q3Y263D00KWC';

export type OperacaoAmazon = 'searchOrders' | 'getOrder' | 'listTransactions' | 'searchListingsItems' | 'getInventorySummaries';

export interface LimitePadrao {
  /** Requisições por segundo (reposição do balde). */
  rate: number;
  /** Tamanho do balde. */
  burst: number;
}

export const OPERACOES: Record<OperacaoAmazon, { metodo: 'GET'; caminho: string; limite: LimitePadrao }> = {
  searchOrders: { metodo: 'GET', caminho: '/orders/2026-01-01/orders', limite: { rate: 0.0056, burst: 20 } },
  getOrder: { metodo: 'GET', caminho: '/orders/2026-01-01/orders/{orderId}', limite: { rate: 0.5, burst: 30 } },
  listTransactions: { metodo: 'GET', caminho: '/finances/2024-06-19/transactions', limite: { rate: 0.5, burst: 10 } },
  searchListingsItems: { metodo: 'GET', caminho: '/listings/2021-08-01/items/{sellerId}', limite: { rate: 5, burst: 5 } },
  getInventorySummaries: { metodo: 'GET', caminho: '/fba/inventory/v1/summaries', limite: { rate: 2, burst: 2 } },
};

/**
 * Dados pedidos em `searchOrders`. Só o que o dashboard usa, e NENHUM conjunto
 * de dado pessoal (BUYER, RECIPIENT, TAX, PAYMENT): o app não pede funções
 * restritas, e a Amazon ocultaria esses campos de qualquer forma.
 */
export const PEDIDOS_INCLUDED_DATA = ['PROCEEDS', 'FULFILLMENT', 'CANCELLATION'] as const;

/** Conjuntos lidos de cada anúncio. */
export const ANUNCIOS_INCLUDED_DATA = ['summaries', 'offers', 'fulfillmentAvailability'] as const;

export const PEDIDOS_POR_PAGINA_MAX = 100;
export const ANUNCIOS_POR_PAGINA_MAX = 20;

/** `paginationToken` de searchOrders vale 24 h (guia de migração da Orders API). */
export const VALIDADE_TOKEN_PEDIDOS_MS = 24 * 3600 * 1000;
/** `nextToken` do FBA Inventory expira 30 s depois da resposta: a paginação não atravessa invocações. */
export const VALIDADE_TOKEN_ESTOQUE_MS = 30 * 1000;

/** Datas de filtro precisam estar ao menos 2 min no passado (Orders e Finances). */
export const FOLGA_DATA_FINAL_MS = 2 * 60 * 1000 + 5_000;
/** Finances: intervalo postedAfter..postedBefore acima de 180 dias devolve vazio. */
export const JANELA_FINANCEIRO_MAX_MS = 180 * 24 * 3600 * 1000;
