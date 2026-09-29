/**
 * orders-backup.service — cópia de segurança do snapshot de pedidos de UMA
 * conta, e a restauração dela.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE EXISTE
 *
 * A carga completa (`modo: full`) publica o que o Mercado Livre devolve. Se
 * ele devolver menos pedidos do que o snapshot tinha, os que faltam saem. O
 * orders-store guarda a versão imediatamente anterior, mas só até a PRÓXIMA
 * publicação — e uma venda nova publica em segundos. `manifest:previous` não
 * serve de rede de segurança para uma operação que alguém vai conferir à mão.
 *
 * A cópia vive em chaves próprias (`orders:backup:*`), fora do ciclo de
 * publicação: nenhuma sincronização a lê, a apaga ou a rotaciona. Tem TTL,
 * para não ficar esquecida no Redis.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * GARANTIAS
 *
 * - Copiar NÃO altera o snapshot publicado: só lê e grava em `orders:backup:*`.
 * - A cópia é conferida depois de gravada (contagem e ids) antes de ser
 *   declarada pronta. Cópia incompleta não fica marcada como válida.
 * - Restaurar publica uma versão NOVA (maior que a atual) com o conteúdo da
 *   cópia. A versão nunca anda para trás: a tela e o cursor de paginação
 *   dependem de ela só crescer.
 * - Copiar e restaurar usam o MESMO lock da sincronização. Não rodam por cima
 *   de uma carga em andamento, e uma carga não roda por cima deles.
 * - Restaurar descarta um job de carga pendente: retomá-lo depois publicaria
 *   por cima do que acabou de ser restaurado.
 */
import { randomBytes } from 'node:crypto';
import type { Cache } from '../lib/cache/cache.js';
import { getEnv } from '../config/env.js';
import {
  type Alvo, type OrdersManifest,
  readManifest, readSnapshot, writeChunk, publishManifest,
} from '../lib/orders-store.js';
import type { OrderSlim } from './orders.service.js';
import { ORDERS_SYNC_LOCK_KEY, mesclarStatus } from './orders-sync.service.js';

/** Sete dias: tempo de sobra para conferir uma recarga, curto para não virar lixo. */
export const BACKUP_TTL_S = 7 * 24 * 3600;
const BLOCO = 500;

const chaveMeta = (alvo: Alvo) => `orders:backup:${alvo}:meta`;
const chaveBloco = (alvo: Alvo, id: string, i: number) => `orders:backup:${alvo}:${id}:${i}`;
const chaveJob = (alvo: Alvo) => `orders:sync:job:${alvo}`;

export interface BackupMeta {
  id: string;
  alvo: Alvo;
  criadoEm: string;
  /** Versão do snapshot no momento da cópia. */
  versaoOrigem: number;
  totalRegistros: number;
  newestDate: string | null;
  oldestDate: string | null;
  blocos: string[];
  /** Só `true` depois de a cópia ser relida e conferida. */
  conferido: boolean;
}

export type ResultadoBackup =
  | { ok: true; acao: 'backup'; backup: Omit<BackupMeta, 'blocos'> & { blocos: number } }
  | { ok: false; acao: 'backup'; motivo: 'sync_em_andamento' | 'sem_snapshot' | 'copia_divergente' };

export type ResultadoRestauracao =
  | { ok: true; acao: 'restaurar'; versaoAnterior: number | null; versaoPublicada: number; totalRegistros: number; deVersao: number }
  | { ok: false; acao: 'restaurar'; motivo: 'sync_em_andamento' | 'sem_backup' | 'backup_nao_conferido' | 'backup_incompleto' };

const publico = (m: BackupMeta) => ({ ...m, blocos: m.blocos.length });

async function comLock<T>(cache: Cache, ocupado: T, f: () => Promise<T>): Promise<T> {
  const dono = randomBytes(16).toString('hex');
  if (!(await cache.setNX(ORDERS_SYNC_LOCK_KEY, dono, getEnv().ORDERS_SYNC_LOCK_TTL_S))) return ocupado;
  try { return await f(); } finally { await cache.delIfEquals(ORDERS_SYNC_LOCK_KEY, dono); }
}

export async function lerBackup(cache: Cache, alvo: Alvo): Promise<BackupMeta | null> {
  const bruto = await cache.get(chaveMeta(alvo));
  if (bruto === null) return null;
  try {
    const m = JSON.parse(bruto) as BackupMeta;
    return m && Array.isArray(m.blocos) && typeof m.id === 'string' ? m : null;
  } catch { return null; }
}

async function lerBlocos(cache: Cache, meta: BackupMeta): Promise<OrderSlim[] | null> {
  const out: OrderSlim[] = [];
  for (const k of meta.blocos) {
    const bruto = await cache.get(k);
    if (bruto === null) return null;
    try {
      const arr = JSON.parse(bruto);
      if (!Array.isArray(arr)) return null;
      out.push(...(arr as OrderSlim[]));
    } catch { return null; }
  }
  return out;
}

/** Copia o snapshot publicado. Substitui a cópia anterior do mesmo alvo. */
export async function criarBackup(cache: Cache, alvo: Alvo = 'ativos'): Promise<ResultadoBackup> {
  return comLock<ResultadoBackup>(cache, { ok: false, acao: 'backup', motivo: 'sync_em_andamento' }, async () => {
    const man = await readManifest(cache, alvo);
    if (!man) return { ok: false, acao: 'backup', motivo: 'sem_snapshot' };
    const pedidos = await readSnapshot(cache, alvo);   // lança se algum chunk faltar: não se copia snapshot quebrado

    const id = `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
    const blocos: string[] = [];
    for (let i = 0; i * BLOCO < Math.max(pedidos.length, 1); i++) {
      const k = chaveBloco(alvo, id, i);
      await cache.set(k, JSON.stringify(pedidos.slice(i * BLOCO, (i + 1) * BLOCO)), BACKUP_TTL_S);
      blocos.push(k);
    }
    const meta: BackupMeta = {
      id, alvo, criadoEm: new Date().toISOString(), versaoOrigem: man.versao,
      totalRegistros: pedidos.length, newestDate: man.newestDate, oldestDate: man.oldestDate,
      blocos, conferido: false,
    };

    // Relê o que gravou. Só então a cópia vale.
    const relido = await lerBlocos(cache, meta);
    const igual = relido !== null && relido.length === pedidos.length
      && relido.every((p, i) => String(p.id) === String(pedidos[i].id))
      && JSON.stringify(relido) === JSON.stringify(pedidos);
    if (!igual || pedidos.length !== man.totalRegistros) {
      for (const k of blocos) await cache.del(k);
      return { ok: false, acao: 'backup', motivo: 'copia_divergente' };
    }

    const anterior = await lerBackup(cache, alvo);
    meta.conferido = true;
    await cache.set(chaveMeta(alvo), JSON.stringify(meta), BACKUP_TTL_S);
    if (anterior) for (const k of anterior.blocos) if (!blocos.includes(k)) await cache.del(k);
    return { ok: true, acao: 'backup', backup: publico(meta) };
  });
}

/** Publica o conteúdo da cópia como versão nova. A cópia continua guardada. */
export async function restaurarBackup(cache: Cache, alvo: Alvo = 'ativos'): Promise<ResultadoRestauracao> {
  return comLock<ResultadoRestauracao>(cache, { ok: false, acao: 'restaurar', motivo: 'sync_em_andamento' }, async () => {
    const meta = await lerBackup(cache, alvo);
    if (!meta) return { ok: false, acao: 'restaurar', motivo: 'sem_backup' };
    if (!meta.conferido) return { ok: false, acao: 'restaurar', motivo: 'backup_nao_conferido' };
    const pedidos = await lerBlocos(cache, meta);
    if (pedidos === null || pedidos.length !== meta.totalRegistros) {
      return { ok: false, acao: 'restaurar', motivo: 'backup_incompleto' };
    }

    const atual = await readManifest(cache, alvo);
    const versao = Math.max(atual?.versao ?? 0, meta.versaoOrigem) + 1;
    const tamanho = getEnv().ORDERS_CHUNK_SIZE;
    const chunks: string[] = []; const counts: number[] = [];
    for (let i = 0; i * tamanho < Math.max(pedidos.length, 1); i++) {
      const fatia = pedidos.slice(i * tamanho, (i + 1) * tamanho);
      chunks.push(await writeChunk(cache, alvo, versao, i, fatia));
      counts.push(fatia.length);
    }
    const man: OrdersManifest = {
      versao, chunks, totalRegistros: pedidos.length,
      newestDate: meta.newestDate, oldestDate: meta.oldestDate,
      chunkSize: tamanho, updatedAt: new Date().toISOString(), origem: 'full', chunkCounts: counts,
    };
    await publishManifest(cache, alvo, man);
    await cache.del(chaveJob(alvo));   // carga pendente não pode ser retomada por cima da restauração
    await mesclarStatus(cache, alvo, {
      ultimaVersao: versao, totalRegistros: pedidos.length, newestDate: meta.newestDate,
      lastSyncAt: new Date().toISOString(), lastResult: 'ok', emAndamento: false,
    });
    return { ok: true, acao: 'restaurar', versaoAnterior: atual?.versao ?? null, versaoPublicada: versao, totalRegistros: pedidos.length, deVersao: meta.versaoOrigem };
  });
}
