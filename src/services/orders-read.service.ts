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
  origem: 'full' | 'incremental' | null;
  partial: boolean;
  lastResult: string | null;
  lastSyncAt: string | null;
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

/** Projeção pública de manifesto + SyncStatus. Nunca devolve os objetos crus. */
export async function getReadStatus(cache: Cache, alvo: Alvo): Promise<OrdersReadStatus> {
  const man = await readManifest(cache, alvo);
  const st = await readStatus(cache, alvo);
  return {
    alvo,
    versao: man?.versao ?? null,
    totalRegistros: man?.totalRegistros ?? 0,
    newestDate: man?.newestDate ?? null,
    oldestDate: man?.oldestDate ?? null,
    updatedAt: man?.updatedAt ?? null,
    origem: man?.origem ?? null,
    partial: st?.emAndamento ?? false,
    lastResult: st?.lastResult ?? null,
    lastSyncAt: st?.lastSyncAt ?? null,
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
 * Lê os itens em [offset, offset+pageSize) tocando SOMENTE os chunks necessários
 * (1 ou mais, conforme pageSize/chunkSize), via readChunkByKey — nunca readSnapshot.
 * Assume chunks de tamanho `man.chunkSize`, exceto possivelmente o último. Para
 * robustez (não depender do último chunk ter tamanho cheio), avança por chunks
 * consecutivos a partir do índice derivado até preencher a página ou acabar.
 */
async function lerJanela(
  cache: Cache,
  man: OrdersManifest,
  offset: number,
  pageSize: number
): Promise<OrderSlim[]> {
  const itens: OrderSlim[] = [];
  if (offset >= man.totalRegistros) return itens;

  const chunkSize = man.chunkSize > 0 ? man.chunkSize : 1;
  let chunkIdx = Math.floor(offset / chunkSize);
  let posNoChunk = offset % chunkSize;

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