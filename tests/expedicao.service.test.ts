import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import {
  consultarEnvios, extrairDespacho, extrairPrazo, extrairEnvio, diaDoCampo, normalizarIds,
  eventoEhDespacho, CHAVE_COOLDOWN, TTL_PENDENTE_S, MAX_IDS,
  TTL_INCOMPLETO_S, TTL_FINAL_S, ttlDoResultado,
  type FetchersEnvio, type RespostaML,
} from '../src/services/expedicao.service.js';
import { runOp } from '../src/ml/ops.js';
import { resetEnvForTests } from '../src/config/env.js';

// ── ML simulado ─────────────────────────────────────────────────────────
// Formatos baseados na documentação "Shipment handling" do Mercado Livre.
// NÃO são respostas reais capturadas — ver o relatório da etapa.

interface EnvioSim {
  envio?: RespostaML | (() => Promise<RespostaML>);
  prazo?: RespostaML;
  historico?: RespostaML;
}

function ml(sim: Record<string, EnvioSim>) {
  const chamadas: string[] = [];
  const ok = (data: unknown): RespostaML => ({ status: 200, data });
  const f: FetchersEnvio = {
    async envio(id) {
      chamadas.push(`envio:${id}`);
      const e = sim[id]?.envio;
      if (typeof e === 'function') return e();
      return e ?? { status: 404, data: { message: 'not_found' } };
    },
    async prazo(id) { chamadas.push(`prazo:${id}`); return sim[id]?.prazo ?? ok({}); },
    async historico(id) { chamadas.push(`hist:${id}`); return sim[id]?.historico ?? ok([]); },
  };
  return { f, chamadas };
}

const ok = (data: unknown): RespostaML => ({ status: 200, data });
const envio = (status: string, substatus: string | null, logistic_type = 'xd_drop_off', extra: object = {}) =>
  ok({
    id: 1, status, substatus, logistic_type,
    // Campos que o ML devolve e que NUNCA podem sair do backend:
    receiver_address: { street_name: 'Rua Secreta', zip_code: '01234-000', receiver_name: 'Fulano' },
    ...extra,
  });
const prazo = (date: string | null) => ok({ estimated_handling_limit: { date }, type: 'drop_off' });
const hist = (...ev: Array<[string, string | null, string | null]>) =>
  ok(ev.map(([status, substatus, date]) => ({ status, substatus, date })));

let cache: FakeCache;
beforeEach(() => { cache = new FakeCache(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// ── Extração ────────────────────────────────────────────────────────────

describe('datas do Mercado Livre', () => {
  it('usa a data escrita pelo ML, não o instante convertido', () => {
    expect(diaDoCampo('2026-10-20T00:00:00.000-03:00')).toBe('2026-10-20');
    // Convertido para Brasília, 00:00Z seria 19/10 às 21h. Só a data importa.
    expect(diaDoCampo('2026-10-20T00:00:00.000Z')).toBe('2026-10-20');
    expect(diaDoCampo('2026-10-20')).toBe('2026-10-20');
  });

  it('data ausente ou inválida é null, nunca zero nem data inventada', () => {
    for (const v of [null, undefined, '', '   ', 0, 'amanhã', '2026-02-30T00:00:00Z', {}]) {
      expect(diaDoCampo(v)).toBeNull();
    }
    expect(extrairPrazo({})).toBeNull();
    expect(extrairPrazo({ estimated_handling_limit: null })).toBeNull();
    expect(extrairPrazo({ estimated_handling_limit: { date: null } })).toBeNull();
    expect(extrairPrazo(null)).toBeNull();
  });

  it('prazo no próprio envio: lead_time (formato novo) antes de shipping_option', () => {
    const d = extrairEnvio({
      status: 'ready_to_ship',
      lead_time: { estimated_handling_limit: { date: '2026-10-21T00:00:00.000-03:00' } },
      shipping_option: { estimated_handling_limit: { date: '2026-10-25T00:00:00.000-03:00' } },
    });
    expect(d?.prazoNoEnvio).toBe('2026-10-21');
    expect(extrairEnvio({ status: 'x', shipping_option: { estimated_handling_limit: { date: '2026-10-25T00:00:00-03:00' } } })?.prazoNoEnvio)
      .toBe('2026-10-25');
  });
});

describe('o que conta como despacho', () => {
  it('etiqueta gerada, impressa, preparação e pagamento NÃO são despacho', () => {
    expect(eventoEhDespacho('ready_to_ship', 'ready_to_print')).toBe(false);
    expect(eventoEhDespacho('ready_to_ship', 'printed')).toBe(false);
    expect(eventoEhDespacho('ready_to_ship', null)).toBe(false);
    expect(eventoEhDespacho('handling', null)).toBe(false);
    expect(eventoEhDespacho('pending', 'buffered')).toBe(false);
    expect(eventoEhDespacho('paid', null)).toBe(false);
    expect(eventoEhDespacho(undefined, undefined)).toBe(false);
  });

  it('agência, coleta, transportadora e trânsito são despacho', () => {
    expect(eventoEhDespacho('ready_to_ship', 'dropped_off')).toBe(true);
    expect(eventoEhDespacho('ready_to_ship', 'picked_up')).toBe(true);
    expect(eventoEhDespacho('ready_to_ship', 'authorized_by_carrier')).toBe(true);
    expect(eventoEhDespacho('shipped', 'in_transit')).toBe(true);
    expect(eventoEhDespacho('delivered', null)).toBe(true);
  });

  it('a data é a do PRIMEIRO evento qualificado, ignorando os demais', () => {
    const h = [
      { status: 'shipped', substatus: 'in_transit', date: '2026-10-20T18:00:00.000-03:00' },
      { status: 'ready_to_ship', substatus: 'printed', date: '2026-10-19T09:00:00.000-03:00' },
      { status: 'ready_to_ship', substatus: 'dropped_off', date: '2026-10-19T16:30:00.000-03:00' },
      { status: 'shipped', substatus: null, date: 'data-quebrada' },
    ];
    expect(extrairDespacho(h)).toBe('2026-10-19T16:30:00.000-03:00');
    expect(extrairDespacho({ data: h })).toBe('2026-10-19T16:30:00.000-03:00');
    expect(extrairDespacho({ results: h })).toBe('2026-10-19T16:30:00.000-03:00');
  });

  it('histórico sem evento datado de despacho devolve null', () => {
    expect(extrairDespacho([{ status: 'ready_to_ship', substatus: 'printed', date: '2026-10-19T09:00:00Z' }])).toBeNull();
    expect(extrairDespacho([{ status: 'shipped', substatus: null, date: null }])).toBeNull();
    expect(extrairDespacho({ algo: 1 })).toBeNull();
    expect(extrairDespacho(null)).toBeNull();
  });
});

// ── Classificação ───────────────────────────────────────────────────────

describe('consultarEnvios — situações', () => {
  it('pendente com etiqueta impressa: prazo oficial, sem histórico', async () => {
    const { f, chamadas } = ml({
      '40001': { envio: envio('ready_to_ship', 'printed'), prazo: prazo('2026-10-19T00:00:00.000-03:00') },
    });
    const r = await consultarEnvios(cache, ['40001'], f);
    expect(r.envios[0]).toMatchObject({
      id: '40001', situacao: 'pendente', status: 'ready_to_ship', substatus: 'printed',
      prazoPostagem: '2026-10-19', despachadoEm: null,
    });
    expect(chamadas).toEqual(['envio:40001', 'prazo:40001']); // histórico não é pedido
  });

  it('deixado na agência: despachado com a data do histórico', async () => {
    const { f } = ml({
      '40002': {
        envio: envio('ready_to_ship', 'dropped_off'),
        prazo: prazo('2026-10-20T00:00:00.000-03:00'),
        historico: hist(['ready_to_ship', 'printed', '2026-10-19T10:00:00.000-03:00'],
                        ['ready_to_ship', 'dropped_off', '2026-10-19T15:12:00.000-03:00']),
      },
    });
    const [e] = (await consultarEnvios(cache, ['40002'], f)).envios;
    expect(e.situacao).toBe('despachado');
    expect(e.despachadoEm).toBe('2026-10-19T15:12:00.000-03:00');
    expect(e.prazoPostagem).toBe('2026-10-20'); // despachado ANTES do prazo continua com o prazo
  });

  it('despachado sem data em lugar nenhum: despachado, data null, com aviso', async () => {
    const { f } = ml({
      '40003': { envio: envio('shipped', 'in_transit'), prazo: prazo(null), historico: ok([]) },
    });
    const [e] = (await consultarEnvios(cache, ['40003'], f)).envios;
    expect(e.situacao).toBe('despachado');
    expect(e.despachadoEm).toBeNull();
    expect(e.prazoPostagem).toBeNull();
    expect(e.avisos).toEqual(expect.arrayContaining(['data_despacho_nao_informada', 'prazo_nao_informado']));
  });

  it('histórico falhou: usa status_history.date_shipped do envio, marcado', async () => {
    const { f } = ml({
      '40004': {
        envio: envio('shipped', null, 'cross_docking', { status_history: { date_shipped: '2026-10-18T11:00:00.000-03:00' } }),
        prazo: prazo('2026-10-18T00:00:00.000-03:00'),
        historico: { status: 500, data: null },
      },
    });
    const [e] = (await consultarEnvios(cache, ['40004'], f)).envios;
    expect(e.despachadoEm).toBe('2026-10-18T11:00:00.000-03:00');
    expect(e.avisos).toEqual(expect.arrayContaining(['history_http_500', 'data_do_envio']));
  });

  it('lead_time indisponível: cai para o prazo do próprio envio, marcado', async () => {
    const { f } = ml({
      '40005': {
        envio: envio('ready_to_ship', 'ready_to_print', 'xd_drop_off', {
          shipping_option: { estimated_handling_limit: { date: '2026-10-22T00:00:00.000-03:00' } },
        }),
        prazo: { status: 404, data: { message: 'not_found' } },
      },
    });
    const [e] = (await consultarEnvios(cache, ['40005'], f)).envios;
    expect(e.prazoPostagem).toBe('2026-10-22');
    expect(e.avisos).toEqual(expect.arrayContaining(['lead_time_http_404', 'prazo_do_envio']));
  });

  it('Full para na primeira chamada e sai como full', async () => {
    const { f, chamadas } = ml({ '40006': { envio: envio('ready_to_ship', 'in_warehouse', 'fulfillment') } });
    const [e] = (await consultarEnvios(cache, ['40006'], f)).envios;
    expect(e.situacao).toBe('full');
    expect(chamadas).toEqual(['envio:40006']);
  });

  it('envio cancelado é cancelado, sem prazo nem histórico', async () => {
    const { f, chamadas } = ml({ '40007': { envio: envio('cancelled', null) } });
    const [e] = (await consultarEnvios(cache, ['40007'], f)).envios;
    expect(e.situacao).toBe('cancelado');
    expect(chamadas).toEqual(['envio:40007']);
  });
});

// ── Falhas de API ───────────────────────────────────────────────────────

describe('consultarEnvios — falhas do Mercado Livre', () => {
  it('envio 500 ou exceção: indisponível, NÃO cacheado, os outros seguem', async () => {
    const { f, chamadas } = ml({
      '50001': { envio: { status: 500, data: null } },
      '50002': { envio: () => Promise.reject(new Error('ECONNRESET')) },
      '50003': { envio: envio('ready_to_ship', 'printed'), prazo: prazo('2026-10-19T00:00:00-03:00') },
    });
    const r = await consultarEnvios(cache, ['50001', '50002', '50003'], f);
    expect(r.envios.map(e => e.situacao)).toEqual(['indisponivel', 'indisponivel', 'pendente']);
    // Próxima passada tenta de novo os que falharam, e só eles.
    chamadas.length = 0;
    await consultarEnvios(cache, ['50001', '50002', '50003'], f);
    expect(chamadas.filter(c => c.startsWith('envio:'))).toEqual(['envio:50001', 'envio:50002']);
  });

  it('status desconhecido não vira pendente (nem atraso falso): sai como outro', async () => {
    const { f, chamadas } = ml({ '50009': { envio: envio('to_be_agreed', null) } });
    const [e] = (await consultarEnvios(cache, ['50009'], f)).envios;
    expect(e.situacao).toBe('outro');
    expect(e.prazoPostagem).toBeNull();
    expect(e.avisos).toEqual(['status_nao_mapeado:to_be_agreed']);
    expect(chamadas).toEqual(['envio:50009']);
  });

  it('envio sem status utilizável é indisponível, não pendente', async () => {
    const { f } = ml({ '50004': { envio: ok({ id: 50004 }) } });
    const [e] = (await consultarEnvios(cache, ['50004'], f)).envios;
    expect(e.situacao).toBe('indisponivel');
    expect(e.avisos).toContain('envio_sem_status');
  });

  it('429 abre cooldown global: nada mais sai ao ML, o resto fica aguardando', async () => {
    const { f, chamadas } = ml({
      '50005': { envio: { status: 429, data: { message: 'too_many_requests' } } },
      '50006': { envio: envio('ready_to_ship', 'printed') },
      '50007': { envio: envio('ready_to_ship', 'printed') },
    });
    const r = await consultarEnvios(cache, ['50005', '50006', '50007'], f, { concorrencia: 1 });
    expect(r.cooldown).toBe(true);
    expect(r.envios.every(e => e.situacao === 'aguardando')).toBe(true);
    expect(chamadas).toEqual(['envio:50005']);
    expect(await cache.get(CHAVE_COOLDOWN)).not.toBeNull();

    // Outra requisição (outra aba, outra instância) dentro da janela: zero chamadas.
    chamadas.length = 0;
    const r2 = await consultarEnvios(cache, ['50006'], f);
    expect(chamadas).toEqual([]);
    expect(r2.envios[0].situacao).toBe('aguardando');
    expect(r2.cooldown).toBe(true);
  });

  it('cooldown não esconde o que já está em cache', async () => {
    const { f } = ml({ '50008': { envio: envio('delivered', null), historico: hist(['shipped', null, '2026-10-17T12:00:00-03:00']) } });
    await consultarEnvios(cache, ['50008'], f);
    await cache.set(CHAVE_COOLDOWN, '1', 60);
    const [e] = (await consultarEnvios(cache, ['50008'], f)).envios;
    expect(e.situacao).toBe('despachado');
    expect(e.despachadoEm).toBe('2026-10-17T12:00:00-03:00');
  });

  it('teto de chamadas: o excedente fica aguardando para a próxima passada', async () => {
    const sim: Record<string, EnvioSim> = {};
    const ids = ['60001', '60002', '60003', '60004'];
    for (const id of ids) sim[id] = { envio: envio('ready_to_ship', 'printed'), prazo: prazo('2026-10-19T00:00:00-03:00') };
    const { f } = ml(sim);
    const r = await consultarEnvios(cache, ids, f, { maxChamadas: 4, concorrencia: 1 });
    expect(r.chamadasML).toBe(4);
    expect(r.envios.map(e => e.situacao)).toEqual(['pendente', 'pendente', 'aguardando', 'aguardando']);
    expect(r.aguardando).toBe(2);
    // A passada seguinte completa só os que faltavam.
    const r2 = await consultarEnvios(cache, ids, f, { maxChamadas: 4, concorrencia: 1 });
    expect(r2.envios.every(e => e.situacao === 'pendente')).toBe(true);
    expect(r2.chamadasML).toBe(4);
  });
});

// ── Cache incremental ───────────────────────────────────────────────────

describe('consultarEnvios — incremental', () => {
  it('despachado é final: a segunda consulta não toca no ML', async () => {
    const { f, chamadas } = ml({
      '70001': { envio: envio('ready_to_ship', 'picked_up', 'cross_docking'), historico: hist(['ready_to_ship', 'picked_up', '2026-10-19T14:00:00-03:00']) },
    });
    await consultarEnvios(cache, ['70001'], f);
    chamadas.length = 0;
    const r = await consultarEnvios(cache, ['70001'], f);
    expect(chamadas).toEqual([]);
    expect(r.chamadasML).toBe(0);
    expect(r.envios[0].despachadoEm).toBe('2026-10-19T14:00:00-03:00');
  });

  it('pendente: cache curto; ao vencer custa 1 chamada (prazo segue em cache)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T12:00:00-03:00'));
    const { f, chamadas } = ml({
      '70002': { envio: envio('ready_to_ship', 'printed'), prazo: prazo('2026-10-19T00:00:00-03:00') },
    });
    await consultarEnvios(cache, ['70002'], f);
    expect(chamadas).toEqual(['envio:70002', 'prazo:70002']);

    chamadas.length = 0;
    await consultarEnvios(cache, ['70002'], f);
    expect(chamadas).toEqual([]); // dentro do TTL

    vi.setSystemTime(Date.now() + (TTL_PENDENTE_S + 1) * 1000);
    chamadas.length = 0;
    const [e] = (await consultarEnvios(cache, ['70002'], f)).envios;
    expect(chamadas).toEqual(['envio:70002']);
    expect(e.prazoPostagem).toBe('2026-10-19');
  });

  it('pendente que foi despachado entre passadas vira despachado', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T09:00:00-03:00'));
    const sim: Record<string, EnvioSim> = {
      '70003': { envio: envio('ready_to_ship', 'printed'), prazo: prazo('2026-10-19T00:00:00-03:00') },
    };
    const { f } = ml(sim);
    expect((await consultarEnvios(cache, ['70003'], f)).envios[0].situacao).toBe('pendente');

    sim['70003'].envio = envio('ready_to_ship', 'dropped_off');
    sim['70003'].historico = hist(['ready_to_ship', 'dropped_off', '2026-10-19T09:01:30-03:00']);
    vi.setSystemTime(Date.now() + (TTL_PENDENTE_S + 1) * 1000);
    const [e] = (await consultarEnvios(cache, ['70003'], f)).envios;
    expect(e.situacao).toBe('despachado');
    expect(e.despachadoEm).toBe('2026-10-19T09:01:30-03:00');
  });

  it('tudo em cache: UM comando ao Redis (MGET) e zero chamadas ao ML', async () => {
    const { f, chamadas } = ml({
      '70010': { envio: envio('cancelled', null) },
      '70011': { envio: envio('shipped', 'in_transit', 'fulfillment') },
    });
    await consultarEnvios(cache, ['70010', '70011'], f);
    chamadas.length = 0;
    const mget = vi.spyOn(cache, 'mget');
    const get = vi.spyOn(cache, 'get');
    const set = vi.spyOn(cache, 'set');
    const r = await consultarEnvios(cache, ['70010', '70011'], f);
    expect(mget).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(chamadas).toEqual([]);
    expect(r.envios.map(e => e.situacao)).toEqual(['cancelado', 'full']);
  });

  it('despachado SEM data não é final: volta a consultar e recupera a data depois', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T10:00:00-03:00'));
    const sim: Record<string, EnvioSim> = {
      '70005': { envio: envio('ready_to_ship', 'dropped_off'), historico: { status: 500, data: null } },
    };
    const { f, chamadas } = ml(sim);
    const [a] = (await consultarEnvios(cache, ['70005'], f)).envios;
    expect(a.situacao).toBe('despachado');
    expect(a.despachadoEm).toBeNull();

    // Antes do TTL incompleto: cache. Depois: nova leitura, agora com data.
    vi.setSystemTime(Date.now() + (TTL_PENDENTE_S + 1) * 1000);
    chamadas.length = 0;
    await consultarEnvios(cache, ['70005'], f);
    expect(chamadas).toEqual([]);

    sim['70005'].historico = hist(['ready_to_ship', 'dropped_off', '2026-10-19T09:40:00-03:00']);
    vi.setSystemTime(Date.now() + (TTL_INCOMPLETO_S + 1) * 1000);
    const [b] = (await consultarEnvios(cache, ['70005'], f)).envios;
    expect(b.despachadoEm).toBe('2026-10-19T09:40:00-03:00');
    expect(ttlDoResultado(b)).toBe(TTL_FINAL_S);
  });

  it('lead_time 200 sem prazo: ausência cacheada por 5 min; HTTP de erro não é cacheado', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T10:00:00-03:00'));
    const sim: Record<string, EnvioSim> = {
      '70006': { envio: envio('ready_to_ship', 'printed'), prazo: prazo(null) },
      '70007': { envio: envio('ready_to_ship', 'printed'), prazo: { status: 503, data: null } },
    };
    const { f, chamadas } = ml(sim);
    await consultarEnvios(cache, ['70006', '70007'], f);
    vi.setSystemTime(Date.now() + (TTL_PENDENTE_S + 1) * 1000);
    chamadas.length = 0;
    await consultarEnvios(cache, ['70006', '70007'], f);
    expect(chamadas.sort()).toEqual(['envio:70006', 'envio:70007', 'prazo:70007']);
  });

  it('cache é por conta: o mesmo id em outra conta não reaproveita', async () => {
    // A rota passa cacheDaConta(cache, conta); aqui simulamos dois prefixos.
    const { f, chamadas } = ml({ '70004': { envio: envio('cancelled', null) } });
    const conta = (p: string) => ({
      get: (k: string) => cache.get(p + k), set: (k: string, v: string, t?: number) => cache.set(p + k, v, t),
      del: (k: string) => cache.del(p + k), setNX: (k: string, v: string, t: number) => cache.setNX(p + k, v, t),
      delIfEquals: (k: string, v: string) => cache.delIfEquals(p + k, v), incr: (k: string, t: number) => cache.incr(p + k, t),
      mget: (ks: string[]) => cache.mget(ks.map(k => p + k)),
      rpush: (k: string, ...v: string[]) => cache.rpush(p + k, ...v), lpopMany: (k: string, m: number) => cache.lpopMany(p + k, m),
      llen: (k: string) => cache.llen(p + k),
    });
    await consultarEnvios(conta(''), ['70004'], f);
    await consultarEnvios(conta('c:degustar-ml:'), ['70004'], f);
    expect(chamadas).toEqual(['envio:70004', 'envio:70004']);
  });
});

// ── Pedidos agrupados e entrada ─────────────────────────────────────────

describe('pedidos agrupados e ids', () => {
  it('ids repetidos (pedidos do mesmo pacote) viram UMA consulta e UMA linha', async () => {
    const ids = normalizarIds('80001, 80001,80002,80001');
    expect(ids).toEqual(['80001', '80002']);
    const { f, chamadas } = ml({
      '80001': { envio: envio('cancelled', null) },
      '80002': { envio: envio('cancelled', null) },
    });
    const r = await consultarEnvios(cache, ids!, f);
    expect(r.envios).toHaveLength(2);
    expect(chamadas.filter(c => c === 'envio:80001')).toHaveLength(1);
  });

  it('rejeita lista vazia, id não numérico e mais de MAX_IDS', () => {
    expect(normalizarIds('')).toBeNull();
    expect(normalizarIds(' , ')).toBeNull();
    expect(normalizarIds('123')).toBeNull(); // curto demais para id de envio
    expect(normalizarIds('80001,../orders')).toBeNull();
    expect(normalizarIds(undefined)).toBeNull();
    const muitos = Array.from({ length: MAX_IDS + 1 }, (_, i) => String(90000 + i)).join(',');
    expect(normalizarIds(muitos)).toBeNull();
  });
});

// ── Dados pessoais ──────────────────────────────────────────────────────

describe('privacidade', () => {
  it('nenhum endereço, nome ou dado de comprador sai da consulta', async () => {
    const { f } = ml({
      '85001': {
        envio: envio('ready_to_ship', 'dropped_off', 'xd_drop_off', { buyer_info: { nickname: 'COMPRADOR' } }),
        prazo: ok({ estimated_handling_limit: { date: '2026-10-19T00:00:00-03:00' }, receiver: { name: 'Fulano' } }),
        historico: ok([{ status: 'ready_to_ship', substatus: 'dropped_off', date: '2026-10-19T10:00:00-03:00', agency: { address: 'Rua Y' } }]),
      },
    });
    const r = await consultarEnvios(cache, ['85001'], f);
    const saida = JSON.stringify(r);
    for (const proibido of ['Rua Secreta', 'zip_code', 'Fulano', 'COMPRADOR', 'Rua Y', 'receiver']) {
      expect(saida).not.toContain(proibido);
    }
    expect(Object.keys(r.envios[0]).sort()).toEqual([
      'avisos', 'consultadoEm', 'despachadoEm', 'id', 'logistica', 'prazoPostagem', 'situacao', 'status', 'substatus',
    ]);
    // E o que fica no Redis também não carrega dado pessoal.
    expect(JSON.stringify([...cache.store.values()])).not.toContain('Rua Secreta');
  });
});

// ── Pela allowlist do proxy ─────────────────────────────────────────────

describe('op expedicao-envios (proxy)', () => {
  beforeEach(async () => {
    Object.assign(process.env, TEST_ENV);
    resetEnvForTests();
    await cache.set('ml:access_token', JSON.stringify({ token: 'AT-teste', expiresAt: Date.now() + 3600_000 }));
  });

  it('valida ids antes de qualquer chamada', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    for (const ids of ['', 'abc', '1,2', '12345,/orders/1']) {
      const r = await runOp(cache, 'expedicao-envios', { ids }, TEST_ENV.ML_USER_ID);
      expect(r.status, ids).toBe(400);
    }
    expect((await runOp(cache, 'expedicao-envios', {}, TEST_ENV.ML_USER_ID)).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('chama as três rotas oficiais com Bearer e devolve o formato da aba', async () => {
    const respostas: Record<string, unknown> = {
      'https://api.mercadolibre.com/shipments/44445555': { status: 'ready_to_ship', substatus: 'dropped_off', logistic_type: 'xd_drop_off' },
      'https://api.mercadolibre.com/shipments/44445555/lead_time': { estimated_handling_limit: { date: '2026-10-19T00:00:00.000-03:00' } },
      'https://api.mercadolibre.com/shipments/44445555/history': [{ status: 'ready_to_ship', substatus: 'dropped_off', date: '2026-10-19T13:00:00.000-03:00' }],
    };
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      new Response(JSON.stringify(respostas[String(url)] ?? {}), { status: respostas[String(url)] ? 200 : 404 }) as unknown as Response);
    const r = await runOp(cache, 'expedicao-envios', { ids: '44445555' }, TEST_ENV.ML_USER_ID);
    expect(r.status).toBe(200);
    const d = r.data as { ok: boolean; envios: Array<Record<string, unknown>>; chamadasML: number };
    expect(d.ok).toBe(true);
    expect(d.chamadasML).toBe(3);
    expect(d.envios[0]).toMatchObject({ situacao: 'despachado', prazoPostagem: '2026-10-19', despachadoEm: '2026-10-19T13:00:00.000-03:00' });
    const urls = spy.mock.calls.map(c => String(c[0])).sort();
    expect(urls).toEqual(Object.keys(respostas).sort());
    for (const [url, init] of spy.mock.calls) {
      expect(String(url)).not.toContain('access_token');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer AT-teste');
    }
  });
});
