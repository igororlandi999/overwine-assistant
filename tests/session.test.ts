import { describe, it, expect, beforeEach } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { createSession, validateSession, destroySession } from '../src/lib/session.js';
import { resetEnvForTests } from '../src/config/env.js';

let cache: FakeCache;
beforeEach(() => {
  cache = new FakeCache();
  Object.assign(process.env, TEST_ENV);
  resetEnvForTests();
});

describe('sessões', () => {
  it('cria token opaco sess_ sem nenhuma credencial ML', async () => {
    const s = await createSession(cache);
    expect(s.id).toMatch(/^sess_[0-9a-f]{64}$/);
    expect(s.id).not.toContain('APP_USR');
    expect(s.id).not.toContain('TG-');
    const raw = await cache.get(`sess:${s.id}`);
    expect(raw).not.toContain('APP_USR'); // dado da sessão também é limpo
  });

  it('valida sessão existente e rejeita token inexistente/malformado', async () => {
    const s = await createSession(cache);
    expect(await validateSession(cache, s.id)).not.toBeNull();
    expect(await validateSession(cache, 'sess_' + 'a'.repeat(64))).toBeNull();
    expect(await validateSession(cache, 'qualquercoisa')).toBeNull();
    expect(await validateSession(cache, null)).toBeNull();
    expect(await validateSession(cache, 'APP_USR-123')).toBeNull(); // token ML não é sessão
  });

  it('expira pela vida máxima absoluta de 24h mesmo com uso contínuo', async () => {
    const s = await createSession(cache);
    const raw = JSON.parse((await cache.get(`sess:${s.id}`))!);
    raw.createdAt = Date.now() - 25 * 3600 * 1000; // envelhece 25h
    await cache.set(`sess:${s.id}`, JSON.stringify(raw), 3600);
    expect(await validateSession(cache, s.id)).toBeNull();
    expect(await cache.get(`sess:${s.id}`)).toBeNull(); // destruída
  });

  it('logout destrói a sessão', async () => {
    const s = await createSession(cache);
    await destroySession(cache, s.id);
    expect(await validateSession(cache, s.id)).toBeNull();
  });
});
