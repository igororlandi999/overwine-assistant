/**
 * contas — o registro de CONTAS (empresa × canal) e as regras de resolução.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE EXISTE
 *
 * Até a etapa 0 do plano multi-conta, o backend inteiro conhecia UMA conta:
 * o vendedor Overwine no Mercado Livre, com credenciais em variáveis fixas e
 * chaves Redis sem espaço de nomes. Este módulo introduz a noção de conta
 * sem mudar o comportamento de nada que exista: a conta legada continua a
 * única ativa, com prefixo vazio no Redis, e toda rota que não recebe conta
 * continua atendendo essa mesma conta — de forma EXPLÍCITA e LIMITADA aos
 * consumidores atuais (dashboard, GitHub Actions, scripts de operação).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TRÊS REGRAS QUE NÃO SE NEGOCIAM
 *
 * 1. Conta AUSENTE no pedido = conta legada. É a compatibilidade da transição.
 * 2. Conta PRESENTE e desconhecida, inativa ou não habilitada = ERRO 400. Um
 *    id errado nunca cai na legada em silêncio: seria a receita para uma
 *    conta ler ou escrever os dados de outra.
 * 3. Enquanto MULTI_CONTA_ENABLED não for "true", só a legada é aceita, e só
 *    uma por vez. A flag existe para que o código multi-conta possa ir para
 *    produção desligado, sem exercer nenhum caminho novo.
 *
 * Leituras aceitam LISTA (`contas=a,b`, para a consolidação da etapa 4);
 * ações (refresh, sync, seed, proxy do ML) exigem UMA conta (`conta=a`).
 */
import registro from './contas.json' with { type: 'json' };

export type Canal = 'ml' | 'amazon' | 'shopee' | 'loja';

export interface Conta {
  id: string;
  empresa: string;
  empresaRotulo: string;
  canal: Canal;
  canalRotulo: string;
  rotulo: string;
  ativo: boolean;
  legada: boolean;
  /** Prefixo de toda chave Redis da conta. Vazio SÓ na legada. */
  prefixo: string;
  ml?: { userIdEnv: string };
  amazon?: { marketplaceId: string; credenciaisEnv: string };
}

export type MotivoContaInvalida =
  | 'conta_invalida'            // id desconhecido
  | 'conta_inativa'             // existe no registro, mas ativo: false
  | 'conta_nao_habilitada'      // MULTI_CONTA_ENABLED desligada e não é a legada (ou lista com mais de uma)
  | 'conta_sem_suporte'         // canal sem adaptador implementado (amazon, shopee, loja — etapas 2+)
  | 'conta_sem_credencial'      // conta ML cuja variável de user_id não está configurada
  | 'consolidacao_indisponivel' // leitura com mais de uma conta antes da etapa 4
  | 'conta_unica';              // ação recebeu lista

export class ContaInvalidaError extends Error {
  constructor(public readonly motivo: MotivoContaInvalida, public readonly conta: string) {
    super(`${motivo}: ${conta}`);
    this.name = 'ContaInvalidaError';
  }
}

interface Registro {
  versao: number;
  legada: string;
  contas: Array<Omit<Conta, 'legada' | 'canal'> & { legada?: boolean; canal: string }>;
}

const REG = registro as unknown as Registro;

const CONTAS: readonly Conta[] = REG.contas.map(c => ({
  ...c,
  canal: c.canal as Canal,
  legada: c.legada === true,
}));

function validarRegistro(): void {
  const ids = new Set<string>();
  const prefixos = new Set<string>();
  let legadas = 0;
  for (const c of CONTAS) {
    if (!/^[a-z0-9-]{3,40}$/.test(c.id)) throw new Error(`contas.json: id inválido "${c.id}"`);
    if (ids.has(c.id)) throw new Error(`contas.json: id duplicado "${c.id}"`);
    ids.add(c.id);
    if (prefixos.has(c.prefixo)) throw new Error(`contas.json: prefixo duplicado "${c.prefixo}"`);
    prefixos.add(c.prefixo);
    if (c.legada) legadas++;
    if (c.legada && c.prefixo !== '') throw new Error('contas.json: a conta legada precisa ter prefixo vazio');
    if (!c.legada && c.prefixo === '') throw new Error(`contas.json: "${c.id}" sem prefixo — só a legada pode usar o espaço sem prefixo`);
    if (!c.legada && !c.prefixo.endsWith(':')) throw new Error(`contas.json: prefixo de "${c.id}" precisa terminar em ":"`);
  }
  if (legadas !== 1) throw new Error('contas.json: precisa haver exatamente uma conta legada');
  if (!ids.has(REG.legada)) throw new Error(`contas.json: legada "${REG.legada}" não está na lista`);
}
validarRegistro();

/** Todas as contas do registro, ativas ou não (para painel e diagnóstico). */
export function listarContas(): readonly Conta[] {
  return CONTAS;
}

export function contaLegada(): Conta {
  return CONTAS.find(c => c.legada)!;
}

export function contaPorId(id: string): Conta | null {
  return CONTAS.find(c => c.id === id) ?? null;
}

/** MULTI_CONTA_ENABLED — lida direto do ambiente para não acoplar ao getEnv() de cada rota. */
export function multiContaHabilitada(): boolean {
  return process.env.MULTI_CONTA_ENABLED === 'true';
}

function normalizarLista(param: unknown): string[] | null {
  if (param === undefined || param === null) return null;
  if (Array.isArray(param)) {
    const flat = param.flatMap(p => normalizarLista(p) ?? []);
    return flat.length ? Array.from(new Set(flat)) : null;
  }
  if (typeof param !== 'string') throw new ContaInvalidaError('conta_invalida', String(param));
  const ids = param.split(',').map(s => s.trim()).filter(Boolean);
  return ids.length ? Array.from(new Set(ids)) : null;
}

/**
 * Uma conta só pode ser USADA quando tudo o que ela precisa existe: está
 * ativa, a flag permite, o canal tem adaptador e a credencial está
 * configurada. Qualquer lacuna é erro explícito — nunca um 500 no meio de
 * uma sincronização, nunca a legada por baixo dos panos. Exportada para que
 * o teste exercite os casos com contas fabricadas, já que hoje nenhuma conta
 * não legada está ativa.
 */
export function validarContaParaUso(c: Conta): Conta {
  if (!c.ativo) throw new ContaInvalidaError('conta_inativa', c.id);
  if (!multiContaHabilitada() && !c.legada) throw new ContaInvalidaError('conta_nao_habilitada', c.id);
  if (c.canal !== 'ml') throw new ContaInvalidaError('conta_sem_suporte', c.id);
  if (!c.ml || !process.env[c.ml.userIdEnv]) throw new ContaInvalidaError('conta_sem_credencial', c.id);
  return c;
}

function validarUma(id: string): Conta {
  const c = contaPorId(id);
  if (!c) throw new ContaInvalidaError('conta_invalida', id);
  return validarContaParaUso(c);
}

/**
 * Leitura: `contas` ausente → [legada]; lista → cada id validado. Com a flag
 * desligada, só a legada, e só uma. Lança ContaInvalidaError; a rota traduz
 * para 400.
 */
export function resolverContasDeLeitura(param: unknown): Conta[] {
  const ids = normalizarLista(param);
  if (ids === null) return [contaLegada()];
  const contas = ids.map(validarUma);
  if (!multiContaHabilitada() && contas.length > 1) {
    throw new ContaInvalidaError('conta_nao_habilitada', ids.join(','));
  }
  return contas;
}

/**
 * Leitura de UMA conta: como `resolverContasDeLeitura`, mas uma lista com
 * mais de uma conta é `consolidacao_indisponivel`, com a flag ligada ou não.
 * É o que as rotas de leitura usam até a etapa 4 existir: nenhuma rota pode
 * receber duas contas e responder, em silêncio, só pela primeira.
 */
export function resolverContaUnicaDeLeitura(param: unknown): Conta {
  const contas = resolverContasDeLeitura(param);
  if (contas.length > 1) throw new ContaInvalidaError('consolidacao_indisponivel', contas.map(c => c.id).join(','));
  return contas[0];
}

/**
 * Ação (escrita, sincronização, proxy, semeadura): `conta` ausente → legada
 * (compatibilidade da transição); lista → erro `conta_unica`; id → validado.
 */
export function resolverContaDeAcao(param: unknown): Conta {
  const ids = normalizarLista(param);
  if (ids === null) return contaLegada();
  if (ids.length > 1) throw new ContaInvalidaError('conta_unica', ids.join(','));
  return validarUma(ids[0]);
}

/** Conta ML cujo `user_id` (do ML) é este. `null` se nenhuma conta ativa o tem. */
export function contaPorMlUserId(userId: string | number): Conta | null {
  const alvo = String(userId);
  for (const c of CONTAS) {
    if (!c.ativo || c.canal !== 'ml' || !c.ml) continue;
    const v = process.env[c.ml.userIdEnv];
    if (v && String(v) === alvo) return c;
  }
  return null;
}

/** `user_id` do Mercado Livre da conta, lido da variável de ambiente que ela referencia. */
export function mlUserIdDaConta(conta: Conta): string {
  if (conta.canal !== 'ml' || !conta.ml) throw new Error(`conta ${conta.id} não é do Mercado Livre`);
  const v = process.env[conta.ml.userIdEnv];
  if (!v || !/^\d+$/.test(v)) throw new Error(`variável ${conta.ml.userIdEnv} ausente ou inválida para a conta ${conta.id}`);
  return v;
}

/** Corpo padrão de erro 400 para as rotas. Nunca ecoa mais que o id pedido. */
export function erroContaParaHttp(e: ContaInvalidaError): { error: MotivoContaInvalida; conta: string } {
  return { error: e.motivo, conta: e.conta.slice(0, 80) };
}
