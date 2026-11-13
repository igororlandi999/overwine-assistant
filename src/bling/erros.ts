/**
 * Erros da integração Bling. As mensagens nunca contêm token, code, client
 * secret nem corpo de resposta: podem ir para log e para o chamador.
 */
export class BlingErro extends Error {
  constructor(msg: string, readonly codigo: string) {
    super(msg);
    this.name = new.target.name;
  }
}

/** Trava BLING_ENABLED desligada: nenhuma chamada foi feita. */
export class BlingDesativadoError extends BlingErro {
  constructor() { super('integração Bling desativada (BLING_ENABLED)', 'bling_desativado'); }
}

/** Variável de ambiente ausente ou inválida. */
export class BlingConfiguracaoError extends BlingErro {
  constructor(msg: string) { super(msg, 'bling_configuracao'); }
}

/**
 * A cadeia de tokens não existe ou foi recusada pelo Bling: é preciso que uma
 * pessoa autorize o aplicativo de novo. Não se resolve com retentativa.
 */
export class BlingAutorizacaoError extends BlingErro {
  constructor(msg: string) { super(msg, 'bling_autorizacao'); }
}

/** Limite atingido (Bling ou teto local). `ate` = quando tentar de novo (epoch ms), se conhecido. */
export class BlingLimiteError extends BlingErro {
  constructor(msg: string, readonly periodo: 'second' | 'day' | 'local_dia' | 'local_token', readonly ate?: number) {
    super(msg, 'bling_limite');
  }
}

/** Resposta HTTP de erro não recuperável (4xx que não 401/429, ou 5xx após as retentativas). */
export class BlingHttpError extends BlingErro {
  constructor(msg: string, readonly status: number, readonly tipo?: string) {
    super(msg, 'bling_http');
  }
}
