/**
 * Credenciais de uma conta Amazon, lidas do ambiente pelo NOME base declarado
 * no registro (`amazon.credenciaisEnv`, por exemplo AMZ_ALEMMAR):
 *
 *   <BASE>_LWA_CLIENT_ID      identificador do app (Solution Provider Portal / Seller Central)
 *   <BASE>_LWA_CLIENT_SECRET  segredo do app; a Amazon exige rotação a cada 180 dias
 *   <BASE>_REFRESH_TOKEN      gerado na AUTORIZAÇÃO do app pela conta (self-authorization)
 *   <BASE>_SELLER_ID          token de comerciante (Merchant Token); não é segredo,
 *                             mas identifica a conta nas chamadas de anúncios
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
    marketplaceId: conta.amazon!.marketplaceId,
  };
}
