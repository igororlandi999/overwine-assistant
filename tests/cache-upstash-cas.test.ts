import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_ENV } from './fake-cache.js';
import { resetEnvForTests } from '../src/config/env.js';

/**
 * Redis simulado que EXECUTA a semântica dos dois scripts Lua do adaptador
 * (GET + comparação + SET/DEL), para conferir que o setIfEquals manda os
 * argumentos na ordem que o script espera.
 */
const dados = new Map<string, { v: string; ex?: number }>();
const evals: { script: string; keys: string[]; args: string[] }[] = [];
vi.mock('@upstash/redis', () => ({
  Redis: class {
    async eval(script: string, keys: string[], args: string[]) {
      evals.push({ script, keys, args });
      const atual = dados.get(keys[0])?.v ?? null;
      if (atual !== args[0]) return 0;
      if (script.includes('"SET"')) dados.set(keys[0], { v: args[1], ex: Number(args[2]) });
      else dados.delete(keys[0]);
      return 1;
    }
  },
}));

const { UpstashCache } = await import('../src/lib/cache/upstash.js');

beforeEach(() => {
  dados.clear();
  evals.length = 0;
  Object.assign(process.env, TEST_ENV);
  resetEnvForTests();
});

describe('UpstashCache.setIfEquals', () => {
  it('um único EVAL atômico: GET, compara e SET com EX', async () => {
    const c = new UpstashCache();
    dados.set('k', { v: 'antigo' });
    expect(await c.setIfEquals('k', 'antigo', 'novo', 60)).toBe(true);
    expect(dados.get('k')).toEqual({ v: 'novo', ex: 60 });
    expect(evals).toHaveLength(1);
    expect(evals[0].script).toContain('redis.call("GET", KEYS[1]) == ARGV[1]');
    expect(evals[0].script).toContain('redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])');
    expect(evals[0].args).toEqual(['antigo', 'novo', '60']);
  });

  it('valor diferente do esperado: não grava', async () => {
    const c = new UpstashCache();
    dados.set('k', { v: 'mais-novo' });
    expect(await c.setIfEquals('k', 'antigo', 'atrasado', 60)).toBe(false);
    expect(dados.get('k')!.v).toBe('mais-novo');
  });

  it('chave ausente: não grava (esperado nunca casa com nil)', async () => {
    const c = new UpstashCache();
    expect(await c.setIfEquals('k', 'antigo', 'novo', 60)).toBe(false);
    expect(dados.has('k')).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])('TTL %s é recusado sem chamar o Redis', async ttl => {
    const c = new UpstashCache();
    await expect(c.setIfEquals('k', 'a', 'b', ttl)).rejects.toThrow(/TTL/);
    expect(evals).toHaveLength(0);
  });
});
