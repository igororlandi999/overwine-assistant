import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeCache } from './fake-cache.js';
import { K } from '../src/bling/auth.js';
import {
  listarDepositos, obterDeposito, listarProdutos, obterProduto, obterEstrutura, lerSaldos, MAX_PAGINAS_DEPOSITOS,
} from '../src/bling/leitura.js';
import { BlingDesativadoError, BlingHttpError } from '../src/bling/erros.js';
import { ligarBling, limparBling, simular, deps, relogio, fixture, API } from './bling-simulado.js';

let cache: FakeCache;
let r: ReturnType<typeof relogio>;

beforeEach(async () => {
  cache = new FakeCache();
  ligarBling();
  r = relogio();
  await cache.set(K.cadeia, JSON.stringify({ access: 'tok', expiresAt: r.agora() + 3600_000, refresh: 'rt', geracao: 'g-teste', empresa: { id: 'emp-1', nome: 'Empresa Teste', cnpj: '12345678000190' }, validacao: 'cnpj' }));
});
afterEach(() => limparBling());

const ok = (corpo: unknown) => ({ status: 200, corpo });
const params = (url: string) => new URL(url).searchParams;

describe('trava', () => {
  it('desligada: leituras não chamam o Bling', async () => {
    limparBling();
    const s = simular({});
    await expect(listarDepositos(cache, deps(s.fetch, r))).rejects.toBeInstanceOf(BlingDesativadoError);
    await expect(lerSaldos(cache, { idsProdutos: [1] }, deps(s.fetch, r))).rejects.toBeInstanceOf(BlingDesativadoError);
    expect(s.chamadas).toHaveLength(0);
  });
});

describe('depósitos', () => {
  it('lista todos, inclusive inativos e os que desconsideram saldo, sem filtrar', async () => {
    const s = simular({ [`${API}/depositos`]: [ok(fixture('depositos.json'))] });
    const d = await listarDepositos(cache, deps(s.fetch, r));
    expect(d.map(x => [x.id, x.situacao, x.desconsiderarSaldo])).toEqual([
      [14880001, 1, false], [14880002, 1, true], [14880003, 0, false],
    ]);
    expect(params(s.chamadas[0].url).get('limite')).toBe('100');
  });

  it('pagina até receber página incompleta', async () => {
    const cheia = { data: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, descricao: `D${i}`, situacao: 1, padrao: false, desconsiderarSaldo: false })) };
    const s = simular({ [`${API}/depositos`]: [ok(cheia), ok(fixture('depositos.json'))] });
    const d = await listarDepositos(cache, deps(s.fetch, r));
    expect(d).toHaveLength(103);
    expect(s.chamadas.map(c => params(c.url).get('pagina'))).toEqual(['1', '2']);
  });

  it('para no teto de páginas em vez de consumir a cota sem fim', async () => {
    const cheia = { data: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, descricao: 'D', situacao: 1, padrao: false, desconsiderarSaldo: false })) };
    const s = simular({ [`${API}/depositos`]: Array.from({ length: MAX_PAGINAS_DEPOSITOS }, () => ok(cheia)) });
    await expect(listarDepositos(cache, deps(s.fetch, r))).rejects.toBeInstanceOf(BlingHttpError);
    expect(s.chamadas).toHaveLength(MAX_PAGINAS_DEPOSITOS);
  });

  it('obterDeposito: 404 vira null', async () => {
    const s = simular({ [`${API}/depositos/99`]: [{ status: 404, corpo: { error: { type: 'RESOURCE_NOT_FOUND' } } }] });
    expect(await obterDeposito(cache, 99, deps(s.fetch, r))).toBeNull();
  });
});

describe('produtos e estruturas', () => {
  it('listarProdutos envia filtros no formato da referência', async () => {
    const s = simular({ [`${API}/produtos`]: [ok(fixture('produtos.json'))] });
    const p = await listarProdutos(cache, { pagina: 2, criterio: 2, tipo: 'P', codigos: ['UNI-TESTE', 'KIT-TESTE-2'] }, deps(s.fetch, r));
    expect(p.map(x => [x.codigo, x.formato])).toEqual([['UNI-TESTE', 'S'], ['KIT-TESTE-2', 'E']]);
    const q = params(s.chamadas[0].url);
    expect(q.get('pagina')).toBe('2');
    expect(q.get('criterio')).toBe('2');
    expect(q.get('tipo')).toBe('P');
    expect(q.getAll('codigos[]')).toEqual(['UNI-TESTE', 'KIT-TESTE-2']);
  });

  it('limite fora de 1..100 é recusado sem chamar', async () => {
    const s = simular({});
    await expect(listarProdutos(cache, { limite: 500 }, deps(s.fetch, r))).rejects.toBeInstanceOf(BlingHttpError);
    expect(s.chamadas).toHaveLength(0);
  });

  it('obterProduto traz GTIN e estrutura do kit sem converter nada', async () => {
    const s = simular({ [`${API}/produtos/16100000002`]: [ok(fixture('produto-kit.json'))] });
    const p = await obterProduto(cache, 16100000002, deps(s.fetch, r));
    expect(p?.gtin).toBe('7890000000002');
    expect(p?.estrutura?.tipoEstoque).toBe('V');
    expect(p?.estrutura?.componentes).toEqual([{ produto: { id: 16100000001 }, quantidade: 2 }]);
    expect(p?.estoque?.saldoVirtualTotal).toBe(5);
  });

  it('obterEstrutura usa /produtos/estruturas/{id}', async () => {
    const s = simular({ [`${API}/produtos/estruturas/16100000002`]: [ok(fixture('estrutura.json'))] });
    const e = await obterEstrutura(cache, 16100000002, deps(s.fetch, r));
    expect(e?.lancamentoEstoque).toBe('A');
    expect(s.chamadas[0].url).toBe(`${API}/produtos/estruturas/16100000002`);
  });

  it('id inválido é recusado sem chamar', async () => {
    const s = simular({});
    for (const id of [0, -1, 1.5, Number.NaN]) {
      await expect(obterProduto(cache, id, deps(s.fetch, r))).rejects.toBeInstanceOf(BlingHttpError);
    }
    expect(s.chamadas).toHaveLength(0);
  });
});

describe('saldos', () => {
  it('preserva físico, virtual, multiempresa e cada depósito exatamente como vieram', async () => {
    const s = simular({ [`${API}/estoques/saldos`]: [ok(fixture('saldos.json'))] });
    const [x] = await lerSaldos(cache, { idsProdutos: [16100000001] }, deps(s.fetch, r));
    expect(x.saldoFisicoTotal).toBe(12);
    expect(x.saldoVirtualTotal).toBe(11);
    expect(x.saldoMultiempresa).toBe(30);
    expect(x.depositos.map(d => [d.id, d.saldoFisico, d.saldoVirtual])).toEqual([[14880001, 10, 9], [14880002, 2, 2]]);
    expect(Object.keys(x)).not.toContain('disponivel');
  });

  it('lotes de até 100 ids, sem repetir ids', async () => {
    const ids = [...Array.from({ length: 250 }, (_, i) => i + 1), 1, 2, 3];
    const s = simular({ [`${API}/estoques/saldos`]: [ok({ data: [] }), ok({ data: [] }), ok({ data: [] })] });
    await lerSaldos(cache, { idsProdutos: ids }, deps(s.fetch, r));
    expect(s.chamadas.map(c => params(c.url).getAll('idsProdutos[]').length)).toEqual([100, 100, 50]);
  });

  it('por depósito usa /estoques/saldos/{idDeposito}', async () => {
    const s = simular({ [`${API}/estoques/saldos/14880001`]: [ok(fixture('saldos.json'))] });
    await lerSaldos(cache, { idsProdutos: [16100000001], idDeposito: 14880001 }, deps(s.fetch, r));
    expect(new URL(s.chamadas[0].url).pathname).toBe('/Api/v3/estoques/saldos/14880001');
  });

  it('lista vazia não chama o Bling', async () => {
    const s = simular({});
    expect(await lerSaldos(cache, { idsProdutos: [] }, deps(s.fetch, r))).toEqual([]);
    expect(s.chamadas).toHaveLength(0);
  });

  it('formato fora do contrato falha com erro claro, em vez de número errado', async () => {
    const quebrado = { data: [{ produto: { id: 1 }, saldoFisicoTotal: '12', saldoVirtualTotal: 11, depositos: [] }] };
    const s = simular({ [`${API}/estoques/saldos`]: [ok(quebrado)] });
    const e = await lerSaldos(cache, { idsProdutos: [1] }, deps(s.fetch, r)).catch((x: any) => x);
    expect(e).toBeInstanceOf(BlingHttpError);
    expect(e.message).toContain('saldoFisicoTotal');
  });
});
