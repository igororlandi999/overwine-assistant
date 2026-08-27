/**
 * orders-read.service — camada PURA de leitura dos snapshots de pedidos para o
 * dashboard (Fase 4c.1). Só consome, nunca altera:
 *   - orders-store (readManifest, readPreviousManifest, readChunkByKey)
 *   - orders-sync.service (readStatus) — status já persistido pela 4b
 *
 * NUNCA: readSnapshot (carrega tudo), scan/keys/mget (a interface Cache não os
 * tem), mlFetch, rede. NUNCA expõe nomes de chunk, chaves Redis, jobId, TTL,
 * chunkSize ou credenciais — só projeções públicas de negócio.
 *
 * Estratégia de versão (D3/F2): cursor da versão atual lê do manifesto atual;
 * cursor da versão imediatamente anterior lê de manifest:previous (retenção da
 * 4b); cursor mais antigo → snapshot_changed.
 */
import type { Cache } from '../lib/cache/cache.js';
import {
  type Alvo,
  type OrdersManifest,
  readManifest,
  readPreviousManifest,
  readChunkByKey,
} from '../lib/orders-store.js';
import { readStatus } from './orders-sync.service.js';
import { lerObsRecebimento, lerObsProcessamento, tamanhoFila } from '../lib/orders-events.js';
import type { OrderSlim } from './orders.service.js';
import { decodeCursor, encodeCursor, InvalidCursorError, type CursorData } from '../lib/orders-cursor.js';

export const PAGE_SIZE_DEFAULT = 200;
export const PAGE_SIZE_MAX = 500;
export const PAGE_SIZE_MIN = 1;

// ── Contratos públicos ──────────────────────────────────────────────────────

export interface OrdersReadStatus {
  alvo: Alvo;
  versao: number | null;
  totalRegistros: number;
  newestDate: string | null;
  oldestDate: string | null;
  updatedAt: string | null;
  origem: 'full' | 'incremental' | 'webhook' | null;
  partial: boolean;
  lastResult: string | null;
  lastSyncAt: string | null;
  /**
   * Idade do snapshot em segundos: agora menos `updatedAt`.
   *
   * Existe porque `updatedAt` só avança quando uma versão é PUBLICADA. Uma
   * sincronização que rodou e não achou nada novo é saudável e não republica —
   * então um `updatedAt` de horas atrás pode significar "nada vendeu desde
   * então" OU "a atualização parou". Quem distingue os dois é o bloco
   * `tempoReal` abaixo, junto de `lastSyncAt`.
   */
  idadeSegundos: number | null;
  tempoReal: OrdersRealtimeStatus;
}

/**
 * Observabilidade do caminho de tempo real. É PROJEÇÃO: nenhuma decisão do
 * backend depende destes campos, eles existem para responder "o tempo real
 * está vivo?" sem abrir log de função.
 */
export interface OrdersRealtimeStatus {
  /** Notificações estão habilitadas? (false = só reconciliação, como antes.) */
  habilitado: boolean;
  ultimaNotificacaoEm: string | null;
  ultimaNotificacaoTopico: string | null;
  ultimaNotificacaoPedido: string | null;
  /** `sent` do Mercado Livre na última notificação aceita — o relógio deles. */
  ultimaNotificacaoSent: string | null;
  /**
   * Milissegundos do caminho da resposta da última notificação aceita. O ML
   * exige HTTP 200 em menos de 500 ms; é aqui que se confere.
   */
  ultimoAckMs: number | null;
  /**
   * Quando a rota PEDIU o dreno em segundo plano. Compare com `ultimoDrenoEm`:
   * se este avança, aquele não, e `pendentes` fica acima de zero, o trabalho
   * de fundo não está sobrevivendo à resposta.
   */
  ultimoDrenoPedidoEm: string | null;
  ultimoPedidoAtualizadoId: string | null;
  ultimoPedidoAtualizadoEm: string | null;
  ultimaAcao: 'novo' | 'atualizado' | 'sem_mudanca' | null;
  /** Versão publicada pelo último upsert que mudou alguma coisa. */
  ultimaVersaoPublicada: number | null;
  /** Do `sent` do ML até a publicação do manifesto, em milissegundos. */
  ultimaLatenciaTotalMs: number | null;
  ultimoDrenoEm: string | null;
  /** Eventos ainda não processados. Persistentemente > 0 é sinal de problema. */
  pendentes: number;
  recebidas: number;
  duplicadas: number;
  rejeitadas: number;
  /**
   * Motivo da última recusa. Uma recusa é invisível do lado do ML — ele recebe
   * 200 e considera a entrega boa —, então este é o único lugar em que
   * `application_id_divergente` aparece antes de alguém abrir o log.
   */
  ultimoMotivoRejeicao: string | null;
  ultimaRejeicaoEm: string | null;
  aplicadosNovos: number;
  aplicadosAtualizados: number;
  falhas: number;
  ultimoErro: string | null;
  ultimoErroEm: string | null;
}

export interface OrdersPage {
  alvo: Alvo;
  versao: number;
  totalRegistros: number;
  pageSize: number;
  items: OrderSlim[];
  nextCursor: string | null;
  servedFrom: 'atual' | 'previous';
}

/** Resultados de erro controlados — a rota traduz para HTTP. */
export type ReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'not_ready' }
  | { ok: false; code: 'invalid_cursor' }
  | { ok: false; code: 'snapshot_changed'; versao: number; totalRegistros: number }
  | { ok: false; code: 'inconsistente' }; // chunk ausente/ inválido (erro controlado)

// ── STATUS ──────────────────────────────────────────────────────────────────

function idadeEmSegundos(updatedAt: string | null): number | null {
  if (!updatedAt) return null;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

/**
 * Projeção pública de manifesto + SyncStatus + telemetria de tempo real.
 * Nunca devolve os objetos crus, nem chave, nem chunk, nem credencial.
 *
 * O bloco `tempoReal` é lido só para o alvo `ativos`: é o único que a callback
 * de notificações mantém. Em `cancelados` ele vem zerado e `habilitado: false`,
 * o que é a verdade — cancelados vivem da reconciliação.
 */
export async function getReadStatus(
  cache: Cache,
  alvo: Alvo,
  opts: { notificacoesHabilitadas?: boolean } = {}
): Promise<OrdersReadStatus> {
  const man = await readManifest(cache, alvo);
  const st = await readStatus(cache, alvo);
  const updatedAt = man?.updatedAt ?? null;

  let tempoReal: OrdersRealtimeStatus = {
    habilitado: false,
    ultimaNotificacaoEm: null, ultimaNotificacaoTopico: null, ultimaNotificacaoPedido: null,
    ultimaNotificacaoSent: null, ultimoAckMs: null, ultimoDrenoPedidoEm: null,
    ultimoPedidoAtualizadoId: null, ultimoPedidoAtualizadoEm: null, ultimaAcao: null,
    ultimaVersaoPublicada: null, ultimaLatenciaTotalMs: null,
    ultimoDrenoEm: null, pendentes: 0,
    recebidas: 0, duplicadas: 0, rejeitadas: 0,
    ultimoMotivoRejeicao: null, ultimaRejeicaoEm: null,
    aplicadosNovos: 0, aplicadosAtualizados: 0, falhas: 0,
    ultimoErro: null, ultimoErroEm: null,
  };

  if (alvo === 'ativos') {
    const [rec, proc, pendentes] = await Promise.all([
      lerObsRecebimento(cache),
      lerObsProcessamento(cache),
      tamanhoFila(cache),
    ]);
    tempoReal = {
      habilitado: opts.notificacoesHabilitadas === true,
      ultimaNotificacaoEm: rec.ultimaNotificacaoEm,
      ultimaNotificacaoTopico: rec.ultimaNotificacaoTopico,
      ultimaNotificacaoPedido: rec.ultimaNotificacaoPedido,
      ultimaNotificacaoSent: rec.ultimaNotificacaoSent,
      ultimoAckMs: rec.ultimoAckMs,
      ultimoDrenoPedidoEm: rec.ultimoDrenoPedidoEm,
      ultimoPedidoAtualizadoId: proc.ultimoPedidoAtualizadoId,
      ultimoPedidoAtualizadoEm: proc.ultimoPedidoAtualizadoEm,
      ultimaAcao: proc.ultimaAcao,
      ultimaVersaoPublicada: proc.ultimaVersaoPublicada,
      ultimaLatenciaTotalMs: proc.ultimaLatenciaTotalMs,
      ultimoDrenoEm: proc.ultimoDrenoEm,
      pendentes,
      recebidas: rec.totalRecebidas,
      duplicadas: rec.totalDuplicadas,
      rejeitadas: rec.totalRejeitadas,
      ultimoMotivoRejeicao: rec.ultimoMotivoRejeicao,
      ultimaRejeicaoEm: rec.ultimaRejeicaoEm,
      aplicadosNovos: proc.totalNovos,
      aplicadosAtualizados: proc.totalAtualizados,
      falhas: proc.totalFalhas,
      ultimoErro: proc.ultimoErro,
      ultimoErroEm: proc.ultimoErroEm,
    };
  }

  return {
    alvo,
    versao: man?.versao ?? null,
    totalRegistros: man?.totalRegistros ?? 0,
    newestDate: man?.newestDate ?? null,
    oldestDate: man?.oldestDate ?? null,
    updatedAt,
    origem: man?.origem ?? null,
    partial: st?.emAndamento ?? false,
    lastResult: st?.lastResult ?? null,
    lastSyncAt: st?.lastSyncAt ?? null,
    idadeSegundos: idadeEmSegundos(updatedAt),
    tempoReal,
  };
}

// ── LISTAGEM ────────────────────────────────────────────────────────────────

export function normalizarPageSize(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isInteger(n) || n < PAGE_SIZE_MIN) return PAGE_SIZE_DEFAULT;
  if (n > PAGE_SIZE_MAX) return PAGE_SIZE_MAX;
  return n;
}

/**
 * Escolhe o manifesto que atende o cursor (D3/F2):
 * - sem cursor: manifesto atual (offset 0, versão atual);
 * - cursor.v === atual.versao: atual;
 * - cursor.v === previous.versao: previous;
 * - senão: snapshot_changed (aponta a versão atual para o cliente reiniciar).
 */
async function resolverManifesto(
  cache: Cache,
  alvo: Alvo,
  cursor: CursorData | null
): Promise<
  | { tipo: 'ok'; man: OrdersManifest; servedFrom: 'atual' | 'previous'; offset: number }
  | { tipo: 'not_ready' }
  | { tipo: 'snapshot_changed'; versao: number; totalRegistros: number }
> {
  const atual = await readManifest(cache, alvo);
  if (!atual) return { tipo: 'not_ready' };

  if (cursor === null) {
    return { tipo: 'ok', man: atual, servedFrom: 'atual', offset: 0 };
  }

  if (cursor.v === atual.versao) {
    return { tipo: 'ok', man: atual, servedFrom: 'atual', offset: cursor.o };
  }

  const previous = await readPreviousManifest(cache, alvo);
  if (previous && cursor.v === previous.versao) {
    return { tipo: 'ok', man: previous, servedFrom: 'previous', offset: cursor.o };
  }

  // Cursor mais antigo que o previous (ou sem previous): reiniciar na versão atual.
  return { tipo: 'snapshot_changed', versao: atual.versao, totalRegistros: atual.totalRegistros };
}

/**
 * Localiza (índice do chunk, posição dentro dele) para um offset global.
 *
 * Quando o manifesto declara `chunkCounts`, andamos pelos tamanhos REAIS. Isso
 * é obrigatório desde o upsert por notificação: ele reescreve UM chunk em vez
 * do snapshot inteiro, e esse chunk fica com um pedido a mais que os demais.
 * Derivar a posição por `chunkSize` nesse manifesto pularia — ou repetiria — um
 * pedido a cada página.
 *
 * Sem `chunkCounts` (manifestos publicados antes desta fase) mantemos a conta
 * antiga por `chunkSize`, que vale porque a publicação canônica fatia em blocos
 * uniformes.
 */
function localizar(man: OrdersManifest, offset: number): { chunkIdx: number; posNoChunk: number } {
  const counts = man.chunkCounts;
  if (Array.isArray(counts) && counts.length === man.chunks.length) {
    let restante = offset;
    for (let i = 0; i < counts.length; i++) {
      const n = counts[i];
      if (restante < n) return { chunkIdx: i, posNoChunk: restante };
      restante -= n;
    }
    return { chunkIdx: man.chunks.length, posNoChunk: 0 }; // além do fim
  }
  const chunkSize = man.chunkSize > 0 ? man.chunkSize : 1;
  return { chunkIdx: Math.floor(offset / chunkSize), posNoChunk: offset % chunkSize };
}

/**
 * Lê os itens em [offset, offset+pageSize) tocando SOMENTE os chunks necessários
 * (1 ou mais, conforme pageSize/chunkSize), via readChunkByKey — nunca readSnapshot.
 * Avança por chunks consecutivos a partir do índice localizado até preencher a
 * página ou acabar, e por isso não depende de o último chunk estar cheio.
 */
async function lerJanela(
  cache: Cache,
  man: OrdersManifest,
  offset: number,
  pageSize: number
): Promise<OrderSlim[]> {
  const itens: OrderSlim[] = [];
  if (offset >= man.totalRegistros) return itens;

  let { chunkIdx, posNoChunk } = localizar(man, offset);

  while (itens.length < pageSize && chunkIdx < man.chunks.length) {
    const chunk = await readChunkByKey(cache, man.chunks[chunkIdx]); // 1 GET
    for (let i = posNoChunk; i < chunk.length && itens.length < pageSize; i++) {
      itens.push(chunk[i]);
    }
    chunkIdx++;
    posNoChunk = 0;
  }
  return itens;
}

export async function getPage(
  cache: Cache,
  alvo: Alvo,
  rawCursor: string | null,
  rawPageSize: unknown
): Promise<ReadResult<OrdersPage>> {
  // 1) cursor
  let cursor: CursorData | null = null;
  if (rawCursor !== null && rawCursor !== undefined && rawCursor !== '') {
    try {
      cursor = decodeCursor(rawCursor);
    } catch (e) {
      if (e instanceof InvalidCursorError) return { ok: false, code: 'invalid_cursor' };
      throw e;
    }
    // alvo do cursor deve bater com o alvo da query (não misturar coleções)
    if (cursor.a !== alvo) return { ok: false, code: 'invalid_cursor' };
  }

  const pageSize = normalizarPageSize(rawPageSize);

  // 2) versão/manifesto
  const r = await resolverManifesto(cache, alvo, cursor);
  if (r.tipo === 'not_ready') return { ok: false, code: 'not_ready' };
  if (r.tipo === 'snapshot_changed') {
    return { ok: false, code: 'snapshot_changed', versao: r.versao, totalRegistros: r.totalRegistros };
  }

  const { man, servedFrom, offset } = r;

  // offset além do total → página vazia terminal (defensivo; cursores normais não chegam aqui)
  if (offset >= man.totalRegistros) {
    return {
      ok: true,
      value: {
        alvo, versao: man.versao, totalRegistros: man.totalRegistros,
        pageSize, items: [], nextCursor: null, servedFrom,
      },
    };
  }

  // 3) janela (só os chunks necessários)
  let items: OrderSlim[];
  try {
    items = await lerJanela(cache, man, offset, pageSize);
  } catch {
    // chunk ausente/ inválido → erro controlado, sem vazar chave/detalhe interno
    return { ok: false, code: 'inconsistente' };
  }

  // 4) nextCursor: null ao atingir totalRegistros
  const proximoOffset = offset + items.length;
  const nextCursor =
    proximoOffset >= man.totalRegistros
      ? null
      : encodeCursor({ v: man.versao, o: proximoOffset, a: alvo });

  return {
    ok: true,
    value: { alvo, versao: man.versao, totalRegistros: man.totalRegistros, pageSize, items, nextCursor, servedFrom },
  };
}