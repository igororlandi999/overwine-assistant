/**
 * orders-refresh.service — decide se vale sincronizar a pedido do dashboard,
 * escolhe o passo (rápido ou profundo) e roda.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE ISTO EXISTE
 *
 * O dashboard dependia de dois mecanismos que falharam ao mesmo tempo: o
 * agendador do GitHub Actions passou a descartar a maioria dos ticks (4 a 5
 * execuções por dia, contra 24 esperadas, em setembro/2026), e a notificação
 * do Mercado Livre chega mas é recusada — o segredo da URL registrada no
 * painel não bate com ML_WEBHOOK_SECRET. Resultado operacional: tela parada
 * por horas.
 *
 * Este serviço fecha o buraco pelo lado que sempre está vivo — a aba aberta.
 * Quando o snapshot está velho, o próprio dashboard pede a sincronização.
 * Não substitui o tempo real nem a reconciliação: é o piso de confiabilidade
 * que garante que ninguém trabalhe com dado de minutos atrás. E o piso precisa
 * bastar sozinho, porque foi exatamente isso que aconteceu.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DOIS PASSOS, COM PAPÉIS DIFERENTES
 *
 * RÁPIDO (orders-recent-sync.service): uma página do Mercado Livre, comparada
 * por assinatura. Uma checagem sem venda custa 1 chamada e nenhuma leitura de
 * chunk; uma venda custa 1 chamada e o upsert daquela venda. É o que roda na
 * maioria das vezes e o que dá latência de segundos.
 *
 * PROFUNDO (runSyncStep incremental): 5 páginas, revisita os 250 conhecidos
 * mais recentes, captura mudança de status fora da primeira página. Roda a
 * cada ORDERS_REFRESH_REVISAO_S, ou sempre que há um passo parcial pendente
 * para terminar. É o que dispensa o GitHub Actions como fonte de consistência.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O QUE MEDE "VELHO", E POR QUE NÃO É `updatedAt`
 *
 * A idade é medida por `lastSyncAt` (quando CHECAMOS), não por
 * `manifest.updatedAt` (quando MUDOU). `updatedAt` só avança quando uma
 * versão é publicada, então num dia sem vendas ele fica parado para sempre —
 * usá-lo como gatilho faria o dashboard pedir sincronização a cada rodada,
 * indefinidamente, para nunca achar nada.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DUAS TRAVAS, COM PAPÉIS DIFERENTES
 *
 * COOLDOWN (global, no Redis): impede que N abas abertas virem N
 * sincronizações. A primeira que chega adquire; as outras recebem `cooldown` e
 * não tocam no Mercado Livre. Um 429 do ML alonga a janela: insistir não
 * resolve rate limit.
 *
 * LOCK (o MESMO de orders-sync e do webhook): impede concorrência real de
 * escrita. Os dois passos adquirem o lock por conta própria e devolvem
 * `sync_em_andamento` sem publicar nada quando ele está ocupado.
 *
 * O cooldown é adquirido ANTES de chamar o passo e NÃO é liberado no fim: ele
 * é uma janela de tempo, não um mutex. Liberar ao terminar permitiria uma
 * sincronização por requisição, que é exatamente o que ele existe para evitar.
 */
import type { Cache } from '../lib/cache/cache.js';
import { getEnv } from '../config/env.js';
import { readManifest } from '../lib/orders-store.js';
import {
  registrarBloqueioSync,
  registrarConclusaoSync,
  registrarFalhaSync,
  registrarTentativaSync,
} from '../lib/sync-telemetry.js';
import {
  runSyncStep,
  readStatus,
  existeJobPendente,
  type FetchOrdersPage,
} from './orders-sync.service.js';
import { sincronizarRecentes } from './orders-recent-sync.service.js';

/** Janela global de cooldown. Vive no mesmo espaço de chaves da sincronização. */
export const CHAVE_COOLDOWN_REFRESH = 'orders:sync:refresh:cooldown';

export type ModoRefresh = 'rapido' | 'incremental';

export type ResultadoRefresh =
  /** Snapshot recente: nada a fazer, e o Mercado Livre não foi tocado. */
  | { acao: 'fresco'; idadeSegundos: number; versao: number }
  /** Outra aba (ou outra requisição) já pediu há pouco. */
  | { acao: 'cooldown'; versao: number }
  /** Não há snapshot base — carga inicial é trabalho do sync admin, não do dashboard. */
  | { acao: 'sem_snapshot' }
  /** O lock estava com a reconciliação ou com o dreno de notificações. */
  | { acao: 'sync_em_andamento'; modo: ModoRefresh; versao: number }
  /** Rodou. `publicou` diz se houve versão nova (false = nada mudou no ML). */
  | {
      acao: 'sincronizado';
      modo: ModoRefresh;
      publicou: boolean;
      novosPedidos: number;
      atualizados: number;
      /** Versão publicada ao final — a mesma de antes quando nada mudou. */
      versao: number;
      chamadasML: number;
      duracaoMs: number;
      motivo?: string;
    }
  /** A sincronização falhou. O snapshot anterior segue intacto e servido. */
  | { acao: 'erro'; modo: ModoRefresh; motivo: string; versao: number };

export interface OpcoesRefresh {
  /** Idade (s) de `lastSyncAt` a partir da qual vale sincronizar. */
  idadeMaximaS?: number;
  /** Duração (s) da janela de cooldown global. */
  cooldownS?: number;
  /** Intervalo (s) entre revisões profundas. */
  revisaoS?: number;
  /** Relógio injetável — os testes precisam controlar a idade. */
  agoraMs?: number;
  /** Força um modo, ignorando a escolha automática (usado em testes). */
  modo?: ModoRefresh;
}

function idadeEmSegundos(iso: string | null | undefined, agoraMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((agoraMs - t) / 1000));
}

/**
 * Sincroniza SOMENTE se o snapshot estiver velho, respeitando cooldown e lock.
 *
 * Nunca reconstrói o histórico: usa o passo rápido ou o passo incremental, a
 * mesma rotina que a reconciliação chama, com o mesmo `fetchPage`, a mesma
 * normalização e a mesma publicação.
 *
 * NUNCA lança. Um erro do Mercado Livre vira `{ acao: 'erro' }` e o snapshot
 * publicado continua intacto — o dashboard segue lendo o que já tinha.
 */
export async function refrescarSeVelho(
  cache: Cache,
  fetchPage: FetchOrdersPage,
  opts: OpcoesRefresh = {}
): Promise<ResultadoRefresh> {
  const env = getEnv();
  const idadeMaximaS = opts.idadeMaximaS ?? env.ORDERS_REFRESH_IDADE_MAX_S;
  const cooldownS = opts.cooldownS ?? env.ORDERS_REFRESH_COOLDOWN_S;
  const revisaoS = opts.revisaoS ?? env.ORDERS_REFRESH_REVISAO_S;
  const agoraMs = opts.agoraMs ?? Date.now();

  // Sem manifesto não há base incremental. A carga inicial percorre o
  // histórico inteiro e é trabalho do endpoint admin, nunca de uma aba aberta.
  const manifesto = await readManifest(cache, 'ativos');
  if (!manifesto) return { acao: 'sem_snapshot' };

  const status = await readStatus(cache, 'ativos');
  const idade = idadeEmSegundos(status?.lastSyncAt ?? null, agoraMs);

  // `idade === null` significa que nunca registramos uma sincronização — trata
  // como velho, porque é o estado em que mais precisamos de uma.
  if (idade !== null && idade < idadeMaximaS) {
    return { acao: 'fresco', idadeSegundos: idade, versao: manifesto.versao };
  }

  // Cooldown ANTES de qualquer chamada de rede. Dez abas chegando juntas
  // produzem uma aquisição e nove `cooldown`.
  const primeira = await cache.setNX(CHAVE_COOLDOWN_REFRESH, String(agoraMs), cooldownS);
  if (!primeira) {
    await registrarBloqueioSync(cache, 'cooldown');
    return { acao: 'cooldown', versao: manifesto.versao };
  }

  // Escolha do passo. Um passo parcial pendente é terminado antes de qualquer
  // outra coisa: ele já gastou páginas e só falta publicar.
  let modo: ModoRefresh = opts.modo ?? 'rapido';
  if (!opts.modo) {
    const idadeRevisao = idadeEmSegundos(status?.ultimaRevisaoEm ?? null, agoraMs);
    if ((await existeJobPendente(cache, 'ativos')) || idadeRevisao === null || idadeRevisao >= revisaoS) {
      modo = 'incremental';
    }
  }

  await registrarTentativaSync(cache, 'dashboard_refresh');
  const inicio = Date.now();

  if (modo === 'incremental') {
    let r;
    try {
      r = await runSyncStep(cache, fetchPage, { alvo: 'ativos', modo: 'incremental' });
    } catch (e) {
      return await falhou(cache, 'incremental', e instanceof Error ? e.message : 'erro desconhecido', manifesto.versao, cooldownS);
    }
    if (r.motivo === 'sync_em_andamento') {
      await registrarBloqueioSync(cache, 'lock');
      return { acao: 'sync_em_andamento', modo, versao: manifesto.versao };
    }
    if (!r.ok) {
      return await falhou(cache, 'incremental', r.motivo ?? 'sincronizacao falhou', manifesto.versao, cooldownS);
    }
    const depois = await readManifest(cache, 'ativos');
    const versao = depois?.versao ?? manifesto.versao;
    const duracaoMs = Date.now() - inicio;
    await registrarConclusaoSync(cache, {
      origem: 'dashboard_refresh', modo: 'incremental', duracaoMs, chamadasML: r.paginasLidas,
      novos: r.concluido ? r.novosPedidos : 0, atualizados: 0,
      versaoPublicada: r.concluido ? versao : null,
    });
    // `concluido` = publicou versão nova. `sem_novos` e `parcial` são desfechos
    // saudáveis que não publicam: o primeiro porque nada mudou no Mercado
    // Livre, o segundo porque o passo é retomável e continua na próxima chamada.
    return {
      acao: 'sincronizado', modo, publicou: r.concluido, novosPedidos: r.novosPedidos, atualizados: 0,
      versao, chamadasML: r.paginasLidas, duracaoMs, ...(r.motivo ? { motivo: r.motivo } : {}),
    };
  }

  let r;
  try {
    r = await sincronizarRecentes(cache, fetchPage);
  } catch (e) {
    return await falhou(cache, 'rapido', e instanceof Error ? e.message : 'erro desconhecido', manifesto.versao, cooldownS);
  }
  const duracaoMs = Date.now() - inicio;
  switch (r.acao) {
    case 'sem_snapshot':
      return { acao: 'sem_snapshot' };
    case 'sync_em_andamento':
      await registrarBloqueioSync(cache, 'lock');
      return { acao: 'sync_em_andamento', modo, versao: manifesto.versao };
    case 'erro':
      return await falhou(cache, 'rapido', r.motivo, manifesto.versao, cooldownS);
    case 'sem_novos':
      await registrarConclusaoSync(cache, {
        origem: 'dashboard_refresh', modo: 'rapido', duracaoMs, chamadasML: r.chamadasML,
        novos: 0, atualizados: 0, versaoPublicada: null,
      });
      return {
        acao: 'sincronizado', modo, publicou: false, novosPedidos: 0, atualizados: 0,
        versao: r.versao, chamadasML: r.chamadasML, duracaoMs, motivo: 'sem_novos',
      };
    case 'sincronizado':
      await registrarConclusaoSync(cache, {
        origem: 'dashboard_refresh', modo: 'rapido', duracaoMs, chamadasML: r.chamadasML,
        novos: r.novos, atualizados: r.atualizados, versaoPublicada: r.publicou ? r.versao : null,
      });
      return {
        acao: 'sincronizado', modo, publicou: r.publicou, novosPedidos: r.novos, atualizados: r.atualizados,
        versao: r.versao, chamadasML: r.chamadasML, duracaoMs, ...(r.publicou ? {} : { motivo: 'sem_novos' }),
      };
  }
}

/**
 * Registra a falha e, se foi rate limit do Mercado Livre, alonga o cooldown:
 * a aba aberta voltaria a pedir em segundos, e 429 não se resolve insistindo.
 */
async function falhou(
  cache: Cache,
  modo: ModoRefresh,
  motivo: string,
  versao: number,
  cooldownS: number
): Promise<ResultadoRefresh> {
  await registrarFalhaSync(cache, 'dashboard_refresh', motivo);
  if (/\b429\b/.test(motivo)) {
    const extra = getEnv().ORDERS_REFRESH_COOLDOWN_429_S;
    if (extra > cooldownS) await cache.set(CHAVE_COOLDOWN_REFRESH, String(Date.now()), extra);
  }
  return { acao: 'erro', modo, motivo, versao };
}
