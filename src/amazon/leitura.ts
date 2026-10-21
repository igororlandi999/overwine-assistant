/**
 * Camada de LEITURA da Amazon: transforma o que a sincronização gravou
 * (formato da Amazon, src/amazon/store.ts) no formato que as rotas e telas
 * existentes já leem — o snapshot de pedidos (orders-store) e o catálogo
 * (items-store) DA CONTA — sem misturar regra do Mercado Livre.
 *
 * Por que projetar em vez de criar rotas novas: status, lista, métricas,
 * consolidação entre contas, versão para o poll e o catálogo já sabem ler
 * esses dois formatos, por conta, com `conta` e `canal` marcados. A Amazon
 * entra pelas mesmas portas; o que é dela vai em campos próprios e valores
 * próprios (status `amazon:*`, logística `amazon_*`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * STATUS — decisões para revisão (contrato: Orders v2026-01-01, FulfillmentStatus)
 *
 *   PENDING_AVAILABILITY  pré-venda, pagamento NÃO autorizado   → pendente, fora do faturamento
 *   PENDING               pedido feito, ainda não pronto        → pendente, fora do faturamento
 *   UNSHIPPED             pronto para envio, nada enviado       → aprovado, ENTRA
 *   PARTIALLY_SHIPPED     parte dos itens enviada               → aprovado, ENTRA
 *   SHIPPED               tudo enviado                          → aprovado, ENTRA
 *   CANCELLED             cancelado, não será atendido          → cancelado, fora
 *   UNFULFILLABLE         só FBA fora do site da Amazon         → não atendível, fora
 *   (ausente/desconhecido)                                      → fora, até alguém decidir
 *
 * Item cancelado dentro de pedido não cancelado (cancellationExecution
 * presente): o item sai do faturamento; o pedido continua.
 *
 * REEMBOLSO: a Orders API não tem status de reembolso. A única evidência é
 * financeira: transação vinculada ao pedido com valor negativo. Ela aparece
 * no financeiro LANÇADO (src/amazon/financeiro.ts), marcada no pedido como
 * `debito_lancado`; o faturamento do pedido NÃO é reduzido automaticamente —
 * faturamento é pedido, transação é dinheiro lançado, e os dois não se
 * confundem.
 *
 * FATURAMENTO de um item = subtotal `ITEM` dos proceeds do item (o valor do
 * produto), menos o `DISCOUNT` quando a Amazon o informa. Frete (SHIPPING),
 * embrulho, imposto e gorjeta ficam de fora, como valores próprios. Sem
 * subtotal ITEM, cai para preço unitário × quantidade, marcado no pedido.
 *
 * MODALIDADE DE ENVIO (preservada, nunca fundida):
 *   fulfilledBy AMAZON                         → amazon_fba
 *   fulfilledBy MERCHANT + programa AMAZON_EASY_SHIP → amazon_easy_ship
 *   fulfilledBy MERCHANT sem Easy Ship         → amazon_envio_proprio
 *   ausente                                    → null
 */
import type { Cache } from '../lib/cache/cache.js';
import type { OrderSlim } from '../services/orders.service.js';
import type { ItemSlim } from '../lib/items-store.js';
import {
  readManifest, writeChunk, publishManifest, type Alvo, type OrdersManifest, type OrigemPublicacao,
} from '../lib/orders-store.js';
import { readCatalogManifest, writeCatalogChunk, publishCatalog, type CatalogManifest } from '../lib/items-store.js';
import { STATUS_VENDA_AMAZON } from '../lib/status-venda.js';
import { lerColecao, lerManifesto } from './store.js';
import type { PedidoAmazon } from './pedidos.js';
import type { AnuncioAmazon, EstoqueFbaAmazon, EstadoEstoqueFba } from './catalogo.js';
import { lerEstadoEstoqueFba } from './catalogo.js';
import { transacoesEconomicas, categoriaDaTransacao, tarifasAmazonDaTransacao, type TransacaoAmazon } from './financeiro.js';

export type ClasseStatusAmazon = 'pendente' | 'aprovado' | 'cancelado' | 'nao_atendivel' | 'desconhecido';

export const STATUS_AMAZON: Record<string, { classe: ClasseStatusAmazon; rotulo: string; motivo: string }> = {
  PENDING_AVAILABILITY: { classe: 'pendente', rotulo: 'Pré-venda', motivo: 'pré-venda; pagamento não autorizado' },
  PENDING: { classe: 'pendente', rotulo: 'Pendente', motivo: 'pedido feito, ainda não pronto para envio' },
  UNSHIPPED: { classe: 'aprovado', rotulo: 'A enviar', motivo: 'pronto para envio; nenhum item enviado' },
  PARTIALLY_SHIPPED: { classe: 'aprovado', rotulo: 'Enviado em parte', motivo: 'ao menos um item enviado, não todos' },
  SHIPPED: { classe: 'aprovado', rotulo: 'Enviado', motivo: 'todos os itens enviados' },
  CANCELLED: { classe: 'cancelado', rotulo: 'Cancelado', motivo: 'cancelado; não será atendido' },
  UNFULFILLABLE: { classe: 'nao_atendivel', rotulo: 'Não atendível', motivo: 'só FBA de pedido fora do site da Amazon' },
};

export function classeDoStatus(s: string | null): ClasseStatusAmazon {
  return (s && STATUS_AMAZON[s]?.classe) || 'desconhecido';
}

/** Status como as telas leem: prefixado, minúsculo. `amazon:desconhecido` quando ausente. */
export function statusDeLeitura(s: string | null): string {
  return 'amazon:' + (s ? s.toLowerCase() : 'desconhecido');
}

export type ModalidadeAmazon = 'amazon_fba' | 'amazon_easy_ship' | 'amazon_envio_proprio';

export function modalidadeDoPedido(p: Pick<PedidoAmazon, 'atendidoPor' | 'programas'>): ModalidadeAmazon | null {
  if (p.atendidoPor === 'AMAZON') return 'amazon_fba';
  if (p.atendidoPor === 'MERCHANT') return p.programas.includes('AMAZON_EASY_SHIP') ? 'amazon_easy_ship' : 'amazon_envio_proprio';
  return null;
}

/** Valor de produto de um item: ITEM − DISCOUNT (quando informados). null se não há base. */
export function valorDoItem(i: PedidoAmazon['itens'][number]): { valor: number; fonte: 'proceeds' | 'preco_unitario' } | null {
  const item = i.composicao.find(c => c.tipo === 'ITEM');
  if (item) {
    const desconto = i.composicao.filter(c => c.tipo === 'DISCOUNT').reduce((s, c) => s + Math.abs(c.valor.valor), 0);
    return { valor: arred(item.valor.valor - desconto), fonte: 'proceeds' };
  }
  if (i.precoUnitario) return { valor: arred(i.precoUnitario.valor * i.quantidade), fonte: 'preco_unitario' };
  return null;
}

/**
 * Pedido Amazon → OrderSlim de LEITURA. `total_amount` e `paid_amount` são o
 * valor dos produtos não cancelados (decisão acima); `sale_fee` fica AUSENTE
 * (a tarifa da Amazon só existe no financeiro lançado). `amazon` carrega o que
 * é só da Amazon, para a tela não precisar adivinhar.
 */
export type PedidoLeituraAmazon = OrderSlim & {
  conta: string;
  canal: 'amazon';
  amazon: {
    statusOriginal: string | null;
    classe: ClasseStatusAmazon;
    modalidade: ModalidadeAmazon | null;
    totalPago: { valor: number; moeda: string } | null;
    frete: number | null;
    itensCancelados: number;
    valorPorPrecoUnitario: boolean;
    moeda: string | null;
  };
};

export function projetarPedido(p: PedidoAmazon): PedidoLeituraAmazon {
  const ativos = p.itens.filter(i => !i.cancelamento?.executadoPor);
  let total = 0, semBase = false, porPreco = false;
  const order_items = ativos.map(i => {
    const v = valorDoItem(i);
    if (!v) semBase = true; else { total += v.valor; if (v.fonte === 'preco_unitario') porPreco = true; }
    return {
      quantity: i.quantidade,
      unit_price: i.precoUnitario?.valor ?? (v ? arred(v.valor / Math.max(1, i.quantidade)) : null),
      item: { id: i.asin, title: i.titulo, seller_sku: i.sku, variation_id: null },
    };
  });
  const valor = semBase ? null : arred(total);
  const frete = p.composicaoTotal.filter(c => c.tipo === 'SHIPPING').reduce((s, c) => s + c.valor.valor, 0);
  const modalidade = modalidadeDoPedido(p);
  return {
    id: p.orderId,
    status: statusDeLeitura(p.statusAtendimento),
    date_created: p.criadoEm,
    paid_amount: valor,
    total_amount: valor,
    order_items,
    shipping: { id: null, logistic_type: modalidade },
    conta: p.conta,
    canal: 'amazon',
    amazon: {
      statusOriginal: p.statusAtendimento,
      classe: classeDoStatus(p.statusAtendimento),
      modalidade,
      totalPago: p.totalPedido,
      frete: p.composicaoTotal.some(c => c.tipo === 'SHIPPING') ? arred(frete) : null,
      itensCancelados: p.itens.length - ativos.length,
      valorPorPrecoUnitario: porPreco,
      moeda: p.totalPedido?.moeda ?? p.itens.find(i => i.precoUnitario)?.precoUnitario?.moeda ?? null,
    },
  };
}

// ── Catálogo ───────────────────────────────────────────────────────────────

/**
 * Anúncio Amazon → ItemSlim de LEITURA. Um SKU vira até DUAS linhas, uma por
 * estoque, para FBA e estoque próprio nunca se somarem por engano:
 *   - `<sku>` (próprio): quantidade do canal DEFAULT — é o estoque do vendedor,
 *     usado tanto pelo Easy Ship quanto pelo envio próprio;
 *   - `<sku>#fba`: disponível no FBA, quando o estoque FBA foi lido. Sem leitura
 *     de FBA (conta sem FBA ou app sem a função), a linha não existe.
 * `logistic_type` é `amazon_proprio` / `amazon_fba` — nunca `fulfillment`, que
 * é o Full do Mercado Livre.
 */
export type ItemLeituraAmazon = ItemSlim & { canal: 'amazon'; asin: string | null; amazon: { estoque: 'proprio' | 'fba'; estoqueInformado: boolean } };

export function projetarCatalogo(anuncios: AnuncioAmazon[], fba: EstoqueFbaAmazon[], estadoFba: EstadoEstoqueFba | null): ItemLeituraAmazon[] {
  const out: ItemLeituraAmazon[] = [];
  const fbaPorSku = new Map(fba.filter(f => f.sku).map(f => [f.sku!, f]));
  for (const a of anuncios) {
    const status = a.status.includes('BUYABLE') ? 'active' : 'paused';
    const base = {
      title: a.titulo, status, price: a.preco?.valor ?? null, original_price: null, sold_quantity: null,
      listing_type_id: null, catalog_listing: null, permalink: a.asin ? `https://www.amazon.com.br/dp/${a.asin}` : null,
      thumbnail: a.imagem, last_updated: a.atualizadoEm, seller_custom_field: a.sku, seller_sku: a.sku, tags: null,
      attributes: [{ id: 'SELLER_SKU', value_name: a.sku }], canal: 'amazon' as const, asin: a.asin,
    };
    const temProprio = a.disponibilidade.some(d => d.canal === 'DEFAULT');
    const f = fbaPorSku.get(a.sku);
    if (temProprio || !f) {
      out.push({
        ...base, id: a.sku, available_quantity: a.estoqueProprio, inventory_id: null,
        shipping: { logistic_type: 'amazon_proprio' },
        amazon: { estoque: 'proprio', estoqueInformado: a.estoqueProprio !== null },
      });
    }
    if (f && estadoFba?.disponivel) {
      out.push({
        ...base, id: `${a.sku}#fba`, available_quantity: f.disponivel, inventory_id: f.fnSku,
        shipping: { logistic_type: 'amazon_fba' },
        amazon: { estoque: 'fba', estoqueInformado: f.disponivel !== null },
      });
    }
  }
  return out;
}

// ── Publicação nas bases que as rotas leem ─────────────────────────────────

const K = { assinatura: (c: string) => `amz:leitura:assinatura:${c}`, status: (a: Alvo) => `orders:sync:status:${a}` };
const POR_CHUNK = 500;

/**
 * Publica a leitura de pedidos (alvos `ativos` e `cancelados`) e o catálogo,
 * cada um só quando o conteúdo mudou — a versão só cresce quando há o que
 * recarregar, para o poll do dashboard não recarregar à toa. Grava também o
 * status de sincronização que a rota de status já expõe (`lastSyncAt`).
 */
export async function publicarLeitura(cache: Cache, opts: { agora?: Date; origem?: OrigemPublicacao; checouAmazon: boolean; resultado: 'ok' | 'parcial' | 'erro_parcial' }): Promise<{ pedidos: boolean; catalogo: boolean }> {
  const agora = opts.agora ?? new Date();
  // "Nunca lido" não é "zero pedidos": sem nenhum pedido gravado E sem uma
  // janela de pedidos lida até o fim, nada é publicado e a tela diz não pronto.
  const algumaJanelaLida = (await cache.get('amz:pedidos:cursor')) !== null;
  const gravados = await lerColecao<PedidoAmazon>(cache, 'pedidos');
  const podePublicar = gravados.length > 0 || algumaJanelaLida;
  const pedidos = gravados.map(projetarPedido)
    .sort((a, b) => (b.date_created ?? '').localeCompare(a.date_created ?? ''));
  let publicouPedidos = false;
  for (const alvo of ['ativos', 'cancelados'] as const) {
    const lista = alvo === 'ativos' ? pedidos : pedidos.filter(p => p.amazon.classe === 'cancelado');
    if (podePublicar && await trocouAssinatura(cache, `pedidos:${alvo}`, lista)) {
      await publicarPedidos(cache, alvo, lista, agora, opts.origem ?? 'incremental');
      publicouPedidos = true;
    }
    // O resultado da consulta é registrado mesmo sem nada publicado: a tela
    // precisa dizer "a última consulta falhou" em vez de ficar muda.
    if (opts.checouAmazon) {
      const man = await readManifest(cache, alvo);
      await cache.set(K.status(alvo), JSON.stringify({
        ultimaVersao: man?.versao ?? null, totalRegistros: man?.totalRegistros ?? 0, newestDate: man?.newestDate ?? null,
        lastSyncAt: agora.toISOString(), lastResult: opts.resultado, emAndamento: opts.resultado !== 'ok',
      }));
    }
  }

  return { pedidos: publicouPedidos, catalogo: await publicarSoCatalogo(cache, agora) };
}

/** Catálogo só existe depois de uma varredura COMPLETA de anúncios (manifesto da coleção). */
async function publicarSoCatalogo(cache: Cache, agora: Date): Promise<boolean> {
  if (!(await lerManifesto(cache, 'anuncios'))) return false;
  const anuncios = await lerColecao<AnuncioAmazon>(cache, 'anuncios');
  const itens = projetarCatalogo(anuncios, await lerColecao<EstoqueFbaAmazon>(cache, 'estoque-fba'), await lerEstadoEstoqueFba(cache));
  if (!(await trocouAssinatura(cache, 'catalogo', itens))) return false;
  await publicarCatalogo(cache, itens, agora);
  return true;
}

async function trocouAssinatura(cache: Cache, nome: string, valor: unknown): Promise<boolean> {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256').update(JSON.stringify(valor)).digest('hex');
  if ((await cache.get(K.assinatura(nome))) === h) return false;
  await cache.set(K.assinatura(nome), h);
  return true;
}

async function publicarPedidos(cache: Cache, alvo: Alvo, lista: OrderSlim[], agora: Date, origem: OrigemPublicacao): Promise<void> {
  const atual = await readManifest(cache, alvo);
  const versao = (atual?.versao ?? 0) + 1;
  const chunks: string[] = [], counts: number[] = [];
  for (let i = 0; i * POR_CHUNK < lista.length; i++) {
    const parte = lista.slice(i * POR_CHUNK, (i + 1) * POR_CHUNK);
    chunks.push(await writeChunk(cache, alvo, versao, i, parte));
    counts.push(parte.length);
  }
  const datas = lista.map(p => p.date_created).filter((d): d is string => !!d).sort();
  const man: OrdersManifest = {
    versao, chunks, totalRegistros: lista.length,
    newestDate: datas[datas.length - 1] ?? null, oldestDate: datas[0] ?? null,
    chunkSize: POR_CHUNK, updatedAt: agora.toISOString(), origem, chunkCounts: counts,
  };
  await publishManifest(cache, alvo, man);
}

async function publicarCatalogo(cache: Cache, itens: ItemLeituraAmazon[], agora: Date): Promise<void> {
  const atual = await readCatalogManifest(cache).catch(() => null);
  const versao = (atual?.versao ?? 0) + 1;
  const ordem = { active: 0, paused: 1, closed: 2 } as Record<string, number>;
  const lista = [...itens].sort((a, b) => (ordem[a.status ?? ''] ?? 3) - (ordem[b.status ?? ''] ?? 3));
  const chunks: string[] = [];
  for (let i = 0; i * POR_CHUNK < lista.length; i++) chunks.push(await writeCatalogChunk(cache, versao, i, lista.slice(i * POR_CHUNK, (i + 1) * POR_CHUNK)));
  const man: CatalogManifest = {
    versao, chunks, chunkSize: POR_CHUNK, updatedAt: agora.toISOString(), complete: true,
    counts: {
      total: lista.length,
      active: lista.filter(i => i.status === 'active').length,
      paused: lista.filter(i => i.status === 'paused').length,
      closed: lista.filter(i => i.status === 'closed').length,
    },
  };
  await publishCatalog(cache, man);
}

// ── Financeiro LANÇADO por pedido (evidência de reembolso) ─────────────────

/**
 * Pedidos com débito financeiro lançado (transação negativa vinculada), uma
 * ocorrência por lançamento. Etiqueta de envio (custo_envio) e repasse NÃO são
 * débito de reembolso: ficam fora daqui.
 */
export function debitosPorPedido(transacoes: readonly TransacaoAmazon[]): Map<string, { valor: number; moeda: string; descricoes: string[] }> {
  const m = new Map<string, { valor: number; moeda: string; descricoes: string[] }>();
  for (const t of transacoesEconomicas(transacoes).transacoes) {
    if (!t.pedidoId || !t.total || t.total.valor >= 0) continue;
    const cat = categoriaDaTransacao(t);
    if (cat === 'custo_envio' || cat === 'repasse') continue;
    const atual = m.get(t.pedidoId) ?? { valor: 0, moeda: t.total.moeda, descricoes: [] };
    if (atual.moeda !== t.total.moeda) continue;
    atual.valor = arred(atual.valor + t.total.valor);
    if (t.descricao && !atual.descricoes.includes(t.descricao)) atual.descricoes.push(t.descricao);
    m.set(t.pedidoId, atual);
  }
  return m;
}

export const STATUS_DE_LEITURA_QUE_CONTAM: readonly string[] = [...STATUS_VENDA_AMAZON];

// ── Financeiro da conta Amazon no período (para a consolidação) ────────────

export interface FinanceiroAmazonDoPeriodo {
  /** Período lido do financeiro (por data de lançamento). null = nunca lido. */
  lidoDesde: string | null;
  lidoAte: string | null;
  /** Vendas do período (pedidos aprovados) e o que se sabe do dinheiro de cada uma. */
  pedidos: { vendas: number; comTransacoes: number; semTransacoesAteLeitura: number; foraDaLeitura: number };
  /** Faturamento (dos PEDIDOS) só das vendas que têm transação lançada. */
  faturamentoComTransacoes: number;
  /** Soma das transações lançadas dessas vendas. NÃO é o líquido do período: pode haver lançamentos futuros. */
  lancadoDessasVendas: number;
  /** Transações dessas vendas ainda retidas (DEFERRED). */
  retidas: number;
  /** Vendas com transação NEGATIVA vinculada (possível reembolso ou ajuste), e quanto. */
  debitos: { pedidos: number; valor: number };
  /** Lançamentos OPERACIONAIS do período SEM pedido (anúncios, armazenagem, ajustes): dinheiro lançado, não venda. Sem repasses. */
  lancamentosSemPedido: { quantidade: number; valor: number };
  /** Repasses do período (Transfer, ex.: Disbursement): saldo movido para o banco. Nem receita nem despesa; fora de qualquer soma acima. */
  repasses: { quantidade: number; valor: number };
  /** Etiquetas de envio compradas na Amazon (MfnPostageFee) dessas vendas: custo logístico, não reembolso. */
  custoEnvio: { pedidos: number; valor: number };
  /**
   * Composição de `lancadoDessasVendas` por natureza. vendas + reembolsos +
   * custoEnvio + outros = lancadoDessasVendas. `tarifasAmazon` é PARTE de
   * `vendas` (a Amazon já desconta a tarifa na transação da venda), não uma
   * parcela a somar.
   */
  porCategoria: { vendas: number; tarifasAmazon: number; reembolsos: number; custoEnvio: number; outros: number };
  /** Liberações retiradas por serem o mesmo dinheiro da transação original (par DEFERRED_RELEASED + RELEASED). */
  duplicidadesRemovidas: number;
  /** Pares ligados de valor diferente: mantidos e apontados. */
  paresDivergentes: number;
  moeda: string | null;
  conciliado: false;
}

export function financeiroAmazonDoPeriodo(
  vendas: ReadonlyArray<{ id: string | number; date_created: string | null; paid_amount: number | null }>,
  transacoes: readonly TransacaoAmazon[],
  cobertura: { desde: string; ate: string } | null,
  periodo: { ini: Date; fim: Date },
): FinanceiroAmazonDoPeriodo {
  const eco = transacoesEconomicas(transacoes);
  const porPedido = new Map<string, TransacaoAmazon[]>();
  for (const t of eco.transacoes) {
    if (!t.pedidoId) continue;
    const l = porPedido.get(t.pedidoId) ?? [];
    l.push(t);
    porPedido.set(t.pedidoId, l);
  }
  const debitos = debitosPorPedido(eco.transacoes);
  let com = 0, sem = 0, fora = 0, fat = 0, lancado = 0, retidas = 0, dPed = 0, dVal = 0, ePed = 0, eVal = 0;
  const cat = { vendas: 0, tarifasAmazon: 0, reembolsos: 0, custoEnvio: 0, outros: 0 };
  const moedas = new Set<string>();
  for (const v of vendas) {
    const id = String(v.id);
    const ts = porPedido.get(id) ?? [];
    if (ts.length) {
      com++; fat += v.paid_amount ?? 0;
      let envio = 0;
      for (const t of ts) {
        if (t.total) {
          lancado += t.total.valor; moedas.add(t.total.moeda);
          const c = categoriaDaTransacao(t);
          if (c === 'venda') { cat.vendas += t.total.valor; cat.tarifasAmazon += tarifasAmazonDaTransacao(t); }
          else if (c === 'reembolso') cat.reembolsos += t.total.valor;
          else if (c === 'custo_envio') { cat.custoEnvio += t.total.valor; envio += t.total.valor; }
          else cat.outros += t.total.valor;
        }
        if (t.status === 'DEFERRED') retidas++;
      }
      if (envio) { ePed++; eVal += envio; }
    } else if (cobertura && v.date_created && v.date_created >= cobertura.desde && v.date_created <= cobertura.ate) sem++;
    else fora++;
    const d = debitos.get(id);
    if (d) { dPed++; dVal += d.valor; }
  }
  const ini = periodo.ini.toISOString(), fim = periodo.fim.toISOString();
  const doPeriodo = eco.transacoes.filter(t => !t.pedidoId && t.lancadaEm && t.lancadaEm >= ini && t.lancadaEm <= fim && t.total);
  const soltas = doPeriodo.filter(t => categoriaDaTransacao(t) !== 'repasse');
  const repasses = doPeriodo.filter(t => categoriaDaTransacao(t) === 'repasse');
  for (const t of doPeriodo) moedas.add(t.total!.moeda);
  return {
    lidoDesde: cobertura?.desde ?? null, lidoAte: cobertura?.ate ?? null,
    pedidos: { vendas: vendas.length, comTransacoes: com, semTransacoesAteLeitura: sem, foraDaLeitura: fora },
    faturamentoComTransacoes: arred(fat), lancadoDessasVendas: arred(lancado), retidas,
    debitos: { pedidos: dPed, valor: arred(dVal) },
    lancamentosSemPedido: { quantidade: soltas.length, valor: arred(soltas.reduce((s, t) => s + t.total!.valor, 0)) },
    repasses: { quantidade: repasses.length, valor: arred(repasses.reduce((s, t) => s + t.total!.valor, 0)) },
    custoEnvio: { pedidos: ePed, valor: arred(eVal) },
    porCategoria: {
      vendas: arred(cat.vendas), tarifasAmazon: arred(cat.tarifasAmazon), reembolsos: arred(cat.reembolsos),
      custoEnvio: arred(cat.custoEnvio), outros: arred(cat.outros),
    },
    duplicidadesRemovidas: eco.duplicidadesRemovidas,
    paresDivergentes: eco.paresDivergentes,
    moeda: moedas.size === 1 ? [...moedas][0] : null,
    conciliado: false,
  };
}

const arred = (n: number) => Math.round(n * 100) / 100;
