/**
 * wait-until — permite responder ao cliente ANTES de terminar o trabalho.
 *
 * Existe por causa de UM requisito externo: o Mercado Livre espera HTTP 200 de
 * uma notificação em até 500 ms e trata uma resposta mais lenta como entrega
 * falha (reenvio, e a callback pode ser desabilitada depois de muitas). Buscar
 * o pedido na API e publicar o manifesto leva mais que isso.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE NÃO O PACOTE @vercel/functions
 *
 * `waitUntil` do pacote oficial faz exatamente o que está aqui: lê o contexto
 * de requisição que o runtime da Vercel publica num símbolo global. Este
 * projeto tem duas dependências de runtime, e a função abaixo é literalmente
 * a implementação — não vale uma dependência a mais nem uma linha nova de
 * lockfile.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O QUE ACONTECE QUANDO O RUNTIME NÃO OFERECE waitUntil
 *
 * `agendar` devolve false e QUEM CHAMA decide. Não engolimos o trabalho: no
 * endpoint de notificações, o caminho sem waitUntil é responder 200 na hora e
 * deixar o processamento para os outros dois gatilhos do dreno (o passo de
 * reconciliação e a chamada explícita ao endpoint admin). Perder velocidade é
 * aceitável; perder o evento não seria.
 */

type Trabalho = Promise<unknown>;

interface ContextoRequisicao {
  waitUntil?: (p: Trabalho) => void;
}

const SIMBOLO = Symbol.for('@vercel/request-context');

function contexto(): ContextoRequisicao | null {
  const g = globalThis as Record<symbol, unknown>;
  const holder = g[SIMBOLO] as { get?: () => ContextoRequisicao | undefined } | undefined;
  if (!holder || typeof holder.get !== 'function') return null;
  try {
    return holder.get() ?? null;
  } catch {
    return null;
  }
}

/**
 * Pede ao runtime que mantenha a função viva até o trabalho terminar.
 * Retorna true se o runtime aceitou; false se não há suporte.
 *
 * Recebe uma FÁBRICA, não uma promessa: sem waitUntil o trabalho não pode ter
 * começado, senão quem chama acabaria com duas execuções concorrentes — a que
 * já disparou e a que ele mesmo vai rodar no lugar.
 *
 * Uma rejeição NUNCA sobe daqui: o cliente já recebeu a resposta e não há para
 * quem propagar. O erro vira log.
 */
export function agendar(fabrica: () => Trabalho, etiqueta: string): boolean {
  const ctx = contexto();
  if (!ctx || typeof ctx.waitUntil !== 'function') return false;
  let trabalho: Trabalho;
  try {
    trabalho = fabrica();
  } catch (e) {
    console.error(`[${etiqueta}]`, e instanceof Error ? e.message : e);
    return true; // o trabalho foi tentado; quem chama não deve repeti-lo
  }
  const seguro = trabalho.catch((e: unknown) => {
    console.error(`[${etiqueta}]`, e instanceof Error ? e.message : e);
  });
  try {
    ctx.waitUntil(seguro);
    return true;
  } catch {
    // O runtime anunciou waitUntil mas recusou. O trabalho JÁ ESTÁ rodando e
    // não dá para desfazê-lo; dizemos que foi agendado para quem chama não
    // disparar um segundo em paralelo. Pode não terminar — a reconciliação
    // periódica cobre.
    return true;
  }
}
