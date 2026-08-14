import { describe, it, expect, beforeEach } from 'vitest';
import { FakeCache } from './fake-cache.js';
import {
  construirCatalogo, contar, idadeSegundos, lerCatalogoPublicado, montarResposta,
  precisaReconstruir, reconstruirCatalogo, toSlimItem,
  IDS_POR_LOTE, STATUS_CATALOGO,
  type FetchItemIds, type FetchItemsBatch, type ItemBruto, type StatusCatalogo,
} from '../src/services/items-catalog.service.js';
import {
  publishCatalog, readCatalogManifest, readPreviousCatalogManifest,
  type CatalogManifest, type ItemSlim,
} from '../src/lib/items-store.js';

const CAMPOS = [
  'id', 'title', 'status', 'price', 'original_price', 'available_quantity',
  'sold_quantity', 'listing_type_id', 'catalog_listing', 'inventory_id',
  'permalink', 'thumbnail', 'last_updated', 'seller_custom_field', 'seller_sku',
  'tags', 'shipping', 'attributes',
].sort();

function bruto(over: Partial<ItemBruto> & { id: string }): ItemBruto {
  return {
    title: 'Vinho Tinto', status: 'active', price: 89.9, original_price: null,
    available_quantity: 12, sold_quantity: 340, listing_type_id: 'gold_special',
    catalog_listing: false, inventory_id: null,
    permalink: 'https://x', thumbnail: 'https://t', last_updated: '2026-08-05T10:00:00.000Z',
    seller_custom_field: 'AZU-750', seller_sku: null,
    tags: ['fulfillment'], shipping: { logistic_type: 'fulfillment' },
    attributes: [{ id: 'SELLER_SKU', value_name: 'AZU-750' }],
    ...over,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// toSlimItem — recorte de campos
// ══════════════════════════════════════════════════════════════════════════
describe('toSlimItem', () => {
  it('mantem EXATAMENTE os 18 campos aprovados', () => {
    const s = toSlimItem(bruto({ id: 'MLB1' }))!;
    expect(Object.keys(s).sort()).toEqual(CAMPOS);
  });

  it('descarta os campos sem uso no frontend', () => {
    const s = toSlimItem(bruto({
      id: 'MLB1',
      health: 0.9, sub_status: ['x'], variations: [{ id: 1 }], base_price: 99,
      category_id: 'MLB1234', condition: 'new', date_created: '2020-01-01',
      catalog_product_id: 'P1',
    } as never))!;
    const bruta = JSON.stringify(s);
    for (const p of ['health', 'sub_status', 'variations', 'base_price',
                     'category_id', 'condition', 'date_created', 'catalog_product_id']) {
      expect(bruta).not.toContain(p);
    }
  });

  it('shipping guarda SOMENTE logistic_type', () => {
    const s = toSlimItem(bruto({
      id: 'MLB1',
      shipping: { logistic_type: 'fulfillment', mode: 'me2', free_shipping: true, methods: [1, 2] },
    } as never))!;
    expect(s.shipping).toEqual({ logistic_type: 'fulfillment' });
    expect(JSON.stringify(s)).not.toContain('free_shipping');
  });

  it('attributes guarda SOMENTE o par SELLER_SKU', () => {
    const s = toSlimItem(bruto({
      id: 'MLB1',
      attributes: [
        { id: 'BRAND', value_name: 'Quinta' },
        { id: 'SELLER_SKU', value_name: 'AZU-750' },
        { id: 'VOLUME', value_name: '750 ml' },
      ],
    }))!;
    expect(s.attributes).toEqual([{ id: 'SELLER_SKU', value_name: 'AZU-750' }]);
    expect(JSON.stringify(s)).not.toContain('BRAND');
    expect(JSON.stringify(s)).not.toContain('Quinta');
  });

  it('sem SELLER_SKU, attributes vira null (itemSKU cai para o proximo fallback)', () => {
    const s = toSlimItem(bruto({ id: 'MLB1', attributes: [{ id: 'BRAND', value_name: 'X' }] }))!;
    expect(s.attributes).toBeNull();
  });

  it('shipping ausente vira null, sem quebrar', () => {
    const s = toSlimItem(bruto({ id: 'MLB1', shipping: null }))!;
    expect(s.shipping).toBeNull();
  });

  it('item sem id e descartado', () => {
    expect(toSlimItem({ title: 'sem id' } as ItemBruto)).toBeNull();
  });

  it('tipos errados viram null em vez de vazar valor estranho', () => {
    const s = toSlimItem({ id: 'MLB1', price: 'caro', available_quantity: null, catalog_listing: 'sim' } as never)!;
    expect(s.price).toBeNull();
    expect(s.available_quantity).toBeNull();
    expect(s.catalog_listing).toBeNull();
  });

  it('nao vaza PII nem credencial mesmo que venham no bruto', () => {
    const s = toSlimItem(bruto({
      id: 'MLB1', seller_id: 2329718196, buyer: { nickname: 'x' }, access_token: 'APP_USR-x',
    } as never))!;
    const b = JSON.stringify(s);
    expect(b).not.toContain('buyer');
    expect(b).not.toContain('nickname');
    expect(b).not.toContain('access_token');
    expect(b).not.toContain('APP_USR');
    expect(b).not.toContain('seller_id');
  });
});

describe('contar', () => {
  it('conta por status', () => {
    const itens = [
      toSlimItem(bruto({ id: '1', status: 'active' }))!,
      toSlimItem(bruto({ id: '2', status: 'paused' }))!,
      toSlimItem(bruto({ id: '3', status: 'closed' }))!,
      toSlimItem(bruto({ id: '4', status: 'active' }))!,
    ];
    expect(contar(itens)).toEqual({ total: 4, active: 2, paused: 1, closed: 1 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// construirCatalogo
// ══════════════════════════════════════════════════════════════════════════
function fakeML(totais: Record<StatusCatalogo, number>, opts: {
  falharLote?: (ids: string[]) => boolean;
  omitirId?: string;
} = {}) {
  const chamadasIds: string[] = [];
  const chamadasLote: string[][] = [];
  const ids: FetchItemIds = async (status, offset) => {
    chamadasIds.push(`${status}:${offset}`);
    const total = totais[status];
    const n = Math.max(0, Math.min(100, total - offset));
    return { results: Array.from({ length: n }, (_, k) => `${status[0].toUpperCase()}${offset + k}`), total };
  };
  const batch: FetchItemsBatch = async (lote) => {
    chamadasLote.push(lote);
    if (opts.falharLote?.(lote)) throw new Error('lote falhou');
    return lote
      .filter(id => id !== opts.omitirId)
      .map(id => bruto({ id, status: id.startsWith('A') ? 'active' : id.startsWith('P') ? 'paused' : 'closed' }));
  };
  return { ids, batch, chamadasIds, chamadasLote };
}

describe('construirCatalogo', () => {
  it('coleta os 3 status e resolve o detalhe em lotes de 20', async () => {
    const ml = fakeML({ active: 250, paused: 120, closed: 30 });
    const r = await construirCatalogo(ml.ids, ml.batch);
    expect(r.complete).toBe(true);
    expect(r.itens.length).toBe(400);
    expect(r.counts).toEqual({ total: 400, active: 250, paused: 120, closed: 30 });
    expect(ml.chamadasLote.length).toBe(20);          // 400 / 20
    expect(ml.chamadasLote.every(l => l.length <= IDS_POR_LOTE)).toBe(true);
    expect(r.chamadas).toBe(6 + 20);                  // (3+2+1) busca + 20 lotes
  });

  it('preserva a ordem active, paused, closed', async () => {
    const ml = fakeML({ active: 250, paused: 120, closed: 30 });
    const r = await construirCatalogo(ml.ids, ml.batch);
    expect(r.itens[0].id).toBe('A0');
    expect(r.itens[249].id).toBe('A249');
    expect(r.itens[250].id).toBe('P0');
    expect(r.itens[370].id).toBe('C0');
  });

  it('os 3 status sao buscados em paralelo', async () => {
    const ml = fakeML({ active: 250, paused: 120, closed: 30 });
    await construirCatalogo(ml.ids, ml.batch);
    expect(ml.chamadasIds.slice(0, 3).map(x => x.split(':')[0]).sort())
      .toEqual(['active', 'closed', 'paused']);
  });

  it('catalogo vazio e um resultado COMPLETO valido', async () => {
    const ml = fakeML({ active: 0, paused: 0, closed: 0 });
    const r = await construirCatalogo(ml.ids, ml.batch);
    expect(r.complete).toBe(true);
    expect(r.counts.total).toBe(0);
  });

  it('lote que falha torna o resultado INCOMPLETO', async () => {
    const ml = fakeML({ active: 100, paused: 0, closed: 0 }, { falharLote: l => l.includes('A40') });
    const r = await construirCatalogo(ml.ids, ml.batch);
    expect(r.complete).toBe(false);
    expect(r.motivos).toContain('lote_falhou');
  });

  it('id descoberto sem detalhe torna o resultado INCOMPLETO', async () => {
    const ml = fakeML({ active: 100, paused: 0, closed: 0 }, { omitirId: 'A7' });
    const r = await construirCatalogo(ml.ids, ml.batch);
    expect(r.complete).toBe(false);
    expect(r.motivos).toContain('id_sem_detalhe');
  });

  it('teto de chamadas torna o resultado INCOMPLETO, nunca truncado como valido', async () => {
    const ml = fakeML({ active: 1000, paused: 0, closed: 0 });
    const r = await construirCatalogo(ml.ids, ml.batch, { maxChamadas: 12 });
    expect(r.complete).toBe(false);
    expect(r.motivos).toContain('teto_de_chamadas');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// reconstruirCatalogo + persistencia
// ══════════════════════════════════════════════════════════════════════════
describe('reconstruirCatalogo', () => {
  let cache: FakeCache;
  beforeEach(() => { cache = new FakeCache(); });

  it('publica quando completo e a versao incrementa', async () => {
    const ml = fakeML({ active: 30, paused: 0, closed: 0 });
    const r1 = await reconstruirCatalogo(cache, ml.ids, ml.batch, 500);
    expect(r1.manifest!.versao).toBe(1);
    expect(r1.manifest!.complete).toBe(true);
    const r2 = await reconstruirCatalogo(cache, ml.ids, ml.batch, 500);
    expect(r2.manifest!.versao).toBe(2);
    expect((await readCatalogManifest(cache))!.versao).toBe(2);
    expect((await readPreviousCatalogManifest(cache))!.versao).toBe(1);
  });

  it('catalogo INCOMPLETO nao publica e nao toca no snapshot anterior', async () => {
    const bom = fakeML({ active: 30, paused: 0, closed: 0 });
    await reconstruirCatalogo(cache, bom.ids, bom.batch, 500);
    const antes = await readCatalogManifest(cache);

    const ruim = fakeML({ active: 30, paused: 0, closed: 0 }, { falharLote: () => true });
    const r = await reconstruirCatalogo(cache, ruim.ids, ruim.batch, 500);
    expect(r.manifest).toBeNull();
    expect(r.resultado.complete).toBe(false);

    const depois = await readCatalogManifest(cache);
    expect(depois).toEqual(antes);              // intacto
    const itens = await lerCatalogoPublicado(cache, depois!);
    expect(itens.length).toBe(30);              // catalogo anterior preservado
  });

  it('divide em chunks conforme chunkSize', async () => {
    const ml = fakeML({ active: 250, paused: 0, closed: 0 });
    const r = await reconstruirCatalogo(cache, ml.ids, ml.batch, 100);
    expect(r.manifest!.chunks.length).toBe(3);
    expect(await lerCatalogoPublicado(cache, r.manifest!)).toHaveLength(250);
  });

  it('catalogo vazio ainda gera manifesto coerente', async () => {
    const ml = fakeML({ active: 0, paused: 0, closed: 0 });
    const r = await reconstruirCatalogo(cache, ml.ids, ml.batch, 500);
    expect(r.manifest!.counts.total).toBe(0);
    expect(await lerCatalogoPublicado(cache, r.manifest!)).toEqual([]);
  });

  it('publishCatalog RECUSA manifesto marcado como incompleto', async () => {
    const man = {
      versao: 9, chunks: [], counts: { total: 0, active: 0, paused: 0, closed: 0 },
      chunkSize: 500, updatedAt: new Date().toISOString(), complete: false,
    } as unknown as CatalogManifest;
    await expect(publishCatalog(cache, man)).rejects.toThrow(/parcial/i);
  });

  it('leitura detecta chunk ausente em vez de devolver catalogo parcial', async () => {
    const ml = fakeML({ active: 30, paused: 0, closed: 0 });
    const r = await reconstruirCatalogo(cache, ml.ids, ml.batch, 500);
    await cache.del(r.manifest!.chunks[0]);
    await expect(lerCatalogoPublicado(cache, r.manifest!)).rejects.toThrow(/ausente/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// frescor
// ══════════════════════════════════════════════════════════════════════════
describe('frescor', () => {
  const AGORA = new Date('2026-08-06T12:00:00.000Z');
  const man = (updatedAt: string): CatalogManifest => ({
    versao: 3, chunks: ['k'], counts: { total: 2, active: 2, paused: 0, closed: 0 },
    chunkSize: 500, updatedAt, complete: true,
  });

  it('idadeSegundos calcula a partir de updatedAt', () => {
    expect(idadeSegundos('2026-08-06T11:55:00.000Z', AGORA)).toBe(300);
    expect(idadeSegundos('data-invalida', AGORA)).toBe(Number.POSITIVE_INFINITY);
  });

  it('stale false dentro do soft TTL', () => {
    const r = montarResposta(man('2026-08-06T11:55:00.000Z'), [], 'snapshot', 900, 86400, [], AGORA);
    expect(r.freshness.stale).toBe(false);
    expect(r.freshness.ageSeconds).toBe(300);
    expect(r.complete).toBe(true);
  });

  it('stale true entre soft e hard, mas ainda serve', () => {
    const r = montarResposta(man('2026-08-06T11:30:00.000Z'), [], 'snapshot', 900, 86400, [], AGORA);
    expect(r.freshness.stale).toBe(true);
    expect(r.source).toBe('snapshot');
  });

  it('precisaReconstruir so alem do hard TTL', () => {
    expect(precisaReconstruir(man('2026-08-06T11:30:00.000Z'), 86400, AGORA)).toBe(false);
    expect(precisaReconstruir(man('2026-08-04T11:30:00.000Z'), 86400, AGORA)).toBe(true);
    expect(precisaReconstruir(null, 86400, AGORA)).toBe(true);
  });

  it('resposta expoe apenas os campos do contrato', () => {
    const r = montarResposta(man('2026-08-06T11:55:00.000Z'), [], 'rebuilt', 900, 86400, ['x'], AGORA);
    expect(Object.keys(r).sort()).toEqual(
      ['complete', 'counts', 'freshness', 'items', 'source', 'updatedAt', 'versao', 'warnings']
    );
  });

  it('STATUS_CATALOGO cobre os tres status do dashboard', () => {
    expect(STATUS_CATALOGO).toEqual(['active', 'paused', 'closed']);
  });
});