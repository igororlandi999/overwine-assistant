/**
 * Apoio dos testes do Bling: ambiente fictício, relógio controlado e um fetch
 * simulado que registra cada chamada. Nenhuma credencial real, nenhuma rede.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DepsBling } from '../src/bling/auth.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'contratos', 'bling');
export const fixture = (nome: string): unknown => JSON.parse(readFileSync(join(DIR, nome), 'utf8'));

export const SEGREDO_TESTE = 'segredo-ficticio-do-app-bling';
export const ENV_BLING = {
  BLING_ENABLED: 'true',
  BLING_CLIENT_ID: 'client-id-ficticio',
  BLING_CLIENT_SECRET: SEGREDO_TESTE,
};
const NOMES = ['BLING_ENABLED', 'BLING_CLIENT_ID', 'BLING_CLIENT_SECRET', 'BLING_MAX_REQ_DIA', 'BLING_CNPJ_ESPERADO', 'BLING_ADMIN_KEY'];

export function ligarBling(extra: Record<string, string> = {}) {
  for (const n of NOMES) delete process.env[n];
  Object.assign(process.env, ENV_BLING, extra);
}
export function limparBling() {
  for (const n of NOMES) delete process.env[n];
}

export interface Chamada { url: string; init: RequestInit }
export type Resposta = { status: number; corpo?: unknown } | Error;

/**
 * fetch simulado: cada chamada consome a próxima resposta da fila do roteador
 * cujo prefixo casa com a URL. Sem resposta prevista = falha do teste.
 */
export function simular(rotas: Record<string, Resposta[]>) {
  const chamadas: Chamada[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    chamadas.push({ url, init });
    const chave = Object.keys(rotas).filter(k => url.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    const r = chave ? rotas[chave].shift() : undefined;
    if (!r) throw new Error(`chamada não prevista no teste: ${url}`);
    if (r instanceof Error) throw r;
    return new Response(r.corpo === undefined ? '' : JSON.stringify(r.corpo), { status: r.status });
  }) as typeof fetch;
  return { fetch: f, chamadas };
}

/** Relógio controlado: sleep avança o tempo em vez de esperar. */
export function relogio(inicio = Date.UTC(2026, 10, 13, 12, 0, 0, 100)) {
  let t = inicio;
  const esperas: number[] = [];
  return {
    agora: () => t,
    sleep: async (ms: number) => { esperas.push(ms); t += ms; },
    avancar: (ms: number) => { t += ms; },
    esperas,
  };
}

export function deps(f: typeof fetch, r = relogio()): DepsBling & { r: ReturnType<typeof relogio> } {
  return { fetch: f, agora: r.agora, sleep: r.sleep, r };
}

export const TOKEN_URL = 'https://api.bling.com.br/Api/v3/oauth/token';
export const API = 'https://api.bling.com.br/Api/v3';

export function cabecalhos(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}
