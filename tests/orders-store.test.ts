import { describe, it, expect, beforeEach } from 'vitest';
import { FakeCache } from './fake-cache.js';
import {
  readManifest,
  readPreviousManifest,
  readSnapshot,
  readChunkByKey,
  writeChunk,
  publishManifest,
  chunkKey,
  type OrdersManifest,
} from '../src/lib/orders-store.js';
import type { OrderSlim } from '../src/services/orders.service.js';

const slim = (id: number | string, date = '2026-07-10T12:00:00.000-03:00'): OrderSlim => ({
  id,
  status: 'paid',
  date_created: date,
  paid_amount: 100,
  total_amount: 100,
  order_items: [{ quantity: 1, unit_price: 100, item: { id: 'MLB1', title: 'V', seller_sku: null, variation_id: null } }],
});

const manifestoDe = (versao: number, chunks: string[], total: number): OrdersManifest => ({
  versao,
  chunks,
  totalRegistros: total,
  newestDate: '2026-07-10T12:00:00.000-03:00',
  oldestDate: '2026-07-10T12:00:00.000-03:00',
  chunkSize: 500,
  updatedAt: new Date().toISOString(),
  origem: 'full',
});

let cache: FakeCache;
beforeEach(() => { cache = new FakeCache(); });

describe('orders-store — chunks', () => {
  it('1. escreve e lê um chunk', async () => {
    const key = await writeChunk(cache, 'ativos', 1, 0, [slim(1), slim(2)]);
    expect(key).toBe(chunkKey('ativos', 1, 0));
    const lido = await readChunkByKey(cache, key);
    expect(lido.map(o => o.id)).toEqual([1, 2]);
  });

  it('17. chunk ausente gera erro explícito', async () => {
    await expect(readChunkByKey(cache, 'orders:chunk:9:9')).rejects.toThrow(/ausente/);
  });

  it('17. chunk com JSON inválido gera erro explícito', async () => {
    await cache.set('orders:chunk:1:0', '{ nao é json');
    await expect(readChunkByKey(cache, 'orders:chunk:1:0')).rejects.toThrow(/JSON inválido/);
  });
});

describe('orders-store — publicação e retenção', () => {
  it('2. publicação atômica: manifesto aponta para os chunks gravados', async () => {
    const k0 = await writeChunk(cache, 'ativos', 1, 0, [slim(1)]);
    await publishManifest(cache, 'ativos', manifestoDe(1, [k0], 1));
    const man = await readManifest(cache, 'ativos');
    expect(man?.versao).toBe(1);
    const snap = await readSnapshot(cache, 'ativos');
    expect(snap.map(o => o.id)).toEqual([1]);
  });

  it('3. snapshot anterior permanece legível após publicar a próxima versão', async () => {
    // versão 1
    const v1k = await writeChunk(cache, 'ativos', 1, 0, [slim(1)]);
    await publishManifest(cache, 'ativos', manifestoDe(1, [v1k], 1));
    // versão 2
    const v2k = await writeChunk(cache, 'ativos', 2, 0, [slim(2)]);
    await publishManifest(cache, 'ativos', manifestoDe(2, [v2k], 1));

    const atual = await readManifest(cache, 'ativos');
    const previous = await readPreviousManifest(cache, 'ativos');
    expect(atual?.versao).toBe(2);
    expect(previous?.versao).toBe(1);
    // ambos os conjuntos de chunks ainda legíveis
    expect((await readChunkByKey(cache, v1k)).map(o => o.id)).toEqual([1]);
    expect((await readChunkByKey(cache, v2k)).map(o => o.id)).toEqual([2]);
  });

  it('4. só a versão previous MAIS ANTIGA é removida na publicação seguinte', async () => {
    const v1 = await writeChunk(cache, 'ativos', 1, 0, [slim(1)]);
    await publishManifest(cache, 'ativos', manifestoDe(1, [v1], 1));
    const v2 = await writeChunk(cache, 'ativos', 2, 0, [slim(2)]);
    await publishManifest(cache, 'ativos', manifestoDe(2, [v2], 1)); // v1 vira previous
    const v3 = await writeChunk(cache, 'ativos', 3, 0, [slim(3)]);
    await publishManifest(cache, 'ativos', manifestoDe(3, [v3], 1)); // v2 vira previous, v1 apagado

    // v1 (previous antigo) foi removido
    await expect(readChunkByKey(cache, v1)).rejects.toThrow(/ausente/);
    // v2 (novo previous) e v3 (atual) permanecem
    expect((await readChunkByKey(cache, v2)).map(o => o.id)).toEqual([2]);
    expect((await readChunkByKey(cache, v3)).map(o => o.id)).toEqual([3]);
    expect((await readManifest(cache, 'ativos'))?.versao).toBe(3);
    expect((await readPreviousManifest(cache, 'ativos'))?.versao).toBe(2);
  });

  it('readSnapshot sem manifesto retorna vazio', async () => {
    expect(await readSnapshot(cache, 'ativos')).toEqual([]);
  });

  it('readSnapshot lança se um chunk listado sumiu (nunca parcial silencioso)', async () => {
    const k = await writeChunk(cache, 'ativos', 1, 0, [slim(1)]);
    await publishManifest(cache, 'ativos', manifestoDe(1, [k, 'orders:chunk:1:1'], 2));
    await expect(readSnapshot(cache, 'ativos')).rejects.toThrow(/ausente/);
  });
});

describe('orders-store — cancelados usam chaves independentes', () => {
  it('15. ativos e cancelados não colidem', async () => {
    const ka = await writeChunk(cache, 'ativos', 1, 0, [slim(1)]);
    const kc = await writeChunk(cache, 'cancelados', 1, 0, [slim(2)]);
    expect(ka).toContain('orders:chunk:');
    expect(kc).toContain('orders:cancel:chunk:');
    await publishManifest(cache, 'ativos', manifestoDe(1, [ka], 1));
    await publishManifest(cache, 'cancelados', manifestoDe(1, [kc], 1));
    expect((await readSnapshot(cache, 'ativos')).map(o => o.id)).toEqual([1]);
    expect((await readSnapshot(cache, 'cancelados')).map(o => o.id)).toEqual([2]);
    // manifestos independentes
    expect(await cache.get('orders:manifest')).not.toBeNull();
    expect(await cache.get('orders:cancel:manifest')).not.toBeNull();
  });
});
