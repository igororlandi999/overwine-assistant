/**
 * Financeiro da Amazon — Finances API v2024-06-19, `listTransactions`.
 *
 * O que a Amazon de fato lançou, transação por transação, sem tabela de
 * tarifas, sem percentual estimado e sem nada do Mercado Livre.
 *
 * LEITURA por data de lançamento (`postedAfter`/`postedBefore`), em janelas
 * de no máximo 180 dias (acima disso a API devolve vazio). O cursor só avança
 * até o fim de uma janela lida até a última página.
 *
 * Uma transação lançada como DEFERRED (retida) muda depois para
 * DEFERRED_RELEASED com a mesma data de lançamento, e uma leitura que só anda
 * para frente nunca veria a mudança. Por isso cada janela recomeça na
 * transação retida mais antiga ainda não liberada.
 *
 * COBERTURA ≠ CONCILIAÇÃO. A documentação avisa que transações das últimas
 * 48 h podem faltar, mas completar 48 h não garante nada: um pedido pode
 * receber reembolso, ajuste ou liberação semanas depois. Este módulo diz só o
 * que RECEBEU e até quando leu. O valor por pedido nunca sai como conciliado:
 * conciliar exige comparar com a tela do Seller Central, pedido a pedido
 * (mesma regra das vendas do Mercado Livre).
 */
import type { Cache } from '../lib/cache/cache.js';
import type { ClienteSpApi } from './cliente.js';
import { mesclarColecao, lerColecao } from './store.js';
import { FOLGA_DATA_FINAL_MS, JANELA_FINANCEIRO_MAX_MS } from './contrato.js';
import type { PedidoAmazon, Valor } from './pedidos.js';

// ── Contrato (subconjunto lido) ────────────────────────────────────────────
interface Currency { currencyCode?: string; currencyAmount?: number | string }
interface ApiBreakdown { breakdownType?: string; breakdownAmount?: Currency; breakdowns?: ApiBreakdown[] }
interface ApiTransaction {
  transactionId?: string;
  transactionType?: string;
  transactionStatus?: string;
  description?: string;
  postedDate?: string;
  totalAmount?: Currency;
  relatedIdentifiers?: Array<{ relatedIdentifierName?: string; relatedIdentifierValue?: string }>;
  marketplaceDetails?: { marketplaceId?: string };
  breakdowns?: ApiBreakdown[];
}
export interface ListTransactionsResponse { payload?: { nextToken?: string; transactions?: ApiTransaction[] } }

// ── Formato gravado ────────────────────────────────────────────────────────
export interface ComposicaoAmazon { tipo: string; valor: Valor | null; partes: ComposicaoAmazon[] }

export interface TransacaoAmazon {
  canal: 'amazon';
  conta: string;
  transactionId: string;
  tipo: string | null;
  status: string | null;
  descricao: string | null;
  lancadaEm: string | null;
  total: Valor | null;
  pedidoId: string | null;
  identificadores: Array<{ nome: string; valor: string }>;
  marketplaceId: string | null;
  /** Árvore de composição COMO a Amazon a nomeia (breakdownType); nenhum nome é inventado aqui. */
  composicao: ComposicaoAmazon[];
}

function valor(c: Currency | undefined): Valor | null {
  if (!c || c.currencyAmount === undefined || c.currencyAmount === null) return null;
  const n = Number(c.currencyAmount);
  return Number.isFinite(n) && c.currencyCode ? { valor: n, moeda: c.currencyCode } : null;
}
function arvore(b: ApiBreakdown[] | undefined): ComposicaoAmazon[] {
  return (b ?? []).map(x => ({ tipo: x.breakdownType ?? '(sem tipo)', valor: valor(x.breakdownAmount), partes: arvore(x.breakdowns) }));
}

/**
 * Identidade estável de uma transação. Usa `transactionId`; se a Amazon não o
 * mandar, uma composição dos campos que não mudam com o status.
 */
function idDaTransacao(t: ApiTransaction): string {
  if (t.transactionId) return t.transactionId;
  const ids = (t.relatedIdentifiers ?? []).map(r => `${r.relatedIdentifierName}=${r.relatedIdentifierValue}`).sort().join('&');
  return `sem-id:${t.postedDate}|${t.transactionType}|${t.description}|${ids}|${t.totalAmount?.currencyAmount}`;
}

export function normalizarTransacao(t: ApiTransaction, conta: string): TransacaoAmazon {
  const ids = (t.relatedIdentifiers ?? [])
    .filter(r => r.relatedIdentifierName && r.relatedIdentifierValue)
    .map(r => ({ nome: r.relatedIdentifierName!, valor: r.relatedIdentifierValue! }));
  return {
    canal: 'amazon', conta,
    transactionId: idDaTransacao(t),
    tipo: t.transactionType ?? null,
    status: t.transactionStatus ?? null,
    descricao: t.description ?? null,
    lancadaEm: t.postedDate ?? null,
    total: valor(t.totalAmount),
    pedidoId: ids.find(i => i.nome === 'ORDER_ID')?.valor ?? null,
    identificadores: ids,
    marketplaceId: t.marketplaceDetails?.marketplaceId ?? null,
    composicao: arvore(t.breakdowns),
  };
}

// ── Sincronização ──────────────────────────────────────────────────────────
const K = { cursor: 'amz:financeiro:cursor', job: 'amz:financeiro:job' };

/** Período lido até a última página. `desde` não muda depois da primeira janela. */
export interface CoberturaFinanceira { desde: string; ate: string }
interface JobFin { de: string; ate: string; token: string | null; paginas: number; desde: string }

export interface ResultadoFinanceiro { concluido: boolean; paginas: number; transacoes: number; janela: { de: string; ate: string }; cobertura: CoberturaFinanceira | null }

export async function sincronizarFinanceiro(
  cache: Cache, cliente: ClienteSpApi,
  o: { conta: string; marketplaceId: string; agora?: () => number; maxPaginas?: number; cargaInicialDias?: number; prazo?: number },
): Promise<ResultadoFinanceiro> {
  const agora = o.agora ?? Date.now;
  const cobertura = await lerJson<CoberturaFinanceira>(cache, K.cursor);
  let job = await lerJson<JobFin>(cache, K.job);

  if (!job) {
    const inicioCarga = new Date(agora() - Math.min(o.cargaInicialDias ?? 180, 720) * 86_400_000).toISOString();
    let de = cobertura?.ate ?? inicioCarga;
    // Recomeça na retida mais antiga ainda não liberada, para ver a liberação.
    const retida = await retidaMaisAntiga(cache);
    if (retida && retida < de) de = retida;
    const limite = agora() - FOLGA_DATA_FINAL_MS;
    const ate = new Date(Math.min(limite, Date.parse(de) + JANELA_FINANCEIRO_MAX_MS - 60_000)).toISOString();
    if (ate <= de) return { concluido: true, paginas: 0, transacoes: 0, janela: { de, ate }, cobertura };
    job = { de, ate, token: null, paginas: 0, desde: cobertura?.desde ?? de };
    await cache.set(K.job, JSON.stringify(job));
  }

  let paginas = 0, transacoes = 0;
  while (paginas < (o.maxPaginas ?? 10) && (o.prazo === undefined || agora() < o.prazo)) {
    const resp: ListTransactionsResponse = await cliente.chamar<ListTransactionsResponse>('listTransactions', {
      query: { postedAfter: job.de, postedBefore: job.ate, marketplaceId: o.marketplaceId, nextToken: job.token ?? undefined },
    });
    paginas++;
    const lote: TransacaoAmazon[] = (resp.payload?.transactions ?? []).map((t: ApiTransaction) => normalizarTransacao(t, o.conta));
    if (lote.length) await mesclarColecao(cache, 'financeiro', lote, t => t.transactionId);
    transacoes += lote.length;
    // "Note that this operation can return empty pages": página vazia com token segue.
    job = { ...job, token: resp.payload?.nextToken ?? null, paginas: job.paginas + 1 };
    if (!job.token) {
      const nova: CoberturaFinanceira = { desde: job.desde < (cobertura?.desde ?? job.desde) ? job.desde : (cobertura?.desde ?? job.desde), ate: maior(job.ate, cobertura?.ate) };
      await cache.set(K.cursor, JSON.stringify(nova));
      await cache.del(K.job);
      return { concluido: true, paginas, transacoes, janela: { de: job.de, ate: job.ate }, cobertura: nova };
    }
    await cache.set(K.job, JSON.stringify(job));
  }
  return { concluido: false, paginas, transacoes, janela: { de: job.de, ate: job.ate }, cobertura };
}

async function retidaMaisAntiga(cache: Cache): Promise<string | null> {
  const ts = await lerColecao<TransacaoAmazon>(cache, 'financeiro');
  let menor: string | null = null;
  for (const t of ts) if (t.status === 'DEFERRED' && t.lancadaEm && (!menor || t.lancadaEm < menor)) menor = t.lancadaEm;
  return menor;
}

export async function lerCoberturaFinanceira(cache: Cache): Promise<CoberturaFinanceira | null> {
  return lerJson<CoberturaFinanceira>(cache, K.cursor);
}

// ── Apuração por pedido ────────────────────────────────────────────────────
export type SituacaoFinanceira =
  /** Pedido fora do período já lido: não se sabe nada ainda. */
  | 'fora_da_cobertura'
  /** Nenhuma transação deste pedido lançada até o fim da cobertura. Não quer dizer zero nem que não virá. */
  | 'sem_transacoes'
  /** Há transações recebidas. Valor PROVISÓRIO: pode haver lançamentos futuros. */
  | 'transacoes_recebidas';

export interface FinanceiroDoPedido {
  orderId: string;
  situacao: SituacaoFinanceira;
  /** Até quando o financeiro foi lido. A resposta vale só até aqui. */
  lidoAte: string | null;
  /** Soma dos totais das transações recebidas. null se não há, ou se as moedas diferem. */
  liquidoRecebido: Valor | null;
  transacoes: number;
  /** Transações ainda retidas (DEFERRED). */
  retidas: number;
  /** Total por breakdownType de primeiro nível, com os nomes da Amazon. */
  porTipo: Array<{ tipo: string; valor: Valor }>;
  moedasMistas: boolean;
  /** Sempre false aqui: conciliação só por comparação com o Seller Central. */
  conciliado: false;
}

export function apurarPedido(p: Pick<PedidoAmazon, 'orderId' | 'criadoEm'>, transacoes: TransacaoAmazon[], cobertura: CoberturaFinanceira | null): FinanceiroDoPedido {
  const minhas = transacoes.filter(t => t.pedidoId === p.orderId);
  const base = { orderId: p.orderId, lidoAte: cobertura?.ate ?? null, transacoes: minhas.length, retidas: minhas.filter(t => t.status === 'DEFERRED').length, conciliado: false as const };
  if (!minhas.length) {
    // Venda feita depois do fim da leitura (ou antes do início) não foi "sem transação": não foi lida.
    const dentro = cobertura && p.criadoEm >= cobertura.desde && p.criadoEm <= cobertura.ate;
    return { ...base, situacao: dentro ? 'sem_transacoes' : 'fora_da_cobertura', liquidoRecebido: null, porTipo: [], moedasMistas: false };
  }
  const moedas = new Set(minhas.map(t => t.total?.moeda).filter(Boolean));
  const mistas = moedas.size > 1 || minhas.some(t => !t.total);
  const liquido = mistas ? null : { valor: arred(minhas.reduce((s, t) => s + t.total!.valor, 0)), moeda: [...moedas][0] as string };
  const tipos = new Map<string, Valor>();
  for (const t of minhas) for (const c of t.composicao) {
    if (!c.valor) continue;
    const atual = tipos.get(c.tipo);
    if (atual && atual.moeda !== c.valor.moeda) continue;
    tipos.set(c.tipo, { valor: arred((atual?.valor ?? 0) + c.valor.valor), moeda: c.valor.moeda });
  }
  return { ...base, situacao: 'transacoes_recebidas', liquidoRecebido: liquido, porTipo: [...tipos].map(([tipo, valor]) => ({ tipo, valor })), moedasMistas: mistas };
}

const arred = (n: number) => Math.round(n * 100) / 100;
const maior = (a: string, b: string | undefined) => (b && b > a ? b : a);

async function lerJson<T>(cache: Cache, k: string): Promise<T | null> {
  const raw = await cache.get(k);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export const CHAVES_FINANCEIRO = K;
