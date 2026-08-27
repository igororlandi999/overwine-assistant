# overwine-assistant

Backend da Overwine: camada de serviços entre o Mercado Livre e os consumidores
(dashboard, assistente e futuras integrações). Nenhuma credencial do ML sai
deste backend — o navegador nunca recebe tokens.

A regra que organiza o projeto: **quem lê, lê snapshot; quem escreve snapshot,
fala com o Mercado Livre.** As rotas de leitura nunca chamam a API do ML, e por
isso abrem rápido, não estouram rate limit e servem o mesmo número para todos os
consumidores.

## Endpoints (10 funções Vercel)

### Leitura — só sessão, nunca chamam o Mercado Livre

| Rota | Método | Função |
|---|---|---|
| `/api/orders/status?alvo=ativos\|cancelados` | GET | cobertura do snapshot de pedidos |
| `/api/orders/list?alvo=&cursor=&pageSize=` | GET | pedidos paginados por cursor |
| `/api/orders/metrics?dias=\|from=&to=` | GET | agregados do período (sem pedido bruto) |
| `/api/orders/margin?dias=\|from=&to=` | GET | margem do período, total e por SKU |
| `/api/orders/logistics` | GET | mapa envio → tipo de logística, agrupado |
| `/api/items/inventory?dias=&modo=&escopo=` | GET | estoque próprio × Full, deduplicado |

`margin` existe para que só haja UMA resposta para "qual foi a margem": o
dashboard tinha uma segunda conta que ignorava frete, embalagem e kits e
reportava ~6 pontos percentuais a mais. Não inclui publicidade — o corpo declara
`antesDePublicidade: true` e o consumidor subtrai por cima.

`inventory` expõe o `inventory.service`: dedup de saldo físico entre o anúncio
próprio e o espelho Full, classificação por velocidade de venda (ruptura,
alerta, ok, excesso, sem venda). Modo padrão `seguro` (saldo negativo
normalizado); `modo=legado` reproduz o dashboard antigo.

Atenção ao período: **em `inventory`, `dias=N` são N dias civis terminando
hoje**, e não os N+1 de `metrics` e `margin`. As rotas de vendas mantêm a
paridade com o dashboard legado; estoque não tem esse legado e usa a mesma
janela que o assistente, para que a mesma pergunta não receba duas velocidades
diferentes. A resposta declara `periodo.dias`.

### Leitura com reconstrução

| Rota | Método | Função |
|---|---|---|
| `/api/items/catalog` | GET | catálogo de anúncios (snapshot) |
| `/api/items/catalog?refresh=1` | GET | reconstrução explícita, com cooldown e lock |

Um catálogo incompleto **nunca** é publicado nem devolvido: se a reconstrução
falha, serve o snapshot completo anterior com `source: 'fallback_stale'`.

### Escrita de snapshot — `X-Admin-Key`, chamam o Mercado Livre

| Rota | Método | Função |
|---|---|---|
| `/api/admin/orders-sync` | POST | um passo retomável do snapshot de pedidos |
| `/api/admin/orders-sync` `{"acao":"drenar"}` | POST | drena a fila de notificações |
| `/api/admin/shipping-sync` | POST | resolve logística e frete real por envio |
| `/api/admin/seed` | POST | semeia a cadeia de tokens (`SEED_ENABLED=false` bloqueia) |

Os passos de sincronização são **retomáveis**: processam um lote por invocação e
devolvem o ponto de retomada. Quem os chama de hora em hora é o GitHub Actions
(`.github/workflows/orders-sync.yml`), não o Vercel Cron — o projeto fica no
plano gratuito de propósito.

### Notificações do Mercado Livre — sem sessão, segredo na URL

| Rota | Método | Função |
|---|---|---|
| `/api/notifications/ml?k=<segredo>` | POST | callback de notificações do ML |

### Sessão, proxy e diagnóstico

| Rota | Método | Auth | Função |
|---|---|---|---|
| `/api/health` | GET | — (detalhe com `X-Admin-Key`) | `{ ok: true }` |
| `/api/auth/login` | POST | senha | cria sessão opaca `sess_...` (12h deslizante, máx 24h) |
| `/api/auth/logout` | POST | Bearer sess | destrói a sessão |
| `/api/auth/session` | GET | Bearer sess | valida e renova a sessão |
| `/api/chat` | POST | Bearer sess | assistente de vendas |
| `/api/ml/<op>` | GET/POST/DELETE | Bearer sess | proxy com allowlist (19 operações) |

## Pedidos em tempo real

**A varredura de hora em hora deixou de ser o caminho de atualização e virou
reconciliação.** O caminho normal agora é:

```
venda no Mercado Livre
  → notificação (tópico orders_v2) em POST /api/notifications/ml
  → validação + fila no Redis, com HTTP 200 em poucas dezenas de ms
  → dreno: GET /orders/{id} com o token do backend
  → toSlim → upsert de UM pedido → manifesto novo
  → o dashboard vê a versão nova no próximo poll
```

Latência ponta a ponta: **poucos segundos no backend**, mais o poll de 45 s do
dashboard. Antes eram até 60 minutos de cron mais até 30 minutos de refresh.

### O upsert é incremental de verdade

O manifesto lista as chaves dos chunks explicitamente, então a versão nova
**reusa as chaves dos chunks que não mudaram** e aponta para uma chave nova só
no chunk tocado. Uma venda custa 1 GET + 1 SET, não a reescrita dos ~8 chunks
do histórico.

O preço disso é que os chunks deixam de ter tamanho uniforme. Por isso o
manifesto passou a declarar `chunkCounts`, e a paginação anda pelos tamanhos
reais em vez de derivar a posição de `chunkSize`. Manifesto antigo, sem o campo,
continua sendo lido pela conta antiga.

### O orçamento de 500 ms é inviolável

Nada no caminho da resposta chama a API do ML, lê chunk ou publica manifesto —
nem como exceção. Se o runtime não oferecer `waitUntil`, o evento **fica na
fila** e o job `notificacoes` do workflow o processa; drenar ali estouraria os
500 ms e faria o ML contar entrega falha, trocando um atraso conhecido por
reenvios e risco de a callback ser desligada. `tempoReal.waitUntilDisponivel`
denuncia esse estado em vez de deixá-lo virar "às vezes o pedido demora".

### Idempotência

O evento carrega **só o id do pedido**. O estado vem sempre de uma busca nova em
`GET /orders/{id}`. Daí saem as duas garantias: o mesmo evento duas vezes não
duplica nada (na segunda o pedido está idêntico e nem publicamos versão nova), e
um evento fora de ordem não regride estado, porque o conteúdo do evento nunca é
aplicado. A deduplicação por `_id` da notificação é economia de chamada, não a
garantia de correção.

O upsert segura o **mesmo lock** da sincronização periódica. Lock ocupado não é
erro: os eventos ficam na fila para o próximo dreno.

### Reconciliação continua existindo

O workflow de hora em hora não mudou de papel — mudou de nome. Ele recupera
notificação que nunca chegou, mudança de status fora da janela de eventos e
qualquer inconsistência; e republica o snapshot em chunks uniformes. Um job novo
(`notificacoes`) drena a fila ao final, para o caso de o dreno em tempo real ter
esbarrado no lock ou falhado.

### O que precisa ser configurado no painel do Mercado Livre

Nada disso funciona só com o deploy. É preciso, em
`https://developers.mercadolivre.com.br` → sua aplicação → **Notificações**:

1. **URL de callback**:
   `https://overwine-assistant.vercel.app/api/notifications/ml?k=<ML_WEBHOOK_SECRET>`
2. **Tópico**: marque **somente `orders_v2`**. Ele cobre o ciclo inteiro —
   criação, pagamento, cancelamento, reembolso. `created_orders` é aceito pelo
   backend por compatibilidade, mas nada depende dele: só dispara na criação, e
   marcá-lo sozinho faria a mudança de status parar de chegar.
3. **Variável** `ML_WEBHOOK_SECRET` no projeto Vercel, com o mesmo valor que
   está na URL, mínimo de 16 caracteres.

O ML **não assina** as notificações: não há HMAC, header de assinatura nem lista
de IPs publicada. O segredo na URL é o único mecanismo disponível, e por isso a
URL registrada no painel é uma credencial.

Sobre ele vêm mais três camadas, nenhuma com fonte de verdade nova:

- **`user_id`** conferido contra `ML_USER_ID`;
- **`application_id`** conferido contra `ML_CLIENT_ID` — no Mercado Livre o
  `application_id` da notificação **é** o `client_id` da aplicação, então não há
  variável nova nem valor duplicado;
- o endpoint **nunca acredita no corpo**: do payload só atravessam o id do
  pedido e o `sent` (usado apenas para medir latência). O estado vem sempre de
  um `GET /orders/{id}` novo.

Os dois primeiros usam a mesma regra defensiva: campo **ausente** não reprova (o
corpo do ML varia por tópico e por versão), campo **presente e divergente**
reprova. Nunca degradam para "aceita qualquer coisa": o `resource` ainda precisa
casar com `/orders/{dígitos}` e o segredo da URL já foi conferido antes.

Sem `ML_WEBHOOK_SECRET` o endpoint responde `503 notificacoes_desabilitadas` e
**nada mais muda** — a reconciliação de hora em hora continua sendo a fonte de
atualização, exatamente como antes.

### Observabilidade

`GET /api/orders/status?alvo=ativos` devolve, além do que já devolvia:

- `idadeSegundos` — idade do snapshot publicado;
- `tempoReal.habilitado` — se as notificações estão configuradas;
- `tempoReal.ultimaNotificacaoEm` / `ultimaNotificacaoPedido` / `ultimaNotificacaoTopico`;
- `tempoReal.ultimoPedidoAtualizadoId` / `ultimoPedidoAtualizadoEm` / `ultimaAcao`;
- `tempoReal.ultimaNotificacaoSent` — o `sent` do ML, para medir latência;
- `tempoReal.ultimoAckMs` — milissegundos do caminho da resposta. O ML exige
  HTTP 200 em menos de 500 ms; é aqui que se confere o orçamento;
- `tempoReal.waitUntilDisponivel` — se `false`, o dreno **não** roda junto da
  notificação e a fila espera o job de hora em hora;
- `tempoReal.ultimaVersaoPublicada` — versão publicada pelo último upsert;
- `tempoReal.ultimaLatenciaTotalMs` — do `sent` do ML até a publicação;
- `tempoReal.pendentes` — eventos na fila (persistentemente > 0 é problema);
- `tempoReal.rejeitadas` / `ultimoMotivoRejeicao` / `ultimaRejeicaoEm` — uma
  recusa é invisível do lado do ML, que recebe 200 e considera a entrega boa.
  **`ultimoMotivoRejeicao: 'application_id_divergente'` com `recebidas: 0` é o
  sintoma de `ML_CLIENT_ID` errado**, e é a primeira coisa a conferir se o
  tempo real não der sinal de vida;
- `tempoReal.falhas` / `ultimoErro` / `ultimoErroEm`;
- `lastSyncAt` / `lastResult` — continuam sendo da **reconciliação**, e só dela.

`updatedAt` só avança quando uma versão é publicada. Um `updatedAt` de horas
atrás pode significar "nada vendeu" ou "a atualização parou" — quem separa os
dois é `lastSyncAt` (a reconciliação rodou) junto de `tempoReal`.

## Assistente (`/api/chat`)

Não é um wrapper de prompt em cima do dashboard. O caminho é:

1. `chat-query.service` interpreta a pergunta de forma **determinística** —
   intenção, métrica e período saem de regras, não do modelo;
2. os serviços de vendas, margem e ranking calculam **no backend**;
3. só então um contexto mínimo vai ao provedor de IA, que apenas **redige**.

O modelo nunca escolhe período, nunca soma e nunca decide se um módulo está
disponível. Perguntas fora do que o parser reconhece recebem resposta
determinística, sem ir ao provedor.

Cobre hoje:

- **vendas** — faturamento, pedidos, ticket médio, unidades, margem e ranking de
  produtos, com comparação entre períodos;
- **estoque** — resumo, ruptura, alerta, estoque baixo, consulta por SKU ou por
  nome, Full, estoque próprio, sem venda, excesso, prioridade de reposição e
  inconsistências nos dados.

O estoque usa o mesmo `inventory-read.service` da rota HTTP, sem chamada de rede
interna, e **não depende mais do contexto que o navegador envia**. Duas
convenções valem a pena registrar: "estoque baixo" é a união de ruptura e
alerta, e "prioridade de reposição" é essa mesma união na ordem que o serviço já
produz — sem previsão de demanda e sem quantidade sugerida de compra.

A resolução de produto é determinística: SKU exato, SKU normalizado, título
normalizado exato e, por último, correspondência contida aceita só quando é
única. Vários candidatos viram uma resposta de ambiguidade com a lista; o modelo
nunca escolhe em silêncio.

A classificação de estoque olha UM saldo por vez — o próprio ou o do Full,
conforme o escopo da pergunta — e o contexto declara qual, porque é assim que o
`inventory.service` calcula e inventar uma base nova mudaria os limites.

## Proxy `/api/ml/<op>`

19 operações na allowlist: `items-search`, `items`, `orders`, `order`,
`order-discounts`, `shipment`, `shipment-costs`, `pub-anunciantes`,
`pub-campanhas`, `pub-metricas`, `reputation`, `visits`, `sites-search`,
`product-items`, `promotions`, `promotion-items`, `ads-billing`,
`promotion-item-set` (POST) e `promotion-item-remove` (DELETE).

Cada uma: sessão → zod → limites → `getAccessToken()` interno → ML com Bearer →
resposta filtrada por whitelist de campos (sem PII do comprador além do
nickname).

`orders?status=cancelled` continua no proxy porque os pedidos cancelados
precisam de `cancel_detail`, que não está no `OrderSlim` do snapshot, e porque a
sincronização agendada só cobre o alvo `ativos`.

## Custos e taxas

`src/config/custos.json` e `src/config/taxas.json` são a fonte — ajustar sempre
lá, nunca no código. Desde o Patch O3 o frete **não** é mais um valor por
garrafa: é o custo real do envio, lido do ML e rateado por receita entre os
itens. `logistica.frete` fica em `0` de propósito; qualquer valor diferente
volta a somar frete por cima do frete real.

## Segurança

- Tokens do ML só no Redis/backend. A sessão é um id aleatório sem credencial.
- CORS não é autenticação: toda rota valida a sessão no servidor.
- Lock distribuído com dono aleatório e compare-and-delete atômico (Lua).
- Força bruta: 5 logins/min/IP e bloqueio de 15 min após 10 falhas/h.
- Rate limit: 600 req/min por sessão; seed 3/10min; chat 10/min e 100/dia.
- Logs com IP mascarado, nunca com senha, code ou token.

## Ambientes

São dois projetos Vercel **separados, com Redis separados**: o oficial
(`overwine-assistant`) e o de laboratório (`overwine-assistant-preview`).
Mesmo código, dados independentes. Experimento vai no preview.

**Um push em `main` publica o backend OFICIAL em produção.** O projeto oficial
está conectado a este repositório pelo app do Vercel no GitHub — o commit recebe
um status "Vercel — Deployment has completed" e o deploy sai em segundos. O
projeto de preview NÃO está conectado: ele é publicado à mão. Portanto push aqui
não é "só rodar CI".

## Desenvolvimento

```bash
npm install
npm run typecheck
npm test
```

`.github/workflows/ci.yml` roda esses dois em todo push.
