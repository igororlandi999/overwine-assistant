/**
 * Etapa 1 — o assistente ainda é mono-conta (lê o snapshot da Overwine). Uma
 * seleção de outra conta, ou de várias, tem de ser recusada de forma
 * explícita: responder com os números da Overwine como se fossem da Degustar
 * seria pior que não responder. A conta legada explícita segue como a ausente.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { createSession } from '../src/lib/session.js';
import handler from '../api/chat.js';

function mockReq(o: Partial<{ method: string; headers: Record<string, unknown>; query: Record<string, unknown>; body: unknown }> = {}) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, query: {}, body: undefined, socket: { remoteAddress: '10.0.0.3' }, ...o } as any;
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
let token: string;
beforeEach(async () => {
  cache = new FakeCache();
  setCacheForTests(cache);
  Object.assign(process.env, TEST_ENV);
  resetEnvForTests();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  token = (await createSession(cache)).id;
});
afterEach(() => vi.restoreAllMocks());

async function perguntar(body: unknown) {
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body }), res);
  return res;
}

describe('POST /api/chat — selecao de conta', () => {
  it('contas=degustar-ml → 400 assistente_mono_conta, sem consultar nada', async () => {
    const res = await perguntar({ message: 'qual o faturamento de hoje?', contas: 'degustar-ml' });
    expect(res.statusCode).toBe(400);
    expect((res.json().error && res.json().error.code) ?? res.json().error).toBe('assistente_mono_conta');
  });

  it('varias contas (lista ou csv) → 400 assistente_mono_conta', async () => {
    for (const contas of ['overwine-ml,degustar-ml', ['overwine-ml', 'degustar-ml']]) {
      const res = await perguntar({ message: 'faturamento', contas });
      expect(res.statusCode).toBe(400);
      expect((res.json().error && res.json().error.code) ?? res.json().error).toBe('assistente_mono_conta');
    }
  });

  it('conta=degustar-ml (singular) → tambem recusada', async () => {
    const res = await perguntar({ message: 'faturamento', conta: 'degustar-ml' });
    expect((res.json().error && res.json().error.code) ?? res.json().error).toBe('assistente_mono_conta');
  });

  it('contas=overwine-ml explicita NAO e recusada por conta: segue o fluxo normal', async () => {
    const res = await perguntar({ message: 'qual o faturamento de hoje?', contas: 'overwine-ml' });
    // o que vier depois (contexto, provedor de IA) nao importa aqui: so nao pode ser a recusa por conta
    expect((res.json().error && res.json().error.code) ?? res.json().error).not.toBe('assistente_mono_conta');
  });
});
