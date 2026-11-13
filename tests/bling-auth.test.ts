import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeCache } from './fake-cache.js';
import {
  iniciarAutorizacao, concluirAutorizacao, obterAccessToken, estadoAutorizacao, impressao,
  K, TETO_LOCAL_TOKEN_POR_MINUTO,
} from '../src/bling/auth.js';
import { blingHabilitado } from '../src/bling/config.js';
import {
  BlingAutorizacaoError, BlingConfiguracaoError, BlingDesativadoError, BlingHttpError, BlingLimiteError,
} from '../src/bling/erros.js';
import { ligarBling, limparBling, simular, deps, relogio, TOKEN_URL, cabecalhos, SEGREDO_TESTE } from './bling-simulado.js';

let cache: FakeCache;
beforeEach(() => { cache = new FakeCache(); ligarBling(); });
afterEach(() => { limparBling(); vi.restoreAllMocks(); });

const tokenOk = (extra: object = {}) => ({
  status: 200,
  corpo: { access_token: 'eyJ.access.1', refresh_token: 'rt-1', expires_in: 21600, token_type: 'Bearer', scope: '98309 318257570', ...extra },
});

const cadeia = async () => {
  const raw = await cache.get(K.cadeia);
  return raw ? JSON.parse(raw) as { access: string; expiresAt: number; refresh: string } : null;
};
const gravar = (access: string, expiresAt: number, refresh: string) =>
  cache.set(K.cadeia, JSON.stringify({ access, expiresAt, refresh }));

async function stateValido(): Promise<string> {
  const { url } = await iniciarAutorizacao(cache);
  return new URL(url).searchParams.get('state')!;
}

describe('trava BLING_ENABLED', () => {
  it('desligada por padrão: nenhuma função de autenticação chama a rede', async () => {
    limparBling();
    const s = simular({});
    await expect(iniciarAutorizacao(cache)).rejects.toBeInstanceOf(BlingDesativadoError);
    await expect(obterAccessToken(cache, deps(s.fetch))).rejects.toBeInstanceOf(BlingDesativadoError);
    await expect(concluirAutorizacao(cache, { code: 'x', state: 'y' }, deps(s.fetch))).rejects.toBeInstanceOf(BlingDesativadoError);
    expect(s.chamadas).toHaveLength(0);
  });

  it('desligada mesmo com cadeia gravada: não usa nem renova tokens', async () => {
    await gravar('tok', Date.now() - 1, 'rt');
    limparBling();
    const s = simular({});
    await expect(obterAccessToken(cache, deps(s.fetch))).rejects.toBeInstanceOf(BlingDesativadoError);
    expect(s.chamadas).toHaveLength(0);
  });

  it.each(['TRUE', ' true', 'true ', '1', 'yes', ''])('valor %j não liga a integração', v => {
    process.env.BLING_ENABLED = v;
    expect(blingHabilitado()).toBe(false);
  });

  it('credencial ausente falha antes da rede, citando só o NOME da variável', async () => {
    delete process.env.BLING_CLIENT_SECRET;
    const e = await iniciarAutorizacao(cache).catch((x: any) => x);
    expect(e).toBeInstanceOf(BlingConfiguracaoError);
    expect(e.message).toContain('BLING_CLIENT_SECRET');
    expect(e.message).not.toContain('client-id-ficticio');
  });

  it('BLING_MAX_REQ_DIA inválido é recusado', async () => {
    process.env.BLING_MAX_REQ_DIA = 'muito';
    await expect(iniciarAutorizacao(cache)).rejects.toBeInstanceOf(BlingConfiguracaoError);
  });
});

describe('iniciarAutorizacao', () => {
  it('monta a URL oficial com response_type, client_id e state; sem redirect_uri nem scope', async () => {
    const { url, expiraEmS } = await iniciarAutorizacao(cache);
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://bling.com.br/Api/v3/oauth/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('client-id-ficticio');
    expect(u.searchParams.get('state')).toMatch(/^[a-f0-9]{48}$/);
    expect(u.searchParams.has('redirect_uri')).toBe(false);
    expect(u.searchParams.has('scope')).toBe(false);
    expect(url).not.toContain(SEGREDO_TESTE);
    expect(expiraEmS).toBe(600);
    expect(await cache.get(K.state(u.searchParams.get('state')!))).toBe('1');
  });

  it('cada chamada gera um state diferente', async () => {
    expect(await stateValido()).not.toBe(await stateValido());
  });
});

describe('concluirAutorizacao', () => {
  it('troca o code no endpoint oficial com Basic, Accept 1.0 e enable-jwt; grava a cadeia; não devolve tokens', async () => {
    const state = await stateValido();
    const s = simular({ [TOKEN_URL]: [tokenOk()] });
    const r = await concluirAutorizacao(cache, { code: 'code-ficticio', state }, deps(s.fetch));

    expect(s.chamadas).toHaveLength(1);
    const { url, init } = s.chamadas[0];
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe('POST');
    const h = cabecalhos(init);
    expect(h['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(h.Accept).toBe('1.0');
    expect(h['enable-jwt']).toBe('1');
    expect(h.Authorization).toBe(`Basic ${Buffer.from(`client-id-ficticio:${SEGREDO_TESTE}`).toString('base64')}`);
    const corpo = new URLSearchParams(String(init.body));
    expect(corpo.get('grant_type')).toBe('authorization_code');
    expect(corpo.get('code')).toBe('code-ficticio');
    expect(corpo.has('client_secret')).toBe(false);
    expect(corpo.has('client_id')).toBe(false);

    expect(await cadeia()).toMatchObject({ access: 'eyJ.access.1', refresh: 'rt-1' });
    expect(r.escopos).toEqual(['98309', '318257570']);
    expect(JSON.stringify(r)).not.toMatch(/eyJ|rt-1/);
    expect(await cache.get(K.lock)).toBeNull();
  });

  it('state desconhecido: recusa sem chamar o Bling e sem gravar nada', async () => {
    const s = simular({});
    await expect(concluirAutorizacao(cache, { code: 'c', state: 'a'.repeat(48) }, deps(s.fetch)))
      .rejects.toBeInstanceOf(BlingAutorizacaoError);
    expect(s.chamadas).toHaveLength(0);
    expect(await cadeia()).toBeNull();
  });

  it('state é de uso único: a segunda conclusão com o mesmo state é recusada', async () => {
    const state = await stateValido();
    const s = simular({ [TOKEN_URL]: [tokenOk()] });
    await concluirAutorizacao(cache, { code: 'c1', state }, deps(s.fetch));
    await expect(concluirAutorizacao(cache, { code: 'c2', state }, deps(s.fetch))).rejects.toBeInstanceOf(BlingAutorizacaoError);
    expect(s.chamadas).toHaveLength(1);
  });

  it('state em formato inválido ou ausente é recusado', async () => {
    const s = simular({});
    for (const state of [undefined, 123, '', 'curto', 'G'.repeat(48)]) {
      await expect(concluirAutorizacao(cache, { code: 'c', state }, deps(s.fetch))).rejects.toBeInstanceOf(BlingAutorizacaoError);
    }
    expect(s.chamadas).toHaveLength(0);
  });

  it('code ausente é recusado depois de consumir o state (não reaproveitável)', async () => {
    const state = await stateValido();
    const s = simular({});
    await expect(concluirAutorizacao(cache, { state }, deps(s.fetch))).rejects.toBeInstanceOf(BlingAutorizacaoError);
    expect(await cache.get(K.state(state))).toBeNull();
    expect(s.chamadas).toHaveLength(0);
  });

  it('Bling recusa o code: erro sem o code na mensagem e nada gravado', async () => {
    const state = await stateValido();
    const s = simular({ [TOKEN_URL]: [{ status: 400, corpo: { error: { type: 'invalid_grant', message: 'x', description: 'code expirado' } } }] });
    const e = await concluirAutorizacao(cache, { code: 'code-secreto-expirado', state }, deps(s.fetch)).catch((x: any) => x);
    expect(e).toBeInstanceOf(BlingAutorizacaoError);
    expect(e.message).toContain('invalid_grant');
    expect(e.message).not.toContain('code-secreto-expirado');
    expect(await cadeia()).toBeNull();
  });

  it('resposta sem refresh_token é recusada (cadeia incompleta não é gravada)', async () => {
    const state = await stateValido();
    const s = simular({ [TOKEN_URL]: [{ status: 200, corpo: { access_token: 'a', expires_in: 100 } }] });
    await expect(concluirAutorizacao(cache, { code: 'c', state }, deps(s.fetch))).rejects.toBeInstanceOf(BlingAutorizacaoError);
    expect(await cadeia()).toBeNull();
  });

  it('respeita o lock: com renovação em andamento, não troca o code e não grava', async () => {
    const state = await stateValido();
    await cache.setNX(K.lock, 'outra-instancia', 30);
    const s = simular({});
    const e = await concluirAutorizacao(cache, { code: 'c', state }, deps(s.fetch)).catch((x: any) => x);
    expect(e).toBeInstanceOf(BlingHttpError);
    expect(e.status).toBe(503);
    expect(s.chamadas).toHaveLength(0);
    expect(await cache.get(K.lock)).toBe('outra-instancia');
  });

  it('nova autorização limpa o efeito de uma recusa anterior (impressão diferente)', async () => {
    await gravar('velho', 0, 'rt-recusado');
    await cache.set(K.recusado, impressao('rt-recusado'));
    const state = await stateValido();
    const s = simular({ [TOKEN_URL]: [tokenOk({ refresh_token: 'rt-novo' })] });
    await concluirAutorizacao(cache, { code: 'c', state }, deps(s.fetch));
    expect((await estadoAutorizacao(cache)).autorizado).toBe(true);
  });
});

describe('obterAccessToken', () => {
  it('sem cadeia: pede nova autorização sem chamar o Bling', async () => {
    const s = simular({});
    await expect(obterAccessToken(cache, deps(s.fetch))).rejects.toBeInstanceOf(BlingAutorizacaoError);
    expect(s.chamadas).toHaveLength(0);
  });

  it('cadeia corrompida é tratada como ausente', async () => {
    await cache.set(K.cadeia, '{quebrado');
    const s = simular({});
    await expect(obterAccessToken(cache, deps(s.fetch))).rejects.toBeInstanceOf(BlingAutorizacaoError);
    expect(s.chamadas).toHaveLength(0);
  });

  it('access token em cache e longe de expirar: devolve sem chamar o Bling', async () => {
    const r = relogio();
    await gravar('tok-cache', r.agora() + 3600_000, 'rt');
    const s = simular({});
    expect((await obterAccessToken(cache, deps(s.fetch, r))).token).toBe('tok-cache');
    expect(s.chamadas).toHaveLength(0);
  });

  it('perto de expirar: renova e grava access, validade e refresh rotacionado numa única escrita', async () => {
    const r = relogio();
    await gravar('velho', r.agora() + 60_000, 'rt-antigo');
    const s = simular({ [TOKEN_URL]: [tokenOk({ access_token: 'novo', refresh_token: 'rt-novo' })] });
    const sets = vi.spyOn(cache, 'set');
    const tok = await obterAccessToken(cache, deps(s.fetch, r));
    expect(tok).toEqual({ token: 'novo', expiresAt: r.agora() + 21600_000 });
    const corpo = new URLSearchParams(String(s.chamadas[0].init.body));
    expect(corpo.get('grant_type')).toBe('refresh_token');
    expect(corpo.get('refresh_token')).toBe('rt-antigo');
    expect(cabecalhos(s.chamadas[0].init)['enable-jwt']).toBe('1');
    expect(await cadeia()).toEqual({ access: 'novo', expiresAt: r.agora() + 21600_000, refresh: 'rt-novo' });
    expect(sets.mock.calls.filter(c => c[0] === K.cadeia)).toHaveLength(1);
    expect(await cache.get(K.lock)).toBeNull();
  });

  it('se o Bling não rotacionar o refresh, o atual é mantido', async () => {
    await gravar('a1', 0, 'rt-mantido');
    const s = simular({ [TOKEN_URL]: [{ status: 200, corpo: { access_token: 'a2', expires_in: 21600 } }] });
    await obterAccessToken(cache, deps(s.fetch));
    expect(await cadeia()).toMatchObject({ access: 'a2', refresh: 'rt-mantido' });
  });

  it('falha ao gravar depois do refresh: a cadeia anterior continua inteira (nunca meia cadeia)', async () => {
    await gravar('a1', 0, 'rt-1');
    const antes = await cache.get(K.cadeia);
    const s = simular({ [TOKEN_URL]: [tokenOk({ access_token: 'a2', refresh_token: 'rt-2' })] });
    vi.spyOn(cache, 'set').mockRejectedValueOnce(new Error('redis fora'));
    await expect(obterAccessToken(cache, deps(s.fetch))).rejects.toThrow('redis fora');
    expect(await cache.get(K.cadeia)).toBe(antes);
    expect(await cache.get(K.lock)).toBeNull();
  });

  it('refresh recusado (400): NÃO apaga nada, marca a recusa e as chamadas seguintes falham sem ir ao /oauth/token', async () => {
    await gravar('a1', 0, 'rt-morto');
    const antes = await cache.get(K.cadeia);
    const s = simular({ [TOKEN_URL]: [{ status: 400, corpo: { error: { type: 'invalid_grant' } } }] });
    const e = await obterAccessToken(cache, deps(s.fetch)).catch((x: any) => x);
    expect(e).toBeInstanceOf(BlingAutorizacaoError);
    expect(e.message).not.toContain('rt-morto');
    expect(await cache.get(K.cadeia)).toBe(antes);
    expect(await cache.get(K.recusado)).toBe(impressao('rt-morto'));
    expect(await cache.get(K.recusado)).not.toContain('rt-morto');
    await expect(obterAccessToken(cache, deps(s.fetch))).rejects.toBeInstanceOf(BlingAutorizacaoError);
    expect(s.chamadas).toHaveLength(1);
    expect((await estadoAutorizacao(cache)).reautorizacaoNecessaria).toBe(true);
  });

  it('401 no refresh enquanto outra instância publica cadeia nova: a cadeia nova sobrevive e continua utilizável', async () => {
    const r = relogio();
    await gravar('a1', 0, 'rt-velho');
    const s = simular({ [TOKEN_URL]: [{ status: 401 }] });
    const f = s.fetch;
    // Simula a outra instância publicando uma cadeia nova durante a nossa chamada ao Bling.
    const d = deps((async (u: any, i: any) => {
      await gravar('a-da-outra', r.agora() + 3600_000, 'rt-da-outra');
      return f(u, i);
    }) as typeof fetch, r);
    await expect(obterAccessToken(cache, d)).rejects.toBeInstanceOf(BlingAutorizacaoError);
    expect(await cadeia()).toMatchObject({ access: 'a-da-outra', refresh: 'rt-da-outra' });
    const s2 = simular({});
    expect((await obterAccessToken(cache, deps(s2.fetch, r))).token).toBe('a-da-outra');
    expect((await estadoAutorizacao(cache, r.agora())).autorizado).toBe(true);
  });

  it('renovação concluída depois que outra escrita mudou a cadeia: não sobrescreve a escrita mais nova', async () => {
    const r = relogio();
    await gravar('a1', 0, 'rt-1');
    const s = simular({ [TOKEN_URL]: [tokenOk({ access_token: 'a-nossa', refresh_token: 'rt-nossa' })] });
    const f = s.fetch;
    const d = deps((async (u: any, i: any) => {
      await gravar('a-autorizacao-nova', r.agora() + 3600_000, 'rt-autorizacao-nova');
      return f(u, i);
    }) as typeof fetch, r);
    await obterAccessToken(cache, d);
    expect(await cadeia()).toMatchObject({ refresh: 'rt-autorizacao-nova' });
  });

  it('falha temporária (5xx ou rede) no refresh: mantém a cadeia e não marca recusa', async () => {
    await gravar('a1', 0, 'rt-vivo');
    const s = simular({ [TOKEN_URL]: [{ status: 503 }, new TypeError('fetch failed')] });
    await expect(obterAccessToken(cache, deps(s.fetch))).rejects.toBeInstanceOf(BlingHttpError);
    const e = await obterAccessToken(cache, deps(s.fetch)).catch((x: any) => x);
    expect(e).toBeInstanceOf(BlingHttpError);
    expect(e.message).not.toMatch(/rt-vivo|segredo|Basic/);
    expect(await cadeia()).toMatchObject({ refresh: 'rt-vivo' });
    expect(await cache.get(K.recusado)).toBeNull();
    expect(await cache.get(K.lock)).toBeNull();
  });

  it(`teto local compartilhado: no máximo ${TETO_LOCAL_TOKEN_POR_MINUTO} chamadas a /oauth/token por minuto`, async () => {
    const r = relogio();
    const s = simular({ [TOKEN_URL]: Array.from({ length: 20 }, () => ({ status: 503 })) });
    await gravar('a', 0, 'rt');
    let limite: unknown = null;
    for (let i = 0; i < 15 && !limite; i++) {
      limite = await obterAccessToken(cache, deps(s.fetch, r)).then(() => null, e => (e instanceof BlingLimiteError ? e : null));
    }
    expect(limite).toBeInstanceOf(BlingLimiteError);
    expect(s.chamadas).toHaveLength(TETO_LOCAL_TOKEN_POR_MINUTO);
    // O contador vive no cache (Redis em produção), não na memória da instância.
    const janela = Math.floor(r.agora() / 60_000);
    expect(Number(await cache.get(K.chamadasToken(janela)))).toBeGreaterThan(TETO_LOCAL_TOKEN_POR_MINUTO);
  });

  it('outra instância renovando (lock ocupado): espera e usa o token que ela gravou', async () => {
    const r = relogio();
    await gravar('a', 0, 'rt');
    await cache.setNX(K.lock, 'outra-instancia', 30);
    const s = simular({});
    const d = deps(s.fetch, r);
    d.sleep = async (ms: number) => {
      r.avancar(ms);
      await gravar('da-outra', r.agora() + 3600_000, 'rt2');
    };
    expect((await obterAccessToken(cache, d)).token).toBe('da-outra');
    expect(s.chamadas).toHaveLength(0);
    expect(await cache.get(K.lock)).toBe('outra-instancia');
  });

  it('token rejeitado (401 da API): renova mesmo sem ter expirado', async () => {
    const r = relogio();
    await gravar('tok-rejeitado', r.agora() + 3600_000, 'rt');
    const s = simular({ [TOKEN_URL]: [tokenOk({ access_token: 'tok-novo' })] });
    expect((await obterAccessToken(cache, deps(s.fetch, r), { rejeitado: 'tok-rejeitado' })).token).toBe('tok-novo');
    expect(s.chamadas).toHaveLength(1);
  });

  it('token rejeitado já substituído por outra instância: usa o novo sem chamar o Bling', async () => {
    const r = relogio();
    await gravar('tok-novo-da-outra', r.agora() + 3600_000, 'rt');
    const s = simular({});
    expect((await obterAccessToken(cache, deps(s.fetch, r), { rejeitado: 'tok-velho' })).token).toBe('tok-novo-da-outra');
    expect(s.chamadas).toHaveLength(0);
  });
});

describe('estadoAutorizacao', () => {
  it('não expõe tokens nem a impressão digital', async () => {
    const agora = Date.now();
    await gravar('tok-secreto', agora + 1000, 'rt-secreto');
    const e = await estadoAutorizacao(cache, agora);
    expect(e).toEqual({ autorizado: true, accessValidoAte: new Date(agora + 1000).toISOString(), reautorizacaoNecessaria: false });
    expect(JSON.stringify(e)).not.toMatch(/secreto|[a-f0-9]{16}/);
  });

  it('sem cadeia: reautorização necessária', async () => {
    expect(await estadoAutorizacao(cache)).toEqual({ autorizado: false, accessValidoAte: null, reautorizacaoNecessaria: true });
  });
});
