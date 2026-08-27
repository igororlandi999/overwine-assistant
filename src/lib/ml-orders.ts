/**
 * ml-orders — o único adaptador de rede para "buscar UM pedido no Mercado
 * Livre". Mora aqui, e não numa rota, porque duas rotas precisam dele:
 * a callback de notificações e o dreno manual do endpoint admin. Uma rota
 * importando outra rota funcionaria, mas colocaria o handler de uma dentro do
 * pacote da outra.
 *
 * Mesma divisão de responsabilidade das demais sincronizações: o serviço não
 * conhece rede, a camada de fora injeta o fetch.
 */
import type { Cache } from './cache/cache.js';
import { mlFetch } from './ml-auth.js';
import type { FetchOrderById } from '../services/orders-webhook.service.js';
import type { OrderInput } from '../services/orders.service.js';

/**
 * GET /orders/{id}.
 *
 * Buscamos o pedido INTEIRO e reduzimos com `toSlim` do lado de cá, em vez de
 * pedir campos específicos ao ML. Assim o upsert por notificação e a varredura
 * periódica gravam registros produzidos pelo MESMO normalizador — se um
 * pedisse menos campos, a comparação `slimIgual` acusaria diferença em todo
 * evento e publicaríamos versão nova à toa.
 *
 * Erro NÃO é engolido: sobe para o dreno, que devolve o evento à fila e
 * registra a falha.
 */
export function criarFetchOrder(cache: Cache): FetchOrderById {
  return async (orderId: string) => {
    const r = await mlFetch(cache, `/orders/${encodeURIComponent(orderId)}`);
    if (!r.ok) throw new Error(`ML GET /orders/${orderId} HTTP ${r.status}.`);
    const data = (await r.json()) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`ML GET /orders/${orderId} sem corpo de objeto.`);
    }
    const o = data as OrderInput;
    if (o.id === undefined || o.id === null) {
      throw new Error(`ML GET /orders/${orderId} sem id.`);
    }
    return o;
  };
}
