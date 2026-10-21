/**
 * Cliente da SP-API para UMA conta: access token, limite por operação e
 * tradução de erros. Não conhece pedidos, anúncios nem financeiro.
 *
 * LIMITE POR OPERAÇÃO (balde de fichas, como a própria SP-API descreve):
 * o balde começa cheio no `burst` e se repõe a `rate` fichas por segundo.
 * O estado fica no cache DA CONTA (`amz:rl:<operacao>`), então o ritmo vale
 * entre invocações. Começa pelo padrão do contrato e passa a usar o valor do
 * cabeçalho `x-amzn-RateLimit-Limit` quando a Amazon o devolve. A
 * sincronização roda sob lock por conta, então um único consumidor mexe no
 * balde por vez.
 *
 * Sem ficha: espera se a espera couber em `esperaMaxMs` (curta, porque a
 * função serverless tem 30 s); senão devolve `limite_local` com a espera
 * necessária, e quem chamou para e continua na próxima invocação.
 */
import type { Cache } from '../lib/cache/cache.js';
import type { CredenciaisAmazon } from './credenciais.js';
import { obterAccessToken, descartarAccessToken } from './lwa.js';
import { OPERACOES, SP_API_HOST, type OperacaoAmazon } from './contrato.js';

export type MotivoErroSpApi =
  | 'limite_local'        // balde vazio: tente depois de `esperaMs`
  | 'limite_amazon'       // HTTP 429 da Amazon
  | 'sem_permissao'       // HTTP 403 que não é token: app sem a função (role) para a operação, ou conta não autorizada
  | 'requisicao_invalida' // HTTP 400
  | 'nao_encontrado'      // HTTP 404
  | 'indisponivel';       // rede, timeout, 5xx

export class ErroSpApi extends Error {
  constructor(
    public readonly motivo: MotivoErroSpApi,
    public readonly operacao: OperacaoAmazon,
    public readonly status: number | null,
    public readonly esperaMs: number | null = null,
    detalhe = '',
  ) {
    super(`${operacao}: ${motivo}${status ? ` (HTTP ${status})` : ''}${detalhe ? ` ${detalhe}` : ''}`);
    this.name = 'ErroSpApi';
  }
}

interface Balde { fichas: number; em: number; rate: number; burst: number; fonte: 'contrato' | 'cabecalho' }

export interface ClienteSpApi {
  chamar<T>(op: OperacaoAmazon, params?: { caminho?: Record<string, string>; query?: Record<string, string | number | boolean | readonly string[] | undefined> }): Promise<T>;
  /** Estado dos baldes lidos/alterados nesta instância (diagnóstico, sem segredo). */
  limites(): Promise<Record<string, { rate: number; burst: number; fonte: string }>>;
}

export interface OpcoesCliente {
  esperaMaxMs?: number;
  dormir?: (ms: number) => Promise<void>;
  agora?: () => number;
  timeoutMs?: number;
}

const chaveBalde = (op: OperacaoAmazon) => `amz:rl:${op}`;

export function criarClienteSpApi(cache: Cache, cred: CredenciaisAmazon, opts: OpcoesCliente = {}): ClienteSpApi {
  const esperaMax = opts.esperaMaxMs ?? 2_000;
  const dormir = opts.dormir ?? (ms => new Promise(r => setTimeout(r, ms)));
  const agora = opts.agora ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const usadas = new Set<OperacaoAmazon>();

  async function lerBalde(op: OperacaoAmazon): Promise<Balde> {
    const raw = await cache.get(chaveBalde(op));
    const padrao = OPERACOES[op].limite;
    let b: Balde = { fichas: padrao.burst, em: agora(), rate: padrao.rate, burst: padrao.burst, fonte: 'contrato' };
    if (raw) { try { b = JSON.parse(raw) as Balde; } catch { /* volta ao padrão */ } }
    const decorrido = Math.max(0, agora() - b.em) / 1000;
    return { ...b, fichas: Math.min(b.burst, b.fichas + decorrido * b.rate), em: agora() };
  }
  async function gravarBalde(op: OperacaoAmazon, b: Balde): Promise<void> {
    // Expira quando o balde estaria cheio de novo: sem chave = balde cheio.
    const ttl = Math.max(60, Math.ceil(b.burst / b.rate) + 60);
    await cache.set(chaveBalde(op), JSON.stringify(b), ttl);
  }

  async function consumirFicha(op: OperacaoAmazon): Promise<void> {
    let b = await lerBalde(op);
    if (b.fichas < 1) {
      const espera = Math.ceil(((1 - b.fichas) / b.rate) * 1000);
      if (espera > esperaMax) throw new ErroSpApi('limite_local', op, null, espera);
      await dormir(espera);
      b = await lerBalde(op);
    }
    b.fichas = Math.max(0, b.fichas - 1);
    await gravarBalde(op, b);
  }

  async function aplicarCabecalho(op: OperacaoAmazon, res: Response): Promise<void> {
    const v = Number(res.headers.get('x-amzn-ratelimit-limit'));
    if (!Number.isFinite(v) || v <= 0) return;
    const b = await lerBalde(op);
    if (b.rate === v && b.fonte === 'cabecalho') return;
    await gravarBalde(op, { ...b, rate: v, fonte: 'cabecalho' });
  }

  function montarUrl(op: OperacaoAmazon, caminho: Record<string, string> = {}, query: Record<string, unknown> = {}): string {
    let p = OPERACOES[op].caminho;
    for (const [k, v] of Object.entries(caminho)) p = p.replace(`{${k}}`, encodeURIComponent(v));
    if (/\{[^}]+\}/.test(p)) throw new Error(`${op}: parâmetro de caminho ausente em ${p}`);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      // Swagger 2 sem collectionFormat = csv: listas viajam separadas por vírgula.
      qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    const s = qs.toString();
    return SP_API_HOST + p + (s ? `?${s}` : '');
  }

  async function uma(op: OperacaoAmazon, url: string, forcarToken: boolean): Promise<Response> {
    const token = await obterAccessToken(cache, cred, { forcar: forcarToken });
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetch(url, {
        method: OPERACOES[op].metodo,
        headers: { 'x-amz-access-token': token, Accept: 'application/json', 'User-Agent': 'overwine-dashboard/1.0 (Language=TypeScript)' },
        signal: ctl.signal,
      });
    } catch (e) {
      throw new ErroSpApi('indisponivel', op, null, null, e instanceof Error ? e.name : '');
    } finally {
      clearTimeout(t);
    }
  }

  return {
    async chamar<T>(op: OperacaoAmazon, params: { caminho?: Record<string, string>; query?: Record<string, unknown> } = {}): Promise<T> {
      usadas.add(op);
      const url = montarUrl(op, params.caminho, params.query);
      await consumirFicha(op);
      let res = await uma(op, url, false);
      if (res.status === 403 && await pareceTokenInvalido(res)) {
        // Access token recusado: descarta e tenta UMA vez com token novo.
        await descartarAccessToken(cache);
        await consumirFicha(op);
        res = await uma(op, url, true);
      }
      await aplicarCabecalho(op, res);
      if (res.ok) return await res.json() as T;
      const codigo = await codigoErro(res);
      if (res.status === 429) {
        const b = await lerBalde(op);
        await gravarBalde(op, { ...b, fichas: 0 });
        throw new ErroSpApi('limite_amazon', op, 429, Math.ceil(1000 / b.rate), codigo);
      }
      if (res.status === 403) throw new ErroSpApi('sem_permissao', op, 403, null, codigo);
      if (res.status === 400) throw new ErroSpApi('requisicao_invalida', op, 400, null, codigo);
      if (res.status === 404) throw new ErroSpApi('nao_encontrado', op, 404, null, codigo);
      throw new ErroSpApi('indisponivel', op, res.status, null, codigo);
    },
    async limites() {
      const out: Record<string, { rate: number; burst: number; fonte: string }> = {};
      for (const op of usadas) { const b = await lerBalde(op); out[op] = { rate: b.rate, burst: b.burst, fonte: b.fonte }; }
      return out;
    },
  };
}

/** Lê o corpo de erro (ErrorList) sem consumir a resposta original. */
async function lerErros(res: Response): Promise<Array<{ code?: string; message?: string }>> {
  try {
    const j = await res.clone().json() as { errors?: Array<{ code?: string; message?: string }> };
    return Array.isArray(j?.errors) ? j.errors : [];
  } catch { return []; }
}
async function codigoErro(res: Response): Promise<string> {
  const e = await lerErros(res);
  return e.map(x => x.code).filter(Boolean).join(',').slice(0, 80);
}
/** 403 por token expirado/inválido (renovável) — diferente de 403 por falta de função. */
async function pareceTokenInvalido(res: Response): Promise<boolean> {
  const e = await lerErros(res);
  return e.some(x => /access token/i.test(x.message ?? '') && /(expired|invalid|revoked)/i.test(x.message ?? ''));
}
