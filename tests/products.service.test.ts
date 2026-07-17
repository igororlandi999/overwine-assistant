import { describe, it, expect } from 'vitest';
import {
  itemSKU,
  normalizeTitle,
  getCustoUnitario,
  buildConsolidado,
  carregarCustos,
  type ProductItemInput,
  type OrderInput,
  type CustoRegra,
} from '../src/services/products.service.js';

// ══════════════════════════════════════════════════════════════════════════
// itemSKU
// ══════════════════════════════════════════════════════════════════════════
describe('itemSKU', () => {
  const base: ProductItemInput = { id: 'MLB1' };

  it('SKU principal (seller_custom_field) presente', () => {
    expect(itemSKU({ ...base, seller_custom_field: '21002' })).toBe('21002');
  });

  it('SKU disponível apenas no atributo SELLER_SKU', () => {
    expect(
      itemSKU({ ...base, attributes: [{ id: 'BRAND', value_name: 'X' }, { id: 'SELLER_SKU', value_name: '25001' }] })
    ).toBe('25001');
  });

  it('SKU vazio ou só espaços cai para a próxima fonte', () => {
    expect(
      itemSKU({ ...base, seller_custom_field: '   ', attributes: [{ id: 'SELLER_SKU', value_name: '25001' }] })
    ).toBe('25001');
    expect(itemSKU({ ...base, seller_custom_field: '' , seller_sku: '30001' })).toBe('30001');
  });

  it('produto sem nenhum SKU confiável retorna null (nunca inventa pelo título)', () => {
    expect(itemSKU({ ...base, title: 'Vinho Carrascal' })).toBeNull();
    expect(itemSKU({ ...base, attributes: [{ id: 'SELLER_SKU', value_name: '   ' }] })).toBeNull();
  });

  it('normaliza espaços laterais e nunca retorna string vazia', () => {
    expect(itemSKU({ ...base, seller_custom_field: '  21003  ' })).toBe('21003');
    const r = itemSKU({ ...base, seller_custom_field: ' ' });
    expect(r).not.toBe('');
    expect(r).toBeNull();
  });

  it('prioridade: seller_custom_field > atributo SELLER_SKU > seller_sku', () => {
    expect(
      itemSKU({
        ...base,
        seller_custom_field: 'A',
        seller_sku: 'C',
        attributes: [{ id: 'SELLER_SKU', value_name: 'B' }],
      })
    ).toBe('A');
    expect(
      itemSKU({ ...base, seller_sku: 'C', attributes: [{ id: 'SELLER_SKU', value_name: 'B' }] })
    ).toBe('B');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// normalizeTitle
// ══════════════════════════════════════════════════════════════════════════
describe('normalizeTitle', () => {
  it('acentos são PRESERVADOS (paridade com o legado — só minúsculas)', () => {
    expect(normalizeTitle('Quinta do Côro MAESTRO')).toBe('quinta do côro maestro');
  });

  it('maiúsculas/minúsculas', () => {
    expect(normalizeTitle('VINHO CARRASCAL Tinto')).toBe('vinho carrascal tinto');
  });

  it('espaços duplicados e laterais', () => {
    expect(normalizeTitle('  Vinho   Ouro   Meu  ')).toBe('vinho ouro meu');
  });

  it('caracteres especiais de logística e kits são tratados como no legado', () => {
    expect(normalizeTitle('Vinho Ouro Meu - FULL envio rápido')).toBe('vinho ouro meu');
    expect(normalizeTitle('Vinho Ouro Meu Kit com 6 unidades')).toBe('vinho ouro meu');
    expect(normalizeTitle('Vinho Ouro Meu Pack 3')).toBe('vinho ouro meu');
    expect(normalizeTitle('Vinho Ouro Meu Caixa 12 garrafas')).toBe('vinho ouro meu');
    expect(normalizeTitle('Arcos do Convento 5 Lts')).toBe('arcos do convento 5 litros');
    expect(normalizeTitle('Arcos do Convento 5L')).toBe('arcos do convento 5 litros');
  });

  it('entrada ausente vira string vazia (endurecimento documentado)', () => {
    expect(normalizeTitle(null)).toBe('');
    expect(normalizeTitle(undefined)).toBe('');
    expect(normalizeTitle('')).toBe('');
  });

  it('dois títulos equivalentes resultam na MESMA normalização', () => {
    const a = normalizeTitle('Vinho Ouro Meu Tinto - Full');
    const b = normalizeTitle('  VINHO  Ouro Meu   Tinto  ');
    expect(a).toBe(b);
    expect(a).toBe('vinho ouro meu tinto');
  });

  it('é determinística (mesma entrada, mesma saída, sem estado)', () => {
    const t = 'Além do Rio Rosé Kit 2';
    expect(normalizeTitle(t)).toBe(normalizeTitle(t));
  });
});

// ══════════════════════════════════════════════════════════════════════════
// getCustoUnitario
// ══════════════════════════════════════════════════════════════════════════
describe('getCustoUnitario', () => {
  it('produto com custo conhecido retorna contrato completo', () => {
    const r = getCustoUnitario('Vinho Carrascal Colheita 2020');
    expect(r).toEqual({
      encontrado: true,
      custoUnitario: 17.81,
      fonte: 'dashboard_legado',
      regraId: 'carrascal',
    });
  });

  it('produto desconhecido: encontrado false e custo null — NUNCA zero', () => {
    const r = getCustoUnitario('Vinho Inexistente da Serra');
    expect(r.encontrado).toBe(false);
    expect(r.custoUnitario).toBeNull();
    expect(r.custoUnitario).not.toBe(0);
    expect(r.fonte).toBeNull();
    expect(r.regraId).toBeNull();
  });

  it('match parcial válido (termo no meio do título, com acento divergente)', () => {
    const r = getCustoUnitario('Promoção MORABITINO Safra Especial 2019');
    expect(r.encontrado).toBe(true);
    expect(r.custoUnitario).toBe(31.56);
  });

  it('regra com exclusão bloqueia e a precedência escolhe a regra seguinte', () => {
    // 'Além do Rio Branco Rosé': regra 1 casa match e tipo (branco), mas a
    // exclusão (rose) bloqueia; a regra 2 (rosé) vence.
    const r = getCustoUnitario('Além do Rio Branco Rosé');
    expect(r.regraId).toBe('alem_rio_rose');
    expect(r.custoUnitario).toBe(14.15);
  });

  it('conflito entre duas regras é resolvido pela ordem explícita', () => {
    // Gran Reserva casa as duas regras djoao_*; a de menor `ordem` vence.
    const gran = getCustoUnitario('D. João V Magnânimo Gran Reserva');
    expect(gran.regraId).toBe('djoao_gran_reserva');
    expect(gran.custoUnitario).toBe(76.33);
    // Sem 'gran', a regra reserva (ordem 10) vence antes da branco (11).
    const reserva = getCustoUnitario('D. João V Magnânimo Reserva Tinto');
    expect(reserva.regraId).toBe('djoao_reserva');
    expect(reserva.custoUnitario).toBe(40.6);
  });

  it('custo zero legítimo é distinguível de custo ausente', () => {
    const regras: CustoRegra[] = [
      { ordem: 1, id: 'brinde', custoUnitario: 0, match: ['brinde overwine'] },
    ];
    const zero = getCustoUnitario('Brinde Overwine Saca-rolhas', null, regras, 'teste');
    expect(zero).toEqual({ encontrado: true, custoUnitario: 0, fonte: 'teste', regraId: 'brinde' });
    const ausente = getCustoUnitario('Outro produto', null, regras, 'teste');
    expect(ausente.encontrado).toBe(false);
    expect(ausente.custoUnitario).toBeNull();
  });

  it('título vazio/ausente nunca encontra custo', () => {
    expect(getCustoUnitario('').encontrado).toBe(false);
    expect(getCustoUnitario(null).encontrado).toBe(false);
    expect(getCustoUnitario(undefined).encontrado).toBe(false);
  });

  it('o parâmetro sku é aceito mas não altera o matching (paridade legado)', () => {
    const semSku = getCustoUnitario('Vinho Carrascal');
    const comSku = getCustoUnitario('Vinho Carrascal', '21002');
    expect(comSku).toEqual(semSku);
  });

  // ── Paridade: TODAS as 25 regras do CUSTO_PRODUTO legado ────────────────
  const paridade: Array<[string, string, number]> = [
    ['alem_rio_branco',      'Vinho Além do Rio Branco 750ml',            14.15],
    ['alem_rio_rose',        'Vinho Além do Rio Rosé Frisante',           14.15],
    ['arcos_750',            'Arcos do Convento Tinto 750ml',             13.02],
    ['arcos_bib',            'Arcos do Convento Bag In Box 5 Litros',     47.15],
    ['vitoria_regia',        'Vinho Vitória Régia Tinto Seco',            16.79],
    ['carrascal',            'Carrascal Colheita Tinto',                  17.81],
    ['capricho_marselan',    'Capricho do Rei Marselan',                  24.14],
    ['morabitino',           'Morabitino Tinto Português',                31.56],
    ['djoao_gran_reserva',   'D. João V Magnânimo Gran Reserva',          76.33],
    ['djoao_reserva',        'D. João V Magnânimo Reserva Tinto',         40.6],
    ['djoao_branco',         'Magnânimo Branco Seco',                     40.6],
    ['quinta_sao_cristovao', 'Quinta de São Cristóvão Tinto',             21.82],
    ['allgodao',             'Allgodão Reserva Tinto',                    29.13],
    ['ouro_meu_exclusive',   'Ouro Meu Exclusive Edition Tinto',          14.62],
    ['ouro_meu_base',        'Vinho Ouro Meu Tinto Seco',                 13.62],
    ['bolota_dourada',       'Bolota Dourada Tinto',                      37.37],
    ['ouro_obidos',          'Ouro de Óbidos Tinto',                      38.19],
    ['cajado_real',          'Cajado Real Tinto Português',               33.82],
    ['hfc',                  'HFC Alicante Bouschet',                     36.84],
    ['coro_maestro',         'Quinta do Côro Maestro',                    17.41],
    ['coro_private',         'Quinta do Côro Private Collection',         43.08],
    ['coro_reserva',         'Quinta do Côro Reserva Syrah',              40.48],
    ['estremoz_aragones',    'Marquês de Estremoz Aragonês',              60.1],
    ['estremoz_reserva',     'Marquês de Estremoz Reserva',               31.98],
    ['beiral',               'Beiral Vineyards Tinto',                    42.99],
  ];

  it.each(paridade)('paridade legado: %s', (regraId, titulo, custo) => {
    const r = getCustoUnitario(titulo);
    expect(r.encontrado).toBe(true);
    expect(r.regraId).toBe(regraId);
    expect(r.custoUnitario).toBe(custo);
  });

  it('a tabela carregada tem exatamente as 25 regras do legado, sem ordem duplicada', () => {
    const { regrasOrdenadas } = carregarCustos();
    expect(regrasOrdenadas).toHaveLength(25);
    expect(new Set(regrasOrdenadas.map(r => r.id)).size).toBe(25);
    // ordenada de forma estrita
    for (let i = 1; i < regrasOrdenadas.length; i++) {
      expect(regrasOrdenadas[i].ordem).toBeGreaterThan(regrasOrdenadas[i - 1].ordem);
    }
  });

  it('precedência independe da ordem do array recebido (ordena por `ordem`)', () => {
    const { regrasOrdenadas } = carregarCustos();
    const invertidas = [...regrasOrdenadas].reverse();
    // getCustoUnitario recebe regras já ordenadas por contrato; quem embaralha
    // deve reordenar via carregarCustos. Este teste garante que carregarCustos
    // reordena mesmo com o arquivo embaralhado.
    const embaralhado = carregarCustos({
      versao: 1,
      moeda: 'BRL',
      fonte: 'teste',
      regras: invertidas,
    });
    expect(embaralhado.regrasOrdenadas[0].id).toBe('alem_rio_branco');
    const r = getCustoUnitario(
      'D. João V Magnânimo Gran Reserva',
      null,
      embaralhado.regrasOrdenadas,
      'teste'
    );
    expect(r.regraId).toBe('djoao_gran_reserva');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// buildConsolidado
// ══════════════════════════════════════════════════════════════════════════
describe('buildConsolidado', () => {
  const item = (over: Partial<ProductItemInput> & { id: string }): ProductItemInput => ({
    title: 'Produto Teste',
    status: 'active',
    price: 50,
    sold_quantity: 0,
    ...over,
  });

  const pedido = (over: Partial<OrderInput> & { id: number | string }): OrderInput => ({
    status: 'paid',
    ...over,
  });

  it('um SKU com um anúncio', () => {
    const linhas = buildConsolidado(
      [item({ id: 'MLB1', seller_custom_field: '21002', sold_quantity: 7, title: 'Vinho A' })],
      []
    );
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      sku: '21002',
      semSku: false,
      label: 'Vinho A',
      anuncios: 1,
      itemIds: ['MLB1'],
      vendasTotal: 7,
      pedidosCnt: 0,
      precoMedioVendido: 0,
      qtdVendida: 0,
      estTotal: null,
    });
  });

  it('um SKU com anúncio clássico e premium consolida em UM grupo', () => {
    const linhas = buildConsolidado(
      [
        item({ id: 'MLB1', seller_custom_field: '21002', title: 'Vinho A Clássico Longo', price: 50 }),
        item({ id: 'MLB2', seller_custom_field: '21002', title: 'Vinho A', price: 60 }),
      ],
      []
    );
    expect(linhas).toHaveLength(1);
    expect(linhas[0].anuncios).toBe(2);
    expect(linhas[0].itemIds).toEqual(['MLB1', 'MLB2']);
    expect(linhas[0].label).toBe('Vinho A'); // título mais curto vence
    // média SIMPLES dos preços listados (paridade legado)
    expect(linhas[0].precoMedioAnuncios).toBe(55);
  });

  it('várias vendas do mesmo SKU somam pedidos e unidades', () => {
    const linhas = buildConsolidado(
      [item({ id: 'MLB1', seller_custom_field: '21002' })],
      [
        pedido({ id: 1, paid_amount: 100, order_items: [{ quantity: 2, item: { id: 'MLB1' } }] }),
        pedido({ id: 2, paid_amount: 60, order_items: [{ quantity: 1, item: { id: 'MLB1' } }] }),
      ]
    );
    expect(linhas[0].pedidosCnt).toBe(2);
    expect(linhas[0].qtdVendida).toBe(3);
  });

  it('preço médio vendido é PONDERADO por quantidade, não média simples', () => {
    // Pedido 1: 3 un por R$ 90 (30/un). Pedido 2: 1 un por R$ 70 (70/un).
    // Ponderado = 160/4 = 40. Média simples de preços unitários seria 50.
    const linhas = buildConsolidado(
      [item({ id: 'MLB1', seller_custom_field: '21002' })],
      [
        pedido({ id: 1, paid_amount: 90, order_items: [{ quantity: 3, item: { id: 'MLB1' } }] }),
        pedido({ id: 2, paid_amount: 70, order_items: [{ quantity: 1, item: { id: 'MLB1' } }] }),
      ]
    );
    expect(linhas[0].precoMedioVendido).toBe(40);
  });

  it('pedido cancelado não conta em pedidosCnt nem no ponderado', () => {
    const linhas = buildConsolidado(
      [item({ id: 'MLB1', seller_custom_field: '21002' })],
      [
        pedido({ id: 1, status: 'cancelled', paid_amount: 999, order_items: [{ quantity: 5, item: { id: 'MLB1' } }] }),
        pedido({ id: 2, paid_amount: 60, order_items: [{ quantity: 1, item: { id: 'MLB1' } }] }),
      ]
    );
    expect(linhas[0].pedidosCnt).toBe(1);
    expect(linhas[0].qtdVendida).toBe(1);
    expect(linhas[0].precoMedioVendido).toBe(60);
  });

  it('pedido não pago (não cancelado) CONTA — paridade com o legado', () => {
    const linhas = buildConsolidado(
      [item({ id: 'MLB1', seller_custom_field: '21002' })],
      [pedido({ id: 1, status: 'payment_required', paid_amount: 0, total_amount: 80, order_items: [{ quantity: 1, item: { id: 'MLB1' } }] })]
    );
    expect(linhas[0].pedidosCnt).toBe(1);
    // paid_amount 0 → fallback total_amount (comportamento legado: || )
    expect(linhas[0].precoMedioVendido).toBe(80);
  });

  it('pedido com vários itens é atribuído SOMENTE ao grupo do primeiro item (quirk legado)', () => {
    const linhas = buildConsolidado(
      [
        item({ id: 'MLB1', seller_custom_field: 'A', title: 'Produto A' }),
        item({ id: 'MLB2', seller_custom_field: 'B', title: 'Produto B' }),
      ],
      [
        pedido({
          id: 1,
          paid_amount: 100,
          order_items: [
            { quantity: 1, item: { id: 'MLB1' } },
            { quantity: 4, item: { id: 'MLB2' } },
          ],
        }),
      ]
    );
    const a = linhas.find(l => l.sku === 'A')!;
    const b = linhas.find(l => l.sku === 'B')!;
    expect(a.pedidosCnt).toBe(1);
    expect(a.qtdVendida).toBe(1); // apenas a quantidade do PRIMEIRO order_item
    expect(b.pedidosCnt).toBe(0); // segundo item não indexa o pedido
    expect(b.qtdVendida).toBe(0);
  });

  it('produto sem SKU vira grupo próprio sem fabricar SKU real', () => {
    const linhas = buildConsolidado(
      [item({ id: 'MLB9', title: 'Sem SKU' }), item({ id: 'MLB8', title: 'Também sem' })],
      []
    );
    expect(linhas).toHaveLength(2);
    const g9 = linhas.find(l => l.sku === 'sem-sku-MLB9')!;
    expect(g9.semSku).toBe(true);
    expect(g9.anuncios).toBe(1);
  });

  it('dois anúncios do grupo no mesmo pedido: pedido contado UMA vez (dedup legado por indexação)', () => {
    const linhas = buildConsolidado(
      [
        item({ id: 'MLB1', seller_custom_field: '21002' }),
        item({ id: 'MLB2', seller_custom_field: '21002' }),
      ],
      [
        pedido({
          id: 1,
          paid_amount: 100,
          order_items: [
            { quantity: 1, item: { id: 'MLB1' } },
            { quantity: 1, item: { id: 'MLB2' } },
          ],
        }),
      ]
    );
    expect(linhas).toHaveLength(1);
    // Indexado só pelo primeiro order_item → 1 pedido, não 2.
    expect(linhas[0].pedidosCnt).toBe(1);
    expect(linhas[0].qtdVendida).toBe(1);
  });

  it('itens sem título ou com dados incompletos não quebram (endurecimento)', () => {
    const linhas = buildConsolidado(
      [
        { id: 'MLB1', seller_custom_field: '21002' }, // sem title, price, status...
        item({ id: 'MLB2', seller_custom_field: '21002', title: 'Com Título' }),
      ],
      [pedido({ id: 1, order_items: [{ item: { id: 'MLB1' } }] })] // sem quantity/paid
    );
    expect(linhas).toHaveLength(1);
    expect(linhas[0].label).toBe('Com Título'); // título ausente não disputa o label
    expect(linhas[0].pedidosCnt).toBe(1);
    expect(linhas[0].qtdVendida).toBe(1); // quantity ausente → 1 (paridade: || 1)
    expect(linhas[0].precoMedioVendido).toBe(0); // sem valor pago → 0/1
  });

  it('ordem de entrada diferente produz a MESMA saída lógica', () => {
    const itens = [
      item({ id: 'MLB1', seller_custom_field: 'A', sold_quantity: 5, title: 'A1' }),
      item({ id: 'MLB2', seller_custom_field: 'B', sold_quantity: 5, title: 'B1' }),
      item({ id: 'MLB3', seller_custom_field: 'C', sold_quantity: 9, title: 'C1' }),
    ];
    const pedidos = [
      pedido({ id: 1, paid_amount: 10, order_items: [{ quantity: 1, item: { id: 'MLB1' } }] }),
      pedido({ id: 2, paid_amount: 10, order_items: [{ quantity: 1, item: { id: 'MLB2' } }] }),
    ];
    const normal = buildConsolidado(itens, pedidos);
    const invertido = buildConsolidado([...itens].reverse(), [...pedidos].reverse());
    expect(invertido).toEqual(normal);
    // A e B empatam em pedidos e vendas → desempate determinístico por sku.
    expect(normal.map(l => l.sku)).toEqual(['A', 'B', 'C']);
  });

  it('estTotal usa o callback de estoque quando fornecido (integração futura com inventory)', () => {
    const linhas = buildConsolidado(
      [
        item({ id: 'MLB1', seller_custom_field: '21002' }),
        item({ id: 'MLB2', seller_custom_field: '21002' }),
      ],
      [],
      { calcularEstoqueGrupo: items => items.length * 10 }
    );
    expect(linhas[0].estTotal).toBe(20);
    // sem callback → null (não calculado), nunca zero enganoso
    const semCb = buildConsolidado([item({ id: 'MLB1', seller_custom_field: '21002' })], []);
    expect(semCb[0].estTotal).toBeNull();
  });
});