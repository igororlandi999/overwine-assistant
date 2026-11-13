/**
 * Ações HTTP do Bling, servidas pela rota existente api/auth/[action].ts
 * (nenhuma função serverless nova):
 *
 *   POST /api/auth/bling-iniciar     admin  → { url, expira_em_s }
 *   GET  /api/auth/bling-callback    público (redirecionamento do Bling) → 303 para ?r=<recibo>
 *   GET  /api/auth/bling-callback?r= público → página HTML curta com o desfecho
 *   GET  /api/auth/bling-status      admin  → conexão ativa e pendente, sem tokens
 *   POST /api/auth/bling-confirmar   admin  { id, cnpj, substituir? } → ativa a pendente
 *   GET  /api/auth/bling-depositos   admin  → depósitos (5 campos), só com conexão validada
 *
 * "admin" = sessão válida do dashboard (Authorization: Bearer sess_...) E
 * cabeçalho X-Admin-Key igual à BLING_ADMIN_KEY (ou, enquanto ela não
 * existir, à ADMIN_KEY), comparado em tempo constante. A
 * chave NUNCA é aceita na URL: qualquer parâmetro de query nas ações admin é
 * recusado (a URL vai para logs e histórico; o cabeçalho não).
 *
 * O X-Admin-Key não está entre os cabeçalhos liberados pelo CORS: estas
 * ações são feitas por curl/cliente HTTP, não pelo navegador do dashboard.
 * Nada aqui muda o CORS nem as ações existentes (login/logout/session).
 *
 * CSRF: as ações que mudam estado (iniciar, confirmar) exigem dois
 * cabeçalhos que um navegador não envia para outro site sem preflight CORS
 * (Authorization e X-Admin-Key), e o backend não usa cookies: um formulário
 * ou link forjado chega sem sessão e sem chave e recebe 401. O X-Admin-Key
 * não está liberado no CORS, então nem a origem permitida do dashboard
 * consegue mandá-lo pelo navegador. Confirmar exige ainda JSON, a mesma
 * sessão que iniciou, o id da pendente e o CNPJ digitado. O callback é
 * público por necessidade e se protege pelo state (192 bits, uso único,
 * criado só por um administrador autenticado).
 *
 * Exposição do authorization code: o code chega na query do callback. Depois
 * de processá-lo, o callback responde 303 para uma URL limpa
 * (?r=<recibo aleatório>), para que o code não fique na barra de endereço,
 * no histórico nem seja reenviado num recarregamento; as páginas mandam
 * Referrer-Policy: no-referrer e não carregam nenhum recurso externo. Nosso
 * log registra só o desfecho. O log de requisições da própria Vercel ainda
 * registra a URL original: o code vale 30 s e só pode ser trocado uma vez.
 *
 * Chave administrativa (src/bling/config.ts, chaveAdminBling):
 *  - BLING_ADMIN_KEY definida (mínimo 32 caracteres): única aceita; a
 *    ADMIN_KEY dos workflows recebe 403 nas ações bling-*.
 *  - BLING_ADMIN_KEY definida e curta, ou igual à ADMIN_KEY: toda ação admin
 *    falha fechada (500, só o nome da variável na mensagem), sem recorrer
 *    à ADMIN_KEY.
 *  - Ausente: compatibilidade temporária com a ADMIN_KEY.
 *  bling-status informa só o NOME da chave em uso (`chave_admin`).
 *  Os workflows do GitHub não usam ações bling-* e não mudam.
 *
 * Com BLING_ENABLED desligado, toda ação bling-* responde 503 sem tocar no
 * Redis e sem chamar o Bling.
 */
import { randomBytes } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Cache } from '../lib/cache/cache.js';
import { getEnv } from '../config/env.js';
import { validateSession } from '../lib/session.js';
import { safeEquals, rateLimitOk, readBearer, clientIp, maskIp, json } from '../lib/http.js';
import { blingHabilitado, chaveAdminBling } from './config.js';
import {
  iniciarAutorizacao, concluirAutorizacao, confirmarPendente, estadoAdministrativo,
  ConfirmacaoError, type ResultadoCallback,
} from './autorizacao.js';
import { listarDepositosResumo } from './leitura.js';
import type { DepsBling } from './auth.js';
import {
  BlingErro, BlingDesativadoError, BlingConfiguracaoError, BlingAutorizacaoError, BlingLimiteError,
} from './erros.js';

export const ACOES_BLING = ['bling-iniciar', 'bling-callback', 'bling-status', 'bling-confirmar', 'bling-depositos'] as const;
type AcaoBling = typeof ACOES_BLING[number];

const METODO: Record<AcaoBling, 'GET' | 'POST'> = {
  'bling-iniciar': 'POST',
  'bling-callback': 'GET',
  'bling-status': 'GET',
  'bling-confirmar': 'POST',
  'bling-depositos': 'GET',
};

export function ehAcaoBling(acao: string): acao is AcaoBling {
  return (ACOES_BLING as readonly string[]).includes(acao);
}

function semCache(res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
}

/** Sessão + X-Admin-Key. Devolve o id da sessão ou responde e devolve null. */
async function exigirAdmin(req: VercelRequest, res: VercelResponse, cache: Cache, acao: string): Promise<string | null> {
  const ip = clientIp(req);
  const extras = Object.keys(req.query || {}).filter(k => k !== 'action');
  if (extras.length) {
    json(res, 400, { error: 'Parâmetros na URL não são aceitos nesta ação. A chave administrativa vai só no cabeçalho X-Admin-Key.' });
    return null;
  }
  if (!(await rateLimitOk(cache, `bling-admin:${ip}`, 20, 600))) {
    json(res, 429, { error: 'Muitas tentativas. Aguarde.' });
    return null;
  }
  const sess = await validateSession(cache, readBearer(req));
  if (!sess) {
    json(res, 401, { error: 'Sessão inválida ou expirada. Faça login.' });
    return null;
  }
  // Lança BlingConfiguracaoError se BLING_ADMIN_KEY existir e for curta (falha fechada).
  const esperada = chaveAdminBling(getEnv().ADMIN_KEY);
  const chave = req.headers['x-admin-key'];
  if (typeof chave !== 'string' || !chave || !safeEquals(chave, esperada.chave)) {
    console.warn(`[bling:${acao}] chave administrativa inválida (esperada: ${esperada.origem}) ip=${maskIp(ip)}`);
    json(res, 403, { error: 'Acesso restrito a administradores.' });
    return null;
  }
  return sess.id;
}

function erroParaHttp(res: VercelResponse, e: unknown, acao: string) {
  if (e instanceof ConfirmacaoError) return json(res, e.status, { error: e.message, codigo: e.codigo });
  if (e instanceof BlingDesativadoError) return json(res, 503, { error: 'Integração Bling desativada.' });
  if (e instanceof BlingConfiguracaoError) return json(res, 500, { error: e.message, codigo: e.codigo });
  if (e instanceof BlingAutorizacaoError) return json(res, 409, { error: e.message, codigo: e.codigo });
  if (e instanceof BlingLimiteError) return json(res, 429, { error: e.message, codigo: e.codigo });
  if (e instanceof BlingErro) return json(res, 502, { error: e.message, codigo: e.codigo });
  console.error(`[bling:${acao}]`, e instanceof Error ? e.name : 'erro');
  return json(res, 500, { error: 'Erro interno.' });
}

const escapar = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Texto da página do callback. Sem token, sem code, sem state. */
type ResultadoPagina = ResultadoCallback | { resultado: 'recibo_desconhecido' };

export function mensagemCallback(r: ResultadoPagina): { status: number; titulo: string; texto: string } {
  switch (r.resultado) {
    case 'pendente':
      return r.motivo === 'substituicao'
        ? { status: 200, titulo: 'Autorização recebida', texto: `Autorização recebida para ${r.empresa.nome} (CNPJ ${r.empresa.cnpj}). Já existe uma conexão ativa: ela continua em uso até um administrador confirmar a troca.` }
        : { status: 200, titulo: 'Autorização recebida', texto: `Autorização recebida para ${r.empresa.nome} (CNPJ ${r.empresa.cnpj}). Ela só será usada depois da confirmação de um administrador.` };
    case 'recibo_desconhecido':
      return { status: 404, titulo: 'Resultado indisponível', texto: 'Este resultado expirou ou não existe. Consulte o estado da conexão pela ação administrativa bling-status.' };
    case 'recusada_empresa':
      return { status: 403, titulo: 'Empresa não permitida', texto: `A empresa autorizada (CNPJ ${r.empresa.cnpj}) não é a esperada. Nada foi gravado; a conexão anterior, se houver, foi preservada.` };
    case 'negada_no_bling':
      return { status: 200, titulo: 'Autorização não concedida', texto: 'A autorização foi recusada no Bling. Nada foi alterado.' };
    case 'state_invalido':
      return { status: 400, titulo: 'Link inválido', texto: 'Link de autorização inválido, expirado ou já utilizado. Inicie a autorização novamente.' };
    case 'falha':
      return { status: 502, titulo: 'Autorização não concluída', texto: `Não foi possível concluir a autorização (${r.codigo}). A conexão anterior, se houver, foi preservada.` };
  }
}

const RECIBO_TTL_S = 300;
const FORMATO_RECIBO = /^[a-f0-9]{32}$/;
export const chaveRecibo = (id: string) => `bling:callback_resultado:${id}`;

function cabecalhosSeguros(res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  // O code chegou na URL do callback: nada pode vazá-la por Referer.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function paginaCallback(res: VercelResponse, r: ResultadoPagina) {
  const m = mensagemCallback(r);
  res.status(m.status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  cabecalhosSeguros(res);
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapar(m.titulo)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#222}</style></head><body><h1>${escapar(m.titulo)}</h1><p>${escapar(m.texto)}</p></body></html>`);
}

/** Despacha uma ação bling-*. Chamado por api/auth/[action].ts, depois do CORS. */
export async function tratarAcaoBling(
  req: VercelRequest, res: VercelResponse, acao: AcaoBling, cache: Cache, deps: DepsBling = {},
): Promise<void> {
  if (req.method !== METODO[acao]) return json(res, 405, { error: `Use ${METODO[acao]}` });
  semCache(res);
  if (!blingHabilitado()) return json(res, 503, { error: 'Integração Bling desativada.' });

  try {
    if (acao === 'bling-callback') {
      if (!(await rateLimitOk(cache, `bling-callback:${clientIp(req)}`, 30, 600))) {
        return json(res, 429, { error: 'Muitas tentativas. Aguarde.' });
      }
      const q = req.query || {};
      const um = (v: unknown) => (Array.isArray(v) ? undefined : v);

      // Segunda etapa: página do recibo, já sem code/state na URL.
      if (q.r !== undefined && q.code === undefined && q.state === undefined) {
        const id = um(q.r);
        const raw = typeof id === 'string' && FORMATO_RECIBO.test(id) ? await cache.get(chaveRecibo(id)) : null;
        let r: ResultadoPagina = { resultado: 'recibo_desconhecido' };
        try { if (raw) r = JSON.parse(raw) as ResultadoCallback; } catch { /* recibo corrompido */ }
        return paginaCallback(res, r);
      }

      const r = await concluirAutorizacao(cache, { code: um(q.code), state: um(q.state), error: um(q.error) }, deps);
      console.info(`[bling:callback] resultado=${r.resultado}${r.resultado === 'falha' ? ` codigo=${r.codigo}` : ''}`);
      // Recibo com o desfecho (só campos seguros) e redirecionamento para URL limpa.
      const recibo = randomBytes(16).toString('hex');
      await cache.set(chaveRecibo(recibo), JSON.stringify(r), RECIBO_TTL_S);
      cabecalhosSeguros(res);
      res.setHeader('Location', `/api/auth/bling-callback?r=${recibo}`);
      res.status(303);
      return void res.end();
    }

    let sessaoId: string | null;
    try {
      sessaoId = await exigirAdmin(req, res, cache, acao);
    } catch (e) {
      if (e instanceof BlingConfiguracaoError) {
        console.error(`[bling:${acao}] ${e.message}`);
        return json(res, 500, { error: 'Configuração administrativa do Bling inválida.', codigo: e.codigo });
      }
      throw e;
    }
    if (!sessaoId) return;

    if (acao === 'bling-iniciar') {
      const r = await iniciarAutorizacao(cache, { sessaoId });
      return json(res, 200, { url: r.url, expira_em_s: r.expiraEmS });
    }
    if (acao === 'bling-status') {
      return json(res, 200, { ...(await estadoAdministrativo(cache)), chave_admin: chaveAdminBling(getEnv().ADMIN_KEY).origem });
    }
    if (acao === 'bling-confirmar') {
      if (!String(req.headers['content-type'] || '').includes('application/json')) {
        return json(res, 415, { error: 'Content-Type deve ser application/json.' });
      }
      const b = (req.body ?? {}) as { id?: unknown; cnpj?: unknown; substituir?: unknown };
      const r = await confirmarPendente(cache, { sessaoId }, { id: b.id, cnpj: b.cnpj, substituir: b.substituir });
      console.info(`[bling:confirmar] ativada substituiu=${r.substituiu}`);
      return json(res, 200, r);
    }
    // bling-depositos
    return json(res, 200, { depositos: await listarDepositosResumo(cache, deps) });
  } catch (e) {
    return erroParaHttp(res, e, acao);
  }
}
