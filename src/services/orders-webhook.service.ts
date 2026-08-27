/**
 * orders-webhook.service — recebe uma notificação do Mercado Livre e atualiza
 * UM pedido no snapshot, sem reconstruir os outros milhares.
 *
 * NÃO conhece HTTP nem Upstash: recebe `Cache` e um `FetchOrderById` por
 * injeção, exatamente como orders-sync.service recebe `FetchOrdersPage`. O
 * mlFetch real é injetado só na rota. Persistência sempre via orders-store;
 * fila e telemetria sempre via orders-events.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE ISTO EXISTE
 *
 * Até aqui o ÚNICO caminho de atualização era a varredura de hora em hora do
 * GitHub Actions. Um pedido feito às 07:05 só aparecia no dashboard depois da
 * execução das 08:17 — mais o intervalo de refresh do navegador. Aumentar a
 * frequência do cron não resolve: transforma um problema de arquitetura numa
 * conta de chamadas à API, e continua sendo polling.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O QUE É INCREMENTAL, EXATAMENTE
 *
 * O snapshot é uma lista de chunks em ordem date_desc. Publicar uma versão
 * nova NÃO exige reescrever todos os chunks: o manifesto lista as chaves
 * explicitamente, então a versão nova pode REUSAR as chaves da versão
 * anterior para os chunks que não mudaram e apontar para uma chave nova
 * apenas no chunk tocado.
 *
 * Custo por venda: 1 GET (o chunk 0) + 1 SET (o chunk 0 novo) + as escritas de
 * ponteiro do manifesto. Uma republicação canônica custa ~8 GET + ~8 SET e
 * ~2 MB de tráfego — por venda seria desperdício e risco.
 *
 * A retenção de orders-store já protege o reuso de chave: `publishManifest`
 * só apaga chunk do `previous` ANTIGO que não seja referenciado pelo atual
 * nem pelo novo.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IDEMPOTÊNCIA E EVENTOS FORA DE ORDEM
 *
 * O evento carrega apenas o ID do pedido. O estado vem SEMPRE de uma busca
 * nova em GET /orders/{id}. Portanto:
 *  - o mesmo evento duas vezes produz o mesmo resultado (na segunda, o pedido
 *    já está idêntico e nem publicamos versão nova);
 *  - um evento antigo chegando depois de um recente não regride nada, porque
 *    nunca aplicamos o conteúdo do evento — só o estado atual do pedido.
 * A deduplicação por `_id` em orders-events é economia de chamadas, não a
 * garantia de correção. A garantia é esta.
 */
import { randomBytes } from 'node:crypto';
import type { Cache } from '../lib/cache/cache.js';
import { getEnv } from '../config/env.js';
import { toSlim, type OrderInput, type OrderSlim } from './orders.service.js';
import { slimIgual, ORDERS_SYNC_LOCK_KEY } from './orders-sync.service.js';
import {
  type Alvo,
  type OrdersManifest,
  readManifest,
  readChunkByKey,
  writeChunk,
  publishManifest,
} from '../lib/orders-store.js';
import {
  type EventoPedido,
  enfileirar,
  reenfileirar,
  retirar,
  marcarNaoVista,
  registrarRecebimento,
  registrarProcessamento,
  registrarDreno,
  tamanhoFila,
} from '../lib/orders-events.js';

/**
 * Tópicos de notificação do Mercado Livre cujo `resource` é `/orders/{id}`.
 *
 * `orders_v2` é o tópico vigente: dispara na criação do pedido e a cada
 * mudança (pagamento, cancelamento, reembolso). `created_orders` é o tópico
 * antigo, aceito porque uma aplicação pode ainda tê-lo assinado no painel; ele
 * só dispara na criação, então nunca substitui `orders_v2`.
 *
 * `shipments`, `payments`, `items`, `questions` e `messages` NÃO entram: o
 * `resource` deles não é um pedido, e traduzi-lo custaria uma chamada extra à
 * API para um dado que a reconciliação já cobre.
 */
export const TOPICOS_DE_PEDIDO: ReadonlySet<string> = new Set(['orders_v2', 'created_orders']);

/** Só o alvo `ativos` é mantido por notificação; `cancelados` fica na reconciliação. */
const ALVO: Alvo = 'ativos';

export type FetchOrderById = (orderId: string) => Promise<OrderInput>;

// ── 1. Interpretação da notificação (pura) ──────────────────────────────────

export type Interpretacao =
  | { ok: true; evento: EventoPedido }
  | { ok: false; motivo: string; topico: string };

/**
 * Valida o corpo de uma notificação do ML e extrai o id do pedido.
 *
 * Nada aqui confia no conteúdo além do id: mesmo que o corpo trouxesse os
 * dados do pedido, o dreno buscaria o estado atual na API assim mesmo. Por
 * isso uma notificação forjada consegue, no pior caso, provocar uma busca a
 * mais de um pedido que já é nosso.
 *
 * O `user_id` é conferido contra ML_USER_ID: notificação de outra conta (o ML
 * envia por aplicação, e uma aplicação pode ter mais de um vendedor
 * autorizado) não pode entrar neste snapshot.
 */
export function interpretarNotificacao(
  body: unknown,
  esperado: { mlUserId: string; applicationId: string }
): Interpretacao {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, motivo: 'corpo_invalido', topico: '' };
  }
  const b = body as Record<string, unknown>;
  const topico = typeof b.topic === 'string' ? b.topic : '';

  if (!TOPICOS_DE_PEDIDO.has(topico)) {
    return { ok: false, motivo: 'topico_ignorado', topico };
  }

  // O ML manda user_id e application_id como número; comparamos em string
  // canônica. Ambos são conferidos com a MESMA regra defensiva: campo ausente
  // não reprova (o corpo do ML pode variar por tópico e por versão), campo
  // presente e divergente reprova. Um corpo mais pobre que o esperado degrada
  // para a validação que sobrou; nunca para "aceita qualquer coisa em
  // silêncio", porque o `resource` ainda precisa casar e o segredo da URL já
  // foi conferido antes de chegarmos aqui.
  const userId = b.user_id;
  if (userId !== undefined && userId !== null && String(userId) !== esperado.mlUserId) {
    return { ok: false, motivo: 'user_id_divergente', topico };
  }

  const appId = b.application_id;
  if (appId !== undefined && appId !== null && String(appId) !== esperado.applicationId) {
    return { ok: false, motivo: 'application_id_divergente', topico };
  }

  const resource = typeof b.resource === 'string' ? b.resource : '';
  const m = /^\/orders\/(\d+)$/.exec(resource);
  if (!m) {
    return { ok: false, motivo: 'resource_invalido', topico };
  }

  const notifId = typeof b._id === 'string' && b._id !== '' ? b._id : null;

  return {
    ok: true,
    evento: {
      orderId: m[1],
      topico,
      notifId,
      recebidoEm: new Date().toISOString(),
      sent: lerSent(b.sent),
    },
  };
}

/**
 * `sent` do ML, aceito só se for data reconhecível. Serve exclusivamente para
 * medir latência: nunca vira dado de pedido e nunca decide nada.
 */
function lerSent(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null;
  return Number.isFinite(Date.parse(v)) ? v : null;
}

// ── 2. Recebimento: valida, deduplica, enfileira. NÃO busca nada no ML. ─────

export type ResultadoRecebimento =
  | { aceito: true; duplicada: false; orderId: string; fila: number }
  | { aceito: true; duplicada: true; orderId: string; fila: number }
  | { aceito: false; motivo: string };

/**
 * Caminho do ACK. Faz o mínimo possível: o Mercado Livre espera HTTP 200 em
 * até 500 ms e conta uma resposta lenta como entrega falha.
 */
export async function receberNotificacao(
  cache: Cache,
  body: unknown,
  esperado: { mlUserId: string; applicationId: string },
  medicao: { inicioMs?: number } = {}
): Promise<ResultadoRecebimento> {
  const decorrido = () =>
    typeof medicao.inicioMs === 'number' ? Math.max(0, Math.round(Date.now() - medicao.inicioMs)) : null;

  const r = interpretarNotificacao(body, esperado);
  if (!r.ok) {
    await registrarRecebimento(cache, {
      topico: r.topico,
      orderId: null,
      duplicada: false,
      rejeitada: true,
      motivo: r.motivo,
    });
    return { aceito: false, motivo: r.motivo };
  }

  const primeira = await marcarNaoVista(cache, r.evento.notifId);
  if (!primeira) {
    const fila = await tamanhoFila(cache);
    await registrarRecebimento(cache, {
      topico: r.evento.topico,
      orderId: r.evento.orderId,
      duplicada: true,
      rejeitada: false,
    });
    return { aceito: true, duplicada: true, orderId: r.evento.orderId, fila };
  }

  const fila = await enfileirar(cache, r.evento);
  await registrarRecebimento(cache, {
    topico: r.evento.topico,
    orderId: r.evento.orderId,
    duplicada: false,
    rejeitada: false,
    sent: r.evento.sent,
    ackMs: decorrido(),
  });
  return { aceito: true, duplicada: false, orderId: r.evento.orderId, fila };
}

// ── 3. Upsert de UM pedido no snapshot publicado ────────────────────────────

export type AcaoUpsert = 'novo' | 'atualizado' | 'sem_mudanca' | 'sem_snapshot';

export interface ResultadoUpsert {
  acao: AcaoUpsert;
  orderId: string;
  /** Versão publicada por este upsert; null quando nada foi publicado. */
  versao: number | null;
  /** Quantos chunks foram LIDOS para localizar o pedido (custo observável). */
  chunksLidos: number;
  /** Quantos chunks foram REESCRITOS (1 normalmente, 2 quando houve divisão). */
  chunksEscritos: number;
}

/**
 * Tamanhos reais de cada chunk.
 *
 * Manifesto publicado por esta fase já traz `chunkCounts`. Para os anteriores
 * derivamos por `chunkSize`, o que é exato porque a publicação canônica fatia
 * em blocos uniformes — e conferimos a soma contra `totalRegistros` antes de
 * acreditar na derivação.
 */
function contagens(man: OrdersManifest): number[] | null {
  const c = man.chunkCounts;
  if (Array.isArray(c) && c.length === man.chunks.length) {
    const soma = c.reduce((s, n) => s + n, 0);
    if (soma === man.totalRegistros) return [...c];
  }
  const tam = man.chunkSize > 0 ? man.chunkSize : 0;
  if (tam <= 0) return null;
  const derivado: number[] = [];
  let restante = man.totalRegistros;
  for (let i = 0; i < man.chunks.length; i++) {
    const n = Math.min(tam, Math.max(restante, 0));
    derivado.push(n);
    restante -= n;
  }
  if (restante !== 0 || derivado.reduce((s, n) => s + n, 0) !== man.totalRegistros) return null;
  return derivado;
}

function maiorData(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}
function menorData(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/**
 * Insere ou atualiza um pedido no snapshot publicado, reescrevendo UM chunk.
 * PRÉ-CONDIÇÃO: o chamador segura ORDERS_SYNC_LOCK_KEY.
 *
 * A varredura para cedo e isso é seguro: os chunks estão em ordem date_desc e
 * `date_created` de um pedido não muda. Se a data do pedido é mais recente que
 * o último registro do chunk `i`, então ele só pode estar em algum chunk até
 * `i` — nunca depois. Pedido sem `date_created` cai no caminho conservador de
 * varrer tudo.
 */
export async function upsertPedido(
  cache: Cache,
  pedido: OrderSlim,
  alvo: Alvo = ALVO
): Promise<ResultadoUpsert> {
  const id = String(pedido.id);
  const man = await readManifest(cache, alvo);
  if (!man) {
    // Sem snapshot base não há o que atualizar incrementalmente. Publicar um
    // manifesto de um pedido só apagaria o histórico na prática: a leitura
    // passaria a servir 1 registro. A carga inicial é trabalho do sync full.
    return { acao: 'sem_snapshot', orderId: id, versao: null, chunksLidos: 0, chunksEscritos: 0 };
  }

  const counts = contagens(man);
  if (counts === null) {
    // Manifesto cujo fatiamento não conseguimos descrever: recusamos o upsert
    // em vez de publicar uma versão com offsets errados. A reconciliação
    // republica canonicamente e o próximo evento encontra o terreno arrumado.
    return { acao: 'sem_snapshot', orderId: id, versao: null, chunksLidos: 0, chunksEscritos: 0 };
  }

  const data = pedido.date_created;
  let chunksLidos = 0;
  let alvoIdx = -1;      // chunk que recebe a escrita
  let posSubstituir = -1; // posição do id existente, quando encontrado
  let posInserir = -1;    // posição de inserção, quando é pedido novo
  let conteudo: OrderSlim[] = [];

  for (let i = 0; i < man.chunks.length; i++) {
    const chunk = await readChunkByKey(cache, man.chunks[i]);
    chunksLidos++;

    const idx = chunk.findIndex(o => String(o.id) === id);
    if (idx >= 0) {
      alvoIdx = i;
      posSubstituir = idx;
      conteudo = chunk;
      break;
    }

    if (data !== null && chunk.length > 0) {
      const maisAntigoDoChunk = chunk[chunk.length - 1].date_created;
      // Cabe neste chunk (é mais novo que o registro mais antigo dele) e não
      // está aqui: então é pedido NOVO e nenhum chunk seguinte pode contê-lo.
      if (maisAntigoDoChunk === null || data >= maisAntigoDoChunk) {
        let pos = chunk.length;
        for (let j = 0; j < chunk.length; j++) {
          const d = chunk[j].date_created;
          if (d !== null && data >= d) { pos = j; break; }
        }
        alvoIdx = i;
        posInserir = pos;
        conteudo = chunk;
        break;
      }
    }
  }

  if (alvoIdx < 0) {
    // Mais antigo que todo o snapshot (ou sem data e ausente de todos os
    // chunks): entra no fim do último chunk.
    alvoIdx = man.chunks.length - 1;
    if (alvoIdx < 0) {
      return { acao: 'sem_snapshot', orderId: id, versao: null, chunksLidos, chunksEscritos: 0 };
    }
    conteudo = await readChunkByKey(cache, man.chunks[alvoIdx]);
    chunksLidos++;
    posInserir = conteudo.length;
  }

  // Nada mudou: não publicamos versão nova. Isso preserva o significado de
  // `versao` para o dashboard, que a usa para decidir se vale repaginar.
  if (posSubstituir >= 0 && slimIgual(conteudo[posSubstituir], pedido)) {
    return { acao: 'sem_mudanca', orderId: id, versao: null, chunksLidos, chunksEscritos: 0 };
  }

  const novoConteudo = [...conteudo];
  const acao: AcaoUpsert = posSubstituir >= 0 ? 'atualizado' : 'novo';
  if (posSubstituir >= 0) novoConteudo[posSubstituir] = pedido;
  else novoConteudo.splice(posInserir, 0, pedido);

  const novaVersao = man.versao + 1;

  // Divisão preventiva: o chunk tocado cresce um registro por venda entre uma
  // republicação canônica e outra. Acima do dobro do tamanho nominal ele é
  // partido em dois — ainda O(1) escritas, e o chunk não vira uma chave gorda.
  const limite = man.chunkSize > 0 ? man.chunkSize * 2 : Number.POSITIVE_INFINITY;
  const partes: OrderSlim[][] =
    novoConteudo.length > limite
      ? [novoConteudo.slice(0, Math.ceil(novoConteudo.length / 2)), novoConteudo.slice(Math.ceil(novoConteudo.length / 2))]
      : [novoConteudo];

  // As chaves novas usam a versão nova, então nunca colidem com as reusadas.
  const novasChaves: string[] = [];
  for (let k = 0; k < partes.length; k++) {
    novasChaves.push(await writeChunk(cache, alvo, novaVersao, k, partes[k]));
  }

  const chunks = [...man.chunks];
  const novosCounts = [...counts];
  chunks.splice(alvoIdx, 1, ...novasChaves);
  novosCounts.splice(alvoIdx, 1, ...partes.map(p => p.length));

  const manifesto: OrdersManifest = {
    versao: novaVersao,
    chunks,
    totalRegistros: man.totalRegistros + (acao === 'novo' ? 1 : 0),
    newestDate: maiorData(man.newestDate, data),
    oldestDate: acao === 'novo' ? menorData(man.oldestDate, data) : man.oldestDate,
    chunkSize: man.chunkSize,
    updatedAt: new Date().toISOString(),
    origem: 'webhook',
    chunkCounts: novosCounts,
  };
  await publishManifest(cache, alvo, manifesto);

  return { acao, orderId: id, versao: novaVersao, chunksLidos, chunksEscritos: partes.length };
}

// ── 4. Dreno da fila ────────────────────────────────────────────────────────

export interface ResultadoDreno {
  ok: boolean;
  processados: number;
  novos: number;
  atualizados: number;
  semMudanca: number;
  falhas: number;
  restantes: number;
  motivo?: string;
}

/**
 * Tentativas de pegar o lock antes de desistir do dreno.
 *
 * Uma tentativa só bastaria se os drenos nunca se cruzassem. Eles se cruzam:
 * duas vendas no mesmo segundo geram dois drenos, o primeiro segura o lock por
 * algumas centenas de milissegundos, e o segundo chegaria depois de o primeiro
 * já ter esvaziado a fila — deixando o evento da segunda venda esperando o job
 * de hora em hora. Uma espera curta cobre essa janela.
 *
 * A espera é barata porque o dreno roda em SEGUNDO PLANO: o ACK já foi dado, e
 * o orçamento de 500 ms do Mercado Livre não se aplica aqui. O teto total
 * (3 x 400 ms = 1,2 s) fica muito abaixo do maxDuration da função, e não tenta
 * vencer uma reconciliação — essa segura o lock por muito mais tempo, e para
 * ela o caminho certo é mesmo deixar o evento na fila.
 */
const LOCK_TENTATIVAS = 3;
const LOCK_ESPERA_MS = 400;

async function tentarLock(cache: Cache, dono: string, ttlS: number): Promise<boolean> {
  for (let i = 0; i < LOCK_TENTATIVAS; i++) {
    if (await cache.setNX(ORDERS_SYNC_LOCK_KEY, dono, ttlS)) return true;
    // Nada a drenar? Não vale esperar por um lock que não vamos usar.
    if ((await tamanhoFila(cache)) === 0) return false;
    if (i < LOCK_TENTATIVAS - 1) await new Promise(r => setTimeout(r, LOCK_ESPERA_MS));
  }
  return false;
}

const DRENO_ZERO: ResultadoDreno = {
  ok: true, processados: 0, novos: 0, atualizados: 0, semMudanca: 0, falhas: 0, restantes: 0,
};

/**
 * Retira eventos da fila e aplica cada um. Segura o MESMO lock da
 * sincronização periódica durante todo o trabalho.
 *
 * Lock ocupado NÃO é erro: significa que uma reconciliação está publicando
 * agora, e ela lê a API do ML de qualquer forma. Os eventos ficam na fila para
 * o próximo dreno.
 */
export async function drenarFila(
  cache: Cache,
  fetchOrder: FetchOrderById,
  opts: { max?: number } = {}
): Promise<ResultadoDreno> {
  const env = getEnv();
  const max = opts.max ?? env.ORDERS_WEBHOOK_MAX_DRENO;

  const dono = randomBytes(16).toString('hex');
  const pegou = await tentarLock(cache, dono, env.ORDERS_SYNC_LOCK_TTL_S);
  if (!pegou) {
    return { ...DRENO_ZERO, restantes: await tamanhoFila(cache), motivo: 'sync_em_andamento' };
  }

  const r: ResultadoDreno = { ...DRENO_ZERO };
  try {
    const eventos = await retirar(cache, max);
    if (eventos.length === 0) {
      await registrarDreno(cache);
      return { ...r, restantes: 0 };
    }

    // Um mesmo pedido pode ter gerado vários eventos (criado, pago, enviado).
    // Buscar o estado atual UMA vez responde a todos eles.
    const unicos = [...new Set(eventos.map(e => e.orderId))];
    const porId = new Map<string, EventoPedido>();
    for (const e of eventos) if (!porId.has(e.orderId)) porId.set(e.orderId, e);

    for (const orderId of unicos) {
      try {
        const bruto = await fetchOrder(orderId);
        if (!bruto || String(bruto.id) !== orderId) {
          throw new Error(`ML devolveu pedido diferente do pedido ${orderId}.`);
        }
        const res = await upsertPedido(cache, toSlim(bruto), ALVO);
        r.processados++;
        // Latência ponta a ponta: do relógio do ML até a publicação. Dois
        // relógios diferentes, então vale como ordem de grandeza.
        const sent = porId.get(orderId)?.sent ?? null;
        const t = sent !== null ? Date.parse(sent) : NaN;
        const latenciaTotalMs = Number.isFinite(t) ? Math.max(0, Math.round(Date.now() - t)) : null;
        const comum = { orderId, versao: res.versao, latenciaTotalMs };
        if (res.acao === 'novo') { r.novos++; await registrarProcessamento(cache, { tipo: 'novo', ...comum }); }
        else if (res.acao === 'atualizado') { r.atualizados++; await registrarProcessamento(cache, { tipo: 'atualizado', ...comum }); }
        else if (res.acao === 'sem_mudanca') { r.semMudanca++; await registrarProcessamento(cache, { tipo: 'sem_mudanca', ...comum }); }
        else {
          // sem_snapshot: não há base para o upsert. Não é falha do evento, e
          // reenfileirar só repetiria o mesmo resultado — a carga inicial (ou a
          // republicação canônica) é que precisa acontecer.
          await registrarProcessamento(cache, { tipo: 'falha', erro: `sem snapshot base para o pedido ${orderId}` });
          r.falhas++;
        }
      } catch (e) {
        r.falhas++;
        const msg = e instanceof Error ? e.message : 'erro desconhecido';
        await registrarProcessamento(cache, { tipo: 'falha', erro: msg });
        // Devolve à fila para uma nova tentativa. Se falhar de novo e de novo,
        // a reconciliação de hora em hora ainda captura o pedido: a fila é o
        // caminho rápido, não a única garantia.
        const original = porId.get(orderId);
        if (original) await reenfileirar(cache, original);
      }
    }

    r.restantes = await tamanhoFila(cache);
    r.ok = r.falhas === 0;
    return r;
  } finally {
    await cache.delIfEquals(ORDERS_SYNC_LOCK_KEY, dono);
  }
}
