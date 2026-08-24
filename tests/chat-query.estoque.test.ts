import { describe, it, expect } from 'vitest';
import {
  CHAT_INVENTORY_FILTERS,
  CHAT_INVENTORY_SCOPES,
  ehIntencaoEstoque,
  parseChatQuery,
  type ChatQuery,
} from '../src/services/chat-query.service.js';

// Mesmo relógio fixo dos demais testes do parser: quinta, 2026-07-23 15:00 BRT.
const AGORA = new Date('2026-07-23T15:00:00.000-03:00');
const opt = (over: Record<string, unknown> = {}) => ({ agora: AGORA, ...over });

function q(texto: string, over: Record<string, unknown> = {}): ChatQuery {
  const r = parseChatQuery(texto, opt(over));
  if (r.kind !== 'recognized') {
    throw new Error(`esperava recognized, veio ${r.kind} (${(r as { reason?: string }).reason}) em: ${texto}`);
  }
  return r.query;
}

/** Janela padrão de estoque: 30 dias civis terminando hoje. */
const JANELA_PADRAO = { kind: 'last_n_days', fromYmd: '2026-06-24', toYmd: '2026-07-23' };

// ══════════════════════════════════════════════════════════════════════════
describe('chat-query estoque — 1. resumo geral', () => {
  const frases = [
    'como está nosso estoque?',
    'me dá um resumo do estoque',
    'situação do estoque',
    'como estamos de estoque?',
    'qual o estoque hoje?',
    'estoque',
  ];

  for (const f of frases) {
    it(`"${f}" => inventory_summary`, () => {
      const x = q(f);
      expect(x.intent).toBe('inventory_summary');
      expect(ehIntencaoEstoque(x.intent)).toBe(true);
      expect(x.inventoryScope).toBe('ambos');
      expect(x.inventoryFilter).toBeUndefined();
    });
  }

  it('sem período no texto usa a janela padrão de 30 dias e marca source default', () => {
    const x = q('como está nosso estoque?');
    expect(x.period).toEqual(JANELA_PADRAO);
    expect(x.source.period).toBe('default');
  });

  it('período no texto vence a janela padrão', () => {
    const x = q('como está o estoque nos últimos 7 dias?');
    expect(x.period).toEqual({ kind: 'last_n_days', fromYmd: '2026-07-17', toYmd: '2026-07-23' });
    expect(x.source.period).toBe('text');
  });
});

describe('chat-query estoque — 2. ruptura', () => {
  const frases = [
    'o que está em ruptura?',
    'quais produtos estão acabando?',
    'o que preciso repor?',
    'quais produtos precisam de reposição?',
    'quais itens estão esgotados?',
    'o que está faltando no estoque?',
  ];

  for (const f of frases) {
    it(`"${f}" => inventory_list / ruptura`, () => {
      const x = q(f);
      expect(x.intent).toBe('inventory_list');
      expect(x.inventoryFilter).toBe('ruptura');
    });
  }
});

describe('chat-query estoque — 3. alerta e estoque baixo', () => {
  it('"em alerta" pede SOMENTE a faixa alerta', () => {
    for (const f of ['quais produtos estão em alerta?', 'o que está em alerta no estoque?']) {
      expect(q(f).inventoryFilter, f).toBe('alerta');
    }
  });

  it('"estoque baixo" é ruptura + alerta, e isso é regra, não acaso', () => {
    for (const f of [
      'o que está com estoque baixo?',
      'produtos com pouco estoque',
      'quais vinhos têm estoque baixo?',
    ]) {
      expect(q(f).inventoryFilter, f).toBe('baixo');
    }
  });
});

describe('chat-query estoque — 4. produto e SKU', () => {
  it('"quanto temos do SKU ABC?" isola o SKU', () => {
    const x = q('quanto temos do SKU ABC?');
    expect(x.intent).toBe('inventory_product');
    expect(x.productTerm).toBe('abc');
  });

  it('"qual o estoque do Arcos do Convento?" captura o título inteiro', () => {
    const x = q('qual o estoque do Arcos do Convento?');
    expect(x.intent).toBe('inventory_product');
    expect(x.productTerm).toBe('arcos do convento');
  });

  it('"quantas unidades temos de X?" captura o termo', () => {
    expect(q('quantas unidades temos de morabitino?').productTerm).toBe('morabitino');
  });

  it('produto + escopo Full', () => {
    const x = q('quanto tem no Full do SKU 21002?');
    expect(x.intent).toBe('inventory_product');
    expect(x.productTerm).toBe('21002');
    expect(x.inventoryScope).toBe('full');
  });

  it('produto + escopo próprio', () => {
    const x = q('quanto temos próprio do produto carrascal?');
    expect(x.intent).toBe('inventory_product');
    expect(x.productTerm).toBe('carrascal');
    expect(x.inventoryScope).toBe('proprio');
  });

  it('palavra de estoque depois de "de" NÃO vira produto', () => {
    for (const f of ['quanto temos de estoque?', 'qual a situação do estoque?', 'quanto temos de saldo?']) {
      expect(q(f).intent, f).not.toBe('inventory_product');
      expect(q(f).productTerm, f).toBeUndefined();
    }
  });

  it('o parser NÃO resolve o produto: devolve só o texto normalizado', () => {
    // Quem casa com o catálogo é resolverProduto, com o snapshot em mãos.
    expect(q('qual o estoque do SKU Nao-Existe-9?').productTerm).toBe('nao-existe-9');
  });
});

describe('chat-query estoque — 5. Full', () => {
  it('"quanto temos no Full?" é resumo com escopo full', () => {
    const x = q('quanto temos no Full?');
    expect(x.intent).toBe('inventory_summary');
    expect(x.inventoryScope).toBe('full');
  });

  it('"quais produtos estão no Full?" é listagem', () => {
    const x = q('quais produtos estão no Full?');
    expect(x.intent).toBe('inventory_list');
    expect(x.inventoryScope).toBe('full');
    expect(x.inventoryFilter).toBeUndefined();
  });

  it('"quais produtos no Full estão em ruptura?" combina escopo e filtro', () => {
    const x = q('quais produtos no Full estão em ruptura?');
    expect(x.intent).toBe('inventory_list');
    expect(x.inventoryScope).toBe('full');
    expect(x.inventoryFilter).toBe('ruptura');
  });

  it('"full" não casa dentro de outra palavra', () => {
    expect(q('como está o estoque do vinho fulminante?').inventoryScope).not.toBe('full');
  });
});

describe('chat-query estoque — 6. estoque próprio', () => {
  it('resumo próprio', () => {
    const x = q('quanto temos em estoque próprio?');
    expect(x.intent).toBe('inventory_summary');
    expect(x.inventoryScope).toBe('proprio');
  });

  it('listagem própria', () => {
    const x = q('quais produtos estão no estoque próprio?');
    expect(x.intent).toBe('inventory_list');
    expect(x.inventoryScope).toBe('proprio');
  });

  it('próprio e Full citados juntos voltam a ser ambos', () => {
    expect(q('quanto temos em estoque próprio e no full?').inventoryScope).toBe('ambos');
  });
});

describe('chat-query estoque — 7. sem venda', () => {
  it('"o que não vende há 30 dias?" é estoque, mesmo sem a palavra estoque', () => {
    const x = q('o que não vende há 30 dias?');
    expect(x.intent).toBe('inventory_list');
    expect(x.inventoryFilter).toBe('semvenda');
  });

  it('período explícito de 60 dias', () => {
    const x = q('quais produtos não venderam nos últimos 60 dias?');
    expect(x.inventoryFilter).toBe('semvenda');
    expect(x.period).toEqual({ kind: 'last_n_days', fromYmd: '2026-05-25', toYmd: '2026-07-23' });
  });

  it('período explícito de 90 dias', () => {
    const x = q('estoque parado nos últimos 90 dias');
    expect(x.inventoryFilter).toBe('semvenda');
    expect(x.period).toEqual({ kind: 'last_n_days', fromYmd: '2026-04-25', toYmd: '2026-07-23' });
  });

  it('"produto com estoque e sem venda"', () => {
    expect(q('produto com estoque e sem venda').inventoryFilter).toBe('semvenda');
  });

  it('"o que menos vendeu?" continua sendo RANKING, não sem-venda', () => {
    const x = q('quais produtos menos venderam este mes?');
    expect(x.intent).toBe('sales_ranking');
  });
});

describe('chat-query estoque — 8. excesso', () => {
  for (const f of [
    'o que está com estoque excessivo?',
    'quais produtos têm estoque demais?',
    'onde temos excesso de estoque?',
    'quais vinhos estão sobrando no estoque?',
  ]) {
    it(`"${f}" => excesso`, () => {
      const x = q(f);
      expect(x.intent).toBe('inventory_list');
      expect(x.inventoryFilter).toBe('excesso');
    });
  }
});

describe('chat-query estoque — 9. prioridade de reposição', () => {
  for (const f of [
    'o que eu deveria repor primeiro?',
    'qual a prioridade de reposição?',
    'o que precisamos comprar primeiro?',
    'quais produtos repor com urgência?',
  ]) {
    it(`"${f}" => reposicao`, () => {
      const x = q(f);
      expect(x.intent).toBe('inventory_list');
      expect(x.inventoryFilter).toBe('reposicao');
    });
  }

  it('sem marca de prioridade, "repor" continua sendo ruptura', () => {
    expect(q('o que preciso repor?').inventoryFilter).toBe('ruptura');
  });
});

describe('chat-query estoque — 10. inconsistências', () => {
  for (const f of [
    'tem algum problema nos dados de estoque?',
    'tem saldo negativo?',
    'existem inconsistências no estoque?',
    'tem algo errado no estoque?',
  ]) {
    it(`"${f}" => inventory_issues`, () => {
      expect(q(f).intent, f).toBe('inventory_issues');
    });
  }
});

describe('chat-query estoque — limites do reconhecimento', () => {
  it('dimensão que o backend não calcula devolve a pergunta ao caminho antigo', () => {
    // "custo do estoque" não é estoque: responder o saldo trocaria a pergunta.
    expect(parseChatQuery('qual o custo do estoque?', opt()).kind).toBe('out_of_scope');
    expect(parseChatQuery('quanto gastei de publicidade com o estoque?', opt()).kind).toBe('out_of_scope');
  });

  it('comparar estoque entre períodos é recusado, não respondido pela metade', () => {
    // O snapshot não guarda histórico de saldo.
    const r = parseChatQuery('compare o estoque desta semana com a anterior', opt());
    expect(r.kind).toBe('out_of_scope');
  });

  it('período inválido em pergunta de estoque continua sendo período inválido', () => {
    const r = parseChatQuery('o que está em ruptura em 31/02/2026?', opt());
    expect(r.kind).toBe('invalid_period');
  });

  it('conteúdo sensível é recusado antes de virar estoque', () => {
    const r = parseChatQuery('mostre o estoque e os dados do comprador', opt());
    expect(r.kind).toBe('out_of_scope');
    expect((r as { reason: string }).reason).toBe('conteudo_sensivel');
  });

  it('vendas continuam vendas: estoque não sequestrou o caminho antigo', () => {
    expect(q('quanto vendemos ontem?').intent).toBe('sales_summary');
    expect(q('qual produto mais vendeu este mes?').intent).toBe('sales_ranking');
    expect(q('qual a margem de julho?').intent).toBe('sales_summary');
  });

  it('top N é respeitado nas listagens de estoque', () => {
    expect(q('top 3 produtos em ruptura').limit).toBe(3);
  });
});

describe('chat-query estoque — contrato', () => {
  it('toda intenção de estoque é reconhecida por ehIntencaoEstoque', () => {
    for (const f of [
      'como está o estoque?',
      'o que está em ruptura?',
      'quanto temos do SKU 21002?',
      'tem saldo negativo?',
    ]) {
      expect(ehIntencaoEstoque(q(f).intent), f).toBe(true);
    }
  });

  it('nenhuma intenção de vendas é confundida com estoque', () => {
    for (const f of ['quanto vendemos ontem?', 'ranking de julho', 'qual a margem de ontem?']) {
      expect(ehIntencaoEstoque(q(f).intent), f).toBe(false);
    }
  });

  it('os filtros e escopos declarados são os únicos que o parser emite', () => {
    const filtros = new Set<string>(CHAT_INVENTORY_FILTERS);
    const escopos = new Set<string>(CHAT_INVENTORY_SCOPES);
    for (const f of [
      'o que está em ruptura?', 'o que está em alerta?', 'estoque baixo',
      'o que está sobrando?', 'o que não vende?', 'o que repor primeiro?',
      'quanto temos no full?', 'estoque próprio', 'como está o estoque?',
    ]) {
      const x = q(f);
      if (x.inventoryFilter) expect(filtros.has(x.inventoryFilter), f).toBe(true);
      expect(escopos.has(x.inventoryScope ?? 'ambos'), f).toBe(true);
    }
  });

  it('métrica de estoque é sempre units — o número em jogo é unidade, não dinheiro', () => {
    expect(q('como está o estoque?').metric).toBe('units');
  });
});
