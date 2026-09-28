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

/**
 * "Manter conectado neste navegador": o frontend passa a guardar o token em
 * localStorage, e um token que morre em 12h obrigaria a senha todo dia. A
 * sessão persistente dura 30 dias deslizantes e no máximo 90 — não é eterna.
 */
describe('sessão persistente (manter conectado)', () => {
  let cache: FakeCache;
  beforeEach(() => { cache = new FakeCache(); Object.assign(process.env, TEST_ENV); resetEnvForTests(); });

  it('login comum continua com 12h deslizantes e não é persistente', async () => {
    const s = await createSession(cache);
    expect(s.persistente).toBe(false);
    expect(s.expiresAt - Date.now()).toBeLessThanOrEqual(12 * 3600_000 + 1000);
    const exp = cache.store.get(`sess:${s.id}`)!.exp!;
    expect(exp - Date.now()).toBeLessThanOrEqual(12 * 3600_000 + 1000);
  });

  it('persistente: TTL de 30 dias no Redis e expiresAt de 30 dias', async () => {
    const s = await createSession(cache, { persistente: true });
    expect(s.persistente).toBe(true);
    const exp = cache.store.get(`sess:${s.id}`)!.exp!;
    expect(exp - Date.now()).toBeGreaterThan(29 * 24 * 3600_000);
    expect(exp - Date.now()).toBeLessThanOrEqual(30 * 24 * 3600_000 + 1000);
    expect(s.expiresAt - Date.now()).toBeGreaterThan(29 * 24 * 3600_000);
  });

  it('persistente: validar devolve persistente=true e renova a janela deslizante', async () => {
    const s = await createSession(cache, { persistente: true });
    // simula 2 horas sem uso: lastSeenAt velho, TTL parcialmente consumido
    const raw = JSON.parse(cache.store.get(`sess:${s.id}`)!.v);
    raw.lastSeenAt = Date.now() - 2 * 3600_000;
    cache.store.set(`sess:${s.id}`, { v: JSON.stringify(raw), exp: Date.now() + 28 * 24 * 3600_000 });
    const v = await validateSession(cache, s.id);
    expect(v).not.toBeNull();
    expect(v!.persistente).toBe(true);
    expect(cache.store.get(`sess:${s.id}`)!.exp! - Date.now()).toBeGreaterThan(29 * 24 * 3600_000);
  });

  it('persistente: NÃO é eterna — morre pela vida máxima absoluta de 90 dias', async () => {
    const s = await createSession(cache, { persistente: true });
    const raw = JSON.parse(cache.store.get(`sess:${s.id}`)!.v);
    raw.createdAt = Date.now() - 91 * 24 * 3600_000;
    raw.lastSeenAt = Date.now();
    cache.store.set(`sess:${s.id}`, { v: JSON.stringify(raw), exp: Date.now() + 30 * 24 * 3600_000 });
    expect(await validateSession(cache, s.id)).toBeNull();
    expect(cache.store.get(`sess:${s.id}`)).toBeUndefined();
  });

  it('persistente: sem uso por mais de 30 dias, o Redis já apagou — token rejeitado', async () => {
    const s = await createSession(cache, { persistente: true });
    cache.store.get(`sess:${s.id}`)!.exp = Date.now() - 1;
    expect(await validateSession(cache, s.id)).toBeNull();
  });

  it('sessão gravada antes desta versão (sem o campo) continua valendo como comum', async () => {
    const id = 'sess_' + 'a'.repeat(64);
    await cache.set(`sess:${id}`, JSON.stringify({ createdAt: Date.now(), lastSeenAt: Date.now() }), 3600);
    const v = await validateSession(cache, id);
    expect(v).not.toBeNull();
    expect(v!.persistente).toBe(false);
  });

  it('cada login cria a sua sessão; revogar uma não afeta a outra', async () => {
    const a = await createSession(cache, { persistente: true });
    const b = await createSession(cache, { persistente: true });
    expect(a.id).not.toBe(b.id);
    await destroySession(cache, a.id);
    expect(await validateSession(cache, a.id)).toBeNull();
    expect(await validateSession(cache, b.id)).not.toBeNull();
  });

  it('o token tem 256 bits de entropia e nenhuma credencial', async () => {
    const s = await createSession(cache, { persistente: true });
    expect(s.id).toMatch(/^sess_[0-9a-f]{64}$/);
    expect(cache.store.get(`sess:${s.id}`)!.v).not.toMatch(/APP_USR|TG-|password|senha/);
  });
});
