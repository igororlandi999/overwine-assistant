/**
 * sync-telemetry — UM blob de observabilidade para "o snapshot de pedidos está
 * sendo atualizado?", independente de quem atualiza.
 *
 * Existe porque, até aqui, cada caminho contava a si mesmo: a reconciliação
 * gravava `lastSyncAt`, o webhook tinha o bloco `tempoReal`, e o auto-refresh
 * do dashboard só deixava rastro em log de função. Descobrir por que a tela
 * parou exigia abrir três lugares e o painel da Vercel. Este blob responde, em
 * uma leitura de `/api/orders/status`: quando tentamos pela última vez, quando
 * concluímos, por qual caminho, quanto custou, quando entrou o último pedido
 * novo, qual foi a última versão publicada e qual foi a última falha.
 *
 * Layout: `orders:sync:obs` (JSON). Mesmo contrato dos blobs de tempo real:
 * best-effort, lido-e-regravado sem lock, nenhuma decisão do sistema depende
 * dele. Mensagens de erro são truncadas — o blob sai por rota pública de
 * status e nunca pode carregar URL, chave ou corpo de resposta do ML.
 */
import type { Cache } from './cache/cache.js';

export const CHAVE_OBS_SYNC = 'orders:sync:obs';

export type OrigemSync = 'dashboard_refresh' | 'reconciliation' | 'webhook';
export type ModoSync = 'rapido' | 'incremental' | 'full' | 'dreno';

export interface ObsSync {
  /** Última vez que ALGUÉM começou a falar com o Mercado Livre por pedidos. */
  ultimoSyncTentadoEm: string | null;
  ultimaOrigemTentada: OrigemSync | null;
  /** Última tentativa que terminou sem erro (publicando ou não). */
  ultimoSyncConcluidoEm: string | null;
  ultimaOrigem: OrigemSync | null;
  ultimoModo: ModoSync | null;
  ultimaDuracaoMs: number | null;
  ultimasChamadasML: number | null;
  /** Do último sync concluído: quantos entraram e quantos mudaram. */
  ultimosPedidosNovos: number | null;
  ultimosPedidosAtualizados: number | null;
  /** Última vez que um pedido NOVO entrou no snapshot, por qualquer caminho. */
  ultimoPedidoNovoEm: string | null;
  ultimoPedidoNovoOrigem: OrigemSync | null;
  ultimaVersaoPublicada: number | null;
  ultimaVersaoPublicadaEm: string | null;
  ultimaVersaoPublicadaOrigem: OrigemSync | null;
  ultimaFalhaEm: string | null;
  ultimaFalhaMotivo: string | null;
  ultimaFalhaOrigem: OrigemSync | null;
  totalTentativas: number;
  totalConcluidos: number;
  totalPublicacoes: number;
  totalFalhas: number;
  /** Quantas vezes o auto-refresh encontrou o lock ocupado, e quando foi a última. */
  lockOcupado: number;
  ultimoLockOcupadoEm: string | null;
  /** Quantas vezes o auto-refresh saiu em cooldown (outra aba já tinha pedido). */
  cooldown: number;
  ultimoCooldownEm: string | null;
}

const ZERO: ObsSync = {
  ultimoSyncTentadoEm: null, ultimaOrigemTentada: null,
  ultimoSyncConcluidoEm: null, ultimaOrigem: null, ultimoModo: null,
  ultimaDuracaoMs: null, ultimasChamadasML: null,
  ultimosPedidosNovos: null, ultimosPedidosAtualizados: null,
  ultimoPedidoNovoEm: null, ultimoPedidoNovoOrigem: null,
  ultimaVersaoPublicada: null, ultimaVersaoPublicadaEm: null, ultimaVersaoPublicadaOrigem: null,
  ultimaFalhaEm: null, ultimaFalhaMotivo: null, ultimaFalhaOrigem: null,
  totalTentativas: 0, totalConcluidos: 0, totalPublicacoes: 0, totalFalhas: 0,
  lockOcupado: 0, ultimoLockOcupadoEm: null,
  cooldown: 0, ultimoCooldownEm: null,
};

export async function lerObsSync(cache: Cache): Promise<ObsSync> {
  const bruto = await cache.get(CHAVE_OBS_SYNC);
  if (bruto === null) return { ...ZERO };
  try {
    const v = JSON.parse(bruto) as Partial<ObsSync>;
    if (!v || typeof v !== 'object') return { ...ZERO };
    return { ...ZERO, ...v };
  } catch {
    return { ...ZERO }; // telemetria corrompida nunca derruba nada
  }
}

async function gravar(cache: Cache, obs: ObsSync): Promise<void> {
  await cache.set(CHAVE_OBS_SYNC, JSON.stringify(obs));
}

export async function registrarTentativaSync(cache: Cache, origem: OrigemSync): Promise<void> {
  const obs = await lerObsSync(cache);
  obs.ultimoSyncTentadoEm = new Date().toISOString();
  obs.ultimaOrigemTentada = origem;
  obs.totalTentativas++;
  await gravar(cache, obs);
}

export async function registrarConclusaoSync(
  cache: Cache,
  dados: {
    origem: OrigemSync;
    modo: ModoSync;
    duracaoMs: number;
    chamadasML: number;
    novos: number;
    atualizados: number;
    /** Versão publicada nesta conclusão; null quando nada mudou. */
    versaoPublicada: number | null;
  }
): Promise<void> {
  const obs = await lerObsSync(cache);
  const agora = new Date().toISOString();
  obs.ultimoSyncConcluidoEm = agora;
  obs.ultimaOrigem = dados.origem;
  obs.ultimoModo = dados.modo;
  obs.ultimaDuracaoMs = Math.max(0, Math.round(dados.duracaoMs));
  obs.ultimasChamadasML = dados.chamadasML;
  obs.ultimosPedidosNovos = dados.novos;
  obs.ultimosPedidosAtualizados = dados.atualizados;
  obs.totalConcluidos++;
  if (dados.novos > 0) {
    obs.ultimoPedidoNovoEm = agora;
    obs.ultimoPedidoNovoOrigem = dados.origem;
  }
  if (dados.versaoPublicada !== null) {
    obs.ultimaVersaoPublicada = dados.versaoPublicada;
    obs.ultimaVersaoPublicadaEm = agora;
    obs.ultimaVersaoPublicadaOrigem = dados.origem;
    obs.totalPublicacoes++;
  }
  await gravar(cache, obs);
}

/**
 * O motivo sai por rota pública de status. As mensagens dos adaptadores não
 * carregam token, mas um erro inesperado (rede, runtime) pode ecoar uma URL
 * com query string. Remove o que se pareça com credencial do ML e qualquer
 * query string antes de truncar.
 */
export function sanitizarMotivo(motivo: string): string {
  return motivo
    .replace(/\b(APP_USR|TG)-[A-Za-z0-9._-]+/g, '[redigido]')
    .replace(/\?[^\s)]*/g, '?[redigido]')
    .slice(0, 200);
}

export async function registrarFalhaSync(cache: Cache, origem: OrigemSync, motivo: string): Promise<void> {
  const obs = await lerObsSync(cache);
  obs.ultimaFalhaEm = new Date().toISOString();
  obs.ultimaFalhaMotivo = sanitizarMotivo(motivo);
  obs.ultimaFalhaOrigem = origem;
  obs.totalFalhas++;
  await gravar(cache, obs);
}

export async function registrarBloqueioSync(cache: Cache, tipo: 'lock' | 'cooldown'): Promise<void> {
  const obs = await lerObsSync(cache);
  const agora = new Date().toISOString();
  if (tipo === 'lock') { obs.lockOcupado++; obs.ultimoLockOcupadoEm = agora; }
  else { obs.cooldown++; obs.ultimoCooldownEm = agora; }
  await gravar(cache, obs);
}
