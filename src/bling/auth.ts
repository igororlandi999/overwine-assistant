/**
 * Dono único da cadeia de tokens do Bling (OAuth 2.0, authorization code, JWT).
 *
 * REGRA ABSOLUTA, a mesma do Mercado Livre: nenhum token, code ou client
 * secret deste módulo sai do backend. Nenhuma função exportada devolve token
 * para fora do módulo bling, e nenhum log contém esses valores.
 *
 * Este módulo cuida da cadeia ATIVA e das chamadas a /oauth/token. O fluxo
 * de autorização (state, callback, validação da empresa, confirmação
 * administrativa) está em autorizacao.ts, que usa trocarCode daqui.
 *
 * Só uma cadeia VALIDADA (empresa identificada e conferida por CNPJ ou por
 * confirmação manual) é aceita como cadeia ativa: parseCadeia recusa
 * qualquer valor sem empresa e sem tipo de validação, e obterAccessToken
 * trata isso como "não autorizado".
 *
 * Persistência ATÔMICA: access token, validade, refresh token e geração
 * vivem numa ÚNICA chave (`bling:tokens`), gravada por um único comando. Não existe estado
 * intermediário em que o refresh novo foi gravado e o access não (ou o
 * contrário): ou a cadeia nova inteira está publicada, ou a anterior continua.
 *
 * Concorrência entre instâncias serverless: duas camadas.
 *  - Lock `bling:refresh_lock` (SET NX + valor de propriedade + compare-and-
 *    delete): evita que várias instâncias chamem o /oauth/token ao mesmo
 *    tempo. Dura 30 s; a chamada ao Bling tem timeout de 10 s.
 *  - Compare-and-set atômico (Cache.setIfEquals, script Lua no Upstash): é o
 *    que garante a CORREÇÃO. A renovação só publica se a cadeia no Redis
 *    ainda for exatamente a que ela leu (valor inteiro, incluindo a
 *    `geracao`, nunca só o refresh token). Se o lock expirar no meio da
 *    chamada e outra instância publicar antes, a escrita atrasada é
 *    descartada e a cadeia vencedora é relida e usada.
 *
 * Refresh recusado (HTTP 400/401): NADA é apagado. Grava-se uma marca com a
 * impressão digital (sha256 truncado) da cadeia recusada, por 15 min.
 * Enquanto a marca casar com a cadeia atual, as chamadas falham na hora
 * pedindo nova autorização, sem tocar no /oauth/token (protege o IP do
 * bloqueio do Bling: mais de 20 chamadas a /oauth/token em 60 s = 60 min de
 * bloqueio). Qualquer cadeia publicada depois (outra instância ou nova
 * autorização) tem outra geração, e a marca deixa de casar.
 *
 * Teto local de chamadas a /oauth/token: 10 por minuto, contado no Redis
 * (compartilhado entre instâncias).
 */
import { randomBytes, createHash } from 'node:crypto';
import type { Cache } from '../lib/cache/cache.js';
import { lerConfigBling, type ConfigBling } from './config.js';
import {
  BLING_TOKEN_URL, HEADER_JWT, REFRESH_TTL_S, ACCESS_TTL_PADRAO_S,
} from './contrato.js';
import { BlingAutorizacaoError, BlingHttpError, BlingLimiteError } from './erros.js';

export const K = {
  cadeia: 'bling:tokens', // JSON Cadeia (só cadeias validadas)
  lock: 'bling:refresh_lock',
  recusado: 'bling:refresh_recusado', // impressão digital da cadeia recusada
  state: (s: string) => `bling:oauth_state:${s}`,
  chamadasToken: (janela: number) => `bling:token_calls:${janela}`,
};

const RENEW_MARGIN_MS = 5 * 60 * 1000;
const LOCK_TTL_S = 30;
const RECUSA_TTL_S = 900;
const TIMEOUT_MS = 10_000;
/** Metade do limite do Bling (20/min): folga para outra instância e para o próprio erro. */
export const TETO_LOCAL_TOKEN_POR_MINUTO = 10;

export interface DepsBling {
  fetch?: typeof fetch;
  agora?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AccessToken {
  token: string;
  expiresAt: number; // epoch ms
}

/** Empresa identificada por GET /empresas/me/dados-basicos. */
export interface EmpresaBling {
  id: string;
  nome: string;
  /** 14 dígitos, sem pontuação. */
  cnpj: string;
}

/** Como a empresa da cadeia foi conferida antes de virar fonte de dados. */
export type Validacao = 'cnpj' | 'manual';

export interface Cadeia {
  access: string;
  expiresAt: number;
  refresh: string;
  /**
   * Identificador aleatório de CADA escrita. Garante que duas cadeias nunca
   * tenham o mesmo valor serializado, mesmo que o Bling devolva tokens
   * iguais ou não rotacione o refresh: o compare-and-set compara a cadeia
   * inteira, não o refresh token.
   */
  geracao: string;
  empresa: EmpresaBling;
  validacao: Validacao;
}

interface RespostaToken {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

const dormir = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Impressão digital NÃO reversível de um valor (só para comparar). */
export function impressao(valor: string): string {
  return createHash('sha256').update(valor).digest('hex').slice(0, 16);
}

export function parseCadeia(raw: string | null): Cadeia | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Cadeia;
    if (typeof p?.access === 'string' && p.access && typeof p.refresh === 'string' && p.refresh
      && typeof p.expiresAt === 'number' && typeof p.geracao === 'string' && p.geracao
      && typeof p.empresa?.id === 'string' && p.empresa.id
      && typeof p.empresa.cnpj === 'string' && /^\d{14}$/.test(p.empresa.cnpj)
      && typeof p.empresa.nome === 'string'
      && (p.validacao === 'cnpj' || p.validacao === 'manual')) return p;
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

/** Tokens recém-obtidos, ainda sem empresa conferida. NUNCA são cadeia ativa. */
export interface TokensObtidos {
  access: string;
  expiresAt: number;
  refresh: string;
}

function tokensDaResposta(d: RespostaToken, refreshAnterior: string | null, agora: number): TokensObtidos | null {
  const refresh = d.refresh_token || refreshAnterior;
  if (!d.access_token || !refresh) return null;
  const expiresIn = typeof d.expires_in === 'number' && d.expires_in > 0 ? d.expires_in : ACCESS_TTL_PADRAO_S;
  return { access: d.access_token, expiresAt: agora + expiresIn * 1000, refresh };
}

/** Cadeia validada pronta para gravar: cada montagem recebe geração nova. */
export function montarCadeia(t: TokensObtidos, empresa: EmpresaBling, validacao: Validacao): Cadeia {
  return { ...t, geracao: randomBytes(8).toString('hex'), empresa, validacao };
}

/** Prazo da chave da cadeia no Redis (validade documentada do refresh token). */
export const CADEIA_TTL_S = REFRESH_TTL_S;

const paraToken = (c: Cadeia): AccessToken => ({ token: c.access, expiresAt: c.expiresAt });

/**
 * Troca o authorization code por tokens. NÃO grava nada: quem decide se os
 * tokens viram cadeia ativa, pendente ou são descartados é autorizacao.ts,
 * depois de identificar a empresa.
 */
export async function trocarCode(cache: Cache, code: string, deps: DepsBling = {}): Promise<TokensObtidos> {
  const cfg = lerConfigBling();
  const r = await requisicaoToken(cache, cfg, { grant_type: 'authorization_code', code }, deps);
  const t = r.dados?.refresh_token ? tokensDaResposta(r.dados, null, (deps.agora ?? Date.now)()) : null;
  if (!t) throw new BlingAutorizacaoError(`troca do code recusada pelo Bling (HTTP ${r.status}${r.tipo ? `, ${r.tipo}` : ''})`);
  return t;
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
  const exigirNaoRecusado = async (raw: string) => {
    if ((await cache.get(K.recusado)) === impressao(raw)) {
      throw new BlingAutorizacaoError('refresh token recusado pelo Bling; autorize o aplicativo novamente');
    }
  };

  const rawAtual = await cache.get(K.cadeia);
  const atual = parseCadeia(rawAtual);
  if (utilizavel(atual)) return paraToken(atual!);
  if (!atual) throw new BlingAutorizacaoError('Bling não autorizado: cadeia de tokens ausente ou expirada');
  await exigirNaoRecusado(rawAtual!);

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
    const rawLida = await cache.get(K.cadeia);
    const lida = parseCadeia(rawLida);
    if (utilizavel(lida)) return paraToken(lida!);
    if (!lida) throw new BlingAutorizacaoError('Bling não autorizado: cadeia de tokens ausente ou expirada');
    await exigirNaoRecusado(rawLida!);

    const r = await requisicaoToken(cache, cfg, { grant_type: 'refresh_token', refresh_token: lida.refresh }, deps);
    const tokens = r.dados ? tokensDaResposta(r.dados, lida.refresh, agora()) : null;
    // A renovação mantém a empresa e a validação da cadeia que renovou.
    const nova = tokens ? montarCadeia(tokens, lida.empresa, lida.validacao) : null;
    if (nova) {
      // Compare-and-set ATÔMICO contra a cadeia exata que lemos (valor
      // serializado inteiro, com a geração). Se outra escrita aconteceu desde
      // a leitura (lock expirado no meio da chamada, ou nova autorização), a
      // nossa é descartada e vale a cadeia vencedora. O token que acabamos de
      // obter NUNCA é devolvido sem ter sido persistido.
      if (await cache.setIfEquals(K.cadeia, rawLida!, JSON.stringify(nova), REFRESH_TTL_S)) return paraToken(nova);
      const vencedora = parseCadeia(await cache.get(K.cadeia));
      if (utilizavel(vencedora)) return paraToken(vencedora!);
      throw new BlingHttpError('cadeia de tokens alterada por outra escrita durante a renovação; tente novamente', 409);
    }

    if (r.status === 400 || r.status === 401) {
      // Marca a cadeia EXATA que foi recusada (com a geração). Qualquer cadeia
      // escrita depois, mesmo com o mesmo refresh token, não casa com a marca.
      await cache.set(K.recusado, impressao(rawLida!), RECUSA_TTL_S);
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
  const recusada = !!c && recusado === impressao(raw!);
  return {
    autorizado: !!c && !recusada,
    accessValidoAte: c && c.expiresAt > agora ? new Date(c.expiresAt).toISOString() : null,
    reautorizacaoNecessaria: !c || recusada,
  };
}
