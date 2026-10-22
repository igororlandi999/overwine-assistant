/**
 * Cenário SIMULADO de expedição para a prévia local (só revisão visual).
 *
 * Liga com `iniciarAmbiente({ expedicao: true })` — a prévia liga, o roteiro
 * de seletores (contas.e2e.ts) não. Transforma alguns pedidos recentes das
 * lojas simuladas em envios próprios, um para cada caso que a aba Expedição
 * precisa mostrar, e responde /shipments/{id}, /lead_time e /history deles.
 *
 * Formatos espelham o que a validação real de 21/10/2026 mostrou: status e
 * substatus do envio, buffering.date em UTC no programado, /history como
 * lista de { status, substatus, date }. O prazo vem do /sla (expected_date);
 * o /lead_time responde sem estimated_handling_limit, como o real desde 2025.
 * Nada aqui é dado real.
 */
import type { OrderInput } from '../src/services/orders.service.js';

interface Caso {
  rotulo: string;
  status: string;
  substatus: string | null;
  logistica: string;
  /** Dias a partir de hoje (BRT) do prazo oficial; null = o ML não informou. */
  prazo: number | null;
  /** Dias até a liberação (programado). */
  liberacao?: number;
  /** Despacho real: dias a partir de hoje e hora local. */
  despacho?: { dias: number; hora: string };
  /** O ML reconhece atraso em /delays (senão 404). */
  atrasoML?: boolean;
  /** O ML NÃO registra o dropped_off (só eventos posteriores). */
  semAgencia?: boolean;
}

export interface CenarioExpedicao {
  /** shipmentId → caso */
  envios: Map<string, Caso>;
  /** Latência simulada de cada chamada ao ML (ms), para medir desempenho. */
  latenciaMs: number;
}

const BRT = 'America/Sao_Paulo';
function ymd(offsetDias: number): string {
  const d = new Date(Date.now() + offsetDias * 86400_000);
  return d.toLocaleDateString('en-CA', { timeZone: BRT });
}

/** Pedidos da Overwine simulada (100000…) e da Degustar (200000…) que viram envios próprios. */
const CASOS_OW: Array<[number, Caso]> = [
  [100000, { rotulo: 'a enviar hoje, etiqueta a imprimir', status: 'ready_to_ship', substatus: 'ready_to_print', logistica: 'xd_drop_off', prazo: 0 }],
  [100001, { rotulo: 'a enviar hoje, pacote com 2 pedidos', status: 'ready_to_ship', substatus: 'printed', logistica: 'xd_drop_off', prazo: 0 }],
  [100003, { rotulo: 'a enviar amanhã (coleta)', status: 'ready_to_ship', substatus: 'ready_to_print', logistica: 'cross_docking', prazo: 1 }],
  [100004, { rotulo: 'prazo vencido ontem, ML sem atraso', status: 'ready_to_ship', substatus: 'printed', logistica: 'xd_drop_off', prazo: -1 }],
  [100012, { rotulo: 'atraso confirmado pelo ML', status: 'ready_to_ship', substatus: 'printed', logistica: 'xd_drop_off', prazo: -2, atrasoML: true }],
  [100005, { rotulo: 'pendente sem prazo', status: 'ready_to_ship', substatus: 'ready_to_print', logistica: 'xd_drop_off', prazo: null }],
  [100006, { rotulo: 'programado (buffered)', status: 'pending', substatus: 'buffered', logistica: 'xd_drop_off', prazo: null, liberacao: 2 }],
  [100007, { rotulo: 'despachado hoje (agência)', status: 'ready_to_ship', substatus: 'dropped_off', logistica: 'xd_drop_off', prazo: 0, despacho: { dias: 0, hora: '09:40' } }],
  [100008, { rotulo: 'despachado hoje (em trânsito)', status: 'shipped', substatus: 'in_transit', logistica: 'cross_docking', prazo: 0, despacho: { dias: 0, hora: '11:15' } }],
  [100009, { rotulo: 'despachado ontem', status: 'delivered', substatus: null, logistica: 'xd_drop_off', prazo: -1, despacho: { dias: -1, hora: '16:02' } }],
  [100010, { rotulo: 'Flex a enviar hoje', status: 'ready_to_ship', substatus: 'ready_to_print', logistica: 'self_service', prazo: 0 }],
  [100011, { rotulo: 'Full fora do mapa (não aparece)', status: 'shipped', substatus: 'in_transit', logistica: 'fulfillment', prazo: null }],
  [100013, { rotulo: 'postado ontem na agência, hoje in_packing_list', status: 'ready_to_ship', substatus: 'in_packing_list', logistica: 'xd_drop_off', prazo: -1, despacho: { dias: -1, hora: '12:13' } }],
  [100014, { rotulo: 'programado, libera em 5 dias, pacote com 2 pedidos', status: 'pending', substatus: 'buffered', logistica: 'xd_drop_off', prazo: null, liberacao: 5 }],
  [100017, { rotulo: 'entregue ontem, sem registro da bipagem', status: 'delivered', substatus: null, logistica: 'xd_drop_off', prazo: -2, despacho: { dias: -1, hora: '12:00' }, semAgencia: true }],
  [100018, { rotulo: 'packing list sem bipagem registrada (conferir)', status: 'ready_to_ship', substatus: 'in_packing_list', logistica: 'xd_drop_off', prazo: -1, despacho: { dias: -1, hora: '12:00' }, semAgencia: true }],
  [100016, { rotulo: 'programado, libera hoje', status: 'pending', substatus: 'buffered', logistica: 'xd_drop_off', prazo: null, liberacao: 0 }],
];
const CASOS_DG: Array<[number, Caso]> = [
  [200000, { rotulo: 'Degustar a enviar hoje', status: 'ready_to_ship', substatus: 'printed', logistica: 'xd_drop_off', prazo: 0 }],
];
/** [filho, dono]: o filho entra no MESMO envio do dono (pedidos do mesmo carrinho). */
const PACOTES: Array<[number, number]> = [[100002, 100001], [100015, 100014]];

const envioDe = (pedidoId: number) => String(900000 + pedidoId);

/** Altera os pedidos simulados no lugar e devolve o cenário dos envios. */
export function aplicarCenarioExpedicao(pedidosOW: OrderInput[], pedidosDG: OrderInput[], volume = 0, latenciaMs = 0): CenarioExpedicao {
  const envios = new Map<string, Caso>();
  // VOLUME (medição de desempenho): outros pedidos da Overwine simulada viram
  // envios próprios já despachados e entregues, como a maior parte da janela real.
  const extras: Array<[number, Caso]> = [];
  for (let i = 0; i < volume; i++) {
    const id = 100020 + i;
    const o = pedidosOW.find(x => Number(x.id) === id) as any;
    if (!o) break;
    const dias = -Math.max(1, Math.round((Date.now() - Date.parse(o.date_created)) / 86400000) - 1);
    extras.push([id, { rotulo: 'volume', status: 'delivered', substatus: null, logistica: 'xd_drop_off', prazo: dias, despacho: { dias, hora: '15:00' } }]);
  }
  const marcar = (lista: OrderInput[], casos: Array<[number, Caso]>) => {
    for (const [id, caso] of casos) {
      const o = lista.find(x => Number(x.id) === id) as any;
      if (!o) continue;
      // Como no snapshot real: o pedido não traz logistic_type.
      o.shipping = { id: Number(envioDe(id)), logistic_type: null };
      envios.set(envioDe(id), caso);
    }
  };
  marcar(pedidosOW, CASOS_OW);
  marcar(pedidosOW, extras);
  marcar(pedidosDG, CASOS_DG);
  for (const [f, dono] of PACOTES) {
    const filho = pedidosOW.find(x => Number(x.id) === f) as any;
    if (filho) filho.shipping = { id: Number(envioDe(dono)), logistic_type: null };
  }
  return { envios, latenciaMs };
}

/** Resposta do ML simulado para as rotas de envio do cenário; null = não é do cenário. */
export function respostaExpedicao(c: CenarioExpedicao, path: string, headers: Headers): { status: number; body: unknown } | null {
  const m = path.match(/^\/shipments\/(\d+)(\/lead_time|\/sla|\/history|\/delays)?$/);
  if (!m) return null;
  const caso = c.envios.get(m[1]);
  if (!caso) return null;
  const id = Number(m[1]);
  if (!m[2]) {
    return {
      status: 200, body: {
        id, status: caso.status, substatus: caso.substatus, logistic_type: caso.logistica, mode: 'me2',
        shipping_option: { cost: 0, list_cost: 20, ...(caso.liberacao !== undefined ? { buffering: { date: ymd(caso.liberacao) + 'T00:00:00.000Z' } } : {}) },
        status_history: caso.despacho && caso.status !== 'ready_to_ship' ? { date_shipped: `${ymd(caso.despacho.dias)}T18:00:00.000-03:00` } : {},
        // Como o ML real: eventos do próprio envio, com horário em -04:00.
        substatus_history: eventos(caso).filter(e => e.status !== 'handling'),
        receiver_address: { street_name: 'Rua Simulada', zip_code: '00000-000' },
      },
    };
  }
  if (m[2] === '/lead_time') {
    return { status: 200, body: { shipping_method: { id: 1, type: 'standard', name: 'Normal' }, cost: 0, estimated_delivery_time: { date: ymd(5) + 'T00:00:00.000-03:00' } } };
  }
  if (m[2] === '/delays') {
    return caso.atrasoML
      ? { status: 200, body: [{ type: 'handling_delayed', date: ymd(-1) + 'T00:00:00.000-03:00' }] }
      : { status: 404, body: { message: 'Delays Not Found for shipment' } };
  }
  if (m[2] === '/sla') {
    void headers;
    if (caso.prazo === null) return { status: 200, body: { status: null, expected_date: null } };
    return { status: 200, body: { status: caso.prazo < 0 ? 'delayed' : 'on_time', expected_date: ymd(caso.prazo) + 'T23:59:59.000-03:00', service: 1, last_updated: new Date().toISOString() } };
  }
  return { status: 200, body: eventos(caso) };
}

/** Horário de Brasília (hh:mm do dia `dias`) escrito em -04:00, como o ML devolve. */
function emMenos4(dias: number, hora: string): string {
  const t = Date.parse(`${ymd(dias)}T${hora}:00.000-03:00`);
  return new Date(t - 4 * 3600_000).toISOString().replace('Z', '-04:00');
}

function eventos(caso: Caso): Array<{ status: string; substatus: string | null; date: string }> {
  const ev: Array<{ status: string; substatus: string | null; date: string }> = [
    { status: 'handling', substatus: null, date: emMenos4(-2, '10:00') },
    { status: 'ready_to_ship', substatus: 'ready_to_print', date: emMenos4(-2, '10:05') },
  ];
  if (caso.despacho) {
    if (!caso.semAgencia) ev.push({ status: 'ready_to_ship', substatus: 'dropped_off', date: emMenos4(caso.despacho.dias, caso.despacho.hora) });
    if (caso.substatus === 'in_packing_list') ev.push({ status: 'ready_to_ship', substatus: 'in_packing_list', date: emMenos4(caso.despacho.dias, '20:40') });
    if (caso.status !== 'ready_to_ship') ev.push({ status: 'shipped', substatus: 'in_transit', date: emMenos4(caso.despacho.dias, '18:00') });
  }
  return ev;
}
