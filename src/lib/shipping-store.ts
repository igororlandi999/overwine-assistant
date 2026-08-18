/**
 * shipping-store — ÚNICA camada que conhece o layout das chaves Redis do mapa
 * de LOGÍSTICA POR ENVIO. Espelha orders-store e items-store: fala só com a
 * interface Cache, nunca com Upstash direto, nunca com scan/keys.
 *
 * Layout:
 *   ship:logi:manifest          manifesto PUBLICADO (ponteiro único)
 *   ship:logi:chunk:{versao}:{i}  chunk = JSON de Array<[shipmentId, logisticType]>
 *   ship:logi:lock              lock de sincronização (setNX/delIfEquals)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE ESTE MAPA EXISTE
 *
 * A API de pedidos do Mercado Livre devolve `shipping.id`, mas NÃO
 * `shipping.logistic_type`. O snapshot de pedidos grava `logistic_type: null`
 * em 100% dos registros — verificado em 18/08/2026 sobre 3.783 vendas.
 *
 * Consequência: `ehVendaFull(null)` é false, então o cálculo de custo somava
 * R$ 3,00 de embalagem em TODA unidade vendida, inclusive nas do Full, onde o
 * Mercado Livre embala. Com ~82% da operação em Full, a margem reportada
 * estava sistematicamente subestimada.
 *
 * O `logistic_type` só existe em GET /shipments/{id}, uma chamada por envio.
 * Este mapa guarda o resultado para que a busca aconteça UMA VEZ na vida de
 * cada envio.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE UM MAPA SEPARADO, E NÃO UM CAMPO NO SNAPSHOT DE PEDIDOS
 *
 * Reescrever o snapshot de pedidos a cada envio resolvido significaria
 * reprocessar milhares de registros para gravar um campo, com risco de
 * corromper a fonte de verdade das vendas. O mapa é aditivo e descartável: se
 * ele sumir, a margem volta a ser a de hoje (subestimada) e nada mais quebra.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IMUTABILIDADE
 *
 * O `logistic_type` de um envio é decidido no despacho e não muda depois. Por
 * isso um id resolvido NUNCA é buscado de novo, e o mapa não tem TTL.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LIMITE CONHECIDO
 *
 * A publicação REESCREVE todos os chunks. Com 3.521 envios (~105 KB) isso é
 * trivial. Acima de ~50.000 envios, o custo de reescrita passa a incomodar e o
 * store precisa virar append-only. Está documentado aqui de propósito: é uma
 * decisão de escala, não um descuido.
 */
import type { Cache } from './cache/cache.js';

/** Entrada do mapa: [shipmentId, logisticType]. Tupla para economizar bytes. */
export type EntradaLogistica = [string, string];

export interface ManifestoLogistica {
  versao: number;
  /** Chaves Redis dos chunks, na ordem de leitura. */
  chunks: string[];
  /** Total de envios resolvidos. Redundante com os chunks, útil para status. */
  total: number;
  chunkSize: number;
  updatedAt: string;
}

export const CHAVE_MANIFESTO = 'ship:logi:manifest';
export const CHAVE_LOCK = 'ship:logi:lock';

/** Entradas por chunk. 2.000 × ~30 bytes ≈ 60 KB, folgado no limite do Upstash. */
export const CHUNK_SIZE = 2000;

function chaveChunk(versao: number, i: number): string {
  return `ship:logi:chunk:${versao}:${i}`;
}

function manifestoValido(v: unknown): v is ManifestoLogistica {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.versao === 'number' && Number.isInteger(m.versao) && m.versao > 0 &&
    Array.isArray(m.chunks) && m.chunks.every(c => typeof c === 'string') &&
    typeof m.total === 'number' && Number.isInteger(m.total) && m.total >= 0 &&
    typeof m.chunkSize === 'number' && m.chunkSize > 0 &&
    typeof m.updatedAt === 'string'
  );
}

export async function lerManifesto(cache: Cache): Promise<ManifestoLogistica | null> {
  const bruto = await cache.get(CHAVE_MANIFESTO);
  if (bruto === null) return null;
  try {
    const v: unknown = JSON.parse(bruto);
    return manifestoValido(v) ? v : null;
  } catch {
    // Manifesto corrompido é tratado como ausente: o mapa é reconstruível, e
    // derrubar o cálculo por causa dele seria pior que recomeçar do zero.
    return null;
  }
}

/**
 * Mapa completo shipmentId → logisticType. Devolve mapa VAZIO quando não há
 * manifesto — nunca lança. Chunk ausente ou ilegível é PULADO: um mapa parcial
 * degrada a margem de alguns pedidos, enquanto lançar derrubaria a consulta
 * inteira.
 */
export async function lerMapaLogistica(cache: Cache): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  const manifesto = await lerManifesto(cache);
  if (manifesto === null) return mapa;

  for (const chave of manifesto.chunks) {
    const bruto = await cache.get(chave);
    if (bruto === null) continue;
    try {
      const entradas: unknown = JSON.parse(bruto);
      if (!Array.isArray(entradas)) continue;
      for (const e of entradas) {
        if (!Array.isArray(e) || e.length !== 2) continue;
        const [id, tipo] = e as [unknown, unknown];
        if (typeof id === 'string' && id !== '' && typeof tipo === 'string' && tipo !== '') {
          mapa.set(id, tipo);
        }
      }
    } catch {
      continue;
    }
  }
  return mapa;
}

/**
 * Publica o mapa inteiro numa versão NOVA e só então troca o manifesto. Os
 * chunks antigos ficam órfãos de propósito: uma leitura concorrente que já
 * pegou o manifesto anterior continua encontrando os chunks dela.
 */
export async function publicarMapaLogistica(
  cache: Cache,
  mapa: Map<string, string>,
  agora: Date = new Date()
): Promise<ManifestoLogistica> {
  const anterior = await lerManifesto(cache);
  const versao = (anterior?.versao ?? 0) + 1;

  const entradas: EntradaLogistica[] = [...mapa.entries()]
    .filter(([id, tipo]) => id !== '' && tipo !== '')
    // Ordem estável: o mesmo mapa produz sempre os mesmos chunks.
    .sort((a, b) => a[0].localeCompare(b[0]));

  const chunks: string[] = [];
  for (let i = 0; i * CHUNK_SIZE < entradas.length; i++) {
    const chave = chaveChunk(versao, i);
    await cache.set(chave, JSON.stringify(entradas.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)));
    chunks.push(chave);
  }

  const manifesto: ManifestoLogistica = {
    versao,
    chunks,
    total: entradas.length,
    chunkSize: CHUNK_SIZE,
    updatedAt: agora.toISOString(),
  };
  await cache.set(CHAVE_MANIFESTO, JSON.stringify(manifesto));
  return manifesto;
}