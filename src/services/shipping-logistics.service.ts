/**
 * shipping-logistics.service — lógica PURA do mapa de logística por envio.
 *
 * Sem Redis, sem fetch, sem relógio implícito. Decide o que buscar, mescla o
 * que voltou e responde a logística de um pedido. Quem fala com o mundo é o
 * endpoint admin; quem fala com o Redis é o shipping-store.
 *
 * Ver a nota longa em lib/shipping-store.ts para o motivo de tudo isto existir:
 * em resumo, a API de pedidos do ML não devolve `logistic_type`, o snapshot
 * grava null em 100% dos pedidos, e o cálculo de custo vinha somando embalagem
 * em vendas Full onde o Mercado Livre é quem embala.
 */
import type { OrderSlim } from './orders.service.js';
import { contaComoVenda } from '../lib/status-venda.js';

/** Envios buscados por invocação. Ver `LOTE_PADRAO` para o racional. */
export const LOTE_PADRAO = 300;
export const LOTE_MAX = 1000;

export interface EnvioResolvido {
  shipmentId: string;
  logisticType: string;
}

export interface PendentesResultado {
  /** Ids a buscar nesta invocação, já cortados em `limite`. */
  ids: string[];
  /** Quantos ainda faltariam depois destes. 0 = acabou. */
  restantes: number;
  /** Envios distintos vistos nos pedidos que contam como venda. */
  totalDistintos: number;
  /** Quantos já estão no mapa. */
  jaResolvidos: number;
}

function shipmentIdDoPedido(o: OrderSlim | null | undefined): string | null {
  const id = o?.shipping?.id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  if (typeof id === 'string' && id.trim() !== '') return id.trim();
  return null;
}

/**
 * Decide quais envios buscar.
 *
 * Só considera pedidos que CONTAM COMO VENDA: buscar o envio de um pedido
 * cancelado gastaria chamada de API para um dado que nenhum cálculo usa.
 *
 * Ordem DECRESCENTE por data do pedido: o backfill começa pelos pedidos
 * recentes, que são os que aparecem nas consultas do dia a dia. Assim a margem
 * melhora desde a primeira invocação, em vez de só no fim do processo.
 */
export function idsPendentes(
  pedidos: OrderSlim[],
  mapa: ReadonlyMap<string, string>,
  limite: number = LOTE_PADRAO
): PendentesResultado {
  const lim = Number.isFinite(limite) && limite > 0
    ? Math.min(Math.floor(limite), LOTE_MAX)
    : LOTE_PADRAO;

  // Mais recentes primeiro. Data ausente vai para o fim.
  const ordenados = [...pedidos].sort((a, b) => {
    const da = a?.date_created ?? '';
    const db = b?.date_created ?? '';
    if (da === db) return 0;
    if (da === '') return 1;
    if (db === '') return -1;
    return db.localeCompare(da);
  });

  const vistos = new Set<string>();
  const pendentes: string[] = [];
  let jaResolvidos = 0;

  for (const o of ordenados) {
    if (!o || !contaComoVenda(o.status)) continue;
    const sid = shipmentIdDoPedido(o);
    if (sid === null || vistos.has(sid)) continue;
    vistos.add(sid);
    if (mapa.has(sid)) jaResolvidos++;
    else pendentes.push(sid);
  }

  return {
    ids: pendentes.slice(0, lim),
    restantes: Math.max(0, pendentes.length - lim),
    totalDistintos: vistos.size,
    jaResolvidos,
  };
}

/**
 * Mescla o que voltou da API. Devolve um mapa NOVO — a entrada não é mutada.
 *
 * Entrada inválida é DESCARTADA em silêncio, nunca gravada como string vazia:
 * um `logisticType` vazio no mapa faria `ehVendaFull` responder false e o envio
 * seria tratado como estoque próprio para sempre, sem nunca mais ser buscado.
 * Descartar mantém o id pendente, e a próxima rodada tenta de novo.
 */
export function mesclarResolvidos(
  mapa: ReadonlyMap<string, string>,
  resolvidos: readonly EnvioResolvido[]
): Map<string, string> {
  const novo = new Map(mapa);
  for (const r of resolvidos) {
    if (!r) continue;
    const { shipmentId, logisticType } = r;
    if (typeof shipmentId !== 'string' || shipmentId.trim() === '') continue;
    if (typeof logisticType !== 'string' || logisticType.trim() === '') continue;
    novo.set(shipmentId.trim(), logisticType.trim());
  }
  return novo;
}

/**
 * Logística de um pedido, para alimentar `custoUnitarioVendido`.
 *
 * Preferência: o campo do PRÓPRIO pedido, se um dia o ML passar a enviá-lo;
 * depois o mapa. `null` quando não se sabe — e null continua sendo tratado como
 * estoque próprio lá na frente, que é o lado conservador (soma embalagem, nunca
 * infla a margem).
 */
export function logisticaDoPedido(
  o: OrderSlim | null | undefined,
  mapa: ReadonlyMap<string, string> | null | undefined
): string | null {
  const doPedido = o?.shipping?.logistic_type;
  if (typeof doPedido === 'string' && doPedido.trim() !== '') return doPedido.trim();
  if (!mapa) return null;
  const sid = shipmentIdDoPedido(o);
  if (sid === null) return null;
  return mapa.get(sid) ?? null;
}

export interface CoberturaLogistica {
  /** Envios distintos em pedidos que contam como venda. */
  totalDistintos: number;
  resolvidos: number;
  pendentes: number;
  /** 0..1. Fração dos envios distintos já conhecidos. */
  fracao: number;
}

/**
 * Quanto do histórico já tem logística conhecida. Serve para a resposta
 * declarar a limitação enquanto o backfill não terminou, em vez de apresentar
 * margem parcial como se fosse completa.
 */
export function coberturaLogistica(
  pedidos: OrderSlim[],
  mapa: ReadonlyMap<string, string>
): CoberturaLogistica {
  const { totalDistintos, jaResolvidos } = idsPendentes(pedidos, mapa, LOTE_MAX);
  return {
    totalDistintos,
    resolvidos: jaResolvidos,
    pendentes: totalDistintos - jaResolvidos,
    fracao: totalDistintos > 0 ? jaResolvidos / totalDistintos : 1,
  };
}