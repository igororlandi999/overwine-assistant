/**
 * Datas no fuso do Brasil (America/Sao_Paulo) — porte da lógica do dashboard.
 *
 * Contexto (herdado dos comentários do index.html):
 * O ML retorna date_created como ISO com offset, ex: "2026-06-10T22:14:00.000-03:00".
 * Comparar essas datas como STRING quebra (formatos mistos) — sempre comparar
 * como Date/epoch. A Vercel executa em UTC, portanto NENHUMA função aqui pode
 * depender do fuso do processo: toda conversão de dia de negócio usa
 * explicitamente o timezone IANA America/Sao_Paulo.
 *
 * Decisões:
 * - Sem biblioteca externa: Intl.DateTimeFormat (full-icu é padrão no Node 20).
 * - O offset é resolvido dinamicamente por instante (hoje o Brasil é -03:00
 *   fixo, sem horário de verão desde 2019; se o DST voltar, o código continua
 *   correto sem alteração).
 * - Entradas inválidas retornam null (start/end/ymd) ou false (dentroDoPeriodo),
 *   espelhando o comportamento tolerante do dashboard, mas com validação de
 *   calendário mais estrita (ex.: "2026-02-30" é rejeitado).
 */

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TZ_SP = 'America/Sao_Paulo';
const MS_SEMANA = 7 * 86400000;

/** true se a string é um "YYYY-MM-DD" que existe no calendário. */
export function ymdValido(ymd: string | null | undefined): ymd is string {
  if (!ymd) return false;
  const m = YMD_RE.exec(ymd);
  if (!m) return false;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1) return false;
  // Dia máximo do mês (Date.UTC normaliza: dia 0 do mês seguinte = último dia).
  const maxDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  return dia <= maxDia;
}

/**
 * Offset (em minutos, a somar ao UTC) de America/Sao_Paulo no instante dado.
 * Ex.: -180 para -03:00. Usa 'longOffset' do Intl (Node >= 17).
 */
function offsetSaoPauloMin(instante: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ_SP,
    timeZoneName: 'longOffset',
  }).formatToParts(instante);
  const tz = parts.find(p => p.type === 'timeZoneName')?.value ?? 'GMT-03:00';
  // Formatos possíveis: "GMT-03:00", "GMT-3", "GMT" (UTC puro).
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tz);
  if (!m) return -180; // fallback documentado: BRT padrão
  const sinal = m[1] === '-' ? -1 : 1;
  return sinal * (Number(m[2]) * 60 + Number(m[3] ?? '0'));
}

/**
 * Constrói o instante UTC correspondente a (ymd + hora local) em São Paulo.
 * Resolve o offset em duas iterações para cobrir viradas de DST hipotéticas.
 */
function instanteEmSaoPaulo(ymd: string, hora: number, min: number, seg: number, ms: number): Date {
  const m = YMD_RE.exec(ymd)!;
  const baseUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hora, min, seg, ms);
  // 1º chute: offset vigente no próprio horário-alvo lido como UTC.
  let off = offsetSaoPauloMin(new Date(baseUtc));
  let instante = new Date(baseUtc - off * 60000);
  // 2ª iteração: se o instante calculado cair do outro lado de uma transição,
  // o offset muda; recalcula uma vez (converge para timezones reais).
  const off2 = offsetSaoPauloMin(instante);
  if (off2 !== off) instante = new Date(baseUtc - off2 * 60000);
  return instante;
}

/**
 * "YYYY-MM-DD" (valor de <input type=date> / filtros) → Date no INÍCIO do dia
 * em São Paulo (00:00:00.000 local). Retorna null para entrada ausente ou
 * inválida.
 */
export function brtStartOfDay(ymd: string | null | undefined): Date | null {
  if (!ymdValido(ymd)) return null;
  return instanteEmSaoPaulo(ymd, 0, 0, 0, 0);
}

/**
 * "YYYY-MM-DD" → Date no FIM do dia em São Paulo (23:59:59.999 local).
 * Retorna null para entrada ausente ou inválida.
 */
export function brtEndOfDay(ymd: string | null | undefined): Date | null {
  if (!ymdValido(ymd)) return null;
  return instanteEmSaoPaulo(ymd, 23, 59, 59, 999);
}

/**
 * Date (ou ISO/epoch) → "YYYY-MM-DD" do dia CIVIL em São Paulo,
 * independente do fuso do processo. Retorna null para entrada inválida.
 * (en-CA gera exatamente o formato YYYY-MM-DD — mesmo truque do dashboard.)
 */
export function ymdBRT(date: Date | string | number | null | undefined): string | null {
  if (date === null || date === undefined || date === '') return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: TZ_SP });
}

/**
 * true se o instante ISO (ex.: date_created do ML) cai dentro de [inicio, fim],
 * bordas INCLUSIVAS. Limites nulos significam "sem limite" daquele lado.
 * ISO ausente/ inválido → false (pedido sem data nunca entra em período).
 */
export function dentroDoPeriodo(
  isoStr: string | null | undefined,
  inicio: Date | null,
  fim: Date | null
): boolean {
  if (!isoStr) return false;
  const t = new Date(isoStr).getTime();
  if (Number.isNaN(t)) return false;
  if (inicio && t < inicio.getTime()) return false;
  if (fim && t > fim.getTime()) return false;
  return true;
}

/**
 * "Hoje" em São Paulo como "YYYY-MM-DD".
 * O relógio é injetável (agora) para testes determinísticos; em produção
 * chame sem argumento.
 */
export function hojeBRT(agora: Date = new Date()): string {
  // agora é sempre um Date válido por assinatura; ymdBRT só retornaria null
  // para Date inválido construído à força — nesse caso propagamos erro claro.
  const ymd = ymdBRT(agora);
  if (!ymd) throw new Error('hojeBRT: relógio injetado é um Date inválido.');
  return ymd;
}

/**
 * Número de semanas (fracionário, >= 0) entre dois instantes.
 * Utilitário genérico de datas (porte de grSemanasEntre): diferença absoluta
 * de epoch — não depende de timezone. Entradas nulas/inválidas → 0.
 */
export function semanasEntre(ini: Date | null | undefined, fim: Date | null | undefined): number {
  if (!ini || !fim) return 0;
  const a = ini.getTime();
  const b = fim.getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, (b - a) / MS_SEMANA);
}