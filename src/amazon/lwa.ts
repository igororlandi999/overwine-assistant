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
 *   cada chamada. Fica SÓ na memória da instância, até perto de expirar: nunca
 *   é gravado no Redis, que não tem criptografia em repouso. Cada instância
 *   (cold start) faz a sua troca, muito abaixo do limite da LWA. A chave da
 *   memória é o sha256 da credencial (client id, secret e refresh token), então
 *   contas e credenciais rotacionadas não se misturam e nenhum segredo vira
 *   chave em texto puro.
 *
 * A outra peça, o client secret do app, expira por política (rotação a cada
 * 180 dias). Expirado, a troca falha com `invalid_client`. Os dois erros são
 * distinguidos porque pedem ações diferentes de quem opera.
 *
 * Nenhum token sai deste módulo para resposta HTTP ou log.
 */
import { createHash } from 'node:crypto';
import type { Cache } from '../lib/cache/cache.js';
import type { CredenciaisAmazon } from './credenciais.js';
import { LWA_TOKEN_URL } from './contrato.js';

/** Chaves que versões anteriores gravavam no Redis. Não são mais lidas nem escritas; as antigas expiram sozinhas (≤ 1 h). */
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

interface AccessGuardado { token: string; expiraEm: number; vidaMs: number }

/** Por instância: hash da credencial -> token, e renovações em andamento. */
const memoria = new Map<string, AccessGuardado>();
const emVoo = new Map<string, Promise<AccessGuardado>>();
/** Último hash usado por cada objeto `cache`, para `descartarAccessToken` saber qual entrada apagar. */
const chavePorCache = new WeakMap<Cache, string>();

function chaveDa(cred: CredenciaisAmazon): string {
  return createHash('sha256').update(`${cred.clientId}\0${cred.clientSecret}\0${cred.refreshToken}`).digest('hex');
}

/** Ainda serve se faltar mais que a margem; um token de vida curta é reaproveitado até a metade dela. */
function aindaServe(g: AccessGuardado): boolean {
  return g.expiraEm - Date.now() > Math.min(MARGEM_RENOVACAO_MS, g.vidaMs / 2);
}

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
  return { token: corpo.access_token, expiraEm: Date.now() + segundos * 1000, vidaMs: segundos * 1000 };
}

/**
 * Access token válido para a credencial. Reaproveita o da memória enquanto
 * faltar mais de 5 min para expirar; senão renova. Chamadas simultâneas na
 * mesma instância compartilham UMA renovação; instâncias diferentes renovam
 * cada uma a sua. Falha na renovação apaga a entrada: nenhum token antigo é
 * devolvido depois de um erro. `cache` não é lido nem escrito; só identifica
 * a entrada para `descartarAccessToken`.
 */
export async function obterAccessToken(cache: Cache, cred: CredenciaisAmazon, opts: { forcar?: boolean } = {}): Promise<string> {
  const chave = chaveDa(cred);
  chavePorCache.set(cache, chave);
  if (opts.forcar) memoria.delete(chave);
  else {
    const atual = memoria.get(chave);
    if (atual && aindaServe(atual)) return atual.token;
  }
  // Uma renovação em voo sempre traz um token novo: `forcar` pode se juntar a ela.
  let voo = emVoo.get(chave);
  if (!voo) {
    voo = trocarRefreshPorAccess(cred)
      .then(novo => { memoria.set(chave, novo); return novo; }, (e: unknown) => { memoria.delete(chave); throw e; })
      .finally(() => emVoo.delete(chave));
    emVoo.set(chave, voo);
  }
  return (await voo).token;
}

/**
 * Descarta o access token guardado (por exemplo, depois de um 403 de token
 * inválido). Com o mesmo `cache` usado em `obterAccessToken`, apaga só a
 * entrada daquela credencial; com um `cache` desconhecido, apaga todas desta
 * instância (custa no máximo uma troca extra por credencial).
 */
export async function descartarAccessToken(cache: Cache): Promise<void> {
  const chave = chavePorCache.get(cache);
  if (chave) memoria.delete(chave);
  else memoria.clear();
}

export const CHAVES_LWA = K;
