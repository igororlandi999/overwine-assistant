/**
 * Dono único da cadeia de tokens do Bling (OAuth 2.0, authorization code, JWT).
 *
 * REGRA ABSOLUTA, a mesma do Mercado Livre: nenhum token, code ou client
 * secret deste módulo sai do backend. Nenhuma função exportada devolve token
 * para fora do módulo bling, e nenhum log contém esses valores.
 *
 * Fluxo (guia "Aplicativos" do Bling):
 *  1. iniciarAutorizacao: gera um `state` aleatório de uso único (10 min) e
 *     devolve a URL de consentimento. redirect_uri e escopos NÃO vão na URL:
 *     o Bling usa sempre os do cadastro do aplicativo.
 *  2. A pessoa autoriza no Bling, que redireciona para o link cadastrado com
 *     `code` (expira em 30 s) e `state`.
 *  3. concluirAutorizacao: consome o `state` (compare-and-delete atômico; um
 *     state repetido ou desconhecido é recusado ANTES de qualquer chamada ao
 *     Bling) e troca o code, sob o mesmo lock da renovação.
 *  4. obterAccessToken: devolve o access token em cache ou renova com o
 *     refresh token, sob lock distribuído.
 *
 * Persistência ATÔMICA: access token, validade e refresh token vivem numa
 * ÚNICA chave (`bling:tokens`), gravada por um único SET. Não existe estado
 * intermediário em que o refresh novo foi gravado e o access não (ou o
 * contrário): ou a cadeia nova inteira está publicada, ou a anterior continua.
 *
 * Concorrência entre instâncias serverless: toda escrita da cadeia (troca do
 * code e renovação) acontece com o lock `bling:refresh_lock` (SET NX + valor
 * de propriedade + compare-and-delete). O lock dura 30 s e a chamada ao
 * /oauth/token tem timeout de 10 s. Antes de publicar, a cadeia é relida: se
 * outra escrita aconteceu nesse meio-tempo, a nossa não a sobrescreve.
 *
 * Refresh recusado (HTTP 400/401): NADA é apagado. Grava-se uma marca com a
 * impressão digital (sha256 truncado) do refresh token recusado, por 15 min.
 * Enquanto a marca casar com o refresh da cadeia atual, as chamadas falham na
 * hora pedindo nova autorização, sem tocar no /oauth/token (protege o IP do
 * bloqueio do Bling: mais de 20 chamadas a /oauth/token em 60 s = 60 min de
 * bloqueio). Se outra instância (ou uma nova autorização) publicar uma cadeia
 * com outro refresh, a marca deixa de casar e não afeta a cadeia nova.
 *
 * Teto local de chamadas a /oauth/token: 10 por minuto, contado no Redis
 * (compartilhado entre instâncias).
 */
import { randomBytes, createHash } from 'node:crypto';
import type { Cache } from '../lib/cache/cache.js';
import { lerConfigBling, type ConfigBling } from './config.js';
import {
  BLING_AUTHORIZE_URL, BLING_TOKEN_URL, HEADER_JWT, REFRESH_TTL_S, ACCESS_TTL_PADRAO_S,
} from './contrato.js';
import { BlingAutorizacaoError, BlingHttpError, BlingLimiteError } from './erros.js';

export const K = {
  cadeia: 'bling:tokens', // JSON { access, expiresAt, refresh }
  lock: 'bling:refresh_lock',
  recusado: 'bling:refresh_recusado', // impressão digital do refresh recusado
  state: (s: string) => `bling:oauth_state:${s}`,
  chamadasToken: (janela: number) => `bling:token_calls:${janela}`,
};

const RENEW_MARGIN_MS = 5 * 60 * 1000;
const STATE_TTL_S = 600;
const LOCK_TTL_S = 30;
const RECUSA_TTL_S = 900;
const TIMEOUT_MS = 10_000;
/** Metade do limite do Bling (20/min): folga para outra instância e para o próprio erro. */
export const TETO_LOCAL_TOKEN_POR_MINUTO = 10;
const FORMATO_STATE = /^[a-f0-9]{48}$/;

export interface DepsBling {
  fetch?: typeof fetch;
  agora?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AccessToken {
  token: string;
  expiresAt: number; // epoch ms
}

interface Cadeia {
  access: string;
  expiresAt: number;
  refresh: string;
}

interface RespostaToken {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

const dormir = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Impressão digital NÃO reversível do refresh token (só para comparar). */
export function impressao(refresh: string): string {
  return createHash('sha256').update(refresh).digest('hex').slice(0, 16);
}

function parseCadeia(raw: string | null): Cadeia | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Cadeia;
    if (typeof p?.access === 'string' && p.access && typeof p.refresh === 'string' && p.refresh
      && typeof p.expiresAt === 'number') return p;
  } catch {
    /* cache corrompido: tratado como ausente */
  }
  return null;
}

function tipoDoErro(corpo: unknown): string | undefined {
  if (!corpo || typeof corpo !== 'object') return undefined;
  const c = corpo as { error?: unknown };
  if (typeof c.error === 'string') return c.error.slice(0, 60);
  if (c.error && typeof c.error === 'object') {
    const t = (c.error as { type?: unknown }).type;
    if (typeof t === 'string') return t.slice(0, 60);
  }
  return undefined;
}

/**
 * POST /oauth/token com as credenciais do app em Basic (o Bling não aceita
 * client_id/secret no corpo). Aplica o teto local antes de sair. Erro de rede
 * vira BlingHttpError sem detalhes da requisição.
 */
async function requisicaoToken(
  cache: Cache, cfg: ConfigBling, corpo: Record<string, string>, deps: DepsBling,
): Promise<{ status: number; dados: RespostaToken | null; tipo?: string }> {
  const janela = Math.floor((deps.agora ?? Date.now)() / 60_000);
  if ((await cache.incr(K.chamadasToken(janela), 60)) > TETO_LOCAL_TOKEN_POR_MINUTO) {
    throw new BlingLimiteError('teto local de chamadas a /oauth/token atingido', 'local_token', (janela + 1) * 60_000);
  }
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(BLING_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: '1.0',
        Authorization: `Basic ${basic}`,
        ...HEADER_JWT,
      },
      body: new URLSearchParams(corpo),
      signal: ctl.signal,
    });
  } catch (e) {
    const motivo = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'erro de rede';
    throw new BlingHttpError(`endpoint de token do Bling indisponível (${motivo})`, 0);
  } finally {
    clearTimeout(timer);
  }
  let json: unknown = null;
  try { json = await res.json(); } catch { /* corpo não JSON */ }
  if (!res.ok) return { status: res.status, dados: null, tipo: tipoDoErro(json) };
  return { status: res.status, dados: json as RespostaToken };
}

/** Monta a cadeia nova. Se o Bling não rotacionar o refresh, mantém o anterior. */
function novaCadeia(d: RespostaToken, refreshAnterior: string | null, agora: number): Cadeia | null {
  const refresh = d.refresh_token || refreshAnterior;
  if (!d.access_token || !refresh) return null;
  const expiresIn = typeof d.expires_in === 'number' && d.expires_in > 0 ? d.expires_in : ACCESS_TTL_PADRAO_S;
  return { access: d.access_token, expiresAt: agora + expiresIn * 1000, refresh };
}

/** Um único SET: a cadeia inteira muda de uma vez ou não muda. */
async function gravarCadeia(cache: Cache, c: Cadeia): Promise<void> {
  await cache.set(K.cadeia, JSON.stringify(c), REFRESH_TTL_S);
}

const paraToken = (c: Cadeia): AccessToken => ({ token: c.access, expiresAt: c.expiresAt });

/** Adquire o lock da cadeia, esperando um pouco se outra instância o tiver. */
async function adquirirLock(cache: Cache, sleep: (ms: number) => Promise<void>, tentativas: number): Promise<string | null> {
  const dono = randomBytes(16).toString('hex');
  for (let i = 0; i <= tentativas; i++) {
    if (await cache.setNX(K.lock, dono, LOCK_TTL_S)) return dono;
    if (i < tentativas) await sleep(500);
  }
  return null;
}

/** Passo 1: URL de consentimento + state de uso único. Não chama o Bling. */
export async function iniciarAutorizacao(cache: Cache): Promise<{ url: string; expiraEmS: number }> {
  const cfg = lerConfigBling();
  const state = randomBytes(24).toString('hex');
  await cache.set(K.state(state), '1', STATE_TTL_S);
  const q = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, state });
  return { url: `${BLING_AUTHORIZE_URL}?${q.toString()}`, expiraEmS: STATE_TTL_S };
}

/**
 * Passo 3: troca o code. O state é consumido antes de tudo; se não for nosso,
 * nada é chamado nem gravado. Devolve só metadados (nunca tokens).
 */
export async function concluirAutorizacao(
  cache: Cache, entrada: { code?: unknown; state?: unknown }, deps: DepsBling = {},
): Promise<{ expiresAt: number; escopos: string[] }> {
  const cfg = lerConfigBling();
  const sleep = deps.sleep ?? dormir;
  const state = typeof entrada.state === 'string' ? entrada.state : '';
  const code = typeof entrada.code === 'string' ? entrada.code.trim() : '';
  if (!FORMATO_STATE.test(state) || !(await cache.delIfEquals(K.state(state), '1'))) {
    throw new BlingAutorizacaoError('state inválido, expirado ou já utilizado; autorização interrompida');
  }
  if (!code || code.length > 512) throw new BlingAutorizacaoError('code ausente ou inválido');

  // O code vale 30 s: espera no máximo ~5 s por uma renovação em andamento.
  const dono = await adquirirLock(cache, sleep, 10);
  if (!dono) throw new BlingHttpError('renovação de token em andamento; inicie a autorização novamente', 503);
  try {
    const r = await requisicaoToken(cache, cfg, { grant_type: 'authorization_code', code }, deps);
    const c = r.dados?.refresh_token ? novaCadeia(r.dados, null, (deps.agora ?? Date.now)()) : null;
    if (!c) {
      throw new BlingAutorizacaoError(`troca do code recusada pelo Bling (HTTP ${r.status}${r.tipo ? `, ${r.tipo}` : ''})`);
    }
    // Autorização explícita de uma pessoa: substitui a cadeia anterior.
    await gravarCadeia(cache, c);
    const escopos = typeof r.dados!.scope === 'string' ? r.dados!.scope.split(/\s+/).filter(Boolean) : [];
    return { expiresAt: c.expiresAt, escopos };
  } finally {
    await cache.delIfEquals(K.lock, dono);
  }
}

/**
 * Access token válido, com renovação antecipada e lock distribuído. INTERNO
 * ao módulo bling (usado só pelo cliente HTTP).
 *
 * `rejeitado`: token que a API acabou de recusar com 401. Se a cadeia atual
 * ainda tiver esse token, ele é renovado mesmo sem ter expirado; se outra
 * instância já o substituiu, o novo é devolvido sem chamar o Bling.
 */
export async function obterAccessToken(
  cache: Cache, deps: DepsBling = {}, opts: { rejeitado?: string } = {},
): Promise<AccessToken> {
  const cfg = lerConfigBling();
  const agora = deps.agora ?? Date.now;
  const sleep = deps.sleep ?? dormir;
  const utilizavel = (c: Cadeia | null): boolean =>
    !!c && c.access !== opts.rejeitado && c.expiresAt - agora() > RENEW_MARGIN_MS;
  const exigirNaoRecusado = async (c: Cadeia) => {
    if ((await cache.get(K.recusado)) === impressao(c.refresh)) {
      throw new BlingAutorizacaoError('refresh token recusado pelo Bling; autorize o aplicativo novamente');
    }
  };

  const atual = parseCadeia(await cache.get(K.cadeia));
  if (utilizavel(atual)) return paraToken(atual!);
  if (!atual) throw new BlingAutorizacaoError('Bling não autorizado: cadeia de tokens ausente ou expirada');
  await exigirNaoRecusado(atual);

  const dono = randomBytes(16).toString('hex');
  if (!(await cache.setNX(K.lock, dono, LOCK_TTL_S))) {
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      const c = parseCadeia(await cache.get(K.cadeia));
      if (utilizavel(c)) return paraToken(c!);
    }
    throw new BlingHttpError('timeout aguardando renovação do token Bling por outra instância', 503);
  }

  try {
    const lida = parseCadeia(await cache.get(K.cadeia));
    if (utilizavel(lida)) return paraToken(lida!);
    if (!lida) throw new BlingAutorizacaoError('Bling não autorizado: cadeia de tokens ausente ou expirada');
    await exigirNaoRecusado(lida);

    const r = await requisicaoToken(cache, cfg, { grant_type: 'refresh_token', refresh_token: lida.refresh }, deps);
    const nova = r.dados ? novaCadeia(r.dados, lida.refresh, agora()) : null;
    if (nova) {
      // Releitura antes de publicar: se a cadeia mudou (nova autorização, ou
      // outra instância depois de o lock expirar), não sobrescreve.
      const agoraNoCache = await cache.get(K.cadeia);
      if (agoraNoCache === null || parseCadeia(agoraNoCache)?.refresh === lida.refresh) {
        await gravarCadeia(cache, nova);
      }
      return paraToken(nova);
    }

    if (r.status === 400 || r.status === 401) {
      await cache.set(K.recusado, impressao(lida.refresh), RECUSA_TTL_S);
      throw new BlingAutorizacaoError(`refresh recusado pelo Bling (HTTP ${r.status}${r.tipo ? `, ${r.tipo}` : ''}); autorize o aplicativo novamente`);
    }
    throw new BlingHttpError(`falha ao renovar token Bling (HTTP ${r.status})`, r.status, r.tipo);
  } finally {
    await cache.delIfEquals(K.lock, dono);
  }
}

/** Estado da autorização, sem tokens e sem chamar o Bling. Seguro para diagnóstico. */
export async function estadoAutorizacao(cache: Cache, agora = Date.now()): Promise<{
  autorizado: boolean; accessValidoAte: string | null; reautorizacaoNecessaria: boolean;
}> {
  const [raw, recusado] = await cache.mget([K.cadeia, K.recusado]);
  const c = parseCadeia(raw);
  const recusada = !!c && recusado === impressao(c.refresh);
  return {
    autorizado: !!c && !recusada,
    accessValidoAte: c && c.expiresAt > agora ? new Date(c.expiresAt).toISOString() : null,
    reautorizacaoNecessaria: !c || recusada,
  };
}
