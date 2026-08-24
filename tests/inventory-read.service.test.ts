import { describe, it, expect, beforeEach } from 'vitest';
import { FakeCache, TEST_ENV } from './fake-cache.js';
import { resetEnvForTests } from '../src/config/env.js';
import {
  publishCatalog, writeCatalogChunk,
  type CatalogManifest, type ItemSlim,
} from '../src/lib/items-store.js';
import {
  publishManifest, writeChunk, type OrdersManifest,
} from '../src/lib/orders-store.js';
import type { OrderSlim } from '../src/services/orders.service.js';
import { hojeBRT } from '../src/lib/datas-brt.js';
import { ymdMenosDias } from '../src/services/orders-metrics.service.js';
import {
  INVENTARIO_DIAS_PADRAO, classificarPorTotal, diasInclusive, lerInventario,
  resolverPeriodoInventario, resolverProduto,
} from '../src/services/inventory-read.service.js';
import type { EstoqueSkuLinha } from '../src/services/inventory.service.js';

let cache: FakeCache;
beforeEach(() => {
  cache = new FakeCache();
  Object.assign(process.env, TEST_ENV);
  resetEnvForTests();
});

function item(o: Partial<ItemSlim> & { id: string }): ItemSlim {
  return {
    title: 'Vinho ' + o.id, status: 'active', price: 100, original_price: null,
    available_quantity: 0, sold_quantity: null, listing_type_id: 'gold_special',
    catalog_listing: false, inventory_id: null, permalink: null, thumbnail: null,
    last_updated: null, seller_custom_field: null, seller_sku: null, tags: [],
    shipping: { logistic_type: 'drop_off' }, attributes: null,
    ...o,
  };
}
const full = (o: Partial<ItemSlim> & { id: string }) =>
  item({ ...o, tags: ['fulfillment'], shipping: { logistic_type: 'fulfillment' } });

async function publicarCatalogo(itens: ItemSlim[]) {
  const chave = await writeCatalogChunk(cache, 1, 0, itens);
  const man: CatalogManifest = {
    versao: 1, chunks: [chave],
    counts: {
      total: itens.length,
      active: itens.filter(i => i.status === 'active').length,
      paused: itens.filter(i => i.status === 'paused').length,
      closed: itens.filter(i => i.status === 'closed').length,
    },
    chunkSize: 500, updatedAt: new Date().toISOString(), complete: true,
  };
  await publishCatalog(cache, man);
}

async function publicarPedidos(unidades: Record<string, number>) {
  const hoje = hojeBRT();
  const pedidos: OrderSlim[] = [];
  let seq = 1;
  for (const [itemId, n] of Object.entries(unidades)) {
    for (let i = 0; i < n; i++) {
      pedidos.push({
        id: seq++, status: 'paid', date_created: `${hoje}T10:00:00.000-03:00`,
        paid_amount: 100, total_amount: 100,
        order_items: [{ quantity: 1, unit_price: 100, item: { id: itemId, title: 'V', seller_sku: null, variation_id: null } }],
      });
    }
  }
  const chave = await writeChunk(cache, 'ativos', 1, 0, pedidos);
  const man: OrdersManifest = {
    versao: 1, chunks: [chave], totalRegistros: pedidos.length,
    oldestDate: `${hoje}T00:00:00.000-03:00`, newestDate: `${hoje}T23:59:59.999-03:00`,
    chunkSize: 500, updatedAt: new Date().toISOString(), origem: 'full',
  };
  await publishManifest(cache, 'ativos', man);
}

const janela30 = () => ({ fromYmd: ymdMenosDias(hojeBRT(), 29), toYmd: hojeBRT() });

/**
 * Cenário de conferência semântica. Trinta unidades na janela de 30 dias dão
 * velocidade 1,00/dia, então os dias de cobertura são o próprio saldo.
 *
 *   AMBOS  próprio 20 + Full 100 → total 120, vende 30
 *   SOFULL próprio  0 + Full 500 → total 500, vende 30
 *   SOPROP próprio 40            → total  40, vende 30
 *   ZERO   próprio  0            → total   0, sem venda
 *   PARADO próprio 70            → total  70, sem venda
 *   MULTI  dois anúncios próprios com inventory_id COMPARTILHADO
 */
const CENARIO: ItemSlim[] = [
  item({ id: 'MLB-AMB-P', seller_custom_field: 'AMBOS', title: 'Ambos os Lados', available_quantity: 20 }),
  full({ id: 'MLB-AMB-F', seller_custom_field: 'AMBOS', title: 'Ambos os Lados', available_quantity: 100, inventory_id: 'INV-AMB' }),
  item({ id: 'MLB-SF-P', seller_custom_field: 'SOFULL', title: 'So no Full', available_quantity: 0 }),
  full({ id: 'MLB-SF-F', seller_custom_field: 'SOFULL', title: 'So no Full', available_quantity: 500, inventory_id: 'INV-SF' }),
  item({ id: 'MLB-SP', seller_custom_field: 'SOPROP', title: 'So Proprio', available_quantity: 40 }),
  item({ id: 'MLB-ZE', seller_custom_field: 'ZERO', title: 'Zerado', available_quantity: 0 }),
  item({ id: 'MLB-PA', seller_custom_field: 'PARADO', title: 'Parado', available_quantity: 70 }),
  item({ id: 'MLB-MU-1', seller_custom_field: 'MULTI', title: 'Multi Anuncio', available_quantity: 33, inventory_id: 'INV-MU' }),
  item({ id: 'MLB-MU-2', seller_custom_field: 'MULTI', title: 'Multi Anuncio', available_quantity: 33, inventory_id: 'INV-MU' }),
];
const VENDAS = { 'MLB-AMB-F': 30, 'MLB-SF-F': 30, 'MLB-SP': 30, 'MLB-MU-1': 30 };

async function inventario(escopo: 'proprio' | 'full' | 'ambos' = 'ambos') {
  await publicarCatalogo(CENARIO);
  await publicarPedidos(VENDAS);
  const r = await lerInventario(cache, { periodo: janela30(), escopo });
  if (!r.ok) throw new Error('esperava ok, veio ' + r.code);
  return r.value;
}
const porSku = (linhas: EstoqueSkuLinha[] | null, sku: string) =>
  (linhas ?? []).find(l => l.sku === sku)!;

// ══════════════════════════════════════════════════════════════════════════
describe('inventory-read — período', () => {
  const agora = new Date('2026-07-23T15:00:00.000-03:00');

  it('dias=N são N dias civis terminando hoje', () => {
    const r = resolverPeriodoInventario({ dias: '30' }, agora);
    expect(r).toEqual({ ok: true, periodo: { fromYmd: '2026-06-24', toYmd: '2026-07-23' } });
  });

  it('sem parâmetro usa a janela padrão de 30 dias', () => {
    const r = resolverPeriodoInventario({}, agora);
    expect(r.ok && r.periodo).toEqual({ fromYmd: '2026-06-24', toYmd: '2026-07-23' });
    expect(INVENTARIO_DIAS_PADRAO).toBe(30);
  });

  it('60 e 90 dias', () => {
    const r60 = resolverPeriodoInventario({ dias: '60' }, agora);
    const r90 = resolverPeriodoInventario({ dias: '90' }, agora);
    expect(r60.ok && r60.periodo).toEqual({ fromYmd: '2026-05-25', toYmd: '2026-07-23' });
    expect(r90.ok && r90.periodo).toEqual({ fromYmd: '2026-04-25', toYmd: '2026-07-23' });
  });

  it('dias=1 é só hoje', () => {
    const r = resolverPeriodoInventario({ dias: '1' }, agora);
    expect(r.ok && r.periodo).toEqual({ fromYmd: '2026-07-23', toYmd: '2026-07-23' });
  });

  it('intervalo explícito passa intocado', () => {
    const r = resolverPeriodoInventario({ from: '2026-07-01', to: '2026-07-10' }, agora);
    expect(r.ok && r.periodo).toEqual({ fromYmd: '2026-07-01', toYmd: '2026-07-10' });
  });

  it('a validação continua sendo a de resolverPeriodo', () => {
    expect(resolverPeriodoInventario({ dias: 'x' }, agora)).toEqual({ ok: false, erro: 'dias_invalido' });
    expect(resolverPeriodoInventario({ dias: '30', from: '2026-07-01' }, agora))
      .toEqual({ ok: false, erro: 'combinacao_invalida' });
    expect(resolverPeriodoInventario({ from: '2026-07-10', to: '2026-07-01' }, agora))
      .toEqual({ ok: false, erro: 'intervalo_invertido' });
  });

  it('diasInclusive conta as duas bordas', () => {
    expect(diasInclusive('2026-07-23', '2026-07-23')).toBe(1);
    expect(diasInclusive('2026-06-24', '2026-07-23')).toBe(30);
  });
});

describe('inventory-read — conferência semântica dos saldos', () => {
  it('estTotal = estProprio + estFull em TODA linha', async () => {
    const inv = await inventario();
    for (const l of inv.proprio!) {
      expect(l.estTotal, l.sku).toBe(l.estProprio + l.estFull);
    }
  });

  it('SKU presente nos dois lados soma sem duplicar', async () => {
    const l = porSku((await inventario()).proprio, 'AMBOS');
    expect(l.estProprio).toBe(20);
    expect(l.estFull).toBe(100);
    expect(l.estTotal).toBe(120);
    expect(l.anuncios).toBe(2);
  });

  it('SKU somente Full tem próprio zero e total igual ao Full', async () => {
    const l = porSku((await inventario()).proprio, 'SOFULL');
    expect(l.estProprio).toBe(0);
    expect(l.estFull).toBe(500);
    expect(l.estTotal).toBe(500);
  });

  it('SKU somente próprio não inventa saldo no Full', async () => {
    const l = porSku((await inventario()).proprio, 'SOPROP');
    expect(l.estFull).toBe(0);
    expect(l.estTotal).toBe(40);
  });

  it('SKU zerado fica zerado, sem virar negativo nem null', async () => {
    const l = porSku((await inventario()).proprio, 'ZERO');
    expect(l.estProprio).toBe(0);
    expect(l.estTotal).toBe(0);
  });

  it('dois anúncios com o MESMO inventory_id contam uma vez', async () => {
    // 33 + 33 no mesmo saldo físico = 33, não 66.
    const l = porSku((await inventario()).proprio, 'MULTI');
    expect(l.anuncios).toBe(2);
    expect(l.estProprio).toBe(33);
  });
});

describe('inventory-read — conferência da classificação', () => {
  it('base própria: cobertura = saldo próprio ÷ velocidade', async () => {
    const inv = await inventario();
    const amb = porSku(inv.proprio, 'AMBOS');
    expect(amb.vendasPeriodo).toBe(30);
    expect(amb.velocidadeDia).toBe(1);
    expect(amb.diasCobertura).toBe(20);   // 20 próprios ÷ 1 por dia
    expect(amb.tipo).toBe('ruptura');     // < 30 dias
  });

  it('base total: mesma velocidade, saldo total', async () => {
    const inv = await inventario();
    const amb = porSku(inv.total, 'AMBOS');
    expect(amb.velocidadeDia).toBe(1);
    expect(amb.diasCobertura).toBe(120);  // 120 totais ÷ 1 por dia
    expect(amb.tipo).toBe('ok');          // 90..365
  });

  it('o SKU só do Full sai de ruptura ao olhar o total', async () => {
    const inv = await inventario();
    expect(porSku(inv.proprio, 'SOFULL').tipo).toBe('ruptura');  // 0 próprio
    expect(porSku(inv.total, 'SOFULL').tipo).toBe('excesso');    // 500 dias
  });

  it('sem venda continua sem venda nas duas bases', async () => {
    const inv = await inventario();
    expect(porSku(inv.proprio, 'PARADO').tipo).toBe('semvenda');
    expect(porSku(inv.total, 'PARADO').tipo).toBe('semvenda');
    expect(porSku(inv.proprio, 'PARADO').diasCobertura).toBeNull();
  });

  it('a base total NÃO muda saldo, só a classificação', async () => {
    const inv = await inventario();
    for (const l of inv.total!) {
      const p = porSku(inv.proprio, l.sku);
      expect(l.estProprio, l.sku).toBe(p.estProprio);
      expect(l.estFull, l.sku).toBe(p.estFull);
      expect(l.estTotal, l.sku).toBe(p.estTotal);
      expect(l.vendasPeriodo, l.sku).toBe(p.vendasPeriodo);
    }
  });

  it('classificarPorTotal é puro: não muta a entrada', async () => {
    const inv = await inventario();
    const antes = JSON.stringify(inv.proprio);
    classificarPorTotal(inv.proprio!, 30);
    expect(JSON.stringify(inv.proprio)).toBe(antes);
  });

  it('sem vendas não classifica, em nenhuma base', async () => {
    await publicarCatalogo(CENARIO);
    const r = await lerInventario(cache, { periodo: janela30() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.vendasDisponiveis).toBe(false);
    for (const l of r.value.total!) expect(l.tipo, l.sku).toBeNull();
  });

  it('a ordenação é a operacional: ruptura primeiro, menor cobertura antes', async () => {
    const inv = await inventario();
    const tipos = inv.total!.filter(l => l.tipo).map(l => l.tipo);
    const ordem = ['ruptura', 'alerta', 'ok', 'excesso', 'semvenda'];
    const idx = tipos.map(t => ordem.indexOf(t!));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });
});

describe('inventory-read — escopo', () => {
  it('escopo ambos traz os três blocos', async () => {
    const inv = await inventario('ambos');
    expect(inv.proprio).not.toBeNull();
    expect(inv.full).not.toBeNull();
    expect(inv.total).not.toBeNull();
  });

  it('escopo proprio não calcula Full nem total', async () => {
    const inv = await inventario('proprio');
    expect(inv.full).toBeNull();
    expect(inv.total).toBeNull();
  });

  it('escopo full não calcula próprio nem total', async () => {
    const inv = await inventario('full');
    expect(inv.proprio).toBeNull();
    expect(inv.total).toBeNull();
  });
});

describe('inventory-read — resolução de produto', () => {
  const linhas = [
    { sku: '21002', label: 'Arcos do Convento 750ml', semSku: false },
    { sku: 'SKU-21004', label: 'Arcos do Convento Branco', semSku: false },
    { sku: '26401', label: 'Magnanimo Gran Reserva', semSku: false },
    { sku: 'sem-sku-MLB9', label: 'Sem sku nenhum', semSku: true },
  ];

  it('SKU exato', () => {
    const r = resolverProduto(linhas, '21002');
    expect(r.kind === 'encontrado' && r.linha.sku).toBe('21002');
  });

  it('SKU normalizado ignora separadores', () => {
    const r = resolverProduto(linhas, 'sku 21004');
    expect(r.kind === 'encontrado' && r.linha.sku).toBe('SKU-21004');
  });

  it('título normalizado exato', () => {
    const r = resolverProduto(linhas, 'magnanimo gran reserva');
    expect(r.kind === 'encontrado' && r.linha.sku).toBe('26401');
  });

  it('correspondência contida só quando é única', () => {
    const r = resolverProduto(linhas, 'magnanimo');
    expect(r.kind === 'encontrado' && r.linha.sku).toBe('26401');
  });

  it('vários candidatos devolvem ambiguidade com a lista', () => {
    const r = resolverProduto(linhas, 'arcos do convento');
    expect(r.kind).toBe('ambiguo');
    if (r.kind !== 'ambiguo') return;
    expect(r.candidatos.map(c => c.sku)).toEqual(['21002', 'SKU-21004']);
  });

  it('SKU exato vence título parecido', () => {
    const comColisao = [...linhas, { sku: 'arcos do convento', label: 'Outro', semSku: false }];
    const r = resolverProduto(comColisao, 'arcos do convento');
    expect(r.kind === 'encontrado' && r.linha.label).toBe('Outro');
  });

  it('termo desconhecido é ausente, não ambíguo', () => {
    expect(resolverProduto(linhas, 'chateau inexistente').kind).toBe('ausente');
  });

  it('termo vazio é ausente', () => {
    expect(resolverProduto(linhas, '   ').kind).toBe('ausente');
  });

  it('linha sem SKU real nunca casa por SKU', () => {
    expect(resolverProduto(linhas, 'sem-sku-MLB9').kind).toBe('ausente');
  });
});

describe('inventory-read — falhas nomeadas', () => {
  it('sem catálogo publicado', async () => {
    const r = await lerInventario(cache, { periodo: janela30() });
    expect(r).toEqual({ ok: false, code: 'catalogo_indisponivel' });
  });

  it('catálogo vazio', async () => {
    await publicarCatalogo([]);
    const r = await lerInventario(cache, { periodo: janela30() });
    expect(r).toEqual({ ok: false, code: 'catalogo_vazio' });
  });

  it('modo legado com saldo negativo vira falha nomeada, não exceção', async () => {
    await publicarCatalogo([
      item({ id: 'MLB-N', seller_custom_field: 'NEG', available_quantity: -4, inventory_id: 'IN1' }),
    ]);
    await publicarPedidos({ 'MLB-N': 1 });
    const r = await lerInventario(cache, { periodo: janela30(), modo: 'legado' });
    expect(r).toEqual({ ok: false, code: 'saldo_invalido_no_modo_legado' });
  });

  it('modo seguro normaliza o negativo e segue', async () => {
    await publicarCatalogo([
      item({ id: 'MLB-N', seller_custom_field: 'NEG', available_quantity: -4, inventory_id: 'IN1' }),
    ]);
    await publicarPedidos({ 'MLB-N': 1 });
    const r = await lerInventario(cache, { periodo: janela30() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(porSku(r.value.proprio, 'NEG').estProprio).toBe(0);
    expect(porSku(r.value.proprio, 'NEG').alertas.some(a => a.tipo === 'saldo_negativo_normalizado')).toBe(true);
  });
});
