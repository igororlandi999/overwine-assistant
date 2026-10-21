import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import {
  consultarEnvios, extrairDespacho, extrairPrazo, extrairLimite, interpretarAtrasos, prazoVencido, extrairEnvio, diaDoCampo, normalizarIds,
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
  atrasos?: RespostaML;
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
    async atrasos(id) { chamadas.push(`atraso:${id}`); return sim[id]?.atrasos ?? { status: 404, data: { message: 'Delays Not Found for shipment' } }; },
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
// Formato de GET /shipments/{id}/sla: expected_date = prazo máximo de despacho.
const prazo = (date: string | null) => ok({ status: 'on_time', expected_date: date, service: 1, last_updated: '2026-10-21T10:00:00.000-03:00' });
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

describe('prazo do /sla (expected_date)', () => {
  it('meia-noite é data pura; instante limite vale o dia em Brasília', () => {
    expect(extrairPrazo({ expected_date: '2026-10-22T00:00:00.000-03:00' })).toBe('2026-10-22');
    expect(extrairPrazo({ expected_date: '2026-10-22T00:00:00.000Z' })).toBe('2026-10-22');
    expect(extrairPrazo({ expected_date: '2026-10-22T23:59:59.000-03:00' })).toBe('2026-10-22');
    // 02:59:59 UTC de 23/10 = 23:59:59 de 22/10 em Brasília
    expect(extrairPrazo({ expected_date: '2026-10-23T02:59:59.000Z' })).toBe('2026-10-22');
    expect(extrairPrazo({ data: { expected_date: '2026-10-24T18:00:00.000-03:00' } })).toBe('2026-10-24');
  });

  it('sem expected_date, data inválida ou corpo estranho: null, nunca data inventada', () => {
    for (const d of [{}, { expected_date: null }, { expected_date: 'amanhã' }, null, [], { status: 'on_time' }]) {
      expect(extrairPrazo(d)).toBeNull();
    }
  });

  it('status do SLA é guardado cru e não muda a classificação', async () => {
    const { f } = ml({ '60001': { envio: envio('ready_to_ship', 'printed'), prazo: ok({ status: 'delayed', expected_date: '2026-10-20T23:59:59.000-03:00' }) } });
    const [e] = (await consultarEnvios(cache, ['60001'], f)).envios;
    expect(e).toMatchObject({ situacao: 'pendente', prazoPostagem: '2026-10-20', slaStatus: 'delayed' });
  });
});

describe('caso real 48265507555 (ready_to_ship/in_hub) e substatus fora da lista', () => {
  it('in_hub é despacho: sai como despachado, com a data do histórico, nunca atrasado', async () => {
    const { f } = ml({
      '48265507555': {
        envio: envio('ready_to_ship', 'in_hub', 'xd_drop_off'),
        prazo: prazo('2026-10-20T23:59:59.000-03:00'),
        historico: hist(['ready_to_ship', 'printed', '2026-10-19T18:00:00.000-03:00'], ['ready_to_ship', 'in_hub', '2026-10-20T16:20:00.000-03:00']),
      },
    });
    const [e] = (await consultarEnvios(cache, ['48265507555'], f)).envios;
    expect(e.situacao).toBe('despachado');
    expect(e.despachadoEm).toBe('2026-10-20T16:20:00.000-03:00');
    expect(e.atrasoML).toBeNull();
  });

  it('se o histórico tiver a agência antes do hub, vale o primeiro evento (agência)', () => {
    expect(extrairDespacho([
      { status: 'ready_to_ship', substatus: 'in_hub', date: '2026-10-20T16:20:00.000-03:00' },
      { status: 'ready_to_ship', substatus: 'dropped_off', date: '2026-10-20T11:05:00.000-03:00' },
    ])).toBe('2026-10-20T11:05:00.000-03:00');
  });

  it('substatus de ready_to_ship desconhecido não vira pendente (nem atraso falso): sai como outro', async () => {
    const { f, chamadas } = ml({ '48265500001': { envio: envio('ready_to_ship', 'novo_substatus_do_ml') } });
    const [e] = (await consultarEnvios(cache, ['48265500001'], f)).envios;
    expect(e.situacao).toBe('outro');
    expect(e.avisos).toEqual(['substatus_nao_mapeado:ready_to_ship/novo_substatus_do_ml']);
    expect(chamadas).toEqual(['envio:48265500001']);
  });

  it('pendentes conhecidos seguem pendentes: impressa, a imprimir, sem substatus', async () => {
    const { f } = ml({
      '48265500002': { envio: envio('ready_to_ship', 'printed'), prazo: prazo('2026-10-22T23:59:59.000-03:00') },
      '48265500003': { envio: envio('ready_to_ship', 'ready_to_print'), prazo: prazo('2026-10-22T23:59:59.000-03:00') },
      '48265500004': { envio: envio('ready_to_ship', null), prazo: prazo('2026-10-22T23:59:59.000-03:00') },
    });
    const r = await consultarEnvios(cache, ['48265500002', '48265500003', '48265500004'], f);
    expect(r.envios.map(e => e.situacao)).toEqual(['pendente', 'pendente', 'pendente']);
  });
});

describe('horário-limite do SLA', () => {
  it('guarda o instante cru quando o SLA traz hora; data pura (meia-noite) fica sem horário', async () => {
    const { f } = ml({
      '61001': { envio: envio('ready_to_ship', 'printed'), prazo: prazo('2026-10-22T13:00:00.000-03:00') },
      '61002': { envio: envio('ready_to_ship', 'printed'), prazo: prazo('2026-10-22T00:00:00.000-03:00') },
    });
    const [a, b] = (await consultarEnvios(cache, ['61001', '61002'], f)).envios;
    expect(a).toMatchObject({ prazoPostagem: '2026-10-22', prazoLimiteEm: '2026-10-22T13:00:00.000-03:00' });
    expect(b).toMatchObject({ prazoPostagem: '2026-10-22', prazoLimiteEm: null });
    expect(extrairLimite({ expected_date: '2026-10-23T02:59:59.000Z' })).toBe('2026-10-23T02:59:59.000Z');
    expect(extrairLimite({ expected_date: null })).toBeNull();
  });

  it('o horário-limite atravessa o cache do prazo', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T10:00:00-03:00'));
    const { f, chamadas } = ml({ '61003': { envio: envio('ready_to_ship', 'printed'), prazo: prazo('2026-10-21T23:59:59.000-03:00') } });
    await consultarEnvios(cache, ['61003'], f);
    vi.setSystemTime(Date.now() + (TTL_PENDENTE_S + 1) * 1000);
    chamadas.length = 0;
    const [e] = (await consultarEnvios(cache, ['61003'], f)).envios;
    expect(chamadas).toEqual(['envio:61003']);           // prazo veio do cache
    expect(e.prazoLimiteEm).toBe('2026-10-21T23:59:59.000-03:00');
  });
});

describe('prazo vencido x atraso confirmado pelo Mercado Livre (/delays)', () => {
  // Caso real de 21/10: 4 pendentes com SLA em 20/10 12:30 que o painel do ML NÃO mostra como atrasados.
  const agora = new Date('2026-10-21T10:00:00-03:00');
  const pendenteVencido = (atrasos?: RespostaML) => ({
    envio: envio('ready_to_ship', 'ready_for_pickup', 'cross_docking'),
    prazo: ok({ status: 'on_time', expected_date: '2026-10-20T12:30:00.000-03:00' }),
    ...(atrasos ? { atrasos } : {}),
  });

  it('vencido na nossa comparação, ML sem atraso (404): nao_indicado, nunca "atrasado"', async () => {
    const { f, chamadas } = ml({ '70100': pendenteVencido() });
    const [e] = (await consultarEnvios(cache, ['70100'], f, { agora })).envios;
    expect(e).toMatchObject({ situacao: 'pendente', prazoPostagem: '2026-10-20', prazoLimiteEm: '2026-10-20T12:30:00.000-03:00', atrasoML: 'nao_indicado', atrasoTipos: [] });
    expect(chamadas).toEqual(['envio:70100', 'prazo:70100', 'atraso:70100']);
  });

  it('ML lista atraso: confirmado, com os tipos como o ML enviou', async () => {
    const { f } = ml({ '70101': pendenteVencido(ok([{ type: 'handling_delayed', date: '2026-10-21T00:00:00.000-03:00' }, { type: 'handling_delayed' }])) });
    const [e] = (await consultarEnvios(cache, ['70101'], f, { agora })).envios;
    expect(e).toMatchObject({ atrasoML: 'confirmado', atrasoTipos: ['handling_delayed'] });
  });

  it('formato inesperado ou HTTP de erro: atraso desconhecido (null), com aviso, sem cache', async () => {
    const { f, chamadas } = ml({
      '70102': pendenteVencido({ status: 500, data: null }),
      '70103': pendenteVencido(ok({ algo: 'diferente' })),
    });
    const r = await consultarEnvios(cache, ['70102', '70103'], f, { agora, concorrencia: 1 });
    expect(r.envios[0]).toMatchObject({ atrasoML: null });
    expect(r.envios[0].avisos).toContain('delays_http_500');
    expect(r.envios[1]).toMatchObject({ atrasoML: null });
    expect(interpretarAtrasos({ status: 200, data: [] })).toEqual({ atraso: 'nao_indicado', tipos: [] });
    expect(interpretarAtrasos({ status: 200, data: { type: 'sla_delayed' } })).toEqual({ atraso: 'confirmado', tipos: ['sla_delayed'] });
    void chamadas;
  });

  it('prazo ainda não vencido (hoje, ou horário-limite futuro): /delays não é consultado', async () => {
    const cedo = new Date('2026-10-20T11:00:00-03:00');
    const { f, chamadas } = ml({ '70104': pendenteVencido() });
    const [e] = (await consultarEnvios(cache, ['70104'], f, { agora: cedo })).envios;
    expect(e.atrasoML).toBeNull();
    expect(chamadas).toEqual(['envio:70104', 'prazo:70104']);
    expect(prazoVencido('2026-10-20', '2026-10-20T12:30:00.000-03:00', '2026-10-20T12:29:00.000-03:00')).toBe(false);
    expect(prazoVencido('2026-10-20', '2026-10-20T12:30:00.000-03:00', '2026-10-20T12:31:00.000-03:00')).toBe(true);
    expect(prazoVencido('2026-10-20', null, '2026-10-20T23:00:00.000-03:00')).toBe(false); // sem horário: o dia todo
    expect(prazoVencido('2026-10-20', null, '2026-10-21T00:01:00.000-03:00')).toBe(true);
  });

  it('a resposta do ML sobre atraso fica em cache: a revisão do pendente não repete /delays', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(agora);
    const { f, chamadas } = ml({ '70105': pendenteVencido() });
    await consultarEnvios(cache, ['70105'], f);
    vi.setSystemTime(Date.now() + (TTL_PENDENTE_S + 1) * 1000);
    chamadas.length = 0;
    const [e] = (await consultarEnvios(cache, ['70105'], f)).envios;
    expect(chamadas).toEqual(['envio:70105']);
    expect(e.atrasoML).toBe('nao_indicado');
  });

  it('programado nunca é consultado em /delays (não tem prazo de postagem ainda)', async () => {
    const { f, chamadas } = ml({ '70106': { envio: envio('pending', 'buffered', 'xd_drop_off', { shipping_option: { buffering: { date: '2026-10-19T00:00:00.000Z' } } }), prazo: ok({}) } });
    await consultarEnvios(cache, ['70106'], f, { agora });
    expect(chamadas).not.toContain('atraso:70106');
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
    const r = await consultarEnvios(cache, ['40001'], f, { agora: new Date('2026-10-19T09:00:00-03:00') });
    expect(r.envios[0]).toMatchObject({
      id: '40001', situacao: 'pendente', status: 'ready_to_ship', substatus: 'printed',
      prazoPostagem: '2026-10-19', despachadoEm: null,
    });
    expect(chamadas).toEqual(['envio:40001', 'prazo:40001']); // histórico e /delays não são pedidos (prazo hoje)
  });

  it('deixado na agência: despachado com a data do histórico', async () => {
    const { f, chamadas: chamadasML } = ml({
      '40002': {
        envio: envio('ready_to_ship', 'dropped_off'),
        prazo: prazo('2026-10-20T00:00:00.000-03:00'),
        historico: hist(['ready_to_ship', 'printed', '2026-10-19T10:00:00.000-03:00'],
                        ['ready_to_ship', 'dropped_off', '2026-10-19T15:12:00.000-03:00']),
      },
    });
    const { chamadas } = { chamadas: [] as string[] };
    const [e] = (await consultarEnvios(cache, ['40002'], f)).envios;
    expect(e.situacao).toBe('despachado');
    expect(e.despachadoEm).toBe('2026-10-19T15:12:00.000-03:00');
    // Despachado não consulta o SLA: o prazo de quem já saiu não muda nenhum grupo.
    expect(e.prazoPostagem).toBeNull();
    void chamadas;
  });

  it('despachado sem data em lugar nenhum: despachado, data null, com aviso', async () => {
    const { f } = ml({
      '40003': { envio: envio('shipped', 'in_transit'), prazo: prazo(null), historico: ok([]) },
    });
    const [e] = (await consultarEnvios(cache, ['40003'], f)).envios;
    expect(e.situacao).toBe('despachado');
    expect(e.despachadoEm).toBeNull();
    expect(e.prazoPostagem).toBeNull();
    expect(e.avisos).toEqual(['data_despacho_nao_informada']);
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

  it('sla indisponível: cai para o prazo antigo do próprio envio, marcado', async () => {
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
    expect(e.avisos).toEqual(expect.arrayContaining(['sla_http_404', 'prazo_do_envio']));
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
    const agora = new Date('2026-10-19T09:00:00-03:00'); // prazo hoje: sem /delays
    const r = await consultarEnvios(cache, ids, f, { maxChamadas: 4, concorrencia: 1, agora });
    expect(r.chamadasML).toBe(4);
    expect(r.envios.map(e => e.situacao)).toEqual(['pendente', 'pendente', 'aguardando', 'aguardando']);
    expect(r.aguardando).toBe(2);
    // A passada seguinte completa só os que faltavam.
    const r2 = await consultarEnvios(cache, ids, f, { maxChamadas: 4, concorrencia: 1, agora });
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

  it('sla 200 sem prazo: ausência cacheada por 5 min; HTTP de erro não é cacheado', async () => {
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

// ── Envio programado (pending/buffered) — caso real validado em 21/10 ───

describe('envio programado (buffered)', () => {
  // Formato observado nos envios reais 48313826973 e 48310252408 (21/10/2026):
  // pending/buffered, xd_drop_off, shipping_option.buffering.date em UTC e
  // /sla respondendo 200 SEM expected_date (prazo ainda não atribuído).
  const buffered = () => envio('pending', 'buffered', 'xd_drop_off', {
    shipping_option: { buffering: { date: '2026-10-23T00:00:00.000Z' } },
  });

  it('sai como programado, com a liberação em campo próprio e SEM prazo inventado', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T14:00:00-03:00'));
    const { f, chamadas } = ml({ '48313826973': { envio: buffered(), prazo: ok({ shipping_method: { id: 1 } }) } });
    const [e] = (await consultarEnvios(cache, ['48313826973'], f)).envios;
    expect(e.situacao).toBe('programado');
    expect(e.liberacaoEm).toBe('2026-10-23');   // data escrita pelo ML, não 22/10 21h
    expect(e.prazoPostagem).toBeNull();          // buffering.date NUNCA vira prazo
    expect(e.despachadoEm).toBeNull();
    expect(e.avisos).toEqual(expect.arrayContaining(['sla_sem_prazo', 'prazo_nao_informado', 'prazo_atribuido_apos_liberacao']));
    expect(chamadas).toEqual(['envio:48313826973', 'prazo:48313826973']); // sem histórico
  });

  it('se o /sla já trouxer prazo, o prazo oficial é mantido', async () => {
    const { f } = ml({ '48310252408': { envio: buffered(), prazo: prazo('2026-10-24T00:00:00.000-03:00') } });
    const [e] = (await consultarEnvios(cache, ['48310252408'], f)).envios;
    expect(e.situacao).toBe('programado');
    expect(e.prazoPostagem).toBe('2026-10-24');
    expect(e.liberacaoEm).toBe('2026-10-23');
  });

  it('sem buffering.date: programado com liberação ausente e aviso, nunca data inventada', async () => {
    const { f } = ml({ '48310000001': { envio: envio('pending', 'buffered', 'xd_drop_off') } });
    const [e] = (await consultarEnvios(cache, ['48310000001'], f)).envios;
    expect(e.situacao).toBe('programado');
    expect(e.liberacaoEm).toBeNull();
    expect(e.avisos).toContain('liberacao_nao_informada');
  });

  it('cache: liberação futura revista a cada 10 min; no dia da liberação, a cada 2 min', () => {
    const p = { ...(JSON.parse('{}')), id: '1', situacao: 'programado', liberacaoEm: '2026-10-23' } as never;
    expect(ttlDoResultado(p, '2026-10-21')).toBe(TTL_INCOMPLETO_S);
    expect(ttlDoResultado(p, '2026-10-23')).toBe(TTL_PENDENTE_S);
    expect(ttlDoResultado({ ...(p as object), liberacaoEm: null } as never, '2026-10-21')).toBe(TTL_PENDENTE_S);
  });

  it('liberado (ready_to_ship): vira pendente com o prazo oficial atribuído pelo ML', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T10:00:00-03:00'));
    const sim: Record<string, EnvioSim> = { '48313826973': { envio: buffered(), prazo: ok({}) } };
    const { f } = ml(sim);
    expect((await consultarEnvios(cache, ['48313826973'], f)).envios[0].situacao).toBe('programado');

    // 23/10: o ML libera a etiqueta e atribui o prazo.
    vi.setSystemTime(new Date('2026-10-23T08:00:00-03:00'));
    sim['48313826973'].envio = envio('ready_to_ship', 'ready_to_print', 'xd_drop_off', {
      shipping_option: { buffering: { date: '2026-10-23T00:00:00.000Z' } },
    });
    sim['48313826973'].prazo = prazo('2026-10-23T00:00:00.000-03:00');
    const [e] = (await consultarEnvios(cache, ['48313826973'], f)).envios;
    expect(e.situacao).toBe('pendente');
    expect(e.prazoPostagem).toBe('2026-10-23');
    expect(e.liberacaoEm).toBeNull(); // liberação só descreve o programado
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
      'atrasoML', 'atrasoTipos', 'avisos', 'consultadoEm', 'despachadoEm', 'id', 'liberacaoEm', 'logistica', 'prazoLimiteEm', 'prazoPostagem', 'situacao', 'slaStatus', 'status', 'substatus',
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

  it('chama as rotas oficiais com Bearer: envio+histórico no despachado; envio+SLA+delays no vencido', async () => {
    const respostas: Record<string, [number, unknown]> = {
      'https://api.mercadolibre.com/shipments/44445555': [200, { status: 'ready_to_ship', substatus: 'dropped_off', logistic_type: 'xd_drop_off' }],
      'https://api.mercadolibre.com/shipments/44445555/history': [200, [{ status: 'ready_to_ship', substatus: 'dropped_off', date: '2026-10-19T13:00:00.000-03:00' }]],
      'https://api.mercadolibre.com/shipments/44446666': [200, { status: 'ready_to_ship', substatus: 'printed', logistic_type: 'xd_drop_off' }],
      'https://api.mercadolibre.com/shipments/44446666/sla': [200, { status: 'on_time', expected_date: '2026-10-19T12:30:00.000-03:00' }],
      'https://api.mercadolibre.com/shipments/44446666/delays': [404, { message: 'Delays Not Found for shipment' }],
    };
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const [st, b] = respostas[String(url)] ?? [404, {}];
      return new Response(JSON.stringify(b), { status: st }) as unknown as Response;
    });
    const r = await runOp(cache, 'expedicao-envios', { ids: '44445555,44446666' }, TEST_ENV.ML_USER_ID);
    expect(r.status).toBe(200);
    const d = r.data as { ok: boolean; envios: Array<Record<string, unknown>>; chamadasML: number };
    expect(d.ok).toBe(true);
    expect(d.chamadasML).toBe(5);
    expect(d.envios[0]).toMatchObject({ situacao: 'despachado', despachadoEm: '2026-10-19T13:00:00.000-03:00' });
    expect(d.envios[1]).toMatchObject({ situacao: 'pendente', prazoPostagem: '2026-10-19', atrasoML: 'nao_indicado', slaStatus: 'on_time' });
    const urls = spy.mock.calls.map(c => String(c[0])).sort();
    expect(urls).toEqual(Object.keys(respostas).sort());
    for (const [url, init] of spy.mock.calls) {
      expect(String(url)).not.toContain('access_token');
      const h = init?.headers as Record<string, string>;
      expect(h.Authorization).toBe('Bearer AT-teste');
      expect(h['x-format-new'], String(url)).toBe(String(url).endsWith('/sla') ? 'true' : undefined);
    }
  });

  it('sla 404 (sem SLA para o envio): pendente sem prazo, nada inventado', async () => {
    const respostas: Record<string, [number, unknown]> = {
      'https://api.mercadolibre.com/shipments/55556666': [200, { status: 'ready_to_ship', substatus: 'ready_to_print', logistic_type: 'xd_drop_off' }],
      'https://api.mercadolibre.com/shipments/55556666/sla': [404, { message: 'sla not found' }],
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const [st, b] = respostas[String(url)] ?? [404, {}];
      return new Response(JSON.stringify(b), { status: st }) as unknown as Response;
    });
    const r = await runOp(cache, 'expedicao-envios', { ids: '55556666' }, TEST_ENV.ML_USER_ID);
    const e = (r.data as { envios: Array<Record<string, unknown>> }).envios[0];
    expect(e).toMatchObject({ situacao: 'pendente', prazoPostagem: null, slaStatus: null });
    expect(e.avisos).toEqual(expect.arrayContaining(['sla_http_404', 'prazo_nao_informado']));
  });
});
