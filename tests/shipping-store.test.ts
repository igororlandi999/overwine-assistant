import { describe, it, expect, beforeEach } from 'vitest';
import { FakeCache } from './fake-cache.js';
import {
  CHAVE_MANIFESTO, CHAVE_MANIFESTO_ANTERIOR, CHUNK_SIZE,
  lerManifesto, lerManifestoAnterior, lerMapaEnvios, publicarMapaEnvios,
  type EnvioInfo,
} from '../src/lib/shipping-store.js';

let cache: FakeCache;
beforeEach(() => { cache = new FakeCache(); });

function mapa(...pares: Array<[string, string, number | null]>): Map<string, EnvioInfo> {
  return new Map(pares.map(([id, lt, custo]) => [id, { logisticType: lt, custoFrete: custo }]));
}

function mapaGrande(n: number, prefixo = 'S'): Map<string, EnvioInfo> {
  const m = new Map<string, EnvioInfo>();
  for (let i = 0; i < n; i++) {
    m.set(`${prefixo}${String(i).padStart(6, '0')}`, { logisticType: 'fulfillment', custoFrete: 7.5 });
  }
  return m;
}

const chavesDeChunk = (c: FakeCache) =>
  [...c.store.keys()].filter(k => k.startsWith('ship:logi:chunk:'));

// ══════════════════════════════════════════════════════════════════════════
describe('shipping-store — publicação e leitura', () => {
  it('primeira publicação cria a versão 1 e nenhum previous', async () => {
    const man = await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 7.5]));
    expect(man.versao).toBe(1);
    expect(man.total).toBe(1);
    expect(await lerManifestoAnterior(cache)).toBeNull();
    expect((await lerMapaEnvios(cache)).get('1')).toEqual({ logisticType: 'fulfillment', custoFrete: 7.5 });
  });

  it('cada publicação incrementa a versão', async () => {
    await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1]));
    await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1], ['2', 'drop_off', 2]));
    const man = await lerManifesto(cache);
    expect(man!.versao).toBe(2);
    expect(man!.total).toBe(2);
  });

  it('descarta entrada com id vazio ou logística vazia', async () => {
    const m = mapa(['1', 'fulfillment', 1], ['', 'fulfillment', 1], ['3', '', 1]);
    const man = await publicarMapaEnvios(cache, m);
    expect(man.total).toBe(1);
    expect([...(await lerMapaEnvios(cache)).keys()]).toEqual(['1']);
  });

  it('mesmo mapa produz sempre os mesmos chunks (ordem estável)', async () => {
    const a = await publicarMapaEnvios(cache, mapa(['b', 'x', 1], ['a', 'y', 2]));
    const conteudoA = a.chunks.map(k => cache.store.get(k)!.v);

    const outro = new FakeCache();
    const b = await publicarMapaEnvios(outro, mapa(['a', 'y', 2], ['b', 'x', 1]));
    const conteudoB = b.chunks.map(k => outro.store.get(k)!.v);

    expect(conteudoB).toEqual(conteudoA);
  });

  it('custoFrete null sobrevive à ida e volta e não vira 0', async () => {
    await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', null], ['2', 'fulfillment', 0]));
    const lido = await lerMapaEnvios(cache);
    expect(lido.get('1')!.custoFrete).toBeNull();
    expect(lido.get('2')!.custoFrete).toBe(0);
  });
});

describe('shipping-store — retenção de chunks', () => {
  it('a versão anterior continua legível depois de uma publicação nova', async () => {
    const v1 = await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1]));
    await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1], ['2', 'drop_off', 2]));

    // Uma leitura que já tinha o manifesto v1 na mão ainda encontra os chunks.
    for (const chave of v1.chunks) expect(cache.store.has(chave)).toBe(true);
    expect((await lerManifestoAnterior(cache))!.versao).toBe(1);
  });

  it('a terceira publicação apaga os chunks da primeira', async () => {
    const v1 = await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1]));
    const v2 = await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1], ['2', 'drop_off', 2]));
    const v3 = await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1], ['2', 'drop_off', 2], ['3', 'xd_drop_off', 3]));

    for (const chave of v1.chunks) expect(cache.store.has(chave)).toBe(false);
    for (const chave of v2.chunks) expect(cache.store.has(chave)).toBe(true);
    for (const chave of v3.chunks) expect(cache.store.has(chave)).toBe(true);
    expect((await lerManifestoAnterior(cache))!.versao).toBe(2);
  });

  it('publicar muitas vezes NÃO faz o Redis crescer sem limite', async () => {
    // O defeito que este teste tranca: sem retenção, uma execução por hora
    // deixava os chunks de toda versão anterior para sempre no Redis.
    for (let i = 1; i <= 12; i++) {
      await publicarMapaEnvios(cache, mapaGrande(1 + i));
    }
    const atual = await lerManifesto(cache);
    const anterior = await lerManifestoAnterior(cache);
    const esperado = new Set([...atual!.chunks, ...anterior!.chunks]);

    expect(new Set(chavesDeChunk(cache))).toEqual(esperado);
    expect(chavesDeChunk(cache).length).toBeLessThanOrEqual(2);
  });

  it('a retenção respeita mapas grandes, com mais de um chunk por versão', async () => {
    const n = CHUNK_SIZE + 500; // duas fatias
    const v1 = await publicarMapaEnvios(cache, mapaGrande(n));
    expect(v1.chunks.length).toBe(2);

    const v2 = await publicarMapaEnvios(cache, mapaGrande(n));
    const v3 = await publicarMapaEnvios(cache, mapaGrande(n));

    for (const chave of v1.chunks) expect(cache.store.has(chave)).toBe(false);
    for (const chave of [...v2.chunks, ...v3.chunks]) expect(cache.store.has(chave)).toBe(true);
    expect(chavesDeChunk(cache).length).toBe(4);
    expect((await lerMapaEnvios(cache)).size).toBe(n);
  });

  it('a publicação nova é legível inteira depois da limpeza', async () => {
    await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1]));
    await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1], ['2', 'drop_off', 2]));
    await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 9], ['2', 'drop_off', 2], ['3', 'self_service', 3]));

    const lido = await lerMapaEnvios(cache);
    expect(lido.size).toBe(3);
    expect(lido.get('1')!.custoFrete).toBe(9); // o valor novo, não o da v1
    expect(lido.get('3')!.logisticType).toBe('self_service');
  });
});

describe('shipping-store — retenção sob falha e reuso de chave', () => {
  it('publicação interrompida entre a limpeza e a troca do ponteiro não destrói o estado válido', async () => {
    const v1 = await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1]));
    const v2 = await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1], ['2', 'drop_off', 2]));

    // Simula a terceira publicação morrendo depois de gravar os chunks novos e
    // de apagar os da v1, mas ANTES de trocar `manifest`.
    const v3chunk = 'ship:logi:chunk:3:0';
    await cache.set(v3chunk, JSON.stringify([['9', ['xd_drop_off', 9]]]));
    for (const chave of v1.chunks) await cache.del(chave);

    // O manifesto publicado ainda é o v2, e os chunks dele continuam lá.
    const atual = await lerManifesto(cache);
    expect(atual!.versao).toBe(2);
    for (const chave of v2.chunks) expect(cache.store.has(chave)).toBe(true);
    expect((await lerMapaEnvios(cache)).size).toBe(2);

    // E a próxima publicação retoma normalmente, sem tropeçar no ponteiro
    // `previous` que aponta para chunks já apagados.
    const v4 = await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1], ['2', 'drop_off', 2], ['3', 'self_service', 3]));
    expect(v4.versao).toBe(3);
    expect((await lerMapaEnvios(cache)).size).toBe(3);
  });

  it('chunk ainda referenciado pelo manifesto atual NUNCA é apagado, mesmo se o previous o citar', async () => {
    // Estado patológico: o `previous` aponta para as MESMAS chaves do atual.
    // Sem a guarda de reuso, a limpeza apagaria os chunks em uso e o mapa
    // publicado ficaria ilegível.
    const v1 = await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1], ['2', 'drop_off', 2]));
    await cache.set(CHAVE_MANIFESTO_ANTERIOR, JSON.stringify({
      versao: 1, chunks: v1.chunks, total: 2, chunkSize: CHUNK_SIZE,
      updatedAt: '2026-08-20T00:00:00.000Z',
    }));

    await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1], ['2', 'drop_off', 2], ['3', 'self_service', 3]));
    for (const chave of v1.chunks) expect(cache.store.has(chave)).toBe(true);
    expect((await lerMapaEnvios(cache)).size).toBe(3);
  });

  it('a limpeza nunca alcança os chunks da versão que está sendo publicada', async () => {
    await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1]));
    await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1], ['2', 'drop_off', 2]));
    const v3 = await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1], ['2', 'drop_off', 2], ['3', 'self_service', 3]));
    for (const chave of v3.chunks) expect(cache.store.has(chave)).toBe(true);
    // E o mapa publicado é legível inteiro logo após a limpeza.
    expect((await lerMapaEnvios(cache)).size).toBe(3);
  });
});

describe('shipping-store — leitura tolerante a falha', () => {
  it('sem manifesto devolve mapa vazio, sem lançar', async () => {
    expect((await lerMapaEnvios(cache)).size).toBe(0);
  });

  it('manifesto corrompido é tratado como ausente', async () => {
    await cache.set(CHAVE_MANIFESTO, '{ isto nao e json');
    expect(await lerManifesto(cache)).toBeNull();
    expect((await lerMapaEnvios(cache)).size).toBe(0);
  });

  it('manifesto com forma inválida é recusado', async () => {
    await cache.set(CHAVE_MANIFESTO, JSON.stringify({ versao: 0, chunks: [], total: 0, chunkSize: 1, updatedAt: 'x' }));
    expect(await lerManifesto(cache)).toBeNull();
  });

  it('chunk ausente é pulado e o resto do mapa sobrevive', async () => {
    const n = CHUNK_SIZE + 10;
    const man = await publicarMapaEnvios(cache, mapaGrande(n));
    expect(man.chunks.length).toBe(2);
    await cache.del(man.chunks[0]);

    const lido = await lerMapaEnvios(cache);
    expect(lido.size).toBe(10);        // sobrou só a segunda fatia
    expect(lido.size).toBeGreaterThan(0);
  });

  it('chunk com JSON inválido é pulado sem derrubar a leitura', async () => {
    const man = await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1]));
    await cache.set(man.chunks[0], 'nao e json');
    expect((await lerMapaEnvios(cache)).size).toBe(0);
  });

  it('aceita a forma legado, só com a logística, e devolve custo null', async () => {
    // Formato gravado antes do custo existir: [id, 'fulfillment'].
    await cache.set('ship:logi:chunk:1:0', JSON.stringify([['1', 'fulfillment'], ['2', 'drop_off']]));
    await cache.set(CHAVE_MANIFESTO, JSON.stringify({
      versao: 1, chunks: ['ship:logi:chunk:1:0'], total: 2, chunkSize: CHUNK_SIZE,
      updatedAt: '2026-08-18T00:00:00.000Z',
    }));
    const lido = await lerMapaEnvios(cache);
    expect(lido.get('1')).toEqual({ logisticType: 'fulfillment', custoFrete: null });
    expect(lido.get('2')).toEqual({ logisticType: 'drop_off', custoFrete: null });
  });

  it('previous corrompido não impede a publicação', async () => {
    await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1]));
    await cache.set(CHAVE_MANIFESTO_ANTERIOR, '{ corrompido');
    const v2 = await publicarMapaEnvios(cache, mapa(['1', 'fulfillment', 1], ['2', 'drop_off', 2]));
    expect(v2.versao).toBe(2);
    expect((await lerMapaEnvios(cache)).size).toBe(2);
  });
});
