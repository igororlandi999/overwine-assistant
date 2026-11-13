/**
 * Contrato da API v3 do Bling usado por este backend.
 *
 * Fontes oficiais conferidas em 13/11/2026:
 *  - Referência OpenAPI (developer.bling.com.br/referencia, arquivo openapi-CR5QY_N1.json)
 *  - Guia "Aplicativos" (fluxo OAuth 2.0, tokens, refresh, revogação)
 *  - Guia "Limites" (3 req/s, 120.000 req/dia, bloqueios por IP)
 *  - Guia "Migração para autenticação JWT" (cabeçalho enable-jwt: 1)
 *
 * Divergências que permanecem na documentação oficial (validar na primeira
 * autorização real; trocar aqui é a única alteração necessária):
 *  - tokenUrl: a OpenAPI declara https://bling.com.br/Api/v3/oauth/token; o
 *    guia "Aplicativos" (texto e exemplo cURL) usa
 *    https://api.bling.com.br/Api/v3/oauth/token; o guia de migração JWT tem
 *    um exemplo cURL em https://api.bling.com.br/oauth/token (sem /Api/v3).
 *    Adotado: o do guia "Aplicativos", mesmo host da API e mesmo prefixo
 *    /Api/v3 da OpenAPI (é o único que concorda com as duas outras fontes em
 *    pelo menos um dos dois pontos).
 *  - authorizationUrl: a OpenAPI e a URL de exemplo do guia usam
 *    https://bling.com.br/Api/v3/oauth/authorize; o bloco HTTP do mesmo guia
 *    mostra Host www.bling.com.br. Adotado: bling.com.br (duas fontes).
 *  - Revogação (/oauth/revoke, sem /Api/v3) não é usada neste PR.
 */

/** Base de todas as leituras. */
export const BLING_API_BASE = 'https://api.bling.com.br/Api/v3';

/** Tela de consentimento (o navegador do usuário vai até aqui). */
export const BLING_AUTHORIZE_URL = 'https://bling.com.br/Api/v3/oauth/authorize';

/** Troca de code e renovação de tokens (somente servidor). */
export const BLING_TOKEN_URL = 'https://api.bling.com.br/Api/v3/oauth/token';

/**
 * Pede tokens e respostas no modelo JWT. O token opaco foi descontinuado; o
 * cabeçalho vai na troca de code, no refresh e em toda chamada à API.
 */
export const HEADER_JWT = { 'enable-jwt': '1' } as const;

/** O authorization code expira em 30 s: a troca precisa ser imediata. */
export const CODE_TTL_S = 30;

/** Validade documentada do refresh token. */
export const REFRESH_TTL_S = 30 * 24 * 3600;

/** expires_in de exemplo na documentação (6 h); usado só se a resposta omitir. */
export const ACCESS_TTL_PADRAO_S = 21600;

/** Limites por conta (todos os endpoints somados). */
export const LIMITE_POR_SEGUNDO = 3;
export const LIMITE_POR_DIA = 120_000;

/**
 * Bloqueio por IP: mais de 20 requisições a /oauth/token em 60 s bloqueia o IP
 * por 60 min. Nosso teto local fica bem abaixo disso.
 */
export const LIMITE_TOKEN_POR_MINUTO_BLING = 20;

/** Máximo de idsProdutos[] por chamada de saldos (documentado com multiempresa). */
export const MAX_IDS_SALDO = 100;

/** Máximo de itens por página nas listagens (padrão documentado de /produtos). */
export const LIMITE_PAGINA = 100;
