/**
 * Um PASSO de sincronização da Amazon para UMA conta: pedidos, anúncios,
 * estoque FBA e financeiro, cada um até onde o orçamento de tempo e o limite
 * da operação deixarem. Retomável: o próximo passo continua de onde parou.
 *
 * Quem chama: a rota de admin existente (/api/admin/orders-sync), pelo job
 * agendado do GitHub Actions (reconciliação, SEM horário garantido — ver
 * refresh.ts), e o refresh pedido por uma aba aberta (src/amazon/refresh.ts).
 * A Amazon não entrega notificação por HTTP (só SQS ou EventBridge), então
 * não há webhook como no Mercado Livre.
 *
 * Cada etapa usa operações com limites INDEPENDENTES: limite esgotado em
 * pedidos não impede anúncios. Falha de autorização (LWA) para tudo, porque
 * nenhuma chamada passaria.
 */
import { randomBytes } from 'node:crypto';
import type { Cache } from '../lib/cache/cache.js';
import type { Conta } from '../config/contas.js';
import { lerCredenciais, variaveisAusentes } from './credenciais.js';
import { criarClienteSpApi, ErroSpApi, type ClienteSpApi } from './cliente.js';
import { FalhaLwa } from './lwa.js';
import { sincronizarPedidos, estadoPedidos } from './pedidos.js';
import { sincronizarAnuncios, sincronizarEstoqueFba, lerEstadoEstoqueFba } from './catalogo.js';
import { sincronizarFinanceiro, lerCoberturaFinanceira } from './financeiro.js';
import { lerManifesto } from './store.js';
import { publicarLeitura } from './leitura.js';

export type EtapaAmazon = 'pedidos' | 'anuncios' | 'estoque_fba' | 'financeiro';
export const ETAPAS_AMAZON: readonly EtapaAmazon[] = ['pedidos', 'anuncios', 'estoque_fba', 'financeiro'];

export type ResultadoEtapa =
  | { status: 'concluida' | 'parcial'; detalhe: Record<string, unknown> }
  | { status: 'aguardando_limite'; esperaMs: number | null; operacao: string }
  | { status: 'sem_permissao' | 'erro'; operacao?: string; motivo: string }
  | { status: 'nao_executada'; motivo: 'orcamento_de_tempo' | 'autorizacao' };

export interface ResultadoPassoAmazon {
  ok: boolean;
  conta: string;
  motivo?: 'sync_em_andamento' | 'autorizacao_invalida' | 'credencial_app_invalida' | 'lwa_indisponivel' | 'credenciais_ausentes';
  /** Todas as etapas pedidas concluíram neste passo. */
  concluido: boolean;
  etapas: Partial<Record<EtapaAmazon, ResultadoEtapa>>;
  limites?: Record<string, { rate: number; burst: number; fonte: string }>;
  /** O que a leitura das telas ganhou neste passo (nova versão de pedidos / catálogo). */
  leitura?: { pedidos: boolean; catalogo: boolean };
}

const K = { lock: 'amz:sync:lock', ultimo: 'amz:sync:ultimo' };

export interface OpcoesPassoAmazon {
  etapas?: readonly EtapaAmazon[];
  agora?: () => number;
  orcamentoMs?: number;
  cliente?: ClienteSpApi;
  cargaInicialDias?: number;
  /** Quem pediu: reconciliação (admin/agendador) ou aba aberta do dashboard. */
  origem?: 'incremental' | 'dashboard_refresh';
}

export async function executarPassoAmazon(cache: Cache, conta: Conta, o: OpcoesPassoAmazon = {}): Promise<ResultadoPassoAmazon> {
  if (conta.canal !== 'amazon' || !conta.amazon) throw new Error(`conta ${conta.id} não é da Amazon`);
  const faltam = variaveisAusentes(conta);
  if (faltam.length && !o.cliente) return { ok: false, conta: conta.id, motivo: 'credenciais_ausentes', concluido: false, etapas: {} };

  const dono = randomBytes(8).toString('hex');
  if (!(await cache.setNX(K.lock, dono, 120))) return { ok: false, conta: conta.id, motivo: 'sync_em_andamento', concluido: false, etapas: {} };

  const agora = o.agora ?? Date.now;
  const inicio = agora();
  const orcamento = o.orcamentoMs ?? 20_000;
  const prazo = inicio + orcamento;
  const etapas = o.etapas ?? ETAPAS_AMAZON;
  const res: ResultadoPassoAmazon = { ok: true, conta: conta.id, concluido: false, etapas: {} };
  try {
    const cred = o.cliente ? null : lerCredenciais(conta);
    const cliente = o.cliente ?? criarClienteSpApi(cache, cred!, { agora });
    const marketplaceId = conta.amazon.marketplaceId;
    const sellerId = cred?.sellerId ?? process.env[`${conta.amazon.credenciaisEnv}_SELLER_ID`] ?? '';

    for (const etapa of etapas) {
      if (agora() - inicio > orcamento) { res.etapas[etapa] = { status: 'nao_executada', motivo: 'orcamento_de_tempo' }; continue; }
      try {
        if (etapa === 'pedidos') {
          const r = await sincronizarPedidos(cache, cliente, { conta: conta.id, marketplaceId, agora, prazo, cargaInicialDias: o.cargaInicialDias });
          res.etapas.pedidos = { status: r.concluido ? 'concluida' : 'parcial', detalhe: { ...r } };
        } else if (etapa === 'anuncios') {
          const r = await sincronizarAnuncios(cache, cliente, { conta: conta.id, sellerId, marketplaceId, agora, prazo });
          res.etapas.anuncios = { status: r.concluido ? 'concluida' : 'parcial', detalhe: { ...r } };
        } else if (etapa === 'estoque_fba') {
          const r = await sincronizarEstoqueFba(cache, cliente, { conta: conta.id, marketplaceId, agora });
          res.etapas.estoque_fba = r.estado.disponivel
            ? { status: 'concluida', detalhe: { registros: r.registros, paginas: r.paginas } }
            : { status: 'sem_permissao', operacao: 'getInventorySummaries', motivo: r.estado.motivo ?? 'indisponivel' };
        } else {
          const r = await sincronizarFinanceiro(cache, cliente, { conta: conta.id, marketplaceId, agora, prazo, cargaInicialDias: o.cargaInicialDias });
          res.etapas.financeiro = { status: r.concluido ? 'concluida' : 'parcial', detalhe: { ...r } };
        }
      } catch (e) {
        if (e instanceof FalhaLwa) {
          res.ok = false; res.motivo = e.motivo;
          for (const x of etapas) if (!res.etapas[x]) res.etapas[x] = { status: 'nao_executada', motivo: 'autorizacao' };
          break;
        }
        if (e instanceof ErroSpApi) {
          res.etapas[etapa] = e.motivo === 'limite_local' || e.motivo === 'limite_amazon'
            ? { status: 'aguardando_limite', esperaMs: e.esperaMs, operacao: e.operacao }
            : e.motivo === 'sem_permissao'
              ? { status: 'sem_permissao', operacao: e.operacao, motivo: e.message }
              : { status: 'erro', operacao: e.operacao, motivo: e.message };
          continue;
        }
        res.etapas[etapa] = { status: 'erro', motivo: e instanceof Error ? e.message.slice(0, 200) : 'erro' };
      }
    }
    res.concluido = res.ok && etapas.every(x => res.etapas[x]?.status === 'concluida' || (x === 'estoque_fba' && res.etapas[x]?.status === 'sem_permissao'));
    // Publica a leitura (snapshot de pedidos e catálogo da conta) sempre que a
    // Amazon foi consultada; a versão só cresce se o conteúdo mudou.
    const consultou = Object.values(res.etapas).some(e => e && (e.status === 'concluida' || e.status === 'parcial'));
    const ep = res.etapas.pedidos?.status;
    res.leitura = await publicarLeitura(cache, {
      agora: new Date(agora()), origem: o.origem ?? 'incremental', checouAmazon: consultou,
      resultado: ep === 'concluida' ? 'ok' : ep === 'erro' || ep === 'sem_permissao' ? 'erro_parcial' : 'parcial',
    });
    res.limites = await cliente.limites();
    await cache.set(K.ultimo, JSON.stringify({ em: new Date(agora()).toISOString(), ok: res.ok, motivo: res.motivo ?? null, etapas: res.etapas }));
    return res;
  } finally {
    await cache.delIfEquals(K.lock, dono);
  }
}

/** Estado legível da integração para diagnóstico. Sem valor de credencial, só NOMES ausentes. */
export async function estadoAmazon(cache: Cache, conta: Conta) {
  const [pedidos, anuncios, fba, fin, cobPedidos, cobFin, estadoFba, ultimo] = await Promise.all([
    lerManifesto(cache, 'pedidos'), lerManifesto(cache, 'anuncios'), lerManifesto(cache, 'estoque-fba'), lerManifesto(cache, 'financeiro'),
    estadoPedidos(cache), lerCoberturaFinanceira(cache), lerEstadoEstoqueFba(cache), cache.get(K.ultimo),
  ]);
  return {
    conta: conta.id,
    ativa: conta.ativo,
    credenciais: { completas: variaveisAusentes(conta).length === 0, ausentes: variaveisAusentes(conta) },
    pedidos: { total: pedidos?.total ?? 0, atualizadoEm: pedidos?.atualizadoEm ?? null, cobertoAte: cobPedidos.cobertoAte, jobEmAndamento: cobPedidos.jobEmAndamento },
    anuncios: { total: anuncios?.total ?? 0, atualizadoEm: anuncios?.atualizadoEm ?? null },
    estoqueFba: { estado: estadoFba, total: fba?.total ?? 0, atualizadoEm: fba?.atualizadoEm ?? null },
    financeiro: { transacoes: fin?.total ?? 0, cobertura: cobFin },
    ultimoPasso: ultimo ? JSON.parse(ultimo) : null,
  };
}
