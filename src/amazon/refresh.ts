/**
 * Atualização da Amazon pedida por uma ABA ABERTA do dashboard.
 *
 * Por que existe: o agendador do GitHub Actions deste projeto não é confiável
 * para "de hora em hora" — nas execuções agendadas de 12/08 a 01/10/2026 a
 * mediana do intervalo em setembro foi de 4,4 h e houve lacunas de até 8,6 h
 * (a própria GitHub documenta atraso e descarte em horário de pico). Ele fica
 * como RECONCILIAÇÃO; com a aba aberta, quem puxa é o dashboard.
 *
 * O que faz: um passo CURTO (orçamento menor que o da função) só de pedidos e
 * financeiro — as duas coisas que mudam ao longo do dia —, e anúncios/estoque
 * apenas quando o catálogo publicado passou da idade máxima. Respeita as cotas
 * pelo mesmo balde da sincronização (cliente.ts): se a cota de pedidos está
 * esgotada, NÃO chama a Amazon e devolve quando poderá chamar de novo.
 *
 * Um intervalo mínimo por conta impede várias abas de gastarem a cota umas das
 * outras. Nunca lança: erro vira resposta com o motivo, e a leitura publicada
 * continua sendo servida.
 */
import type { Cache } from '../lib/cache/cache.js';
import type { Conta } from '../config/contas.js';
import { readManifest } from '../lib/orders-store.js';
import { readCatalogManifest } from '../lib/items-store.js';
import { executarPassoAmazon, type EtapaAmazon, type ResultadoPassoAmazon, type OpcoesPassoAmazon } from './sync.service.js';
import { OPERACOES, type OperacaoAmazon } from './contrato.js';
import { lerCatalogoVerificadoEm, referenciaDeFrescor } from './leitura.js';

const K = { intervalo: 'amz:refresh:intervalo' };
export const INTERVALO_MINIMO_S = 60;
export const IDADE_MAX_CATALOGO_MS = 6 * 3600 * 1000;

export type ResultadoRefreshAmazon =
  | { acao: 'intervalo_minimo'; versao: number | null; proximaTentativaEm: string }
  | { acao: 'sincronizado'; publicou: boolean; versao: number | null; etapas: ResultadoPassoAmazon['etapas']; proximaConsultaPedidosEm: string | null }
  | { acao: 'sync_em_andamento'; versao: number | null }
  | { acao: 'erro'; motivo: string; versao: number | null };

/** Quando a operação terá ficha de novo, pelo estado do balde (sem chamar a Amazon). */
export async function proximaFichaEm(cache: Cache, op: OperacaoAmazon, agora: number): Promise<string | null> {
  const raw = await cache.get(`amz:rl:${op}`);
  if (!raw) return null; // balde cheio
  const b = JSON.parse(raw) as { fichas: number; em: number; rate: number; burst: number };
  const fichas = Math.min(b.burst, b.fichas + (Math.max(0, agora - b.em) / 1000) * b.rate);
  if (fichas >= 1) return null;
  return new Date(agora + Math.ceil(((1 - fichas) / b.rate) * 1000)).toISOString();
}

export async function refrescarAmazon(cache: Cache, conta: Conta, o: Pick<OpcoesPassoAmazon, 'cliente' | 'agora'> = {}): Promise<ResultadoRefreshAmazon> {
  const agora = o.agora ?? Date.now;
  const versao = async () => (await readManifest(cache, 'ativos'))?.versao ?? null;
  try {
    if (!(await cache.setNX(K.intervalo, '1', INTERVALO_MINIMO_S))) {
      return { acao: 'intervalo_minimo', versao: await versao(), proximaTentativaEm: new Date(agora() + INTERVALO_MINIMO_S * 1000).toISOString() };
    }
    const etapas: EtapaAmazon[] = ['pedidos', 'financeiro'];
    const cat = await readCatalogManifest(cache).catch(() => null);
    const refCat = cat ? referenciaDeFrescor(cat.updatedAt, await lerCatalogoVerificadoEm(cache)) : null;
    if (!refCat || agora() - Date.parse(refCat) > IDADE_MAX_CATALOGO_MS) etapas.push('anuncios', 'estoque_fba');
    const antes = await versao();
    const r = await executarPassoAmazon(cache, conta, { ...o, etapas, orcamentoMs: 10_000, origem: 'dashboard_refresh' });
    if (r.motivo === 'sync_em_andamento') return { acao: 'sync_em_andamento', versao: antes };
    if (!r.ok) return { acao: 'erro', motivo: r.motivo ?? 'falha', versao: antes };
    const depois = await versao();
    return {
      acao: 'sincronizado', publicou: depois !== antes, versao: depois, etapas: r.etapas,
      proximaConsultaPedidosEm: await proximaFichaEm(cache, 'searchOrders', agora()),
    };
  } catch (e) {
    return { acao: 'erro', motivo: e instanceof Error ? e.message.slice(0, 120) : 'erro', versao: await versao().catch(() => null) };
  }
}

/** Padrão do contrato, para a tela explicar o ritmo sem prometer intervalo fixo. */
export const RITMO_PADRAO_PEDIDOS = OPERACOES.searchOrders.limite;

/**
 * Estado de atualização da conta Amazon, para a tela mostrar de onde vêm os
 * dados e quando podem mudar. Barato: só cache, nenhuma chamada à Amazon.
 */
export async function estadoAtualizacaoAmazon(cache: Cache, agora = Date.now()) {
  const ultimo = await cache.get('amz:sync:ultimo');
  const cobPedidos = await cache.get('amz:pedidos:cursor');
  const cobFin = await cache.get('amz:financeiro:cursor');
  const u = ultimo ? JSON.parse(ultimo) as { em: string; ok: boolean; motivo: string | null; etapas: Record<string, { status: string }> } : null;
  return {
    ultimoPasso: u ? { em: u.em, ok: u.ok, motivo: u.motivo, etapas: Object.fromEntries(Object.entries(u.etapas ?? {}).map(([k, v]) => [k, v.status])) } : null,
    pedidosLidosAte: cobPedidos ? (JSON.parse(cobPedidos) as { ate: string }).ate : null,
    financeiroLidoAte: cobFin ? (JSON.parse(cobFin) as { ate: string }).ate : null,
    proximaConsultaPedidosEm: await proximaFichaEm(cache, 'searchOrders', agora),
    ritmoPadraoPedidos: RITMO_PADRAO_PEDIDOS,
    /** Sem aba aberta, só a reconciliação agendada (sem garantia de horário). */
    semAbaAberta: 'reconciliacao_agendada_sem_horario_garantido' as const,
  };
}
