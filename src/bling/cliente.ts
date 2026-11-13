/**
 * Cliente HTTP da API v3 do Bling. SOMENTE LEITURA: a única função pública faz
 * GET. Não existe caminho neste módulo para POST, PUT, PATCH ou DELETE na API
 * (o único POST do Bling feito pelo backend é o de /oauth/token, em auth.ts).
 *
 * Comportamento:
 *  - Trava BLING_ENABLED verificada antes de tudo (via lerConfigBling).
 *  - Limite de 3 req/s por conta respeitado com um contador por segundo no
 *    Redis, compartilhado entre instâncias serverless; quem passa do limite
 *    espera o próximo segundo (até ~5 s) em vez de levar 429.
 *  - Teto local diário (BLING_MAX_REQ_DIA) checado antes de sair.
 *  - 401: renova UMA vez (sob o lock da cadeia; se outra instância já
 *    renovou, usa o token dela) e repete; segundo 401 vira
 *    BlingAutorizacaoError.
 *  - 429 com period "second": espera e repete (até 2 vezes). Com period "day":
 *    falha na hora, sem insistir (insistir só gasta o limite de erros por IP).
 *  - 5xx, timeout e erro de rede: até 2 retentativas com espera crescente.
 *    Seguro porque toda chamada aqui é GET (idempotente).
 *  - Demais 4xx: falha sem retentativa.
 *  - Logs: método, caminho SEM query, status e tentativa. Nunca token, query
 *    ou corpo.
 */
import type { Cache } from '../lib/cache/cache.js';
import { lerConfigBling } from './config.js';
import { obterAccessToken, type DepsBling } from './auth.js';
import { BLING_API_BASE, HEADER_JWT, LIMITE_POR_SEGUNDO } from './contrato.js';
import { BlingAutorizacaoError, BlingHttpError, BlingLimiteError } from './erros.js';

export type ValorQuery = string | number | boolean | undefined | null | ReadonlyArray<string | number>;
export type Query = Record<string, ValorQuery>;

const TIMEOUT_MS = 15_000;
const MAX_RETENTATIVAS_5XX = 2;
const MAX_RETENTATIVAS_429 = 2;
const ESPERAS_5XX_MS = [500, 1500];
const MAX_ESPERAS_JANELA = 10;

const RL = {
  segundo: (s: number) => `bling:rl:s:${s}`,
  dia: (d: string) => `bling:rl:d:${d}`,
};

const dormir = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Caminho relativo à base v3, sem esquema, host, query ou "..". */
const FORMATO_CAMINHO = /^\/[A-Za-z0-9_\-/]+$/;

export function montarUrl(caminho: string, query: Query = {}): string {
  if (!FORMATO_CAMINHO.test(caminho) || caminho.includes('..') || caminho.includes('//')) {
    throw new BlingHttpError('caminho Bling inválido', 0);
  }
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const item of v) q.append(k, String(item));
    else q.append(k, String(v));
  }
  const s = q.toString();
  return `${BLING_API_BASE}${caminho}${s ? `?${s}` : ''}`;
}

/** Reserva uma vaga na janela de 1 s e na cota diária local. */
async function reservarVaga(cache: Cache, maxReqDia: number, agora: () => number, sleep: (ms: number) => Promise<void>) {
  const dia = new Date(agora()).toISOString().slice(0, 10);
  const usados = await cache.incr(RL.dia(dia), 26 * 3600);
  if (usados > maxReqDia) throw new BlingLimiteError('teto local diário de requisições ao Bling atingido', 'local_dia');

  for (let i = 0; i < MAX_ESPERAS_JANELA; i++) {
    const t = agora();
    const s = Math.floor(t / 1000);
    if ((await cache.incr(RL.segundo(s), 2)) <= LIMITE_POR_SEGUNDO) return;
    await sleep((s + 1) * 1000 - t + 5);
  }
  throw new BlingLimiteError('janela de 3 req/s ocupada por tempo demais', 'second');
}

function periodoDo429(corpo: unknown): string | undefined {
  const e = (corpo as { error?: { period?: unknown } } | null)?.error;
  return typeof e?.period === 'string' ? e.period : undefined;
}

function tipoDoErro(corpo: unknown): string | undefined {
  const e = (corpo as { error?: { type?: unknown } } | null)?.error;
  return typeof e?.type === 'string' ? e.type.slice(0, 60) : undefined;
}

async function lerJson(res: Response): Promise<unknown> {
  try { return await res.json(); } catch { return null; }
}

function log(caminho: string, msg: string) {
  console.warn(`[bling] GET ${caminho} ${msg}`);
}

/**
 * GET autenticado na API v3. Devolve o corpo JSON já parseado.
 * `caminho` é relativo à base (ex.: "/depositos", "/produtos/123").
 */
export async function blingGet<T = unknown>(
  cache: Cache, caminho: string, query: Query = {}, deps: DepsBling = {},
): Promise<T> {
  const cfg = lerConfigBling();
  const url = montarUrl(caminho, query);
  const f = deps.fetch ?? fetch;
  const agora = deps.agora ?? Date.now;
  const sleep = deps.sleep ?? dormir;

  let rejeitado: string | undefined;
  let renovou = false;
  let r5xx = 0;
  let r429 = 0;

  for (;;) {
    await reservarVaga(cache, cfg.maxReqDia, agora, sleep);
    const { token } = await obterAccessToken(cache, deps, { rejeitado });

    let res: Response;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      res = await f(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...HEADER_JWT },
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const motivo = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'erro de rede';
      if (r5xx < MAX_RETENTATIVAS_5XX) {
        log(caminho, `${motivo} tentativa=${r5xx + 1}`);
        await sleep(ESPERAS_5XX_MS[r5xx++]);
        continue;
      }
      throw new BlingHttpError(`Bling indisponível (${motivo})`, 0);
    }
    clearTimeout(timer);

    if (res.ok) return (await lerJson(res)) as T;

    const corpo = await lerJson(res);

    if (res.status === 401) {
      if (!renovou) {
        renovou = true;
        log(caminho, 'status=401 renovando token');
        rejeitado = token;
        continue;
      }
      throw new BlingAutorizacaoError('Bling recusou o token renovado (401); autorize o aplicativo novamente');
    }

    if (res.status === 429) {
      const periodo = periodoDo429(corpo);
      if (periodo === 'day') {
        log(caminho, 'status=429 limite diário');
        throw new BlingLimiteError('limite diário de requisições do Bling atingido', 'day');
      }
      if (r429 < MAX_RETENTATIVAS_429) {
        log(caminho, `status=429 tentativa=${r429 + 1}`);
        await sleep(1000 * ++r429);
        continue;
      }
      throw new BlingLimiteError('limite de requisições por segundo do Bling atingido', 'second');
    }

    if (res.status >= 500) {
      if (r5xx < MAX_RETENTATIVAS_5XX) {
        log(caminho, `status=${res.status} tentativa=${r5xx + 1}`);
        await sleep(ESPERAS_5XX_MS[r5xx++]);
        continue;
      }
      throw new BlingHttpError(`Bling respondeu HTTP ${res.status}`, res.status, tipoDoErro(corpo));
    }

    log(caminho, `status=${res.status}`);
    throw new BlingHttpError(`Bling respondeu HTTP ${res.status}`, res.status, tipoDoErro(corpo));
  }
}
