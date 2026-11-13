import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FakeCache } from './fake-cache.js';
import { blingGet, montarUrl } from '../src/bling/cliente.js';
import { K } from '../src/bling/auth.js';
import { BlingAutorizacaoError, BlingDesativadoError, BlingHttpError, BlingLimiteError } from '../src/bling/erros.js';
import { ligarBling, limparBling, simular, deps, relogio, fixture, TOKEN_URL, API, cabecalhos } from './bling-simulado.js';

let cache: FakeCache;
let r: ReturnType<typeof relogio>;

beforeEach(async () => {
  cache = new FakeCache();
  ligarBling();
  r = relogio();
  await cache.set(K.cadeia, JSON.stringify({ access: 'tok-atual', expiresAt: r.agora() + 3600_000, refresh: 'rt-atual', geracao: 'g-teste' }));
});
afterEach(() => { limparBling(); vi.restoreAllMocks(); });

describe('montarUrl', () => {
  it('usa a base oficial e repete parâmetros de lista', () => {
    expect(montarUrl('/estoques/saldos', { 'idsProdutos[]': [1, 2], pagina: 1, vazio: undefined }))
      .toBe(`${API}/estoques/saldos?idsProdutos%5B%5D=1&idsProdutos%5B%5D=2&pagina=1`);
  });

  it.each(['depositos', '/depositos?x=1', 'https://outro.host/x', '/a/../b', '//host/x', '/a b'])('recusa caminho %j', c => {
    expect(() => montarUrl(c)).toThrow(BlingHttpError);
  });
});

describe('blingGet', () => {
  it('trava desligada: nenhuma chamada', async () => {
    limparBling();
    const s = simular({});
    await expect(blingGet(cache, '/depositos', {}, deps(s.fetch, r))).rejects.toBeInstanceOf(BlingDesativadoError);
    expect(s.chamadas).toHaveLength(0);
  });

  it('GET com Bearer, enable-jwt e Accept JSON; devolve o corpo', async () => {
    const s = simular({ [`${API}/depositos`]: [{ status: 200, corpo: fixture('depositos.json') }] });
    const corpo = await blingGet<{ data: unknown[] }>(cache, '/depositos', {}, deps(s.fetch, r));
    expect(corpo.data).toHaveLength(3);
    const { init } = s.chamadas[0];
    expect(init.method).toBe('GET');
    const h = cabecalhos(init);
    expect(h.Authorization).toBe('Bearer tok-atual');
    expect(h['enable-jwt']).toBe('1');
    expect(h.Accept).toBe('application/json');
    expect(init.body).toBeUndefined();
  });

  it('401: renova uma vez e repete', async () => {
    const s = simular({
      [`${API}/depositos`]: [{ status: 401 }, { status: 200, corpo: { data: [] } }],
      [TOKEN_URL]: [{ status: 200, corpo: { access_token: 'tok-novo', refresh_token: 'rt-novo', expires_in: 21600 } }],
    });
    await blingGet(cache, '/depositos', {}, deps(s.fetch, r));
    expect(s.chamadas.map(c => c.url.startsWith(TOKEN_URL) ? 'token' : 'api')).toEqual(['api', 'token', 'api']);
    expect(cabecalhos(s.chamadas[2].init).Authorization).toBe('Bearer tok-novo');
  });

  it('401 quando outra instância já renovou: usa o token novo sem chamar /oauth/token', async () => {
    const s = simular({ [`${API}/depositos`]: [{ status: 401 }, { status: 200, corpo: { data: [] } }] });
    const f = s.fetch;
    let primeira = true;
    const d = deps((async (u: any, i: any) => {
      const resp = await f(u, i);
      if (primeira) {
        primeira = false;
        await cache.set(K.cadeia, JSON.stringify({ access: 'tok-da-outra', expiresAt: r.agora() + 3600_000, refresh: 'rt-2', geracao: 'g-teste' }));
      }
      return resp;
    }) as typeof fetch, r);
    await blingGet(cache, '/depositos', {}, d);
    expect(s.chamadas.some(c => c.url.startsWith(TOKEN_URL))).toBe(false);
    expect(cabecalhos(s.chamadas[1].init).Authorization).toBe('Bearer tok-da-outra');
  });

  it('401 de novo depois de renovar: pede nova autorização, sem laço', async () => {
    const s = simular({
      [`${API}/depositos`]: [{ status: 401 }, { status: 401 }],
      [TOKEN_URL]: [{ status: 200, corpo: { access_token: 'tok-novo', expires_in: 21600 } }],
    });
    await expect(blingGet(cache, '/depositos', {}, deps(s.fetch, r))).rejects.toBeInstanceOf(BlingAutorizacaoError);
    expect(s.chamadas).toHaveLength(3);
  });

  it('429 por segundo: espera e repete', async () => {
    const s = simular({ [`${API}/depositos`]: [{ status: 429, corpo: fixture('erro-429-segundo.json') }, { status: 200, corpo: { data: [] } }] });
    await blingGet(cache, '/depositos', {}, deps(s.fetch, r));
    expect(s.chamadas).toHaveLength(2);
    expect(r.esperas).toContain(1000);
  });

  it('429 por segundo persistente: desiste após 2 retentativas', async () => {
    const e429 = { status: 429, corpo: fixture('erro-429-segundo.json') };
    const s = simular({ [`${API}/depositos`]: [e429, e429, e429] });
    const e: any = await blingGet(cache, '/depositos', {}, deps(s.fetch, r)).catch((x: any) => x);
    expect(e).toBeInstanceOf(BlingLimiteError);
    expect(e.periodo).toBe('second');
    expect(s.chamadas).toHaveLength(3);
  });

  it('429 diário: falha na hora, sem retentativa', async () => {
    const s = simular({ [`${API}/depositos`]: [{ status: 429, corpo: fixture('erro-429-dia.json') }] });
    const e: any = await blingGet(cache, '/depositos', {}, deps(s.fetch, r)).catch((x: any) => x);
    expect(e).toBeInstanceOf(BlingLimiteError);
    expect(e.periodo).toBe('day');
    expect(s.chamadas).toHaveLength(1);
  });

  it('5xx e erro de rede: até 2 retentativas com espera crescente', async () => {
    const s = simular({ [`${API}/depositos`]: [{ status: 502 }, new TypeError('fetch failed'), { status: 200, corpo: { data: [] } }] });
    await blingGet(cache, '/depositos', {}, deps(s.fetch, r));
    expect(s.chamadas).toHaveLength(3);
    expect(r.esperas.filter(ms => ms === 500 || ms === 1500)).toEqual([500, 1500]);
  });

  it('5xx persistente: erro após 3 tentativas', async () => {
    const s = simular({ [`${API}/depositos`]: [{ status: 500 }, { status: 500 }, { status: 500 }] });
    const e: any = await blingGet(cache, '/depositos', {}, deps(s.fetch, r)).catch((x: any) => x);
    expect(e).toBeInstanceOf(BlingHttpError);
    expect(e.status).toBe(500);
    expect(s.chamadas).toHaveLength(3);
  });

  it('4xx comum (404, 400): sem retentativa', async () => {
    for (const status of [404, 400, 403]) {
      const s = simular({ [`${API}/depositos`]: [{ status, corpo: { error: { type: 'RESOURCE_NOT_FOUND' } } }] });
      const e: any = await blingGet(cache, '/depositos', {}, deps(s.fetch, r)).catch((x: any) => x);
      expect(e).toBeInstanceOf(BlingHttpError);
      expect(e.status).toBe(status);
      expect(s.chamadas).toHaveLength(1);
    }
  });

  it('limite de 3 req/s: a 4ª chamada no mesmo segundo espera o próximo segundo', async () => {
    const ok = () => ({ status: 200, corpo: { data: [] } });
    const s = simular({ [`${API}/depositos`]: [ok(), ok(), ok(), ok()] });
    const segundoInicial = Math.floor(r.agora() / 1000);
    for (let i = 0; i < 4; i++) await blingGet(cache, '/depositos', {}, deps(s.fetch, r));
    expect(r.esperas).toHaveLength(1);
    expect(Math.floor(r.agora() / 1000)).toBe(segundoInicial + 1);
  });

  it('teto local diário: bloqueia antes de sair', async () => {
    ligarBling({ BLING_MAX_REQ_DIA: '2' });
    const ok = () => ({ status: 200, corpo: { data: [] } });
    const s = simular({ [`${API}/depositos`]: [ok(), ok()] });
    await blingGet(cache, '/depositos', {}, deps(s.fetch, r));
    r.avancar(1000);
    await blingGet(cache, '/depositos', {}, deps(s.fetch, r));
    const e: any = await blingGet(cache, '/depositos', {}, deps(s.fetch, r)).catch((x: any) => x);
    expect(e).toBeInstanceOf(BlingLimiteError);
    expect(e.periodo).toBe('local_dia');
    expect(s.chamadas).toHaveLength(2);
  });

  it('logs não contêm token, query nem corpo', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = simular({
      [`${API}/estoques/saldos`]: [{ status: 401 }, { status: 500, corpo: { segredo: 'corpo-x' } }, { status: 200, corpo: { data: [] } }],
      [TOKEN_URL]: [{ status: 200, corpo: { access_token: 'tok-novo-secreto', expires_in: 21600 } }],
    });
    await blingGet(cache, '/estoques/saldos', { 'idsProdutos[]': [987654] }, deps(s.fetch, r));
    const texto = warn.mock.calls.flat().join(' ');
    expect(texto).toContain('[bling] GET /estoques/saldos');
    expect(texto).not.toMatch(/tok-|rt-|987654|corpo-x|segredo/);
  });
});

describe('somente leitura', () => {
  it('nenhum módulo src/bling faz requisição de escrita à API (o único POST é o /oauth/token)', () => {
    const dir = join(process.cwd(), 'src', 'bling');
    for (const arq of readdirSync(dir)) {
      const fonte = readFileSync(join(dir, arq), 'utf8');
      const escritas = fonte.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
      if (arq === 'auth.ts') {
        expect(escritas).toEqual(["method: 'POST'"]);
        expect(fonte).toContain('BLING_TOKEN_URL, {');
      } else {
        expect(escritas, arq).toEqual([]);
      }
    }
  });
});
