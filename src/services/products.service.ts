/**
 * products.service — identidade, normalização, custos e consolidação de produto.
 * Porte da lógica do dashboard legado (index.html): itemSKU (li. 3326),
 * normalizeTitle (li. 5937), getCustoUnitario (li. 3178) e buildConsolidado
 * (li. 5958). Funções PURAS: sem DOM, sem fetch, sem Redis, sem formatação de
 * moeda. Valores monetários permanecem number, sem arredondamento.
 *
 * Paridade vs endurecimentos intencionais — resumo (detalhe nos testes):
 * - itemSKU: legado devolvia 'sem-sku-<id>' como fallback; aqui devolve null
 *   (SKU não confiável não vira SKU). buildConsolidado preserva o agrupamento
 *   legado gerando a chave sintética internamente e marcando semSku: true.
 * - normalizeTitle: paridade exata, ACENTOS PRESERVADOS (o legado só remove
 *   acentos dentro de getCustoUnitario; remover aqui fundiria identidades que
 *   o código atual distingue). Entrada ausente vira '' (legado lançava erro).
 * - getCustoUnitario: paridade exata de matching e precedência; o retorno
 *   passa a ser um contrato explícito (custo ausente NUNCA vira zero).
 * - buildConsolidado: paridade das agregações, incluindo dois comportamentos
 *   herdados documentados: (a) pedidos são indexados apenas pelo PRIMEIRO
 *   order_item; (b) precoMedioVendido usa o paid_amount do PEDIDO inteiro
 *   dividido pela quantidade do primeiro item. Empates de ordenação ganham
 *   desempate determinístico por SKU (endurecimento; no legado a ordem de
 *   empate dependia da ordem de entrada).
 */
import { z } from 'zod';
import custosConfig from '../config/custos.json';

// ── Contratos de entrada (somente os campos realmente usados) ─────────────

export interface ItemAttributeInput {
  id?: string | null;
  value_name?: string | null;
}

export interface ProductItemInput {
  id: string;
  title?: string | null;
  status?: string | null;
  price?: number | null;
  sold_quantity?: number | null;
  seller_custom_field?: string | null;
  /** Campo alternativo usado pela aba Margem do legado. */
  seller_sku?: string | null;
  attributes?: ItemAttributeInput[] | null;
}

export interface OrderItemInput {
  quantity?: number | null;
  unit_price?: number | null;
  item?: { id?: string | null } | null;
}

export interface OrderInput {
  id: number | string;
  status?: string | null;
  paid_amount?: number | null;
  total_amount?: number | null;
  order_items?: OrderItemInput[] | null;
}

// ── Tabela de custos (schema validado com zod, fail-fast como env.ts) ─────

const custoRegraSchema = z.object({
  ordem: z.number().int().positive(),
  id: z.string().min(1),
  custoUnitario: z.number().min(0),
  match: z.array(z.string().min(1)).min(1),
  tipo: z.array(z.string().min(1)).optional(),
  exclui: z.array(z.string().min(1)).optional(),
});

const custosConfigSchema = z.object({
  versao: z.number().int().positive(),
  moeda: z.literal('BRL'),
  fonte: z.string().min(1),
  regras: z.array(custoRegraSchema).min(1),
});

export type CustoRegra = z.infer<typeof custoRegraSchema>;
export type CustosConfig = z.infer<typeof custosConfigSchema>;

let regrasCache: { config: CustosConfig; regrasOrdenadas: CustoRegra[] } | null = null;

/** Valida e devolve a config de custos com as regras JÁ ordenadas por `ordem`. */
export function carregarCustos(config: unknown = custosConfig): {
  config: CustosConfig;
  regrasOrdenadas: CustoRegra[];
} {
  if (config === custosConfig && regrasCache) return regrasCache;
  const parsed = custosConfigSchema.safeParse(config);
  if (!parsed.success) {
    const detalhe = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`custos.json inválido — ${detalhe}`);
  }
  const ordens = new Set(parsed.data.regras.map(r => r.ordem));
  if (ordens.size !== parsed.data.regras.length) {
    throw new Error('custos.json inválido — campo "ordem" duplicado.');
  }
  const resultado = {
    config: parsed.data,
    // Ordenação EXPLÍCITA por `ordem`: a precedência nunca depende da
    // posição acidental no arquivo.
    regrasOrdenadas: [...parsed.data.regras].sort((a, b) => a.ordem - b.ordem),
  };
  if (config === custosConfig) regrasCache = resultado;
  return resultado;
}

// ── itemSKU ───────────────────────────────────────────────────────────────

function skuLimpo(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/**
 * SKU confiável de um anúncio, na prioridade do legado:
 *   1. seller_custom_field            (itemSKU, li. 3326)
 *   2. attributes[SELLER_SKU].value_name
 *   3. seller_sku                     (alternativa usada pela aba Margem)
 * Espaços laterais são normalizados. Sem SKU confiável → null (o legado
 * fabricava 'sem-sku-<id>'; esse fallback agora é responsabilidade explícita
 * de quem agrupa — ver buildConsolidado). Nunca retorna string vazia e nunca
 * inventa SKU a partir do título.
 */
export function itemSKU(item: ProductItemInput): string | null {
  const direto = skuLimpo(item.seller_custom_field);
  if (direto) return direto;
  const attr = (item.attributes ?? []).find(a => a?.id === 'SELLER_SKU');
  const porAtributo = skuLimpo(attr?.value_name);
  if (porAtributo) return porAtributo;
  return skuLimpo(item.seller_sku);
}

// ── normalizeTitle ────────────────────────────────────────────────────────

/**
 * Normalização de título para agrupamento textual — paridade exata com o
 * legado (li. 5937): minúsculas, remoção de sufixos de logística (Full),
 * normalização de volume (5l / 5 lts → 5 litros), corte de kit/pack/cx/caixa
 * e colapso de espaços. ACENTOS SÃO PRESERVADOS de propósito (ver cabeçalho).
 * Entrada ausente → '' (endurecimento: o legado lançava TypeError).
 */
export function normalizeTitle(title: string | null | undefined): string {
  return (title ?? '')
    .toLowerCase()
    // remover sufixos de logistica
    .replace(/\s*-\s*(full|fulfillment|ml fulfillment).*/i, '')
    .replace(/\bfull\b/gi, '')
    .replace(/\bfulfillment\b/gi, '')
    // normalizar variacoes de volume/quantidade
    .replace(/\b(\d+)\s*lts\b/gi, '$1 litros')
    .replace(/\b(\d+)\s*l\b/gi, '$1 litros')
    // remover especificadores de kit/pack/caixa
    .replace(/\s+pack\s+\d+.*/i, '')
    .replace(/\s+kit\s+com\s+\d+.*/i, '')
    .replace(/\s+kit\s+\d+.*/i, '')
    .replace(/\s+cx\s+\d+.*/i, '')
    .replace(/\s+caixa\s+\d+.*/i, '')
    // normalizar espacos multiplos e trim
    .replace(/\s+/g, ' ')
    .trim();
}

// ── getCustoUnitario ──────────────────────────────────────────────────────

export type CustoProdutoResultado =
  | { encontrado: true; custoUnitario: number; fonte: string; regraId: string }
  | { encontrado: false; custoUnitario: null; fonte: null; regraId: null };

const NAO_ENCONTRADO: CustoProdutoResultado = {
  encontrado: false,
  custoUnitario: null,
  fonte: null,
  regraId: null,
};

/** Minúsculas + remoção de marcas de acento (mesmo regex do legado: U+0300–U+036F). */
function normalizarParaMatch(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Custo unitário de um anúncio pelo título — paridade exata com o legado:
 * - título e termos de `match` são normalizados (minúsculas + sem acentos);
 * - termos de `tipo` e `exclui` são comparados COMO ESTÃO contra o título já
 *   normalizado (quirk herdado: 'rosé' em exclui nunca casa; 'rose' casa);
 * - precedência: primeira regra em `ordem` crescente com match ∧ tipo ∧ ¬exclui.
 * O parâmetro `sku` é aceito para compatibilidade de assinatura e estratégia
 * futura por SKU, mas — como no legado — NÃO participa do matching hoje.
 * Custo desconhecido retorna encontrado: false (nunca zero, nunca estimado).
 */
export function getCustoUnitario(
  titulo: string | null | undefined,
  _sku?: string | null,
  regras: CustoRegra[] = carregarCustos().regrasOrdenadas,
  fonte: string = carregarCustos().config.fonte
): CustoProdutoResultado {
  const t = normalizarParaMatch(titulo ?? '');
  if (t === '') return NAO_ENCONTRADO;

  for (const regra of regras) {
    const matchBase = regra.match.some(m => t.includes(normalizarParaMatch(m)));
    if (!matchBase) continue;
    const temTipo = !regra.tipo || regra.tipo.some(tp => t.includes(tp));
    const temExcl = !!regra.exclui && regra.exclui.some(ex => t.includes(ex));
    if (temTipo && !temExcl) {
      return { encontrado: true, custoUnitario: regra.custoUnitario, fonte, regraId: regra.id };
    }
  }
  return NAO_ENCONTRADO;
}

// ── buildConsolidado ──────────────────────────────────────────────────────

export interface ConsolidadoLinha {
  /** Chave do grupo: SKU real, ou 'sem-sku-<itemId>' quando não há SKU. */
  sku: string;
  /** true quando o grupo foi criado pela chave sintética (sem SKU confiável). */
  semSku: boolean;
  /** Título mais curto entre os anúncios do grupo (comportamento legado). */
  label: string;
  /** Quantidade de anúncios do grupo. */
  anuncios: number;
  /** IDs (MLB) dos anúncios pertencentes ao grupo. */
  itemIds: string[];
  /** Soma de sold_quantity (contador histórico do ML) dos anúncios. */
  vendasTotal: number;
  /** Pedidos NÃO cancelados atribuídos ao grupo (não pagos CONTAM — legado). */
  pedidosCnt: number;
  /** Média SIMPLES dos preços de anúncios ativos com preço > 0 (legado). */
  precoMedioAnuncios: number;
  /** Média ponderada por quantidade vendida: Σ valor pago ÷ Σ unidades. */
  precoMedioVendido: number;
  /** Unidades consideradas no ponderado (denominador). */
  qtdVendida: number;
  /**
   * Estoque total do grupo — calculado APENAS se `calcularEstoqueGrupo` for
   * fornecido (a lógica de dedup próprio×Full pertence ao futuro
   * inventory.service; não é duplicada aqui). null = não calculado.
   */
  estTotal: number | null;
}

export interface BuildConsolidadoOpcoes {
  /**
   * Ponto de integração com o futuro inventory.service: recebe os anúncios do
   * grupo e devolve o estoque consolidado (equivalente legado:
   * consolidarEstoqueGrupo(items).proprio + .full). Ausente → estTotal: null.
   */
  calcularEstoqueGrupo?: (items: ProductItemInput[]) => number;
}

const PREFIXO_SEM_SKU = 'sem-sku-';

/**
 * Consolidação de produtos por SKU — porte de buildConsolidado (li. 5958).
 * Recebe itens e pedidos por parâmetro; não lê estado global nem DOM.
 *
 * Comportamentos legados preservados (com testes de paridade):
 * - Agrupamento por SKU; sem SKU → grupo próprio 'sem-sku-<id>'.
 * - Anúncios clássico e premium do MESMO SKU caem no MESMO grupo (o tipo de
 *   anúncio não participa do agrupamento).
 * - Pedidos são indexados SOMENTE pelo item do PRIMEIRO order_item; um pedido
 *   nunca é contado duas vezes ainda que dois anúncios do grupo apareçam nele.
 * - pedidosCnt exclui apenas status 'cancelled' (pendentes/não pagos contam).
 * - precoMedioVendido: Σ(paid_amount || total_amount || 0) ÷ Σ(qtd do PRIMEIRO
 *   order_item), pedidos não cancelados (quirk herdado e documentado).
 * - Nenhuma deduplicação por id de pedido aqui: a unicidade de pedidos é
 *   responsabilidade da ingestão (futuro orders.service), como no legado.
 * - Ordenação: pedidosCnt desc, vendasTotal desc; desempate por sku asc
 *   (endurecimento determinístico — só afeta empates exatos).
 */
export function buildConsolidado(
  items: ProductItemInput[],
  orders: OrderInput[],
  opcoes: BuildConsolidadoOpcoes = {}
): ConsolidadoLinha[] {
  interface Grupo {
    sku: string;
    semSku: boolean;
    label: string;
    items: ProductItemInput[];
  }

  // 1) Agrupar anúncios por SKU (fallback sintético preserva o legado).
  const grupos = new Map<string, Grupo>();
  for (const item of items) {
    const skuReal = itemSKU(item);
    const chave = skuReal ?? PREFIXO_SEM_SKU + item.id;
    let g = grupos.get(chave);
    if (!g) {
      g = { sku: chave, semSku: skuReal === null, label: item.title ?? '', items: [] };
      grupos.set(chave, g);
    }
    g.items.push(item);
    // Label: preferir o título mais curto entre os anúncios do grupo.
    // Endurecimento: título ausente é ignorado na disputa (legado lançava erro).
    const titulo = item.title ?? '';
    if (titulo !== '' && (g.label === '' || titulo.length < g.label.length)) {
      g.label = titulo;
    }
  }

  // 2) Indexar pedidos pelo item do PRIMEIRO order_item (paridade exata).
  const ordersByItem = new Map<string, OrderInput[]>();
  for (const o of orders) {
    const id = o.order_items?.[0]?.item?.id;
    if (!id) continue;
    const lista = ordersByItem.get(id);
    if (lista) lista.push(o);
    else ordersByItem.set(id, [o]);
  }

  // 3) Agregar por grupo.
  const linhas: ConsolidadoLinha[] = [];
  for (const g of grupos.values()) {
    const estTotal = opcoes.calcularEstoqueGrupo ? opcoes.calcularEstoqueGrupo(g.items) : null;
    const vendasTotal = g.items.reduce((s, i) => s + (i.sold_quantity ?? 0), 0);

    const allOrd = g.items.flatMap(i => ordersByItem.get(i.id) ?? []);
    const pedidosCnt = allOrd.filter(o => o.status !== 'cancelled').length;

    const precosAtivos = g.items
      .filter(i => i.status === 'active' && (i.price ?? 0) > 0)
      .map(i => i.price as number);
    const precoMedioAnuncios = precosAtivos.length
      ? precosAtivos.reduce((s, p) => s + p, 0) / precosAtivos.length
      : 0;

    let valorVendido = 0;
    let qtdVendida = 0;
    for (const o of allOrd) {
      if (o.status === 'cancelled') continue;
      // Paridade legada: operador || (paid_amount 0/null cai para total_amount).
      valorVendido += o.paid_amount || o.total_amount || 0;
      qtdVendida += o.order_items?.[0]?.quantity || 1;
    }
    const precoMedioVendido = qtdVendida > 0 ? valorVendido / qtdVendida : 0;

    linhas.push({
      sku: g.sku,
      semSku: g.semSku,
      label: g.label,
      anuncios: g.items.length,
      itemIds: g.items.map(i => i.id),
      vendasTotal,
      pedidosCnt,
      precoMedioAnuncios,
      precoMedioVendido,
      qtdVendida,
      estTotal,
    });
  }

  // 4) Ordenar: paridade + desempate determinístico.
  linhas.sort(
    (a, b) =>
      b.pedidosCnt - a.pedidosCnt ||
      b.vendasTotal - a.vendasTotal ||
      a.sku.localeCompare(b.sku, 'pt-BR')
  );
  return linhas;
}