/**
 * Dono único da cadeia de tokens do Mercado Livre.
 * REGRA ABSOLUTA: nenhum token deste módulo sai do backend. Nenhum endpoint
 * público retorna access_token, refresh_token ou derivados.
 *
 * Pontos críticos:
 * 1. Refresh token do ML é de USO ÚNICO: cada renovação devolve um novo e
 *    invalida o anterior. A cadeia vive no Redis (fonte única).
 * 2. Serverless = instâncias concorrentes. Lock via SET NX com valor de
 *    propriedade aleatório + compare-and-delete atômico na liberação
 *    (não apagamos um lock expirado que outra instância já adquiriu).
 * 3. Chamadas ao ML sempre com Authorization: Bearer.
 */
import { randomBytes } from 'node:crypto';
import { getEnv } from '../config/env.js';
import type { Cache } from './cache/cache.js';

const K = {
  access: 'ml:access_token', // JSON { token, expiresAt }
  refresh: 'ml:refresh_token', // string TG-...
  lock: 'ml:refresh_lock',
};

const RENEW_MARGIN_MS = 5 * 60 * 1000;
const REFRESH_TTL_S = 180 * 24 * 3600; // refresh do ML vale 6 meses
const ML_TIMEOUT_MS = 10_000;

export interface AccessToken {
  token: string;
  expiresAt: number; // epoch ms
}

interface MLTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user_id?: number;
  message?: string;
  error?: string;
}

async function fetchTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ML_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function mlTokenRequest(params: Record<string, string>): Promise<MLTokenResponse> {
  const res = await fetchTimeout('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params),
  });
  return (await res.json()) as MLTokenResponse;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function parseCachedAccess(raw: string | null): AccessToken | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as AccessToken;
    if (p?.token && p?.expiresAt) return p;
  } catch {
    /* cache corrompido — ignora */
  }
  return null;
}

/** Access token válido, com renovação antecipada e lock distribuído. INTERNO. */
export async function getAccessToken(cache: Cache): Promise<AccessToken> {
  const cached = parseCachedAccess(await cache.get(K.access));
  if (cached && cached.expiresAt - Date.now() > RENEW_MARGIN_MS) return cached;

  const lockOwner = randomBytes(16).toString('hex');
  const gotLock = await cache.setNX(K.lock, lockOwner, 30);
  if (!gotLock) {
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      const c = parseCachedAccess(await cache.get(K.access));
      if (c && c.expiresAt - Date.now() > RENEW_MARGIN_MS) return c;
    }
    throw new Error('Timeout aguardando renovação de token por outra instância.');
  }

  try {
    const again = parseCachedAccess(await cache.get(K.access));
    if (again && again.expiresAt - Date.now() > RENEW_MARGIN_MS) return again;

    const env = getEnv();
    const refresh = await cache.get(K.refresh);
    if (!refresh) {
      throw new Error('Cadeia de tokens não semeada. Autorize o app e chame POST /api/admin/seed.');
    }

    const data = await mlTokenRequest({
      grant_type: 'refresh_token',
      client_id: env.ML_CLIENT_ID,
      client_secret: env.ML_CLIENT_SECRET,
      refresh_token: refresh,
    });

    if (!data.access_token) {
      throw new Error(`Falha ao renovar token ML: ${data.message || data.error || 'sem detalhe'}`);
    }

    // Gravar o novo refresh ANTES de tudo — o antigo já morreu no ML.
    if (data.refresh_token) await cache.set(K.refresh, data.refresh_token, REFRESH_TTL_S);

    const expiresIn = data.expires_in ?? 21600;
    const tok: AccessToken = { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    await cache.set(K.access, JSON.stringify(tok), Math.max(expiresIn - 60, 60));
    return tok;
  } finally {
    // Libera só se o lock ainda for NOSSO (compare-and-delete atômico).
    await cache.delIfEquals(K.lock, lockOwner);
  }
}

export async function isChainSeeded(cache: Cache): Promise<boolean> {
  return (await cache.get(K.refresh)) !== null;
}

/**
 * Semeia a cadeia de UMA conta. Aceita { code } (exchange OAuth) ou
 * { refreshToken } (TG- válido).
 *
 * `userIdEsperado` é o `user_id` do Mercado Livre da conta que o chamador
 * quer semear. A autorização é feita por uma PESSOA no navegador, e nada
 * impede que ela entre com o vendedor errado: sem esta conferência, os tokens
 * da Degustar poderiam parar no espaço da Overwine (ou o contrário) e todas
 * as leituras seguintes seriam de outra loja. Por isso:
 *  - com `code`, o `user_id` vem na própria resposta do token e é conferido
 *    ANTES de gravar qualquer coisa;
 *  - com `refreshToken`, o token é trocado DIRETO no Mercado Livre (sem
 *    passar pelo cache) e o `user_id` da resposta é conferido; só então a
 *    cadeia nova é publicada. Uma requisição concorrente que renove o token
 *    da conta nesse meio-tempo continua vendo a cadeia anterior, nunca a
 *    candidata — gravar primeiro e restaurar depois abriria essa janela.
 * Sem `userIdEsperado` (chamadas antigas), vale ML_USER_ID — a legada.
 */
export async function seedTokens(
  cache: Cache,
  input: { code?: string; refreshToken?: string },
  opts: { userIdEsperado?: string } = {}
): Promise<{ userId?: number; expiresAt: number }> {
  const env = getEnv();
  const esperado = opts.userIdEsperado ?? env.ML_USER_ID;

  if (input.code) {
    const data = await mlTokenRequest({
      grant_type: 'authorization_code',
      client_id: env.ML_CLIENT_ID,
      client_secret: env.ML_CLIENT_SECRET,
      code: input.code,
      redirect_uri: env.ML_REDIRECT_URI,
    });
    if (!data.access_token || !data.refresh_token) {
      throw new Error(`Falha no exchange do code: ${data.message || data.error || 'sem detalhe'}`);
    }
    if (!data.user_id || String(data.user_id) !== esperado) {
      throw new Error(`user_id da autorização (${data.user_id ?? 'ausente'}) difere do vendedor esperado (${esperado}). Semeadura recusada; nada foi gravado.`);
    }
    await cache.set(K.refresh, data.refresh_token, REFRESH_TTL_S);
    const expiresIn = data.expires_in ?? 21600;
    const tok: AccessToken = { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    await cache.set(K.access, JSON.stringify(tok), Math.max(expiresIn - 60, 60));
    return { userId: data.user_id, expiresAt: tok.expiresAt };
  }

  if (input.refreshToken) {
    // Troca o refresh token candidato DIRETO no ML, sem tocar no cache: até a
    // conferência do vendedor passar, a cadeia publicada é a anterior.
    const data = await mlTokenRequest({
      grant_type: 'refresh_token',
      client_id: env.ML_CLIENT_ID,
      client_secret: env.ML_CLIENT_SECRET,
      refresh_token: input.refreshToken,
    });
    if (!data.access_token) throw new Error(`Falha ao renovar token ML: ${data.message || data.error || 'sem detalhe'}`);
    if (!data.user_id || String(data.user_id) !== esperado) {
      throw new Error(`user_id do refresh token (${data.user_id ?? 'ausente'}) difere do vendedor esperado (${esperado}). Semeadura recusada; nada foi gravado.`);
    }
    // Publica a cadeia nova: o refresh devolvido (o candidato já foi consumido
    // pelo ML, que os rotaciona) e o access token. Refresh primeiro, como na
    // renovação normal — o antigo já morreu do lado do ML.
    await cache.set(K.refresh, data.refresh_token ?? input.refreshToken, REFRESH_TTL_S);
    const expiresIn = data.expires_in ?? 21600;
    const tok: AccessToken = { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    await cache.set(K.access, JSON.stringify(tok), Math.max(expiresIn - 60, 60));
    return { userId: data.user_id, expiresAt: tok.expiresAt };
  }

  throw new Error('Informe { code } ou { refreshToken }.');
}

/**
 * Chamada autenticada ao ML (Bearer). Em 401 com token cacheado (revogação
 * externa), invalida o cache e tenta UMA renovação; depois propaga o erro.
 */
export async function mlFetch(
  cache: Cache,
  path: string,
  init: RequestInit = {},
  _retried = false
): Promise<Response> {
  const { token } = await getAccessToken(cache);
  const res = await fetchTimeout(`https://api.mercadolibre.com${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (res.status === 401 && !_retried) {
    await cache.del(K.access);
    return mlFetch(cache, path, init, true);
  }
  return res;
}
