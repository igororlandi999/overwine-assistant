/**
 * chat-query.service — parser DETERMINÍSTICO de perguntas de vendas em pt-BR.
 *
 * Serviço PURO: não consulta pedidos, não calcula métricas, não chama IA, não
 * faz rede, não persiste, não mantém estado interno. Recebe texto e devolve uma
 * representação tipada da consulta; quem calcula é sales-metrics.service.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DECISÕES EXPLÍCITAS
 *
 * 1. SEMANA: sempre segunda a domingo.
 *
 * 1b. PERÍODOS CORRENTES SÃO ACUMULADOS ATÉ HOJE — nunca incluem dias
 *    futuros. `current_week` = segunda → hoje; `current_month` = dia 1 → hoje.
 *    Em COMPARAÇÕES, o período anterior é alinhado pelo mesmo número de dias
 *    decorridos (numa quarta, esta semana = seg–qua e a anterior = seg–qua),
 *    limitado ao último dia real do mês anterior (31/03 compara contra
 *    1–28 ou 1–29 de fevereiro). Consultados ISOLADAMENTE, `previous_week` e
 *    `previous_month` permanecem COMPLETOS.
 *
 * 1c. MÊS NOMEADO ("em julho", "julho de 2025") é o kind `month`. Antes desta
 *    regra a frase caía no ano solto: "quanto faturamos em março de 2026"
 *    devolvia 01/01 a hoje (o ANO INTEIRO), porque o nome do mês era ignorado
 *    e "de 2026" era capturado por `anoCitado`. Responder o ano quando se
 *    pergunta o mês é resposta errada sem aviso — pior que recusar.
 *    O mês corrente é ACUMULADO até hoje (decisão 1b): em 14/08, "agosto" é
 *    01/08 → 14/08, nunca 01/08 → 31/08. Somente nomes por EXTENSO disparam a
 *    regra; abreviações (jan, mar, set, out) continuam exigindo um dia junto,
 *    porque isoladas produziriam falso positivo em texto livre.
 *
 * 2. FUSO: todo período é resolvido em dias civis de America/Sao_Paulo,
 *    ancorado em `hojeBRT(agora)` de datas-brt. O relógio é INJETÁVEL
 *    (opts.agora) para testes determinísticos.
 *
 * 3. ANO AUSENTE ("25 de julho", "25/07"): escolhemos o ano que produz a data
 *    PASSADA MAIS RECENTE (<= hoje). Se 25/07 do ano corrente ainda não
 *    chegou, entende-se 25/07 do ano anterior. Nunca resolvemos para o futuro,
 *    porque a intenção natural em um dashboard de vendas é consultar o
 *    passado.
 *
 * 4. MÉTRICA PADRÃO: `revenue` só é assumida quando há intenção de vendas
 *    CLARA no texto (verbo/substantivo de venda ou comparação de vendas).
 *    Uma frase sem intenção de vendas NUNCA vira consulta de faturamento por
 *    padrão — devolve out_of_scope.
 *
 * 5. PROMPT INJECTION: conter uma palavra de período ("ontem") não torna a
 *    frase uma consulta válida. Exigimos intenção/métrica de negócio
 *    permitida, e termos sensíveis (tokens, clientes, compradores, endereços,
 *    "ignore as instruções") produzem out_of_scope mesmo com período presente.
 *
 * 6. CONTINUIDADE: `previousQuery` é ENTRADA OPCIONAL da função pura — nunca
 *    estado do módulo. Nada é guardado nem persistido aqui.
 */
import { hojeBRT, ymdValido } from '../lib/datas-brt.js';
import type { PeriodoYmd } from './sales-metrics.service.js';

// ── Tipos públicos ──────────────────────────────────────────────────────────

/** FONTE ÚNICA das intenções. Ver a nota de CHAT_PERIOD_KINDS abaixo. */
export const CHAT_INTENTS = ['sales_summary', 'sales_comparison', 'sales_ranking'] as const;
export type ChatIntent = typeof CHAT_INTENTS[number];

/**
 * Critérios de ranking. Subconjunto DELIBERADO de CHAT_METRICS: só faz sentido
 * ordenar produtos por receita, quantidade ou margem. Ticket médio e nº de
 * pedidos por produto seriam outra pergunta, com outra conta.
 */
export const CHAT_RANK_BY = ['revenue', 'units', 'margin'] as const;
export type ChatRankBy = typeof CHAT_RANK_BY[number];

/** FONTE ÚNICA das métricas. Ver a nota de CHAT_PERIOD_KINDS abaixo. */
export const CHAT_METRICS = ['revenue', 'orders', 'average_ticket', 'units', 'margin'] as const;
export type ChatMetric = typeof CHAT_METRICS[number];

/**
 * FONTE ÚNICA dos kinds de período. O tipo `ChatPeriodKind` e o conjunto usado
 * por `previousQueryValida` derivam desta lista — não existe segunda cópia a
 * manter em sincronia. Um kind novo declarado aqui já entra automaticamente na
 * validação de continuidade; declarado só no tipo, o typecheck acusa.
 */
export const CHAT_PERIOD_KINDS = [
  'today', 'yesterday', 'day_before_yesterday',
  'date', 'range', 'month',
  'current_week', 'previous_week',
  'current_month', 'previous_month',
  'current_year', 'previous_year', 'year',
  'last_n_days',
] as const;

export type ChatPeriodKind = typeof CHAT_PERIOD_KINDS[number];

export interface ChatPeriod extends PeriodoYmd {
  kind: ChatPeriodKind;
}

/** Origem de cada parte da consulta (texto atual ou continuidade). */
export interface ChatQuerySource {
  intent: 'text' | 'previous';
  metric: 'text' | 'previous' | 'default';
  period: 'text' | 'previous';
}

export interface ChatQuery {
  intent: ChatIntent;
  metric: ChatMetric;
  period: ChatPeriod;
  /** Presente somente em sales_comparison. */
  comparePeriod?: ChatPeriod;
  /**
   * Presentes somente em sales_ranking. `rankBy` sempre coincide com `metric`
   * — a duplicação é intencional: `metric` mantém o contrato antigo (e sobrevive
   * à continuidade, que o frontend projeta), e `rankBy` declara explicitamente
   * que este é o eixo de ORDENAÇÃO, não só o número pedido.
   */
  rankBy?: ChatRankBy;
  /** Top N pedido. Ausente = padrão do serviço de ranking. */
  limit?: number;
  source: ChatQuerySource;
}

export type ChatQueryResult =
  | { kind: 'recognized'; query: ChatQuery }
  | { kind: 'ambiguous'; reason: AmbiguousReason }
  | { kind: 'out_of_scope'; reason: OutOfScopeReason }
  | { kind: 'invalid_period'; reason: InvalidPeriodReason };

export type AmbiguousReason = 'periodo_ausente' | 'metrica_ausente' | 'consulta_vaga';
export type OutOfScopeReason = 'sem_intencao_de_vendas' | 'assunto_nao_suportado' | 'conteudo_sensivel';
export type InvalidPeriodReason =
  | 'data_inexistente' | 'intervalo_invertido' | 'intervalo_incompleto' | 'data_ininteligivel'
  | 'janela_excessiva';

export interface ParseOptions {
  /** Relógio injetável (testes determinísticos). Default: agora. */
  agora?: Date;
  /** Continuidade: consulta anterior, se houver. Entrada opcional e pura. */
  previousQuery?: ChatQuery | null;
}

// ── Normalização ────────────────────────────────────────────────────────────

/** minúsculas, sem acentos, espaços colapsados. */
function normalizar(texto: string): string {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Aritmética de calendário (pura, sem fuso: opera sobre YMD) ───────────────

function ymdParaUTC(ymd: string): Date {
  const [a, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d));
}
function utcParaYmd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function somaDias(ymd: string, n: number): string {
  const d = ymdParaUTC(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return utcParaYmd(d);
}
/** 0=domingo … 6=sábado */
function diaDaSemana(ymd: string): number {
  return ymdParaUTC(ymd).getUTCDay();
}
/** Diferença em dias entre dois YMD (b - a). */
function diasEntre(a: string, b: string): number {
  return Math.round((ymdParaUTC(b).getTime() - ymdParaUTC(a).getTime()) / 86400000);
}
/** Segunda-feira da semana que contém `ymd` (semana seg→dom). */
function segundaDaSemana(ymd: string): string {
  const dow = diaDaSemana(ymd);
  const recuo = dow === 0 ? 6 : dow - 1; // domingo pertence à semana que começou na segunda anterior
  return somaDias(ymd, -recuo);
}
function primeiroDiaDoMes(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}
function ultimoDiaDoMes(ymd: string): string {
  const [a, m] = ymd.split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate(); // dia 0 do mês seguinte
  return `${ymd.slice(0, 7)}-${String(ultimo).padStart(2, '0')}`;
}
function mesAnterior(ymd: string): string {
  const [a, m] = ymd.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 2, 1));
  return utcParaYmd(d);
}

// ── Léxico ──────────────────────────────────────────────────────────────────

const MESES: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};

/** Termos que indicam intenção de VENDAS (não são métrica por si sós). */
const RE_INTENCAO_VENDAS = /\b(vend[ei]|vendas|vendemos|vendeu|vendido|vendidas?|vender\w*|faturamento|faturamos|faturou|faturaram|faturei|receita|arrecad\w*|movimento)\b/;
/**
 * Intenção de MARGEM/LUCRO. Separada de RE_INTENCAO_VENDAS porque a pergunta
 * "qual a margem?" não menciona venda nenhuma, mas é uma consulta legítima ao
 * mesmo snapshot. Os termos saíram de RE_FORA_ESCOPO ao entrar aqui.
 */
const RE_INTENCAO_MARGEM = /\b(margem|margens|lucro|lucros|lucratividade|rentabilidade|rentavel|rentaveis)\b/;
const RE_COMPARACAO = /\b(compar\w*|versus|vs|em relacao a|frente a|contra)\b/;

/** Conteúdo sensível: recusa mesmo com período presente. */
const RE_SENSIVEL = /\b(token|tokens|senha|password|chave|api key|credencial|sessao|cliente|clientes|comprador|compradores|nickname|apelido|endereco|enderecos|cpf|cnpj|telefone|email|e-mail|instrucoes|instrucao|prompt|system|regras internas|revele|revelar)\b/;
const RE_INJECAO = /\b(ignore|ignorar|desconsidere|esqueca|finja|aja como|voce agora)\b/;

/**
 * Assuntos fora do escopo desta fase (existem no dashboard, não no parser).
 *
 * SAÍRAM daqui ao ganhar suporte: `ranking`, `mais vendido`, `top N`,
 * `produto`, `produtos`, `sku` — agora tratados por RE_RANKING_EXPLICITO e
 * RE_DIMENSAO_PRODUTO. `anuncio` PERMANECE: um anúncio não é um produto (três
 * anúncios do mesmo vinho compartilham um SKU), e responder ranking de produto
 * a uma pergunta sobre anúncio seria trocar a dimensão pedida.
 */
const RE_FORA_ESCOPO = /\b(custo|tacos|anuncio|anuncios|ads|publicidade|estoque|ruptura|cobertura|reputacao|qualidade|cancelad\w*|motivo)\b/;

/**
 * Ranking por PALAVRA EXPLÍCITA. Basta um destes termos: a pergunta já é
 * inequivocamente de classificação, com ou sem menção a produto.
 * "o que mais vendeu ontem?" cai aqui — antes deste bloco ela era reconhecida
 * como sales_summary e recebia o faturamento TOTAL do dia, respondendo outra
 * pergunta sem nenhum aviso.
 */
const RE_RANKING_EXPLICITO = /\b(ranking|rankings|top\s*\d+|mais vendid\w+|menos vendid\w+|campe\w+ de vendas?|best sellers?|que mais (vendeu|venderam|faturou|faturaram|saiu|sairam)|o que mais (vendeu|vende|saiu|sai))\b/;

/**
 * Dimensão de PRODUTO. Sozinha não basta ("qual produto tem estoque?" não é
 * ranking); exige intenção de vendas ou margem junto, verificada no parser.
 */
const PROD = '(?:produto|produtos|sku|skus|item|itens|vinho|vinhos)';
const RE_DIMENSAO_PRODUTO = new RegExp(
  // "faturamento POR PRODUTO"
  `\\bpor ${PROD}\\b`
  // "QUAL FOI O PRODUTO...", "QUAIS os 5 VINHOS..." — até 4 palavras de folga
  // entre o interrogativo e o substantivo, que é o que separa "qual" de
  // "produto" em "qual foi o produto com maior margem".
  + `|\\b(?:quais|qual|que)\\b(?:\\s+\\w+){0,4}\\s+\\b${PROD}\\b`
  // "PRODUTOS QUE mais venderam", "PRODUTO COM maior margem"
  + `|\\b${PROD}\\s+(?:que|com)\\b`
);

/**
 * Top N. Só é lido quando a consulta JÁ foi classificada como ranking, o que
 * evita disputa com números de data. O sufixo exigido ("produtos", "maiores"…)
 * impede que "25 de julho" ou "10 unidades" virem limite.
 */
const RE_LIMITE = /\btop\s*(\d{1,2})\b|\b(\d{1,2})\s+(?:maiores|melhores|principais|primeiros|produtos|vinhos|itens|skus)\b/;

/**
 * FILTRO por um produto específico ("a margem DO PRODUTO x", "quanto vendi DO
 * SKU ABC"). NÃO é ranking e NÃO é suportado: o serviço classifica todos os
 * produtos, não isola um. Sem esta guarda a frase perderia a dimensão e seria
 * respondida com o número GERAL do período — a mesma classe de erro que o
 * bloco de dimensão não suportada existe para impedir.
 */
const RE_FILTRO_PRODUTO = /\b(d[oa]s? (produto|produtos|sku|skus|item|itens|vinho|vinhos)|(deste|desse|daquele) (produto|sku|item|vinho))\b/;

function detectarRankBy(t: string): ChatRankBy {
  // Margem primeiro: "ranking de margem por produto" carrega os dois léxicos.
  if (RE_INTENCAO_MARGEM.test(t)) return 'margin';
  // Receita explícita vence o coloquial: "que mais FATURARAM" é receita.
  if (/\b(faturamento|faturou|faturaram|faturamos|faturei|receita|valor vendido)\b/.test(t)) return 'revenue';
  // "que mais vendeu", "mais vendidos", "por quantidade" — leitura coloquial de
  // VOLUME, não de dinheiro.
  if (/\b(quantidade|quantidades|unidade|unidades|volume|pecas|mais vendid\w+|menos vendid\w+|vendeu mais|venderam mais|que mais (vendeu|venderam|saiu|sairam)|o que mais (vendeu|vende|saiu|sai))\b/.test(t)) return 'units';
  return 'revenue';
}

function detectarLimite(t: string): number | undefined {
  const m = RE_LIMITE.exec(t);
  if (!m) return undefined;
  const n = Number(m[1] ?? m[2]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ── Detecção de métrica ─────────────────────────────────────────────────────

function detectarMetrica(t: string): ChatMetric | null {
  // margem antes de tudo: "qual a margem do faturamento?" carrega os dois
  // vocabulários, e a pergunta é de margem.
  if (RE_INTENCAO_MARGEM.test(t)) return 'margin';
  // ticket médio antes de "pedidos" (a frase costuma conter ambos)
  if (/\bticket\b/.test(t)) return 'average_ticket';
  if (/\b(unidade|unidades|pecas|itens vendidos|quantas unidades)\b/.test(t)) return 'units';
  if (/\b(pedido|pedidos|vendas realizadas|quantidade de pedidos)\b/.test(t)) return 'orders';
  if (/\b(faturamento|faturamos|faturou|faturaram|faturei|receita|quanto vendemos|quanto vendeu|quanto foi|arrecad\w*)\b/.test(t)) return 'revenue';
  return null;
}

// ── Detecção de período ─────────────────────────────────────────────────────

type PeriodoDetectado =
  | { ok: true; period: ChatPeriod; compare?: ChatPeriod }
  | { ok: false; erro: InvalidPeriodReason }
  | null; // nenhum período no texto

function periodo(kind: ChatPeriodKind, fromYmd: string, toYmd: string): ChatPeriod {
  return { kind, fromYmd, toYmd };
}

/**
 * Resolve o ano de uma data sem ano: escolhe o ano que deixa a data no PASSADO
 * mais recente (<= hoje). Ver decisão 3 no cabeçalho.
 */
function resolverAnoAusente(dia: number, mes: number, hoje: string): number {
  const anoHoje = Number(hoje.slice(0, 4));
  const candidato = `${anoHoje}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  if (ymdValido(candidato) && candidato <= hoje) return anoHoje;
  return anoHoje - 1;
}

function montarYmd(dia: number, mes: number, ano: number): string {
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/** Extrai datas explícitas do texto, na ordem de aparição. */
interface DataBruta { dia: number; mes: number; ano: number | null; }

function extrairDatas(t: string, hoje: string): { datas: DataBruta[]; invalida: boolean } {
  const datas: DataBruta[] = [];
  let invalida = false;

  // "entre 20 e 25 de julho [de 2026]" / "de 20 a 25 de julho"
  const parExtenso = /\b(?:entre|de)\s+(\d{1,2})\s+(?:e|a|ate)\s+(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?/.exec(t);
  if (parExtenso) {
    const mes = MESES[parExtenso[3]];
    if (mes) {
      const ano = parExtenso[4] ? Number(parExtenso[4]) : null;
      datas.push({ dia: Number(parExtenso[1]), mes, ano });
      datas.push({ dia: Number(parExtenso[2]), mes, ano });
      return { datas, invalida };
    }
  }

  // Datas numéricas: 25/07/2026, 25-07-2026, 25/07
  const reNum = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/g;
  let m: RegExpExecArray | null;
  while ((m = reNum.exec(t)) !== null) {
    const dia = Number(m[1]);
    const mes = Number(m[2]);
    let ano: number | null = null;
    if (m[3]) {
      const raw = Number(m[3]);
      ano = raw < 100 ? 2000 + raw : raw;
    }
    if (mes < 1 || mes > 12 || dia < 1 || dia > 31) invalida = true;
    datas.push({ dia, mes, ano });
  }

  // Datas por extenso: "25 de julho de 2026" / "25 de julho"
  const reExt = /\b(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?/g;
  while ((m = reExt.exec(t)) !== null) {
    const mes = MESES[m[2]];
    if (!mes) continue; // "25 de manhã" não é data
    datas.push({ dia: Number(m[1]), mes, ano: m[3] ? Number(m[3]) : null });
  }

  return { datas, invalida };
}

/** Teto da janela móvel: acima disso a consulta é recusada (decisão 7). */
const MAX_JANELA_DIAS = 365;

/** Multiplicador de unidade para janelas móveis. Mês = 30 dias corridos. */
const UNIDADE_JANELA: Record<string, number> = {
  dia: 1, dias: 1,
  semana: 7, semanas: 7,
  mes: 30, meses: 30,
};

/**
 * Janela móvel "últimos N dias/semanas/meses", INCLUSIVA até hoje.
 * "últimos 7 dias" em 13/08 => 07/08 a 13/08 (7 dias civis).
 * Exige N numérico: "última semana" (sem número) continua sendo previous_week.
 */
const RE_JANELA_MOVEL =
  /\b(?:nos?\s+|nas?\s+)?ultim[oa]s?\s+(\d{1,5})\s+(dias?|semanas?|mes|meses)\b|\b(\d{1,5})\s+ultim[oa]s?\s+(dias?|semanas?|mes|meses)\b/;

function detectarJanelaMovel(t: string, hoje: string): PeriodoDetectado {
  const m = RE_JANELA_MOVEL.exec(t);
  if (!m) return null;

  const quantidade = Number(m[1] ?? m[3]);
  const unidade = (m[2] ?? m[4]) as string;
  const fator = UNIDADE_JANELA[unidade];
  if (!Number.isInteger(quantidade) || fator === undefined) return null;

  const dias = quantidade * fator;
  if (dias < 1 || dias > MAX_JANELA_DIAS) {
    return { ok: false, erro: 'janela_excessiva' };
  }

  // Inclusiva: N dias civis terminando HOJE.
  return { ok: true, period: periodo('last_n_days', somaDias(hoje, -(dias - 1)), hoje) };
}

/**
 * Mês por EXTENSO, com ano opcional: "julho", "em julho", "julho de 2025",
 * "julho/2025". Abreviações (jan, mar, set, out) NÃO entram: isoladas casariam
 * em texto livre ("no set", "marco zero") e criariam período onde não há.
 */
const RE_MES_NOMEADO =
  /\b(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b(?:\s*(?:de|do|em)\s+|\s*\/\s*|\s+)?(20\d{2})?/;

/**
 * Resolve um mês nomeado em período civil.
 *
 * Ano AUSENTE: escolhe o ano que deixa o mês no passado mais recente — mesma
 * regra das datas sem ano (decisão 3). Em 14/08/2026, "julho" é 2026 e
 * "dezembro" é 2025.
 *
 * O fim é limitado a HOJE: o mês corrente devolve 01 → hoje, jamais dias
 * futuros (decisão 1b). Um mês inteiramente no futuro (só possível com ano
 * explícito) é recusado com `data_inexistente`, reusando o motivo já existente
 * em vez de ampliar o contrato público de erros.
 */
function detectarMesNomeado(t: string, hoje: string): PeriodoDetectado {
  const m = RE_MES_NOMEADO.exec(t);
  if (!m) return null;

  const mes = MESES[m[1]];
  if (!mes) return null; // defensivo: a alternância acima só produz nomes válidos

  const anoHoje = Number(hoje.slice(0, 4));
  const mm = String(mes).padStart(2, '0');
  const anoExplicito = m[2] ? Number(m[2]) : null;
  // Sem ano no texto: o ano corrente só vale se o mês JÁ COMEÇOU.
  const ano = anoExplicito ?? (`${anoHoje}-${mm}-01` <= hoje ? anoHoje : anoHoje - 1);

  const from = `${ano}-${mm}-01`;
  if (from > hoje) return { ok: false, erro: 'data_inexistente' };

  const ultimo = ultimoDiaDoMes(from);
  return { ok: true, period: periodo('month', from, ultimo > hoje ? hoje : ultimo) };
}

function detectarPeriodo(t: string, hoje: string): PeriodoDetectado {
  // ── Janela móvel ("ultimos N dias") — antes dos relativos nomeados, para que
  //    "ultimos 7 dias" não seja capturado por outra regra. ──
  const janela = detectarJanelaMovel(t, hoje);
  if (janela !== null) return janela;

  // ── Períodos relativos nomeados ──
  if (/\banteontem\b/.test(t)) {
    const d = somaDias(hoje, -2);
    return { ok: true, period: periodo('day_before_yesterday', d, d) };
  }
  if (/\bontem\b/.test(t)) {
    const d = somaDias(hoje, -1);
    return { ok: true, period: periodo('yesterday', d, d) };
  }
  if (/\b(hoje|no dia de hoje)\b/.test(t)) {
    return { ok: true, period: periodo('today', hoje, hoje) };
  }

  // ── Mês nomeado ("em julho", "julho de 2025") ──
  // A extração de datas é hoisted porque o mês nomeado só pode valer quando o
  // texto NÃO traz uma data com dia: em "25 de julho" quem manda é a data
  // absoluta, e o mês seria uma leitura mais larga do que a pedida.
  // Vem ANTES dos relativos nomeados porque "no mês de julho" casa com o regex
  // de `mesAtual` (`\bno mes\b`) e devolveria o mês corrente.
  const { datas, invalida } = extrairDatas(t, hoje);
  if (datas.length === 0) {
    const mesNomeado = detectarMesNomeado(t, hoje);
    if (mesNomeado !== null) return mesNomeado;
  }

  const semanaPassada = /\b(semana passada|semana anterior|ultima semana|semana retrasada|da semana passada)\b/.test(t);
  const semanaAtual = /\b(esta semana|essa semana|desta semana|dessa semana|nesta semana|nessa semana|semana atual|na semana)\b/.test(t);
  const mesPassado = /\b(mes passado|mes anterior|ultimo mes|do mes passado)\b/.test(t);
  const mesAtual = /\b(este mes|esse mes|deste mes|desse mes|neste mes|nesse mes|mes atual|no mes)\b/.test(t);
  const anoPassado = /\b(ano passado|ano anterior|ultimo ano|do ano passado)\b/.test(t);
  const anoAtual = /\b(este ano|esse ano|deste ano|desse ano|neste ano|nesse ano|ano atual|no ano)\b/.test(t);
  // Ano explícito: "em 2025", "de 2025". Restrito a 20xx para não capturar
  // números soltos (quantidades, valores, SKUs).
  const anoCitado = /\b(?:em|de|do|no|ano de|durante)\s+(20\d{2})\b/.exec(t);

  // ── Períodos CORRENTES são acumulados até HOJE (nunca incluem dias futuros).
  const segAtual = segundaDaSemana(hoje);
  const semanaAtualP = periodo('current_week', segAtual, hoje);          // seg → hoje
  const diasDecorridosSemana = diasEntre(segAtual, hoje) + 1;            // inclusivo

  const segAnterior = somaDias(segAtual, -7);
  // Isolada: semana anterior COMPLETA (seg → dom).
  const semanaAnteriorCompletaP = periodo('previous_week', segAnterior, somaDias(segAnterior, 6));
  // Em comparação: mesmo número de dias decorridos da semana atual.
  const semanaAnteriorAlinhadaP = periodo(
    'previous_week', segAnterior, somaDias(segAnterior, diasDecorridosSemana - 1)
  );

  const primeiroDiaMesAtual = primeiroDiaDoMes(hoje);
  const mesAtualP = periodo('current_month', primeiroDiaMesAtual, hoje); // dia 1 → hoje
  const diaDoMesHoje = Number(hoje.slice(8, 10));

  const refAnterior = mesAnterior(hoje);
  const primeiroDiaMesAnterior = primeiroDiaDoMes(refAnterior);
  const ultimoDiaMesAnterior = ultimoDiaDoMes(refAnterior);
  // Isolado: mês anterior COMPLETO.
  const mesAnteriorCompletoP = periodo('previous_month', primeiroDiaMesAnterior, ultimoDiaMesAnterior);
  // Em comparação: mesmo número de dias, limitado ao último dia real do mês
  // anterior (ex.: 31 de março compara contra 1–28/29 de fevereiro).
  const diaLimiteAnterior = Math.min(diaDoMesHoje, Number(ultimoDiaMesAnterior.slice(8, 10)));
  const mesAnteriorAlinhadoP = periodo(
    'previous_month',
    primeiroDiaMesAnterior,
    `${primeiroDiaMesAnterior.slice(0, 7)}-${String(diaLimiteAnterior).padStart(2, '0')}`
  );

  const anoHoje = Number(hoje.slice(0, 4));
  // Ano corrente ACUMULADO: 1º de janeiro → hoje, nunca até 31/12 futuro.
  const anoAtualP = periodo('current_year', `${anoHoje}-01-01`, hoje);
  // Ano anterior COMPLETO.
  const anoAnteriorCompletoP = periodo('previous_year', `${anoHoje - 1}-01-01`, `${anoHoje - 1}-12-31`);
  // Em comparação: mesmo dia/mês decorrido do ano atual (alinhamento justo).
  const anoAnteriorAlinhadoP = periodo('previous_year', `${anoHoje - 1}-01-01`, `${anoHoje - 1}${hoje.slice(4)}`);

  // Comparação: períodos alinhados pelo número de dias decorridos.
  if (RE_COMPARACAO.test(t) && (semanaAtual || semanaPassada)) {
    return { ok: true, period: semanaAtualP, compare: semanaAnteriorAlinhadaP };
  }
  if (RE_COMPARACAO.test(t) && (mesAtual || mesPassado)) {
    return { ok: true, period: mesAtualP, compare: mesAnteriorAlinhadoP };
  }
  if (RE_COMPARACAO.test(t) && (anoAtual || anoPassado)) {
    return { ok: true, period: anoAtualP, compare: anoAnteriorAlinhadoP };
  }

  // Consulta isolada: períodos anteriores permanecem COMPLETOS.
  if (semanaPassada) return { ok: true, period: semanaAnteriorCompletaP };
  if (semanaAtual) return { ok: true, period: semanaAtualP };
  if (mesPassado) return { ok: true, period: mesAnteriorCompletoP };
  if (mesAtual) return { ok: true, period: mesAtualP };
  if (anoPassado) return { ok: true, period: anoAnteriorCompletoP };
  if (anoAtual) return { ok: true, period: anoAtualP };

  // ── Datas absolutas (extraídas no topo, junto com a guarda do mês nomeado) ──
  const querIntervalo = /\b(entre|de \d|a partir de|ate|periodo)\b/.test(t) || datas.length >= 2;

  if (datas.length === 0) {
    // Ano solto ("em 2025", "durante 2024"). SÓ aqui: antes da extração de
    // datas, "25 de julho de 2026" seria capturado pelo trecho "de 2026" e o
    // dia se perderia.
    if (anoCitado) {
      const a = Number(anoCitado[1]);
      // O ano corrente é o ACUMULADO até hoje, não até 31/12 futuro.
      if (a === anoHoje) return { ok: true, period: anoAtualP };
      // Ano futuro não é período consultável. Reusa o motivo existente em vez
      // de ampliar o contrato público de erros.
      if (a > anoHoje) return { ok: false, erro: 'data_inexistente' };
      return { ok: true, period: periodo('year', `${a}-01-01`, `${a}-12-31`) };
    }
    if (invalida) return { ok: false, erro: 'data_ininteligivel' };
    return null; // nenhum período no texto
  }

  if (datas.length === 1) {
    // "entre 20 e ..." com só uma borda reconhecida => intervalo incompleto
    if (/\bentre\b/.test(t)) return { ok: false, erro: 'intervalo_incompleto' };
    const d = datas[0];
    const ano = d.ano ?? resolverAnoAusente(d.dia, d.mes, hoje);
    const ymd = montarYmd(d.dia, d.mes, ano);
    if (!ymdValido(ymd)) return { ok: false, erro: 'data_inexistente' };
    return { ok: true, period: periodo('date', ymd, ymd) };
  }

  // Duas ou mais datas => intervalo com as duas primeiras.
  const [a, b] = datas;
  // Ano do INTERVALO (não de cada borda isolada): se alguma borda traz ano,
  // ele manda. Senão, ancoramos no INÍCIO — um intervalo que já começou no ano
  // corrente pertence ao ano corrente ainda que o fim seja alguns dias à
  // frente ("entre 20 e 25 de julho" consultado no dia 23). Resolver cada
  // borda isoladamente jogaria o fim para o ano anterior e inverteria o range.
  const anoExplicito = a.ano ?? b.ano ?? null;
  const anoIntervalo = anoExplicito ?? resolverAnoAusente(a.dia, a.mes, hoje);
  const anoA = a.ano ?? anoIntervalo;
  const anoB = b.ano ?? anoIntervalo;
  const ymdA = montarYmd(a.dia, a.mes, anoA);
  const ymdB = montarYmd(b.dia, b.mes, anoB);
  if (!ymdValido(ymdA) || !ymdValido(ymdB)) return { ok: false, erro: 'data_inexistente' };
  if (ymdA > ymdB) return { ok: false, erro: 'intervalo_invertido' };
  if (!querIntervalo) return { ok: true, period: periodo('date', ymdA, ymdA) };
  return { ok: true, period: periodo('range', ymdA, ymdB) };
}

// ── Validação de previousQuery ──────────────────────────────────────────────

const INTENTS: ReadonlySet<string> = new Set<string>(CHAT_INTENTS);
const METRICS: ReadonlySet<string> = new Set<string>(CHAT_METRICS);
const KINDS: ReadonlySet<string> = new Set<string>(CHAT_PERIOD_KINDS);

const RANK_BY: ReadonlySet<string> = new Set<string>(CHAT_RANK_BY);

/**
 * Converte a métrica herdada em critério de ranking. `average_ticket` e
 * `orders` não são eixos de ranking (ver CHAT_RANK_BY); caem em receita, que é
 * o padrão e nunca produz número errado — só uma ordenação diferente da que o
 * usuário talvez esperasse.
 */
function rankByDeMetric(m: ChatMetric): ChatRankBy {
  return RANK_BY.has(m) ? (m as ChatRankBy) : 'revenue';
}

/** previousQuery só é aceita se for estruturalmente íntegra. */
export function previousQueryValida(q: unknown): q is ChatQuery {
  if (!q || typeof q !== 'object') return false;
  const c = q as Partial<ChatQuery>;
  if (!c.intent || !INTENTS.has(c.intent)) return false;
  if (!c.metric || !METRICS.has(c.metric)) return false;
  const p = c.period;
  if (!p || typeof p !== 'object') return false;
  if (!p.kind || !KINDS.has(p.kind)) return false;
  if (!ymdValido(p.fromYmd) || !ymdValido(p.toYmd)) return false;
  if (p.fromYmd > p.toYmd) return false;
  return true;
}

// ── Parser principal ────────────────────────────────────────────────────────

/**
 * Interpreta a pergunta. Função PURA: mesma entrada, mesma saída; não muta
 * `opts` nem `previousQuery`.
 */
export function parseChatQuery(texto: string, opts: ParseOptions = {}): ChatQueryResult {
  const t = normalizar(texto);
  const hoje = hojeBRT(opts.agora ?? new Date());
  const prev = previousQueryValida(opts.previousQuery) ? (opts.previousQuery as ChatQuery) : null;

  if (!t) return { kind: 'ambiguous', reason: 'consulta_vaga' };

  // 1) Conteúdo sensível / injeção: recusa antes de qualquer interpretação.
  if (RE_SENSIVEL.test(t) || RE_INJECAO.test(t)) {
    return { kind: 'out_of_scope', reason: 'conteudo_sensivel' };
  }

  const metricaTexto = detectarMetrica(t);
  const ehComparacao = RE_COMPARACAO.test(t);
  // Comparar períodos num dashboard de vendas É intenção de vendas clara
  // ("compare esta semana com a anterior" — exemplo canônico da Fase 5g),
  // desde que haja de fato dois períodos a comparar (verificado adiante).
  const comparacaoDePeriodos = ehComparacao && /\b(semana|mes|periodo)\b/.test(t);
  const temIntencaoVendas = RE_INTENCAO_VENDAS.test(t) || RE_INTENCAO_MARGEM.test(t)
    || metricaTexto !== null || comparacaoDePeriodos;

  // 1b) Ranking. Palavra explícita basta; a dimensão de produto sozinha exige
  //     intenção de vendas junto ("qual produto tem estoque?" não é ranking, e
  //     de todo modo cai em RE_FORA_ESCOPO logo abaixo).
  const ehRanking = RE_RANKING_EXPLICITO.test(t)
    || (RE_DIMENSAO_PRODUTO.test(t) && temIntencaoVendas);

  // Filtro por UM produto ("a margem do produto x") não é ranking e não é
  // suportado. Recusa antes de qualquer outra interpretação, para a frase não
  // perder a dimensão e virar o número geral do período.
  if (RE_FILTRO_PRODUTO.test(t) && !RE_RANKING_EXPLICITO.test(t)) {
    return { kind: 'out_of_scope', reason: 'assunto_nao_suportado' };
  }

  // Comparar RANKINGS entre períodos é outra pergunta ("o top 5 mudou?"), com
  // outro contrato de dados. Recusa explícita em vez de responder o ranking de
  // um só período e dar a impressão de ter comparado.
  if (ehRanking && ehComparacao) {
    return { kind: 'out_of_scope', reason: 'assunto_nao_suportado' };
  }

  // 2) Assunto conhecido do dashboard, porém fora do escopo desta fase.
  //    Recusa SEMPRE, mesmo havendo uma métrica suportada na frase: uma
  //    dimensão não suportada ("faturamento POR PRODUTO", "pedidos
  //    CANCELADOS") não pode ser silenciosamente reduzida ao resumo geral —
  //    isso responderia outra pergunta e daria um número enganoso.
  if (RE_FORA_ESCOPO.test(t)) {
    return { kind: 'out_of_scope', reason: 'assunto_nao_suportado' };
  }

  // 3) Período do texto.
  const per = detectarPeriodo(t, hoje);
  if (per && per.ok === false) return { kind: 'invalid_period', reason: per.erro };

  const temPeriodo = per !== null && per.ok === true;

  // 4) Sem intenção de vendas no texto: só prossegue via continuidade válida.
  //    NUNCA assume revenue para frases sem intenção de vendas (decisão 4).
  if (!temIntencaoVendas && !ehRanking) {
    if (temPeriodo && prev) {
      // Continuidade tipo "e ontem?": herda intenção e métrica, troca o período.
      // Um ranking anterior continua ranking; rankBy vem de prev.metric, que é
      // o campo que o frontend projeta de volta (limit não sobrevive e volta ao
      // padrão do serviço — degradação aceitável, jamais número errado).
      const rankingHerdado = prev.intent === 'sales_ranking';
      return {
        kind: 'recognized',
        query: {
          intent: prev.intent === 'sales_comparison' ? 'sales_summary' : prev.intent,
          metric: prev.metric,
          period: (per as { ok: true; period: ChatPeriod }).period,
          ...(rankingHerdado ? { rankBy: rankByDeMetric(prev.metric) } : {}),
          source: { intent: 'previous', metric: 'previous', period: 'text' },
        },
      };
    }
    if (temPeriodo && !prev) return { kind: 'ambiguous', reason: 'metrica_ausente' };
    return { kind: 'out_of_scope', reason: 'sem_intencao_de_vendas' };
  }

  // 5) Há intenção de vendas. Métrica: do texto, ou herdada, ou padrão revenue.
  //    Em ranking, a métrica É o critério de ordenação: perguntar "top 5 por
  //    quantidade" e receber faturamento seria responder outra coisa.
  const rankBy: ChatRankBy | null = ehRanking ? detectarRankBy(t) : null;
  const limite = ehRanking ? detectarLimite(t) : undefined;

  let metric: ChatMetric;
  let metricFrom: ChatQuerySource['metric'];
  if (rankBy) {
    metric = rankBy;
    metricFrom = 'text';
  } else if (metricaTexto) {
    metric = metricaTexto;
    metricFrom = 'text';
  } else if (prev) {
    metric = prev.metric;
    metricFrom = 'previous';
  } else {
    metric = 'revenue'; // permitido: intenção de vendas é clara
    metricFrom = 'default';
  }

  const extraRanking = rankBy
    ? { rankBy, ...(limite !== undefined ? { limit: limite } : {}) }
    : {};

  // 6) Período: do texto ou herdado ("e os pedidos?" mantém o período anterior).
  if (!temPeriodo) {
    if (prev) {
      return {
        kind: 'recognized',
        query: {
          intent: rankBy ? 'sales_ranking' : 'sales_summary',
          metric,
          period: { ...prev.period },
          ...extraRanking,
          source: { intent: rankBy ? 'text' : 'previous', metric: metricFrom, period: 'previous' },
        },
      };
    }
    return { kind: 'ambiguous', reason: 'periodo_ausente' };
  }

  const p = per as { ok: true; period: ChatPeriod; compare?: ChatPeriod };

  // 7) Comparação exige dois períodos resolvidos. (Ranking + comparação já foi
  //    recusado no passo 1b.)
  if (ehComparacao) {
    if (!p.compare) return { kind: 'ambiguous', reason: 'periodo_ausente' };
    return {
      kind: 'recognized',
      query: {
        intent: 'sales_comparison',
        metric,
        period: p.period,
        comparePeriod: p.compare,
        source: { intent: 'text', metric: metricFrom, period: 'text' },
      },
    };
  }

  return {
    kind: 'recognized',
    query: {
      intent: rankBy ? 'sales_ranking' : 'sales_summary',
      metric,
      period: p.period,
      ...extraRanking,
      source: { intent: 'text', metric: metricFrom, period: 'text' },
    },
  };
}