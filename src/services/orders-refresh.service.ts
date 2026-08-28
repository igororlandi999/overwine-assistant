/**
 * orders-refresh.service — decide se vale rodar UM passo incremental de
 * sincronização a pedido do dashboard, e roda.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE ISTO EXISTE
 *
 * O dashboard dependia de dois mecanismos que falharam ao mesmo tempo: o
 * agendador do GitHub Actions passou a descartar a maioria dos ticks (1 a 2
 * execuções por dia, contra 24 esperadas), e a notificação do Mercado Livre
 * ainda não autentica. Resultado operacional: tela parada por horas.
 *
 * Este serviço fecha o buraco pelo lado que sempre está vivo — a aba aberta.
 * Quando o snapshot está velho, o próprio dashboard pede a sincronização.
 * Não substitui o tempo real nem a reconciliação: é o piso de confiabilidade
 * que garante que ninguém trabalhe com dado de horas atrás.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O QUE MEDE "VELHO", E POR QUE NÃO É `updatedAt`
 *
 * A idade é medida por `lastSyncAt` (quando CHECAMOS), não por
 * `manifest.updatedAt` (quando MUDOU). A distinção é decisiva: `updatedAt` só
 * avança quando uma versão é publicada, então num dia sem vendas ele fica
 * parado para sempre — e usá-lo como gatilho faria o dashboard pedir
 * sincronização a cada rodada, indefinidamente, para nunca achar nada.
 *
 * Com `lastSyncAt`, um período sem vendas produz uma sincronização a cada
 * janela e mais nada. É o mesmo par pedimos/mudou que a telemetria de tempo
 * real já usa.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DUAS TRAVAS, COM PAPÉIS DIFERENTES
 *
 * COOLDOWN (global, no Redis): impede que N abas abertas virem N
 * sincronizações. A primeira que chega adquire; as outras recebem `cooldown` e
 * não tocam no Mercado Livre. É o que segura carga.
 *
 * LOCK (o MESMO de orders-sync e do webhook): impede concorrência real de
 * escrita com o GitHub Actions e com o dreno de notificações. Quem segura o
 * lock é `runSyncStep`, e ele já devolve `sync_em_andamento` sem publicar nada
 * quando encontra o lock ocupado. Não duplicamos essa lógica aqui.
 *
 * O cooldown é adquirido ANTES de chamar o sync e NÃO é liberado no fim: ele é
 * uma janela de tempo, não um mutex. Liberar ao terminar permitiria uma
 * sincronização por requisição, que é exatamente o que ele existe para evitar.
 */
import type { Cache } from '../lib/cache/cache.js';
import { getEnv } from '../config/env.js';
import { readManifest } from '../lib/orders-store.js';
import {
  runSyncStep,
  readStatus,
  type FetchOrdersPage,
} from './orders-sync.service.js';

/** Janela global de cooldown. Vive no mesmo espaço de chaves da sincronização. */
export const CHAVE_COOLDOWN_REFRESH = 'orders:sync:refresh:cooldown';

export type ResultadoRefresh =
  /** Snapshot recente: nada a fazer, e o Mercado Livre não foi tocado. */
  | { acao: 'fresco'; idadeSegundos: number }
  /** Outra aba (ou outra requisição) já pediu há pouco. */
  | { acao: 'cooldown' }
  /** Não há snapshot base — carga inicial é trabalho do sync admin, não do dashboard. */
  | { acao: 'sem_snapshot' }
  /** O lock estava com a reconciliação ou com o dreno de notificações. */
  | { acao: 'sync_em_andamento' }
  /** Rodou. `publicou` diz se houve versão nova (false = nada mudou no ML). */
  | { acao: 'sincronizado'; publicou: boolean; novosPedidos: number; motivo?: string }
  /** A sincronização falhou. O snapshot anterior segue intacto e servido. */
  | { acao: 'erro'; motivo: string };

export interface OpcoesRefresh {
  /** Idade (s) de `lastSyncAt` a partir da qual vale sincronizar. */
  idadeMaximaS?: number;
  /** Duração (s) da janela de cooldown global. */
  cooldownS?: number;
  /** Relógio injetável — os testes precisam controlar a idade. */
  agoraMs?: number;
}

function idadeEmSegundos(iso: string | null, agoraMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((agoraMs - t) / 1000));
}

/**
 * Sincroniza SOMENTE se o snapshot estiver velho, respeitando cooldown e lock.
 *
 * Nunca reconstrói o histórico: usa `runSyncStep` em modo `incremental`, a
 * mesma rotina que a reconciliação de hora em hora chama, com o mesmo
 * `fetchPage`, a mesma normalização e a mesma publicação.
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
    return { acao: 'fresco', idadeSegundos: idade };
  }

  // Cooldown ANTES de qualquer chamada de rede. Dez abas chegando juntas
  // produzem uma aquisição e nove `cooldown`.
  const primeira = await cache.setNX(CHAVE_COOLDOWN_REFRESH, String(agoraMs), cooldownS);
  if (!primeira) return { acao: 'cooldown' };

  let r;
  try {
    r = await runSyncStep(cache, fetchPage, { alvo: 'ativos', modo: 'incremental' });
  } catch (e) {
    return { acao: 'erro', motivo: e instanceof Error ? e.message : 'erro desconhecido' };
  }

  if (r.motivo === 'sync_em_andamento') return { acao: 'sync_em_andamento' };
  if (!r.ok) return { acao: 'erro', motivo: r.motivo ?? 'sincronizacao falhou' };

  // `concluido` = publicou versão nova. `sem_novos` e `parcial` são desfechos
  // saudáveis que não publicam: o primeiro porque nada mudou no Mercado Livre,
  // o segundo porque o passo é retomável e continua na próxima chamada.
  return {
    acao: 'sincronizado',
    publicou: r.concluido,
    novosPedidos: r.novosPedidos,
    ...(r.motivo ? { motivo: r.motivo } : {}),
  };
}
