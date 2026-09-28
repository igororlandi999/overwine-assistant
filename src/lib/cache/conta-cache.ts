/**
 * conta-cache — o MESMO `Cache`, com toda chave prefixada pela conta.
 *
 * É o único mecanismo de isolamento de dados entre contas, e por isso ele
 * cobre a interface `Cache` INTEIRA: strings, TTL, lock (setNX), compare-and-
 * delete atômico (delIfEquals, que no Upstash é um script Lua — a chave
 * prefixada é passada ao script, então o CAD continua atômico), contadores
 * (incr) e a fila (rpush/lpopMany/llen). Stores, serviços, locks, cooldowns,
 * telemetria e os tokens do Mercado Livre (`ml:*`, em ml-auth) usam só essa
 * interface, então ficam isolados por construção, sem que nenhum deles
 * conheça a conta.
 *
 * A conta LEGADA tem prefixo vazio: o wrapper devolve o cache original, e
 * nenhuma chave que existe hoje em produção muda de nome ou de formato.
 *
 * O que NÃO passa por aqui, de propósito: sessão do dashboard, rate limit
 * por IP/sessão e bloqueio de login. São globais do backend, não de uma
 * conta. As rotas usam o cache cru para isso e o cache da conta para dados.
 *
 * Há um teste que percorre os métodos do `Cache` por reflexão e falha se um
 * método novo for adicionado à interface sem ser coberto aqui.
 */
import type { Cache } from './cache.js';
import type { Conta } from '../../config/contas.js';

export const PREFIXO_CONTA_RE = /^c:[a-z0-9-]+:$/;

export function cacheDaConta(cache: Cache, conta: Pick<Conta, 'id' | 'prefixo' | 'legada'>): Cache {
  if (conta.prefixo === '') {
    if (!conta.legada) throw new Error(`conta ${conta.id} sem prefixo e não legada`);
    return cache;
  }
  if (!PREFIXO_CONTA_RE.test(conta.prefixo)) throw new Error(`prefixo inválido para a conta ${conta.id}`);
  return new CachePrefixado(cache, conta.prefixo);
}

class CachePrefixado implements Cache {
  constructor(private readonly base: Cache, private readonly prefixo: string) {}
  private k(key: string): string {
    if (typeof key !== 'string' || key === '') throw new Error('chave vazia');
    return this.prefixo + key;
  }
  get(key: string) { return this.base.get(this.k(key)); }
  set(key: string, value: string, ttlSeconds?: number) { return this.base.set(this.k(key), value, ttlSeconds); }
  del(key: string) { return this.base.del(this.k(key)); }
  setNX(key: string, value: string, ttlSeconds: number) { return this.base.setNX(this.k(key), value, ttlSeconds); }
  delIfEquals(key: string, value: string) { return this.base.delIfEquals(this.k(key), value); }
  incr(key: string, ttlSeconds: number) { return this.base.incr(this.k(key), ttlSeconds); }
  rpush(key: string, ...values: string[]) { return this.base.rpush(this.k(key), ...values); }
  lpopMany(key: string, max: number) { return this.base.lpopMany(this.k(key), max); }
  llen(key: string) { return this.base.llen(this.k(key)); }
}

/** Métodos que a interface `Cache` tem hoje. O teste de reflexão compara com o FakeCache. */
export const METODOS_CACHE = ['get', 'set', 'del', 'setNX', 'delIfEquals', 'incr', 'rpush', 'lpopMany', 'llen'] as const;
