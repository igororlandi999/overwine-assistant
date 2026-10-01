/**
 * Login with Amazon (LWA) — access token da SP-API para UMA conta.
 *
 * Dois tokens com papéis diferentes:
 *
 *   REFRESH TOKEN: credencial de LONGA duração, emitida UMA vez quando o
 *   usuário principal autoriza o app para a conta (self-authorization). Vem
 *   do ambiente (<BASE>_REFRESH_TOKEN), nunca é gravado no Redis e NÃO é
 *   trocado a cada renovação. A Amazon pode emitir outro numa nova
 *   autorização, e um novo não invalida os anteriores. Deixa de valer se a
 *   autorização for revogada (`invalid_grant`).
 *
 *   ACCESS TOKEN: credencial CURTA (expires_in, hoje 3600 s), obtida trocando
 *   o refresh token neste módulo. Vai no cabeçalho `x-amz-access-token` de
 *   cada chamada. Fica no cache DA CONTA até perto de expirar.
 *
 * A outra peça, o client secret do app, expira por política (rotação a cada
 * 180 dias). Expirado, a troca falha com `invalid_client`. Os dois erros são
 * distinguidos porque pedem ações diferentes de quem opera.
 *
 * Nenhum token sai deste módulo para resposta HTTP ou log.
 */
import { randomBytes } from 'node:crypto';
import type { Cache } from '../lib/cache/cache.js';
import type { CredenciaisAmazon } from './credenciais.js';
import { LWA_TOKEN_URL } from './contrato.js';

const K = { access: 'amz:lwa:access', lock: 'amz:lwa:lock' };
const MARGEM_RENOVACAO_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 10_000;

export type MotivoFalhaLwa =
  | 'autorizacao_invalida'   // invalid_grant: refresh token revogado, errado ou de outro app — refazer a autorização
  | 'credencial_app_invalida' // invalid_client: client id/secret errado ou secret expirado — rotacionar no portal
  | 'lwa_indisponivel';       // rede, 5xx, resposta sem token

export class FalhaLwa extends Error {
  constructor(public readonly motivo: MotivoFalhaLwa, detalhe: string) {
    super(`${motivo}: ${detalhe}`);
    this.name = 'FalhaLwa';
  }
}

interface AccessGuardado { token: string; expiraEm: number }

async function trocarRefreshPorAccess(cred: CredenciaisAmazon): Promise<AccessGuardado> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(LWA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: cred.refreshToken,
        client_id: cred.clientId,
        client_secret: cred.clientSecret,
      }),
      signal: ctl.signal,
    });
  } catch (e) {
    throw new FalhaLwa('lwa_indisponivel', e instanceof Error ? e.name : 'erro de rede');
  } finally {
    clearTimeout(t);
  }
  let corpo: { access_token?: string; expires_in?: number; error?: string } = {};
  try { corpo = await res.json() as typeof corpo; } catch { /* corpo não-JSON */ }
  if (!res.ok || !corpo.access_token) {
    if (corpo.error === 'invalid_grant') throw new FalhaLwa('autorizacao_invalida', `HTTP ${res.status}`);
    if (corpo.error === 'invalid_client' || corpo.error === 'unauthorized_client') throw new FalhaLwa('credencial_app_invalida', `HTTP ${res.status}`);
    throw new FalhaLwa('lwa_indisponivel', `HTTP ${res.status}${corpo.error ? ' ' + corpo.error : ''}`);
  }
  const segundos = Number.isFinite(corpo.expires_in) && corpo.expires_in! > 0 ? corpo.expires_in! : 3600;
  return { token: corpo.access_token, expiraEm: Date.now() + segundos * 1000 };
}

/**
 * Access token válido para a conta dona de `cache` (já prefixado). Reaproveita
 * o guardado enquanto faltar mais de 5 min para expirar; senão renova sob lock,
 * para duas instâncias não trocarem o token ao mesmo tempo.
 */
export async function obterAccessToken(cache: Cache, cred: CredenciaisAmazon, opts: { forcar?: boolean } = {}): Promise<string> {
  const ler = async (): Promise<AccessGuardado | null> => {
    const raw = await cache.get(K.access);
    if (!raw) return null;
    try { return JSON.parse(raw) as AccessGuardado; } catch { return null; }
  };
  if (!opts.forcar) {
    const atual = await ler();
    if (atual && atual.expiraEm - Date.now() > MARGEM_RENOVACAO_MS) return atual.token;
  }
  const dono = randomBytes(12).toString('hex');
  const temLock = await cache.setNX(K.lock, dono, 30);
  if (!temLock) {
    // Outra instância está renovando: usa o atual se ainda valer.
    const atual = await ler();
    if (atual && atual.expiraEm > Date.now() + 10_000) return atual.token;
  }
  try {
    const novo = await trocarRefreshPorAccess(cred);
    const ttl = Math.max(60, Math.floor((novo.expiraEm - Date.now()) / 1000));
    await cache.set(K.access, JSON.stringify(novo), ttl);
    return novo.token;
  } finally {
    if (temLock) await cache.delIfEquals(K.lock, dono);
  }
}

/** Descarta o access token guardado (por exemplo, depois de um 403 de token inválido). */
export async function descartarAccessToken(cache: Cache): Promise<void> {
  await cache.del(K.access);
}

export const CHAVES_LWA = K;
