/**
 * Credenciais de uma conta Amazon, lidas do ambiente pelo NOME base declarado
 * no registro (`amazon.credenciaisEnv`, por exemplo AMZ_ALEMMAR):
 *
 *   <BASE>_LWA_CLIENT_ID      identificador do app (Solution Provider Portal / Seller Central)
 *   <BASE>_LWA_CLIENT_SECRET  segredo do app; a Amazon exige rotação a cada 180 dias
 *   <BASE>_REFRESH_TOKEN      gerado na AUTORIZAÇÃO do app pela conta (self-authorization)
 *   <BASE>_SELLER_ID          token de comerciante (Merchant Token); não é segredo,
 *                             mas identifica a conta nas chamadas de anúncios
 *   <BASE>_ENABLED            TRAVA da integração. Só o valor exato "true" liga a
 *                             conta; ausente ou qualquer outro valor = Amazon inativa,
 *                             mesmo com CONTAS_ATIVAS, MULTI_CONTA_ENABLED e credenciais.
 *   <BASE>_MARKETPLACE_ID     OPCIONAL. Marketplace das chamadas. Ausente = valor do
 *                             registro (contas.json; Brasil A2Q3Y263D00KWC). Presente
 *                             com formato inválido = erro, nunca cai em outro marketplace.
 *
 * Nenhum valor sai deste módulo para resposta HTTP ou log: só a lista de
 * NOMES ausentes, para diagnóstico.
 */
import type { Conta } from '../config/contas.js';

export interface CredenciaisAmazon {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  sellerId: string;
  marketplaceId: string;
}

const SUFIXOS = ['LWA_CLIENT_ID', 'LWA_CLIENT_SECRET', 'REFRESH_TOKEN', 'SELLER_ID'] as const;

export function nomesDasVariaveis(conta: Pick<Conta, 'amazon'>): string[] {
  if (!conta.amazon) return [];
  return SUFIXOS.map(s => `${conta.amazon!.credenciaisEnv}_${s}`);
}

/** Nome da variável de trava da conta (ex.: AMZ_ALEMMAR_ENABLED). */
export function nomeDaTrava(conta: Pick<Conta, 'amazon'>): string | null {
  return conta.amazon ? `${conta.amazon.credenciaisEnv}_ENABLED` : null;
}

/** A trava explícita está ligada? Só o valor exato `"true"` liga; qualquer outro, inclusive com espaços, não. */
export function amazonHabilitada(conta: Pick<Conta, 'amazon'>): boolean {
  const nome = nomeDaTrava(conta);
  return nome !== null && process.env[nome] === 'true';
}

/** Formato de um Marketplace ID da SP-API (ex.: A2Q3Y263D00KWC). */
const FORMATO_MARKETPLACE = /^[A-Z0-9]{10,16}$/;

export interface MarketplaceDaConta { id: string; origem: 'ambiente' | 'registro' }

/**
 * Marketplace efetivo da conta: <BASE>_MARKETPLACE_ID quando definida, senão o
 * do registro. Valor presente mas malformado lança erro só com o NOME da variável.
 */
export function marketplaceDaConta(conta: Pick<Conta, 'id' | 'amazon'>): MarketplaceDaConta {
  if (!conta.amazon) throw new Error(`conta ${conta.id} sem bloco amazon`);
  const nome = `${conta.amazon.credenciaisEnv}_MARKETPLACE_ID`;
  const doAmbiente = (process.env[nome] ?? '').trim();
  if (!doAmbiente) return { id: conta.amazon.marketplaceId, origem: 'registro' };
  if (!FORMATO_MARKETPLACE.test(doAmbiente)) throw new Error(`${nome} com formato inválido para ${conta.id}`);
  return { id: doAmbiente, origem: 'ambiente' };
}

/** Nomes das variáveis que faltam (vazio = todas presentes). */
export function variaveisAusentes(conta: Pick<Conta, 'amazon'>): string[] {
  if (!conta.amazon) return ['amazon (bloco ausente no registro)'];
  return nomesDasVariaveis(conta).filter(n => !(process.env[n] ?? '').trim());
}

export function lerCredenciais(conta: Pick<Conta, 'id' | 'amazon'>): CredenciaisAmazon {
  const faltam = variaveisAusentes(conta);
  if (faltam.length) throw new Error(`credenciais Amazon incompletas para ${conta.id}: ${faltam.join(', ')}`);
  const base = conta.amazon!.credenciaisEnv;
  const v = (s: string) => process.env[`${base}_${s}`]!.trim();
  return {
    clientId: v('LWA_CLIENT_ID'),
    clientSecret: v('LWA_CLIENT_SECRET'),
    refreshToken: v('REFRESH_TOKEN'),
    sellerId: v('SELLER_ID'),
    marketplaceId: marketplaceDaConta(conta).id,
  };
}
