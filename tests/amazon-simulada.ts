/**
 * Amazon simulada para os testes da integração: LWA + SP-API.
 *
 * Toda requisição à SP-API é conferida contra o MODELO OFICIAL da operação
 * (tests/contratos/amazon/*.json): parâmetro de query não declarado, valor
 * fora do enum, parâmetro obrigatório ausente ou caminho desconhecido viram
 * HTTP 400 com o corpo de erro do contrato. Assim o teste falha se o código
 * pedir algo que a Amazon real recusaria.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'tests', 'contratos', 'amazon');
export const MODELOS = {
  orders: JSON.parse(readFileSync(join(DIR, 'orders_2026-01-01.json'), 'utf8')),
  finances: JSON.parse(readFileSync(join(DIR, 'finances_2024-06-19.json'), 'utf8')),
  listings: JSON.parse(readFileSync(join(DIR, 'listingsItems_2021-08-01.json'), 'utf8')),
  fbaInventory: JSON.parse(readFileSync(join(DIR, 'fbaInventory.json'), 'utf8')),
};

interface ParamModelo { name: string; in: string; required?: boolean; type?: string; enum?: string[]; items?: { enum?: string[] }; maximum?: number; minimum?: number; maxItems?: number }
interface OpModelo { modelo: any; caminho: string; op: any }

function operacoes(): OpModelo[] {
  const out: OpModelo[] = [];
  for (const modelo of Object.values(MODELOS)) {
    for (const [caminho, metodos] of Object.entries<any>(modelo.paths)) {
      if (metodos.get) out.push({ modelo, caminho, op: metodos.get });
    }
  }
  return out;
}
const OPS = operacoes();

function casar(pathname: string): { op: OpModelo; caminho: Record<string, string> } | null {
  for (const o of OPS) {
    const nomes: string[] = [];
    const re = new RegExp('^' + o.caminho.replace(/\{([^}]+)\}/g, (_, n) => { nomes.push(n); return '([^/]+)'; }) + '$');
    const m = re.exec(pathname);
    if (m) return { op: o, caminho: Object.fromEntries(nomes.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

function resolverParam(modelo: any, p: any): ParamModelo {
  if (p.$ref) return modelo.parameters[p.$ref.split('/').pop()];
  return p;
}

/** Erros de contrato desta requisição (vazio = válida). */
export function validarContraModelo(url: URL): { operationId: string | null; erros: string[]; caminho: Record<string, string> } {
  const c = casar(url.pathname);
  if (!c) return { operationId: null, erros: [`caminho não existe nos modelos: ${url.pathname}`], caminho: {} };
  const params = (c.op.op.parameters as any[]).map(p => resolverParam(c.op.modelo, p));
  const query = params.filter(p => p.in === 'query');
  const erros: string[] = [];
  for (const k of url.searchParams.keys()) if (!query.some(p => p.name === k)) erros.push(`parâmetro não declarado: ${k}`);
  for (const p of query) {
    const v = url.searchParams.get(p.name);
    if (v === null) { if (p.required) erros.push(`obrigatório ausente: ${p.name}`); continue; }
    const valores = p.type === 'array' ? v.split(',') : [v];
    const en = p.type === 'array' ? p.items?.enum : p.enum;
    for (const x of valores) if (en && !en.includes(x)) erros.push(`${p.name}: valor fora do enum: ${x}`);
    if (p.maxItems && valores.length > p.maxItems) erros.push(`${p.name}: mais de ${p.maxItems} itens`);
    if (p.type === 'integer' && (p.maximum !== undefined && Number(v) > p.maximum || p.minimum !== undefined && Number(v) < p.minimum)) erros.push(`${p.name}: fora do intervalo`);
  }
  return { operationId: c.op.op.operationId, erros, caminho: c.caminho };
}

export interface ChamadaRegistrada { operationId: string | null; url: URL; status: number }

export interface Cenario {
  pedidos?: any[];
  anuncios?: any[];
  estoqueFba?: any[] | 'sem_permissao';
  transacoes?: any[];
  /** Cabeçalho x-amzn-RateLimit-Limit devolvido por operação. */
  limiteCabecalho?: Partial<Record<string, number>>;
  /** Responde 429 nas próximas N chamadas desta operação. */
  forcar429?: Partial<Record<string, number>>;
  lwa?: 'ok' | 'invalid_grant' | 'invalid_client';
}

export const CREDENCIAIS_TESTE = {
  AMZ_ALEMMAR_LWA_CLIENT_ID: 'amzn1.application-oa2-client.teste',
  AMZ_ALEMMAR_LWA_CLIENT_SECRET: 'segredo-do-app-de-teste',
  AMZ_ALEMMAR_REFRESH_TOKEN: 'Atzr|refresh-de-teste-longo',
  AMZ_ALEMMAR_SELLER_ID: 'A1TESTEMERCHANT',
};

export function criarAmazonSimulada(cen: Cenario) {
  const chamadas: ChamadaRegistrada[] = [];
  const trocasLwa: URLSearchParams[] = [];
  const validos = new Map<string, number>(); // access token -> expira
  let emitidos = 0;
  const tokensPedidos = new Map<string, { emitido: number; offset: number }>();
  let agora = () => Date.now();

  const resp = (status: number, corpo: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json', ...headers } });
  const erro = (status: number, code: string, message: string) => resp(status, { errors: [{ code, message }] });

  function paginar<T>(lista: T[], tamanho: number, token: string | null): { pagina: T[]; prox: string | null } {
    const ini = token ? Number(token.split(':')[1]) : 0;
    const pagina = lista.slice(ini, ini + tamanho);
    return { pagina, prox: ini + tamanho < lista.length ? `pg:${ini + tamanho}` : null };
  }

  async function fetchSimulado(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.href === 'https://api.amazon.com/auth/o2/token') {
      const corpo = new URLSearchParams(String(init.body));
      trocasLwa.push(corpo);
      if (cen.lwa === 'invalid_grant' || corpo.get('refresh_token') !== CREDENCIAIS_TESTE.AMZ_ALEMMAR_REFRESH_TOKEN) return resp(400, { error: 'invalid_grant', error_description: 'refresh token inválido' });
      if (cen.lwa === 'invalid_client' || corpo.get('client_secret') !== CREDENCIAIS_TESTE.AMZ_ALEMMAR_LWA_CLIENT_SECRET) return resp(401, { error: 'invalid_client', error_description: 'client inválido' });
      if (corpo.get('grant_type') !== 'refresh_token') return resp(400, { error: 'unsupported_grant_type' });
      const t = `Atza|acesso-${++emitidos}`;
      validos.set(t, agora() + 3600_000);
      // A LWA NÃO devolve refresh token novo nesta troca: o de longa duração continua o mesmo.
      return resp(200, { access_token: t, token_type: 'bearer', expires_in: 3600 });
    }
    if (url.origin !== 'https://sellingpartnerapi-na.amazon.com') return erro(404, 'NotFound', 'host desconhecido');

    const v = validarContraModelo(url);
    const reg: ChamadaRegistrada = { operationId: v.operationId, url, status: 0 };
    chamadas.push(reg);
    const fim = (r: Response) => { reg.status = r.status; return r; };
    const token = new Headers(init.headers).get('x-amz-access-token') ?? '';
    const exp = validos.get(token);
    if (!exp || exp < agora()) return fim(erro(403, 'Unauthorized', 'The access token you provided has expired.'));
    if (v.erros.length) return fim(erro(400, 'InvalidInput', v.erros.join('; ')));
    const op = v.operationId!;
    if ((cen.forcar429?.[op] ?? 0) > 0) { cen.forcar429![op]!--; return fim(erro(429, 'QuotaExceeded', 'You exceeded your quota for the requested resource.')); }
    const hdr: Record<string, string> = cen.limiteCabecalho?.[op] ? { 'x-amzn-RateLimit-Limit': String(cen.limiteCabecalho[op]) } : {};
    const q = url.searchParams;

    if (op === 'searchOrders') {
      const de = q.get('lastUpdatedAfter'), ate = q.get('lastUpdatedBefore');
      if (!de && !q.get('createdAfter')) return fim(erro(400, 'InvalidInput', 'exatamente um de createdAfter e lastUpdatedAfter'));
      if (ate && Date.parse(ate) > agora() - 120_000) return fim(erro(400, 'InvalidInput', 'lastUpdatedBefore precisa estar 2 min no passado'));
      const tk = q.get('paginationToken');
      if (tk) { const info = tokensPedidos.get(tk); if (!info || agora() - info.emitido > 24 * 3600_000) return fim(erro(400, 'InvalidInput', 'paginationToken expirado')); }
      const lista = (cen.pedidos ?? []).filter(o => (!de || o.lastUpdatedTime >= de) && (!ate || o.lastUpdatedTime <= ate));
      const { pagina, prox } = paginar(lista, Number(q.get('maxResultsPerPage') ?? 100), tk);
      if (prox) tokensPedidos.set(prox, { emitido: agora(), offset: 0 });
      return fim(resp(200, { orders: pagina, ...(prox ? { pagination: { nextToken: prox } } : {}) }, hdr));
    }
    if (op === 'searchListingsItems') {
      if (v.caminho.sellerId !== CREDENCIAIS_TESTE.AMZ_ALEMMAR_SELLER_ID) return fim(erro(403, 'Unauthorized', 'Access to requested resource is denied.'));
      const { pagina, prox } = paginar(cen.anuncios ?? [], Number(q.get('pageSize') ?? 10), q.get('pageToken'));
      return fim(resp(200, { numberOfResults: (cen.anuncios ?? []).length, items: pagina, ...(prox ? { pagination: { nextToken: prox } } : {}) }, hdr));
    }
    if (op === 'getInventorySummaries') {
      if (cen.estoqueFba === 'sem_permissao') return fim(erro(403, 'Unauthorized', 'Access to requested resource is denied.'));
      const { pagina, prox } = paginar(cen.estoqueFba ?? [], 50, q.get('nextToken'));
      return fim(resp(200, { payload: { granularity: { granularityType: 'Marketplace', granularityId: q.get('granularityId') }, inventorySummaries: pagina }, ...(prox ? { pagination: { nextToken: prox } } : {}) }, hdr));
    }
    if (op === 'listTransactions') {
      const de = q.get('postedAfter')!, ate = q.get('postedBefore');
      if (ate && Date.parse(ate) - Date.parse(de) > 180 * 86_400_000) return fim(resp(200, { payload: { transactions: [] } }, hdr)); // contrato: >180 dias = vazio
      const lista = (cen.transacoes ?? []).filter(t => t.postedDate >= de && (!ate || t.postedDate < ate));
      const { pagina, prox } = paginar(lista, 2, q.get('nextToken'));
      return fim(resp(200, { payload: { transactions: pagina, ...(prox ? { nextToken: prox } : {}) } }, hdr));
    }
    return fim(erro(404, 'NotFound', op));
  }

  return {
    fetch: fetchSimulado as typeof fetch,
    chamadas, trocasLwa,
    usarRelogio(f: () => number) { agora = f; },
    expirarTokens() { validos.clear(); },
  };
}

/** Pedido no formato do contrato v2026-01-01, a partir do exemplo oficial. */
export function exemploOficialSearchOrders(): any {
  return MODELOS.orders.paths['/orders/2026-01-01/orders'].get.responses['200'].examples['application/json'];
}
