import { describe, it, expect } from 'vitest';
import {
  brtStartOfDay,
  brtEndOfDay,
  ymdBRT,
  dentroDoPeriodo,
  hojeBRT,
  semanasEntre,
  ymdValido,
} from '../src/lib/datas-brt.js';

// A Vercel roda em UTC; os testes NÃO assumem o fuso do processo — todas as
// expectativas são expressas em epoch/ISO UTC (São Paulo = UTC-03:00).

describe('brtStartOfDay', () => {
  it('início do dia em São Paulo = 03:00 UTC do mesmo dia', () => {
    const d = brtStartOfDay('2026-07-17');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-07-17T03:00:00.000Z');
  });

  it('vale para anos e meses diferentes (virada de ano)', () => {
    expect(brtStartOfDay('2025-12-31')!.toISOString()).toBe('2025-12-31T03:00:00.000Z');
    expect(brtStartOfDay('2026-01-01')!.toISOString()).toBe('2026-01-01T03:00:00.000Z');
    // 29/02 em ano bissexto é válido
    expect(brtStartOfDay('2024-02-29')!.toISOString()).toBe('2024-02-29T03:00:00.000Z');
  });

  it('rejeita entradas inválidas com null explícito', () => {
    expect(brtStartOfDay(null)).toBeNull();
    expect(brtStartOfDay(undefined)).toBeNull();
    expect(brtStartOfDay('')).toBeNull();
    expect(brtStartOfDay('17/07/2026')).toBeNull();   // formato BR
    expect(brtStartOfDay('2026-7-1')).toBeNull();     // sem zero à esquerda
    expect(brtStartOfDay('2026-02-30')).toBeNull();   // dia inexistente
    expect(brtStartOfDay('2026-02-29')).toBeNull();   // 2026 não é bissexto
    expect(brtStartOfDay('2026-13-01')).toBeNull();   // mês inexistente
  });
});

describe('brtEndOfDay', () => {
  it('fim do dia em São Paulo = 02:59:59.999 UTC do dia SEGUINTE', () => {
    const d = brtEndOfDay('2026-07-17');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-07-18T02:59:59.999Z');
  });

  it('fim de mês atravessa a fronteira do mês em UTC', () => {
    expect(brtEndOfDay('2026-06-30')!.toISOString()).toBe('2026-07-01T02:59:59.999Z');
    expect(brtEndOfDay('2025-12-31')!.toISOString()).toBe('2026-01-01T02:59:59.999Z');
  });

  it('rejeita entradas inválidas com null explícito', () => {
    expect(brtEndOfDay(null)).toBeNull();
    expect(brtEndOfDay('2026-02-30')).toBeNull();
  });
});

describe('ymdBRT', () => {
  it('instante UTC de madrugada ainda pertence ao dia ANTERIOR em BRT', () => {
    // 02:59 UTC do dia 17 = 23:59 BRT do dia 16
    expect(ymdBRT(new Date('2026-07-17T02:59:00.000Z'))).toBe('2026-07-16');
    // exatamente 03:00 UTC vira 00:00 BRT — já é dia 17
    expect(ymdBRT(new Date('2026-07-17T03:00:00.000Z'))).toBe('2026-07-17');
  });

  it('instante que já é o dia seguinte em UTC mas ainda é o dia anterior em BRT', () => {
    // 01:00 UTC do dia 18 = 22:00 BRT do dia 17
    expect(ymdBRT(new Date('2026-07-18T01:00:00.000Z'))).toBe('2026-07-17');
  });

  it('aceita ISO com offset -03:00 (formato do ML) e epoch', () => {
    expect(ymdBRT('2026-06-10T22:14:00.000-03:00')).toBe('2026-06-10');
    // mesmo instante expresso em UTC (01:14Z do dia 11) continua sendo 10/06 em BRT
    expect(ymdBRT('2026-06-11T01:14:00.000Z')).toBe('2026-06-10');
    expect(ymdBRT(Date.UTC(2026, 0, 1, 12, 0, 0))).toBe('2026-01-01');
  });

  it('vira ano corretamente (réveillon em BRT)', () => {
    // 01:30 UTC de 01/01/2026 = 22:30 BRT de 31/12/2025
    expect(ymdBRT(new Date('2026-01-01T01:30:00.000Z'))).toBe('2025-12-31');
  });

  it('entrada inválida retorna null', () => {
    expect(ymdBRT(null)).toBeNull();
    expect(ymdBRT(undefined)).toBeNull();
    expect(ymdBRT('')).toBeNull();
    expect(ymdBRT('nao-e-data')).toBeNull();
    expect(ymdBRT(new Date('invalid'))).toBeNull();
  });
});

describe('dentroDoPeriodo', () => {
  const ini = brtStartOfDay('2026-07-10')!;
  const fim = brtEndOfDay('2026-07-17')!;

  it('data dentro do período', () => {
    expect(dentroDoPeriodo('2026-07-14T15:00:00.000-03:00', ini, fim)).toBe(true);
  });

  it('borda inicial é INCLUSIVA (exatamente 00:00:00.000 BRT do primeiro dia)', () => {
    expect(dentroDoPeriodo('2026-07-10T00:00:00.000-03:00', ini, fim)).toBe(true);
    // 1 ms antes fica fora
    expect(dentroDoPeriodo('2026-07-09T23:59:59.999-03:00', ini, fim)).toBe(false);
  });

  it('borda final é INCLUSIVA (exatamente 23:59:59.999 BRT do último dia)', () => {
    expect(dentroDoPeriodo('2026-07-17T23:59:59.999-03:00', ini, fim)).toBe(true);
    // 1 ms depois (00:00:00.000 do dia 18) fica fora
    expect(dentroDoPeriodo('2026-07-18T00:00:00.000-03:00', ini, fim)).toBe(false);
  });

  it('data fora do período (antes e depois)', () => {
    expect(dentroDoPeriodo('2026-07-01T12:00:00.000-03:00', ini, fim)).toBe(false);
    expect(dentroDoPeriodo('2026-08-01T12:00:00.000-03:00', ini, fim)).toBe(false);
  });

  it('período de um único dia contém o dia inteiro e nada além', () => {
    const i = brtStartOfDay('2026-07-17')!;
    const f = brtEndOfDay('2026-07-17')!;
    expect(dentroDoPeriodo('2026-07-17T00:00:00.000-03:00', i, f)).toBe(true);
    expect(dentroDoPeriodo('2026-07-17T12:34:56.000-03:00', i, f)).toBe(true);
    expect(dentroDoPeriodo('2026-07-17T23:59:59.999-03:00', i, f)).toBe(true);
    expect(dentroDoPeriodo('2026-07-16T23:59:59.999-03:00', i, f)).toBe(false);
    expect(dentroDoPeriodo('2026-07-18T00:00:00.000-03:00', i, f)).toBe(false);
  });

  it('limites nulos significam "sem limite" daquele lado', () => {
    expect(dentroDoPeriodo('1999-01-01T00:00:00.000Z', null, fim)).toBe(true);
    expect(dentroDoPeriodo('2099-01-01T00:00:00.000Z', ini, null)).toBe(true);
    expect(dentroDoPeriodo('2099-01-01T00:00:00.000Z', null, null)).toBe(true);
  });

  it('ISO ausente ou inválido nunca pertence a período algum', () => {
    expect(dentroDoPeriodo(null, ini, fim)).toBe(false);
    expect(dentroDoPeriodo(undefined, ini, fim)).toBe(false);
    expect(dentroDoPeriodo('', ini, fim)).toBe(false);
    expect(dentroDoPeriodo('data-invalida', ini, fim)).toBe(false);
  });

  it('funciona atravessando anos e meses', () => {
    const i = brtStartOfDay('2025-12-15')!;
    const f = brtEndOfDay('2026-01-15')!;
    expect(dentroDoPeriodo('2025-12-31T23:00:00.000-03:00', i, f)).toBe(true);
    expect(dentroDoPeriodo('2026-01-01T01:00:00.000-03:00', i, f)).toBe(true);
    expect(dentroDoPeriodo('2026-01-16T00:00:00.000-03:00', i, f)).toBe(false);
  });
});

describe('hojeBRT (relógio injetável)', () => {
  it('usa o relógio injetado, nunca a hora real, e respeita o dia civil BRT', () => {
    // 02:00 UTC de 17/07 ainda é 16/07 em São Paulo
    expect(hojeBRT(new Date('2026-07-17T02:00:00.000Z'))).toBe('2026-07-16');
    // 12:00 UTC de 17/07 é 09:00 BRT — dia 17
    expect(hojeBRT(new Date('2026-07-17T12:00:00.000Z'))).toBe('2026-07-17');
  });

  it('sem argumento retorna um YMD válido (fumaça, sem fixar o valor)', () => {
    expect(ymdValido(hojeBRT())).toBe(true);
  });

  it('Date inválido injetado gera erro explícito', () => {
    expect(() => hojeBRT(new Date('invalid'))).toThrow(/inválido/);
  });
});

describe('semanasEntre', () => {
  it('calcula semanas fracionárias', () => {
    const ini = new Date('2026-07-01T00:00:00.000Z');
    expect(semanasEntre(ini, new Date('2026-07-08T00:00:00.000Z'))).toBe(1);
    expect(semanasEntre(ini, new Date('2026-07-04T12:00:00.000Z'))).toBeCloseTo(0.5, 10);
  });

  it('nunca retorna negativo e trata entradas inválidas como 0', () => {
    const a = new Date('2026-07-08T00:00:00.000Z');
    const b = new Date('2026-07-01T00:00:00.000Z');
    expect(semanasEntre(a, b)).toBe(0);          // fim antes do início
    expect(semanasEntre(null, b)).toBe(0);
    expect(semanasEntre(a, undefined)).toBe(0);
    expect(semanasEntre(new Date('invalid'), b)).toBe(0);
  });
});