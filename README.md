# overwine-assistant

Backend da Overwine: camada de serviços entre o Mercado Livre e os consumidores
(dashboard, assistente e futuras integrações). Nenhuma credencial do ML sai
deste backend — o navegador nunca recebe tokens.

A regra que organiza o projeto: **quem lê, lê snapshot; quem escreve snapshot,
fala com o Mercado Livre.** As rotas de leitura nunca chamam a API do ML, e por
isso abrem rápido, não estouram rate limit e servem o mesmo número para todos os
consumidores.

## Endpoints (9 funções Vercel)

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
| `/api/admin/shipping-sync` | POST | resolve logística e frete real por envio |
| `/api/admin/seed` | POST | semeia a cadeia de tokens (`SEED_ENABLED=false` bloqueia) |

Os dois primeiros são **retomáveis**: processam um lote por invocação e devolvem
o ponto de retomada. Quem os chama de hora em hora é o GitHub Actions
(`.github/workflows/orders-sync.yml`), não o Vercel Cron — o projeto fica no
plano gratuito de propósito.

### Sessão, proxy e diagnóstico

| Rota | Método | Auth | Função |
|---|---|---|---|
| `/api/health` | GET | — (detalhe com `X-Admin-Key`) | `{ ok: true }` |
| `/api/auth/login` | POST | senha | cria sessão opaca `sess_...` (12h deslizante, máx 24h) |
| `/api/auth/logout` | POST | Bearer sess | destrói a sessão |
| `/api/auth/session` | GET | Bearer sess | valida e renova a sessão |
| `/api/chat` | POST | Bearer sess | assistente de vendas |
| `/api/ml/<op>` | GET/POST/DELETE | Bearer sess | proxy com allowlist (19 operações) |

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
