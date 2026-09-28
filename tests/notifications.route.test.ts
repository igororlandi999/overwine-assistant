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

/**
 * Este arquivo cobre o CONTRATO HTTP da callback: autenticacao, os 200 de
 * protocolo, a telemetria do recebimento. Nada aqui e sobre o dreno.
 *
 * Por isso o dreno e neutralizado. Com o `waitUntil` publico da Vercel o
 * trabalho de fundo COMECA sempre (a API recebe uma promessa, nao uma
 * fabrica), entao sem esta dupla de mocks cada teste de protocolo dispararia
 * um dreno de verdade — disputando lock, mexendo na fila e tornando as
 * asercoes dependentes de corrida.
 *
 * O dreno de verdade, ligado ao `waitUntil` de verdade, e exercitado em
 * tests/notifications.background.test.ts. Nenhum dos dois arquivos e o
 * suficiente sozinho; juntos cobrem a rota inteira.
 */
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../src/services/orders-webhook.service.js', async importarReal => {
  const real = await importarReal<typeof import('../src/services/orders-webhook.service.js')>();
  return { ...real, drenarFila: vi.fn(async () => ({
    ok: true, processados: 0, novos: 0, atualizados: 0, semMudanca: 0,
    falhas: 0, restantes: 0,
  })) };
});
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

function mockReq(o: Partial<{ method: string; headers: Record<string, unknown>; query: Record<string, unknown>; body: unknown; url: string }> = {}) {
  return { method: 'POST', headers: {}, query: {}, body: undefined, url: '/api/notifications/ml', ...o } as any;
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

  /**
   * Em setembro/2026 o Mercado Livre entregou dezenas de notificações por
   * hora com um segredo que não batia — e o status mostrava `recebidas: 0`,
   * sem nada apontando para a causa. A recusa por segredo agora fica visível
   * em `tempoReal.ultimoMotivoRejeicao`, sem gravar o segredo tentado.
   */
  it('segredo errado fica visível na telemetria como segredo_invalido, sem o valor tentado', async () => {
    await chamar({ query: { k: 'segredo-errado-de-atacante' }, body: corpo() });
    const obs = await lerObsRecebimento(cache);
    expect(obs.totalRejeitadas).toBe(1);
    expect(obs.ultimoMotivoRejeicao).toBe('segredo_invalido');
    expect(obs.ultimaRejeicaoEm).not.toBeNull();
    expect(obs.totalRecebidas).toBe(0);
    expect(JSON.stringify(obs)).not.toContain('segredo-errado-de-atacante');
  });

  /**
   * O painel do Mercado Livre recusa callback com query string ("O endereço
   * deve ser válido"), então o segredo precisa poder viajar no path:
   * /api/notifications/ml/<segredo>. É o MESMO ML_WEBHOOK_SECRET, a mesma
   * comparação em tempo constante, e nada muda depois da autenticação.
   */
  it('segredo no PATH (forma do painel do ML) passa pela autenticação e enfileira', async () => {
    const res = await chamar({ url: `/api/notifications/ml/${SEGREDO}`, query: {}, body: corpo() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await tamanhoFila(cache)).toBe(1);
  });

  it('segredo no PATH com tópico irrelevante: 200 ignorada — o smoke de produção', async () => {
    const res = await chamar({ url: `/api/notifications/ml/${SEGREDO}`, query: {}, body: corpo({ topic: 'items', resource: '/items/MLB1' }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, ignorada: true });
    expect(await tamanhoFila(cache)).toBe(0);
  });

  it('segredo errado no PATH é 401 e NÃO enfileira', async () => {
    const res = await chamar({ url: '/api/notifications/ml/segredo-errado-no-path', query: {}, body: corpo() });
    expect(res.statusCode).toBe(401);
    expect(await tamanhoFila(cache)).toBe(0);
  });

  it('PATH com o segredo certo mais lixo depois (subcaminho) é 401', async () => {
    const res = await chamar({ url: `/api/notifications/ml/${SEGREDO}x`, query: {}, body: corpo() });
    expect(res.statusCode).toBe(401);
  });

  it('a query ?k= antiga continua funcionando, e tem precedência sobre o path', async () => {
    const res = await chamar({ url: '/api/notifications/ml/qualquer-coisa', query: { k: SEGREDO }, body: corpo() });
    expect(res.statusCode).toBe(200);
    expect(await tamanhoFila(cache)).toBe(1);
  });

  it('o rewrite do path para query está declarado em vercel.json, sem função nova', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const cfg = JSON.parse(readFileSync('vercel.json', 'utf8')) as { rewrites?: { source: string; destination: string }[] };
    expect(cfg.rewrites).toContainEqual({ source: '/api/notifications/ml/:k', destination: '/api/notifications/ml?k=:k' });
    // Plano gratuito: 12 funções por deploy. Contamos os arquivos de rota.
    const contar = (dir: string): number => readdirSync(dir).reduce((n, f) => {
      const p = `${dir}/${f}`;
      return n + (statSync(p).isDirectory() ? contar(p) : (f.endsWith('.ts') ? 1 : 0));
    }, 0);
    expect(contar('api')).toBeLessThanOrEqual(12);
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

  /**
   * Regressao encontrada no smoke test do Preview, nao aqui: com
   * Content-Type: application/json e corpo invalido, o helper do @vercel/node
   * LANCA na primeira leitura de req.body — antes de qualquer linha nossa. O
   * resultado era HTTP 500, e 500 e a unica resposta que faz o Mercado Livre
   * reenviar para sempre.
   *
   * O mock deste arquivo entrega a string crua e nunca passa pelo parser da
   * plataforma, entao o teste antigo nao podia pegar. Este reproduz o
   * comportamento real: a propriedade `body` lanca ao ser lida.
   */
  it('req.body que LANCA ao ser lido ainda responde 200', async () => {
    const req = mockReq({ query: { k: SEGREDO } });
    Object.defineProperty(req, 'body', {
      get() { throw new SyntaxError('Unexpected token i in JSON at position 0'); },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.json().ignorada).toBe(true);
    expect(await tamanhoFila(cache)).toBe(0);
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

  it('o segredo no PATH NAO vai para o log, certo ou errado', async () => {
    const linhas: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { linhas.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'info').mockImplementation((...a: unknown[]) => { linhas.push(a.map(String).join(' ')); });
    await chamar({ url: `/api/notifications/ml/${SEGREDO}`, query: {}, body: corpo() });
    await chamar({ url: '/api/notifications/ml/segredo-errado-no-path-abc', query: {}, body: corpo() });
    const tudo = linhas.join('\n');
    expect(tudo).not.toContain(SEGREDO);
    expect(tudo).not.toContain('segredo-errado-no-path-abc');
    const gravado = (cache.store.get(CHAVE_OBS_NOTIF)?.v ?? '') + (cache.store.get(CHAVE_OBS_PROC)?.v ?? '');
    expect(gravado).not.toContain(SEGREDO);
    expect(gravado).not.toContain('segredo-errado-no-path-abc');
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
  it('o ack so enfileira: nada de manifesto publicado nem pedido buscado', async () => {
    await chamar({ query: { k: SEGREDO }, body: corpo() });
    expect(await tamanhoFila(cache)).toBe(1);
    expect(cache.store.get('orders:manifest')).toBeUndefined();
  });

  it('o ack registra QUANDO pediu o dreno de fundo', async () => {
    // Par pedimos/terminou: este e o "pedimos". O "terminou" e ultimoDrenoEm,
    // no outro blob. Divergencia entre os dois com fila pendente significa que
    // o trabalho de fundo nao esta sobrevivendo a resposta.
    await chamar({ query: { k: SEGREDO }, body: corpo() });
    expect((await lerObsRecebimento(cache)).ultimoDrenoPedidoEm).toBeTypeOf('string');
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
