/**
 * orders-events — ÚNICA camada que conhece o layout das chaves Redis da fila
 * de notificações do Mercado Livre e dos contadores de observabilidade dela.
 * Espelha orders-store: fala só com a interface Cache, nunca com Upstash.
 *
 * Layout:
 *   orders:evt:queue          FILA (lista Redis) de eventos a processar
 *   orders:evt:seen:{id}      marca de idempotência por id de notificação
 *   orders:evt:obs:notif      telemetria do RECEBIMENTO (escrita no ack)
 *   orders:evt:obs:proc       telemetria do PROCESSAMENTO (escrita sob lock)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE UMA FILA, E NÃO PROCESSAR NA PRÓPRIA NOTIFICAÇÃO
 *
 * O Mercado Livre espera HTTP 200 em até 500 ms. Buscar o pedido na API,
 * reescrever o chunk e publicar o manifesto leva mais que isso — e uma
 * resposta lenta é contada como entrega falha, com reenvio e risco de o ML
 * desabilitar a callback. Então o endpoint só ENFILEIRA e responde; quem
 * processa é o dreno, disparado por três gatilhos independentes (ver
 * orders-webhook.service).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE RPUSH/LPOP E NÃO UM ARRAY EM JSON
 *
 * Duas notificações podem chegar no mesmo milissegundo, em instâncias
 * serverless diferentes. Um ciclo get → parse → push → set perderia uma das
 * duas em silêncio. RPUSH e LPOP são atômicos no servidor; a fila não tem
 * essa corrida.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * JANELA DE PERDA CONHECIDA: LPOP NÃO É LEASE
 *
 * `retirar` usa LPOP. O evento sai da fila ATOMICAMENTE e passa a existir só
 * na memória da função. Se a função morrer entre o LPOP e a conclusão (ou o
 * reenfileiramento), aquele evento SOME. Isto é uma escolha consciente, não um
 * descuido, e vale escrever exatamente o que ela custa.
 *
 * QUANDO ACONTECE
 *   - a instância é congelada ou recuperada antes de o trabalho de fundo
 *     terminar (o `waitUntil` pede, não garante);
 *   - maxDuration estourado, falta de memória, troca de deploy no meio do voo.
 *   A janela é o tempo entre o LPOP e o fim do upsert: algo entre 300 ms e 1 s
 *   por lote. Um lote pode levar até ORDERS_WEBHOOK_MAX_DRENO eventos junto.
 *
 * O QUE SE PERDE
 *   Nada de dado: o evento carrega só um id de pedido. Perde-se a ATUALIZAÇÃO
 *   RÁPIDA daquele pedido. O pedido continua existindo no Mercado Livre e
 *   entra no snapshot pela reconciliação.
 *
 * PIOR CASO DE LATÊNCIA
 *   Até a próxima reconciliação publicar: o cron de hora em hora (`17 * * * *`)
 *   mais o atraso do agendador do GitHub Actions (minutos a dezenas de
 *   minutos) mais a execução, mais os 45 s do poll do dashboard. Na prática,
 *   de 60 a 90 minutos — exatamente o comportamento de antes desta fase, e só
 *   para o pedido que caiu na janela.
 *
 * POR QUE NÃO UMA FILA COM LEASE AGORA
 *   A correção clássica é não remover na leitura: LMOVE para uma lista
 *   `processing` com LREM na conclusão e um varredor devolvendo o que passou
 *   do prazo; ou Redis Streams com consumer group (XREADGROUP/XACK/XAUTOCLAIM),
 *   que é a ferramenta feita para isso.
 *
 *   Qualquer um dos dois exige métodos novos na interface Cache, um GATILHO
 *   NOVO para varrer leases vencidos, e uma decisão de prazo — curto demais
 *   reprocessa em paralelo, longo demais atrasa a recuperação. Isso é
 *   infraestrutura de fila de verdade para proteger uma janela de
 *   sub-segundo cujo pior caso a reconciliação já cobre.
 *
 *   O gatilho para revisitar é medido, não achado: se `tempoReal` mostrar
 *   pedidos aparecendo só na reconciliação de forma recorrente, ou se o
 *   negócio passar a exigir teto de latência garantido mesmo em falha, aí a
 *   fila com lease se paga.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A TELEMETRIA É BEST-EFFORT, DE PROPÓSITO
 *
 * Os dois blobs de observabilidade são lidos-e-regravados sem lock. Uma
 * atualização concorrente pode perder um contador. Isso é aceitável porque
 * nenhuma decisão do sistema depende deles: existem para responder "quando
 * chegou a última notificação" a um humano. Nada de negócio lê daqui.
 */
import type { Cache } from './cache/cache.js';

export const CHAVE_FILA = 'orders:evt:queue';
export const CHAVE_OBS_NOTIF = 'orders:evt:obs:notif';
export const CHAVE_OBS_PROC = 'orders:evt:obs:proc';

const chaveVisto = (notifId: string) => `orders:evt:seen:${notifId}`;

/**
 * Janela de idempotência. O ML reenvia uma notificação não confirmada por
 * horas; 24 h cobre a política de retentativa com folga. Passada a janela, um
 * reenvio tardio vira um upsert a mais do MESMO pedido, que é inofensivo — o
 * dreno sempre busca o estado atual na API.
 */
export const TTL_VISTO_S = 24 * 3600;

/** Um evento na fila. Só o mínimo: o processamento rebusca tudo na API do ML. */
export interface EventoPedido {
  /** Id do pedido no Mercado Livre, sempre em string canônica. */
  orderId: string;
  /** Tópico que originou o evento (orders_v2, shipments, ...). */
  topico: string;
  /** Id da notificação (`_id` do corpo do ML), quando informado. */
  notifId: string | null;
  /** Quando o backend recebeu (ISO). Não é o `sent` do ML. */
  recebidoEm: string;
  /**
   * `sent` do corpo do ML: quando o Mercado Livre despachou a notificação.
   *
   * É o ÚNICO campo do corpo, além do id, que atravessa a fila — e serve
   * exclusivamente para MEDIR latência ponta a ponta. Nenhuma decisão de
   * negócio o consulta, e ele nunca vira dado de pedido. `null` quando ausente
   * ou fora do formato ISO.
   */
  sent: string | null;
}

export interface ObsRecebimento {
  ultimaNotificacaoEm: string | null;
  ultimaNotificacaoTopico: string | null;
  ultimaNotificacaoPedido: string | null;
  /** `sent` do ML na última notificação aceita — o relógio DELES. */
  ultimaNotificacaoSent: string | null;
  /**
   * Milissegundos gastos no caminho da resposta da última notificação aceita.
   * O Mercado Livre exige HTTP 200 em menos de 500 ms; este número é a prova
   * de que continuamos dentro do orçamento.
   */
  ultimoAckMs: number | null;
  /**
   * Quando a rota PEDIU um dreno em segundo plano, na última notificação.
   *
   * Existe para ser comparado com `ultimoDrenoEm` (do outro blob, escrito
   * quando o dreno TERMINA). O `waitUntil` público devolve `void` e não diz se
   * a extensão foi aceita, então não há sonda de capacidade honesta a fazer —
   * mas "pedimos às 09:00:01 e nenhum dreno terminou depois disso, com fila
   * pendente" é uma medida do resultado, e é o sintoma que importa.
   */
  ultimoDrenoPedidoEm: string | null;
  totalRecebidas: number;
  totalDuplicadas: number;
  totalRejeitadas: number;
  /**
   * Por que a última notificação recusada foi recusada.
   *
   * Existe porque uma recusa é INVISÍVEL do lado de fora: respondemos 200 para
   * o ML não reenviar para sempre, então o painel dele mostra entrega bem
   * sucedida enquanto nada entra na fila. Sem este campo, um `ML_CLIENT_ID` com
   * um espaço sobrando derrubaria 100% das notificações e o sintoma seria
   * "o tempo real não funciona", sem nada apontando para a causa.
   *
   * É um dos motivos fechados de `interpretarNotificacao` (topico_ignorado,
   * user_id_divergente, application_id_divergente, resource_invalido,
   * corpo_invalido) — nunca texto vindo do corpo da notificação.
   */
  ultimoMotivoRejeicao: string | null;
  ultimaRejeicaoEm: string | null;
}

export interface ObsProcessamento {
  ultimoPedidoAtualizadoId: string | null;
  ultimoPedidoAtualizadoEm: string | null;
  ultimaAcao: 'novo' | 'atualizado' | 'sem_mudanca' | null;
  /** Versão do snapshot publicada pelo último upsert que mudou algo. */
  ultimaVersaoPublicada: number | null;
  /**
   * Latência ponta a ponta em milissegundos: do `sent` do Mercado Livre até a
   * publicação do manifesto. `null` quando o evento não trouxe `sent`.
   *
   * Depende dos relógios de duas máquinas diferentes, então vale como ordem de
   * grandeza — não como medição de precisão.
   */
  ultimaLatenciaTotalMs: number | null;
  totalNovos: number;
  totalAtualizados: number;
  totalSemMudanca: number;
  totalFalhas: number;
  ultimoErro: string | null;
  ultimoErroEm: string | null;
  ultimoDrenoEm: string | null;
}

const OBS_RECEBIMENTO_ZERO: ObsRecebimento = {
  ultimaNotificacaoEm: null,
  ultimaNotificacaoTopico: null,
  ultimaNotificacaoPedido: null,
  ultimaNotificacaoSent: null,
  ultimoAckMs: null,
  ultimoDrenoPedidoEm: null,
  totalRecebidas: 0,
  totalDuplicadas: 0,
  totalRejeitadas: 0,
  ultimoMotivoRejeicao: null,
  ultimaRejeicaoEm: null,
};

const OBS_PROCESSAMENTO_ZERO: ObsProcessamento = {
  ultimoPedidoAtualizadoId: null,
  ultimoPedidoAtualizadoEm: null,
  ultimaAcao: null,
  ultimaVersaoPublicada: null,
  ultimaLatenciaTotalMs: null,
  totalNovos: 0,
  totalAtualizados: 0,
  totalSemMudanca: 0,
  totalFalhas: 0,
  ultimoErro: null,
  ultimoErroEm: null,
  ultimoDrenoEm: null,
};

async function lerBlob<T>(cache: Cache, chave: string, zero: T): Promise<T> {
  const bruto = await cache.get(chave);
  if (bruto === null) return { ...zero };
  try {
    const v = JSON.parse(bruto) as Partial<T>;
    if (!v || typeof v !== 'object') return { ...zero };
    return { ...zero, ...v };
  } catch {
    // Telemetria corrompida NUNCA derruba nada: recomeça do zero.
    return { ...zero };
  }
}

export function lerObsRecebimento(cache: Cache): Promise<ObsRecebimento> {
  return lerBlob(cache, CHAVE_OBS_NOTIF, OBS_RECEBIMENTO_ZERO);
}

export function lerObsProcessamento(cache: Cache): Promise<ObsProcessamento> {
  return lerBlob(cache, CHAVE_OBS_PROC, OBS_PROCESSAMENTO_ZERO);
}

/**
 * Idempotência: devolve true na PRIMEIRA vez que este id de notificação
 * aparece, false em qualquer reenvio dentro da janela. Notificação sem `_id`
 * não tem como ser deduplicada aqui e passa direto — o dreno ainda é idempotente
 * por construção (busca o pedido na API e faz upsert do estado atual).
 */
export async function marcarNaoVista(cache: Cache, notifId: string | null): Promise<boolean> {
  if (!notifId) return true;
  return cache.setNX(chaveVisto(notifId), '1', TTL_VISTO_S);
}

/** Enfileira um evento. Retorna o tamanho da fila depois da escrita. */
export async function enfileirar(cache: Cache, evento: EventoPedido): Promise<number> {
  return cache.rpush(CHAVE_FILA, JSON.stringify(evento));
}

/** Devolve um evento ao INÍCIO conceitual da fila após falha de processamento. */
export async function reenfileirar(cache: Cache, evento: EventoPedido): Promise<void> {
  await cache.rpush(CHAVE_FILA, JSON.stringify(evento));
}

/**
 * Retira até `max` eventos. Entradas ilegíveis são DESCARTADAS em silêncio:
 * já saíram da fila e não há como reprocessá-las; a reconciliação periódica
 * cobre o pedido que elas representavam.
 */
export async function retirar(cache: Cache, max: number): Promise<EventoPedido[]> {
  const brutos = await cache.lpopMany(CHAVE_FILA, max);
  const out: EventoPedido[] = [];
  for (const b of brutos) {
    try {
      const e = JSON.parse(b) as EventoPedido;
      if (e && typeof e.orderId === 'string' && e.orderId !== '') out.push(e);
    } catch {
      continue;
    }
  }
  return out;
}

export function tamanhoFila(cache: Cache): Promise<number> {
  return cache.llen(CHAVE_FILA);
}

export async function registrarRecebimento(
  cache: Cache,
  dados: {
    topico: string;
    orderId: string | null;
    duplicada: boolean;
    rejeitada: boolean;
    motivo?: string;
    sent?: string | null;
    ackMs?: number | null;
  }
): Promise<void> {
  const obs = await lerObsRecebimento(cache);
  if (dados.rejeitada) {
    obs.totalRejeitadas++;
    obs.ultimoMotivoRejeicao = dados.motivo ?? null;
    obs.ultimaRejeicaoEm = new Date().toISOString();
  } else if (dados.duplicada) {
    obs.totalDuplicadas++;
  } else {
    obs.totalRecebidas++;
    obs.ultimaNotificacaoEm = new Date().toISOString();
    obs.ultimaNotificacaoTopico = dados.topico;
    obs.ultimaNotificacaoPedido = dados.orderId;
    obs.ultimaNotificacaoSent = dados.sent ?? null;
    obs.ultimoAckMs = typeof dados.ackMs === 'number' ? dados.ackMs : null;
  }
  await cache.set(CHAVE_OBS_NOTIF, JSON.stringify(obs));
}

/**
 * Marca que a rota pediu um dreno em segundo plano. Escrito DEPOIS de o
 * trabalho começar e ANTES da resposta — é o "pedimos" do par pedimos/terminou.
 */
export async function registrarDrenoPedido(cache: Cache): Promise<void> {
  const obs = await lerObsRecebimento(cache);
  obs.ultimoDrenoPedidoEm = new Date().toISOString();
  await cache.set(CHAVE_OBS_NOTIF, JSON.stringify(obs));
}

export async function registrarProcessamento(
  cache: Cache,
  dados:
    | {
        tipo: 'novo' | 'atualizado' | 'sem_mudanca';
        orderId: string;
        versao?: number | null;
        latenciaTotalMs?: number | null;
      }
    | { tipo: 'falha'; erro: string }
): Promise<void> {
  const obs = await lerObsProcessamento(cache);
  const agora = new Date().toISOString();
  obs.ultimoDrenoEm = agora;
  if (dados.tipo === 'falha') {
    obs.totalFalhas++;
    // Mensagem truncada: o blob é lido por rota pública de status e não pode
    // virar veículo de vazamento de URL, chave ou corpo de resposta do ML.
    obs.ultimoErro = dados.erro.slice(0, 200);
    obs.ultimoErroEm = agora;
  } else {
    obs.ultimaAcao = dados.tipo;
    obs.ultimoPedidoAtualizadoId = dados.orderId;
    obs.ultimoPedidoAtualizadoEm = agora;
    if (dados.versao !== undefined) obs.ultimaVersaoPublicada = dados.versao;
    if (dados.latenciaTotalMs !== undefined) obs.ultimaLatenciaTotalMs = dados.latenciaTotalMs;
    if (dados.tipo === 'novo') obs.totalNovos++;
    else if (dados.tipo === 'atualizado') obs.totalAtualizados++;
    else obs.totalSemMudanca++;
  }
  await cache.set(CHAVE_OBS_PROC, JSON.stringify(obs));
}

/** Marca que um dreno rodou, mesmo sem nada a fazer (prova de vida). */
export async function registrarDreno(cache: Cache): Promise<void> {
  const obs = await lerObsProcessamento(cache);
  obs.ultimoDrenoEm = new Date().toISOString();
  await cache.set(CHAVE_OBS_PROC, JSON.stringify(obs));
}
