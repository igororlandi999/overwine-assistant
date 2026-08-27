/**
 * Contrato HTTP da callback de notificações do Mercado Livre.
 *
 * A regra que mais importa aqui não é de segurança, é de PROTOCOLO: o ML trata
 * uma resposta que não seja 2xx como entrega falha e reenvia; uma sequência de
 * falhas pode fazer a callback ser desabilitada na aplicação. Por isso tudo o
 * que não for problema de autenticação responde 200 — inclusive tópico que não
 * nos interessa e corpo malformado. Os testes abaixo travam exatamente isso,
 * porque é o tipo de coisa que alguém "corrige" para 400 com a melhor das
 * intenções.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { tamanhoFila, lerObsRecebimento } from '../src/lib/orders-events.js';
import handler from '../api/notifications/ml.js';

const SEGREDO = 'segredo-de-webhook-bem-longo';
const UID = TEST_ENV.ML_USER_ID;

function mockReq(o: Partial<{ method: string; headers: Record<string, unknown>; query: Record<string, unknown>; body: unknown }> = {}) {
  return { method: 'POST', headers: {}, query: {}, body: undefined, ...o } as any;
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

const corpo = (over: Record<string, unknown> = {}) => ({
  _id: 'notif-1',
  topic: 'orders_v2',
  resource: '/orders/2000012345',
  user_id: Number(UID),
  application_id: 1234,
  attempts: 1,
  sent: '2026-08-27T09:00:00.000Z',
  received: '2026-08-27T09:00:00.000Z',
  ...over,
});

let cache: FakeCache;
beforeEach(() => {
  cache = new FakeCache();
  setCacheForTests(cache);
  Object.assign(process.env, TEST_ENV, { ML_WEBHOOK_SECRET: SEGREDO });
  resetEnvForTests();
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.ML_WEBHOOK_SECRET;
  resetEnvForTests();
  vi.restoreAllMocks();
});

async function chamar(o: Parameters<typeof mockReq>[0] = {}) {
  const res = mockRes();
  await handler(mockReq(o), res);
  return res;
}

describe('POST /api/notifications/ml — autenticação e método', () => {
  it('só POST', async () => {
    const res = await chamar({ method: 'GET', query: { k: SEGREDO }, body: corpo() });
    expect(res.statusCode).toBe(405);
  });

  it('sem ML_WEBHOOK_SECRET o recurso responde 503 e nada é enfileirado', async () => {
    delete process.env.ML_WEBHOOK_SECRET;
    resetEnvForTests();
    const res = await chamar({ query: { k: 'qualquer' }, body: corpo() });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('notificacoes_desabilitadas');
    expect(await tamanhoFila(cache)).toBe(0);
  });

  it('segredo errado é 401 e NÃO enfileira', async () => {
    const res = await chamar({ query: { k: 'errado' }, body: corpo() });
    expect(res.statusCode).toBe(401);
    expect(await tamanhoFila(cache)).toBe(0);
  });

  it('sem segredo na URL é 401', async () => {
    const res = await chamar({ query: {}, body: corpo() });
    expect(res.statusCode).toBe(401);
  });

  it('a resposta NUNCA devolve dado do pedido, chave ou token', async () => {
    const res = await chamar({ query: { k: SEGREDO }, body: corpo() });
    const texto = String(res.body);
    expect(texto).toBe(JSON.stringify({ ok: true }));
    expect(texto).not.toContain('2000012345');
    expect(texto).not.toContain(SEGREDO);
  });
});

describe('POST /api/notifications/ml — o ML sempre recebe 200 no que não é auth', () => {
  it('notificação válida: 200 e evento na fila', async () => {
    const res = await chamar({ query: { k: SEGREDO }, body: corpo() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await tamanhoFila(cache)).toBe(1);
  });

  it('tópico que não interessa: 200 com ignorada, e nada na fila', async () => {
    const res = await chamar({ query: { k: SEGREDO }, body: corpo({ topic: 'shipments', resource: '/shipments/1' }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, ignorada: true });
    expect(await tamanhoFila(cache)).toBe(0);
  });

  it('corpo malformado: 200, não 400 — 4xx faria o ML reenviar para sempre', async () => {
    const res = await chamar({ query: { k: SEGREDO }, body: 'isto nao e json' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ignorada).toBe(true);
  });

  it('pedido de OUTRA conta: 200 e nada na fila', async () => {
    const res = await chamar({ query: { k: SEGREDO }, body: corpo({ user_id: 987654321 }) });
    expect(res.statusCode).toBe(200);
    expect(await tamanhoFila(cache)).toBe(0);
    expect((await lerObsRecebimento(cache)).totalRejeitadas).toBe(1);
  });

  it('reenvio do mesmo _id: 200 com duplicada e a fila não cresce', async () => {
    await chamar({ query: { k: SEGREDO }, body: corpo() });
    const res = await chamar({ query: { k: SEGREDO }, body: corpo() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, duplicada: true });
    expect(await tamanhoFila(cache)).toBe(1);
  });

  it('corpo como STRING JSON (sem parser da Vercel) é aceito igual', async () => {
    const res = await chamar({ query: { k: SEGREDO }, body: JSON.stringify(corpo()) });
    expect(res.statusCode).toBe(200);
    expect(await tamanhoFila(cache)).toBe(1);
  });
});

describe('POST /api/notifications/ml — limite de taxa', () => {
  it('acima do teto por minuto responde 429, mas o teto é folgado para o volume real', async () => {
    for (let i = 0; i < 300; i++) {
      await chamar({ query: { k: SEGREDO }, body: corpo({ _id: `n${i}` }) });
    }
    const res = await chamar({ query: { k: SEGREDO }, body: corpo({ _id: 'estoura' }) });
    expect(res.statusCode).toBe(429);
  });
});
