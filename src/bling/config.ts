/**
 * Configuração da integração Bling, lida direto do ambiente (não por getEnv):
 * getEnv() é chamado por praticamente toda rota, e exigir variáveis do Bling
 * ali derrubaria o backend inteiro enquanto a integração não estiver
 * configurada. Mesmo critério da GEMINI_API_KEY e das credenciais Amazon.
 *
 *   BLING_ENABLED        TRAVA da integração. Só o valor exato "true" liga.
 *                        Ausente ou qualquer outro valor = Bling desligado:
 *                        nenhuma chamada sai deste backend para o Bling.
 *   BLING_CLIENT_ID      Client Id do aplicativo (Área do Integrador).
 *   BLING_CLIENT_SECRET  Client Secret do aplicativo. Nunca sai do servidor.
 *   BLING_CNPJ_ESPERADO  OPCIONAL, não é segredo. CNPJ da empresa que PODE
 *                        ser conectada. Presente: autorização de outro CNPJ
 *                        (/empresas/me/dados-basicos) é recusada. Presente
 *                        ou não, toda autorização fica pendente até a
 *                        confirmação de um administrador.
 *   BLING_MAX_REQ_DIA    OPCIONAL. Teto local diário de requisições (padrão
 *                        20.000), bem abaixo das 120.000 da conta, para que
 *                        um erro de código não esgote a cota que o próprio
 *                        Bling usa com outras integrações da conta.
 *
 * Nenhum valor sai deste módulo para resposta HTTP ou log: só NOMES ausentes.
 */
import { BlingDesativadoError, BlingConfiguracaoError } from './erros.js';

export const NOME_TRAVA = 'BLING_ENABLED';
const OBRIGATORIAS = ['BLING_CLIENT_ID', 'BLING_CLIENT_SECRET'] as const;
const MAX_REQ_DIA_PADRAO = 20_000;

export interface ConfigBling {
  clientId: string;
  clientSecret: string;
  maxReqDia: number;
  /** 14 dígitos, ou null quando a validação é manual. */
  cnpjEsperado: string | null;
}

/** Só os dígitos de um CNPJ (aceita com ou sem pontuação). */
export function digitosCnpj(v: string): string {
  return v.replace(/\D/g, '');
}

/** A trava está ligada? Só o valor exato "true" liga. */
export function blingHabilitado(): boolean {
  return process.env[NOME_TRAVA] === 'true';
}

/** Nomes das variáveis obrigatórias ausentes (vazio = todas presentes). */
export function variaveisAusentes(): string[] {
  return OBRIGATORIAS.filter(n => !(process.env[n] ?? '').trim());
}

/**
 * Configuração efetiva. Lança BlingDesativadoError com a trava desligada e
 * BlingConfiguracaoError se faltar credencial: nos dois casos ANTES de
 * qualquer chamada de rede.
 */
export function lerConfigBling(): ConfigBling {
  if (!blingHabilitado()) throw new BlingDesativadoError();
  const faltam = variaveisAusentes();
  if (faltam.length) throw new BlingConfiguracaoError(`credenciais Bling incompletas: ${faltam.join(', ')}`);
  const bruto = (process.env.BLING_MAX_REQ_DIA ?? '').trim();
  const n = bruto ? Number(bruto) : MAX_REQ_DIA_PADRAO;
  if (!Number.isInteger(n) || n <= 0) throw new BlingConfiguracaoError('BLING_MAX_REQ_DIA inválido');
  const cnpjBruto = (process.env.BLING_CNPJ_ESPERADO ?? '').trim();
  const cnpjEsperado = cnpjBruto ? digitosCnpj(cnpjBruto) : null;
  if (cnpjEsperado !== null && cnpjEsperado.length !== 14) throw new BlingConfiguracaoError('BLING_CNPJ_ESPERADO inválido');
  return {
    clientId: process.env.BLING_CLIENT_ID!.trim(),
    clientSecret: process.env.BLING_CLIENT_SECRET!.trim(),
    maxReqDia: n,
    cnpjEsperado,
  };
}
