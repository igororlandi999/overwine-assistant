/**
 * ml-envios — adaptador de rede da expedição: as três leituras de UM envio no
 * Mercado Livre. Mesma divisão de ml-orders.ts: o serviço não conhece rede,
 * esta camada injeta o fetch.
 *
 * Devolve status + corpo e NÃO lança em HTTP de erro: quem decide o que um
 * 404 ou um 429 significa é o serviço. Corpo ilegível vira `null`, nunca {}.
 */
import type { Cache } from './cache/cache.js';
import { mlFetch } from './ml-auth.js';
import type { FetchersEnvio, RespostaML } from '../services/expedicao.service.js';

async function ler(cache: Cache, path: string): Promise<RespostaML> {
  const r = await mlFetch(cache, path);
  let data: unknown = null;
  try { data = await r.json(); } catch { /* corpo vazio ou não-JSON */ }
  return { status: r.status, data };
}

export function criarFetchersEnvio(cache: Cache): FetchersEnvio {
  const id = (s: string) => encodeURIComponent(s);
  return {
    envio: s => ler(cache, `/shipments/${id(s)}`),
    prazo: s => ler(cache, `/shipments/${id(s)}/lead_time`),
    historico: s => ler(cache, `/shipments/${id(s)}/history`),
  };
}
