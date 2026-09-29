# Roteiro de navegador e prévia local

Dashboard **real** (o `index.html` do repositório `ml-dashboard-overwine`),
handlers **reais** deste backend e Mercado Livre **simulado**. Nenhum dado
real, nenhuma credencial, nenhuma chamada a produção.

| arquivo | o que é |
|---|---|
| `ambiente.ts` | as duas lojas simuladas, o Mercado Livre simulado e o servidor local |
| `contas.e2e.ts` | o roteiro automatizado dos seletores e da consolidação |
| `previa.ts` | servidor para revisão visual, com a faixa "DADOS SIMULADOS" |
| `vitest.config.ts` | mantém o roteiro fora de `npm test` |

## Preparar (uma vez)

```
cd e2e
npm install
npx playwright install chromium
```

O Playwright fica em `e2e/node_modules`, fora das dependências do backend. Se
já houver uma instalação em outro lugar, aponte para ela:
`PLAYWRIGHT_DIR=<pasta>/node_modules/playwright`.

## Rodar o roteiro

```
npm run e2e
```

Leva cerca de 2 minutos: o cooldown do refresh é o real. Saída em `e2e/saida/`
(`relato.txt` e as telas), que não é versionada.

Variáveis:

| variável | padrão | para quê |
|---|---|---|
| `DASHBOARD_HTML` | `../ml-dashboard-overwine/index.html` | qual dashboard servir |
| `PLAYWRIGHT_DIR` | `playwright` | instalação do Playwright |
| `E2E_PORTA` | `5517` | porta do servidor do roteiro |
| `E2E_SAIDA` | `e2e/saida` | onde gravar relato e telas |

## Prévia para revisão visual

```
npm run previa
```

Abre em `http://127.0.0.1:5600/`. A senha aparece no terminal. Toda página
leva uma faixa vermelha fixa dizendo que os dados são simulados.

## As lojas simuladas

| | Overwine (simulada) | Degustar (simulada) |
|---|---|---|
| pedidos pagos | 120 de R$ 300, um a cada 8 h | 21 de R$ 100, um a cada 36 h |
| ids dos pedidos | 100000–199999 | 200000–299999 |
| cancelados | 4 | 2 |
| anúncio | `MLB1000001`, saldo 40 | `MLB2000001`, saldo 8 |
| SKU e título | `21003`, Arcos do Convento BIB | **os mesmos** |
| visitas por dia | 200 | 30 |
| reputação | Verde | Verde Claro |
| tarifa e frete | estimados pela tabela dela | reais nos 12 pedidos mais novos (R$ 12 e R$ 9,50); ausentes nos demais |

O mesmo SKU e o mesmo título nas duas é de propósito: é o caso real, e é onde
um custo ou uma margem vazaria de uma empresa para a outra.

O Mercado Livre simulado reconhece o vendedor pelo **token** e recusa (403) a
consulta que nomeie um vendedor diferente do dono do token. É a prova de que o
backend nunca consulta uma loja com a credencial da outra.

## O que o roteiro verifica

1. Overwine sozinha: nenhuma requisição ganha `conta`/`contas`.
2. Degustar: só os pedidos dela, todos marcados.
3. Nenhum pedido na conta errada, nenhum repetido.
4. Consolidado: soma das bases, ticket médio recalculado, SKU por empresa.
5. Trocas rápidas de conta e período: o estado final é só o da última seleção.
6. Atualização automática por conta, e a Overwine com o corpo `{}` de sempre.
7. Financeiro: tarifa e frete reais com cobertura completa; subtotal rotulado
   com cobertura parcial; nenhum percentual da Overwine fora da Overwine.
