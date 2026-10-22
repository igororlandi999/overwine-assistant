/**
 * ml-envios — adaptador de rede da expedição: as três leituras de UM envio no
 * Mercado Livre. Mesma divisão de ml-orders.ts: o serviço não conhece rede,
 * esta camada injeta o fetch.
 *
 * Devolve status + corpo e NÃO lança em HTTP de erro: quem decide o que um
 * 404 ou um 429 significa é o serviço. Corpo ilegível vira `null`, nunca {}.
 *
 * Prazo: GET /shipments/{id}/sla (`expected_date`). O estimated_handling_limit
 * do /lead_time foi descontinuado pelo ML em 13/05/2025 — a validação real de
 * 21/10/2026 o encontrou vazio em 52 de 52 envios, com ou sem x-format-new.
 * O /sla vai com x-format-new, como a documentação de envios faz em todas as
 * chamadas. /shipments/{id} e /history seguem no formato já validado.
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
    prazo: s => ler(cache, `/shipments/${id(s)}/sla`, HEADERS_FORMATO_NOVO),
    historico: s => ler(cache, `/shipments/${id(s)}/history`),
    atrasos: s => ler(cache, `/shipments/${id(s)}/delays`),
  };
}

// ── Diagnóstico TEMPORÁRIO da bipagem na agência (branch diag/, não vai para a main) ──
//
// Para descobrir qual evento comprova que a agência recebeu o pacote: devolve,
// de UM envio, status/substatus/histórico com horários em todas as formas que a
// API pública oferece (envio no formato antigo e no novo, /history, /sla e
// /delays). Só caminhos de campo; valores apenas de status, substatus, datas,
// tipos e ids. Qualquer caminho que lembre pessoa ou endereço é descartado.

const DIAG_PROIBIDO = /(address|receiver|sender|buyer|seller_id|name|phone|email|document|doc_|zip|street|city|state_name|neighborhood|municipality|comment|geo|latitude|longitude|contact|tracking_number|identification|nickname|cost|price|amount)/i;
const DIAG_VALOR = /(date|status|substatus|type|mode|time|limit|buffer|expected|updated|created|event|code|description|service|^\d+$|id$)/i;

export function diagEstrutura(data: unknown, prof = 0, prefixo = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (Object.keys(out).length >= 400) return out;
  if (data === null || typeof data !== 'object') {
    if (prefixo) out[prefixo] = DIAG_VALOR.test(prefixo.split('.').pop() ?? '') ? data : `<${data === null ? 'null' : typeof data}>`;
    return out;
  }
  if (prof >= 7) { out[prefixo || '(raiz)'] = '<profundo>'; return out; }
  const entradas = Array.isArray(data) ? data.slice(0, 60).map((v, i) => [String(i), v] as const) : Object.entries(data);
  if (entradas.length === 0) { if (prefixo) out[prefixo] = Array.isArray(data) ? '<lista vazia>' : '<objeto vazio>'; return out; }
  for (const [k, v] of entradas) {
    if (DIAG_PROIBIDO.test(k)) continue;
    diagEstrutura(v, prof + 1, prefixo ? `${prefixo}.${k}` : k, out);
  }
  return out;
}

export async function diagnosticarBipagem(cache: Cache, shipmentId: string): Promise<Record<string, unknown>> {
  const id = encodeURIComponent(shipmentId);
  const [envio, envioNovo, historico, sla, atrasos] = await Promise.all([
    ler(cache, `/shipments/${id}`),
    ler(cache, `/shipments/${id}`, HEADERS_FORMATO_NOVO),
    ler(cache, `/shipments/${id}/history`),
    ler(cache, `/shipments/${id}/sla`, HEADERS_FORMATO_NOVO),
    ler(cache, `/shipments/${id}/delays`),
  ]);
  return {
    id: shipmentId,
    envio: { http: envio.status, campos: diagEstrutura(envio.data) },
    envioFormatoNovo: { http: envioNovo.status, campos: diagEstrutura(envioNovo.data) },
    historico: { http: historico.status, campos: diagEstrutura(historico.data) },
    sla: { http: sla.status, campos: diagEstrutura(sla.data) },
    delays: { http: atrasos.status, campos: diagEstrutura(atrasos.data) },
  };
}
