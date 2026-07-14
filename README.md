# overwine-assistant

Backend BFF da Overwine: sessões + proxy com allowlist para a API do Mercado Livre.
Nenhuma credencial do ML sai deste backend — o navegador nunca recebe tokens.

## Endpoints (4 funções Vercel)
| Rota | Método | Auth | Função |
|---|---|---|---|
| `/api/health` | GET | — (detalhe só com `X-Admin-Key`) | `{ ok: true }` |
| `/api/auth/login` | POST | senha | cria sessão opaca `sess_...` (12h deslizante, máx 24h) |
| `/api/auth/logout` | POST | Bearer sess | destrói sessão |
| `/api/auth/session` | GET | Bearer sess | valida/renova sessão |
| `/api/admin/seed` | POST | `X-Admin-Key` | semeia cadeia de tokens (desativável via `SEED_ENABLED=false`) |
| `/api/ml/<op>` | GET/POST/DELETE | Bearer sess | proxy allowlist (16 operações) |

## Operações do proxy (`/api/ml/<op>`)
items-search, items, orders, order, order-discounts, shipment, reputation,
visits, sites-search, product-items, promotions, promotion-items, ads-billing,
promotion-item-set (POST), promotion-item-remove (DELETE).
Cada uma: sessão → zod → limites → `getAccessToken()` interno → ML com Bearer
→ resposta filtrada por whitelist de campos (sem PII de comprador além do nickname).

## Segurança
- Tokens ML só no Redis/backend. Sessão é ID aleatório sem credencial.
- CORS ≠ autenticação: toda rota valida sessão server-side.
- Lock distribuído com dono aleatório + compare-and-delete atômico (Lua).
- Brute force: 5 logins/min/IP + bloqueio 15 min após 10 falhas/h.
- Rate limit: 600 req/min por sessão; seed 3/10min.
- Logs com IP mascarado, nunca com senha/code/token.

## Desenvolvimento
```bash
npm install && npm test && npm run typecheck
```
