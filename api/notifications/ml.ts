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
import { agendar } from '../../src/lib/wait-until.js';
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

    const r = await receberNotificacao(cache, lerCorpo(req), env.ML_USER_ID);

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
      // Runtime sem waitUntil. Drenamos UM pedido no caminho da resposta e
      // aceitamos estourar os 500 ms: o ML reenvia, a deduplicação por `_id`
      // torna o reenvio barato, e a alternativa seria o pedido esperar a
      // próxima reconciliação — uma hora, que é exatamente o que esta fase
      // existe para eliminar.
      try {
        const d = await drenarFila(cache, criarFetchOrder(cache), { max: 1 });
        console.info(`[ml-notif] dreno inline processados=${d.processados} restantes=${d.restantes}`);
      } catch (e) {
        console.error('[ml-notif] dreno inline', e instanceof Error ? e.message : e);
      }
    }

    console.info(`[ml-notif] enfileirada pedido=${r.orderId} fila=${r.fila} dreno=${agendado ? 'agendado' : 'inline'}`);
    return json(res, 200, { ok: true });
  } catch (e) {
    // Erro nosso: 500 faz o ML reenviar, que é o comportamento desejado — o
    // evento ainda não foi enfileirado.
    console.error('[ml-notif]', e instanceof Error ? e.message : e);
    return json(res, 500, { error: 'erro_interno' });
  }
}
