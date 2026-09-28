/**
 * Registro de contas (src/config/contas.ts) — etapa 0 do plano multi-conta.
 *
 * O que estes testes travam: a conta legada é a única ativa e a única sem
 * prefixo; conta ausente cai na legada (compatibilidade da transição); conta
 * presente e inválida NUNCA cai na legada; a flag desligada bloqueia tudo que
 * não seja a legada; ações aceitam uma conta só.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  listarContas, contaLegada, contaPorId, multiContaHabilitada,
  resolverContasDeLeitura, resolverContaUnicaDeLeitura, resolverContaDeAcao, contaPorMlUserId, mlUserIdDaConta,
  validarContaParaUso, ContaInvalidaError, erroContaParaHttp, type Conta,
} from '../src/config/contas.js';

const envOriginal = { ...process.env };
beforeEach(() => { delete process.env.MULTI_CONTA_ENABLED; process.env.ML_USER_ID = '2329718196'; });
afterEach(() => { process.env = { ...envOriginal }; });

describe('registro', () => {
  it('exatamente uma conta legada, ativa, sem prefixo: Overwine no Mercado Livre', () => {
    const legadas = listarContas().filter(c => c.legada);
    expect(legadas).toHaveLength(1);
    expect(legadas[0]).toMatchObject({ id: 'overwine-ml', canal: 'ml', ativo: true, prefixo: '' });
    expect(contaLegada().id).toBe('overwine-ml');
  });

  it('toda conta nova nasce inativa e com prefixo proprio terminado em ":"', () => {
    for (const c of listarContas().filter(c => !c.legada)) {
      expect(c.ativo).toBe(false);
      expect(c.prefixo).toMatch(/^c:[a-z0-9-]+:$/);
      expect(c.prefixo).toContain(c.id);
    }
  });

  it('as contas da primeira entrega estao declaradas (inativas ate a etapa correspondente)', () => {
    expect(contaPorId('degustar-ml')).toMatchObject({ empresa: 'degustar', canal: 'ml', ativo: false });
    expect(contaPorId('alemmar-amazon')).toMatchObject({ empresa: 'alemmar', canal: 'amazon', ativo: false });
    expect(contaPorId('alemmar-amazon')!.amazon!.marketplaceId).toBe('A2Q3Y263D00KWC');
  });

  it('o registro nao contem segredo: credenciais sao referenciadas por NOME de variavel', () => {
    const texto = JSON.stringify(listarContas());
    expect(texto).not.toMatch(/APP_USR|TG-|refresh_token|secret/i);
    expect(contaLegada().ml!.userIdEnv).toBe('ML_USER_ID');
  });

  it('o user_id do ML vem da variavel, nunca do JSON', () => {
    expect(mlUserIdDaConta(contaLegada())).toBe('2329718196');
    process.env.ML_USER_ID = 'abc';
    expect(() => mlUserIdDaConta(contaLegada())).toThrow(/ML_USER_ID/);
  });
});

describe('leitura — contas=', () => {
  it('ausente, vazio ou so virgulas → [legada]', () => {
    for (const v of [undefined, null, '', ' , ', []]) {
      expect(resolverContasDeLeitura(v).map(c => c.id)).toEqual(['overwine-ml']);
    }
  });

  it('legada explicita → a mesma lista que a ausente (compatibilidade)', () => {
    expect(resolverContasDeLeitura('overwine-ml').map(c => c.id)).toEqual(['overwine-ml']);
    expect(resolverContasDeLeitura(['overwine-ml']).map(c => c.id)).toEqual(['overwine-ml']);
    expect(resolverContasDeLeitura('overwine-ml,overwine-ml').map(c => c.id)).toEqual(['overwine-ml']);
  });

  it('conta desconhecida → conta_invalida, e NUNCA a legada', () => {
    const e = tentar(() => resolverContasDeLeitura('nao-existe'));
    expect(e).toMatchObject({ motivo: 'conta_invalida', conta: 'nao-existe' });
    expect(tentar(() => resolverContasDeLeitura('overwine-ml,nao-existe'))!.motivo).toBe('conta_invalida');
  });

  it('conta inativa → conta_inativa, com a flag ligada ou desligada', () => {
    expect(tentar(() => resolverContasDeLeitura('degustar-ml'))!.motivo).toBe('conta_inativa');
    process.env.MULTI_CONTA_ENABLED = 'true';
    expect(tentar(() => resolverContasDeLeitura('degustar-ml'))!.motivo).toBe('conta_inativa');
  });

  it('flag desligada (padrao): nenhuma conta alem da legada passa', () => {
    expect(multiContaHabilitada()).toBe(false);
    // Hoje toda conta nao legada esta inativa, entao o motivo e conta_inativa;
    // `conta_nao_habilitada` so e alcancavel quando uma conta nova for ativada
    // com a flag ainda desligada — e a etapa 1 tera o teste correspondente.
    for (const id of ['alemmar-amazon', 'degustar-ml', 'alemmar-shopee']) {
      expect(tentar(() => resolverContasDeLeitura(id))).not.toBeNull();
    }
  });

  it('valor de tipo inesperado (objeto, numero) → conta_invalida', () => {
    expect(tentar(() => resolverContasDeLeitura(42))!.motivo).toBe('conta_invalida');
    expect(tentar(() => resolverContasDeLeitura({ a: 1 }))!.motivo).toBe('conta_invalida');
  });
});

describe('leitura de UMA conta — nunca a primeira da lista em silencio', () => {
  it('lista com mais de uma conta e recusada; repetida conta como uma; ausente e a legada', () => {
    expect(tentar(() => resolverContaUnicaDeLeitura('overwine-ml,degustar-ml'))).not.toBeNull();
    process.env.MULTI_CONTA_ENABLED = 'true';
    expect(tentar(() => resolverContaUnicaDeLeitura('overwine-ml,degustar-ml'))).not.toBeNull();
    expect(resolverContaUnicaDeLeitura('overwine-ml,overwine-ml').id).toBe('overwine-ml');
    expect(resolverContaUnicaDeLeitura(undefined).id).toBe('overwine-ml');
  });
});

describe('conta so pode ser usada com suporte completo (validarContaParaUso)', () => {
  const fabricada = (over: Partial<Conta>): Conta => ({
    id: 'x-teste', empresa: 'x', empresaRotulo: 'X', canal: 'ml', canalRotulo: 'ML', rotulo: 'X',
    ativo: true, legada: false, prefixo: 'c:x-teste:', ml: { userIdEnv: 'ML_X_TESTE_USER_ID' }, ...over,
  });
  it('ativa mas flag desligada → conta_nao_habilitada', () => {
    process.env.ML_X_TESTE_USER_ID = '42';
    expect(tentar(() => validarContaParaUso(fabricada({})))!.motivo).toBe('conta_nao_habilitada');
  });
  it('flag ligada, canal sem adaptador (amazon) → conta_sem_suporte', () => {
    process.env.MULTI_CONTA_ENABLED = 'true';
    expect(tentar(() => validarContaParaUso(fabricada({ canal: 'amazon', ml: undefined, amazon: { marketplaceId: 'A2Q3Y263D00KWC', credenciaisEnv: 'AMZ_X' } })))!.motivo).toBe('conta_sem_suporte');
  });
  it('flag ligada, ML sem a variavel de user_id → conta_sem_credencial', () => {
    process.env.MULTI_CONTA_ENABLED = 'true';
    delete process.env.ML_X_TESTE_USER_ID;
    expect(tentar(() => validarContaParaUso(fabricada({})))!.motivo).toBe('conta_sem_credencial');
  });
  it('flag ligada, ML com credencial → passa', () => {
    process.env.MULTI_CONTA_ENABLED = 'true';
    process.env.ML_X_TESTE_USER_ID = '42';
    expect(validarContaParaUso(fabricada({})).id).toBe('x-teste');
  });
  it('a legada passa com a flag desligada, e exige a variavel ML_USER_ID', () => {
    expect(validarContaParaUso(contaLegada()).id).toBe('overwine-ml');
    delete process.env.ML_USER_ID;
    expect(tentar(() => validarContaParaUso(contaLegada()))!.motivo).toBe('conta_sem_credencial');
  });
});

describe('acao — conta=', () => {
  it('ausente → legada (o dashboard, o Actions e os scripts atuais nao enviam conta)', () => {
    expect(resolverContaDeAcao(undefined).id).toBe('overwine-ml');
  });
  it('lista → conta_unica: uma acao nunca e sobre varias contas', () => {
    expect(tentar(() => resolverContaDeAcao('overwine-ml,degustar-ml'))!.motivo).toBe('conta_unica');
  });
  it('invalida → erro, nunca legada', () => {
    expect(tentar(() => resolverContaDeAcao('xpto'))!.motivo).toBe('conta_invalida');
    expect(tentar(() => resolverContaDeAcao('degustar-ml'))!.motivo).toBe('conta_inativa');
  });
});

describe('webhook — conta por user_id do ML', () => {
  it('user_id da legada resolve; qualquer outro nao resolve (conta inativa nao vale)', () => {
    expect(contaPorMlUserId('2329718196')!.id).toBe('overwine-ml');
    expect(contaPorMlUserId(2329718196)!.id).toBe('overwine-ml');
    process.env.ML_DEGUSTAR_USER_ID = '111';
    expect(contaPorMlUserId('111')).toBeNull();   // degustar-ml esta inativa
    expect(contaPorMlUserId('999')).toBeNull();
  });
});

describe('erro para HTTP', () => {
  it('corpo minimo, id truncado, sem detalhe interno', () => {
    const e = new ContaInvalidaError('conta_invalida', 'x'.repeat(200));
    const b = erroContaParaHttp(e);
    expect(b.error).toBe('conta_invalida');
    expect(b.conta.length).toBe(80);
  });
});

function tentar(fn: () => unknown): ContaInvalidaError | null {
  try { fn(); return null; } catch (e) { return e instanceof ContaInvalidaError ? e : null; }
}
