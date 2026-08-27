/**
 * Valida o PARSER do workflow de sincronização executando o Python de verdade,
 * extraído de .github/workflows/orders-sync.yml, contra respostas REAIS
 * capturadas nos logs do GitHub Actions.
 *
 * Existe porque o parser é a única parte do sistema sem cobertura, e foi
 * exatamente ali que nasceu o defeito: entre 17/08/2026 e 24/08/2026, a
 * resposta de sucesso `sem_novos` era interpretada como falha fatal e 34 das
 * 60 últimas execuções ficaram vermelhas com o backend saudável.
 *
 * O teste é um contrato entre dois arquivos que não se enxergam: o YAML decide
 * pelo par (ok, concluido, retomavel, motivo) que orders-sync.service.ts
 * produz. Mudar um sem o outro quebra aqui.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const YAML = '.github/workflows/orders-sync.yml';

/**
 * Extrai um bloco `python3 ... <<'PY' ... PY` do YAML e remove a indentação do
 * bloco escalar, que é o que o YAML faria antes de entregar o script ao shell.
 */
function extrairPython(indice: number): string {
  const linhas = readFileSync(YAML, 'utf8').split(/\r?\n/);
  const inicios: number[] = [];
  linhas.forEach((l, i) => { if (l.includes("<<'PY'")) inicios.push(i); });
  expect(inicios.length, 'blocos python no workflow').toBeGreaterThan(indice);

  const corpo: string[] = [];
  for (let i = inicios[indice] + 1; i < linhas.length; i++) {
    if (linhas[i].trim() === 'PY') break;
    corpo.push(linhas[i]);
  }
  const recuo = Math.min(
    ...corpo.filter(l => l.trim() !== '').map(l => l.length - l.trimStart().length)
  );
  return corpo.map(l => l.slice(recuo)).join('\n');
}

/** Roda o parser com uma resposta e devolve o código de saída. */
function rodar(script: string, resposta: string): { code: number; saida: string } {
  const arquivo = `${process.env.TEMP || '/tmp'}/ow-parser-${Math.random().toString(36).slice(2)}.json`;
  const fs = require('node:fs') as typeof import('node:fs');
  fs.writeFileSync(arquivo, resposta, 'utf8');
  try {
    const r = spawnSync('python3', ['-c', script, arquivo], { encoding: 'utf8' });
    return { code: r.status ?? -1, saida: (r.stdout || '') + (r.stderr || '') };
  } finally {
    try { fs.unlinkSync(arquivo); } catch { /* temporário */ }
  }
}

const PY_SYNC = extrairPython(0);
const PY_LOGISTICA = extrairPython(1);
const PY_DRENO = extrairPython(2);

/**
 * Códigos de saída do parser de sincronização:
 *   0  → terminou (publicou, ou não havia nada a publicar)
 *   10 → parcial e retomável: o laço do shell chama o próximo passo
 *   1  → falha de verdade
 */
const CONCLUIU = 0;
const CONTINUA = 10;
const FALHA = 1;

describe('workflow orders-sync — parser da sincronização', () => {
  it('sem_novos é SUCESSO — a resposta exata que derrubava 57% das execuções', () => {
    // Capturada nos runs 32747860494, 32719072848 e 32709569639, idêntica nos
    // dois backends.
    const r = rodar(PY_SYNC, JSON.stringify({
      ok: true, concluido: false, retomavel: false,
      committedOffset: 250, paginasLidas: 5, novosPedidos: 0, motivo: 'sem_novos',
    }));
    expect(r.code, r.saida).toBe(CONCLUIU);
    expect(r.saida).not.toContain('::error::');
  });

  it('parcial e retomável pede o próximo passo', () => {
    // Passo 1 dos runs 32753642339 e 32758600425.
    const r = rodar(PY_SYNC, JSON.stringify({
      ok: true, concluido: false, retomavel: true,
      committedOffset: 250, paginasLidas: 5, novosPedidos: 1, motivo: 'parcial',
    }));
    expect(r.code, r.saida).toBe(CONTINUA);
  });

  it('concluído encerra com sucesso', () => {
    // Passo 2 dos mesmos runs, e a forma única de antes de 17/08.
    const r = rodar(PY_SYNC, JSON.stringify({
      ok: true, concluido: true, retomavel: false,
      committedOffset: 300, paginasLidas: 1, novosPedidos: 1,
    }));
    expect(r.code, r.saida).toBe(CONCLUIU);
  });

  it('ok:false continua sendo falha, mesmo retomável', () => {
    const r = rodar(PY_SYNC, JSON.stringify({
      ok: false, concluido: false, retomavel: true,
      committedOffset: 100, paginasLidas: 2, novosPedidos: 0,
      motivo: 'erro_parcial: pagina 3 falhou',
    }));
    expect(r.code).toBe(FALHA);
    expect(r.saida).toContain('::error::');
  });

  it('ok:false e não retomável é falha', () => {
    const r = rodar(PY_SYNC, JSON.stringify({
      ok: false, concluido: false, retomavel: false, motivo: 'limite_excedido',
    }));
    expect(r.code).toBe(FALHA);
  });

  it('o conserto NÃO mascara outro estado não retomável', () => {
    // Só `sem_novos` passa. Qualquer outro motivo sem retomada continua vermelho.
    const r = rodar(PY_SYNC, JSON.stringify({
      ok: true, concluido: false, retomavel: false, motivo: 'estado_desconhecido',
    }));
    expect(r.code).toBe(FALHA);
    expect(r.saida).toContain('::error::');
  });

  it('resposta que não é JSON é falha', () => {
    const r = rodar(PY_SYNC, 'isto nao e json');
    expect(r.code).toBe(FALHA);
    expect(r.saida).toContain('::error::');
  });

  it('o resumo impresso cita os campos que o operador precisa', () => {
    const r = rodar(PY_SYNC, JSON.stringify({
      ok: true, concluido: true, retomavel: false,
      committedOffset: 300, paginasLidas: 1, novosPedidos: 7,
    }));
    for (const campo of ['ok=', 'concluido=', 'retomavel=', 'committedOffset=', 'novosPedidos=']) {
      expect(r.saida, campo).toContain(campo);
    }
  });
});

describe('workflow orders-sync — parser da logística', () => {
  it('concluído encerra', () => {
    const r = rodar(PY_LOGISTICA, JSON.stringify({
      ok: true, concluido: true, buscados: 0, resolvidos: 0, falhas: 0, restantes: 0, cobertura: 1,
    }));
    expect(r.code, r.saida).toBe(CONCLUIU);
  });

  it('ainda faltam envios pede o próximo passo', () => {
    const r = rodar(PY_LOGISTICA, JSON.stringify({
      ok: true, concluido: false, buscados: 300, resolvidos: 300, falhas: 0, restantes: 900, cobertura: 0.25,
    }));
    expect(r.code, r.saida).toBe(CONTINUA);
  });

  it('ok:false é falha', () => {
    const r = rodar(PY_LOGISTICA, JSON.stringify({ ok: false, concluido: false }));
    expect(r.code).toBe(FALHA);
    expect(r.saida).toContain('::error::');
  });

  it('cobertura ausente não quebra a impressão', () => {
    const r = rodar(PY_LOGISTICA, JSON.stringify({ ok: true, concluido: true }));
    expect(r.code, r.saida).toBe(CONCLUIU);
    expect(r.saida).toContain('cobertura=?');
  });
});


/**
 * Parser do dreno da fila de notificações.
 *
 * A regra que este bloco existe para travar: um evento que falhou e voltou
 * para a fila NÃO deixa o job vermelho. Ele é aviso, porque o job `sync` varre
 * a API do Mercado Livre de qualquer forma e recupera o pedido — marcar
 * vermelho aqui produziria exatamente o ruído recorrente que já custou 34 de
 * 60 execuções em agosto/2026, agora por outro caminho.
 */
describe('workflow orders-sync — parser do dreno de notificacoes', () => {
  it('fila vazia é sucesso silencioso — o estado NORMAL do job', () => {
    const r = rodar(PY_DRENO, JSON.stringify({
      ok: true, processados: 0, novos: 0, atualizados: 0, semMudanca: 0,
      falhas: 0, restantes: 0,
    }));
    expect(r.code, r.saida).toBe(0);
    expect(r.saida).not.toContain('::error::');
    expect(r.saida).not.toContain('::warning::');
  });

  it('eventos aplicados são reportados e não geram aviso', () => {
    const r = rodar(PY_DRENO, JSON.stringify({
      ok: true, processados: 3, novos: 2, atualizados: 1, semMudanca: 0,
      falhas: 0, restantes: 0,
    }));
    expect(r.code, r.saida).toBe(0);
    expect(r.saida).toContain('novos=2');
    expect(r.saida).not.toContain('::warning::');
  });

  it('falha em um evento é AVISO, nunca erro: a sincronizacao periodica cobre', () => {
    const r = rodar(PY_DRENO, JSON.stringify({
      ok: false, processados: 1, novos: 0, atualizados: 0, semMudanca: 0,
      falhas: 1, restantes: 1,
    }));
    expect(r.code, r.saida).toBe(0);
    expect(r.saida).toContain('::warning::');
    expect(r.saida).not.toContain('::error::');
  });

  it('lock ocupado (motivo sync_em_andamento) nao derruba o job', () => {
    const r = rodar(PY_DRENO, JSON.stringify({
      ok: true, processados: 0, novos: 0, atualizados: 0, semMudanca: 0,
      falhas: 0, restantes: 2, motivo: 'sync_em_andamento',
    }));
    expect(r.code, r.saida).toBe(0);
    expect(r.saida).toContain('motivo=sync_em_andamento');
    expect(r.saida).toContain('::warning::');
  });

  it('resposta que nao e JSON e falha', () => {
    const r = rodar(PY_DRENO, '<html>502</html>');
    expect(r.code).toBe(1);
    expect(r.saida).toContain('::error::');
  });
});
