import { describe, it, expect, beforeEach } from 'vitest';
import { FakeCache } from './fake-cache.js';
import { encodeCursor, decodeCursor, InvalidCursorError } from '../src/lib/orders-cursor.js';
import {
  getReadStatus, getPage, normalizarPageSize,
  PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX,
} from '../src/services/orders-read.service.js';
import {
  type Alvo, type OrdersManifest,
  writeChunk, publishManifest,
} from '../src/lib/orders-store.js';
import type { OrderSlim } from '../src/services/orders.service.js';

// ── helpers de fixture (usam as funções REAIS do store — validam o encaixe) ──
function pedido(id: number, data = '2026-07-01T10:00:00.000-03:00'): OrderSlim {
  return {
    id, status: 'paid', date_created: data, paid_amount: 100, total_amount: 100,
    order_items: [{ quantity: 1, unit_price: 100, item: { id: `MLB${id}`, title: 'V', seller_sku: 'SKU', variation_id: null } }],
    buyer: { nickname: 'X' },
  };
}

/** Publica um snapshot com N pedidos, chunkSize dado. Retorna o manifesto. */
async function publicar(cache: FakeCache, alvo: Alvo, n: number, chunkSize: number, versaoEsperada?: number): Promise<OrdersManifest> {
  const pedidos = Array.from({ length: n }, (_, i) => pedido(i + 1, `2026-07-01T10:00:${String(i % 60).padStart(2, '0')}.000-03:00`));
  // Descobre a versão que publishManifest vai gerar? Não: publishManifest só troca ponteiro.
  // Aqui montamos o manifesto manualmente como a sync faria (writeChunk + publishManifest).
  const atual = JSON.parse((await cache.get(alvo === 'cancelados' ? 'orders:cancel:manifest' : 'orders:manifest')) || 'null');
  const versao = versaoEsperada ?? ((atual?.versao ?? 0) + 1);
  const chunks: string[] = [];
  for (let i = 0; i * chunkSize < n; i++) {
    const fatia = pedidos.slice(i * chunkSize, (i + 1) * chunkSize);
    chunks.push(await writeChunk(cache, alvo, versao, i, fatia));
  }
  const man: OrdersManifest = {
    versao, chunks, totalRegistros: n,
    newestDate: pedidos.length ? pedidos[pedidos.length - 1].date_created : null,
    oldestDate: pedidos.length ? pedidos[0].date_created : null,
    chunkSize, updatedAt: new Date().toISOString(), origem: 'full',
  };
  await publishManifest(cache, alvo, man);
  return man;
}

let cache: FakeCache;
beforeEach(() => { cache = new FakeCache(); });

// ═══════════════════════════ CURSOR ═══════════════════════════
describe('orders-cursor', () => {
  it('1. encode → decode roundtrip', () => {
    const c = { v: 3, o: 400, a: 'ativos' as const };
    const dec = decodeCursor(encodeCursor(c));
    expect(dec).toEqual(c);
  });

  it('2. cursor adulterado (base64 quebrado, JSON inválido, chars fora) → InvalidCursorError', () => {
    expect(() => decodeCursor('###nao-base64###')).toThrow(InvalidCursorError);
    expect(() => decodeCursor(Buffer.from('nao-json', 'utf8').toString('base64url'))).toThrow(InvalidCursorError);
    expect(() => decodeCursor('')).toThrow(InvalidCursorError);
  });

  it('valida tipos: v inteiro>0, o inteiro>=0, a válido', () => {
    const b = (o: object) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
    expect(() => decodeCursor(b({ v: 0, o: 0, a: 'ativos' }))).toThrow(InvalidCursorError);
    expect(() => decodeCursor(b({ v: 1.5, o: 0, a: 'ativos' }))).toThrow(InvalidCursorError);
    expect(() => decodeCursor(b({ v: 1, o: -1, a: 'ativos' }))).toThrow(InvalidCursorError);
    expect(() => decodeCursor(b({ v: 1, o: 0, a: 'x' }))).toThrow(InvalidCursorError);
    expect(() => decodeCursor(b({ v: 1, o: 0 }))).toThrow(InvalidCursorError);
  });

  it('3. cursor com alvo divergente é rejeitado pelo getPage (invalid_cursor)', async () => {
    await publicar(cache, 'ativos', 3, 500);
    const cursorCancelados = encodeCursor({ v: 1, o: 0, a: 'cancelados' });
    const r = await getPage(cache, 'ativos', cursorCancelados, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_cursor');
  });
});

// ═══════════════════════════ STATUS ═══════════════════════════
describe('getReadStatus', () => {
  it('4/5. status de ativos e cancelados (projeção do manifesto)', async () => {
    await publicar(cache, 'ativos', 10, 500);
    await publicar(cache, 'cancelados', 4, 500);
    const a = await getReadStatus(cache, 'ativos');
    expect(a).toMatchObject({ alvo: 'ativos', versao: 1, totalRegistros: 10, origem: 'full' });
    const c = await getReadStatus(cache, 'cancelados');
    expect(c).toMatchObject({ alvo: 'cancelados', versao: 1, totalRegistros: 4 });
  });

  it('6. status NÃO expõe chunks, chunkSize, jobId nem chaves Redis', async () => {
    await publicar(cache, 'ativos', 10, 500);
    // simula job interno + status persistido
    await cache.set('orders:sync:job:ativos', JSON.stringify({ jobId: 'deadbeef', committedOffset: 5, chunkKeys: ['orders:build:chunk:deadbeef:0'] }));
    const s = await getReadStatus(cache, 'ativos');
    const raw = JSON.stringify(s);
    expect(raw).not.toContain('chunks');
    expect(raw).not.toContain('chunkSize');
    expect(raw).not.toContain('jobId');
    expect(raw).not.toContain('deadbeef');
    expect(raw).not.toContain('orders:');
    expect('chunks' in (s as object)).toBe(false);
  });

  it('7. partial acompanha SyncStatus.emAndamento', async () => {
    await publicar(cache, 'ativos', 3, 500);
    await cache.set('orders:sync:status:ativos', JSON.stringify({
      ultimaVersao: 1, totalRegistros: 3, newestDate: null, lastSyncAt: '2026-07-20T00:00:00Z',
      lastResult: 'parcial', emAndamento: true,
    }));
    let s = await getReadStatus(cache, 'ativos');
    expect(s.partial).toBe(true);
    expect(s.lastResult).toBe('parcial');
    expect(s.lastSyncAt).toBe('2026-07-20T00:00:00Z');

    await cache.set('orders:sync:status:ativos', JSON.stringify({
      ultimaVersao: 1, totalRegistros: 3, newestDate: null, lastSyncAt: '2026-07-20T01:00:00Z',
      lastResult: 'ok', emAndamento: false,
    }));
    s = await getReadStatus(cache, 'ativos');
    expect(s.partial).toBe(false);
  });

  it('status sem manifesto: versao null, totalRegistros 0, partial false', async () => {
    const s = await getReadStatus(cache, 'ativos');
    expect(s).toMatchObject({ versao: null, totalRegistros: 0, partial: false, origem: null });
  });
});

// ═══════════════════════════ PAGESIZE ═══════════════════════════
describe('normalizarPageSize', () => {
  it('13/14/15. padrão, teto e inválido', () => {
    expect(normalizarPageSize(undefined)).toBe(PAGE_SIZE_DEFAULT);
    expect(normalizarPageSize('200')).toBe(200);
    expect(normalizarPageSize('500')).toBe(PAGE_SIZE_MAX);
    expect(normalizarPageSize('999')).toBe(PAGE_SIZE_MAX);
    expect(normalizarPageSize('0')).toBe(PAGE_SIZE_DEFAULT);
    expect(normalizarPageSize('-5')).toBe(PAGE_SIZE_DEFAULT);
    expect(normalizarPageSize('abc')).toBe(PAGE_SIZE_DEFAULT);
    expect(normalizarPageSize('1.5')).toBe(PAGE_SIZE_DEFAULT);
    expect(normalizarPageSize(50)).toBe(50);
  });
});

// ═══════════════════════════ PAGINAÇÃO ═══════════════════════════
describe('getPage — paginação', () => {
  it('8. página dentro de um único chunk', async () => {
    await publicar(cache, 'ativos', 100, 500); // 1 chunk
    const r = await getPage(cache, 'ativos', null, 50);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.items.length).toBe(50);
      expect(r.value.items[0].id).toBe(1);
      expect(r.value.items[49].id).toBe(50);
      expect(r.value.nextCursor).not.toBeNull();
      expect(r.value.servedFrom).toBe('atual');
    }
  });

  it('9. página cruzando dois chunks', async () => {
    await publicar(cache, 'ativos', 300, 100); // 3 chunks de 100
    // offset 80, pageSize 50 → itens 81..130 (cruza chunk 0→1)
    const cursor = encodeCursor({ v: 1, o: 80, a: 'ativos' });
    const r = await getPage(cache, 'ativos', cursor, 50);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.items.map(p => p.id)).toEqual(Array.from({ length: 50 }, (_, i) => 81 + i));
    }
  });

  it('10. varredura completa sem duplicar nem perder', async () => {
    const N = 250, CS = 100;
    await publicar(cache, 'ativos', N, CS);
    const vistos: number[] = [];
    let cursor: string | null = null;
    let guardas = 0;
    do {
      const r = await getPage(cache, 'ativos', cursor, 60);
      expect(r.ok).toBe(true);
      if (!r.ok) break;
      vistos.push(...r.value.items.map(p => Number(p.id)));
      cursor = r.value.nextCursor;
    } while (cursor !== null && ++guardas < 100);
    expect(vistos.length).toBe(N);
    expect(new Set(vistos).size).toBe(N); // sem duplicatas
    expect(vistos).toEqual(Array.from({ length: N }, (_, i) => i + 1)); // ordem preservada
  });

  it('11. última página parcial → nextCursor null', async () => {
    await publicar(cache, 'ativos', 130, 100); // 100 + 30
    const cursor = encodeCursor({ v: 1, o: 100, a: 'ativos' });
    const r = await getPage(cache, 'ativos', cursor, 200);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.items.length).toBe(30);
      expect(r.value.nextCursor).toBeNull();
    }
  });

  it('12. snapshot vazio (0 pedidos) → página vazia, nextCursor null', async () => {
    await publicar(cache, 'ativos', 0, 500);
    const r = await getPage(cache, 'ativos', null, 200);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.items).toEqual([]);
      expect(r.value.nextCursor).toBeNull();
      expect(r.value.totalRegistros).toBe(0);
    }
  });

  it('16. lê SOMENTE os chunks necessários (conta GETs de chunk)', async () => {
    await publicar(cache, 'ativos', 500, 100); // 5 chunks
    const gets: string[] = [];
    const orig = cache.get.bind(cache);
    cache.get = async (k: string) => { gets.push(k); return orig(k); };
    // 1ª página pageSize 50 dentro do chunk 0 → deve ler manifesto + 1 chunk
    await getPage(cache, 'ativos', null, 50);
    const chunkGets = gets.filter(k => k.startsWith('orders:chunk:'));
    expect(chunkGets.length).toBe(1);
  });

  it('17. cursor da versão atual serve do atual', async () => {
    await publicar(cache, 'ativos', 100, 500); // v1
    const cursor = encodeCursor({ v: 1, o: 10, a: 'ativos' });
    const r = await getPage(cache, 'ativos', cursor, 20);
    expect(r.ok && r.value.servedFrom).toBe('atual');
  });

  it('18. cursor da versão anterior serve do previous', async () => {
    await publicar(cache, 'ativos', 100, 500); // v1 (vira previous)
    await publicar(cache, 'ativos', 120, 500); // v2 (atual)
    const cursorV1 = encodeCursor({ v: 1, o: 10, a: 'ativos' });
    const r = await getPage(cache, 'ativos', cursorV1, 20);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.servedFrom).toBe('previous');
      expect(r.value.versao).toBe(1);
      expect(r.value.totalRegistros).toBe(100);
      expect(r.value.items[0].id).toBe(11);
    }
  });

  it('19. cursor mais antigo que o previous → snapshot_changed com versao/total atuais', async () => {
    await publicar(cache, 'ativos', 100, 500); // v1
    await publicar(cache, 'ativos', 110, 500); // v2 (previous = v1)
    await publicar(cache, 'ativos', 120, 500); // v3 (atual; previous = v2)
    const cursorV1 = encodeCursor({ v: 1, o: 0, a: 'ativos' });
    const r = await getPage(cache, 'ativos', cursorV1, 20);
    expect(r.ok).toBe(false);
    if (!r.ok && r.code === 'snapshot_changed') {
      expect(r.versao).toBe(3);
      expect(r.totalRegistros).toBe(120);
    } else {
      throw new Error('esperado snapshot_changed');
    }
  });

  it('20. manifesto ausente → not_ready', async () => {
    const r = await getPage(cache, 'ativos', null, 200);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_ready');
  });

  it('21. chunk ausente/ inválido → erro controlado (inconsistente), sem vazar chave', async () => {
    const man = await publicar(cache, 'ativos', 100, 100);
    await cache.del(man.chunks[0]); // remove um chunk apontado pelo manifesto
    const r = await getPage(cache, 'ativos', null, 50);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('inconsistente');
      expect(JSON.stringify(r)).not.toContain('orders:chunk');
    }
  });

  it('22. ativos e cancelados não se misturam', async () => {
    await publicar(cache, 'ativos', 5, 500);
    await publicar(cache, 'cancelados', 3, 500);
    const a = await getPage(cache, 'ativos', null, 200);
    const c = await getPage(cache, 'cancelados', null, 200);
    expect(a.ok && a.value.totalRegistros).toBe(5);
    expect(c.ok && c.value.totalRegistros).toBe(3);
    // ids não colidem entre coleções na leitura
    if (a.ok && c.ok) {
      expect(a.value.items.length).toBe(5);
      expect(c.value.items.length).toBe(3);
    }
  });
});