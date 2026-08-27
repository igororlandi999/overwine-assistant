/**
 * POST /api/notifications/ml?k=<ML_WEBHOOK_SECRET>
 *
 * Callback de notificações do Mercado Livre. É o gatilho de TEMPO REAL do
 * snapshot de pedidos: uma venda dispara um evento aqui em segundos, contra a
 * varredura de hora em hora do GitHub Actions, que continua existindo como
 * reconciliação.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CONTRATO COM O MERCADO LIVRE
 *
 * O ML espera HTTP 200 em até 500 ms. Uma resposta mais lenta conta como
 * entrega falha: ele reenvia, e uma sequência longa de falhas pode fazer a
 * callback ser desabilitada. Por isso este handler faz o MÍNIMO no caminho da
 * resposta — validar, deduplicar, enfileirar — e delega o trabalho pesado ao
 * dreno, agendado via waitUntil.
 *
 * O orçamento de 500 ms é INVIOLÁVEL neste arquivo. Nenhuma chamada à API do
 * Mercado Livre, nenhuma leitura de chunk e nenhuma publicação de manifesto
 * pode entrar no caminho da resposta, nem como "só desta vez, quando o runtime
 * não tiver waitUntil". Sem waitUntil o evento fica na fila e o job de hora em
 * hora o drena — e `tempoReal.waitUntilDisponivel` em /api/orders/status diz
 * exatamente que foi isso que aconteceu, em vez de deixar o sintoma virar
 * "às vezes o pedido demora".
 *
 * Corolário: qualquer coisa que não seja um problema de autenticação responde
 * 200. Tópico que não interessa, corpo estranho, pedido de outra conta: tudo
 * 200. Devolver 4xx nesses casos só faria o ML reenviar para sempre um evento
 * que nunca vamos querer.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AUTENTICAÇÃO
 *
 * O Mercado Livre NÃO assina as notificações: não há HMAC, header de
 * assinatura, nem lista de IPs publicada. O que existe é a URL de callback,
 * que só o ML conhece. Então o segredo vai NA URL (`?k=`), comparado em tempo
 * constante, e a URL registrada no painel do ML passa a ser uma credencial —
 * trocá-la exige editar o painel.
 *
 * A segunda camada é a arquitetura: este endpoint NUNCA acredita no corpo. O
 * id do pedido é o único dado aproveitado, e o estado vem de uma busca nova em
 * GET /orders/{id} com o token do backend. Uma notificação forjada com um id
 * válido provoca, no pior caso, uma releitura de um pedido que já é nosso.
 *
 * NUNCA expõe token do ML, chave Redis, nome de chunk ou detalhe do pedido: a
 * resposta é `{ ok: true }` e nada mais.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getEnv } from '../../src/config/env.js';
import { getCache } from '../../src/lib/cache/cache.js';
import { safeEquals, rateLimitOk, clientIp, maskIp, json } from '../../src/lib/http.js';
import { agendar, suportaWaitUntil } from '../../src/lib/wait-until.js';
import { criarFetchOrder } from '../../src/lib/ml-orders.js';
import { receberNotificacao, drenarFila } from '../../src/services/orders-webhook.service.js';

/** O corpo pode chegar já parseado pela Vercel ou como string bruta. */
function lerCorpo(req: VercelRequest): unknown {
  const b: unknown = req.body;
  if (typeof b === 'string') {
    try {
      return JSON.parse(b);
    } catch {
      return null;
    }
  }
  return b ?? null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const inicioMs = Date.now();
  const cache = getCache();
  const ip = clientIp(req);

  try {
    const env = getEnv();

    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });

    // Sem segredo configurado o recurso está DESLIGADO — e desligado de forma
    // explícita, não silenciosa. A reconciliação segue como estava.
    if (!env.ML_WEBHOOK_SECRET) {
      return json(res, 503, { error: 'notificacoes_desabilitadas' });
    }

    // Rate limit ANTES da comparação do segredo: o endpoint é público e não
    // pode virar um amplificador de escrita no Redis. O volume real de
    // notificações da conta fica em dezenas por hora.
    if (!(await rateLimitOk(cache, `ml-notif:${ip}`, 300, 60))) {
      return json(res, 429, { error: 'rate_limited' });
    }

    const k = typeof req.query.k === 'string' ? req.query.k : '';
    if (!k || !safeEquals(k, env.ML_WEBHOOK_SECRET)) {
      console.warn(`[ml-notif] segredo invalido ip=${maskIp(ip)}`);
      return json(res, 401, { error: 'unauthorized' });
    }

    // Consulta PURA, sem I/O: só para a telemetria saber se o dreno pôde ser
    // agendado. Precisa vir antes do registro do recebimento, que é a única
    // escrita de telemetria do caminho da resposta.
    const comWaitUntil = suportaWaitUntil();

    const r = await receberNotificacao(
      cache,
      lerCorpo(req),
      // `application_id` do Mercado Livre É o client_id da aplicação. Não há
      // fonte nova nem valor duplicado aqui: ML_CLIENT_ID já é obrigatório
      // desde a primeira versão do backend, e é o mesmo número que aparece no
      // corpo da notificação.
      { mlUserId: env.ML_USER_ID, applicationId: env.ML_CLIENT_ID },
      { inicioMs, waitUntilDisponivel: comWaitUntil }
    );

    if (!r.aceito) {
      // 200 de propósito: ver a nota de contrato no topo.
      console.info(`[ml-notif] ignorada motivo=${r.motivo}`);
      return json(res, 200, { ok: true, ignorada: true });
    }

    if (r.duplicada) {
      console.info(`[ml-notif] duplicada pedido=${r.orderId}`);
      return json(res, 200, { ok: true, duplicada: true });
    }

    // Trabalho pesado FORA do caminho da resposta. Fábrica, não promessa: se
    // o runtime não tiver waitUntil, o dreno NÃO pode já ter começado.
    const agendado = agendar(
      () =>
        drenarFila(cache, criarFetchOrder(cache)).then(d => {
          console.info(
            `[ml-notif] dreno processados=${d.processados} novos=${d.novos} ` +
            `atualizados=${d.atualizados} falhas=${d.falhas} restantes=${d.restantes}`
          );
        }),
      'ml-notif'
    );

    if (!agendado) {
      // Sem waitUntil NÃO drenamos aqui. Drenar no caminho da resposta
      // estouraria os 500 ms e faria o ML contar entrega falha — trocaríamos
      // um atraso conhecido por reenvios e risco de a callback ser desligada.
      // O evento está na fila e o job `notificacoes` do workflow o processa.
      console.warn('[ml-notif] runtime sem waitUntil: evento fica na fila ate o dreno agendado');
    }

    console.info(
      `[ml-notif] enfileirada pedido=${r.orderId} fila=${r.fila} ` +
      `dreno=${agendado ? 'agendado' : 'adiado'} ackMs=${Date.now() - inicioMs}`
    );
    return json(res, 200, { ok: true });
  } catch (e) {
    // Erro nosso: 500 faz o ML reenviar, que é o comportamento desejado — o
    // evento ainda não foi enfileirado.
    console.error('[ml-notif]', e instanceof Error ? e.message : e);
    return json(res, 500, { error: 'erro_interno' });
  }
}
