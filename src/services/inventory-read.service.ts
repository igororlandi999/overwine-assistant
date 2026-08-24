/**
 * inventory-read.service — composição de LEITURA do estoque.
 *
 * Existe para que a rota HTTP (`GET /api/items/inventory`) e o assistente
 * (`api/chat.ts`) produzam exatamente os MESMOS números. Antes desta camada a
 * composição vivia dentro da rota, e o chat só teria dois caminhos: repetir a
 * composição (duas verdades) ou fazer um `fetch` para o próprio backend (uma
 * viagem de rede inútil, com sessão e rate limit no meio). Nenhum dos dois.
 *
 * É a MENOR extração possível: só a leitura dos dois snapshots, a resolução de
 * período e a resolução de produto. O cálculo continua inteiro no
 * inventory.service, que não foi tocado.
 *
 * NUNCA chama o Mercado Livre. Lê o snapshot de catálogo PUBLICADO e o
 * snapshot de pedidos `ativos`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PERÍODO: POR QUE ESTE SERVIÇO RESOLVE "N DIAS" DIFERENTE DE metrics/margin
 *
 * `resolverPeriodo` devolve `hoje-N .. hoje` para `dias=N` — que são N+1 dias
 * civis. Aquilo é paridade DELIBERADA com o dashboard legado, e as rotas de
 * vendas e margem dependem dela.
 *
 * O parser do chat resolve "últimos N dias" como `hoje-(N-1) .. hoje`, que são
 * N dias civis — a conta certa. As duas convenções conviviam sem se cruzar
 * enquanto estoque não existia no chat.
 *
 * Com estoque nos dois lados elas se cruzariam: o dashboard pediria `dias=30`
 * (31 dias) e o usuário perguntaria "últimos 30 dias" (30 dias), e a MESMA
 * pergunta devolveria velocidades diferentes por ~3%. Duas respostas para a
 * mesma pergunta é o problema que `/api/orders/margin` existe para não repetir.
 *
 * Resolução: no estoque, `dias=N` significa N dias civis terminando hoje, dos
 * dois lados. `metrics` e `margin` ficam intocados — a paridade deles é com o
 * dashboard legado, que estoque não tem, porque estoque no backend é novo.
 * TODA a validação (dias inválido, limites, intervalo invertido, combinação
 * proibida) continua em `resolverPeriodo`: aqui só a janela é reescrita.
 */
import type { Cache } from '../lib/cache/cache.js';
import { readCatalogManifest, type CatalogManifest, type ItemSlim } from '../lib/items-store.js';
import { readSnapshot } from '../lib/orders-store.js';
import { brtEndOfDay, brtStartOfDay } from '../lib/datas-brt.js';
import { getReadStatus } from './orders-read.service.js';
import { unidadesPorItem } from './orders.service.js';
import { normalizeTitle } from './products.service.js';
import {
  lerCatalogoPublicado, precisaReconstruir,
} from './items-catalog.service.js';
import {
  resolverPeriodo, ymdMenosDias, type ParamsResultado,
} from './orders-metrics.service.js';
import type { PeriodoYmd } from './sales-metrics.service.js';
import {
  buildEstoqueFullPorSku, buildEstoquePorSku,
  type EstoqueFullLinha, type EstoquePorSkuOpcoes, type EstoqueSkuLinha, type ModoEstoque,
} from './inventory.service.js';

/** Janela legada de vendas da aba Estoque: estGetSKUData usa 30 dias. */
export const INVENTARIO_DIAS_PADRAO = 30;

export type EscopoEstoque = 'proprio' | 'full' | 'ambos';

/** Mesmo default do schema de env, para quem chamar sem passar `hardTtlS`. */
const HARD_TTL_S_PADRAO = 86400;

/**
 * Resolve o período de uma consulta de estoque.
 *
 * Delega TODA a validação a `resolverPeriodo` e depois reescreve a janela de
 * `dias=N` para N dias civis inclusivos. Intervalo explícito (`from`/`to`)
 * passa intocado: ali o usuário já disse as duas pontas.
 */
export function resolverPeriodoInventario(
  query: Record<string, unknown>,
  agora: Date = new Date()
): ParamsResultado {
  const r = resolverPeriodo(query, agora, INVENTARIO_DIAS_PADRAO);
  if (!r.ok) return r;

  const temIntervalo =
    (query.from !== undefined && query.from !== '') ||
    (query.to !== undefined && query.to !== '');
  if (temIntervalo) return r;

  // `dias` já foi validado como inteiro dentro dos limites por resolverPeriodo.
  const n = query.dias === undefined || query.dias === ''
    ? INVENTARIO_DIAS_PADRAO
    : Number(query.dias);
  const hoje = r.periodo.toYmd;
  return { ok: true, periodo: { fromYmd: ymdMenosDias(hoje, n - 1), toYmd: hoje } };
}

/** Dias do período, bordas incluídas. É o divisor da velocidade de venda. */
export function diasInclusive(fromYmd: string, toYmd: string): number {
  const ini = brtStartOfDay(fromYmd);
  const fim = brtStartOfDay(toYmd);
  if (!ini || !fim) return 1;
  return Math.round((fim.getTime() - ini.getTime()) / 86400000) + 1;
}

export interface OpcoesInventario {
  periodo: PeriodoYmd;
  /** Ver a nota de MODO em `lerInventario`. Padrão `seguro`. */
  modo?: ModoEstoque;
  escopo?: EscopoEstoque;
  /**
   * TTL duro do catálogo, para marcar `stale`. Vem de
   * `ITEMS_CATALOG_HARD_TTL_S`: o serviço não lê env, senão a rota e o chat
   * poderiam divergir se um deles esquecesse de passar o valor configurado.
   */
  hardTtlS?: number;
}

export interface Inventario {
  catalogo: {
    versao: number;
    updatedAt: string;
    counts: CatalogManifest['counts'];
    stale: boolean;
  };
  periodo: { fromYmd: string; toYmd: string; dias: number };
  modo: ModoEstoque;
  escopo: EscopoEstoque;
  vendasDisponiveis: boolean;
  proprio: EstoqueSkuLinha[] | null;
  full: EstoqueFullLinha[] | null;
  warnings: string[];
}

export type FalhaInventario =
  | 'catalogo_indisponivel'
  | 'catalogo_vazio'
  | 'saldo_invalido_no_modo_legado';

export type LeituraInventario =
  | { ok: true; value: Inventario }
  | { ok: false; code: FalhaInventario };

/**
 * Lê catálogo + pedidos e devolve o estoque calculado.
 *
 * MODO: o padrão é `seguro`, não `legado`. No legado o saldo negativo é
 * PROPAGADO e `classificarEstoque` LANÇA com estoque < 0 — um único anúncio com
 * available_quantity negativo derrubaria a consulta. O seguro normaliza para 0
 * e registra alerta. Fora esse caso os totais são idênticos nos dois modos (ver
 * o cabeçalho de inventory.service.ts), então o padrão seguro não afasta os
 * números do dashboard; só remove o não determinismo da partição
 * clássico/premium. `legado` continua disponível para comparar paridade e
 * devolve falha explícita quando o saldo negativo aparece.
 *
 * VENDAS são OPCIONAIS: sem o snapshot de pedidos os saldos deduplicados
 * continuam corretos e só a classificação por velocidade fica nula.
 */
export async function lerInventario(
  cache: Cache,
  opcoes: OpcoesInventario
): Promise<LeituraInventario> {
  const modo: ModoEstoque = opcoes.modo ?? 'seguro';
  const escopo: EscopoEstoque = opcoes.escopo ?? 'ambos';

  // Catálogo: SOMENTE o snapshot publicado. Reconstruir é trabalho de
  // `catalog?refresh=1` — esta leitura nunca toca o Mercado Livre nem pega o
  // lock de reconstrução, para não competir com a atualização do catálogo.
  let manifest: CatalogManifest | null = null;
  try {
    manifest = await readCatalogManifest(cache);
  } catch {
    manifest = null; // manifesto corrompido é tratado como ausente
  }
  if (!manifest) return { ok: false, code: 'catalogo_indisponivel' };

  let items: ItemSlim[];
  try {
    items = await lerCatalogoPublicado(cache, manifest);
  } catch {
    return { ok: false, code: 'catalogo_indisponivel' };
  }
  if (items.length === 0) return { ok: false, code: 'catalogo_vazio' };

  const warnings: string[] = [];
  if (precisaReconstruir(manifest, opcoes.hardTtlS ?? HARD_TTL_S_PADRAO)) warnings.push('catalogo_stale');

  let vendasPorItem: Record<string, number> | undefined;
  try {
    const st = await getReadStatus(cache, 'ativos');
    if (st.versao !== null && st.totalRegistros > 0) {
      const pedidos = await readSnapshot(cache, 'ativos');
      if (pedidos.length > 0) {
        vendasPorItem = Object.fromEntries(
          unidadesPorItem(
            pedidos,
            brtStartOfDay(opcoes.periodo.fromYmd),
            brtEndOfDay(opcoes.periodo.toYmd)
          )
        );
      }
    }
  } catch {
    vendasPorItem = undefined; // segue sem classificação
  }
  if (!vendasPorItem) warnings.push('vendas_indisponiveis');

  const dias = diasInclusive(opcoes.periodo.fromYmd, opcoes.periodo.toYmd);
  const opts: EstoquePorSkuOpcoes = { modo, vendasPorItem, diasPeriodo: dias };

  let proprio: EstoqueSkuLinha[] | null = null;
  let full: EstoqueFullLinha[] | null = null;
  try {
    proprio = escopo === 'full' ? null : buildEstoquePorSku(items, opts);
    full = escopo === 'proprio' ? null : buildEstoqueFullPorSku(items, opts);
  } catch (e) {
    // `classificarEstoque` lança com saldo negativo, que só o modo legado
    // propaga. Vira falha nomeada em vez de erro opaco.
    if (modo === 'legado') return { ok: false, code: 'saldo_invalido_no_modo_legado' };
    throw e;
  }

  return {
    ok: true,
    value: {
      catalogo: {
        versao: manifest.versao,
        updatedAt: manifest.updatedAt,
        counts: manifest.counts,
        stale: warnings.includes('catalogo_stale'),
      },
      periodo: { fromYmd: opcoes.periodo.fromYmd, toYmd: opcoes.periodo.toYmd, dias },
      modo,
      escopo,
      vendasDisponiveis: vendasPorItem !== undefined,
      proprio,
      full,
      warnings,
    },
  };
}

// ── Resolução determinística de produto ───────────────────────────────────

/**
 * Normalização de SKU para comparação: minúsculas, sem separadores. Faz
 * "SKU-21002", "sku 21002" e "21002" casarem entre si.
 */
function skuComparavel(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface CandidatoProduto {
  sku: string;
  label: string;
}

export type ResolucaoProduto<T> =
  | { kind: 'encontrado'; linha: T }
  | { kind: 'ambiguo'; candidatos: CandidatoProduto[] }
  | { kind: 'ausente' };

/** Quantos candidatos citar numa resposta de ambiguidade. */
export const MAX_CANDIDATOS = 5;

/**
 * Resolve UM produto dentro das linhas de estoque, em ordem de precisão:
 *   1. SKU exato;
 *   2. SKU normalizado (sem separadores);
 *   3. título normalizado exato — `normalizeTitle` do products.service, o mesmo
 *      normalizador que o agrupamento de produtos já usa;
 *   4. correspondência textual contida, aceita SOMENTE quando é única.
 *
 * Vários candidatos no passo 4 devolvem `ambiguo` com a lista — o modelo nunca
 * escolhe em silêncio. Parar no primeiro nível que resolve é o que torna a
 * resolução determinística: um SKU exato nunca perde para um título parecido.
 */
export function resolverProduto<T extends { sku: string; label: string; semSku: boolean }>(
  linhas: T[],
  termo: string
): ResolucaoProduto<T> {
  const alvo = (termo || '').trim().toLowerCase();
  if (alvo === '') return { kind: 'ausente' };

  const exato = linhas.filter(l => !l.semSku && l.sku.toLowerCase() === alvo);
  if (exato.length === 1) return { kind: 'encontrado', linha: exato[0] };

  const alvoSku = skuComparavel(alvo);
  if (alvoSku !== '') {
    const porSku = linhas.filter(l => !l.semSku && skuComparavel(l.sku) === alvoSku);
    if (porSku.length === 1) return { kind: 'encontrado', linha: porSku[0] };
  }

  const alvoTitulo = normalizeTitle(alvo);
  if (alvoTitulo !== '') {
    const porTitulo = linhas.filter(l => normalizeTitle(l.label) === alvoTitulo);
    if (porTitulo.length === 1) return { kind: 'encontrado', linha: porTitulo[0] };

    const contidos = linhas.filter(l => {
      const t = normalizeTitle(l.label);
      return t !== '' && t.includes(alvoTitulo);
    });
    if (contidos.length === 1) return { kind: 'encontrado', linha: contidos[0] };
    if (contidos.length > 1) {
      return {
        kind: 'ambiguo',
        candidatos: contidos
          .slice()
          .sort((a, b) => a.sku.localeCompare(b.sku, 'pt-BR'))
          .slice(0, MAX_CANDIDATOS)
          .map(l => ({ sku: l.sku, label: l.label })),
      };
    }
  }

  // Vários SKUs exatos iguais não deveriam existir, mas se existirem é
  // ambiguidade legítima, não "não encontrado".
  if (exato.length > 1) {
    return {
      kind: 'ambiguo',
      candidatos: exato.slice(0, MAX_CANDIDATOS).map(l => ({ sku: l.sku, label: l.label })),
    };
  }

  return { kind: 'ausente' };
}
