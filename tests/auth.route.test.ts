/**
 * Contrato HTTP de /api/auth com "manter conectado".
 *
 * O que sai daqui para o navegador é UM token opaco de sessão. Nunca a senha,
 * nunca token do Mercado Livre, nunca ADMIN_KEY — e um login errado não cria
 * sessão nenhuma.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { PERSISTENT_SLIDING_TTL_S } from '../src/lib/session.js';
import handler from '../api/auth/[action].js';

function mockReq(o: Partial<{ method: string; headers: Record<string, unknown>; query: Record<string, unknown>; body: unknown }> = {}) {
  return { method: 'POST', headers: {}, query: {}, body: undefined, socket: { remoteAddress: '10.0.0.1' }, ...o } as any;
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
beforeEach(() => {
  cache = new FakeCache();
  setCacheForTests(cache);
  Object.assign(process.env, TEST_ENV);
  resetEnvForTests();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function chamar(action: string, o: Parameters<typeof mockReq>[0] = {}) {
  const res = mockRes();
  await handler(mockReq({ query: { action }, ...o }), res);
  return res;
}
const sessoesNoRedis = () => [...cache.store.keys()].filter(k => k.startsWith('sess:'));

describe('POST /api/auth/login', () => {
  it('sem "persistent": sessão comum de 12h', async () => {
    const res = await chamar('login', { body: { password: TEST_ENV.DASHBOARD_PASSWORD } });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.session_token).toMatch(/^sess_[0-9a-f]{64}$/);
    expect(b.persistent).toBe(false);
    expect(b.expires_at - Date.now()).toBeLessThanOrEqual(12 * 3600_000 + 1000);
  });

  it('com "persistent: true": sessão de 30 dias, revogável', async () => {
    const res = await chamar('login', { body: { password: TEST_ENV.DASHBOARD_PASSWORD, persistent: true } });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.persistent).toBe(true);
    expect(b.expires_at - Date.now()).toBeGreaterThan((PERSISTENT_SLIDING_TTL_S - 60) * 1000);
    expect(sessoesNoRedis()).toHaveLength(1);
  });

  it('"persistent" só vale como booleano true — string ou número não persistem', async () => {
    for (const v of ['true', 1, 'sim']) {
      const res = await chamar('login', { body: { password: TEST_ENV.DASHBOARD_PASSWORD, persistent: v } });
      expect(res.json().persistent).toBe(false);
    }
  });

  it('a resposta NÃO contém a senha nem credencial do Mercado Livre', async () => {
    const res = await chamar('login', { body: { password: TEST_ENV.DASHBOARD_PASSWORD, persistent: true } });
    expect(res.body).not.toContain(TEST_ENV.DASHBOARD_PASSWORD);
    expect(res.body).not.toMatch(/access_token|refresh_token|APP_USR|TG-|ADMIN/);
  });

  it('senha errada: 401 e NENHUMA sessão criada, mesmo pedindo persistente', async () => {
    const res = await chamar('login', { body: { password: 'errada-errada', persistent: true } });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('session_token');
    expect(sessoesNoRedis()).toHaveLength(0);
  });
});

describe('GET /api/auth/session e POST /api/auth/logout', () => {
  async function login(persistent: boolean) {
    return (await chamar('login', { body: { password: TEST_ENV.DASHBOARD_PASSWORD, persistent } })).json().session_token as string;
  }

  it('token válido: ok=true e persistent refletido', async () => {
    const tok = await login(true);
    const res = await chamar('session', { method: 'GET', headers: { authorization: `Bearer ${tok}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, persistent: true });
  });

  it('token inválido ou expirado: 401', async () => {
    expect((await chamar('session', { method: 'GET', headers: { authorization: 'Bearer sess_' + 'f'.repeat(64) } })).statusCode).toBe(401);
    const tok = await login(true);
    cache.store.get(`sess:${tok}`)!.exp = Date.now() - 1;   // expirou no Redis
    expect((await chamar('session', { method: 'GET', headers: { authorization: `Bearer ${tok}` } })).statusCode).toBe(401);
  });

  it('logout revoga a sessão: o mesmo token deixa de validar', async () => {
    const tok = await login(true);
    expect((await chamar('logout', { headers: { authorization: `Bearer ${tok}` } })).statusCode).toBe(200);
    expect(sessoesNoRedis()).toHaveLength(0);
    expect((await chamar('session', { method: 'GET', headers: { authorization: `Bearer ${tok}` } })).statusCode).toBe(401);
  });
});
