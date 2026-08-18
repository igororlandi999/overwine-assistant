import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { contaComoVenda, STATUS_VENDA } from '../src/lib/status-venda.js';

describe('contaComoVenda', () => {
  it('conta os dois status em que o dinheiro entrou', () => {
    expect(contaComoVenda('paid')).toBe(true);
    expect(contaComoVenda('partially_refunded')).toBe(true);
  });

  it('cancelado nao conta', () => {
    expect(contaComoVenda('cancelled')).toBe(false);
  });

  it('LISTA DE PERMISSAO: status desconhecido NAO vira receita por omissao', () => {
    // Esta e a razao de ser do modulo. Com `!== cancelled`, qualquer status
    // novo do Mercado Livre entraria no faturamento sozinho, sem ninguem
    // decidir. Aqui ele fica de fora ate alguem olhar.
    for (const s of [
      'payment_required',
      'payment_in_process',
      'partially_paid',
      'invalid',
      'status_que_o_ml_ainda_nao_inventou',
    ]) {
      expect(contaComoVenda(s), s).toBe(false);
    }
  });

  it('valores nao-string nao quebram nem contam', () => {
    for (const v of [null, undefined, 0, 1, {}, [], true]) {
      expect(contaComoVenda(v as unknown as string), String(v)).toBe(false);
    }
  });

  it('e sensivel a caixa e a espacos: nao adivinha', () => {
    // Adivinhar aqui esconderia dado sujo vindo da API em vez de expo-lo.
    expect(contaComoVenda('PAID')).toBe(false);
    expect(contaComoVenda(' paid')).toBe(false);
    expect(contaComoVenda('paid ')).toBe(false);
  });

  it('o conjunto exportado tem exatamente os dois status', () => {
    expect([...STATUS_VENDA].sort()).toEqual(['paid', 'partially_refunded']);
  });
});

// ── Guarda estrutural ──────────────────────────────────────────────────────
describe('nenhum servico compara status com string solta', () => {
  function arquivosTs(dir: string): string[] {
    const saida: string[] = [];
    for (const nome of readdirSync(dir)) {
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) saida.push(...arquivosTs(caminho));
      else if (nome.endsWith('.ts')) saida.push(caminho);
    }
    return saida;
  }

  it('a convencao antiga nao volta por descuido', () => {
    // Duas convencoes coexistindo foi exatamente o problema que este modulo
    // resolveu. Se alguem escrever `status === 'paid'` de novo num servico, o
    // sistema volta a divergir em silencio — este teste quebra antes disso.
    const permitidos = new Set([
      // Define o conceito; e o unico lugar onde as strings podem aparecer.
      'src/lib/status-venda.ts',
      // Monta um mapa de contagem POR status para diagnostico. Precisa
      // enxergar todos os status, inclusive os que nao sao venda.
      'src/services/orders-metrics.service.ts',
    ]);

    const proibido = /\bstatus\s*[!=]==\s*['"](paid|cancelled|partially_refunded)['"]/;
    const infratores: string[] = [];

    for (const arquivo of [...arquivosTs('src'), ...arquivosTs('api')]) {
      const rel = arquivo.replace(/\\/g, '/');
      if (permitidos.has(rel)) continue;
      const linhas = readFileSync(arquivo, 'utf8').split('\n');
      linhas.forEach((linha, i) => {
        // Ignora comentário de linha e de bloco: a guarda vale para CÓDIGO.
        const semComentario = linha.replace(/\/\/.*$/, '').replace(/^\s*\*/, '');
        if (proibido.test(semComentario)) infratores.push(`${rel}:${i + 1} ${linha.trim()}`);
      });
    }

    expect(infratores, `Use contaComoVenda() de lib/status-venda:\n${infratores.join('\n')}`)
      .toEqual([]);
  });
});