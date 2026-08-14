/**
 * sales-metrics.service — métricas determinísticas de vendas por período.
 *
 * Serviço PURO: sem Redis, sem fetch, sem DOM, sem globais, sem formatação de
 * moeda, sem IA. Recebe os pedidos já lidos e devolve números prontos. A Gemini
 * NUNCA calcula estes valores — ela apenas os redige.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CONVENÇÕES (Fase 5g, decididas explicitamente):
 *
 * 1. STATUS: todas as métricas consideram SOMENTE `status === 'paid'`.
 *    Cancelados E pendentes ficam de fora. Isto difere de `vendasPorItem`
 *    (orders.service), que usa `!== 'cancelled'` e portanto conta pendentes —
 *    misturar as duas convenções faria faturamento e contagem divergirem por
 *    construção, então aqui a regra é única e explícita.
 *
 * 2. RECEITA: `paid_amount || 0`, SEM cair para total_amount.
 *    Paridade com o card do dashboard (renderPedidos), que é a referência que
 *    o usuário vê. `faturamentoPeriodo` (orders.service) usa
 *    `paid_amount || total_amount || 0` e por isso NÃO é reutilizada aqui.
 *
 * 3. UNIDADES: soma `quantity` de TODOS os order_items, não apenas o primeiro
 *    (`vendasPorItem` indexa só order_items[0] e subcontaria multi-item).
 *    O fallback para 1 aplica-se SOMENTE a null/undefined (`?? 1`):
 *    `quantity: 0` é um valor legítimo e permanece 0.
 *
 * 4. PERÍODO: intervalo [from, to] em dias civis de America/Sao_Paulo, com
 *    AMBAS as bordas INCLUSIVAS (delegado a brtStartOfDay/brtEndOfDay/
 *    dentroDoPeriodo de datas-brt — nenhuma lógica de fuso é reimplementada).
 *
 * 5. COBERTURA: oldestDate/newestDate são TIMESTAMPS do primeiro e do último
 *    pedido do snapshot — não garantem que os dias correspondentes estejam
 *    integralmente cobertos. Se o primeiro pedido é de 10:30, o dia dele não
 *    tem dados das 00:00 às 10:30. Por isso os limites são comparados como
 *    INSTANTES: o dia do oldest e o dia do newest são marcados parciais salvo
 *    quando coincidem exatamente com o início/fim do dia. Um período fora da
 *    janela retorna `disponivel: false` — NUNCA zero disfarçado de fato.
 *
 * 6. `partial` (do status de leitura) indica apenas SNAPSHOT PARCIAL segundo o
 *    contrato atual da rota. Não afirmamos aqui que há "sincronização em
 *    andamento" — o contrato não expõe esse significado (não existe campo
 *    syncPending), então o warning é neutro: cobertura potencialmente
 *    incompleta.
 */
import { brtStartOfDay, brtEndOfDay, ymdBRT, ymdValido, dentroDoPeriodo } from '../lib/datas-brt.js';
import type { OrderSlim } from './orders.service.js';

/** Período resolvido: dias civis BRT, bordas inclusivas. */
export interface PeriodoYmd {
  fromYmd: string;
  toYmd: string;
}

/** Janela de dados realmente disponível, vinda do manifesto do snapshot. */
export interface CoberturaSnapshot {
  /**
   * oldestDate do manifesto: TIMESTAMP (ISO com offset) do pedido mais antigo,
   * ou null se não houver dados. Não é garantia de dia completo.
   */
  oldestDate: string | null;
  /** newestDate do manifesto: TIMESTAMP do pedido mais recente, ou null. */
  newestDate: string | null;
  /** partial do status de leitura: snapshot parcial (semântica do contrato atual). */
  partial: boolean;
  /**
   * lastSyncAt do status: TIMESTAMP da última sincronização concluída.
   * Existe porque "não há pedido depois de X" NÃO é o mesmo que "não sabemos o
   * que houve depois de X": um dia varrido sem nenhuma venda é conhecido e vale
   * zero. Sem este campo, toda manhã antes da primeira venda o sistema
   * declarava o dia indisponível. Ver `janelaAte`.
   */
  lastSyncAt?: string | null;
  /**
   * lastResult do status. A janela só é estendida até lastSyncAt quando a
   * sincronização TERMINOU BEM — o timestamp é gravado mesmo em falha, e
   * confiar nele nesse caso afirmaria cobertura que não existe.
   */
  lastResult?: string | null;
}

/**
 * Desfechos de sincronização que autorizam estender a janela conhecida até
 * lastSyncAt. 'sem_novos' É sucesso: significa que a varredura rodou e não
 * encontrou pedido algum — exatamente o caso do dia sem vendas.
 */
const SYNC_RESULTS_CONFIAVEIS: ReadonlySet<string> = new Set(['ok', 'sem_novos']);

/**
 * Instante até o qual a janela é CONHECIDA: o mais recente entre o último
 * pedido e a última sincronização bem-sucedida. Devolve também a origem, para
 * que o chamador saiba se o limite veio de dado ou de varredura.
 */
export function janelaAte(c: CoberturaSnapshot): { instante: number; origem: 'pedido' | 'sync' } | null {
  const tNewest = c.newestDate ? new Date(c.newestDate).getTime() : NaN;
  const temPedido = Number.isFinite(tNewest);

  const confiavel = typeof c.lastResult === 'string' && SYNC_RESULTS_CONFIAVEIS.has(c.lastResult);
  const tSync = confiavel && c.lastSyncAt ? new Date(c.lastSyncAt).getTime() : NaN;
  const temSync = Number.isFinite(tSync);

  if (temSync && (!temPedido || tSync > tNewest)) return { instante: tSync, origem: 'sync' };
  if (temPedido) return { instante: tNewest, origem: 'pedido' };
  return null;
}

export type CoberturaTipo = 'total' | 'parcial' | 'indisponivel';

export interface CoberturaResultado {
  tipo: CoberturaTipo;
  /** Período efetivamente calculado (interseção com a janela). null se indisponível. */
  periodoEfetivo: PeriodoYmd | null;
  /** Dia BRT do oldestDate/newestDate, para mensagens precisas. */
  dadosDesdeYmd: string | null;
  dadosAteYmd: string | null;
  /** true quando o dia de dadosDesdeYmd/dadosAteYmd NÃO está integralmente coberto. */
  primeiroDiaIncompleto: boolean;
  ultimoDiaIncompleto: boolean;
  warnings: string[];
}

export interface MetricasVendas {
  /** Receita: Σ paid_amount de pedidos 'paid' no período. */
  receita: number;
  /** Quantidade de pedidos 'paid' no período. */
  pedidos: number;
  /** receita / pedidos. null quando não há pedidos pagos (evita divisão por zero). */
  ticketMedio: number | null;
  /** Σ quantity de TODOS os order_items dos pedidos 'paid' no período. */
  unidades: number;
}

export interface ResultadoConsulta {
  /** false quando o período está inteiramente fora da janela de dados. */
  disponivel: boolean;
  /** Período pedido (como resolvido pelo parser). */
  periodoSolicitado: PeriodoYmd;
  /** Período realmente calculado (interseção com a cobertura). */
  periodoCalculado: PeriodoYmd | null;
  cobertura: CoberturaTipo;
  /** null quando disponivel === false — nunca zeros que pareçam fato. */
  metricas: MetricasVendas | null;
  warnings: string[];
}

/** Códigos de warning (estáveis; a redação fica com a camada de resposta). */
export const WARN_COBERTURA_PARCIAL_INICIO = 'cobertura_parcial_inicio';
export const WARN_COBERTURA_PARCIAL_FIM = 'cobertura_parcial_fim';
/**
 * Snapshot marcado como parcial pelo status de leitura. Formulação NEUTRA: o
 * contrato atual não diz o motivo (não há syncPending), apenas que a cobertura
 * pode estar incompleta.
 */
export const WARN_SNAPSHOT_PARCIAL = 'snapshot_parcial';
export const WARN_SEM_DADOS_NO_PERIODO = 'sem_dados_no_periodo';

/** true se o período tem from <= to e ambos são YMD válidos de calendário. */
export function periodoValido(p: PeriodoYmd | null | undefined): p is PeriodoYmd {
  if (!p) return false;
  if (!ymdValido(p.fromYmd) || !ymdValido(p.toYmd)) return false;
  return p.fromYmd <= p.toYmd; // YYYY-MM-DD é ordenável lexicograficamente
}

/**
 * Interseção do período pedido com a janela de dados do snapshot.
 *
 * Os limites são TIMESTAMPS: o dia do primeiro pedido não tem dados antes dele,
 * e o dia do último não tem dados depois dele. Regras (Fase 5g):
 *  - período inteiramente antes do dia do oldest  → indisponivel
 *  - período inteiramente depois do dia do newest → indisponivel
 *  - começa antes do dia do oldest                → recorta e avisa (parcial)
 *  - termina depois do dia do newest              → recorta e avisa (parcial)
 *  - INCLUI o dia do oldest e esse dia é incompleto  → parcial (aviso início)
 *  - INCLUI o dia do newest e esse dia é incompleto  → parcial (aviso fim)
 *  - somente dias integralmente cobertos e partial === false → total
 *  - partial === true → warning adicional, sem mudar o tipo
 */
export function avaliarCobertura(
  periodo: PeriodoYmd,
  cobertura: CoberturaSnapshot
): CoberturaResultado {
  const warnings: string[] = [];
  if (cobertura.partial) warnings.push(WARN_SNAPSHOT_PARCIAL);

  // Dia civil BRT de cada limite + o instante exato, para saber se o dia é integral.
  const desde = ymdBRT(cobertura.oldestDate);
  // O fim da janela é o mais recente entre o último pedido e a última
  // sincronização bem-sucedida — ver janelaAte.
  const limite = janelaAte(cobertura);
  const ate = limite ? ymdBRT(new Date(limite.instante).toISOString()) : null;

  // Sem janela conhecida: não há como afirmar cobertura.
  if (!desde || !ate) {
    return {
      tipo: 'indisponivel',
      periodoEfetivo: null,
      dadosDesdeYmd: desde,
      dadosAteYmd: ate,
      primeiroDiaIncompleto: false,
      ultimoDiaIncompleto: false,
      warnings,
    };
  }

  // O dia do oldest só é integral se o primeiro pedido estiver exatamente em
  // 00:00:00.000 BRT; idem para o newest em 23:59:59.999 BRT.
  const tOldest = new Date(cobertura.oldestDate as string).getTime();
  const tNewest = limite!.instante;
  const inicioDoDiaDesde = brtStartOfDay(desde)?.getTime() ?? NaN;
  const fimDoDiaAte = brtEndOfDay(ate)?.getTime() ?? NaN;
  const primeiroDiaIncompleto = !(tOldest <= inicioDoDiaDesde);
  const ultimoDiaIncompleto = !(tNewest >= fimDoDiaAte);

  // Fora da janela por completo (dos dois lados).
  if (periodo.toYmd < desde || periodo.fromYmd > ate) {
    return {
      tipo: 'indisponivel',
      periodoEfetivo: null,
      dadosDesdeYmd: desde,
      dadosAteYmd: ate,
      primeiroDiaIncompleto,
      ultimoDiaIncompleto,
      warnings,
    };
  }

  // Recorte: interseção [max(from, desde), min(to, ate)].
  const fromEfetivo = periodo.fromYmd < desde ? desde : periodo.fromYmd;
  const toEfetivo = periodo.toYmd > ate ? ate : periodo.toYmd;

  let parcial = false;
  // (a) o pedido extrapola a janela; (b) o pedido toca um dia-limite incompleto.
  if (periodo.fromYmd < desde || (primeiroDiaIncompleto && fromEfetivo <= desde && toEfetivo >= desde)) {
    warnings.push(WARN_COBERTURA_PARCIAL_INICIO);
    parcial = true;
  }
  if (periodo.toYmd > ate || (ultimoDiaIncompleto && toEfetivo >= ate && fromEfetivo <= ate)) {
    warnings.push(WARN_COBERTURA_PARCIAL_FIM);
    parcial = true;
  }

  return {
    tipo: parcial ? 'parcial' : 'total',
    periodoEfetivo: { fromYmd: fromEfetivo, toYmd: toEfetivo },
    dadosDesdeYmd: desde,
    dadosAteYmd: ate,
    primeiroDiaIncompleto,
    ultimoDiaIncompleto,
    warnings,
  };
}

/**
 * Calcula as métricas de vendas do período. SOMENTE status 'paid'; bordas
 * inclusivas em America/Sao_Paulo. Não conhece cobertura — quem decide se o
 * período é válido é `calcularConsulta`.
 */
export function calcularMetricas(orders: OrderSlim[], periodo: PeriodoYmd): MetricasVendas {
  const inicio = brtStartOfDay(periodo.fromYmd);
  const fim = brtEndOfDay(periodo.toYmd);

  let receita = 0;
  let pedidos = 0;
  let unidades = 0;

  for (const o of orders) {
    if (!o || o.status !== 'paid') continue;              // cancelados e pendentes fora
    if (!dentroDoPeriodo(o.date_created, inicio, fim)) continue;
    pedidos += 1;
    receita += o.paid_amount || 0;                        // paridade com o card
    for (const oi of o.order_items ?? []) {               // TODOS os itens
      unidades += oi?.quantity ?? 1;                      // 0 é válido e permanece 0
    }
  }

  return {
    receita,
    pedidos,
    ticketMedio: pedidos > 0 ? receita / pedidos : null,
    unidades,
  };
}

/**
 * Consulta completa: avalia cobertura, recorta o período e calcula as métricas
 * apenas da parte disponível. Período fora da janela devolve
 * `disponivel: false` com `metricas: null` — nunca zeros que possam ser lidos
 * como "não vendemos nada".
 */
export function calcularConsulta(
  orders: OrderSlim[],
  periodo: PeriodoYmd,
  cobertura: CoberturaSnapshot
): ResultadoConsulta {
  if (!periodoValido(periodo)) {
    return {
      disponivel: false,
      periodoSolicitado: periodo,
      periodoCalculado: null,
      cobertura: 'indisponivel',
      metricas: null,
      warnings: ['periodo_invalido'],
    };
  }

  const cob = avaliarCobertura(periodo, cobertura);

  if (cob.tipo === 'indisponivel' || !cob.periodoEfetivo) {
    return {
      disponivel: false,
      periodoSolicitado: periodo,
      periodoCalculado: null,
      cobertura: 'indisponivel',
      metricas: null,
      warnings: cob.warnings,
    };
  }

  const metricas = calcularMetricas(orders, cob.periodoEfetivo);
  const warnings = [...cob.warnings];
  // Período coberto, mas sem nenhum pedido pago: é um fato (zero real), e não
  // uma lacuna de dados — sinalizado para a redação distinguir os dois casos.
  if (metricas.pedidos === 0) warnings.push(WARN_SEM_DADOS_NO_PERIODO);

  return {
    disponivel: true,
    periodoSolicitado: periodo,
    periodoCalculado: cob.periodoEfetivo,
    cobertura: cob.tipo,
    metricas,
    warnings,
  };
}

/**
 * Fração MÍNIMA do período solicitado que precisa estar coberta por dados para
 * que uma comparação seja legítima.
 *
 * Motivo concreto: o snapshot começa em 13/08/2025. "Este ano vs ano passado"
 * comparava 8 meses de 2026 contra DOIS DIAS de 2025 e produzia uma variação de
 * +160.030,95% — aritmeticamente correta e informativamente falsa. O aviso de
 * cobertura parcial existia, mas vinha no rodapé de um número gigante.
 *
 * Abaixo deste limite a variação NÃO é calculada: os dois valores absolutos são
 * informados e o motivo é declarado. Um número enganoso é pior que a ausência
 * dele.
 */
export const COBERTURA_MINIMA_COMPARACAO = 0.7;

export const WARN_COMPARACAO_DESIGUAL = 'comparacao_cobertura_desigual';

/** Fração do período solicitado efetivamente coberta (0..1). */
export function fracaoCoberta(r: ResultadoConsulta): number {
  if (!r.disponivel || !r.periodoCalculado) return 0;
  const pedidos = diasNoPeriodo(r.periodoSolicitado);
  const cobertos = diasNoPeriodo(r.periodoCalculado);
  return pedidos > 0 ? cobertos / pedidos : 0;
}

function diasNoPeriodo(p: PeriodoYmd): number {
  const ini = brtStartOfDay(p.fromYmd)?.getTime();
  const fim = brtStartOfDay(p.toYmd)?.getTime();
  if (ini === undefined || fim === undefined || !Number.isFinite(ini) || !Number.isFinite(fim)) return 0;
  return Math.round((fim - ini) / 86400000) + 1;
}

/** Resultado de comparação entre dois períodos (ex.: esta semana × anterior). */
export interface ResultadoComparacao {
  atual: ResultadoConsulta;
  anterior: ResultadoConsulta;
  /**
   * Variações absolutas e percentuais. null quando algum lado está
   * indisponível OU quando a cobertura de um dos lados é baixa demais para
   * que a comparação signifique alguma coisa — ver COBERTURA_MINIMA_COMPARACAO.
   */
  variacao: {
    receitaAbs: number;
    receitaPct: number | null;   // null quando a base é 0 (divisão indefinida)
    pedidosAbs: number;
    pedidosPct: number | null;
    unidadesAbs: number;
    unidadesPct: number | null;
  } | null;
  /** Fração coberta de cada lado, para a redação poder explicar a recusa. */
  cobertura: { atual: number; anterior: number };
  /** true quando a variação foi suprimida por cobertura desigual. */
  comparavel: boolean;
  warnings: string[];
}

/** Variação percentual segura: base 0 → null (não inventa "100%" nem Infinity). */
function pct(atual: number, anterior: number): number | null {
  if (anterior === 0) return null;
  return ((atual - anterior) / anterior) * 100;
}

/**
 * Compara dois períodos com as mesmas regras de cobertura. Se qualquer um dos
 * lados estiver indisponível, `variacao` é null — comparar contra um período
 * sem dados produziria uma conclusão falsa.
 */
export function calcularComparacao(
  orders: OrderSlim[],
  periodoAtual: PeriodoYmd,
  periodoAnterior: PeriodoYmd,
  cobertura: CoberturaSnapshot
): ResultadoComparacao {
  const atual = calcularConsulta(orders, periodoAtual, cobertura);
  const anterior = calcularConsulta(orders, periodoAnterior, cobertura);
  const cob = { atual: fracaoCoberta(atual), anterior: fracaoCoberta(anterior) };

  if (!atual.disponivel || !anterior.disponivel || !atual.metricas || !anterior.metricas) {
    return { atual, anterior, variacao: null, cobertura: cob, comparavel: false, warnings: [] };
  }

  // Cobertura desigual: os dois lados existem, mas um deles mal foi coberto.
  // Calcular percentual aqui produziria um número grande e falso.
  if (cob.atual < COBERTURA_MINIMA_COMPARACAO || cob.anterior < COBERTURA_MINIMA_COMPARACAO) {
    return {
      atual, anterior, variacao: null, cobertura: cob,
      comparavel: false, warnings: [WARN_COMPARACAO_DESIGUAL],
    };
  }

  const a = atual.metricas;
  const b = anterior.metricas;
  return {
    atual,
    anterior,
    cobertura: cob,
    comparavel: true,
    warnings: [],
    variacao: {
      receitaAbs: a.receita - b.receita,
      receitaPct: pct(a.receita, b.receita),
      pedidosAbs: a.pedidos - b.pedidos,
      pedidosPct: pct(a.pedidos, b.pedidos),
      unidadesAbs: a.unidades - b.unidades,
      unidadesPct: pct(a.unidades, b.unidades),
    },
  };
}