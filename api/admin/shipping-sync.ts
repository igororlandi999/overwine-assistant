/**
 * POST /api/admin/shipping-sync — dispara UM passo de resolução de logística.
 *
 * Proteção idêntica a /api/admin/orders-sync: somente POST, Content-Type JSON,
 * x-admin-key com comparação timing-safe, rate limit por IP, logs com IP
 * mascarado e sem credenciais.
 *
 * Por que este endpoint existe: a API de pedidos do Mercado Livre devolve
 * `shipping.id` mas não `shipping.logistic_type`, e sem esse campo o cálculo de
 * custo soma embalagem em toda venda — inclusive nas do Full, onde o Mercado
 * Livre é quem embala. Ver a nota longa em lib/shipping-store.ts.
 *
 * O passo é RETOMÁVEL: busca no máximo `limite` envios por invocação e devolve
 * `concluido: false` enquanto sobrar. Envio resolvido nunca é buscado de novo.
 *
 * Body opcional: { limite?: number, concorrencia?: number }.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getEnv } from '../../src/config/env.js';
import { getCache } from '../../src/lib/cache/cache.js';
import { mlFetch } from '../../src/lib/ml-auth.js';
import { safeEquals, rateLimitOk, clientIp, maskIp, json } from '../../src/lib/http.js';
import { readSnapshot } from '../../src/lib/orders-store.js';
import { lerMapaEnvios, publicarMapaEnvios, CHAVE_LOCK } from '../../src/lib/shipping-store.js';
import { executarPasso, type BuscarLogistica } from '../../src/services/shipping-logistics.service.js';

/** TTL do lock. Um passo cabe folgado nisso; se estourar, o lock expira só. */
const LOCK_TTL_S = 120;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cache = getCache();
  const ip = clientIp(req);
  let lockToken: string | null = null;

  try {
    const env = getEnv();

    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      return json(res, 415, { error: 'Content-Type deve ser application/json.' });
    }
    if (!(await rateLimitOk(cache, `shipping-sync:${ip}`, 20, 600))) {
      console.warn(`[shipping-sync] rate limit ip=${maskIp(ip)}`);
      return json(res, 429, { error: 'Muitas requisições.' });
    }
    const key = String(req.headers['x-admin-key'] || '');
    if (!key || !safeEquals(key, env.ADMIN_KEY)) {
      console.warn(`[shipping-sync] admin key inválida ip=${maskIp(ip)}`);
      return json(res, 401, { error: 'Não autorizado.' });
    }

    // Lock: dois passos simultâneos leriam o mesmo mapa e o segundo publicaria
    // por cima do primeiro, descartando envios já pagos em chamadas de API.
    lockToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (!(await cache.setNX(CHAVE_LOCK, lockToken, LOCK_TTL_S))) {
      lockToken = null;
      return json(res, 409, { error: 'Outro passo em andamento.', code: 'lock_ocupado' });
    }

    const body = (req.body ?? {}) as { limite?: number; concorrencia?: number };

    const pedidos = await readSnapshot(cache, 'ativos');
    const mapaAtual = await lerMapaEnvios(cache);

    // Busca REAL, injetada. Erro de um envio não derruba o passo: devolver null
    // mantém o id pendente para a próxima rodada. Envio arquivado (404) ou
    // instabilidade momentânea não podem travar o backfill inteiro.
    const buscar: BuscarLogistica = async (shipmentId) => {
      const id = encodeURIComponent(shipmentId);
      // DUAS chamadas: o objeto de envio traz a logística, e /costs traz o que
      // o VENDEDOR pagou — o objeto de envio só expõe preço de tabela e o que o
      // comprador viu, e a diferença entre eles é subsídio do Mercado Livre.
      const [rEnvio, rCusto] = await Promise.all([
        mlFetch(cache, `/shipments/${id}`),
        mlFetch(cache, `/shipments/${id}/costs`),
      ]);
      if (!rEnvio.ok || !rCusto.ok) return null;

      const envio = (await rEnvio.json()) as { logistic_type?: unknown };
      const custos = (await rCusto.json()) as { senders?: unknown };
      if (typeof envio.logistic_type !== 'string' || envio.logistic_type === '') return null;

      // senders[] é o lado do vendedor; pode vir com mais de uma entrada.
      const senders = Array.isArray(custos.senders) ? custos.senders : [];
      let custoFrete = 0;
      for (const s of senders) {
        const c = (s as { cost?: unknown }).cost;
        if (typeof c === 'number' && Number.isFinite(c)) custoFrete += c;
      }
      return { shipmentId, logisticType: envio.logistic_type, custoFrete };
    };

    console.info(`[shipping-sync] passo ip=${maskIp(ip)} pedidos=${pedidos.length} mapa=${mapaAtual.size}`);

    const { mapa, resultado } = await executarPasso(pedidos, mapaAtual, buscar, {
      limite: body.limite,
      concorrencia: body.concorrencia,
    });

    // Só publica se algo mudou. Um passo em que todas as buscas falharam não
    // deve criar versão nova do mapa nem reescrever os chunks.
    if (resultado.resolvidos > 0) await publicarMapaEnvios(cache, mapa);

    console.info(
      `[shipping-sync] fim buscados=${resultado.buscados} resolvidos=${resultado.resolvidos} ` +
      `falhas=${resultado.falhas} restantes=${resultado.restantes} cobertura=${resultado.cobertura.toFixed(3)}`
    );
    return json(res, 200, resultado);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erro interno';
    console.error('[shipping-sync]', msg);
    return json(res, 502, { error: msg });
  } finally {
    if (lockToken !== null) await cache.delIfEquals(CHAVE_LOCK, lockToken);
  }
}