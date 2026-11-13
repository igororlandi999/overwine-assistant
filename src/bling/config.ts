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
 *   BLING_ADMIN_KEY      OPCIONAL na transição, recomendada. Chave das ações
 *                        administrativas bling-* (cabeçalho X-Admin-Key),
 *                        separada da ADMIN_KEY dos workflows do GitHub.
 *                        Mínimo de 32 caracteres. Definida: só ela vale nas
 *                        ações bling-* (a ADMIN_KEY passa a receber 403).
 *                        Definida mas curta: as ações bling-* recusam tudo
 *                        (nunca caem de volta para a ADMIN_KEY). Ausente:
 *                        compatibilidade temporária com a ADMIN_KEY.
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

export const MIN_BLING_ADMIN_KEY = 32;

export type OrigemChaveAdmin = 'BLING_ADMIN_KEY' | 'ADMIN_KEY';

/**
 * Qual chave autoriza as ações administrativas bling-*. Devolve o valor
 * só para comparação em tempo constante; o valor nunca vai para log ou
 * resposta, apenas o NOME da origem.
 *
 * - BLING_ADMIN_KEY presente (qualquer valor não vazio): é a única aceita.
 *   Com menos de 32 caracteres (após remover espaços das pontas), ou igual
 *   à ADMIN_KEY, lança BlingConfiguracaoError: a ação falha fechada, sem
 *   recorrer à ADMIN_KEY.
 * - Ausente: compatibilidade temporária com `adminKeyLegada` (ADMIN_KEY).
 */
export function chaveAdminBling(adminKeyLegada: string): { chave: string; origem: OrigemChaveAdmin } {
  const bruto = process.env.BLING_ADMIN_KEY;
  if (bruto === undefined || bruto === '') return { chave: adminKeyLegada, origem: 'ADMIN_KEY' };
  const chave = bruto.trim();
  if (chave.length < MIN_BLING_ADMIN_KEY) {
    throw new BlingConfiguracaoError(`BLING_ADMIN_KEY inválida (mínimo ${MIN_BLING_ADMIN_KEY} caracteres)`);
  }
  // Igual à ADMIN_KEY anularia o isolamento: quem tem a chave dos workflows
  // continuaria administrando o Bling. Falha fechada, como a chave curta.
  if (chave === adminKeyLegada.trim()) {
    throw new BlingConfiguracaoError('BLING_ADMIN_KEY inválida (deve ser diferente da ADMIN_KEY)');
  }
  return { chave, origem: 'BLING_ADMIN_KEY' };
}
