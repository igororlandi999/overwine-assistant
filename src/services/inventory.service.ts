/**
 * inventory.service — estoque próprio × Full com deduplicação de saldo físico.
 * Porte do dashboard legado (index.html): isFullItem (li. 3264), fullStockKey
 * (li. 3336), consolidarEstoqueGrupo (li. 3344), núcleo de estGetSKUData
 * (li. 4957) e núcleo de renderEstoqueFull (li. 9974/10030).
 *
 * Serviço PURO: sem DOM, sem Redis, sem fetch, sem globais, sem localStorage,
 * sem formatação monetária, sem chamadas ao ML.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DOIS MODOS EXPLÍCITOS (parâmetro `modo`):
 *
 *   'legado' (PADRÃO nesta fase — paridade byte-a-byte com o dashboard):
 *     - classe clássico/premium de uma chave Full = a do PRIMEIRO anúncio
 *       visto (NÃO determinístico: fullClassico/fullPremium podem depender da
 *       ordem de entrada — é um BUG do legado, preservado de propósito);
 *     - saldo negativo é PROPAGADO (available_quantity || 0 do legado);
 *     - auditoria segue a ordem de chegada.
 *
 *   'seguro' (determinístico e não-negativo):
 *     - classe da chave Full = a do anúncio de MAIOR saldo considerado;
 *       empate de saldo → premium vence; empate persistente → menor itemId
 *       lexical (regra explícita, independente de ordem);
 *     - saldo negativo é NORMALIZADO para 0, com alerta; garante
 *       proprio >= 0, full >= 0, total >= 0;
 *     - auditoria ORDENADA (chaveDedup, considerado desc, itemId) — ordem de
 *       entrada invertida nunca produz mensagens contraditórias.
 *
 * Os TOTAIS de dedup próprio×Full (regra de maior saldo / soma por chave) são
 * idênticos nos dois modos PARA ENTRADAS NÃO NEGATIVAS. Diferenças
 * explicitamente documentadas: (a) saldo negativo — o legado propaga, o seguro
 * normaliza para 0, então os totais divergem quando há available_quantity < 0;
 * (b) a partição clássico/premium do Full (não determinística no legado);
 * (c) a ordem/uniformidade da auditoria. Fora essas diferenças e com entradas
 * >= 0, proprio/full/total coincidem nos dois modos.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { itemSKU, type ProductItemInput } from './products.service.js';

// ── Contratos de entrada (somente campos realmente usados) ────────────────

export interface InventoryItemInput extends ProductItemInput {
  available_quantity?: number | null;
  inventory_id?: string | null;
  listing_type_id?: string | null;
  /** Tags do ANÚNCIO (nível raiz do item no ML) — o legado lê i.tags. */
  tags?: string[] | null;
  shipping?: {
    logistic_type?: string | null;
    mode?: string | null;
  } | null;
}

export type ModoEstoque = 'legado' | 'seguro';

// ── isFullItem ────────────────────────────────────────────────────────────

/**
 * Detecta se um anúncio está no Full (fulfillment).
 *
 * Modo 'legado' (paridade EXATA): compara logistic_type e tags COMO ESTÃO —
 *   shipping.logistic_type === 'fulfillment' (comparação estrita, sensível a
 *   caixa/espaço, igual ao legado) OU tags inclui exatamente 'fulfillment'.
 * Modo 'seguro': aplica trim + lowercase em logistic_type e em cada tag antes
 *   de comparar (tolera 'Fulfillment', ' fulfillment ', etc.).
 *
 * Em ambos: estruturas ausentes → false; o título NUNCA é sinal (a palavra
 * "Full" no título não classifica).
 */
export function isFullItem(
  item: InventoryItemInput | null | undefined,
  modo: ModoEstoque = 'legado'
): boolean {
  if (!item) return false;
  if (modo === 'seguro') {
    const lt = (item.shipping?.logistic_type ?? '').trim().toLowerCase();
    if (lt === 'fulfillment') return true;
    return (item.tags ?? []).some(t => (t ?? '').trim().toLowerCase() === 'fulfillment');
  }
  const lt = item.shipping?.logistic_type || '';
  if (lt === 'fulfillment') return true;
  if ((item.tags ?? []).includes('fulfillment')) return true;
  return false;
}

// ── fullStockKey ──────────────────────────────────────────────────────────

export interface FullStockKey {
  origem: 'inventory_id' | 'sku' | 'item';
  valor: string;
}

/** inventory_id normalizado: trim; vazio/só espaços = ausente (endurecimento). */
function inventoryIdLimpo(item: InventoryItemInput): string | null {
  const raw = item.inventory_id;
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t === '' ? null : t;
}

/**
 * Chave ÚNICA de saldo físico para dedup do Full — porte de fullStockKey.
 * Legado: inventory_id || 'sku:' + itemSKU(i).
 *
 * Fallbacks e riscos (documentados):
 * - Sem inventory_id → chave por SKU. Evita somar duplicatas óbvias do mesmo
 *   produto (espelhos Full sem inventory_id). RISCO residual herdado: dois
 *   saldos Full fisicamente distintos do mesmo SKU, ambos sem inventory_id,
 *   são fundidos (fica o maior) — o legado aceita esse risco.
 * - Sem inventory_id E sem SKU → chave pelo próprio item.
 * - A serialização prefixa a origem (inv:/sku:/item:) para impedir colisão
 *   teórica entre um inventory_id literal "sku:x" e o fallback.
 */
export function fullStockKey(item: InventoryItemInput): FullStockKey {
  const inv = inventoryIdLimpo(item);
  if (inv) return { origem: 'inventory_id', valor: inv };
  const sku = itemSKU(item);
  if (sku) return { origem: 'sku', valor: sku };
  return { origem: 'item', valor: item.id };
}

/** Serialização estável e livre de colisão entre origens. */
export function fullStockKeyStr(key: FullStockKey): string {
  const prefixo = key.origem === 'inventory_id' ? 'inv' : key.origem;
  return `${prefixo}:${key.valor}`;
}

// ── consolidarEstoqueGrupo ────────────────────────────────────────────────

export interface EstoqueComponente {
  itemId: string;
  origem: 'full' | 'proprio_com_inventory' | 'proprio_sem_inventory';
  chaveDedup: string;
  /** Saldo lido do anúncio, sem normalização (pode ser negativo). */
  quantidadeOriginal: number;
  /** Saldo efetivamente usado: no modo seguro, max(0, original). */
  quantidadeConsiderada: number;
  /** true se este anúncio definiu o saldo considerado da sua chave. */
  considerado: boolean;
  motivo: string;
  premium: boolean;
}

export interface EstoqueAlerta {
  tipo:
    | 'saldo_negativo'
    | 'saldo_negativo_normalizado'
    | 'inventory_id_invalido'
    | 'proprio_sem_inventory_ignorado';
  itemId?: string;
  mensagem: string;
}

export interface EstoqueConsolidado {
  modo: ModoEstoque;
  proprio: number;
  fullClassico: number;
  fullPremium: number;
  full: number;
  /** proprio + full. */
  total: number;
  detalhes: { proprio: EstoqueComponente[]; full: EstoqueComponente[] };
  alertas: EstoqueAlerta[];
}

/** Saldo bruto do anúncio: número finito, senão 0 (nunca NaN). Negativo passa. */
function quantidadeBruta(item: InventoryItemInput): number {
  const q = item.available_quantity;
  return typeof q === 'number' && Number.isFinite(q) ? q : 0;
}

/**
 * Desempate determinístico de classe clássico/premium para uma chave Full
 * (modo seguro): vence o de MAIOR saldo considerado; empate → premium vence;
 * empate persistente → menor itemId lexical.
 */
function classeVence(
  a: { qtd: number; premium: boolean; itemId: string },
  b: { qtd: number; premium: boolean; itemId: string }
): boolean {
  if (a.qtd !== b.qtd) return a.qtd > b.qtd;
  if (a.premium !== b.premium) return a.premium; // premium vence empate de saldo
  return a.itemId.localeCompare(b.itemId) < 0;    // menor itemId lexical
}

type DesempateFull = { qtd: number; premium: boolean; itemId: string };

/** Critério pelo qual `venc` supera `perd` (mesma ordem de classeVence). */
function criterioDesempateFull(venc: DesempateFull, perd: DesempateFull): string {
  if (venc.qtd !== perd.qtd) return `saldo maior (${venc.qtd} > ${perd.qtd})`;
  if (venc.premium !== perd.premium) return 'empate de saldo resolvido por premium';
  return `empate de saldo e classe resolvido por itemId lexical (${venc.itemId} < ${perd.itemId})`;
}

function motivoVitoriaFull(chave: string, venc: DesempateFull, perd: DesempateFull): string {
  return `Vencedor determinístico da chave ${chave}: ${criterioDesempateFull(venc, perd)}.`;
}

function motivoPerdaFull(chave: string, perd: DesempateFull, venc: DesempateFull): string {
  return `Deduplicado na chave ${chave}: perdeu para ${venc.itemId} por ${criterioDesempateFull(venc, perd)}.`;
}

type DesempateProprio = { qtd: number; itemId: string };

/**
 * Desempate determinístico do estoque PRÓPRIO (modo seguro): maior saldo
 * vence; empate → menor itemId lexical. NÃO usa premium — clássico/premium
 * não altera o total próprio, então não é critério aqui.
 */
function proprioVence(a: DesempateProprio, b: DesempateProprio): boolean {
  if (a.qtd !== b.qtd) return a.qtd > b.qtd;
  return a.itemId.localeCompare(b.itemId) < 0;
}

/** Critério pelo qual `venc` supera `perd` no estoque próprio. */
function criterioDesempateProprio(venc: DesempateProprio, perd: DesempateProprio): string {
  if (venc.qtd !== perd.qtd) return `saldo maior (${venc.qtd} > ${perd.qtd})`;
  return `empate de saldo resolvido por itemId lexical (${venc.itemId} < ${perd.itemId})`;
}

function motivoVitoriaProprio(rotulo: string, venc: DesempateProprio, perd: DesempateProprio): string {
  return `Vencedor determinístico (${rotulo}): ${criterioDesempateProprio(venc, perd)}.`;
}

function motivoPerdaProprio(rotulo: string, perd: DesempateProprio, venc: DesempateProprio): string {
  return `Deduplicado (${rotulo}): perdeu para ${venc.itemId} por ${criterioDesempateProprio(venc, perd)}.`;
}

interface SlotFull {
  chave: string;
  qtd: number;         // saldo considerado (já normalizado no modo seguro)
  premium: boolean;    // classe vigente da chave
  donoItemId: string;  // anúncio que definiu a classe vigente
}

/**
 * Consolida o estoque de UM grupo de produto (mesmo SKU) — função principal.
 *
 * TOTAIS idênticos nos dois modos PARA ENTRADAS NÃO NEGATIVAS (com negativos,
 * o seguro normaliza a 0 e diverge do legado — ver DIFERENÇAS):
 *   FULL: dedup por fullStockKey; mesma chave = mesmo saldo físico → fica o
 *     MAIOR; chaves distintas → SOMAM.
 *   PRÓPRIO: com inventory_id, dedup por id e soma entre ids distintos; sem
 *     inventory_id, usa o MAIOR do bloco; se há próprio com inventory_id, o
 *     bloco sem inventory é descartado (quirk anti-duplicação legado).
 *
 * DIFERENÇAS por modo: partição clássico/premium (ver classeVence no seguro
 * vs "primeiro anúncio" no legado), tratamento de negativos e ordem da
 * auditoria. Ver cabeçalho do arquivo.
 *
 * STATUS: nenhum filtro aqui (paridade) — quem filtra é o chamador.
 */
export function consolidarEstoqueGrupo(
  items: InventoryItemInput[],
  modo: ModoEstoque = 'legado'
): EstoqueConsolidado {
  const seguro = modo === 'seguro';
  const fullVistos = new Map<string, SlotFull>();
  const propComInv = new Map<string, { qtd: number; donoItemId: string }>();
  let propSemInvMax = 0;
  let propSemInvDono: string | null = null;
  let temPropSemInv = false;

  const detalhesFull: EstoqueComponente[] = [];
  const detalhesProprio: EstoqueComponente[] = [];
  const alertas: EstoqueAlerta[] = [];

  for (const item of items) {
    const original = quantidadeBruta(item);
    const est = seguro ? Math.max(0, original) : original;
    if (original < 0) {
      alertas.push(
        seguro
          ? {
              tipo: 'saldo_negativo_normalizado',
              itemId: item.id,
              mensagem: `available_quantity negativo (${original}) normalizado para 0.`,
            }
          : {
              tipo: 'saldo_negativo',
              itemId: item.id,
              mensagem: `available_quantity negativo (${original}) propagado por paridade com o legado.`,
            }
      );
    }
    if (
      typeof item.inventory_id === 'string' &&
      item.inventory_id.trim() === '' &&
      item.inventory_id !== ''
    ) {
      alertas.push({
        tipo: 'inventory_id_invalido',
        itemId: item.id,
        mensagem: 'inventory_id contém apenas espaços — tratado como ausente.',
      });
    }

    if (isFullItem(item, modo)) {
      const chave = fullStockKeyStr(fullStockKey(item));
      const premium = item.listing_type_id === 'gold_pro';
      const atual = fullVistos.get(chave);
      const comp: EstoqueComponente = {
        itemId: item.id,
        origem: 'full',
        chaveDedup: chave,
        quantidadeOriginal: original,
        quantidadeConsiderada: est,
        considerado: false,
        premium,
        motivo: '',
      };
      if (!atual) {
        fullVistos.set(chave, { chave, qtd: est, premium, donoItemId: item.id });
        comp.considerado = true;
        comp.motivo = 'Primeiro anúncio da chave — saldo considerado.';
      } else if (seguro) {
        // MODO SEGURO: o MESMO vencedor determinístico (classeVence) define
        // qtd, premium, donoItemId E o único componente considerado. O saldo
        // NÃO é o único critério de troca — empates são resolvidos por
        // premium e depois por itemId lexical, de forma independente da ordem.
        const candidato = { qtd: est, premium, itemId: item.id };
        const vigente = { qtd: atual.qtd, premium: atual.premium, itemId: atual.donoItemId };
        if (classeVence(candidato, vigente)) {
          const anterior = detalhesFull.find(d => d.chaveDedup === chave && d.considerado);
          if (anterior) {
            anterior.considerado = false;
            anterior.motivo = motivoPerdaFull(
              chave,
              { qtd: anterior.quantidadeConsiderada, premium: anterior.premium, itemId: anterior.itemId },
              candidato
            );
          }
          atual.qtd = est;
          atual.premium = premium;
          atual.donoItemId = item.id;
          comp.considerado = true;
          comp.motivo = motivoVitoriaFull(chave, candidato, vigente);
        } else {
          comp.considerado = false;
          comp.motivo = motivoPerdaFull(chave, candidato, vigente);
        }
      } else {
        // MODO LEGADO (inalterado): troca só por saldo estritamente maior;
        // classe permanece a do primeiro anúncio da chave (quirk preservado).
        const saldoTrocou = est > atual.qtd;
        if (saldoTrocou) {
          const anterior = detalhesFull.find(d => d.chaveDedup === chave && d.considerado);
          if (anterior) {
            anterior.considerado = false;
            anterior.motivo = `Deduplicado: mesma chave ${chave}; venceu ${item.id} com saldo maior (${est} > ${anterior.quantidadeConsiderada}).`;
          }
          atual.qtd = est;
          comp.considerado = true;
          comp.motivo = `Mesma chave ${chave}: saldo maior vence; classe permanece a do primeiro anúncio (quirk legado, não determinístico).`;
        } else {
          comp.motivo = `Deduplicado: mesma chave ${chave} já considerada com saldo ${atual.qtd} (>= ${est}).`;
        }
      }
      detalhesFull.push(comp);
      continue;
    }

    const inv = inventoryIdLimpo(item);
    if (inv) {
      const chave = `inv:${inv}`;
      const atual = propComInv.get(chave);
      const comp: EstoqueComponente = {
        itemId: item.id,
        origem: 'proprio_com_inventory',
        chaveDedup: chave,
        quantidadeOriginal: original,
        quantidadeConsiderada: est,
        considerado: false,
        premium: item.listing_type_id === 'gold_pro',
        motivo: '',
      };
      const trocaSeguro =
        seguro && atual !== undefined &&
        proprioVence({ qtd: est, itemId: item.id }, { qtd: atual.qtd, itemId: atual.donoItemId });
      const trocaLegado = !seguro && (!atual || est > atual.qtd);
      const primeiro = !atual;
      if (primeiro || trocaSeguro || trocaLegado) {
        if (atual) {
          const anterior = detalhesProprio.find(d => d.chaveDedup === chave && d.considerado);
          if (anterior) {
            anterior.considerado = false;
            anterior.motivo = seguro
              ? motivoPerdaProprio(
                  chave,
                  { qtd: anterior.quantidadeConsiderada, itemId: anterior.itemId },
                  { qtd: est, itemId: item.id }
                )
              : `Deduplicado: mesmo inventory_id; venceu ${item.id} com saldo maior (${est} > ${anterior.quantidadeConsiderada}).`;
          }
        }
        propComInv.set(chave, { qtd: est, donoItemId: item.id });
        comp.considerado = true;
        comp.motivo = !atual
          ? 'Saldo próprio independente (inventory_id distinto soma).'
          : seguro
            ? motivoVitoriaProprio(chave, { qtd: est, itemId: item.id }, { qtd: atual.qtd, itemId: atual.donoItemId })
            : 'Mesmo inventory_id: saldo maior vence.';
      } else {
        comp.motivo = seguro
          ? motivoPerdaProprio(
              chave,
              { qtd: est, itemId: item.id },
              { qtd: atual.qtd, itemId: atual.donoItemId }
            )
          : `Deduplicado: mesmo inventory_id já considerado com saldo ${atual.qtd} (>= ${est}).`;
      }
      detalhesProprio.push(comp);
    } else {
      temPropSemInv = true;
      const candidato: DesempateProprio = { qtd: est, itemId: item.id };
      const venceu =
        propSemInvDono === null ||
        (seguro
          ? proprioVence(candidato, { qtd: propSemInvMax, itemId: propSemInvDono })
          : est > propSemInvMax);
      const comp: EstoqueComponente = {
        itemId: item.id,
        origem: 'proprio_sem_inventory',
        chaveDedup: 'sem-inventory',
        quantidadeOriginal: original,
        quantidadeConsiderada: est,
        considerado: venceu,
        premium: item.listing_type_id === 'gold_pro',
        motivo: '',
      };
      if (venceu) {
        const donoAnterior = propSemInvDono;
        const maxAnterior = propSemInvMax;
        for (const d of detalhesProprio) {
          if (d.origem === 'proprio_sem_inventory' && d.considerado && d.itemId !== item.id) {
            d.considerado = false;
            d.motivo = seguro
              ? motivoPerdaProprio('sem-inventory', { qtd: d.quantidadeConsiderada, itemId: d.itemId }, candidato)
              : `Espelho sem inventory_id: venceu ${item.id} com saldo maior.`;
          }
        }
        if (est > propSemInvMax) propSemInvMax = est;
        propSemInvDono = item.id;
        comp.motivo =
          donoAnterior === null
            ? 'Espelhos sem inventory_id compartilham o mesmo saldo — primeiro anúncio considerado.'
            : seguro
              ? motivoVitoriaProprio('sem-inventory', candidato, { qtd: maxAnterior, itemId: donoAnterior })
              : 'Espelhos sem inventory_id compartilham o mesmo saldo — maior saldo considerado.';
      } else {
        comp.motivo = seguro
          ? motivoPerdaProprio('sem-inventory', candidato, { qtd: propSemInvMax, itemId: propSemInvDono! })
          : 'Espelho sem inventory_id com saldo menor ou igual — não somado.';
      }
      detalhesProprio.push(comp);
    }
  }

  let fullClassico = 0;
  let fullPremium = 0;
  for (const slot of fullVistos.values()) {
    if (slot.premium) fullPremium += slot.qtd;
    else fullClassico += slot.qtd;
  }

  let proprio = 0;
  for (const { qtd } of propComInv.values()) proprio += qtd;
  if (proprio === 0 && temPropSemInv) {
    proprio = propSemInvMax;
  } else if (proprio !== 0 && temPropSemInv) {
    // Regra legada anti-duplicação: havendo próprio COM inventory_id, o bloco
    // sem inventory_id é descartado POR INTEIRO. Todos os componentes recebem
    // considerado=false e o MESMO motivo — que não cita vencedor interno,
    // pois o bloco não foi decidido internamente, e sim descartado por regra
    // externa. Texto independente da ordem de entrada.
    for (const d of detalhesProprio) {
      if (d.origem === 'proprio_sem_inventory') {
        d.considerado = false;
        d.motivo =
          'Ignorado: o grupo possui estoque próprio com inventory_id; todo o bloco sem inventory_id foi descartado pela regra legada anti-duplicação.';
      }
    }
    alertas.push({
      tipo: 'proprio_sem_inventory_ignorado',
      mensagem:
        'Anúncios próprios sem inventory_id ignorados porque o grupo tem saldo próprio com inventory_id (regra legada anti-duplicação).',
    });
  }

  if (seguro) {
    normalizarMotivosSeguro(detalhesFull, true);
    normalizarMotivosSeguro(detalhesProprio, false);
    ordenarComponentes(detalhesFull);
    ordenarComponentes(detalhesProprio);
    ordenarAlertas(alertas);
  }

  const full = fullClassico + fullPremium;
  return {
    modo,
    proprio,
    fullClassico,
    fullPremium,
    full,
    total: proprio + full,
    detalhes: { proprio: detalhesProprio, full: detalhesFull },
    alertas,
  };
}

/**
 * Recalcula os `motivo` no modo seguro a partir do ESTADO FINAL de cada chave,
 * não do instante da inserção — assim o texto do vencedor não depende de ele
 * ter entrado primeiro ou destronado outro. Para cada chave (exceto o bloco
 * já descartado por regra externa), o único componente considerado é o
 * vencedor; sua justificativa e a de cada perdedor derivam do desempate
 * determinístico contra o vencedor. Não altera flags nem totais.
 */
function normalizarMotivosSeguro(comps: EstoqueComponente[], usaPremium: boolean): void {
  const porChave = new Map<string, EstoqueComponente[]>();
  for (const c of comps) {
    const lista = porChave.get(c.chaveDedup);
    if (lista) lista.push(c);
    else porChave.set(c.chaveDedup, [c]);
  }
  for (const [chave, lista] of porChave) {
    const venc = lista.find(c => c.considerado);
    if (!venc) {
      // Chave sem vencedor = bloco descartado por regra EXTERNA (hoje só o
      // proprio_sem_inventory quando há próprio com inventory_id). Esses
      // componentes já receberam um motivo uniforme e determinístico no
      // descarte; NÃO sobrescrevemos aqui. Se algum dia surgir outra origem
      // de "grupo sem considerado", ela precisará de regra própria — não cair
      // silenciosamente neste caminho.
      continue;
    }
    const chaveUnica = lista.length === 1;
    for (const c of lista) {
      if (c === venc) {
        if (chaveUnica) {
          c.motivo = usaPremium
            ? `Único anúncio da chave ${chave} — saldo considerado.`
            : c.chaveDedup === 'sem-inventory'
              ? 'Único anúncio próprio sem inventory_id — saldo considerado.'
              : 'Saldo próprio independente (inventory_id distinto soma).';
        } else {
          c.motivo = usaPremium
            ? `Vencedor determinístico da chave ${chave}.`
            : `Vencedor determinístico (${chave}).`;
        }
      } else {
        const criterio = usaPremium
          ? criterioDesempateFull(
              { qtd: venc.quantidadeConsiderada, premium: venc.premium, itemId: venc.itemId },
              { qtd: c.quantidadeConsiderada, premium: c.premium, itemId: c.itemId }
            )
          : criterioDesempateProprio(
              { qtd: venc.quantidadeConsiderada, itemId: venc.itemId },
              { qtd: c.quantidadeConsiderada, itemId: c.itemId }
            );
        c.motivo = usaPremium
          ? `Deduplicado na chave ${chave}: perdeu para ${venc.itemId} por ${criterio}.`
          : `Deduplicado (${chave}): perdeu para ${venc.itemId} por ${criterio}.`;
      }
    }
  }
}

/** Ordenação determinística da auditoria (modo seguro). Não afeta totais. */
function ordenarComponentes(comps: EstoqueComponente[]): void {
  comps.sort(
    (a, b) =>
      a.chaveDedup.localeCompare(b.chaveDedup) ||
      Number(b.considerado) - Number(a.considerado) ||
      a.itemId.localeCompare(b.itemId)
  );
}

/** Ordenação determinística dos alertas (modo seguro). Não afeta totais. */
function ordenarAlertas(alertas: EstoqueAlerta[]): void {
  alertas.sort(
    (a, b) =>
      a.tipo.localeCompare(b.tipo) ||
      (a.itemId ?? '').localeCompare(b.itemId ?? '') ||
      a.mensagem.localeCompare(b.mensagem)
  );
}

// ── Classificação (limites legados, idênticos nas abas Estoque e Full) ────

export type TipoEstoque = 'ruptura' | 'alerta' | 'ok' | 'excesso' | 'semvenda';

/** Limites herdados do dashboard (li. 4990 e 10033) — não inventar novos. */
export const LIMITES_CLASSIFICACAO = {
  rupturaDiasMax: 30,
  alertaDiasMax: 90,
  okDiasMax: 365,
  fonte: 'dashboard_legado',
} as const;

export interface ClassificacaoEstoque {
  tipo: TipoEstoque;
  velocidadeDia: number;
  /** Dias de cobertura (Math.round); null quando não há venda. */
  diasCobertura: number | null;
}

/**
 * Classifica um saldo pela velocidade de venda do período.
 * Porte do núcleo de estGetSKUData/renderEstoqueFull, período generalizado:
 *   vel = +(vendasPeriodo / diasPeriodo).toFixed(2)
 *   dias = vel > 0 ? Math.round(estoque / vel) : (sem venda)
 *   vel === 0 → semvenda; dias < 30 → ruptura; < 90 → alerta;
 *   <= 365 → ok; > 365 → excesso.
 *
 * diasPeriodo inválido (<= 0 ou não finito) → erro explícito.
 * estoque NEGATIVO → erro explícito (não há cobertura negativa silenciosa):
 * o chamador deve normalizar (modo seguro já entrega proprio/full >= 0).
 */
export function classificarEstoque(
  estoque: number,
  vendasPeriodo: number,
  diasPeriodo: number
): ClassificacaoEstoque {
  if (!Number.isFinite(diasPeriodo) || diasPeriodo <= 0) {
    throw new Error(`classificarEstoque: diasPeriodo inválido (${diasPeriodo}); deve ser > 0.`);
  }
  if (!Number.isFinite(estoque) || estoque < 0) {
    throw new Error(
      `classificarEstoque: estoque inválido (${estoque}); não pode ser negativo (normalize antes — use modo 'seguro').`
    );
  }
  const vel = +(vendasPeriodo / diasPeriodo).toFixed(2);
  if (vel === 0) return { tipo: 'semvenda', velocidadeDia: 0, diasCobertura: null };
  const dias = Math.round(estoque / vel);
  let tipo: TipoEstoque;
  if (dias < LIMITES_CLASSIFICACAO.rupturaDiasMax) tipo = 'ruptura';
  else if (dias < LIMITES_CLASSIFICACAO.alertaDiasMax) tipo = 'alerta';
  else if (dias <= LIMITES_CLASSIFICACAO.okDiasMax) tipo = 'ok';
  else tipo = 'excesso';
  return { tipo, velocidadeDia: vel, diasCobertura: dias };
}

/** Ordem operacional legada dos tipos (ruptura primeiro). */
const ORDEM_TIPO: Record<TipoEstoque, number> = {
  ruptura: 0, alerta: 1, ok: 2, excesso: 3, semvenda: 4,
};

// ── Ordenação genérica de linhas classificáveis (sem cast inseguro) ───────

export interface LinhaClassificavel {
  sku: string;
  tipo: TipoEstoque | null;
  diasCobertura: number | null;
}

/**
 * Ordena in place qualquer array cujos itens tenham {sku, tipo, diasCobertura}.
 * Aceita EstoqueSkuLinha[] e EstoqueFullLinha[] sem cast duplo (o parâmetro é
 * um supertipo estrutural comum). Com classificação: tipo (ruptura primeiro),
 * dias asc (null por último), sku asc. Sem classificação: sku asc.
 */
export function ordenarLinhasClassificaveis<T extends LinhaClassificavel>(linhas: T[]): T[] {
  linhas.sort((a, b) => {
    if (a.tipo && b.tipo) {
      const porTipo = ORDEM_TIPO[a.tipo] - ORDEM_TIPO[b.tipo];
      if (porTipo !== 0) return porTipo;
      const da = a.diasCobertura ?? Number.MAX_SAFE_INTEGER;
      const db = b.diasCobertura ?? Number.MAX_SAFE_INTEGER;
      if (da !== db) return da - db;
    }
    return a.sku.localeCompare(b.sku, 'pt-BR');
  });
  return linhas;
}

// ── Estoque por SKU (núcleo de estGetSKUData) ─────────────────────────────

export interface EstoquePorSkuOpcoes {
  modo?: ModoEstoque;
  /**
   * Vendas do período por item_id (MLB → unidades), já calculadas pelo
   * chamador (futuro sales/orders.service). Ausente → classificação null.
   */
  vendasPorItem?: Record<string, number>;
  /** Dias do período das vendas. Padrão legado: 30. */
  diasPeriodo?: number;
  /**
   * Filtra status !== 'active' antes de agrupar. Padrão true (paridade
   * estGetSKUData legado: allItems.filter(i => i.status === 'active')).
   */
  incluirSomenteAtivos?: boolean;
}

export interface EstoqueSkuLinha extends LinhaClassificavel {
  semSku: boolean;
  label: string;
  anuncios: number;
  itemIds: string[];
  preco: number;
  estProprio: number;
  estFull: number;
  estTotal: number;
  vendasPeriodo: number | null;
  velocidadeDia: number | null;
  alertas: EstoqueAlerta[];
}

const PREFIXO_SEM_SKU = 'sem-sku-';

interface GrupoSku {
  sku: string;
  semSku: boolean;
  label: string;
  items: InventoryItemInput[];
}

function agruparPorSku(items: InventoryItemInput[]): Map<string, GrupoSku> {
  const grupos = new Map<string, GrupoSku>();
  for (const item of items) {
    const skuReal = itemSKU(item);
    const chave = skuReal ?? PREFIXO_SEM_SKU + item.id;
    let g = grupos.get(chave);
    if (!g) {
      g = { sku: chave, semSku: skuReal === null, label: item.title ?? '', items: [] };
      grupos.set(chave, g);
    }
    g.items.push(item);
    const titulo = item.title ?? '';
    if (titulo !== '' && (g.label === '' || titulo.length < g.label.length)) g.label = titulo;
  }
  return grupos;
}

function vendasDoGrupo(g: GrupoSku, vendasPorItem: Record<string, number>): number {
  return g.items.reduce((s, i) => s + (vendasPorItem[i.id] ?? 0), 0);
}

/**
 * Núcleo puro de estGetSKUData (Gestão de Estoque):
 * - por padrão considera SOMENTE status === 'active' (paridade; configurável
 *   via incluirSomenteAtivos:false);
 * - agrupa por SKU (fallback sintético por anúncio);
 * - estProprio via consolidarEstoqueGrupo (Gestão de Estoque = só próprio);
 * - preco = MAIOR preço do grupo (paridade);
 * - vendas do período chegam prontas por parâmetro (sem tocar em pedidos).
 *
 * consolidarEstoqueGrupo aceita qualquer status porque é uma primitiva de
 * dedup de saldo físico, reutilizada por contextos com filtros distintos
 * (Gestão de Estoque filtra 'active'; a aba Full não filtra status). O filtro
 * vive no chamador, não na primitiva.
 */
export function buildEstoquePorSku(
  items: InventoryItemInput[],
  opcoes: EstoquePorSkuOpcoes = {}
): EstoqueSkuLinha[] {
  const { vendasPorItem, diasPeriodo = 30, incluirSomenteAtivos = true, modo = 'legado' } = opcoes;
  const base = incluirSomenteAtivos ? items.filter(i => i.status === 'active') : items;
  const linhas: EstoqueSkuLinha[] = [];

  for (const g of agruparPorSku(base).values()) {
    const cons = consolidarEstoqueGrupo(g.items, modo);
    const preco = g.items.reduce((max, i) => {
      const p = typeof i.price === 'number' && Number.isFinite(i.price) ? i.price : 0;
      return p > max ? p : max;
    }, 0);

    let vendasPeriodo: number | null = null;
    let velocidadeDia: number | null = null;
    let diasCobertura: number | null = null;
    let tipo: TipoEstoque | null = null;
    if (vendasPorItem) {
      vendasPeriodo = vendasDoGrupo(g, vendasPorItem);
      const c = classificarEstoque(cons.proprio, vendasPeriodo, diasPeriodo);
      velocidadeDia = c.velocidadeDia;
      diasCobertura = c.diasCobertura;
      tipo = c.tipo;
    }

    linhas.push({
      sku: g.sku,
      semSku: g.semSku,
      label: g.label,
      anuncios: g.items.length,
      itemIds: g.items.map(i => i.id),
      preco,
      estProprio: cons.proprio,
      estFull: cons.full,
      estTotal: cons.total,
      vendasPeriodo,
      velocidadeDia,
      diasCobertura,
      tipo,
      alertas: cons.alertas,
    });
  }

  return ordenarLinhasClassificaveis(linhas);
}

// ── Estoque Full por SKU (núcleo de renderEstoqueFull) ────────────────────

export interface EstoqueFullLinha extends LinhaClassificavel {
  semSku: boolean;
  label: string;
  anuncios: number;
  itemIds: string[];
  estClassico: number;
  estPremium: number;
  estTotal: number;
  vendasPeriodo: number | null;
  velocidadeDia: number | null;
  alertas: EstoqueAlerta[];
}

/**
 * Núcleo puro do cálculo de renderEstoqueFull:
 * - considera SOMENTE anúncios Full (isFullItem) — SEM filtro de status
 *   (paridade: o legado não filtra status no Full);
 * - agrupa por SKU; estClassico/estPremium via consolidarEstoqueGrupo;
 * - classificação idêntica à Gestão de Estoque quando vendas fornecidas.
 */
export function buildEstoqueFullPorSku(
  items: InventoryItemInput[],
  opcoes: EstoquePorSkuOpcoes = {}
): EstoqueFullLinha[] {
  const { vendasPorItem, diasPeriodo = 30, modo = 'legado' } = opcoes;
  const fullItems = items.filter(i => isFullItem(i, modo));
  const linhas: EstoqueFullLinha[] = [];

  for (const g of agruparPorSku(fullItems).values()) {
    const cons = consolidarEstoqueGrupo(g.items, modo);

    let vendasPeriodo: number | null = null;
    let velocidadeDia: number | null = null;
    let diasCobertura: number | null = null;
    let tipo: TipoEstoque | null = null;
    if (vendasPorItem) {
      vendasPeriodo = vendasDoGrupo(g, vendasPorItem);
      const c = classificarEstoque(cons.full, vendasPeriodo, diasPeriodo);
      velocidadeDia = c.velocidadeDia;
      diasCobertura = c.diasCobertura;
      tipo = c.tipo;
    }

    linhas.push({
      sku: g.sku,
      semSku: g.semSku,
      label: g.label,
      anuncios: g.items.length,
      itemIds: g.items.map(i => i.id),
      estClassico: cons.fullClassico,
      estPremium: cons.fullPremium,
      estTotal: cons.full,
      vendasPeriodo,
      velocidadeDia,
      diasCobertura,
      tipo,
      alertas: cons.alertas,
    });
  }

  return ordenarLinhasClassificaveis(linhas);
}

// ── Integração com products.service ──────────────────────────────────────

/**
 * Adaptador para o callback calcularEstoqueGrupo de buildConsolidado:
 * devolve o estoque total do grupo (próprio + Full). O modo default é
 * 'legado' para paridade; passe 'seguro' para totais não-negativos.
 */
export function calcularEstoqueTotalGrupo(
  items: InventoryItemInput[],
  modo: ModoEstoque = 'legado'
): number {
  return consolidarEstoqueGrupo(items, modo).total;
}