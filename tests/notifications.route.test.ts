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
import { tamanhoFila, lerObsRecebimento, CHAVE_OBS_NOTIF, CHAVE_OBS_PROC } from '../src/lib/orders-events.js';
import {
  type OrdersManifest, readManifest, readSnapshot, writeChunk, publishManifest,
} from '../src/lib/orders-store.js';
import { ORDERS_SYNC_LOCK_KEY } from '../src/services/orders-sync.service.js';
import type { OrderSlim } from '../src/services/orders.service.js';
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
  application_id: Number(TEST_ENV.ML_CLIENT_ID),
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


// ═══════════════════════════════════════════════════════════════════════════
/**
 * Portão anterior ao merge. Cada teste aqui trava uma promessa feita ao
 * revisor, e não uma escolha de implementação.
 */
describe('portão — o segredo e a query string não vazam', () => {
  it('o segredo NAO aparece na telemetria gravada', async () => {
    await chamar({ query: { k: SEGREDO }, body: corpo() });
    const gravado = (cache.store.get(CHAVE_OBS_NOTIF)?.v ?? '') + (cache.store.get(CHAVE_OBS_PROC)?.v ?? '');
    expect(gravado).not.toContain(SEGREDO);
  });

  it('a query string NAO e gravada na telemetria, nem quando tem lixo junto', async () => {
    await chamar({
      query: { k: SEGREDO, debug: 'valor-marcado-xyz', outro: 'nao-deveria-persistir' },
      body: corpo(),
    });
    const gravado = (cache.store.get(CHAVE_OBS_NOTIF)?.v ?? '') + (cache.store.get(CHAVE_OBS_PROC)?.v ?? '');
    expect(gravado).not.toContain('valor-marcado-xyz');
    expect(gravado).not.toContain('nao-deveria-persistir');
    expect(gravado).not.toContain('k=');
  });

  it('o segredo NAO vai para o log, nem quando esta errado', async () => {
    const warn = vi.mocked(console.warn);
    await chamar({ query: { k: 'segredo-errado-de-atacante' }, body: corpo() });
    const tudo = warn.mock.calls.flat().map(String).join(' ');
    expect(tudo).not.toContain('segredo-errado-de-atacante');
    expect(tudo).not.toContain(SEGREDO);
  });

  it('nenhum log de sucesso carrega o segredo', async () => {
    await chamar({ query: { k: SEGREDO }, body: corpo() });
    const tudo = [...vi.mocked(console.info).mock.calls, ...vi.mocked(console.warn).mock.calls]
      .flat().map(String).join(' ');
    expect(tudo).not.toContain(SEGREDO);
  });
});

describe('portão — application_id e user_id conferidos antes de enfileirar', () => {
  it('application_id divergente e recusado, sem enfileirar', async () => {
    const res = await chamar({ query: { k: SEGREDO }, body: corpo({ application_id: 999999999 }) });
    expect(res.statusCode).toBe(200);   // 200 para o ML nao reenviar para sempre
    expect(await tamanhoFila(cache)).toBe(0);
    expect((await lerObsRecebimento(cache)).totalRejeitadas).toBe(1);
  });

  /**
   * Uma recusa e INVISIVEL do lado do Mercado Livre: ele recebe 200 e marca a
   * entrega como boa. Se o motivo nao ficasse gravado, um ML_CLIENT_ID com um
   * espaco sobrando derrubaria 100% das notificacoes e o sintoma seria "o
   * tempo real nao funciona", sem nada apontando para a causa.
   */
  it('o motivo da recusa fica gravado — recusa nao pode ser silenciosa', async () => {
    await chamar({ query: { k: SEGREDO }, body: corpo({ application_id: 999999999 }) });
    const obs = await lerObsRecebimento(cache);
    expect(obs.ultimoMotivoRejeicao).toBe('application_id_divergente');
    expect(obs.ultimaRejeicaoEm).toBeTypeOf('string');
  });

  it('cada motivo de recusa aparece com o proprio nome', async () => {
    const casos: Array<[Record<string, unknown>, string]> = [
      [{ user_id: 987654321 }, 'user_id_divergente'],
      [{ application_id: 5 }, 'application_id_divergente'],
      [{ topic: 'shipments', resource: '/shipments/1' }, 'topico_ignorado'],
      [{ resource: '/orders/abc' }, 'resource_invalido'],
    ];
    for (const [over, esperado] of casos) {
      cache.store.delete('orders:evt:obs:notif');
      await chamar({ query: { k: SEGREDO }, body: corpo(over) });
      expect((await lerObsRecebimento(cache)).ultimoMotivoRejeicao, esperado).toBe(esperado);
    }
  });

  it('o motivo gravado NAO carrega texto vindo do corpo da notificacao', async () => {
    await chamar({
      query: { k: SEGREDO },
      body: corpo({ topic: 'topico-forjado-com-<script>', resource: '/x/1' }),
    });
    const obs = await lerObsRecebimento(cache);
    expect(obs.ultimoMotivoRejeicao).toBe('topico_ignorado');
    expect(JSON.stringify(obs)).not.toContain('topico-forjado');
  });

  it('application_id ausente NAO reprova — o corpo do ML varia por topico', async () => {
    const sem = corpo();
    delete (sem as Record<string, unknown>).application_id;
    const res = await chamar({ query: { k: SEGREDO }, body: sem });
    expect(res.statusCode).toBe(200);
    expect(await tamanhoFila(cache)).toBe(1);
  });

  it('application_id como string bate com o ML_CLIENT_ID numerico', async () => {
    await chamar({ query: { k: SEGREDO }, body: corpo({ application_id: TEST_ENV.ML_CLIENT_ID }) });
    expect(await tamanhoFila(cache)).toBe(1);
  });

  it('user_id certo e application_id errado ainda reprova', async () => {
    await chamar({ query: { k: SEGREDO }, body: corpo({ user_id: Number(UID), application_id: 42 }) });
    expect(await tamanhoFila(cache)).toBe(0);
  });
});

describe('portão — orders_v2 basta, sem depender de created_orders', () => {
  it('orders_v2 sozinho enfileira: nada no caminho exige o topico antigo', async () => {
    const res = await chamar({ query: { k: SEGREDO }, body: corpo({ topic: 'orders_v2' }) });
    expect(res.statusCode).toBe(200);
    expect(await tamanhoFila(cache)).toBe(1);
    expect((await lerObsRecebimento(cache)).ultimaNotificacaoTopico).toBe('orders_v2');
  });
});

describe('portão — os 500 ms sao inviolaveis no caminho da resposta', () => {
  it('a rota NAO chama o Mercado Livre para responder', async () => {
    const fetchEspiao = vi.spyOn(globalThis, 'fetch');
    await chamar({ query: { k: SEGREDO }, body: corpo() });
    expect(fetchEspiao).not.toHaveBeenCalled();
  });

  it('o ack so enfileira: nada de manifesto publicado nem pedido buscado', async () => {
    await chamar({ query: { k: SEGREDO }, body: corpo() });
    expect(await tamanhoFila(cache)).toBe(1);
    expect(cache.store.get('orders:manifest')).toBeUndefined();
  });

  it('sem waitUntil o evento FICA na fila — nao ha dreno inline', async () => {
    // O runtime de teste nao publica o contexto de requisicao da Vercel, entao
    // este e exatamente o cenario "sem waitUntil".
    await chamar({ query: { k: SEGREDO }, body: corpo() });
    const obs = await lerObsRecebimento(cache);
    expect(obs.waitUntilDisponivel).toBe(false);
    expect(await tamanhoFila(cache)).toBe(1);
  });

  it('registra o tempo do ack, para o orcamento ser conferivel', async () => {
    await chamar({ query: { k: SEGREDO }, body: corpo() });
    const obs = await lerObsRecebimento(cache);
    expect(typeof obs.ultimoAckMs).toBe('number');
    expect(obs.ultimoAckMs).toBeGreaterThanOrEqual(0);
  });

  it('guarda o `sent` do ML para medir latencia ponta a ponta', async () => {
    await chamar({ query: { k: SEGREDO }, body: corpo({ sent: '2026-08-27T09:00:00.000Z' }) });
    expect((await lerObsRecebimento(cache)).ultimaNotificacaoSent).toBe('2026-08-27T09:00:00.000Z');
  });

  it('`sent` invalido vira null em vez de sujar a medicao', async () => {
    await chamar({ query: { k: SEGREDO }, body: corpo({ sent: 'nao-e-data' }) });
    expect((await lerObsRecebimento(cache)).ultimaNotificacaoSent).toBeNull();
  });
});

describe('portão — o corpo nunca vira estado do pedido', () => {
  it('campos de pedido no corpo sao IGNORADOS: so o id atravessa a fila', async () => {
    await chamar({
      query: { k: SEGREDO },
      body: corpo({
        status: 'cancelled',
        paid_amount: 999999,
        total_amount: 999999,
        order_items: [{ quantity: 42, item: { id: 'MLB-FORJADO' } }],
        buyer: { nickname: 'atacante' },
      }),
    });
    const naFila = cache.lists.get('orders:evt:queue') ?? [];
    expect(naFila).toHaveLength(1);
    const evento = JSON.parse(naFila[0]);
    expect(evento.orderId).toBe('2000012345');
    expect(Object.keys(evento).sort()).toEqual(
      ['notifId', 'orderId', 'recebidoEm', 'sent', 'topico']
    );
    expect(naFila[0]).not.toContain('MLB-FORJADO');
    expect(naFila[0]).not.toContain('atacante');
    expect(naFila[0]).not.toContain('999999');
  });

  it('resource com id nao numerico e recusado — o id so serve para GET /orders/{id}', async () => {
    for (const resource of ['/orders/1;rm', '/orders/../items/1', '/orders/1?x=1', '/orders/abc']) {
      const res = await chamar({ query: { k: SEGREDO }, body: corpo({ _id: resource, resource }) });
      expect(res.json().ignorada, resource).toBe(true);
    }
    expect(await tamanhoFila(cache)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
/**
 * O QUE DISPARA O PROCESSAMENTO DEPOIS DO ACK.
 *
 * Este bloco existe para responder uma pergunta específica com prova, e não
 * com afirmação: tirar o dreno do caminho da resposta transformou a fila numa
 * fila que só o GitHub Actions drena?
 *
 * Não. O contrato é:
 *   notificação → ACK 200 em menos de 500 ms → dreno IMEDIATO em segundo
 *   plano, agendado no `waitUntil` do runtime.
 *
 * O GitHub Actions é rede de segurança — para o evento que falhou, para o que
 * esbarrou no lock, e para o runtime que não oferece `waitUntil`. Nunca é o
 * caminho normal.
 *
 * Os testes abaixo instalam o MESMO contexto de requisição que a Vercel
 * publica (`Symbol.for('@vercel/request-context')`), porque é exatamente daí
 * que `src/lib/wait-until.ts` lê. Sem isso o ambiente de teste é,
 * legitimamente, um runtime sem `waitUntil` — e é assim que os testes do bloco
 * anterior conseguem exercitar o outro caminho.
 */
describe('portão — o que processa o pedido depois do ACK', () => {
  const SIMBOLO_CONTEXTO = Symbol.for('@vercel/request-context');

  /** Instala um waitUntil de mentira que COLETA, sem aguardar. */
  function instalarWaitUntil(): Promise<unknown>[] {
    const agendados: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[SIMBOLO_CONTEXTO] = {
      get: () => ({ waitUntil: (p: Promise<unknown>) => { agendados.push(p); } }),
    };
    return agendados;
  }
  function removerWaitUntil() {
    delete (globalThis as Record<symbol, unknown>)[SIMBOLO_CONTEXTO];
  }
  afterEach(removerWaitUntil);

  /** Snapshot base mínimo: sem ele o upsert recusa e não há o que provar. */
  async function publicarBase(): Promise<OrdersManifest> {
    const pedidos: OrderSlim[] = Array.from({ length: 3 }, (_, i) => ({
      id: i + 1, status: 'paid', date_created: `2026-08-2${i}T10:00:00.000Z`,
      paid_amount: 100, total_amount: 100,
      order_items: [{ quantity: 1, unit_price: 100, item: { id: 'MLB1', title: 'V', seller_sku: 'S', variation_id: null } }],
    }));
    const chave = await writeChunk(cache, 'ativos', 1, 0, pedidos);
    const man: OrdersManifest = {
      versao: 1, chunks: [chave], totalRegistros: 3,
      newestDate: pedidos[0].date_created, oldestDate: pedidos[2].date_created,
      chunkSize: 500, updatedAt: '2026-08-20T12:00:00.000Z', origem: 'full',
      chunkCounts: [3],
    };
    await publishManifest(cache, 'ativos', man);
    return man;
  }

  /** Token válido em cache: o dreno não deve gastar o teste em OAuth. */
  async function semearToken() {
    await cache.set('ml:access_token', JSON.stringify({
      token: 'token-de-teste', expiresAt: Date.now() + 3600_000,
    }));
  }

  const PEDIDO_CRU = {
    id: 2000012345, status: 'paid', date_created: '2026-08-27T09:00:00.000Z',
    paid_amount: 250, total_amount: 250,
    order_items: [{ quantity: 1, unit_price: 250, item: { id: 'MLB9', title: 'Vinho', seller_sku: 'SKU9', variation_id: null } }],
    buyer: { nickname: 'comprador' },
    shipping: { id: 77, logistic_type: 'fulfillment' },
  };

  function respostaDoPedido() {
    return new Response(JSON.stringify(PEDIDO_CRU), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }

  it('o HTTP 200 sai ANTES de o GET /orders/{id} terminar', async () => {
    await publicarBase();
    await semearToken();
    const agendados = instalarWaitUntil();

    // A busca do pedido fica PRESA até liberarmos. Se a resposta esperasse por
    // ela, o handler não retornaria e o teste travaria no próprio await.
    let liberar!: () => void;
    const preso = new Promise<void>(r => { liberar = r; });
    let buscaTerminou = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await preso;
      buscaTerminou = true;
      return respostaDoPedido();
    });

    const res = await chamar({ query: { k: SEGREDO }, body: corpo() });

    // Já respondemos, e a busca do pedido AINDA não terminou.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(buscaTerminou).toBe(false);

    // ...e o trabalho está agendado, não perdido.
    expect(agendados).toHaveLength(1);

    liberar();
    await Promise.all(agendados);
    expect(buscaTerminou).toBe(true);
  });

  it('o processamento e AGENDADO no waitUntil do runtime', async () => {
    await publicarBase();
    await semearToken();
    const agendados = instalarWaitUntil();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDoPedido());

    await chamar({ query: { k: SEGREDO }, body: corpo() });

    expect(agendados).toHaveLength(1);
    expect((await lerObsRecebimento(cache)).waitUntilDisponivel).toBe(true);
  });

  it('o pedido e atualizado pelo dreno de fundo, SEM depender do cron horario', async () => {
    const base = await publicarBase();
    await semearToken();
    const agendados = instalarWaitUntil();
    const espiao = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDoPedido());

    await chamar({ query: { k: SEGREDO }, body: corpo() });
    await Promise.all(agendados);   // é só isto: nenhum passo de sincronizacao

    const snap = await readSnapshot(cache, 'ativos');
    expect(snap.some(o => String(o.id) === '2000012345')).toBe(true);
    expect(snap).toHaveLength(4);

    const man = await readManifest(cache, 'ativos');
    expect(man!.versao).toBe(base.versao + 1);
    expect(man!.origem).toBe('webhook');
    expect(await tamanhoFila(cache)).toBe(0);

    // A única chamada ao ML foi a do pedido. Nenhum /orders/search — ou seja,
    // nada aqui passou pela varredura periódica.
    const urls = espiao.mock.calls.map(c => String(c[0]));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/orders/2000012345');
    expect(urls.some(u => u.includes('/orders/search'))).toBe(false);
  });

  it('a latencia medida cobre da notificacao ate a publicacao', async () => {
    await publicarBase();
    await semearToken();
    const agendados = instalarWaitUntil();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDoPedido());

    const sent = new Date(Date.now() - 800).toISOString();
    await chamar({ query: { k: SEGREDO }, body: corpo({ sent }) });
    await Promise.all(agendados);

    const b = JSON.parse(cache.store.get('orders:evt:obs:proc')!.v);
    expect(b.ultimaVersaoPublicada).toBe(2);
    expect(b.ultimaLatenciaTotalMs).toBeGreaterThanOrEqual(800);
  });

  it('falha no processamento NAO vira 500: o ACK ja foi dado', async () => {
    await publicarBase();
    await semearToken();
    const agendados = instalarWaitUntil();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('indisponivel', { status: 500 })
    );

    const res = await chamar({ query: { k: SEGREDO }, body: corpo() });
    expect(res.statusCode).toBe(200);

    // O trabalho de fundo tambem NAO pode rejeitar: ninguem esta ouvindo.
    await expect(Promise.all(agendados)).resolves.toBeDefined();
  });

  it('falha no processamento REENFILEIRA o evento — nada se perde', async () => {
    await publicarBase();
    await semearToken();
    const agendados = instalarWaitUntil();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('erro', { status: 500 }));

    await chamar({ query: { k: SEGREDO }, body: corpo() });
    await Promise.all(agendados);

    expect(await tamanhoFila(cache)).toBe(1);
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap.some(o => String(o.id) === '2000012345')).toBe(false);
  });

  it('o evento reenfileirado e reprocessado quando a busca volta a funcionar', async () => {
    await publicarBase();
    await semearToken();
    const primeira = instalarWaitUntil();
    const espiao = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('erro', { status: 500 }));

    await chamar({ query: { k: SEGREDO }, body: corpo({ _id: 'falha' }) });
    await Promise.all(primeira);
    expect(await tamanhoFila(cache)).toBe(1);

    // O ML volta. Uma notificacao nova (ou o job de fallback) drena a fila
    // inteira — inclusive o evento que tinha falhado.
    espiao.mockResolvedValue(respostaDoPedido());
    const segunda = instalarWaitUntil();
    await chamar({ query: { k: SEGREDO }, body: corpo({ _id: 'retorno' }) });
    await Promise.all(segunda);

    expect(await tamanhoFila(cache)).toBe(0);
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap.filter(o => String(o.id) === '2000012345')).toHaveLength(1);
  });

  it('lock ocupado PRESERVA o evento e nao chama o Mercado Livre', async () => {
    await publicarBase();
    await semearToken();
    const agendados = instalarWaitUntil();
    const espiao = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDoPedido());
    // Uma reconciliacao esta publicando agora.
    await cache.setNX(ORDERS_SYNC_LOCK_KEY, 'sincronizacao-em-andamento', 120);

    const res = await chamar({ query: { k: SEGREDO }, body: corpo() });
    await Promise.all(agendados);

    expect(res.statusCode).toBe(200);
    expect(await tamanhoFila(cache)).toBe(1);   // preservado
    expect(espiao).not.toHaveBeenCalled();
    // E o lock da sincronizacao continua com o dono dela.
    expect(await cache.get(ORDERS_SYNC_LOCK_KEY)).toBe('sincronizacao-em-andamento');
  });

  it('liberado o lock, o proximo dreno aplica o evento que ficou esperando', async () => {
    await publicarBase();
    await semearToken();
    const bloqueado = instalarWaitUntil();
    const espiao = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDoPedido());
    await cache.setNX(ORDERS_SYNC_LOCK_KEY, 'dona', 120);

    await chamar({ query: { k: SEGREDO }, body: corpo({ _id: 'travado' }) });
    await Promise.all(bloqueado);
    expect(await tamanhoFila(cache)).toBe(1);

    await cache.del(ORDERS_SYNC_LOCK_KEY);
    const livre = instalarWaitUntil();
    await chamar({ query: { k: SEGREDO }, body: corpo({ _id: 'depois' }) });
    await Promise.all(livre);

    expect(await tamanhoFila(cache)).toBe(0);
    expect(espiao).toHaveBeenCalled();
    expect((await readSnapshot(cache, 'ativos')).some(o => String(o.id) === '2000012345')).toBe(true);
  });

  it('varios eventos do mesmo pedido colapsam numa unica busca', async () => {
    await publicarBase();
    await semearToken();
    const espiao = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDoPedido());

    // Tres notificacoes chegam antes de qualquer dreno rodar (sem waitUntil).
    removerWaitUntil();
    for (const id of ['a', 'b', 'c']) await chamar({ query: { k: SEGREDO }, body: corpo({ _id: id }) });
    expect(await tamanhoFila(cache)).toBe(3);
    expect(espiao).not.toHaveBeenCalled();

    // O primeiro dreno com waitUntil resolve as tres com UMA chamada.
    const agendados = instalarWaitUntil();
    await chamar({ query: { k: SEGREDO }, body: corpo({ _id: 'd' }) });
    await Promise.all(agendados);

    expect(espiao.mock.calls).toHaveLength(1);
    expect(await tamanhoFila(cache)).toBe(0);
  });
});
