/**
 * orders-events — ÚNICA camada que conhece o layout das chaves Redis da fila
 * de notificações do Mercado Livre e dos contadores de observabilidade dela.
 * Espelha orders-store: fala só com a interface Cache, nunca com Upstash.
 *
 * Layout:
 *   orders:evt:queue          FILA (lista Redis) de eventos a processar
 *   orders:evt:seen:{id}      marca de idempotência por id de notificação
 *   orders:evt:obs:notif      telemetria do RECEBIMENTO (escrita no ack)
 *   orders:evt:obs:proc       telemetria do PROCESSAMENTO (escrita sob lock)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE UMA FILA, E NÃO PROCESSAR NA PRÓPRIA NOTIFICAÇÃO
 *
 * O Mercado Livre espera HTTP 200 em até 500 ms. Buscar o pedido na API,
 * reescrever o chunk e publicar o manifesto leva mais que isso — e uma
 * resposta lenta é contada como entrega falha, com reenvio e risco de o ML
 * desabilitar a callback. Então o endpoint só ENFILEIRA e responde; quem
 * processa é o dreno, disparado por três gatilhos independentes (ver
 * orders-webhook.service).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE RPUSH/LPOP E NÃO UM ARRAY EM JSON
 *
 * Duas notificações podem chegar no mesmo milissegundo, em instâncias
 * serverless diferentes. Um ciclo get → parse → push → set perderia uma das
 * duas em silêncio. RPUSH e LPOP são atômicos no servidor; a fila não tem
 * essa corrida.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A TELEMETRIA É BEST-EFFORT, DE PROPÓSITO
 *
 * Os dois blobs de observabilidade são lidos-e-regravados sem lock. Uma
 * atualização concorrente pode perder um contador. Isso é aceitável porque
 * nenhuma decisão do sistema depende deles: existem para responder "quando
 * chegou a última notificação" a um humano. Nada de negócio lê daqui.
 */
import type { Cache } from './cache/cache.js';

export const CHAVE_FILA = 'orders:evt:queue';
export const CHAVE_OBS_NOTIF = 'orders:evt:obs:notif';
export const CHAVE_OBS_PROC = 'orders:evt:obs:proc';

const chaveVisto = (notifId: string) => `orders:evt:seen:${notifId}`;

/**
 * Janela de idempotência. O ML reenvia uma notificação não confirmada por
 * horas; 24 h cobre a política de retentativa com folga. Passada a janela, um
 * reenvio tardio vira um upsert a mais do MESMO pedido, que é inofensivo — o
 * dreno sempre busca o estado atual na API.
 */
export const TTL_VISTO_S = 24 * 3600;

/** Um evento na fila. Só o mínimo: o processamento rebusca tudo na API do ML. */
export interface EventoPedido {
  /** Id do pedido no Mercado Livre, sempre em string canônica. */
  orderId: string;
  /** Tópico que originou o evento (orders_v2, shipments, ...). */
  topico: string;
  /** Id da notificação (`_id` do corpo do ML), quando informado. */
  notifId: string | null;
  /** Quando o backend recebeu (ISO). Não é o `sent` do ML. */
  recebidoEm: string;
}

export interface ObsRecebimento {
  ultimaNotificacaoEm: string | null;
  ultimaNotificacaoTopico: string | null;
  ultimaNotificacaoPedido: string | null;
  totalRecebidas: number;
  totalDuplicadas: number;
  totalRejeitadas: number;
}

export interface ObsProcessamento {
  ultimoPedidoAtualizadoId: string | null;
  ultimoPedidoAtualizadoEm: string | null;
  ultimaAcao: 'novo' | 'atualizado' | 'sem_mudanca' | null;
  totalNovos: number;
  totalAtualizados: number;
  totalSemMudanca: number;
  totalFalhas: number;
  ultimoErro: string | null;
  ultimoErroEm: string | null;
  ultimoDrenoEm: string | null;
}

const OBS_RECEBIMENTO_ZERO: ObsRecebimento = {
  ultimaNotificacaoEm: null,
  ultimaNotificacaoTopico: null,
  ultimaNotificacaoPedido: null,
  totalRecebidas: 0,
  totalDuplicadas: 0,
  totalRejeitadas: 0,
};

const OBS_PROCESSAMENTO_ZERO: ObsProcessamento = {
  ultimoPedidoAtualizadoId: null,
  ultimoPedidoAtualizadoEm: null,
  ultimaAcao: null,
  totalNovos: 0,
  totalAtualizados: 0,
  totalSemMudanca: 0,
  totalFalhas: 0,
  ultimoErro: null,
  ultimoErroEm: null,
  ultimoDrenoEm: null,
};

async function lerBlob<T>(cache: Cache, chave: string, zero: T): Promise<T> {
  const bruto = await cache.get(chave);
  if (bruto === null) return { ...zero };
  try {
    const v = JSON.parse(bruto) as Partial<T>;
    if (!v || typeof v !== 'object') return { ...zero };
    return { ...zero, ...v };
  } catch {
    // Telemetria corrompida NUNCA derruba nada: recomeça do zero.
    return { ...zero };
  }
}

export function lerObsRecebimento(cache: Cache): Promise<ObsRecebimento> {
  return lerBlob(cache, CHAVE_OBS_NOTIF, OBS_RECEBIMENTO_ZERO);
}

export function lerObsProcessamento(cache: Cache): Promise<ObsProcessamento> {
  return lerBlob(cache, CHAVE_OBS_PROC, OBS_PROCESSAMENTO_ZERO);
}

/**
 * Idempotência: devolve true na PRIMEIRA vez que este id de notificação
 * aparece, false em qualquer reenvio dentro da janela. Notificação sem `_id`
 * não tem como ser deduplicada aqui e passa direto — o dreno ainda é idempotente
 * por construção (busca o pedido na API e faz upsert do estado atual).
 */
export async function marcarNaoVista(cache: Cache, notifId: string | null): Promise<boolean> {
  if (!notifId) return true;
  return cache.setNX(chaveVisto(notifId), '1', TTL_VISTO_S);
}

/** Enfileira um evento. Retorna o tamanho da fila depois da escrita. */
export async function enfileirar(cache: Cache, evento: EventoPedido): Promise<number> {
  return cache.rpush(CHAVE_FILA, JSON.stringify(evento));
}

/** Devolve um evento ao INÍCIO conceitual da fila após falha de processamento. */
export async function reenfileirar(cache: Cache, evento: EventoPedido): Promise<void> {
  await cache.rpush(CHAVE_FILA, JSON.stringify(evento));
}

/**
 * Retira até `max` eventos. Entradas ilegíveis são DESCARTADAS em silêncio:
 * já saíram da fila e não há como reprocessá-las; a reconciliação periódica
 * cobre o pedido que elas representavam.
 */
export async function retirar(cache: Cache, max: number): Promise<EventoPedido[]> {
  const brutos = await cache.lpopMany(CHAVE_FILA, max);
  const out: EventoPedido[] = [];
  for (const b of brutos) {
    try {
      const e = JSON.parse(b) as EventoPedido;
      if (e && typeof e.orderId === 'string' && e.orderId !== '') out.push(e);
    } catch {
      continue;
    }
  }
  return out;
}

export function tamanhoFila(cache: Cache): Promise<number> {
  return cache.llen(CHAVE_FILA);
}

export async function registrarRecebimento(
  cache: Cache,
  dados: { topico: string; orderId: string | null; duplicada: boolean; rejeitada: boolean }
): Promise<void> {
  const obs = await lerObsRecebimento(cache);
  if (dados.rejeitada) {
    obs.totalRejeitadas++;
  } else if (dados.duplicada) {
    obs.totalDuplicadas++;
  } else {
    obs.totalRecebidas++;
    obs.ultimaNotificacaoEm = new Date().toISOString();
    obs.ultimaNotificacaoTopico = dados.topico;
    obs.ultimaNotificacaoPedido = dados.orderId;
  }
  await cache.set(CHAVE_OBS_NOTIF, JSON.stringify(obs));
}

export async function registrarProcessamento(
  cache: Cache,
  dados:
    | { tipo: 'novo' | 'atualizado' | 'sem_mudanca'; orderId: string }
    | { tipo: 'falha'; erro: string }
): Promise<void> {
  const obs = await lerObsProcessamento(cache);
  const agora = new Date().toISOString();
  obs.ultimoDrenoEm = agora;
  if (dados.tipo === 'falha') {
    obs.totalFalhas++;
    // Mensagem truncada: o blob é lido por rota pública de status e não pode
    // virar veículo de vazamento de URL, chave ou corpo de resposta do ML.
    obs.ultimoErro = dados.erro.slice(0, 200);
    obs.ultimoErroEm = agora;
  } else {
    obs.ultimaAcao = dados.tipo;
    obs.ultimoPedidoAtualizadoId = dados.orderId;
    obs.ultimoPedidoAtualizadoEm = agora;
    if (dados.tipo === 'novo') obs.totalNovos++;
    else if (dados.tipo === 'atualizado') obs.totalAtualizados++;
    else obs.totalSemMudanca++;
  }
  await cache.set(CHAVE_OBS_PROC, JSON.stringify(obs));
}

/** Marca que um dreno rodou, mesmo sem nada a fazer (prova de vida). */
export async function registrarDreno(cache: Cache): Promise<void> {
  const obs = await lerObsProcessamento(cache);
  obs.ultimoDrenoEm = new Date().toISOString();
  await cache.set(CHAVE_OBS_PROC, JSON.stringify(obs));
}
