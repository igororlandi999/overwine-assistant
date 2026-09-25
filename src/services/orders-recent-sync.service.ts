/**
 * orders-recent-sync.service — o passo RÁPIDO de sincronização de pedidos.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE EXISTE
 *
 * O passo incremental (orders-sync.service) revisita os 250 pedidos conhecidos
 * mais recentes a cada chamada: 5 páginas do Mercado Livre, e com UM pedido
 * novo ele não cabe em ORDERS_SYNC_MAX_PAGES — termina `parcial`, sem publicar,
 * e só publica na chamada seguinte. Como caminho de "aba aberta pedindo
 * atualização a cada meio minuto" isso custa 5 chamadas por checagem e leva
 * duas checagens para uma venda aparecer.
 *
 * Este passo faz o oposto: lê UMA página (os 50 pedidos mais recentes, na
 * ordem que a API já devolve) e compara com uma ASSINATURA da última página
 * que vimos. Igual → nada mudou, e nem os chunks do snapshot foram lidos.
 * Diferente → aplica só o que mudou, pedido a pedido, com o mesmo `upsertPedido`
 * do webhook — 1 chunk lido, 1 escrito, manifesto novo — e guarda a assinatura
 * nova. Uma venda custa 1 chamada ao ML mais o upsert daquela venda: trabalho
 * proporcional ao pedido novo, e não ao histórico.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O QUE ELE NÃO COBRE, E QUEM COBRE
 *
 * Só a primeira página, ordenada por data de criação. Um pedido de três dias
 * atrás que mudou de status não aparece aqui. Isso é responsabilidade da
 * revisão profunda (o passo incremental, com sua janela de 250 conhecidos),
 * que o auto-refresh dispara a cada ORDERS_REFRESH_REVISAO_S, e da
 * reconciliação do GitHub Actions. Os dois caminhos publicam versão nova e
 * invalidam a assinatura por `versao`, então a próxima checagem rápida
 * reconcilia a assinatura sem ter que confiar nela.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ASSINATURA, NÃO ÍNDICE
 *
 * `orders:sync:head` guarda `{ versao, assinatura }`: a versão do manifesto
 * sobre a qual a assinatura vale e o SHA-256 da forma canônica dos 50
 * pedidos. Mais barato que um índice id→hash e igualmente suficiente: a
 * pergunta é "a primeira página mudou desde a última vez?", e um hash responde.
 * Quando a versão publicada muda por fora (webhook, reconciliação), a
 * assinatura deixa de valer e o caminho de aplicação roda uma vez — encontra
 * tudo igual, não publica, e grava a assinatura sob a versão nova.
 *
 * Segura o MESMO lock dos outros escritores. Nunca reconstrói nada: sem
 * manifesto base devolve `sem_snapshot`.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Cache } from '../lib/cache/cache.js';
import { getEnv } from '../config/env.js';
import { toSlim, type OrderSlim } from './orders.service.js';
import {
  ORDERS_SYNC_LOCK_KEY,
  fetchPageComRetry,
  mesclarStatus,
  slimCanonico,
  slimIgual,
  type FetchOrdersPage,
} from './orders-sync.service.js';
import { upsertPedido } from './orders-webhook.service.js';
import { type Alvo, readManifest, readChunkByKey } from '../lib/orders-store.js';

export const CHAVE_HEAD = 'orders:sync:head';
const ALVO: Alvo = 'ativos';
const LIMIT = 50;

interface Head {
  versao: number;
  assinatura: string;
}

export type ResultadoRecentes =
  | { acao: 'sem_snapshot'; chamadasML: 0 }
  | { acao: 'sync_em_andamento'; chamadasML: 0 }
  | { acao: 'sem_novos'; versao: number; chamadasML: number }
  | {
      acao: 'sincronizado';
      publicou: boolean;
      novos: number;
      atualizados: number;
      versao: number;
      chamadasML: number;
    }
  | { acao: 'erro'; motivo: string; chamadasML: number };

export interface OpcoesRecentes {
  /**
   * Teto de páginas quando a primeira vem INTEIRA de pedidos desconhecidos
   * (mais de 50 vendas desde a última checagem — raro, mas a revisão profunda
   * cobre o que passar do teto).
   */
  maxPaginas?: number;
}

export function assinaturaDaPagina(slims: OrderSlim[]): string {
  const h = createHash('sha256');
  for (const s of slims) h.update(slimCanonico(s)).update('\n');
  return h.digest('hex');
}

async function lerHead(cache: Cache): Promise<Head | null> {
  const raw = await cache.get(CHAVE_HEAD);
  if (raw === null) return null;
  try {
    const h = JSON.parse(raw) as Partial<Head>;
    if (!h || typeof h.versao !== 'number' || typeof h.assinatura !== 'string') return null;
    return { versao: h.versao, assinatura: h.assinatura };
  } catch {
    return null;
  }
}

/**
 * Sincroniza os pedidos mais recentes. Adquire o lock compartilhado aqui
 * mesmo, e devolve `sync_em_andamento` se estiver ocupado.
 *
 * Nunca lança por causa do Mercado Livre: erro vira `{ acao: 'erro' }` com o
 * snapshot anterior intacto.
 */
export async function sincronizarRecentes(
  cache: Cache,
  fetchPage: FetchOrdersPage,
  opts: OpcoesRecentes = {}
): Promise<ResultadoRecentes> {
  const env = getEnv();
  const maxPaginas = opts.maxPaginas ?? 3;

  const dono = randomBytes(16).toString('hex');
  if (!(await cache.setNX(ORDERS_SYNC_LOCK_KEY, dono, env.ORDERS_SYNC_LOCK_TTL_S))) {
    return { acao: 'sync_em_andamento', chamadasML: 0 };
  }

  let chamadasML = 0;
  try {
    const man = await readManifest(cache, ALVO);
    if (!man) return { acao: 'sem_snapshot', chamadasML: 0 };

    let pagina;
    try {
      pagina = await fetchPageComRetry(fetchPage, { offset: 0, limit: LIMIT }, env.ORDERS_PAGE_RETRIES);
    } catch (e) {
      return { acao: 'erro', motivo: e instanceof Error ? e.message : 'erro desconhecido', chamadasML: 1 };
    }
    chamadasML = 1;
    const slims = pagina.results.map(toSlim);
    const assinatura = assinaturaDaPagina(slims);

    const head = await lerHead(cache);
    if (head && head.versao === man.versao && head.assinatura === assinatura) {
      await mesclarStatus(cache, ALVO, { lastSyncAt: new Date().toISOString(), lastResult: 'sem_novos', emAndamento: false });
      return { acao: 'sem_novos', versao: man.versao, chamadasML };
    }

    // Algo mudou (ou a versão publicada mudou por fora). Compara com o chunk
    // mais recente ANTES de chamar o upsert: o comum é uma página em que só um
    // ou dois pedidos diferem, e cada upsert relê o chunk por conta própria.
    const conhecidos = new Map<string, OrderSlim>();
    if (man.chunks.length > 0) {
      for (const o of await readChunkByKey(cache, man.chunks[0])) conhecidos.set(String(o.id), o);
    }

    let novos = 0;
    let atualizados = 0;
    let versao = man.versao;
    let lista = slims;
    let offset = 0;
    let paginas = 1;

    for (;;) {
      let novosNaPagina = 0;
      for (const s of lista) {
        const antigo = conhecidos.get(String(s.id));
        if (antigo && slimIgual(antigo, s)) continue;
        const r = await upsertPedido(cache, s, ALVO, 'dashboard_refresh');
        if (r.versao !== null) versao = r.versao;
        if (r.acao === 'novo') { novos++; novosNaPagina++; }
        else if (r.acao === 'atualizado') atualizados++;
        // `sem_mudanca`: estava num chunk mais antigo, idêntico. `sem_snapshot`
        // não acontece aqui — o manifesto foi lido acima.
      }
      // Página inteira de pedidos novos: pode haver mais atrás dela.
      if (novosNaPagina < lista.length || lista.length < LIMIT || paginas >= maxPaginas) break;
      offset += LIMIT;
      try {
        pagina = await fetchPageComRetry(fetchPage, { offset, limit: LIMIT }, env.ORDERS_PAGE_RETRIES);
      } catch (e) {
        // O que já foi aplicado está publicado; o resto fica para a próxima.
        chamadasML++;
        return { acao: 'erro', motivo: e instanceof Error ? e.message : 'erro desconhecido', chamadasML };
      }
      chamadasML++;
      paginas++;
      lista = pagina.results.map(toSlim);
    }

    await cache.set(CHAVE_HEAD, JSON.stringify({ versao, assinatura } satisfies Head));
    const publicou = novos + atualizados > 0;
    const manFinal = publicou ? await readManifest(cache, ALVO) : man;
    await mesclarStatus(cache, ALVO, {
      ultimaVersao: manFinal?.versao ?? versao,
      totalRegistros: manFinal?.totalRegistros ?? man.totalRegistros,
      newestDate: manFinal?.newestDate ?? man.newestDate,
      lastSyncAt: new Date().toISOString(),
      lastResult: publicou ? 'ok' : 'sem_novos',
      emAndamento: false,
    });
    return { acao: 'sincronizado', publicou, novos, atualizados, versao, chamadasML };
  } catch (e) {
    // Redis indisponível no meio do upsert, manifesto corrompido, o que for:
    // o contrato é não lançar. O que já foi publicado está publicado; a
    // assinatura NÃO foi gravada, então a próxima checagem refaz a comparação.
    return { acao: 'erro', motivo: e instanceof Error ? e.message : 'erro desconhecido', chamadasML };
  } finally {
    await cache.delIfEquals(ORDERS_SYNC_LOCK_KEY, dono);
  }
}
