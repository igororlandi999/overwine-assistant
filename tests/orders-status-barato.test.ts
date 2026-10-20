/**
 * Status barato (10/2026) — a consulta que o dashboard faz a cada 60 s.
 *
 * Antes: sessão (GET + renovação por minuto), rate limit (INCR + EXPIRE por
 * janela de 60 s), manifesto, status e telemetria (3 GETs) e o diagnóstico de
 * tempo real (2 GETs + LLEN) — ~10 comandos faturáveis por poll.
 * Agora: sessão (GET), rate limit (INCR) e UM MGET; diagnóstico só com
 * `?diagnostico=1`. Renovação de sessão a cada 5 min e janela de rate limit
 * de 5 min diluem os dois comandos ocasionais.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { setCacheForTests, type Cache } from '../src/lib/cache/cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import { createSession, validateSession } from '../src/lib/session.js';
import { writeChunk, publishManifest, type OrdersManifest } from '../src/lib/orders-store.js';
import { mesclarStatus } from '../src/services/orders-sync.service.js';
import { registrarConclusaoSync, registrarFalhaSync } from '../src/lib/sync-telemetry.js';
import { cacheDaConta } from '../src/lib/cache/conta-cache.js';
import { contaLegada, contaPorId } from '../src/config/contas.js';
import handler from '../api/orders/[resource].js';

/** Conta comandos FATURÁVEIS na Upstash: EVAL = 1 + chamadas internas; INCR que abre janela = INCR + EXPIRE. */
class Faturavel implements Cache {
  n = 0;
  por: Record<string, number> = {};
  chavesMget: string[][] = [];
  constructor(readonly b: FakeCache) {}
  private c(m: string, k = 1) { this.n += k; this.por[m] = (this.por[m] ?? 0) + k; }
  zerar() { this.n = 0; this.por = {}; this.chavesMget = []; }
  get(k: string) { this.c('get'); return this.b.get(k); }
  mget(ks: string[]) { this.c('mget'); this.chavesMget.push(ks); return this.b.mget(ks); }
  set(k: string, v: string, t?: number) { this.c('set'); return this.b.set(k, v, t); }
  del(k: string) { this.c('del'); return this.b.del(k); }
  setNX(k: string, v: string, t: number) { this.c('setNX'); return this.b.setNX(k, v, t); }
  delIfEquals(k: string, v: string) { this.c('eval', 3); return this.b.delIfEquals(k, v); }
  async incr(k: string, t: number) { const n = await this.b.incr(k, t); this.c('incr'); if (n === 1) this.c('expire'); return n; }
  rpush(k: string, ...v: string[]) { this.c('rpush'); return this.b.rpush(k, ...v); }
  lpopMany(k: string, m: number) { this.c('lpopMany'); return this.b.lpopMany(k, m); }
  llen(k: string) { this.c('llen'); return this.b.llen(k); }
}

function mockRes() {
  const r: any = { statusCode: 0, headers: {}, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.setHeader = () => r;
  r.send = (b: any) => { r.body = b; return r; };
  r.end = () => r;
  r.json = () => JSON.parse(r.body);
  return r;
}

const AGORA = Date.UTC(2026, 9, 20, 15, 0, 0);
let fake: FakeCache;
let cache: Faturavel;
let token: string;

async function publicarBase(c: Cache, total: number, versao: number, newest: string) {
  const chunks = [await writeChunk(c, 'ativos', versao, 0, [{ id: versao, status: 'paid', date_created: newest, paid_amount: 1, total_amount: 1, order_items: [] } as never])];
  const man: OrdersManifest = {
    versao, chunks, totalRegistros: total, newestDate: newest, oldestDate: '2025-01-01T00:00:00.000-03:00',
    chunkSize: 500, updatedAt: new Date(AGORA - 3600_000).toISOString(), origem: 'incremental', chunkCounts: [1],
  };
  await publishManifest(c, 'ativos', man);
  await mesclarStatus(c, 'ativos', {
    ultimaVersao: versao, totalRegistros: total, newestDate: newest,
    lastSyncAt: new Date(AGORA - 90_000).toISOString(), lastResult: 'sem_novos', emAndamento: false,
    ultimaRevisaoEm: new Date(AGORA - 300_000).toISOString(),
  });
  await registrarConclusaoSync(c, { origem: 'reconciliation', modo: 'incremental', duracaoMs: 1, chamadasML: 5, novos: 0, atualizados: 0, versaoPublicada: null });
}

const legada = () => cacheDaConta(cache, contaLegada());
const degustar = () => cacheDaConta(cache, contaPorId('degustar-ml')!);

beforeEach(async () => {
  vi.useFakeTimers({ now: AGORA, toFake: ['Date'] });
  Object.assign(process.env, TEST_ENV, {
    MULTI_CONTA_ENABLED: 'true', CONTAS_ATIVAS: 'degustar-ml', ML_DEGUSTAR_USER_ID: '999',
    ML_WEBHOOK_SECRET: 'segredo-de-webhook-bem-longo',
  });
  resetEnvForTests();
  fake = new FakeCache();
  cache = new Faturavel(fake);
  setCacheForTests(cache);
  await publicarBase(legada(), 6746, 1913, '2026-10-20T09:54:55.000-04:00');
  await publicarBase(degustar(), 134, 125, '2026-10-19T23:03:39.000-04:00');
  token = (await createSession(cache)).id;
});
afterEach(() => { vi.useRealTimers(); delete process.env.ML_WEBHOOK_SECRET; resetEnvForTests(); });

async function status(contas: string, extra: Record<string, string> = {}) {
  const res = mockRes();
  await handler({ method: 'GET', headers: { authorization: `Bearer ${token}` }, query: { resource: 'status', alvo: 'ativos', contas, ...extra } } as never, res);
  return res;
}
/** Avança o relógio como o poll do dashboard (60 s) e mede uma consulta. */
async function poll(contas: string, extra: Record<string, string> = {}) {
  vi.setSystemTime(Date.now() + 60_000);
  cache.zerar();
  const res = await status(contas, extra);
  return { res, n: cache.n, por: { ...cache.por }, mget: cache.chavesMget };
}
const semRelogio = (b: Record<string, unknown>): Record<string, unknown> => {
  const { agora, idadeSegundos, idadeCheckSegundos, tempoReal, porConta, ...resto } = b;
  void agora; void idadeSegundos; void idadeCheckSegundos; void tempoReal;
  if (porConta && typeof porConta === 'object') {
    resto.porConta = Object.fromEntries(Object.entries(porConta as Record<string, Record<string, unknown>>).map(([k, v]) => [k, semRelogio(v)]));
  }
  return resto;
};

describe('status barato — custo por poll', () => {
  it('Overwine ML: 3 comandos no poll típico, sem diagnóstico; 10 polls custam no máximo 34', async () => {
    let total = 0;
    const custos: number[] = [];
    for (let i = 0; i < 10; i++) {
      const p = await poll('overwine-ml');
      expect(p.res.statusCode).toBe(200);
      expect(p.por.mget).toBe(1);
      expect(p.por.llen ?? 0).toBe(0);           // tamanho da fila: só no diagnóstico
      expect(p.por.get).toBe(1);                 // só a sessão
      custos.push(p.n);
      total += p.n;
    }
    // Típico: GET sessão + INCR + MGET. A cada 5 min, +EXPIRE e +renovação.
    expect(custos.filter(c => c === 3).length).toBeGreaterThanOrEqual(6);
    expect(Math.max(...custos)).toBeLessThanOrEqual(5);
    expect(total).toBeLessThanOrEqual(34);
  });

  it('Degustar: mesmo custo, e o MGET lê só chaves da Degustar', async () => {
    const p = await poll('degustar-ml');
    expect(p.res.statusCode).toBe(200);
    expect(p.por.mget).toBe(1);
    expect(p.mget).toEqual([[
      'c:degustar-ml:orders:manifest', 'c:degustar-ml:orders:sync:status:ativos', 'c:degustar-ml:orders:sync:obs',
    ]]);
  });

  it('Overwine ML (legada): MGET nas chaves de sempre, sem prefixo', async () => {
    const p = await poll('overwine-ml');
    expect(p.mget).toEqual([['orders:manifest', 'orders:sync:status:ativos', 'orders:sync:obs']]);
  });

  it('consolidado: um MGET por conta, sem diagnóstico', async () => {
    const p = await poll('overwine-ml,degustar-ml');
    expect(p.res.statusCode).toBe(200);
    expect(p.por.mget).toBe(2);
    expect(p.por.llen ?? 0).toBe(0);
    expect(p.res.json()).not.toHaveProperty('tempoReal');
  });

  it('?diagnostico=1 devolve o tempoReal (custa +3 por conta)', async () => {
    const p = await poll('overwine-ml', { diagnostico: '1' });
    const b = p.res.json();
    expect(b.tempoReal.habilitado).toBe(true);
    expect(b.tempoReal).toHaveProperty('pendentes');
    expect(p.por.llen).toBe(1);
    expect(p.por.get).toBe(3); // sessão + 2 blobs de tempo real
  });
});

describe('status barato — mesmo conteúdo que o dashboard usa', () => {
  it('corpo enxuto = corpo de diagnóstico sem o bloco tempoReal', async () => {
    for (const contas of ['overwine-ml', 'degustar-ml', 'overwine-ml,degustar-ml']) {
      const enxuto = (await status(contas)).json();
      const completo = (await status(contas, { diagnostico: '1' })).json();
      expect(enxuto).not.toHaveProperty('tempoReal');
      expect(completo).toHaveProperty('tempoReal');
      expect(semRelogio(enxuto)).toEqual(semRelogio(completo));
      for (const k of ['agora', 'idadeSegundos', 'idadeCheckSegundos']) expect(enxuto).toHaveProperty(k);
    }
  });

  it('campos do poll: versao, totalRegistros, newestDate, updatedAt, partial, origem, idadeCheck e sincronizacao', async () => {
    const b = (await status('overwine-ml')).json();
    expect(b).toMatchObject({
      conta: 'overwine-ml', versao: 1913, totalRegistros: 6746, newestDate: '2026-10-20T09:54:55.000-04:00',
      partial: false, origem: 'incremental', lastResult: 'sem_novos',
    });
    expect(b.idadeCheckSegundos).toBe(90);
    expect(b.sincronizacao.totalConcluidos).toBe(1);
  });

  it('contas isoladas: cada uma vê só o próprio snapshot', async () => {
    const o = (await status('overwine-ml')).json();
    const d = (await status('degustar-ml')).json();
    expect([o.versao, o.totalRegistros, o.conta]).toEqual([1913, 6746, 'overwine-ml']);
    expect([d.versao, d.totalRegistros, d.conta]).toEqual([125, 134, 'degustar-ml']);
    const c = (await status('overwine-ml,degustar-ml')).json();
    expect(c.porConta['overwine-ml'].totalRegistros).toBe(6746);
    expect(c.porConta['degustar-ml'].totalRegistros).toBe(134);
    expect(c.totalRegistros).toBe(6746 + 134);
  });

  it('versão nova publicada aparece no poll seguinte (o que dispara o recarregamento)', async () => {
    const antes = (await status('overwine-ml')).json().versao;
    await publicarBase(legada(), 6747, 1914, '2026-10-20T11:00:00.000-04:00');
    const depois = (await status('overwine-ml')).json();
    expect(antes).toBe(1913);
    expect(depois.versao).toBe(1914);
    expect(depois.totalRegistros).toBe(6747);
  });

  it('sincronização em andamento e falha real continuam visíveis', async () => {
    vi.setSystemTime(Date.now() + 60_000);   // a falha vem depois da última conclusão
    await mesclarStatus(degustar(), 'ativos', { emAndamento: true, lastResult: 'erro_parcial' });
    await registrarFalhaSync(degustar(), 'reconciliation', 'token recusado pelo ML');
    const d = (await status('degustar-ml')).json();
    expect(d.partial).toBe(true);
    expect(d.lastResult).toBe('erro_parcial');
    expect(d.sincronizacao.ultimaFalhaMotivo).toBe('token recusado pelo ML');
    expect(Date.parse(d.sincronizacao.ultimaFalhaEm)).toBeGreaterThan(Date.parse(d.sincronizacao.ultimoSyncConcluidoEm));
    // e a Overwine segue sem falha
    expect((await status('overwine-ml')).json().sincronizacao.ultimaFalhaEm).toBeNull();
  });

  it('manifesto corrompido continua sendo erro (não vira "sem snapshot")', async () => {
    await fake.set('orders:manifest', '{quebrado');
    const res = await status('overwine-ml');
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
  });
});

describe('status barato — proteções mantidas', () => {
  it('rate limit: 3000 consultas por 5 min por sessão; a 3001ª é 429', async () => {
    const key = `rl:orders-read:${token.slice(0, 24)}:${Math.floor(Date.now() / 300_000)}`;
    await fake.set(key, '3000', 300);
    expect((await status('overwine-ml')).statusCode).toBe(429);
  });

  it('sessão comum renova o TTL a cada 5 min, não a cada consulta', async () => {
    cache.zerar();
    vi.setSystemTime(Date.now() + 60_000);
    expect(await validateSession(cache, token)).not.toBeNull();
    expect(cache.por.set ?? 0).toBe(0);           // 1 min: não regrava
    vi.setSystemTime(Date.now() + 250_000);
    expect(await validateSession(cache, token)).not.toBeNull();
    expect(cache.por.set).toBe(1);                // passou de 5 min: regrava
  });

  it('sem sessão continua 401', async () => {
    const res = mockRes();
    await handler({ method: 'GET', headers: {}, query: { resource: 'status', alvo: 'ativos' } } as never, res);
    expect(res.statusCode).toBe(401);
  });
});
