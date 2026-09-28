/**
 * POST /api/orders/refresh — o dashboard pede uma sincronização incremental
 * quando percebe que o snapshot está velho.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE UMA ABA ABERTA PODE PEDIR ISSO
 *
 * Os dois mecanismos de atualização falharam ao mesmo tempo: o agendador do
 * GitHub Actions passou a descartar quase todos os ticks (1 a 2 execuções por
 * dia, contra 24 esperadas) e a notificação do Mercado Livre ainda não
 * autentica. A equipe ficou olhando dado de horas atrás.
 *
 * A aba aberta é o único componente que continua vivo em todos esses cenários.
 * Então ela vira o piso de confiabilidade — não o mecanismo principal, que
 * segue sendo o tempo real, nem a rede de segurança, que segue sendo a
 * reconciliação.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O QUE ESTA ROTA NÃO FAZ
 *
 * Não expõe ADMIN_KEY ao navegador: a autorização é a MESMA sessão do
 * dashboard, igual às rotas de leitura. Não devolve token do Mercado Livre,
 * chave Redis, nome de chunk nem pedido bruto. Não reconstrói o histórico —
 * chama exclusivamente o passo `incremental`, o mesmo que a reconciliação usa.
 * E o navegador continua sem falar com a API do Mercado Livre: quem fala é
 * este backend, com o token que nunca sai daqui.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE AGUARDA O TRABALHO EM VEZ DE AGENDAR EM SEGUNDO PLANO
 *
 * Aqui não existe o orçamento de 500 ms que a callback do Mercado Livre impõe:
 * quem chama é o poll do dashboard, em segundo plano, e nenhum humano está
 * esperando esta resposta. Em troca de alguns segundos ganhamos duas coisas
 * que importam num conserto de confiabilidade: a resposta carrega o RESULTADO
 * real da sincronização (dá para validar a rota sem adivinhar), e o trabalho
 * não depende de o runtime honrar `waitUntil` — coisa que ainda não
 * conseguimos observar funcionando nesta implantação.
 *
 * O passo é limitado por ORDERS_SYNC_MAX_PAGES e é retomável, então mesmo uma
 * invocação interrompida deixa progresso gravado.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getCache } from '../../src/lib/cache/cache.js';
import { resolverContaDeAcao, mlUserIdDaConta, ContaInvalidaError, erroContaParaHttp } from '../../src/config/contas.js';
import { cacheDaConta } from '../../src/lib/cache/conta-cache.js';
import { validateSession } from '../../src/lib/session.js';
import { applyCors, rateLimitOk, readBearer, json } from '../../src/lib/http.js';
import { criarFetchOrdersPage } from '../../src/lib/ml-orders.js';
import { refrescarSeVelho } from '../../src/services/orders-refresh.service.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return; // OPTIONS encerra aqui (204)

  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });

  const cache = getCache();

  try {
    // Sessão obrigatória — mesma regra das rotas de leitura. x-admin-key não
    // vale aqui, e o navegador nunca precisa conhecer a chave de admin.
    const sess = await validateSession(cache, readBearer(req));
    if (!sess) return json(res, 401, { error: 'unauthorized' });

    // Teto por sessão. O cooldown global é quem realmente segura carga; este
    // limite existe só para uma aba com defeito não martelar a rota.
    if (!(await rateLimitOk(cache, `orders-refresh:${sess.id.slice(0, 24)}`, 20, 60))) {
      return json(res, 429, { error: 'rate_limited' });
    }

    // Ação: UMA conta. Ausente = legada (o dashboard atual não envia conta).
    // O lock, o cooldown, o snapshot e o token do ML são os DA CONTA.
    let conta;
    try {
      const corpo = (req.body && typeof req.body === 'object') ? (req.body as { conta?: unknown }) : {};
      conta = resolverContaDeAcao(corpo.conta ?? req.query.conta);
    } catch (e) {
      if (e instanceof ContaInvalidaError) return json(res, 400, erroContaParaHttp(e));
      throw e;
    }
    const cacheDados = cacheDaConta(cache, conta);

    const r = await refrescarSeVelho(cacheDados, criarFetchOrdersPage(cacheDados, mlUserIdDaConta(conta)));

    // Erro da sincronização NÃO vira 5xx: o snapshot anterior continua válido e
    // sendo servido, e o dashboard não deve tratar isso como falha de leitura.
    // Ele volta a pedir na próxima rodada do poll.
    if (r.acao === 'erro') {
      console.error(`[orders-refresh] modo=${r.modo} erro=${r.motivo}`);
      return json(res, 200, { ok: false, acao: 'erro', modo: r.modo, versao: r.versao, conta: conta.id });
    }

    // `versao` vai na resposta de propósito: quando `publicou` é true, o
    // dashboard recarrega na hora em vez de esperar a próxima rodada do poll.
    const detalhe = r.acao === 'sincronizado'
      ? ` modo=${r.modo} publicou=${r.publicou} novos=${r.novosPedidos} atualizados=${r.atualizados} versao=${r.versao} ml=${r.chamadasML} ms=${r.duracaoMs}`
      : '';
    console.info(`[orders-refresh] conta=${conta.id} acao=${r.acao}${detalhe} sessao=${sess.id.slice(0, 8)}`);
    return json(res, 200, { ok: true, ...r, conta: conta.id });
  } catch (e) {
    console.error('[orders-refresh]', e instanceof Error ? e.message : e);
    return json(res, 500, { error: 'erro_interno' });
  }
}
