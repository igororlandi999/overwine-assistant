/**
 * ml-envios — adaptador de rede da expedição: as três leituras de UM envio no
 * Mercado Livre. Mesma divisão de ml-orders.ts: o serviço não conhece rede,
 * esta camada injeta o fetch.
 *
 * Devolve status + corpo e NÃO lança em HTTP de erro: quem decide o que um
 * 404 ou um 429 significa é o serviço. Corpo ilegível vira `null`, nunca {}.
 *
 * `x-format-new: true` no /lead_time: a documentação "Gerenciamento de envios"
 * usa esse cabeçalho em todas as chamadas de envio, e a validação real de
 * 21/10/2026 mostrou /lead_time SEM estimated_handling_limit em 49 de 49
 * envios próprios quando chamado sem ele. /shipments/{id} e /history seguem
 * no formato já validado (status, substatus, status_history.date_shipped).
 */
import type { Cache } from './cache/cache.js';
import { mlFetch } from './ml-auth.js';
import type { FetchersEnvio, RespostaML } from '../services/expedicao.service.js';

export const HEADERS_FORMATO_NOVO: Record<string, string> = { 'x-format-new': 'true' };

async function ler(cache: Cache, path: string, headers?: Record<string, string>): Promise<RespostaML> {
  const r = await mlFetch(cache, path, headers ? { headers } : {});
  let data: unknown = null;
  try { data = await r.json(); } catch { /* corpo vazio ou não-JSON */ }
  return { status: r.status, data };
}

export function criarFetchersEnvio(cache: Cache): FetchersEnvio {
  const id = (s: string) => encodeURIComponent(s);
  return {
    envio: s => ler(cache, `/shipments/${id(s)}`),
    prazo: s => ler(cache, `/shipments/${id(s)}/lead_time`, HEADERS_FORMATO_NOVO),
    historico: s => ler(cache, `/shipments/${id(s)}/history`),
  };
}

// ── Diagnóstico TEMPORÁRIO (remover antes do merge) ─────────────────────
//
// Mostra a ESTRUTURA das respostas de prazo de um envio, com e sem o
// cabeçalho de formato novo, para confirmar com dado real de onde vem o
// prazo de postagem. Só caminhos de campo; valores apenas de campos de data,
// prazo, status e tipo. Qualquer caminho que lembre pessoa ou endereço é
// descartado inteiro, com valor e tudo.

const CAMINHO_PROIBIDO = /(address|receiver|sender|buyer|seller_id|name|phone|email|document|doc_|zip|street|city|state|neighborhood|municipality|comment|geo|latitude|longitude|contact|tracking_number|identification)/i;
const VALOR_PERMITIDO = /(date|limit|handling|buffer|deadline|cutoff|status|type|mode|delay|offset|unit|time|schedule|service|id$)/i;
const MAX_CAMPOS = 150;

/** Achata `data` em { caminho: valor-ou-tipo }, sem nada pessoal. */
export function estruturaSegura(data: unknown, prof = 0, prefixo = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (Object.keys(out).length >= MAX_CAMPOS) return out;
  if (data === null || typeof data !== 'object') {
    if (prefixo) {
      out[prefixo] = VALOR_PERMITIDO.test(prefixo.split('.').pop() ?? '') ? data : `<${data === null ? 'null' : typeof data}>`;
    }
    return out;
  }
  if (prof >= 6) { out[prefixo || '(raiz)'] = '<profundo>'; return out; }
  const entradas = Array.isArray(data) ? data.slice(0, 3).map((v, i) => [String(i), v] as const) : Object.entries(data);
  if (entradas.length === 0) { if (prefixo) out[prefixo] = Array.isArray(data) ? '<lista vazia>' : '<objeto vazio>'; return out; }
  for (const [k, v] of entradas) {
    const caminho = prefixo ? `${prefixo}.${k}` : k;
    if (CAMINHO_PROIBIDO.test(k)) continue;
    estruturaSegura(v, prof + 1, caminho, out);
  }
  return out;
}

export async function diagnosticarPrazo(cache: Cache, shipmentId: string): Promise<Record<string, unknown>> {
  const id = encodeURIComponent(shipmentId);
  const [semHeader, comHeader] = await Promise.all([
    ler(cache, `/shipments/${id}/lead_time`),
    ler(cache, `/shipments/${id}/lead_time`, HEADERS_FORMATO_NOVO),
  ]);
  return {
    id: shipmentId,
    leadTimeSemHeader: { http: semHeader.status, campos: estruturaSegura(semHeader.data) },
    leadTimeComHeader: { http: comHeader.status, campos: estruturaSegura(comHeader.data) },
  };
}
