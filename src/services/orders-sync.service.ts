/**
 * orders-sync.service — orquestra a sincronização de pedidos do ML com o Redis.
 * NÃO conhece Upstash nem HTTP: recebe `Cache` e um `FetchOrdersPage` por
 * injeção. O mlFetch real é injetado só na rota admin. Usa orders-store para
 * toda persistência (única camada que conhece o layout de chaves) e
 * orders.service (Fase 4a) para toSlim/dedupById — sem alterá-los.
 *
 * Garantias (decisões obrigatórias):
 * - Nenhum erro de página é engolido: fetch falho → retries → passo retomável.
 * - PROGRESSO NUNCA VIVE EM BUFFER LOCAL entre invocações. Toda página
 *   confirmada da invocação é gravada num BUILD chunk isolado
 *   (orders:build:chunk:{jobId}:{i}) ANTES de o committedOffset avançar.
 *   Invariante: página buscada → toSlim → build chunk gravado → chave
 *   registrada no job → committedOffset = próximo offset real da API → job
 *   persistido.
 * - Full E incremental são jobs RETOMÁVEIS com committedOffset. Nenhum dos
 *   dois publica antes de a varredura terminar (achou conhecido / atingiu
 *   total / página vazia). Um passo parcial retorna { concluido:false,
 *   retomavel:true, motivo:'parcial' } e NÃO troca o manifesto publicado.
 * - Rebuild parcial escreve SÓ em build chunks; writeChunk (chaves publicadas)
 *   só na publicação final canônica, com ORDERS_CHUNK_SIZE.
 * - Dedup por dedupById (primeiro visto vence). Tudo persistido passa por
 *   toSlim. Sem scan/keys/mget. Sem teto legado de 8000.
 * - Um job em andamento para o alvo é RETOMADO; uma chamada com modo diferente
 *   não sobrescreve o job (retorna motivo:'job_em_andamento').
 */
import { randomBytes } from 'node:crypto';
import type { Cache } from '../lib/cache/cache.js';
import { getEnv } from '../config/env.js';
import { toSlim, dedupById, type OrderInput, type OrderSlim } from './orders.service.js';
import {
  type Alvo,
  type OrdersManifest,
  readManifest,
  readSnapshot,
  readChunkByKey,
  writeChunk,
  writeBuildChunk,
  publishManifest,
  deleteBuildChunks,
} from '../lib/orders-store.js';

const LOCK_KEY = 'orders:sync:lock';
const jobKey = (alvo: Alvo) => `orders:sync:job:${alvo}`;
const statusKey = (alvo: Alvo) => `orders:sync:status:${alvo}`;
const LIMIT = 50;

export interface FetchOrdersPageParams {
  offset: number;
  limit: number;
  status?: 'cancelled';
}
export type FetchOrdersPage = (
  params: FetchOrdersPageParams
) => Promise<{ results: OrderInput[]; total: number }>;

export interface SyncJob {
  jobId: string;
  modo: 'full' | 'incremental';
  alvo: Alvo;
  /** Offset CONFIRMADO: todas as páginas até aqui estão em build chunks gravados. */
  committedOffset: number;
  /** Chaves de build chunk já persistidas (NÃO guarda pedidos — só chaves). */
  chunkKeys: string[];
  /** Total reportado pela API na última página lida (para saber quando encerra). */
  total: number | null;
  /** (incremental) versão do manifesto base sobre o qual o job foi iniciado. */
  baseManifestVersion: number | null;
  iniciadoEm: string;
}

export interface SyncStatus {
  ultimaVersao: number | null;
  totalRegistros: number;
  newestDate: string | null;
  lastSyncAt: string | null;
  lastResult: 'ok' | 'parcial' | 'erro_parcial' | 'sem_novos' | 'sync_em_andamento' | 'job_em_andamento';
  emAndamento: boolean;
}

export interface SyncStepResult {
  ok: boolean;
  concluido: boolean; // true = snapshot publicado nesta invocação
  retomavel: boolean;
  committedOffset: number;
  paginasLidas: number;
  novosPedidos: number;
  motivo?: string;
}

interface SyncOpts {
  alvo?: Alvo;
  modo?: 'full' | 'incremental';
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── página com retries ──────────────────────────────────────────────────────
async function fetchPageComRetry(
  fetchPage: FetchOrdersPage,
  params: FetchOrdersPageParams,
  retries: number
): Promise<{ results: OrderInput[]; total: number }> {
  let ultimoErro: unknown;
  for (let tentativa = 0; tentativa <= retries; tentativa++) {
    try {
      const page = await fetchPage(params);
      // Validação defensiva: uma resposta malformada NÃO pode virar sync
      // "concluído" silencioso. Falha aqui entra no mecanismo de retries e,
      // esgotado, vira erro_parcial retomável.
      if (!page || !Array.isArray(page.results)) {
        throw new Error('Resposta do ML sem results[] válido.');
      }
      const total = page.total;
      if (!Number.isInteger(total) || !Number.isFinite(total) || total < 0) {
        throw new Error(`paging.total inválido do ML: ${String(total)}.`);
      }
      return { results: page.results, total };
    } catch (e) {
      ultimoErro = e;
      if (tentativa < retries) await sleep(200 * (tentativa + 1));
    }
  }
  throw ultimoErro instanceof Error ? ultimoErro : new Error('Falha ao buscar página do ML.');
}

// ── job persistence ─────────────────────────────────────────────────────────
async function readJob(cache: Cache, alvo: Alvo): Promise<SyncJob | null> {
  const raw = await cache.get(jobKey(alvo));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as SyncJob;
  } catch {
    return null;
  }
}
async function writeJob(cache: Cache, job: SyncJob): Promise<void> {
  await cache.set(jobKey(job.alvo), JSON.stringify(job));
}
async function clearJob(cache: Cache, alvo: Alvo): Promise<void> {
  await cache.del(jobKey(alvo));
}
async function writeStatus(cache: Cache, alvo: Alvo, status: SyncStatus): Promise<void> {
  await cache.set(statusKey(alvo), JSON.stringify(status));
}
export async function readStatus(cache: Cache, alvo: Alvo): Promise<SyncStatus | null> {
  const raw = await cache.get(statusKey(alvo));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as SyncStatus;
  } catch {
    return null;
  }
}

// ── helpers de data e fatiamento ────────────────────────────────────────────
function newest(pedidos: OrderSlim[]): string | null {
  let max: string | null = null;
  for (const p of pedidos) if (p.date_created && (max === null || p.date_created > max)) max = p.date_created;
  return max;
}
function oldest(pedidos: OrderSlim[]): string | null {
  let min: string | null = null;
  for (const p of pedidos) if (p.date_created && (min === null || p.date_created < min)) min = p.date_created;
  return min;
}
function fatiar<T>(arr: T[], tamanho: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += tamanho) out.push(arr.slice(i, i + tamanho));
  return out;
}

/** Lê e concatena todos os build chunks de um job (fonte no Redis, não em memória). */
async function lerBuildChunks(cache: Cache, keys: string[]): Promise<OrderSlim[]> {
  const out: OrderSlim[] = [];
  for (const key of keys) out.push(...(await readChunkByKey(cache, key)));
  return out;
}

/**
 * Publica um conjunto completo de pedidos slim como nova versão canônica.
 * RECHUNK com ORDERS_CHUNK_SIZE, gravando em chaves PUBLICADAS (writeChunk).
 * Grava todos os chunks ANTES de trocar o manifesto (retenção na publishManifest).
 */
async function publicarSnapshot(
  cache: Cache,
  alvo: Alvo,
  pedidos: OrderSlim[],
  origem: 'full' | 'incremental',
  chunkSize: number
): Promise<OrdersManifest> {
  const manifestoAtual = await readManifest(cache, alvo);
  const novaVersao = (manifestoAtual?.versao ?? 0) + 1;

  const fatias = fatiar(pedidos, chunkSize);
  const chunks: string[] = [];
  for (let i = 0; i < fatias.length; i++) {
    chunks.push(await writeChunk(cache, alvo, novaVersao, i, fatias[i]));
  }

  const manifesto: OrdersManifest = {
    versao: novaVersao,
    chunks,
    totalRegistros: pedidos.length,
    newestDate: newest(pedidos),
    oldestDate: oldest(pedidos),
    chunkSize,
    updatedAt: new Date().toISOString(),
    origem,
  };
  await publishManifest(cache, alvo, manifesto);
  return manifesto;
}

// ── passo público ───────────────────────────────────────────────────────────
export async function runSyncStep(
  cache: Cache,
  fetchPage: FetchOrdersPage,
  opts: SyncOpts = {}
): Promise<SyncStepResult> {
  const env = getEnv();
  const alvo: Alvo = opts.alvo ?? 'ativos';
  const cfg = {
    chunkSize: env.ORDERS_CHUNK_SIZE,
    maxPages: env.ORDERS_SYNC_MAX_PAGES,
    maxTotal: env.ORDERS_SYNC_MAX_TOTAL,
    retries: env.ORDERS_PAGE_RETRIES,
  };
  const statusFetch = alvo === 'cancelados' ? ('cancelled' as const) : undefined;

  const lockOwner = randomBytes(16).toString('hex');
  const gotLock = await cache.setNX(LOCK_KEY, lockOwner, env.ORDERS_SYNC_LOCK_TTL_S);
  if (!gotLock) {
    return retomavel('sync_em_andamento', 0, 0, 0);
  }

  try {
    const jobExistente = await readJob(cache, alvo);
    const manifestoPublicado = await readManifest(cache, alvo);

    // Controle de modo: um job em andamento manda. Chamada com modo diferente
    // NÃO sobrescreve o job.
    let modo: 'full' | 'incremental';
    if (jobExistente) {
      if (opts.modo && opts.modo !== jobExistente.modo) {
        return retomavel('job_em_andamento', jobExistente.committedOffset, 0, 0);
      }
      modo = jobExistente.modo;
    } else {
      modo = opts.modo ?? (manifestoPublicado ? 'incremental' : 'full');
    }

    if (modo === 'incremental') {
      return await passoIncremental(cache, fetchPage, alvo, statusFetch, cfg, jobExistente);
    }
    return await passoFull(cache, fetchPage, alvo, statusFetch, cfg, jobExistente);
  } finally {
    await cache.delIfEquals(LOCK_KEY, lockOwner);
  }
}

function retomavel(motivo: string, offset: number, paginas: number, novos: number): SyncStepResult {
  return { ok: motivo === 'parcial', concluido: false, retomavel: true, committedOffset: offset, paginasLidas: paginas, novosPedidos: novos, motivo };
}

interface Cfg { chunkSize: number; maxPages: number; maxTotal: number; retries: number }

/**
 * Varre páginas a partir do committedOffset do job, gravando CADA página
 * confirmada num build chunk e avançando o cursor. Retorna o desfecho da
 * varredura para o chamador decidir publicação.
 *
 * `pararEmConhecido`: predicate que, no incremental, sinaliza id já conhecido
 * (encerra a varredura). No full, nunca para por isso.
 * Retorna { encerrou, paginasLidas, coletados, erro? }.
 */
async function varrer(
  cache: Cache,
  fetchPage: FetchOrdersPage,
  job: SyncJob,
  status: 'cancelled' | undefined,
  cfg: Cfg,
  pararEmConhecido: (o: OrderInput) => boolean
): Promise<{
  encerrou: boolean;
  paginasLidas: number;
  coletados: number;
  erro?: string;
  limiteExcedido?: { total: number; limite: number };
}> {
  let offset = job.committedOffset;
  let chunkIndex = job.chunkKeys.length;
  let paginasLidas = 0;
  let coletados = 0;
  let total = job.total ?? Infinity;

  // Se o job já sabe o total de uma execução anterior e ele excede o limite,
  // aborta imediatamente (nada a publicar).
  if (Number.isFinite(total) && total > cfg.maxTotal) {
    return { encerrou: false, paginasLidas, coletados, limiteExcedido: { total, limite: cfg.maxTotal } };
  }

  while (paginasLidas < cfg.maxPages) {
    // Conclusão normal: cursor alcançou o total reportado pela API.
    if (offset >= total) {
      return { encerrou: true, paginasLidas, coletados };
    }
    let page: { results: OrderInput[]; total: number };
    try {
      page = await fetchPageComRetry(fetchPage, { offset, limit: LIMIT, status }, cfg.retries);
    } catch (e) {
      return { encerrou: false, paginasLidas, coletados, erro: e instanceof Error ? e.message : 'erro' };
    }
    total = page.total;
    job.total = total;
    paginasLidas++;

    // Limite de SEGURANÇA (não é conclusão): total real acima do teto → aborta
    // sem publicar, com erro explícito. Nada persistido nesta página é usado.
    if (total > cfg.maxTotal) {
      return { encerrou: false, paginasLidas, coletados, limiteExcedido: { total, limite: cfg.maxTotal } };
    }

    // Coleta respeitando o corte por id conhecido (incremental).
    const novosDaPagina: OrderSlim[] = [];
    let achouConhecido = false;
    for (const o of page.results) {
      if (pararEmConhecido(o)) { achouConhecido = true; break; }
      novosDaPagina.push(toSlim(o));
    }

    // Persistir o confirmado desta página num BUILD chunk ANTES de avançar.
    if (novosDaPagina.length > 0) {
      const key = await writeBuildChunk(cache, job.jobId, chunkIndex, novosDaPagina);
      chunkIndex++;
      job.chunkKeys.push(key);
      coletados += novosDaPagina.length;
    }

    if (achouConhecido) {
      // cursor avança até o offset desta página (parte dela consumida)
      job.committedOffset = offset + page.results.length;
      await writeJob(cache, job);
      return { encerrou: true, paginasLidas, coletados };
    }

    if (page.results.length === 0) {
      job.committedOffset = total;
      await writeJob(cache, job);
      return { encerrou: true, paginasLidas, coletados };
    }

    // Avança committedOffset para o PRÓXIMO offset real da API e persiste o job.
    offset += LIMIT;
    job.committedOffset = offset;
    await writeJob(cache, job);
  }

  // maxPages atingido sem encerrar: parcial, retomável.
  return { encerrou: false, paginasLidas, coletados };
}

// ── passo FULL ──────────────────────────────────────────────────────────────
async function passoFull(
  cache: Cache,
  fetchPage: FetchOrdersPage,
  alvo: Alvo,
  status: 'cancelled' | undefined,
  cfg: Cfg,
  jobExistente: SyncJob | null
): Promise<SyncStepResult> {
  const job: SyncJob = jobExistente ?? {
    jobId: randomBytes(8).toString('hex'),
    modo: 'full',
    alvo,
    committedOffset: 0,
    chunkKeys: [],
    total: null,
    baseManifestVersion: null,
    iniciadoEm: new Date().toISOString(),
  };
  if (!jobExistente) await writeJob(cache, job);

  const r = await varrer(cache, fetchPage, job, status, cfg, () => false);

  if (r.erro) {
    await writeStatus(cache, alvo, await statusResumo(cache, alvo, 'erro_parcial', false));
    return { ok: false, concluido: false, retomavel: true, committedOffset: job.committedOffset, paginasLidas: r.paginasLidas, novosPedidos: r.coletados, motivo: `erro_parcial: ${r.erro}` };
  }

  if (r.limiteExcedido) {
    return await abortarLimiteSeguranca(cache, alvo, job, r.limiteExcedido, r.paginasLidas);
  }

  if (!r.encerrou) {
    // Parcial: NÃO publica. Job persistido (build chunks + committedOffset).
    await writeStatus(cache, alvo, await statusResumo(cache, alvo, 'parcial', false));
    return { ok: true, concluido: false, retomavel: true, committedOffset: job.committedOffset, paginasLidas: r.paginasLidas, novosPedidos: r.coletados, motivo: 'parcial' };
  }

  // Concluído: ler todos os build chunks, dedup, publicar canônico, limpar.
  const todos = await lerBuildChunks(cache, job.chunkKeys);
  const unicos = dedupById(todos as unknown as OrderInput[]) as unknown as OrderSlim[];
  const manifesto = await publicarSnapshot(cache, alvo, unicos, 'full', cfg.chunkSize);
  await deleteBuildChunks(cache, job.chunkKeys);
  await clearJob(cache, alvo);
  await writeStatus(cache, alvo, {
    ultimaVersao: manifesto.versao, totalRegistros: manifesto.totalRegistros,
    newestDate: manifesto.newestDate, lastSyncAt: manifesto.updatedAt,
    lastResult: 'ok', emAndamento: false,
  });
  return { ok: true, concluido: true, retomavel: false, committedOffset: job.committedOffset, paginasLidas: r.paginasLidas, novosPedidos: unicos.length };
}

// ── passo INCREMENTAL ───────────────────────────────────────────────────────
async function passoIncremental(
  cache: Cache,
  fetchPage: FetchOrdersPage,
  alvo: Alvo,
  status: 'cancelled' | undefined,
  cfg: Cfg,
  jobExistente: SyncJob | null
): Promise<SyncStepResult> {
  const manifestoBase = await readManifest(cache, alvo);
  if (!manifestoBase) {
    // sem base: é uma carga inicial disfarçada → trata como full.
    return passoFull(cache, fetchPage, alvo, status, cfg, jobExistente);
  }

  // Job existente: confirmar que a base não mudou (não misturar snapshots).
  if (jobExistente && jobExistente.baseManifestVersion !== manifestoBase.versao) {
    // base trocou sob o job: descarta o job antigo e recomeça do zero.
    await deleteBuildChunks(cache, jobExistente.chunkKeys);
    await clearJob(cache, alvo);
    jobExistente = null;
  }

  const snapshotBase = await readSnapshot(cache, alvo);
  const conhecidos = new Set(snapshotBase.map(o => String(o.id)));

  const job: SyncJob = jobExistente ?? {
    jobId: randomBytes(8).toString('hex'),
    modo: 'incremental',
    alvo,
    committedOffset: 0,
    chunkKeys: [],
    total: null,
    baseManifestVersion: manifestoBase.versao,
    iniciadoEm: new Date().toISOString(),
  };
  if (!jobExistente) await writeJob(cache, job);

  const r = await varrer(cache, fetchPage, job, status, cfg, o => conhecidos.has(String(o.id)));

  if (r.erro) {
    await writeStatus(cache, alvo, await statusResumo(cache, alvo, 'erro_parcial', false));
    return { ok: false, concluido: false, retomavel: true, committedOffset: job.committedOffset, paginasLidas: r.paginasLidas, novosPedidos: r.coletados, motivo: `erro_parcial: ${r.erro}` };
  }

  if (r.limiteExcedido) {
    return await abortarLimiteSeguranca(cache, alvo, job, r.limiteExcedido, r.paginasLidas);
  }

  if (!r.encerrou) {
    // Parcial: NÃO publica; manifesto atual permanece intacto.
    await writeStatus(cache, alvo, await statusResumo(cache, alvo, 'parcial', false));
    return { ok: true, concluido: false, retomavel: true, committedOffset: job.committedOffset, paginasLidas: r.paginasLidas, novosPedidos: r.coletados, motivo: 'parcial' };
  }

  // Concluído: reunir novos dos build chunks, dedup, merge, publicar, limpar.
  const novos = await lerBuildChunks(cache, job.chunkKeys);
  if (novos.length === 0) {
    await deleteBuildChunks(cache, job.chunkKeys);
    await clearJob(cache, alvo);
    await writeStatus(cache, alvo, {
      ultimaVersao: manifestoBase.versao, totalRegistros: snapshotBase.length,
      newestDate: newest(snapshotBase), lastSyncAt: new Date().toISOString(),
      lastResult: 'sem_novos', emAndamento: false,
    });
    return { ok: true, concluido: false, retomavel: false, committedOffset: job.committedOffset, paginasLidas: r.paginasLidas, novosPedidos: 0, motivo: 'sem_novos' };
  }

  const merged = dedupById([...novos, ...snapshotBase] as unknown as OrderInput[]) as unknown as OrderSlim[];
  const manifesto = await publicarSnapshot(cache, alvo, merged, 'incremental', cfg.chunkSize);
  await deleteBuildChunks(cache, job.chunkKeys);
  await clearJob(cache, alvo);
  await writeStatus(cache, alvo, {
    ultimaVersao: manifesto.versao, totalRegistros: manifesto.totalRegistros,
    newestDate: manifesto.newestDate, lastSyncAt: manifesto.updatedAt,
    lastResult: 'ok', emAndamento: false,
  });
  return { ok: true, concluido: true, retomavel: false, committedOffset: job.committedOffset, paginasLidas: r.paginasLidas, novosPedidos: novos.length };
}

async function statusResumo(
  cache: Cache,
  alvo: Alvo,
  lastResult: SyncStatus['lastResult'],
  emAndamento: boolean
): Promise<SyncStatus> {
  const man = await readManifest(cache, alvo);
  return {
    ultimaVersao: man?.versao ?? null,
    totalRegistros: man?.totalRegistros ?? 0,
    newestDate: man?.newestDate ?? null,
    lastSyncAt: new Date().toISOString(),
    lastResult,
    emAndamento,
  };
}

/**
 * Limite de segurança excedido: paging.total > ORDERS_SYNC_MAX_TOTAL.
 * NÃO publica, NÃO conclui, mantém o snapshot publicado anterior intacto.
 * Descarta os build chunks e o job (não há como concluir este job enquanto o
 * total exceder o teto — deixá-lo vivo só reencontraria o mesmo limite). O
 * operador precisa elevar ORDERS_SYNC_MAX_TOTAL para prosseguir.
 */
async function abortarLimiteSeguranca(
  cache: Cache,
  alvo: Alvo,
  job: SyncJob,
  info: { total: number; limite: number },
  paginasLidas: number
): Promise<SyncStepResult> {
  await deleteBuildChunks(cache, job.chunkKeys);
  await clearJob(cache, alvo);
  await writeStatus(cache, alvo, await statusResumo(cache, alvo, 'erro_parcial', false));
  return {
    ok: false,
    concluido: false,
    retomavel: false,
    committedOffset: job.committedOffset,
    paginasLidas,
    novosPedidos: 0,
    motivo: `limite_seguranca_excedido: paging.total ${info.total} > ORDERS_SYNC_MAX_TOTAL ${info.limite}.`,
  };
}