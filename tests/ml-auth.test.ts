import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { getAccessToken, seedTokens, mlFetch } from '../src/lib/ml-auth.js';
import { resetEnvForTests } from '../src/config/env.js';

let cache: FakeCache;

beforeEach(() => {
  cache = new FakeCache();
  Object.assign(process.env, TEST_ENV);
  resetEnvForTests();
  vi.restoreAllMocks();
});
afterEach(() => vi.restoreAllMocks());

function mockML(resposta: object, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(resposta), { status }) as unknown as Response
  );
}

describe('getAccessToken', () => {
  it('falha com mensagem clara quando a cadeia não foi semeada', async () => {
    await expect(getAccessToken(cache)).rejects.toThrow(/não semeada/i);
  });

  it('renova e ROTACIONA o refresh token (uso único do ML)', async () => {
    await cache.set('ml:refresh_token', 'TG-antigo');
    mockML({ access_token: 'AT-novo', refresh_token: 'TG-novo', expires_in: 21600 });
    const tok = await getAccessToken(cache);
    expect(tok.token).toBe('AT-novo');
    expect(await cache.get('ml:refresh_token')).toBe('TG-novo');
  });

  it('usa o access token em cache sem chamar o ML', async () => {
    const spy = mockML({});
    await cache.set('ml:access_token',
      JSON.stringify({ token: 'AT-cache', expiresAt: Date.now() + 3600_000 }));
    const tok = await getAccessToken(cache);
    expect(tok.token).toBe('AT-cache');
    expect(spy).not.toHaveBeenCalled();
  });

  it('libera o lock ao falhar, sem apagar lock de outra instância', async () => {
    await cache.set('ml:refresh_token', 'TG-x');
    mockML({ error: 'boom' }, 500);
    await expect(getAccessToken(cache)).rejects.toThrow();
    expect(await cache.get('ml:refresh_lock')).toBeNull();
  });

  it('compare-and-delete: NÃO apaga lock que expirou e foi readquirido por outro', async () => {
    // simula: instância A adquiriu com dono X; lock "de A" na verdade agora é de B
    await cache.set('ml:refresh_lock', 'dono-B', 30);
    const apagou = await cache.delIfEquals('ml:refresh_lock', 'dono-A');
    expect(apagou).toBe(false);
    expect(await cache.get('ml:refresh_lock')).toBe('dono-B');
  });
});

describe('seedTokens', () => {
  it('semeia via authorization code e valida user_id', async () => {
    mockML({ access_token: 'AT-1', refresh_token: 'TG-1', expires_in: 21600, user_id: 2329718196 });
    const r = await seedTokens(cache, { code: 'TG-code' });
    expect(r.userId).toBe(2329718196);
    expect(await cache.get('ml:refresh_token')).toBe('TG-1');
  });

  it('RECUSA semeadura de user_id diferente do ML_USER_ID', async () => {
    mockML({ access_token: 'AT-1', refresh_token: 'TG-1', expires_in: 21600, user_id: 999 });
    await expect(seedTokens(cache, { code: 'TG-code' })).rejects.toThrow(/difere de ML_USER_ID/);
    expect(await cache.get('ml:refresh_token')).toBeNull();
  });

  it('semeia via refresh token direto e valida a cadeia na hora', async () => {
    mockML({ access_token: 'AT-2', refresh_token: 'TG-2', expires_in: 21600 });
    await seedTokens(cache, { refreshToken: 'TG-inicial' });
    expect(await cache.get('ml:refresh_token')).toBe('TG-2');
  });
});

describe('mlFetch', () => {
  it('usa Bearer e em 401 invalida o cache e tenta UMA vez', async () => {
    await cache.set('ml:access_token',
      JSON.stringify({ token: 'AT-revogado', expiresAt: Date.now() + 3600_000 }));
    await cache.set('ml:refresh_token', 'TG-x');

    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'AT-novo', refresh_token: 'TG-y', expires_in: 21600 }), { status: 200 });
      }
      const auth = (init?.headers as Record<string, string>)?.Authorization || '';
      expect(auth.startsWith('Bearer ')).toBe(true);
      return auth === 'Bearer AT-novo'
        ? new Response(JSON.stringify({ ok: 1 }), { status: 200 })
        : new Response('{}', { status: 401 });
    });

    const res = await mlFetch(cache, '/users/me');
    expect(res.status).toBe(200);
    expect(calls.filter(c => c.includes('/users/me')).length).toBe(2); // original + retry único
  });
});
