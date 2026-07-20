import { describe, it, expect } from 'vitest';
import {
  isFullItem,
  fullStockKey,
  fullStockKeyStr,
  consolidarEstoqueGrupo,
  classificarEstoque,
  buildEstoquePorSku,
  buildEstoqueFullPorSku,
  calcularEstoqueTotalGrupo,
  ordenarLinhasClassificaveis,
  LIMITES_CLASSIFICACAO,
  type InventoryItemInput,
  type EstoqueComponente,
} from '../src/services/inventory.service.js';
import { buildConsolidado, type ProductItemInput } from '../src/services/products.service.js';

const item = (over: Partial<InventoryItemInput> & { id: string }): InventoryItemInput => ({
  title: 'Vinho Teste',
  status: 'active',
  available_quantity: 0,
  ...over,
});
const full = (over: Partial<InventoryItemInput> & { id: string }): InventoryItemInput =>
  item({ shipping: { logistic_type: 'fulfillment' }, ...over });

const considerados = (comps: EstoqueComponente[]) => comps.filter(c => c.considerado);

// ══════════════════════════════════════════════════════════════════════════
// IDENTIFICAÇÃO FULL (1-5) + NORMALIZAÇÃO DE SINAIS (item 5 do pedido)
// ══════════════════════════════════════════════════════════════════════════
describe('isFullItem', () => {
  it('1. item claramente Full', () => {
    expect(isFullItem(item({ id: 'A', shipping: { logistic_type: 'fulfillment' } }))).toBe(true);
  });
  it('2. item claramente próprio', () => {
    expect(isFullItem(item({ id: 'A', shipping: { logistic_type: 'drop_off' } }))).toBe(false);
  });
  it('3. shipping ausente → não é Full', () => {
    expect(isFullItem(item({ id: 'A' }))).toBe(false);
    expect(isFullItem(item({ id: 'A', shipping: null }))).toBe(false);
    expect(isFullItem(null)).toBe(false);
    expect(isFullItem(undefined)).toBe(false);
  });
  it('4. sinal secundário: tag fulfillment', () => {
    expect(isFullItem(item({ id: 'A', tags: ['fulfillment'] }))).toBe(true);
    expect(isFullItem(item({ id: 'A', shipping: { logistic_type: 'cross_docking' }, tags: ['fulfillment'] }))).toBe(true);
  });
  it('5. "Full" no título sem sinal logístico NÃO é Full', () => {
    expect(isFullItem(item({ id: 'A', title: 'Vinho Full Body', shipping: { logistic_type: 'drop_off' } }))).toBe(false);
  });

  // Normalização — comportamento por modo (documentado, sem mudar o padrão)
  describe('normalização de sinais (legado estrito vs seguro tolerante)', () => {
    const casos: Array<[string, Partial<InventoryItemInput>]> = [
      ['logistic_type caixa diferente', { shipping: { logistic_type: 'Fulfillment' } }],
      ['logistic_type com espaços', { shipping: { logistic_type: ' fulfillment ' } }],
      ['tag caixa diferente', { tags: ['Fulfillment'] }],
      ['tag com espaços', { tags: [' fulfillment '] }],
    ];
    it.each(casos)('legado é ESTRITO: %s → false', (_n, over) => {
      expect(isFullItem(item({ id: 'A', ...over }), 'legado')).toBe(false);
    });
    it.each(casos)('seguro é TOLERANTE (trim+lowercase): %s → true', (_n, over) => {
      expect(isFullItem(item({ id: 'A', ...over }), 'seguro')).toBe(true);
    });
    it('forma canônica continua Full nos dois modos', () => {
      expect(isFullItem(full({ id: 'A' }), 'legado')).toBe(true);
      expect(isFullItem(full({ id: 'A' }), 'seguro')).toBe(true);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// fullStockKey
// ══════════════════════════════════════════════════════════════════════════
describe('fullStockKey', () => {
  it('usa inventory_id quando presente', () => {
    expect(fullStockKey(item({ id: 'A', inventory_id: 'INV1' }))).toEqual({ origem: 'inventory_id', valor: 'INV1' });
  });
  it('fallback por SKU', () => {
    expect(fullStockKey(item({ id: 'A', seller_custom_field: '21002' }))).toEqual({ origem: 'sku', valor: '21002' });
  });
  it('fallback pelo item', () => {
    expect(fullStockKey(item({ id: 'A' }))).toEqual({ origem: 'item', valor: 'A' });
  });
  it('prefixo impede colisão inventory_id literal vs SKU', () => {
    const kInv = fullStockKeyStr(fullStockKey(item({ id: 'A', inventory_id: 'sku:21002' })));
    const kSku = fullStockKeyStr(fullStockKey(item({ id: 'B', seller_custom_field: '21002' })));
    expect(kInv).not.toBe(kSku);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BUG DE ORDEM CLÁSSICO/PREMIUM — demonstração explícita (item 1 do pedido)
// ══════════════════════════════════════════════════════════════════════════
describe('classe clássico/premium — bug de ordem no legado vs determinismo no seguro', () => {
  // Mesma inventory_id, saldos diferentes; o de MAIOR saldo é premium.
  const classicoPrimeiro = [
    full({ id: 'A', inventory_id: 'INV1', available_quantity: 4, listing_type_id: 'gold_special' }),
    full({ id: 'B', inventory_id: 'INV1', available_quantity: 9, listing_type_id: 'gold_pro' }),
  ];
  const premiumPrimeiro = [...classicoPrimeiro].reverse();

  it('LEGADO: fullClassico/fullPremium DEPENDEM da ordem (bug preservado)', () => {
    const cp = consolidarEstoqueGrupo(classicoPrimeiro, 'legado');
    const pp = consolidarEstoqueGrupo(premiumPrimeiro, 'legado');
    // full/total NÃO variam
    expect(cp.full).toBe(9);
    expect(pp.full).toBe(9);
    expect(cp.total).toBe(9);
    expect(pp.total).toBe(9);
    // mas a PARTIÇÃO clássico/premium diverge conforme o primeiro anúncio:
    expect(cp.fullClassico).toBe(9); // primeiro foi clássico
    expect(cp.fullPremium).toBe(0);
    expect(pp.fullClassico).toBe(0); // primeiro foi premium
    expect(pp.fullPremium).toBe(9);
    // A DIVERGÊNCIA fica explícita:
    expect(cp.fullClassico).not.toBe(pp.fullClassico);
    expect(cp.fullPremium).not.toBe(pp.fullPremium);
  });

  it('SEGURO: classe é DETERMINÍSTICA (maior saldo manda), independe da ordem', () => {
    const cp = consolidarEstoqueGrupo(classicoPrimeiro, 'seguro');
    const pp = consolidarEstoqueGrupo(premiumPrimeiro, 'seguro');
    // o maior saldo (9) é premium → classe da chave = premium, nas duas ordens
    expect(cp.fullClassico).toBe(0);
    expect(cp.fullPremium).toBe(9);
    expect(pp.fullClassico).toBe(0);
    expect(pp.fullPremium).toBe(9);
    expect(cp.fullClassico).toBe(pp.fullClassico);
    expect(cp.fullPremium).toBe(pp.fullPremium);
    // detalhes considerados iguais em conteúdo lógico
    expect(considerados(cp.detalhes.full).map(c => c.itemId)).toEqual(
      considerados(pp.detalhes.full).map(c => c.itemId)
    );
  });

  // No modo seguro, o vencedor determinístico define classe E considerado —
  // são o MESMO anúncio, independente da ordem de entrada.
  const soConsiderado = (comps: EstoqueComponente[]) => {
    const c = considerados(comps);
    expect(c).toHaveLength(1);
    return c[0];
  };
  // Chave lógica completa de um componente para comparação de auditoria.
  const chaveAuditoria = (c: EstoqueComponente) =>
    [c.itemId, c.considerado, c.premium, c.quantidadeOriginal, c.quantidadeConsiderada, c.chaveDedup].join('|');

  it('SEGURO caso 1: mesmo inventory_id, mesmo saldo, ambos clássicos → A único considerado nas 2 ordens', () => {
    const itens = [
      full({ id: 'A', inventory_id: 'INV1', available_quantity: 10, listing_type_id: 'gold_special' }),
      full({ id: 'B', inventory_id: 'INV1', available_quantity: 10, listing_type_id: 'gold_special' }),
    ];
    const normal = consolidarEstoqueGrupo(itens, 'seguro');
    const invert = consolidarEstoqueGrupo([...itens].reverse(), 'seguro');
    // menor itemId lexical (A) vence o empate total
    expect(soConsiderado(normal.detalhes.full).itemId).toBe('A');
    expect(soConsiderado(invert.detalhes.full).itemId).toBe('A');
    // detalhes lógicos completos iguais (ordenados de forma determinística)
    expect(normal.detalhes.full.map(chaveAuditoria)).toEqual(invert.detalhes.full.map(chaveAuditoria));
    expect(normal.fullClassico).toBe(10);
    expect(normal.fullPremium).toBe(0);
  });

  it('SEGURO caso 2: mesmo inventory_id, mesmo saldo, A clássico + B premium → B único considerado nas 2 ordens', () => {
    const itens = [
      full({ id: 'A', inventory_id: 'INV1', available_quantity: 10, listing_type_id: 'gold_special' }),
      full({ id: 'B', inventory_id: 'INV1', available_quantity: 10, listing_type_id: 'gold_pro' }),
    ];
    const normal = consolidarEstoqueGrupo(itens, 'seguro');
    const invert = consolidarEstoqueGrupo([...itens].reverse(), 'seguro');
    // premium vence o empate de saldo
    expect(soConsiderado(normal.detalhes.full).itemId).toBe('B');
    expect(soConsiderado(invert.detalhes.full).itemId).toBe('B');
    expect(normal.fullPremium).toBe(10);
    expect(invert.fullPremium).toBe(10);
    expect(normal.fullPremium).toBe(invert.fullPremium);
    expect(normal.detalhes.full.map(chaveAuditoria)).toEqual(invert.detalhes.full.map(chaveAuditoria));
  });

  it('SEGURO caso 3: mesmo inventory_id, saldos diferentes → maior saldo único considerado nas 2 ordens', () => {
    const itens = [
      full({ id: 'A', inventory_id: 'INV1', available_quantity: 4, listing_type_id: 'gold_special' }),
      full({ id: 'B', inventory_id: 'INV1', available_quantity: 9, listing_type_id: 'gold_pro' }),
    ];
    const normal = consolidarEstoqueGrupo(itens, 'seguro');
    const invert = consolidarEstoqueGrupo([...itens].reverse(), 'seguro');
    expect(soConsiderado(normal.detalhes.full).itemId).toBe('B');
    expect(soConsiderado(invert.detalhes.full).itemId).toBe('B');
    expect(normal.full).toBe(9);
    expect(invert.full).toBe(9);
    expect(normal.detalhes.full.map(chaveAuditoria)).toEqual(invert.detalhes.full.map(chaveAuditoria));
  });

  it('SEGURO caso 4: exatamente 1 considerado por chave e donoItemId lógico == item considerado', () => {
    const itens = [
      full({ id: 'C', inventory_id: 'INV1', available_quantity: 5, listing_type_id: 'gold_special' }),
      full({ id: 'A', inventory_id: 'INV1', available_quantity: 5, listing_type_id: 'gold_pro' }),
      full({ id: 'B', inventory_id: 'INV2', available_quantity: 8, listing_type_id: 'gold_special' }),
      full({ id: 'D', inventory_id: 'INV2', available_quantity: 8, listing_type_id: 'gold_special' }),
    ];
    for (const arr of [itens, [...itens].reverse()]) {
      const r = consolidarEstoqueGrupo(arr, 'seguro');
      const porChave = new Map<string, EstoqueComponente[]>();
      for (const c of r.detalhes.full) {
        (porChave.get(c.chaveDedup) ?? porChave.set(c.chaveDedup, []).get(c.chaveDedup)!).push(c);
      }
      for (const comps of porChave.values()) {
        expect(considerados(comps)).toHaveLength(1); // exatamente 1 por chave
      }
      // INV1: empate de saldo → premium (A). INV2: empate total → menor itemId (B).
      const inv1 = soConsiderado(r.detalhes.full.filter(c => c.chaveDedup === 'inv:INV1'));
      const inv2 = soConsiderado(r.detalhes.full.filter(c => c.chaveDedup === 'inv:INV2'));
      expect(inv1.itemId).toBe('A');
      expect(inv2.itemId).toBe('B');
    }
  });

  it('SEGURO caso 5: auditoria completa idêntica em ordem normal e invertida', () => {
    const itens = [
      full({ id: 'C', inventory_id: 'INV1', available_quantity: 4, listing_type_id: 'gold_special' }),
      full({ id: 'A', inventory_id: 'INV1', available_quantity: 9, listing_type_id: 'gold_pro' }),
      full({ id: 'B', inventory_id: 'INV1', available_quantity: 9, listing_type_id: 'gold_special' }),
    ];
    const normal = consolidarEstoqueGrupo(itens, 'seguro');
    const invert = consolidarEstoqueGrupo([...itens].reverse(), 'seguro');
    // compara itemId, considerado, premium, quantidadeOriginal, quantidadeConsiderada, chaveDedup
    expect(normal.detalhes.full.map(chaveAuditoria)).toEqual(invert.detalhes.full.map(chaveAuditoria));
    // vencedor: empate de saldo 9 entre A(premium) e B(clássico) → A
    expect(soConsiderado(normal.detalhes.full).itemId).toBe('A');
  });

  // ── TEXTO DE MOTIVO no Full seguro (bug de argumentos invertidos) ────────
  describe('texto de motivo no Full seguro (perdedor cita vencedor e critério correto)', () => {
    const vencedorDe = (r: ReturnType<typeof consolidarEstoqueGrupo>) => soConsiderado(r.detalhes.full);
    const perdedoresDe = (r: ReturnType<typeof consolidarEstoqueGrupo>) =>
      r.detalhes.full.filter(c => !c.considerado);

    it('vitória por saldo maior', () => {
      const r = consolidarEstoqueGrupo([
        full({ id: 'A', inventory_id: 'INV1', available_quantity: 4 }),
        full({ id: 'B', inventory_id: 'INV1', available_quantity: 9 }),
      ], 'seguro');
      const venc = vencedorDe(r);
      expect(venc.itemId).toBe('B');
      expect(venc.motivo).toMatch(/Vencedor determinístico da chave/);
      for (const p of perdedoresDe(r)) {
        expect(p.motivo).toContain('perdeu para B');        // cita o vencedor certo
        expect(p.motivo).toMatch(/saldo maior \(9 > 4\)/);  // critério certo
        expect(p.motivo).not.toContain(`perdeu para ${p.itemId}`); // não diz que o vencedor perdeu
      }
    });

    it('vitória por premium em empate de saldo', () => {
      const r = consolidarEstoqueGrupo([
        full({ id: 'A', inventory_id: 'INV1', available_quantity: 9, listing_type_id: 'gold_special' }),
        full({ id: 'B', inventory_id: 'INV1', available_quantity: 9, listing_type_id: 'gold_pro' }),
      ], 'seguro');
      const venc = vencedorDe(r);
      expect(venc.itemId).toBe('B');
      expect(venc.motivo).toMatch(/Vencedor determinístico da chave/);
      const p = perdedoresDe(r)[0];
      expect(p.motivo).toContain('perdeu para B');
      expect(p.motivo).toMatch(/empate de saldo resolvido por premium/);
    });

    it('vitória por itemId lexical em empate persistente', () => {
      const r = consolidarEstoqueGrupo([
        full({ id: 'B', inventory_id: 'INV1', available_quantity: 9, listing_type_id: 'gold_special' }),
        full({ id: 'A', inventory_id: 'INV1', available_quantity: 9, listing_type_id: 'gold_special' }),
      ], 'seguro');
      const venc = vencedorDe(r);
      expect(venc.itemId).toBe('A');
      expect(venc.motivo).toMatch(/Vencedor determinístico da chave/);
      const p = perdedoresDe(r)[0];
      expect(p.itemId).toBe('B');
      expect(p.motivo).toContain('perdeu para A');
      expect(p.motivo).toMatch(/itemId lexical \(A < B\)/);
      expect(p.motivo).not.toContain('perdeu para B');
    });
  });

  // ── DETERMINISMO DO PRÓPRIO no modo seguro (casos A–E) ───────────────────
  describe('próprio seguro: determinismo e auditoria independente da ordem', () => {
    const prop = (over: Partial<InventoryItemInput> & { id: string }): InventoryItemInput =>
      item({ shipping: { logistic_type: 'drop_off' }, ...over });
    const soConsideradoProp = (comps: EstoqueComponente[]) => {
      const c = considerados(comps);
      expect(c).toHaveLength(1);
      return c[0];
    };

    it('A. mesmo inventory_id, mesmo saldo → A único considerado nas 2 ordens; auditoria idêntica', () => {
      const itens = [
        prop({ id: 'A', inventory_id: 'INV1', available_quantity: 10 }),
        prop({ id: 'B', inventory_id: 'INV1', available_quantity: 10 }),
      ];
      const normal = consolidarEstoqueGrupo(itens, 'seguro');
      const invert = consolidarEstoqueGrupo([...itens].reverse(), 'seguro');
      expect(soConsideradoProp(normal.detalhes.proprio).itemId).toBe('A'); // menor itemId
      expect(soConsideradoProp(invert.detalhes.proprio).itemId).toBe('A');
      expect(normal.detalhes.proprio.map(chaveAuditoria)).toEqual(invert.detalhes.proprio.map(chaveAuditoria));
      expect(normal.proprio).toBe(10);
    });

    it('B. sem inventory_id, mesmo SKU e saldo → A único considerado nas 2 ordens; auditoria idêntica', () => {
      const itens = [
        prop({ id: 'A', seller_custom_field: '21002', available_quantity: 7 }),
        prop({ id: 'B', seller_custom_field: '21002', available_quantity: 7 }),
      ];
      const normal = consolidarEstoqueGrupo(itens, 'seguro');
      const invert = consolidarEstoqueGrupo([...itens].reverse(), 'seguro');
      expect(soConsideradoProp(normal.detalhes.proprio).itemId).toBe('A');
      expect(soConsideradoProp(invert.detalhes.proprio).itemId).toBe('A');
      expect(normal.detalhes.proprio.map(chaveAuditoria)).toEqual(invert.detalhes.proprio.map(chaveAuditoria));
      expect(normal.proprio).toBe(7);
    });

    it('C. saldos diferentes → maior saldo único considerado nas 2 ordens (com e sem inventory)', () => {
      const comInv = [
        prop({ id: 'A', inventory_id: 'INV1', available_quantity: 4 }),
        prop({ id: 'B', inventory_id: 'INV1', available_quantity: 9 }),
      ];
      for (const arr of [comInv, [...comInv].reverse()]) {
        const r = consolidarEstoqueGrupo(arr, 'seguro');
        expect(soConsideradoProp(r.detalhes.proprio).itemId).toBe('B');
        expect(r.proprio).toBe(9);
      }
      const semInv = [
        prop({ id: 'A', seller_custom_field: '21002', available_quantity: 4 }),
        prop({ id: 'B', seller_custom_field: '21002', available_quantity: 9 }),
      ];
      for (const arr of [semInv, [...semInv].reverse()]) {
        const r = consolidarEstoqueGrupo(arr, 'seguro');
        expect(soConsideradoProp(r.detalhes.proprio).itemId).toBe('B');
        expect(r.proprio).toBe(9);
      }
    });

    it('D. campo motivo idêntico entre ordem normal e invertida', () => {
      const itens = [
        prop({ id: 'C', inventory_id: 'INV1', available_quantity: 5 }),
        prop({ id: 'A', inventory_id: 'INV1', available_quantity: 5 }),
        prop({ id: 'B', inventory_id: 'INV2', available_quantity: 8 }),
      ];
      const normal = consolidarEstoqueGrupo(itens, 'seguro');
      const invert = consolidarEstoqueGrupo([...itens].reverse(), 'seguro');
      const porItem = (r: ReturnType<typeof consolidarEstoqueGrupo>) =>
        Object.fromEntries(r.detalhes.proprio.map(c => [c.itemId, c.motivo]));
      expect(porItem(normal)).toEqual(porItem(invert));
      // INV1 empate 5 → menor itemId A vence (determinístico); C cita perda p/ A
      expect(porItem(normal)['A']).toMatch(/Vencedor determinístico \(inv:INV1\)/);
      expect(porItem(normal)['C']).toContain('perdeu para A');
      expect(porItem(normal)['C']).toMatch(/itemId lexical \(A < C\)/);
    });

    it('E. exatamente 1 considerado por chave própria; após descarte do bloco sem-inventory nenhum descartado fica considerado', () => {
      // grupo com próprio COM inventory (INV1) E próprio SEM inventory → bloco sem-inv é descartado
      const itens = [
        prop({ id: 'A', inventory_id: 'INV1', available_quantity: 10 }),
        prop({ id: 'B', inventory_id: 'INV1', available_quantity: 6 }),
        prop({ id: 'C', seller_custom_field: '21002', available_quantity: 99 }),
        prop({ id: 'D', seller_custom_field: '21002', available_quantity: 99 }),
      ];
      for (const arr of [itens, [...itens].reverse()]) {
        const r = consolidarEstoqueGrupo(arr, 'seguro');
        // 1 considerado por chave INV1
        const inv1 = r.detalhes.proprio.filter(c => c.chaveDedup === 'inv:INV1');
        expect(considerados(inv1)).toHaveLength(1);
        expect(soConsideradoProp(inv1).itemId).toBe('A');
        // bloco sem-inventory: TODOS descartados (proprio com inventory existe)
        const semInv = r.detalhes.proprio.filter(c => c.chaveDedup === 'sem-inventory');
        expect(semInv.every(c => c.considerado === false)).toBe(true);
        expect(r.proprio).toBe(10); // só INV1
        expect(r.alertas.some(a => a.tipo === 'proprio_sem_inventory_ignorado')).toBe(true);
      }
    });

    it('DESCARTE: bloco sem-inventory descartado por regra externa tem motivo uniforme e determinístico', () => {
      const A = prop({ id: 'A', inventory_id: 'INV1', available_quantity: 10 });
      const C = prop({ id: 'C', seller_custom_field: '21002', available_quantity: 99 });
      const D = prop({ id: 'D', seller_custom_field: '21002', available_quantity: 99 });
      const ordens = [
        [A, C, D],
        [D, C, A],
        [C, A, D],
        [D, A, C],
      ];
      const auditorias = ordens.map(arr => {
        const r = consolidarEstoqueGrupo(arr, 'seguro');
        // 1. proprio === 10
        expect(r.proprio).toBe(10);
        const semInv = r.detalhes.proprio.filter(c => c.chaveDedup === 'sem-inventory');
        // 2. C e D considerado=false
        expect(semInv.every(c => c.considerado === false)).toBe(true);
        // 3. C e D mesmo motivo
        const motivos = new Set(semInv.map(c => c.motivo));
        expect(motivos.size).toBe(1);
        // 4. motivo não cita "perdeu para C" nem "perdeu para D"
        const motivo = [...motivos][0];
        expect(motivo).not.toContain('perdeu para C');
        expect(motivo).not.toContain('perdeu para D');
        expect(motivo).toMatch(/descartado pela regra legada anti-duplicação/);
        // 6. alerta uma única vez
        expect(r.alertas.filter(a => a.tipo === 'proprio_sem_inventory_ignorado')).toHaveLength(1);
        return r.detalhes.proprio.map(chaveAuditoria);
      });
      // 5. detalhes.proprio completos (incl. motivo) idênticos entre todas as ordens
      for (let i = 1; i < auditorias.length; i++) {
        expect(auditorias[i]).toEqual(auditorias[0]);
      }
    });

    it('E2. bloco sem-inventory isolado: exatamente 1 considerado (o vencedor determinístico)', () => {
      const itens = [
        prop({ id: 'C', seller_custom_field: '21002', available_quantity: 5 }),
        prop({ id: 'A', seller_custom_field: '21002', available_quantity: 5 }),
        prop({ id: 'B', seller_custom_field: '21002', available_quantity: 5 }),
      ];
      for (const arr of [itens, [...itens].reverse()]) {
        const r = consolidarEstoqueGrupo(arr, 'seguro');
        const semInv = r.detalhes.proprio.filter(c => c.chaveDedup === 'sem-inventory');
        expect(considerados(semInv)).toHaveLength(1);
        expect(soConsideradoProp(semInv).itemId).toBe('A'); // menor itemId no empate
      }
    });

    it('GUARDIÃO: auditoria completa (detalhes+alertas, incl. motivo) idêntica sob QUALQUER permutação (seguro)', () => {
      // grupo heterogêneo: Full com/sem inventory, próprio com inventory,
      // DOIS próprios sem inventory (bloco descartado pela regra externa),
      // empates e um saldo negativo (gera alerta).
      const base = [
        full({ id: 'F1', inventory_id: 'INVF', available_quantity: 9, listing_type_id: 'gold_special' }),
        full({ id: 'F2', inventory_id: 'INVF', available_quantity: 9, listing_type_id: 'gold_pro' }),
        full({ id: 'F3', seller_custom_field: 'SK', available_quantity: 3 }),
        prop({ id: 'P1', inventory_id: 'INVP', available_quantity: 5 }),
        prop({ id: 'P2', inventory_id: 'INVP', available_quantity: 5 }),
        prop({ id: 'P3', inventory_id: 'INVQ', available_quantity: 7 }),
        prop({ id: 'P4', seller_custom_field: 'SK', available_quantity: 99 }),
        prop({ id: 'P5', seller_custom_field: 'SK', available_quantity: 99 }),
        prop({ id: 'P6', inventory_id: 'INVR', available_quantity: -4 }),
      ];
      const chaveComMotivo = (c: EstoqueComponente) =>
        [c.origem, c.chaveDedup, c.itemId, c.considerado, c.premium, c.quantidadeOriginal, c.quantidadeConsiderada, c.motivo].join('¦');
      const chaveAlerta = (a: { tipo: string; itemId?: string; mensagem: string }) =>
        [a.tipo, a.itemId ?? '', a.mensagem].join('¦');
      const ref = consolidarEstoqueGrupo(base, 'seguro');
      const refFull = ref.detalhes.full.map(chaveComMotivo);
      const refProp = ref.detalhes.proprio.map(chaveComMotivo);
      const refAlertas = ref.alertas.map(chaveAlerta);
      let seed = 12345;
      const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      for (let n = 0; n < 60; n++) {
        const arr = [...base];
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        const r = consolidarEstoqueGrupo(arr, 'seguro');
        expect(r.detalhes.full.map(chaveComMotivo)).toEqual(refFull);
        expect(r.detalhes.proprio.map(chaveComMotivo)).toEqual(refProp);
        expect(r.alertas.map(chaveAlerta)).toEqual(refAlertas); // alertas também determinísticos
        expect(r.proprio).toBe(ref.proprio);
        expect(r.full).toBe(ref.full);
      }
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// DEDUP FULL (6-14)
// ══════════════════════════════════════════════════════════════════════════
describe('consolidarEstoqueGrupo — dedup Full', () => {
  it('6. um Full com inventory_id', () => {
    const r = consolidarEstoqueGrupo([full({ id: 'A', inventory_id: 'INV1', available_quantity: 12 })]);
    expect(r).toMatchObject({ full: 12, proprio: 0, total: 12 });
  });
  it('7. mesmo inventory_id, mesmo saldo → não soma', () => {
    const r = consolidarEstoqueGrupo([
      full({ id: 'A', inventory_id: 'INV1', available_quantity: 10, listing_type_id: 'gold_special' }),
      full({ id: 'B', inventory_id: 'INV1', available_quantity: 10, listing_type_id: 'gold_pro' }),
    ]);
    expect(r.full).toBe(10);
  });
  it('8. mesmo inventory_id, saldos diferentes → maior vence', () => {
    const r = consolidarEstoqueGrupo([
      full({ id: 'A', inventory_id: 'INV1', available_quantity: 4 }),
      full({ id: 'B', inventory_id: 'INV1', available_quantity: 9 }),
    ]);
    expect(r.full).toBe(9);
  });
  it('9. dois inventory_ids diferentes somam', () => {
    const r = consolidarEstoqueGrupo([
      full({ id: 'A', inventory_id: 'INV1', available_quantity: 5 }),
      full({ id: 'B', inventory_id: 'INV2', available_quantity: 7 }),
    ]);
    expect(r.full).toBe(12);
  });
  it('10. Full sem inventory_id: chave por SKU', () => {
    expect(consolidarEstoqueGrupo([full({ id: 'A', seller_custom_field: '21002', available_quantity: 8 })]).full).toBe(8);
  });
  it('11. vários Full sem inventory_id, mesmo SKU → maior vence', () => {
    const r = consolidarEstoqueGrupo([
      full({ id: 'A', seller_custom_field: '21002', available_quantity: 6 }),
      full({ id: 'B', seller_custom_field: '21002', available_quantity: 9 }),
    ]);
    expect(r.full).toBe(9);
  });
  it('12. available_quantity ausente → 0, nunca NaN', () => {
    const r = consolidarEstoqueGrupo([full({ id: 'A', inventory_id: 'INV1', available_quantity: null })]);
    expect(r.full).toBe(0);
    expect(Number.isNaN(r.full)).toBe(false);
  });
  it('13. inventory_id vazio/espaços tratado como ausente', () => {
    expect(fullStockKey(item({ id: 'A', inventory_id: '   ', seller_custom_field: '21002' })).origem).toBe('sku');
    const r = consolidarEstoqueGrupo([full({ id: 'A', inventory_id: '   ', seller_custom_field: '21002', available_quantity: 5 })]);
    expect(r.full).toBe(5);
    expect(r.alertas.some(a => a.tipo === 'inventory_id_invalido')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ESTOQUE NEGATIVO — legado propaga, seguro normaliza (item 3 do pedido)
// ══════════════════════════════════════════════════════════════════════════
describe('estoque negativo: quantidadeOriginal vs quantidadeConsiderada', () => {
  it('negativo PRÓPRIO — legado propaga, seguro normaliza para 0', () => {
    const items = [item({ id: 'A', inventory_id: 'INV1', available_quantity: -3 })];
    const leg = consolidarEstoqueGrupo(items, 'legado');
    expect(leg.proprio).toBe(-3);
    expect(leg.alertas.some(a => a.tipo === 'saldo_negativo')).toBe(true);
    const seg = consolidarEstoqueGrupo(items, 'seguro');
    expect(seg.proprio).toBe(0);
    expect(seg.total).toBeGreaterThanOrEqual(0);
    expect(seg.alertas.some(a => a.tipo === 'saldo_negativo_normalizado')).toBe(true);
    const comp = seg.detalhes.proprio[0];
    expect(comp.quantidadeOriginal).toBe(-3);
    expect(comp.quantidadeConsiderada).toBe(0);
  });

  it('negativo FULL — seguro garante full >= 0', () => {
    const items = [full({ id: 'A', inventory_id: 'INV1', available_quantity: -8 })];
    expect(consolidarEstoqueGrupo(items, 'legado').full).toBe(-8);
    const seg = consolidarEstoqueGrupo(items, 'seguro');
    expect(seg.full).toBe(0);
    expect(seg.total).toBeGreaterThanOrEqual(0);
  });

  it('mistura de negativo e positivo na MESMA chave', () => {
    const items = [
      full({ id: 'A', inventory_id: 'INV1', available_quantity: -5 }),
      full({ id: 'B', inventory_id: 'INV1', available_quantity: 7 }),
    ];
    // legado: -5 entra primeiro, 7 > -5 vence → 7
    expect(consolidarEstoqueGrupo(items, 'legado').full).toBe(7);
    // seguro: -5 vira 0, 7 vence → 7; nunca negativo
    const seg = consolidarEstoqueGrupo(items, 'seguro');
    expect(seg.full).toBe(7);
    expect(seg.full).toBeGreaterThanOrEqual(0);
  });

  it('todos negativos na mesma chave — seguro entrega 0, não o "menos negativo"', () => {
    const items = [
      full({ id: 'A', inventory_id: 'INV1', available_quantity: -5 }),
      full({ id: 'B', inventory_id: 'INV1', available_quantity: -2 }),
    ];
    expect(consolidarEstoqueGrupo(items, 'legado').full).toBe(-2); // maior dos negativos
    expect(consolidarEstoqueGrupo(items, 'seguro').full).toBe(0);
  });

  it('classificarEstoque REJEITA estoque negativo (sem cobertura negativa silenciosa)', () => {
    expect(() => classificarEstoque(-1, 10, 30)).toThrow(/negativo/);
    // fluxo correto: modo seguro normaliza antes → classifica 0 como semvenda se vel 0, etc.
    const est = consolidarEstoqueGrupo([item({ id: 'A', inventory_id: 'INV1', available_quantity: -4 })], 'seguro').proprio;
    expect(() => classificarEstoque(est, 5, 30)).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// DEDUP PRÓPRIO (15-24)
// ══════════════════════════════════════════════════════════════════════════
describe('consolidarEstoqueGrupo — dedup próprio', () => {
  it('15. um próprio', () => {
    expect(consolidarEstoqueGrupo([item({ id: 'A', inventory_id: 'INV1', available_quantity: 20 })]).proprio).toBe(20);
  });
  it('16. espelhos SEM inventory_id → maior', () => {
    const r = consolidarEstoqueGrupo([
      item({ id: 'A', seller_custom_field: '21002', available_quantity: 15 }),
      item({ id: 'B', seller_custom_field: '21002', available_quantity: 18 }),
    ]);
    expect(r.proprio).toBe(18);
  });
  it('17. mesmo inventory_id → maior', () => {
    const r = consolidarEstoqueGrupo([
      item({ id: 'A', inventory_id: 'INV1', available_quantity: 12 }),
      item({ id: 'B', inventory_id: 'INV1', available_quantity: 5 }),
    ]);
    expect(r.proprio).toBe(12);
  });
  it('18. inventory_ids diferentes → soma', () => {
    const r = consolidarEstoqueGrupo([
      item({ id: 'A', inventory_id: 'INV1', available_quantity: 12 }),
      item({ id: 'B', inventory_id: 'INV2', available_quantity: 5 }),
    ]);
    expect(r.proprio).toBe(17);
  });
  it('19. mistura com/sem inventory_id: bloco sem-inventory ignorado (quirk legado)', () => {
    const r = consolidarEstoqueGrupo([
      item({ id: 'A', inventory_id: 'INV1', available_quantity: 10 }),
      item({ id: 'B', seller_custom_field: '21002', available_quantity: 99 }),
    ]);
    expect(r.proprio).toBe(10);
    expect(r.alertas.some(a => a.tipo === 'proprio_sem_inventory_ignorado')).toBe(true);
  });
  it('20. apenas sem inventory_id → maior do bloco', () => {
    const r = consolidarEstoqueGrupo([
      item({ id: 'A', seller_custom_field: '21002', available_quantity: 7 }),
      item({ id: 'B', seller_custom_field: '21002', available_quantity: 4 }),
    ]);
    expect(r.proprio).toBe(7);
  });
  it('21. clássico/premium próprios mesmo inventory → maior', () => {
    const r = consolidarEstoqueGrupo([
      item({ id: 'A', inventory_id: 'INV1', available_quantity: 3, listing_type_id: 'gold_special' }),
      item({ id: 'B', inventory_id: 'INV1', available_quantity: 8, listing_type_id: 'gold_pro' }),
    ]);
    expect(r.proprio).toBe(8);
  });
  it('22/23/24. consolidarEstoqueGrupo NÃO filtra status (paridade)', () => {
    const r = consolidarEstoqueGrupo([
      item({ id: 'A', inventory_id: 'INV1', available_quantity: 5, status: 'paused' }),
      item({ id: 'B', inventory_id: 'INV2', available_quantity: 6, status: 'closed' }),
      item({ id: 'C', inventory_id: 'INV3', available_quantity: 7, status: null }),
    ]);
    expect(r.proprio).toBe(18);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// STATUS em buildEstoquePorSku (item 6 do pedido)
// ══════════════════════════════════════════════════════════════════════════
describe('buildEstoquePorSku — filtro de status configurável', () => {
  const mistos = (): InventoryItemInput[] => [
    item({ id: 'A', seller_custom_field: '21002', inventory_id: 'I1', available_quantity: 10, status: 'active' }),
    item({ id: 'B', seller_custom_field: '21002', inventory_id: 'I2', available_quantity: 5, status: 'paused' }),
    item({ id: 'C', seller_custom_field: '21002', inventory_id: 'I3', available_quantity: 4, status: 'closed' }),
    item({ id: 'D', seller_custom_field: '21002', inventory_id: 'I4', available_quantity: 3, status: null }),
    item({ id: 'E', seller_custom_field: '21002', inventory_id: 'I5', available_quantity: 2, status: undefined }),
  ];

  it('padrão (incluirSomenteAtivos=true) mantém apenas active — paridade estGetSKUData', () => {
    const linhas = buildEstoquePorSku(mistos());
    expect(linhas).toHaveLength(1);
    expect(linhas[0].estProprio).toBe(10); // só o item A
    expect(linhas[0].anuncios).toBe(1);
  });

  it('incluirSomenteAtivos=false soma todos os status', () => {
    const linhas = buildEstoquePorSku(mistos(), { incluirSomenteAtivos: false });
    expect(linhas[0].estProprio).toBe(24); // 10+5+4+3+2 (inventory_ids distintos)
    expect(linhas[0].anuncios).toBe(5);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// GRUPO MISTO (25-30)
// ══════════════════════════════════════════════════════════════════════════
describe('consolidarEstoqueGrupo — grupo misto e auditoria', () => {
  it('25/27. total = próprio + full', () => {
    const r = consolidarEstoqueGrupo([
      item({ id: 'A', inventory_id: 'INV1', available_quantity: 10 }),
      full({ id: 'B', inventory_id: 'INVF', available_quantity: 25 }),
    ]);
    expect(r).toMatchObject({ proprio: 10, full: 25, total: 35 });
  });
  it('26. múltiplos clássico/premium por inventory distinto', () => {
    const r = consolidarEstoqueGrupo([
      full({ id: 'A', inventory_id: 'INV1', available_quantity: 5, listing_type_id: 'gold_special' }),
      full({ id: 'B', inventory_id: 'INV2', available_quantity: 8, listing_type_id: 'gold_pro' }),
    ]);
    expect(r).toMatchObject({ fullClassico: 5, fullPremium: 8, full: 13 });
  });
  it('28. ordem invertida — totais idênticos nos dois modos', () => {
    const itens = [
      item({ id: 'A', inventory_id: 'INV1', available_quantity: 10 }),
      full({ id: 'B', inventory_id: 'INVF', available_quantity: 25 }),
      full({ id: 'C', inventory_id: 'INVF', available_quantity: 25 }),
    ];
    for (const modo of ['legado', 'seguro'] as const) {
      const r1 = consolidarEstoqueGrupo(itens, modo);
      const r2 = consolidarEstoqueGrupo([...itens].reverse(), modo);
      expect(r2.proprio).toBe(r1.proprio);
      expect(r2.full).toBe(r1.full);
      expect(r2.total).toBe(r1.total);
    }
  });
  it('29. grupo vazio → zeros válidos, não null/NaN', () => {
    const r = consolidarEstoqueGrupo([]);
    expect(r).toMatchObject({ proprio: 0, full: 0, total: 0 });
    expect(Number.isNaN(r.total)).toBe(false);
    expect(r.detalhes.proprio).toEqual([]);
    expect(r.detalhes.full).toEqual([]);
  });
  it('30. auditoria explica dedup sem alterar totais', () => {
    const r = consolidarEstoqueGrupo([
      full({ id: 'A', inventory_id: 'INV1', available_quantity: 4 }),
      full({ id: 'B', inventory_id: 'INV1', available_quantity: 9 }),
    ]);
    const cons = considerados(r.detalhes.full);
    expect(cons).toHaveLength(1);
    expect(cons[0].itemId).toBe('B');
    expect(cons.reduce((s, d) => s + d.quantidadeConsiderada, 0)).toBe(r.full);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AUDITORIA DETERMINÍSTICA (item 7 do pedido)
// ══════════════════════════════════════════════════════════════════════════
describe('auditoria determinística no modo seguro', () => {
  const itens = [
    full({ id: 'C', inventory_id: 'INV2', available_quantity: 3 }),
    full({ id: 'A', inventory_id: 'INV1', available_quantity: 9 }),
    full({ id: 'B', inventory_id: 'INV1', available_quantity: 4 }),
    item({ id: 'D', inventory_id: 'INVP', available_quantity: 6 }),
  ];

  it('ordem de entrada invertida produz auditoria IDÊNTICA (seguro)', () => {
    const r1 = consolidarEstoqueGrupo(itens, 'seguro');
    const r2 = consolidarEstoqueGrupo([...itens].reverse(), 'seguro');
    const chave = (c: EstoqueComponente) => `${c.origem}|${c.chaveDedup}|${c.itemId}|${c.considerado}`;
    expect(r1.detalhes.full.map(chave)).toEqual(r2.detalhes.full.map(chave));
    expect(r1.detalhes.proprio.map(chave)).toEqual(r2.detalhes.proprio.map(chave));
  });

  it('não há mensagens contraditórias: no máximo 1 considerado por chave', () => {
    const r = consolidarEstoqueGrupo(itens, 'seguro');
    const porChave = new Map<string, number>();
    for (const c of [...r.detalhes.full, ...r.detalhes.proprio]) {
      if (c.considerado) porChave.set(c.chaveDedup, (porChave.get(c.chaveDedup) ?? 0) + 1);
    }
    for (const n of porChave.values()) expect(n).toBe(1);
  });

  it('auditoria ordenada não altera os totais', () => {
    const r1 = consolidarEstoqueGrupo(itens, 'seguro');
    const r2 = consolidarEstoqueGrupo(itens, 'legado');
    expect(r1.full).toBe(r2.full);
    expect(r1.proprio).toBe(r2.proprio);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// SKU (31-35)
// ══════════════════════════════════════════════════════════════════════════
describe('buildEstoquePorSku — agrupamento por SKU', () => {
  it('31. por SKU real', () => {
    const linhas = buildEstoquePorSku([
      item({ id: 'A', seller_custom_field: '21002', inventory_id: 'INV1', available_quantity: 10 }),
      item({ id: 'B', seller_custom_field: '21002', inventory_id: 'INV2', available_quantity: 5 }),
    ]);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ sku: '21002', estProprio: 15, anuncios: 2 });
  });
  it('32. sem SKU → sintético', () => {
    const linhas = buildEstoquePorSku([item({ id: 'MLB9', available_quantity: 3 })]);
    expect(linhas[0]).toMatchObject({ sku: 'sem-sku-MLB9', semSku: true });
  });
  it('33. dois sem SKU não fundem', () => {
    const linhas = buildEstoquePorSku([item({ id: 'MLB1', available_quantity: 3 }), item({ id: 'MLB2', available_quantity: 4 })]);
    expect(linhas).toHaveLength(2);
  });
  it('34. espaços no SKU normalizam', () => {
    const linhas = buildEstoquePorSku([
      item({ id: 'A', seller_custom_field: ' 21002 ', inventory_id: 'INV1', available_quantity: 10 }),
      item({ id: 'B', seller_custom_field: '21002', inventory_id: 'INV2', available_quantity: 5 }),
    ]);
    expect(linhas).toHaveLength(1);
    expect(linhas[0].sku).toBe('21002');
  });
  it('35. integração com itemSKU (atributo SELLER_SKU)', () => {
    const linhas = buildEstoquePorSku([
      item({ id: 'A', seller_custom_field: '21002', inventory_id: 'INV1', available_quantity: 10 }),
      item({ id: 'B', attributes: [{ id: 'SELLER_SKU', value_name: '21002' }], inventory_id: 'INV2', available_quantity: 5 }),
    ]);
    expect(linhas[0].estProprio).toBe(15);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// CLASSIFICAÇÃO (36-43)
// ══════════════════════════════════════════════════════════════════════════
describe('classificarEstoque', () => {
  it('36. ruptura (< 30 dias)', () => { expect(classificarEstoque(10, 30, 30).tipo).toBe('ruptura'); });
  it('37. alerta (30..89)', () => { expect(classificarEstoque(60, 30, 30).tipo).toBe('alerta'); });
  it('38. ok (90..365)', () => { expect(classificarEstoque(120, 30, 30).tipo).toBe('ok'); });
  it('39. excesso (> 365)', () => { expect(classificarEstoque(400, 30, 30).tipo).toBe('excesso'); });
  it('40. sem venda (vel 0) → semvenda, diasCobertura null', () => {
    const c = classificarEstoque(50, 0, 30);
    expect(c).toMatchObject({ tipo: 'semvenda', velocidadeDia: 0, diasCobertura: null });
  });
  it('41. diasPeriodo <= 0 ou inválido lança erro', () => {
    expect(() => classificarEstoque(10, 5, 0)).toThrow(/diasPeriodo/);
    expect(() => classificarEstoque(10, 5, -1)).toThrow(/diasPeriodo/);
    expect(() => classificarEstoque(10, 5, NaN)).toThrow(/diasPeriodo/);
  });
  it('42. limites exatos (29/30, 89/90, 365/366)', () => {
    expect(classificarEstoque(29, 30, 30).tipo).toBe('ruptura');
    expect(classificarEstoque(30, 30, 30).tipo).toBe('alerta');
    expect(classificarEstoque(89, 30, 30).tipo).toBe('alerta');
    expect(classificarEstoque(90, 30, 30).tipo).toBe('ok');
    expect(classificarEstoque(365, 30, 30).tipo).toBe('ok');
    expect(classificarEstoque(366, 30, 30).tipo).toBe('excesso');
    expect(LIMITES_CLASSIFICACAO).toMatchObject({ rupturaDiasMax: 30, alertaDiasMax: 90, okDiasMax: 365 });
  });
  it('43. classificação independe da ordem de entrada', () => {
    const itens = [
      full({ id: 'A', seller_custom_field: 'S1', inventory_id: 'I1', available_quantity: 10 }),
      full({ id: 'B', seller_custom_field: 'S2', inventory_id: 'I2', available_quantity: 400 }),
    ];
    const vendas = { A: 30, B: 30 };
    const r1 = buildEstoqueFullPorSku(itens, { vendasPorItem: vendas, diasPeriodo: 30 });
    const r2 = buildEstoqueFullPorSku([...itens].reverse(), { vendasPorItem: vendas, diasPeriodo: 30 });
    expect(r1.map(l => l.sku)).toEqual(r2.map(l => l.sku));
    expect(r1[0].tipo).toBe('ruptura');
  });
  it('velocidade arredondada a 2 casas (paridade toFixed)', () => {
    const c = classificarEstoque(100, 10, 30);
    expect(c.velocidadeDia).toBe(0.33);
    expect(c.diasCobertura).toBe(Math.round(100 / 0.33));
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ORDENAÇÃO GENÉRICA (item 4 do pedido) — sem cast inseguro
// ══════════════════════════════════════════════════════════════════════════
describe('ordenarLinhasClassificaveis aceita ambos os tipos sem cast', () => {
  it('ordena EstoqueSkuLinha[] e EstoqueFullLinha[] pela mesma regra', () => {
    const skuLinhas = buildEstoquePorSku(
      [
        item({ id: 'A', seller_custom_field: 'S1', inventory_id: 'I1', available_quantity: 10 }),
        item({ id: 'B', seller_custom_field: 'S2', inventory_id: 'I2', available_quantity: 400 }),
      ],
      { vendasPorItem: { A: 30, B: 30 }, diasPeriodo: 30 }
    );
    expect(skuLinhas[0].tipo).toBe('ruptura'); // já ordenado internamente
    // chamada direta com tipos distintos, sem cast:
    const full1 = buildEstoqueFullPorSku([full({ id: 'A', seller_custom_field: 'S1', inventory_id: 'I1', available_quantity: 5 })]);
    expect(ordenarLinhasClassificaveis(full1)).toBe(full1);
    expect(ordenarLinhasClassificaveis(skuLinhas)).toBe(skuLinhas);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// INTEGRAÇÃO (44-47)
// ══════════════════════════════════════════════════════════════════════════
describe('integração inventory ↔ products', () => {
  it('44. calcularEstoqueTotalGrupo = próprio + Full', () => {
    expect(
      calcularEstoqueTotalGrupo([
        item({ id: 'A', inventory_id: 'INV1', available_quantity: 10 }),
        full({ id: 'B', inventory_id: 'INVF', available_quantity: 25 }),
      ])
    ).toBe(35);
  });
  it('44b. calcularEstoqueTotalGrupo modo seguro nunca negativo', () => {
    expect(
      calcularEstoqueTotalGrupo([item({ id: 'A', inventory_id: 'INV1', available_quantity: -9 })], 'seguro')
    ).toBe(0);
  });
  it('45/46. buildConsolidado usa callback; estTotal deixa de ser null', () => {
    const items: ProductItemInput[] = [
      { id: 'A', seller_custom_field: '21002', title: 'Vinho', price: 50, available_quantity: 10, inventory_id: 'INV1' } as InventoryItemInput,
      { id: 'B', seller_custom_field: '21002', title: 'Vinho', price: 50, available_quantity: 25, inventory_id: 'INVF', shipping: { logistic_type: 'fulfillment' } } as InventoryItemInput,
    ];
    expect(buildConsolidado(items, [])[0].estTotal).toBeNull();
    const comCb = buildConsolidado(items, [], {
      calcularEstoqueGrupo: g => calcularEstoqueTotalGrupo(g as InventoryItemInput[]),
    });
    expect(comCb[0].estTotal).toBe(35);
  });
  it('47. sem callback, buildConsolidado inalterado (sem regressão)', () => {
    const items: ProductItemInput[] = [{ id: 'A', seller_custom_field: '21002', title: 'Vinho A', price: 50, sold_quantity: 3 }];
    expect(buildConsolidado(items, [])[0]).toMatchObject({ sku: '21002', vendasTotal: 3, estTotal: null });
  });
});