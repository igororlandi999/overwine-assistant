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
import custosConfig from '../config/custos.json' with { type: 'json' };
import { contaComoVenda } from '../lib/status-venda.js';

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
  custoProduto: z.number().min(0),
  /**
   * seller_sku dos anúncios desta regra. Identidade EXATA, não heurística —
   * por isso vence `match`. Opcional: regras de produtos que nunca venderam
   * ainda não têm SKU conhecido e seguem só por título.
   */
  sku: z.array(z.string().min(1)).optional(),
  match: z.array(z.string().min(1)).min(1),
  tipo: z.array(z.string().min(1)).optional(),
  exclui: z.array(z.string().min(1)).optional(),
});

/**
 * Custos logísticos por unidade vendida. `frete` incide em toda venda;
 * `embalagem` incide SOMENTE em venda por estoque próprio — no Full o Mercado
 * Livre embala e não há custo unitário de embalagem.
 */
const logisticaSchema = z.object({
  frete: z.number().min(0),
  embalagem: z.number().min(0),
});

const custosConfigSchema = z.object({
  versao: z.number().int().positive(),
  moeda: z.literal('BRL'),
  fonte: z.string().min(1),
  logistica: logisticaSchema,
  regras: z.array(custoRegraSchema).min(1),
});

export type CustoRegra = z.infer<typeof custoRegraSchema>;
export type Logistica = z.infer<typeof logisticaSchema>;
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
  | {
      encontrado: true;
      /** Custo de aquisição de UMA garrafa. Em kit, NÃO é o custo da venda. */
      custoProduto: number;
      fonte: string;
      regraId: string;
      /**
       * Como a regra foi encontrada. 'sku' é identidade exata; 'titulo' é
       * heurística de texto e merece desconfiança — foi por 'titulo' que o HFC
       * passou meses aparecendo como sem custo.
       */
      via: 'sku' | 'titulo';
      /**
       * Garrafas embutidas em uma unidade vendida. 1 para anúncio avulso, N
       * para "Kit Com N Un". Fica explícito no retorno para ser auditável: a
       * detecção vem do TÍTULO, e título é fonte frágil (foi o que escondeu o
       * HFC). Quem calcular custo DEVE multiplicar por este número.
       */
      garrafasPorVenda: number;
    }
  | { encontrado: false; custoProduto: null; fonte: null; regraId: null; via: null; garrafasPorVenda: 1 };

const NAO_ENCONTRADO: CustoProdutoResultado = {
  encontrado: false,
  custoProduto: null,
  fonte: null,
  regraId: null,
  via: null,
  garrafasPorVenda: 1,
};

/**
 * Kits são montados no estoque a partir de garrafas avulsas, então o custo de
 * aquisição é N × o custo unitário. O ML vende o kit como UMA unidade, e o
 * título é o único lugar onde a quantidade aparece — não há campo estruturado.
 *
 * Só dispara com um substantivo de contagem explícito ("6 un", "4 garrafas").
 * Isso evita casar com volume: "Bag In Box 5 Litros" é um recipiente único de
 * 5 L, com custo próprio já cadastrado (regra arcos_bib), e NÃO pode virar
 * multiplicador — seria contar cinco vezes um custo que já é do conjunto.
 */
const RE_KIT = /\b(?:kit|caixa|pack|combo|c\/)\s*(?:com\s+)?(\d{1,2})\s*(?:un|und|unid\w*|garrafas?|gfs?)\b/;

/** Garrafas por unidade vendida detectadas no título. 1 quando não é kit. */
export function garrafasPorVenda(titulo: string | null | undefined): number {
  const m = RE_KIT.exec(normalizarParaMatch(titulo ?? ''));
  if (!m) return 1;
  const n = Number(m[1]);
  // Teto defensivo: acima disso é quase certo erro de leitura do título, e
  // inflar custo silenciosamente é pior que ignorar o kit.
  return Number.isFinite(n) && n >= 2 && n <= 24 ? n : 1;
}

/** Minúsculas + remoção de marcas de acento (mesmo regex do legado: U+0300–U+036F). */
function normalizarParaMatch(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Custo PURO de aquisição de um anúncio pelo título — não inclui frete nem
 * embalagem (use `custoUnitarioVendido` para o custo por unidade vendida):
 * - título e termos de `match` são normalizados (minúsculas + sem acentos);
 * - termos de `tipo` e `exclui` são comparados COMO ESTÃO contra o título já
 *   normalizado (quirk herdado: 'rosé' em exclui nunca casa; 'rose' casa);
 * - precedência: primeira regra em `ordem` crescente com match ∧ tipo ∧ ¬exclui.
 *
 * RESOLUÇÃO POR SKU (v3) VEM PRIMEIRO. `seller_sku` é identidade exata do
 * anúncio; título é texto que muda ao sabor de quem cadastra. A regra 'hfc'
 * existia com o custo certo e mesmo assim o produto figurava como sem custo,
 * porque o anúncio se chama 'Herdade Da Fonte Coberta' e a regra só conhecia a
 * sigla — falha silenciosa, sem nada no sistema apontando para ela.
 *
 * O caminho por título PERMANECE como fallback: cobre o anúncio sem seller_sku
 * e o SKU ainda não mapeado. Um SKU novo, portanto, degrada para o
 * comportamento antigo em vez de perder o custo.
 *
 * Custo desconhecido retorna encontrado: false (nunca zero, nunca estimado).
 */
export function getCustoProduto(
  titulo: string | null | undefined,
  sku?: string | null,
  regras: CustoRegra[] = carregarCustos().regrasOrdenadas,
  fonte: string = carregarCustos().config.fonte
): CustoProdutoResultado {
  const s = skuLimpo(sku);
  if (s !== null) {
    for (const regra of regras) {
      if (regra.sku?.includes(s)) {
        return {
          encontrado: true,
          custoProduto: regra.custoProduto,
          fonte,
          regraId: regra.id,
          via: 'sku',
          garrafasPorVenda: garrafasPorVenda(titulo),
        };
      }
    }
  }

  const t = normalizarParaMatch(titulo ?? '');
  if (t === '') return NAO_ENCONTRADO;

  for (const regra of regras) {
    const matchBase = regra.match.some(m => t.includes(normalizarParaMatch(m)));
    if (!matchBase) continue;
    const temTipo = !regra.tipo || regra.tipo.some(tp => t.includes(tp));
    const temExcl = !!regra.exclui && regra.exclui.some(ex => t.includes(ex));
    if (temTipo && !temExcl) {
      return {
        encontrado: true,
        custoProduto: regra.custoProduto,
        fonte,
        regraId: regra.id,
        via: 'titulo',
        garrafasPorVenda: garrafasPorVenda(titulo),
      };
    }
  }
  return NAO_ENCONTRADO;
}

/**
 * `logistic_type` do pedido que caracteriza venda pelo Full. Fora dessa lista
 * (inclusive null/ausente) a venda é tratada como estoque próprio, que é o
 * lado CONSERVADOR: soma embalagem e portanto nunca infla a margem.
 */
const LOGISTIC_TYPES_FULL: ReadonlySet<string> = new Set(['fulfillment']);

/** true quando o pedido foi atendido pelo Full (sem custo de embalagem). */
export function ehVendaFull(logisticType: string | null | undefined): boolean {
  return typeof logisticType === 'string' && LOGISTIC_TYPES_FULL.has(logisticType.toLowerCase());
}

/**
 * Custo por UNIDADE VENDIDA: (custo do produto + frete) × garrafas + embalagem.
 *
 * O que escala com o número de garrafas e o que NÃO escala foi definido pelo
 * proprietário (17/08/2026):
 * - custo do produto ESCALA: o kit é montado com N garrafas do estoque;
 * - frete ESCALA: mais garrafas aumentam o volume, e o frete sobe junto;
 * - embalagem NÃO escala: o kit inteiro vai em UMA embalagem.
 *
 * A embalagem só entra em venda por estoque próprio (no Full o Mercado Livre
 * embala). Custo de produto desconhecido devolve null — nunca zero, para que a
 * margem seja declarada indisponível em vez de fabricada.
 */
export function custoUnitarioVendido(
  custoProduto: number | null,
  logisticType: string | null | undefined,
  logistica: Logistica = carregarCustos().config.logistica,
  garrafas: number = 1
): number | null {
  if (custoProduto === null) return null;
  const n = Number.isFinite(garrafas) && garrafas >= 1 ? Math.floor(garrafas) : 1;
  const embalagem = ehVendaFull(logisticType) ? 0 : logistica.embalagem;
  return (custoProduto + logistica.frete) * n + embalagem;
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
    const pedidosCnt = allOrd.filter(o => contaComoVenda(o.status)).length;

    const precosAtivos = g.items
      .filter(i => i.status === 'active' && (i.price ?? 0) > 0)
      .map(i => i.price as number);
    const precoMedioAnuncios = precosAtivos.length
      ? precosAtivos.reduce((s, p) => s + p, 0) / precosAtivos.length
      : 0;

    let valorVendido = 0;
    let qtdVendida = 0;
    for (const o of allOrd) {
      if (!contaComoVenda(o.status)) continue;
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