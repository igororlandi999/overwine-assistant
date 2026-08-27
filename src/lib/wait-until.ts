/**
 * wait-until — permite responder ao cliente ANTES de terminar o trabalho.
 *
 * Existe por causa de UM requisito externo: o Mercado Livre espera HTTP 200 de
 * uma notificação em até 500 ms e trata uma resposta mais lenta como entrega
 * falha (reenvio, e a callback pode ser desabilitada depois de muitas). Buscar
 * o pedido na API e publicar o manifesto leva mais que isso.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O MECANISMO É O `waitUntil` PÚBLICO DA VERCEL
 *
 * Uma versão anterior deste arquivo lia o contexto de requisição direto de
 * `Symbol.for('@vercel/request-context')` para não acrescentar dependência.
 * Isso é API interna: nada garante o formato entre versões do runtime, e uma
 * mudança silenciosa ali derrubaria justamente o caminho de tempo real dos
 * pedidos — que quebra sem barulho, porque o ACK continuaria respondendo 200.
 * Não é lugar para economizar uma dependência.
 *
 * Agora usamos `waitUntil` de `@vercel/functions`, que é o que a documentação
 * da Vercel manda usar para continuar processando depois de responder.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O TRABALHO SEMPRE COMEÇA; O `waitUntil` SÓ IMPEDE O CONGELAMENTO
 *
 * A API pública recebe uma PROMESSA, não uma fábrica — então o trabalho já
 * começou quando pedimos a extensão. `waitUntil` não dispara nada: ele pede ao
 * runtime que não congele a instância antes de a promessa terminar.
 *
 * Corolário para a observabilidade: a função devolve `void` e não informa se a
 * extensão foi aceita; `getContext` não é exportado pelo pacote, então não há
 * como perguntar "este runtime tem waitUntil?" pela API pública. Não fingimos
 * saber. O que registramos é QUANDO pedimos (na rota) e QUANDO o trabalho
 * terminou (no dreno). Se o primeiro avança, o segundo não, e a fila fica
 * pendente, então o trabalho de fundo não está sobrevivendo — uma medida do
 * resultado real, melhor que uma sonda de capacidade.
 */
import { waitUntil } from '@vercel/functions';

/**
 * Pede ao runtime que mantenha a função viva até `trabalho` terminar.
 *
 * NUNCA lança. Quem chama está no caminho da resposta de uma notificação do
 * Mercado Livre: uma exceção aqui viraria HTTP 500 e um reenvio, para um
 * trabalho que já está rodando de qualquer forma.
 *
 * Uma rejeição de `trabalho` também nunca escapa: o cliente já recebeu a
 * resposta e não há para quem propagar, então vira log. Sem este `catch` a
 * rejeição ficaria sem tratamento.
 */
export function agendarEmSegundoPlano(trabalho: Promise<unknown>, etiqueta: string): void {
  const seguro = trabalho.catch((e: unknown) => {
    console.error(`[${etiqueta}]`, e instanceof Error ? e.message : e);
  });
  try {
    waitUntil(seguro);
  } catch (e) {
    // O trabalho continua rodando; só não temos a garantia de que a instância
    // fica viva até o fim. A reconciliação periódica cobre o que não terminar.
    console.error(`[${etiqueta}] waitUntil recusou o agendamento`, e instanceof Error ? e.message : e);
  }
}
