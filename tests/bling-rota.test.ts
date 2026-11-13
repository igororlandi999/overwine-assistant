/**
 * Ações bling-* em /api/auth/[action]: autorização administrativa, callback
 * OAuth, confirmação de pendente e leitura de depósitos. Fetch simulado,
 * nenhuma credencial real, nenhuma chamada ao Bling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { createSession } from '../src/lib/session.js';
import { K } from '../src/bling/auth.js';
import { KA } from '../src/bling/autorizacao.js';
import { chaveRecibo } from '../src/bling/rota.js';
import handler from '../api/auth/[action].js';
import { ligarBling, limparBling, simular, fixture, TOKEN_URL, API, type Resposta } from './bling-simulado.js';

const CNPJ = '12345678000190';
const CNPJ_FMT = '12.345.678/0001-90';
const EMPRESA = { data: { id: 'emp-overwine', nome: 'Overwine Teste LTDA', cnpj: CNPJ_FMT, email: 'contato@exemplo.com', dataContrato: '2024-01-01' } };
const OUTRA_EMPRESA = { data: { id: 'emp-outra', nome: 'Outra LTDA', cnpj: '98.765.432/0001-10', email: 'x@exemplo.com' } };
const TOKEN_NOVO = { access_token: 'eyJ.access.SEGREDO', refresh_token: 'rt-SEGREDO', expires_in: 21600, token_type: 'Bearer', scope: '1 2' };

function mockReq(o: Partial<{ method: string; headers: Record<string, unknown>; query: Record<string, unknown>; body: unknown }> = {}) {
  return { method: 'GET', headers: {}, query: {}, body: undefined, socket: { remoteAddress: '10.0.0.9' }, ...o } as any;
}
function mockRes() {
  const r: any = { statusCode: 0, headers: {} as Record<string, string>, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k.toLowerCase()] = v; return r; };
  r.send = (b: any) => { r.body = b; return r; };
  r.end = () => r;
  r.json = () => JSON.parse(r.body);
  return r;
}

let cache: FakeCache;
let sessao: string;
let corpos: string[];
let fetchSpy: any;

beforeEach(async () => {
  cache = new FakeCache();
  setCacheForTests(cache);
  Object.assign(process.env, TEST_ENV);
  resetEnvForTests();
  ligarBling({ BLING_CNPJ_ESPERADO: CNPJ_FMT });
  sessao = (await createSession(cache, { persistente: false })).id;
  corpos = [];
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (u: any) => { throw new Error(`fetch não previsto: ${u}`); });
});
afterEach(() => { limparBling(); vi.restoreAllMocks(); });

/** Programa as respostas do "Bling" para o próximo fluxo. */
function bling(rotas: Record<string, Resposta[]>) {
  const s = simular(rotas);
  fetchSpy.mockImplementation(s.fetch as any);
  return s;
}

const admin = (extra: Record<string, unknown> = {}) => ({ authorization: `Bearer ${sessao}`, 'x-admin-key': TEST_ENV.ADMIN_KEY, ...extra });

async function chamar(action: string, o: Parameters<typeof mockReq>[0] = {}) {
  const res = mockRes();
  await handler(mockReq({ ...o, query: { action, ...(o.query || {}) } }), res);
  corpos.push(String(res.body ?? ''));
  return res;
}

async function iniciar(headers = admin()): Promise<string> {
  const r = await chamar('bling-iniciar', { method: 'POST', headers });
  expect(r.statusCode).toBe(200);
  return new URL(r.json().url).searchParams.get('state')!;
}

/**
 * Simula o navegador: o callback responde 303 para uma URL limpa (?r=...),
 * que é seguida. Devolve a página final, com a resposta 303 em `.redirect`.
 */
async function callback(query: Record<string, unknown>) {
  const primeira = await chamar('bling-callback', { query });
  expect(primeira.statusCode).toBe(303);
  const local = new URL(primeira.headers['location'], 'https://overwine-assistant.vercel.app');
  const pagina = await chamar('bling-callback', { query: Object.fromEntries(local.searchParams) });
  pagina.redirect = primeira;
  return pagina;
}
async function confirmar(body: Record<string, unknown>, headers: Record<string, unknown> = admin({ 'content-type': 'application/json' })) {
  return chamar('bling-confirmar', { method: 'POST', headers, body });
}
const idPendente = async () => (await chamar('bling-status', { headers: admin() })).json().pendente?.id;
const cadeiaAtiva = async () => { const raw = await cache.get(K.cadeia); return raw ? JSON.parse(raw) : null; };

async function gravarAtiva(access = 'tok-antigo', cnpj = CNPJ) {
  await cache.set(K.cadeia, JSON.stringify({
    access, expiresAt: Date.now() + 3600_000, refresh: 'rt-antigo', geracao: 'g-antiga',
    empresa: { id: 'emp-antiga', nome: 'Antiga', cnpj }, validacao: 'cnpj',
  }));
  return cache.get(K.cadeia);
}

function semSegredos() {
  const tudo = corpos.join('\n');
  for (const s of ['SEGREDO', 'rt-antigo', 'tok-antigo', 'code-', TEST_ENV.ADMIN_KEY, 'segredo-ficticio']) expect(tudo).not.toContain(s);
}

describe('integração desligada', () => {
  it('toda ação bling-* responde 503, sem tocar no Redis e sem chamar o Bling', async () => {
    limparBling();
    const antes = [...cache.store.keys()].sort();
    for (const [acao, method] of [['bling-iniciar', 'POST'], ['bling-callback', 'GET'], ['bling-status', 'GET'], ['bling-confirmar', 'POST'], ['bling-depositos', 'GET']]) {
      const r = await chamar(acao, { method, headers: admin(), query: acao === 'bling-callback' ? { code: 'code-x', state: 'a'.repeat(48) } : {} });
      expect(r.statusCode, acao).toBe(503);
    }
    expect([...cache.store.keys()].sort()).toEqual(antes);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('proteção administrativa', () => {
  const acoesAdmin: [string, string][] = [['bling-iniciar', 'POST'], ['bling-status', 'GET'], ['bling-confirmar', 'POST'], ['bling-depositos', 'GET']];

  it.each(acoesAdmin)('%s sem sessão: 401', async (acao, method) => {
    const r = await chamar(acao, { method, headers: { 'x-admin-key': TEST_ENV.ADMIN_KEY, 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(401);
  });

  it.each(acoesAdmin)('%s com sessão expirada/inexistente: 401', async (acao, method) => {
    const r = await chamar(acao, { method, headers: admin({ authorization: 'Bearer sess_' + 'f'.repeat(64) }) });
    expect(r.statusCode).toBe(401);
  });

  it.each(acoesAdmin)('%s com sessão mas sem ADMIN_KEY ou com chave errada: 403', async (acao, method) => {
    for (const h of [{ authorization: `Bearer ${sessao}` }, admin({ 'x-admin-key': 'chave-errada-com-16-caracteres' })]) {
      const r = await chamar(acao, { method, headers: h });
      expect(r.statusCode).toBe(403);
    }
  });

  it('chave administrativa na query string é recusada, mesmo correta', async () => {
    for (const q of [{ adminKey: TEST_ENV.ADMIN_KEY }, { key: TEST_ENV.ADMIN_KEY }, { 'x-admin-key': TEST_ENV.ADMIN_KEY }]) {
      const r = await chamar('bling-status', { headers: { authorization: `Bearer ${sessao}` }, query: q });
      expect(r.statusCode).toBe(400);
    }
    const r = await chamar('bling-iniciar', { method: 'POST', headers: admin(), query: { adminKey: TEST_ENV.ADMIN_KEY } });
    expect(r.statusCode).toBe(400);
    expect([...cache.store.keys()].some(k => k.startsWith('bling:oauth_state:'))).toBe(false);
  });

  it('método errado: 405', async () => {
    expect((await chamar('bling-iniciar', { method: 'GET', headers: admin() })).statusCode).toBe(405);
    expect((await chamar('bling-callback', { method: 'POST' })).statusCode).toBe(405);
  });

  it('respostas administrativas não são cacheáveis', async () => {
    const r = await chamar('bling-status', { headers: admin() });
    expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('iniciar', () => {
  it('devolve a URL oficial com state de uso único ligado à sessão; sem segredo na resposta', async () => {
    const r = await chamar('bling-iniciar', { method: 'POST', headers: admin() });
    const u = new URL(r.json().url);
    expect(`${u.origin}${u.pathname}`).toBe('https://bling.com.br/Api/v3/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('client-id-ficticio');
    const state = u.searchParams.get('state')!;
    expect(state).toMatch(/^[a-f0-9]{48}$/);
    const reg = JSON.parse((await cache.get(KA.state(state)))!);
    expect(reg.sessao).toMatch(/^[a-f0-9]{16}$/);
    expect(reg.sessao).not.toBe(sessao);
    expect(r.json().expira_em_s).toBe(600);
    semSegredos();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('callback', () => {
  it('legítimo, CNPJ confere e sem conexão ativa: NÃO ativa; fica pendente até a confirmação administrativa', async () => {
    const state = await iniciar();
    bling({ [TOKEN_URL]: [{ status: 200, corpo: TOKEN_NOVO }], [`${API}/empresas/me/dados-basicos`]: [{ status: 200, corpo: EMPRESA }] });
    const r = await callback({ code: 'code-legitimo', state });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.body).toContain('só será usada depois da confirmação');
    expect(r.body).toContain(CNPJ_FMT);
    expect(await cadeiaAtiva()).toBeNull();
    const st = (await chamar('bling-status', { headers: admin() })).json();
    expect(st).toMatchObject({ ativa: null, pendente: { motivo: 'primeira_conexao', validacao: 'cnpj' } });

    // Primeira conexão: confirmação exige id, CNPJ e a mesma sessão; não exige "substituir".
    const ok = await confirmar({ id: st.pendente.id, cnpj: CNPJ_FMT });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ resultado: 'ativada', substituiu: false });
    const c = await cadeiaAtiva();
    expect(c).toMatchObject({ access: TOKEN_NOVO.access_token, empresa: { id: 'emp-overwine', cnpj: CNPJ }, validacao: 'cnpj' });
    expect(JSON.stringify(c)).not.toContain('contato@exemplo.com');
    // a identificação da empresa usou o token recém-obtido, explicitamente
    const chamadaEmpresa = fetchSpy.mock.calls.find(([u]: [unknown]) => String(u).includes('/empresas/me/dados-basicos'))!;
    expect((chamadaEmpresa[1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${TOKEN_NOVO.access_token}` });
    semSegredos();
  });

  it('state reutilizado: a segunda chamada é recusada sem chamar o Bling', async () => {
    const state = await iniciar();
    bling({ [TOKEN_URL]: [{ status: 200, corpo: TOKEN_NOVO }], [`${API}/empresas/me/dados-basicos`]: [{ status: 200, corpo: EMPRESA }] });
    await callback({ code: 'code-1', state });
    const chamadas = fetchSpy.mock.calls.length;
    const r = await callback({ code: 'code-2', state });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('inválido, expirado ou já utilizado');
    expect(fetchSpy.mock.calls.length).toBe(chamadas);
  });

  it('state inválido, desconhecido ou expirado: 400 sem chamar o Bling e sem gravar', async () => {
    const expirado = await iniciar();
    cache.store.get(KA.state(expirado))!.exp = Date.now() - 1;
    for (const state of [undefined, '', 'curto', 'G'.repeat(48), 'a'.repeat(48), ['a'.repeat(48)], expirado]) {
      const r = await callback({ code: 'code-x', state });
      expect(r.statusCode).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await cadeiaAtiva()).toBeNull();
  });

  it('autorização negada no Bling (?error=...): consome o state e não grava nada', async () => {
    const state = await iniciar();
    const r = await callback({ error: 'access_denied', state });
    expect(r.body).toContain('Autorização não concedida');
    expect(await cache.get(KA.state(state))).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('empresa diferente da esperada: recusa, descarta os tokens e preserva a conexão anterior', async () => {
    const antes = await gravarAtiva();
    const state = await iniciar();
    bling({ [TOKEN_URL]: [{ status: 200, corpo: TOKEN_NOVO }], [`${API}/empresas/me/dados-basicos`]: [{ status: 200, corpo: OUTRA_EMPRESA }] });
    const r = await callback({ code: 'code-x', state });
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('não é a esperada');
    expect(await cache.get(K.cadeia)).toBe(antes);
    expect(await cache.get(KA.pendente)).toBeNull();
    semSegredos();
  });

  it.each<[string, Record<string, Resposta[]>]>([
    ['code recusado pelo Bling', { [TOKEN_URL]: [{ status: 400, corpo: { error: { type: 'invalid_grant' } } }] }],
    ['endpoint de token fora do ar', { [TOKEN_URL]: [new TypeError('fetch failed')] }],
    ['escopo Empresas ausente (403)', { [TOKEN_URL]: [{ status: 200, corpo: TOKEN_NOVO }], [`${API}/empresas/me/dados-basicos`]: [{ status: 403, corpo: { error: { type: 'FORBIDDEN' } } }] }],
    ['empresa fora do contrato', { [TOKEN_URL]: [{ status: 200, corpo: TOKEN_NOVO }], [`${API}/empresas/me/dados-basicos`]: [{ status: 200, corpo: { data: { id: 'x', nome: 'y', cnpj: '123' } } }] }],
  ])('falha no OAuth (%s): conexão anterior preservada, nada pendente, página sem segredo', async (_n, rotas) => {
    const antes = await gravarAtiva();
    const state = await iniciar();
    bling(rotas);
    const r = await callback({ code: 'code-falha', state });
    expect(r.statusCode).toBe(502);
    expect(r.body).toContain('conexão anterior');
    expect(await cache.get(K.cadeia)).toBe(antes);
    expect(await cache.get(KA.pendente)).toBeNull();
    expect(await cache.get(KA.state(state))).toBeNull();
    semSegredos();
  });

  it('nome da empresa vindo do Bling é escapado na página', async () => {
    const state = await iniciar();
    bling({ [TOKEN_URL]: [{ status: 200, corpo: TOKEN_NOVO }], [`${API}/empresas/me/dados-basicos`]: [{ status: 200, corpo: { data: { ...EMPRESA.data, nome: '<script>alert(1)</script>' } } }] });
    const r = await callback({ code: 'code-x', state });
    expect(r.body).not.toContain('<script>');
    expect(r.body).toContain('&lt;script&gt;');
  });
});

describe('substituição de conexão existente', () => {
  async function autorizarComAtivaExistente() {
    const antes = await gravarAtiva();
    const state = await iniciar();
    bling({ [TOKEN_URL]: [{ status: 200, corpo: TOKEN_NOVO }], [`${API}/empresas/me/dados-basicos`]: [{ status: 200, corpo: EMPRESA }] });
    const r = await callback({ code: 'code-novo', state });
    return { antes, r };
  }

  it('callback válido com conexão ativa: fica PENDENTE e a conexão atual continua intacta', async () => {
    const { antes, r } = await autorizarComAtivaExistente();
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('continua em uso até um administrador confirmar');
    expect(await cache.get(K.cadeia)).toBe(antes);
    const st = (await chamar('bling-status', { headers: admin() })).json();
    expect(st.ativa.empresa.nome).toBe('Antiga');
    expect(st.pendente).toMatchObject({ motivo: 'substituicao', validacao: 'cnpj', empresa: { cnpj: CNPJ_FMT } });
    semSegredos();
  });

  it('confirmar sem "substituir": 409 e nada muda', async () => {
    const { antes } = await autorizarComAtivaExistente();
    const id = (await chamar('bling-status', { headers: admin() })).json().pendente.id;
    const r = await chamar('bling-confirmar', { method: 'POST', headers: admin({ 'content-type': 'application/json' }), body: { id, cnpj: CNPJ_FMT } });
    expect(r.statusCode).toBe(409);
    expect(r.json().codigo).toBe('substituicao_exige_confirmacao');
    expect(await cache.get(K.cadeia)).toBe(antes);
  });

  it('confirmar por OUTRA sessão administrativa: 403', async () => {
    await autorizarComAtivaExistente();
    const id = (await chamar('bling-status', { headers: admin() })).json().pendente.id;
    const outra = (await createSession(cache, { persistente: false })).id;
    const r = await chamar('bling-confirmar', { method: 'POST', headers: admin({ authorization: `Bearer ${outra}`, 'content-type': 'application/json' }), body: { id, cnpj: CNPJ, substituir: true } });
    expect(r.statusCode).toBe(403);
    expect(r.json().codigo).toBe('sessao_divergente');
  });

  it('confirmar com CNPJ errado ou id errado: 409', async () => {
    await autorizarComAtivaExistente();
    const id = (await chamar('bling-status', { headers: admin() })).json().pendente.id;
    const h = admin({ 'content-type': 'application/json' });
    expect((await chamar('bling-confirmar', { method: 'POST', headers: h, body: { id, cnpj: '00.000.000/0000-00', substituir: true } })).json().codigo).toBe('cnpj_divergente');
    expect((await chamar('bling-confirmar', { method: 'POST', headers: h, body: { id: 'f'.repeat(32), cnpj: CNPJ, substituir: true } })).json().codigo).toBe('id_divergente');
  });

  it('confirmar com "substituir": true pela mesma sessão: troca atômica; pendente some', async () => {
    await autorizarComAtivaExistente();
    const id = (await chamar('bling-status', { headers: admin() })).json().pendente.id;
    const r = await chamar('bling-confirmar', { method: 'POST', headers: admin({ 'content-type': 'application/json' }), body: { id, cnpj: CNPJ, substituir: true } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ resultado: 'ativada', substituiu: true, empresa: { nome: 'Overwine Teste LTDA' } });
    expect(await cadeiaAtiva()).toMatchObject({ access: TOKEN_NOVO.access_token, empresa: { id: 'emp-overwine' } });
    expect(await cache.get(KA.pendente)).toBeNull();
    semSegredos();
  });

  it('conexão ativa mudou entre a leitura e a troca: compare-and-set falha e nada é sobrescrito', async () => {
    await autorizarComAtivaExistente();
    const id = (await chamar('bling-status', { headers: admin() })).json().pendente.id;
    const original = cache.setIfEquals.bind(cache);
    vi.spyOn(cache, 'setIfEquals').mockImplementationOnce(async (k, e, v, t) => {
      await cache.set(K.cadeia, 'cadeia-mais-nova-de-outra-instancia');
      return original(k, e, v, t);
    });
    const r = await chamar('bling-confirmar', { method: 'POST', headers: admin({ 'content-type': 'application/json' }), body: { id, cnpj: CNPJ, substituir: true } });
    expect(r.statusCode).toBe(409);
    expect(r.json().codigo).toBe('concorrencia');
    expect(await cache.get(K.cadeia)).toBe('cadeia-mais-nova-de-outra-instancia');
    expect(await cache.get(KA.pendente)).not.toBeNull();
  });
});

describe('validação manual (sem BLING_CNPJ_ESPERADO)', () => {
  beforeEach(() => ligarBling());

  it('callback fica pendente; a conexão NÃO é usada como fonte até a confirmação', async () => {
    const state = await iniciar();
    bling({ [TOKEN_URL]: [{ status: 200, corpo: TOKEN_NOVO }], [`${API}/empresas/me/dados-basicos`]: [{ status: 200, corpo: EMPRESA }] });
    const r = await callback({ code: 'code-x', state });
    expect(r.body).toContain('só será usada depois da confirmação');
    expect(await cadeiaAtiva()).toBeNull();
    const chamadas = fetchSpy.mock.calls.length;
    const dep = await chamar('bling-depositos', { headers: admin() });
    expect(dep.statusCode).toBe(409);
    expect(fetchSpy.mock.calls.length).toBe(chamadas);

    const st = (await chamar('bling-status', { headers: admin() })).json();
    expect(st).toMatchObject({ ativa: null, pendente: { motivo: 'primeira_conexao', validacao: 'manual' } });
    const ok = await chamar('bling-confirmar', { method: 'POST', headers: admin({ 'content-type': 'application/json' }), body: { id: st.pendente.id, cnpj: CNPJ_FMT } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().substituiu).toBe(false);
    expect(await cadeiaAtiva()).toMatchObject({ validacao: 'manual', empresa: { cnpj: CNPJ } });
    semSegredos();
  });
});

describe('depósitos', () => {
  it('sem conexão autorizada: 409, sem chamar o Bling', async () => {
    const r = await chamar('bling-depositos', { headers: admin() });
    expect(r.statusCode).toBe(409);
    expect(r.json().codigo).toBe('bling_autorizacao');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('conexão gravada sem empresa validada (formato antigo ou adulterado): tratada como não autorizada', async () => {
    await cache.set(K.cadeia, JSON.stringify({ access: 'tok-antigo', expiresAt: Date.now() + 3600_000, refresh: 'rt-antigo', geracao: 'g' }));
    const r = await chamar('bling-depositos', { headers: admin() });
    expect(r.statusCode).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
    const st = (await chamar('bling-status', { headers: admin() })).json();
    expect(st.ativa).toBeNull();
  });

  it('conexão com empresa mas sem tipo de validação reconhecido: tratada como não autorizada', async () => {
    for (const validacao of [undefined, 'pendente', 'nenhuma']) {
      await cache.set(K.cadeia, JSON.stringify({
        access: 'tok-antigo', expiresAt: Date.now() + 3600_000, refresh: 'rt-antigo', geracao: 'g',
        empresa: { id: 'e', nome: 'n', cnpj: CNPJ }, validacao,
      }));
      expect((await chamar('bling-depositos', { headers: admin() })).statusCode).toBe(409);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('com conexão validada: devolve SÓ os cinco campos, sem saldo e sem tokens', async () => {
    await gravarAtiva();
    const comExtra = { data: (fixture('depositos.json') as any).data.map((d: any) => ({ ...d, campoExtraDoBling: 'x', saldo: 99 })) };
    const s = bling({ [`${API}/depositos`]: [{ status: 200, corpo: comExtra }] });
    const r = await chamar('bling-depositos', { headers: admin() });
    expect(r.statusCode).toBe(200);
    const { depositos } = r.json();
    expect(depositos).toHaveLength(3);
    for (const d of depositos) expect(Object.keys(d).sort()).toEqual(['desconsiderarSaldo', 'descricao', 'id', 'padrao', 'situacao']);
    expect(s.chamadas.every(c => !c.url.includes('/estoques'))).toBe(true);
    semSegredos();
  });
});

describe('regressão: autenticação do dashboard e do Mercado Livre', () => {
  it('login/session continuam funcionando e as chaves ml:* não são tocadas pelo fluxo Bling', async () => {
    await cache.set('ml:refresh_token', 'TG-ml');
    await cache.set('ml:access_token', JSON.stringify({ token: 'AT-ml', expiresAt: Date.now() + 1e6 }));
    const login = await chamar('login', { method: 'POST', body: { password: TEST_ENV.DASHBOARD_PASSWORD } });
    expect(login.statusCode).toBe(200);
    const s = await chamar('session', { headers: { authorization: `Bearer ${login.json().session_token}` } });
    expect(s.statusCode).toBe(200);

    const state = await iniciar();
    bling({ [TOKEN_URL]: [{ status: 200, corpo: TOKEN_NOVO }], [`${API}/empresas/me/dados-basicos`]: [{ status: 200, corpo: EMPRESA }] });
    await callback({ code: 'code-x', state });
    expect(await cache.get('ml:refresh_token')).toBe('TG-ml');
    expect(JSON.parse((await cache.get('ml:access_token'))!).token).toBe('AT-ml');
    expect(fetchSpy.mock.calls.every(([u]: [unknown]) => !String(u).includes('mercadolibre'))).toBe(true);
  });

  it('ação desconhecida continua 404', async () => {
    expect((await chamar('bling-qualquer', { headers: admin() })).statusCode).toBe(404);
  });
});

describe('primeira conexão: confirmação obrigatória', () => {
  async function pendentePrimeira() {
    const state = await iniciar();
    bling({ [TOKEN_URL]: [{ status: 200, corpo: TOKEN_NOVO }], [`${API}/empresas/me/dados-basicos`]: [{ status: 200, corpo: EMPRESA }] });
    await callback({ code: 'code-x', state });
    return idPendente();
  }

  it('enquanto pendente, depósitos responde 409 sem chamar o Bling', async () => {
    await pendentePrimeira();
    const n = fetchSpy.mock.calls.length;
    expect((await chamar('bling-depositos', { headers: admin() })).statusCode).toBe(409);
    expect(fetchSpy.mock.calls.length).toBe(n);
  });

  it('confirmação sem sessão, sem ADMIN_KEY, por outra sessão, com id ou CNPJ errado: nada é ativado', async () => {
    const id = await pendentePrimeira();
    const outra = (await createSession(cache, { persistente: false })).id;
    const casos: [Record<string, unknown>, Record<string, unknown>, number][] = [
      [{ 'content-type': 'application/json', 'x-admin-key': TEST_ENV.ADMIN_KEY }, { id, cnpj: CNPJ }, 401],
      [{ 'content-type': 'application/json', authorization: `Bearer ${sessao}` }, { id, cnpj: CNPJ }, 403],
      [admin({ 'content-type': 'application/json', authorization: `Bearer ${outra}` }), { id, cnpj: CNPJ }, 403],
      [admin({ 'content-type': 'application/json' }), { id: 'a'.repeat(32), cnpj: CNPJ }, 409],
      [admin({ 'content-type': 'application/json' }), { id, cnpj: '11.111.111/0001-11' }, 409],
      [admin({ 'content-type': 'application/json' }), { id }, 409],
      [admin(), { id, cnpj: CNPJ }, 415],
    ];
    for (const [h, b, status] of casos) expect((await confirmar(b, h)).statusCode).toBe(status);
    expect(await cadeiaAtiva()).toBeNull();
    expect(await idPendente()).toBe(id);
  });

  it('outra conexão ativada entre o callback e a confirmação: exige "substituir" (reconferido na hora)', async () => {
    const id = await pendentePrimeira();
    await gravarAtiva();
    const r = await confirmar({ id, cnpj: CNPJ });
    expect(r.statusCode).toBe(409);
    expect(r.json().codigo).toBe('substituicao_exige_confirmacao');
  });

  it('pendente tem prazo no Redis (24 h) e não aparece em nenhuma resposta com tokens', async () => {
    await pendentePrimeira();
    const e = cache.store.get(KA.pendente)!;
    expect(e.exp).not.toBeNull();
    expect(e.exp! - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
    expect(e.exp! - Date.now()).toBeGreaterThan(23 * 3600_000);
    semSegredos();
  });
});

describe('exposição do authorization code', () => {
  it('callback responde 303 para URL limpa, sem code nem state, e sem cache', async () => {
    const state = await iniciar();
    bling({ [TOKEN_URL]: [{ status: 200, corpo: TOKEN_NOVO }], [`${API}/empresas/me/dados-basicos`]: [{ status: 200, corpo: EMPRESA }] });
    const r = await callback({ code: 'code-secreto-123', state });
    const loc = r.redirect.headers['location'];
    expect(loc).toMatch(/^\/api\/auth\/bling-callback\?r=[a-f0-9]{32}$/);
    expect(loc).not.toContain('code');
    expect(loc).not.toContain(state);
    expect(r.redirect.headers['referrer-policy']).toBe('no-referrer');
    expect(r.redirect.headers['cache-control']).toBe('no-store');
    expect(r.redirect.body ?? '').not.toContain('code-secreto-123');
  });

  it('recibo guarda só o desfecho seguro, expira em 5 min e recibo desconhecido dá 404', async () => {
    const state = await iniciar();
    bling({ [TOKEN_URL]: [{ status: 200, corpo: TOKEN_NOVO }], [`${API}/empresas/me/dados-basicos`]: [{ status: 200, corpo: EMPRESA }] });
    const r = await callback({ code: 'code-x', state });
    const id = new URL(r.redirect.headers['location'], 'https://x').searchParams.get('r')!;
    const e = cache.store.get(chaveRecibo(id))!;
    expect(e.v).not.toMatch(/SEGREDO|code-x|rt-|eyJ/);
    expect(e.exp! - Date.now()).toBeLessThanOrEqual(300_000);
    expect((await chamar('bling-callback', { query: { r: 'b'.repeat(32) } })).statusCode).toBe(404);
    expect((await chamar('bling-callback', { query: { r: '../x' } })).statusCode).toBe(404);
  });

  it('log do callback registra só o desfecho', async () => {
    const info = vi.mocked(console.info);
    const state = await iniciar();
    bling({ [TOKEN_URL]: [{ status: 200, corpo: TOKEN_NOVO }], [`${API}/empresas/me/dados-basicos`]: [{ status: 200, corpo: EMPRESA }] });
    await callback({ code: 'code-no-log', state });
    const texto = info.mock.calls.flat().join(' ');
    expect(texto).toContain('resultado=pendente');
    expect(texto).not.toMatch(/code-no-log|SEGREDO|[a-f0-9]{48}/);
  });
});

describe('CSRF', () => {
  it('requisição forjada de outro site (sem Authorization/X-Admin-Key) não inicia nem confirma nada', async () => {
    const forjada = { origin: 'https://site-malicioso.exemplo', 'content-type': 'application/json' };
    expect((await chamar('bling-iniciar', { method: 'POST', headers: forjada })).statusCode).toBe(401);
    expect((await confirmar({ id: 'a'.repeat(32), cnpj: CNPJ }, forjada)).statusCode).toBe(401);
    expect([...cache.store.keys()].some(k => k.startsWith('bling:oauth_state:'))).toBe(false);
  });

  it('o CORS não libera X-Admin-Key para navegador nenhum', async () => {
    const r = await chamar('bling-status', { method: 'OPTIONS', headers: { origin: TEST_ENV.ALLOWED_ORIGIN } });
    expect(r.statusCode).toBe(204);
    expect(String(r.headers['access-control-allow-headers']).toLowerCase()).not.toContain('x-admin-key');
  });
});

describe('BLING_ADMIN_KEY (chave administrativa própria do Bling)', () => {
  const CHAVE_BLING = 'chave-bling-de-teste-com-32-caract';
  const acoes: [string, string, Record<string, unknown>?][] = [
    ['bling-iniciar', 'POST'], ['bling-status', 'GET'], ['bling-depositos', 'GET'],
    ['bling-confirmar', 'POST', { id: 'a'.repeat(32), cnpj: CNPJ }],
  ];
  const comChave = (k: string) => admin({ 'x-admin-key': k, 'content-type': 'application/json' });
  const logs = () => [vi.mocked(console.warn), vi.mocked(console.error), vi.mocked(console.info)]
    .flatMap(m => m.mock.calls.flat()).join(' ');

  it('ausente: compatibilidade com ADMIN_KEY; status informa só o nome da chave', async () => {
    const r = await chamar('bling-status', { headers: admin() });
    expect(r.statusCode).toBe(200);
    expect(r.json().chave_admin).toBe('ADMIN_KEY');
    expect(r.body).not.toContain(TEST_ENV.ADMIN_KEY);
  });

  it('presente: só ela é aceita; status informa BLING_ADMIN_KEY sem o valor', async () => {
    process.env.BLING_ADMIN_KEY = CHAVE_BLING;
    expect(CHAVE_BLING.length).toBeGreaterThanOrEqual(32);
    const r = await chamar('bling-status', { headers: comChave(CHAVE_BLING) });
    expect(r.statusCode).toBe(200);
    expect(r.json().chave_admin).toBe('BLING_ADMIN_KEY');
    expect(r.body).not.toContain(CHAVE_BLING);
    expect((await chamar('bling-iniciar', { method: 'POST', headers: comChave(CHAVE_BLING) })).statusCode).toBe(200);
  });

  it.each(acoes)('presente: a ADMIN_KEY antiga é rejeitada em %s (403)', async (acao, method, body) => {
    process.env.BLING_ADMIN_KEY = CHAVE_BLING;
    const r = await chamar(acao, { method, headers: comChave(TEST_ENV.ADMIN_KEY), body });
    expect(r.statusCode).toBe(403);
    expect([...cache.store.keys()].some(k => k.startsWith('bling:oauth_state:'))).toBe(false);
  });

  it('exatamente 32 caracteres é aceita; espaços nas pontas são ignorados', async () => {
    const k32 = 'x'.repeat(32);
    process.env.BLING_ADMIN_KEY = `  ${k32}  `;
    expect((await chamar('bling-status', { headers: comChave(k32) })).statusCode).toBe(200);
  });

  it.each(['curta', 'y'.repeat(31), ' '.repeat(40), `  ${'z'.repeat(30)}  `])(
    'presente mas inválida (%j): falha fechada para QUALQUER chave, sem recorrer à ADMIN_KEY e sem expor valores',
    async invalida => {
      process.env.BLING_ADMIN_KEY = invalida;
      for (const tentativa of [TEST_ENV.ADMIN_KEY, invalida.trim() || 'vazia', CHAVE_BLING]) {
        for (const [acao, method, body] of acoes) {
          const r = await chamar(acao, { method, headers: comChave(tentativa), body });
          expect(r.statusCode, `${acao} com ${tentativa.slice(0, 4)}`).toBe(500);
          expect(r.json().codigo).toBe('bling_configuracao');
        }
      }
      expect([...cache.store.keys()].some(k => k.startsWith('bling:oauth_state:'))).toBe(false);
      const tudo = corpos.join(' ') + logs();
      expect(tudo).toContain('BLING_ADMIN_KEY');
      if (invalida.trim()) expect(tudo).not.toContain(invalida.trim());
      expect(tudo).not.toContain(TEST_ENV.ADMIN_KEY);
    },
  );

  it('igual à ADMIN_KEY (isolamento anulado): falha fechada, inclusive para a própria ADMIN_KEY', async () => {
    process.env.BLING_ADMIN_KEY = ` ${TEST_ENV.ADMIN_KEY.padEnd(32, 'x')} `;
    process.env.ADMIN_KEY = TEST_ENV.ADMIN_KEY.padEnd(32, 'x');
    resetEnvForTests();
    try {
      for (const [acao, method, body] of acoes) {
        const r = await chamar(acao, { method, headers: comChave(TEST_ENV.ADMIN_KEY.padEnd(32, 'x')), body });
        expect(r.statusCode).toBe(500);
      }
      expect(corpos.join(' ') + logs()).not.toContain(TEST_ENV.ADMIN_KEY);
    } finally {
      process.env.ADMIN_KEY = TEST_ENV.ADMIN_KEY;
      resetEnvForTests();
    }
  });

  it('logs de tentativa negada citam só o nome da chave esperada, nunca valores', async () => {
    process.env.BLING_ADMIN_KEY = CHAVE_BLING;
    await chamar('bling-status', { headers: comChave('tentativa-errada-qualquer-coisa') });
    const t = logs();
    expect(t).toContain('esperada: BLING_ADMIN_KEY');
    expect(t).not.toMatch(new RegExp(`${CHAVE_BLING}|${TEST_ENV.ADMIN_KEY}|tentativa-errada`));
  });

  it('callback não depende de chave nenhuma (protegido só pelo state)', async () => {
    process.env.BLING_ADMIN_KEY = 'curta';
    const r = await chamar('bling-callback', { query: { code: 'c', state: 'a'.repeat(48) } });
    expect(r.statusCode).toBe(303);
  });

  it('integração desligada continua 503 antes de olhar a chave', async () => {
    limparBling();
    process.env.BLING_ADMIN_KEY = 'curta';
    expect((await chamar('bling-status', { headers: admin() })).statusCode).toBe(503);
  });
});

describe('BLING_ADMIN_KEY não afeta as rotas administrativas existentes (workflows)', () => {
  it('api/admin/seed continua exigindo a ADMIN_KEY e recusa a BLING_ADMIN_KEY', async () => {
    process.env.BLING_ADMIN_KEY = 'chave-bling-de-teste-com-32-caract';
    const { default: seed } = await import('../api/admin/seed.js');
    const req = (k: string) => mockReq({ method: 'POST', headers: { 'x-admin-key': k, 'content-type': 'application/json' }, body: {} });
    const comBling = mockRes(); await seed(req('chave-bling-de-teste-com-32-caract'), comBling);
    expect(comBling.statusCode).toBe(401);
    const comAdmin = mockRes(); await seed(req(TEST_ENV.ADMIN_KEY), comAdmin);
    expect(comAdmin.statusCode).not.toBe(401);
  });
});
