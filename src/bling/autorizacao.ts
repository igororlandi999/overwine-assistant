/**
 * Fluxo administrativo de autorização do Bling.
 *
 *  1. iniciarAutorizacao (administrador: sessão do dashboard + ADMIN_KEY):
 *     gera um `state` de 192 bits, de uso único, válido por 10 min, ligado à
 *     impressão digital da sessão que o pediu. Devolve a URL de consentimento.
 *  2. A pessoa autoriza no Bling, que redireciona o navegador para o
 *     callback cadastrado no aplicativo, com `code` (30 s) e `state`.
 *  3. concluirAutorizacao (callback, SEM sessão: o redirecionamento do Bling
 *     não carrega o token de sessão do dashboard, que vive no localStorage):
 *     a) consome o state atomicamente (leitura + compare-and-delete); state
 *        desconhecido, expirado ou já usado é recusado antes de qualquer
 *        chamada ao Bling;
 *     b) troca o code por tokens (nada é gravado ainda);
 *     c) identifica a empresa com GET /empresas/me/dados-basicos usando o
 *        token recém-obtido;
 *     d) decide:
 *        - BLING_CNPJ_ESPERADO definido e diferente: recusa; os tokens são
 *          descartados e nada é gravado;
 *        - em QUALQUER outro caso (inclusive CNPJ conferido e nenhuma
 *          conexão ativa), a autorização fica PENDENTE. O callback nunca
 *          ativa nada: a primeira conexão também exige confirmação.
 *     Qualquer falha em (b) ou (c) não grava nada: a conexão anterior,
 *     se houver, segue funcionando.
 *  4. confirmarPendente (administrador, MESMA sessão que iniciou): exige o
 *     CNPJ da empresa pendente digitado de volta e, se já houver conexão
 *     ativa, `substituir: true`. A troca é um compare-and-set contra a
 *     conexão ativa lida: se ela mudou no meio-tempo, nada é sobrescrito.
 *
 * Uma autorização pendente NUNCA é usada como fonte de dados: ela vive numa
 * chave separada, que o cliente HTTP não lê.
 */
import { randomBytes } from 'node:crypto';
import type { Cache } from '../lib/cache/cache.js';
import { lerConfigBling, digitosCnpj } from './config.js';
import { BLING_AUTHORIZE_URL } from './contrato.js';
import {
  K, trocarCode, montarCadeia, parseCadeia, impressao, CADEIA_TTL_S,
  type DepsBling, type EmpresaBling, type Validacao, type Cadeia,
} from './auth.js';
import { obterEmpresaDoToken } from './leitura.js';
import { BlingAutorizacaoError, BlingErro } from './erros.js';

export const KA = {
  state: K.state,
  pendente: 'bling:autorizacao_pendente',
};

export const STATE_TTL_S = 600;
export const PENDENTE_TTL_S = 24 * 3600;
const FORMATO_STATE = /^[a-f0-9]{48}$/;
const FORMATO_ID_PENDENTE = /^[a-f0-9]{32}$/;

interface RegistroState { sessao: string; criadoEm: number }

/** Se havia conexão ativa quando a autorização chegou (só informativo; a confirmação reconfere). */
export type MotivoPendente = 'primeira_conexao' | 'substituicao';

interface RegistroPendente {
  id: string;
  cadeia: Cadeia;
  motivo: MotivoPendente;
  /** Impressão digital da sessão que iniciou a autorização. */
  sessao: string;
  criadoEm: number;
}

/** Resultado do callback: só dados seguros (nunca token ou code). */
export type ResultadoCallback =
  | { resultado: 'pendente'; motivo: MotivoPendente; empresa: EmpresaPublica }
  | { resultado: 'recusada_empresa'; empresa: EmpresaPublica }
  | { resultado: 'negada_no_bling' }
  | { resultado: 'state_invalido' }
  | { resultado: 'falha'; codigo: string };

export interface EmpresaPublica { nome: string; cnpj: string }

const publica = (e: EmpresaBling): EmpresaPublica => ({ nome: e.nome, cnpj: formatarCnpj(e.cnpj) });

export function formatarCnpj(d: string): string {
  return d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : d;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function parsePendente(raw: string | null): RegistroPendente | null {
  const p = parseJson<RegistroPendente>(raw);
  if (!p || typeof p.id !== 'string' || typeof p.sessao !== 'string' || typeof p.criadoEm !== 'number') return null;
  if (p.motivo !== 'primeira_conexao' && p.motivo !== 'substituicao') return null;
  return parseCadeia(JSON.stringify(p.cadeia)) ? p : null;
}

/** Passo 1. Não chama o Bling. `sessaoId` vem da sessão já validada pela rota. */
export async function iniciarAutorizacao(cache: Cache, ctx: { sessaoId: string }, agora = Date.now()): Promise<{ url: string; expiraEmS: number }> {
  const cfg = lerConfigBling();
  if (!ctx.sessaoId) throw new BlingAutorizacaoError('sessão administrativa ausente');
  const state = randomBytes(24).toString('hex');
  const reg: RegistroState = { sessao: impressao(ctx.sessaoId), criadoEm: agora };
  await cache.set(KA.state(state), JSON.stringify(reg), STATE_TTL_S);
  const q = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, state });
  return { url: `${BLING_AUTHORIZE_URL}?${q.toString()}`, expiraEmS: STATE_TTL_S };
}

/** Consome o state: só um chamador consegue, mesmo com requisições simultâneas. */
async function consumirState(cache: Cache, state: unknown): Promise<RegistroState | null> {
  if (typeof state !== 'string' || !FORMATO_STATE.test(state)) return null;
  const raw = await cache.get(KA.state(state));
  const reg = parseJson<RegistroState>(raw);
  if (!raw || !reg || typeof reg.sessao !== 'string') return null;
  if (!(await cache.delIfEquals(KA.state(state), raw))) return null;
  return reg;
}

/** Passo 3 (callback). Nunca lança: todo desfecho vira um resultado seguro. */
export async function concluirAutorizacao(
  cache: Cache, entrada: { code?: unknown; state?: unknown; error?: unknown }, deps: DepsBling = {},
): Promise<ResultadoCallback> {
  const agora = deps.agora ?? Date.now;
  try {
    const cfg = lerConfigBling();
    const reg = await consumirState(cache, entrada.state);
    if (!reg) return { resultado: 'state_invalido' };
    if (entrada.error !== undefined && entrada.error !== null && entrada.error !== '') return { resultado: 'negada_no_bling' };
    const code = typeof entrada.code === 'string' ? entrada.code.trim() : '';
    if (!code || code.length > 512) return { resultado: 'falha', codigo: 'code_invalido' };

    const tokens = await trocarCode(cache, code, deps);
    const empresa = await obterEmpresaDoToken(cache, tokens.access, deps);

    if (cfg.cnpjEsperado !== null && empresa.cnpj !== cfg.cnpjEsperado) {
      // Empresa errada: os tokens são descartados aqui (não gravados).
      return { resultado: 'recusada_empresa', empresa: publica(empresa) };
    }

    const validacao: Validacao = cfg.cnpjEsperado !== null ? 'cnpj' : 'manual';
    const cadeia = montarCadeia(tokens, empresa, validacao);

    // Nunca ativa aqui: toda autorização espera a confirmação administrativa.
    const motivo: MotivoPendente = (await cache.get(K.cadeia)) === null ? 'primeira_conexao' : 'substituicao';
    const pendente: RegistroPendente = {
      id: randomBytes(16).toString('hex'), cadeia, motivo, sessao: reg.sessao, criadoEm: agora(),
    };
    await cache.set(KA.pendente, JSON.stringify(pendente), PENDENTE_TTL_S);
    return { resultado: 'pendente', motivo, empresa: publica(empresa) };
  } catch (e) {
    return { resultado: 'falha', codigo: e instanceof BlingErro ? e.codigo : 'erro_interno' };
  }
}

export class ConfirmacaoError extends Error {
  constructor(msg: string, readonly status: number, readonly codigo: string) { super(msg); }
}

/** Passo 4: torna ativa a autorização pendente. */
export async function confirmarPendente(
  cache: Cache, ctx: { sessaoId: string }, entrada: { id?: unknown; cnpj?: unknown; substituir?: unknown },
): Promise<{ resultado: 'ativada'; empresa: EmpresaPublica; substituiu: boolean }> {
  const cfg = lerConfigBling();
  const raw = await cache.get(KA.pendente);
  const p = parsePendente(raw);
  if (!raw || !p) throw new ConfirmacaoError('não há autorização pendente', 404, 'sem_pendente');
  if (typeof entrada.id !== 'string' || !FORMATO_ID_PENDENTE.test(entrada.id) || entrada.id !== p.id) {
    throw new ConfirmacaoError('identificador da autorização pendente não confere', 409, 'id_divergente');
  }
  if (impressao(ctx.sessaoId) !== p.sessao) {
    throw new ConfirmacaoError('a confirmação precisa ser feita pela mesma sessão que iniciou a autorização', 403, 'sessao_divergente');
  }
  if (typeof entrada.cnpj !== 'string' || digitosCnpj(entrada.cnpj) !== p.cadeia.empresa.cnpj) {
    throw new ConfirmacaoError('CNPJ informado não confere com o da empresa autorizada', 409, 'cnpj_divergente');
  }
  if (cfg.cnpjEsperado !== null && p.cadeia.empresa.cnpj !== cfg.cnpjEsperado) {
    throw new ConfirmacaoError('empresa pendente difere de BLING_CNPJ_ESPERADO', 409, 'empresa_nao_esperada');
  }

  // Geração nova: a cadeia confirmada não casa com nenhuma marca de recusa antiga.
  const cadeia = JSON.stringify({ ...p.cadeia, geracao: randomBytes(8).toString('hex') });
  const ativaRaw = await cache.get(K.cadeia);
  let substituiu = false;
  if (ativaRaw === null) {
    if (!(await cache.setNX(K.cadeia, cadeia, CADEIA_TTL_S))) {
      throw new ConfirmacaoError('outra conexão foi ativada durante a confirmação; consulte o estado e tente de novo', 409, 'concorrencia');
    }
  } else {
    if (entrada.substituir !== true) {
      throw new ConfirmacaoError('já existe conexão ativa; para trocar, envie "substituir": true', 409, 'substituicao_exige_confirmacao');
    }
    if (!(await cache.setIfEquals(K.cadeia, ativaRaw, cadeia, CADEIA_TTL_S))) {
      throw new ConfirmacaoError('a conexão ativa mudou durante a confirmação; consulte o estado e tente de novo', 409, 'concorrencia');
    }
    substituiu = true;
  }
  await cache.delIfEquals(KA.pendente, raw);
  return { resultado: 'ativada', empresa: publica(p.cadeia.empresa), substituiu };
}

/** Estado administrativo, sem tokens. Não chama o Bling. */
export async function estadoAdministrativo(cache: Cache, agora = Date.now()) {
  const [rawAtiva, rawPendente, recusado] = await cache.mget([K.cadeia, KA.pendente, K.recusado]);
  const a = parseCadeia(rawAtiva);
  const p = parsePendente(rawPendente);
  return {
    ativa: a ? {
      empresa: publica(a.empresa),
      validacao: a.validacao,
      accessValidoAte: a.expiresAt > agora ? new Date(a.expiresAt).toISOString() : null,
      reautorizacaoNecessaria: recusado === impressao(rawAtiva!),
    } : null,
    pendente: p ? {
      id: p.id,
      empresa: publica(p.cadeia.empresa),
      motivo: p.motivo,
      validacao: p.cadeia.validacao,
      criadoEm: new Date(p.criadoEm).toISOString(),
      expiraEm: new Date(p.criadoEm + PENDENTE_TTL_S * 1000).toISOString(),
    } : null,
  };
}
