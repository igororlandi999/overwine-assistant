/**
 * Cursor opaco de paginação de pedidos (Fase 4c.1).
 *
 * Conteúdo (e SOMENTE ele):
 *   { v: number, o: number, a: 'ativos' | 'cancelados' }
 *   v = versão do snapshot em que a paginação foi ancorada
 *   o = offset global (índice do próximo pedido a servir)
 *   a = alvo (trava o cursor a uma coleção)
 *
 * Codificado em base64url. NÃO é mecanismo de autenticação — a sessão continua
 * obrigatória na rota. O cursor não carrega nenhuma chave Redis, nome de chunk,
 * token ou credencial: só três inteiros/enum de negócio.
 */
import type { Alvo } from '../lib/orders-store.js';

export interface CursorData {
  v: number;
  o: number;
  a: Alvo;
}

/** Erro de cursor malformado/adulterado — a rota traduz para 400 invalid_cursor. */
export class InvalidCursorError extends Error {
  constructor(motivo = 'cursor inválido') {
    super(motivo);
    this.name = 'InvalidCursorError';
  }
}

function toBase64Url(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  // Rejeita qualquer caractere fora do alfabeto base64url ANTES de decodificar.
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new InvalidCursorError('caractere inválido no cursor');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf-8');
}

export function encodeCursor(data: CursorData): string {
  return toBase64Url(JSON.stringify({ v: data.v, o: data.o, a: data.a }));
}

/**
 * Decodifica e valida rigorosamente. Qualquer desvio lança InvalidCursorError:
 * base64 inválido, JSON inválido, tipos errados, v não-inteiro-positivo,
 * o não-inteiro-≥0, ou alvo inválido.
 */
export function decodeCursor(raw: string): CursorData {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) {
    throw new InvalidCursorError('cursor vazio ou grande demais');
  }

  let json: string;
  try {
    json = fromBase64Url(raw);
  } catch (e) {
    if (e instanceof InvalidCursorError) throw e;
    throw new InvalidCursorError('base64 inválido');
  }

  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new InvalidCursorError('JSON inválido');
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new InvalidCursorError('estrutura inválida');
  }
  const c = obj as Record<string, unknown>;

  if (typeof c.v !== 'number' || !Number.isInteger(c.v) || c.v <= 0) {
    throw new InvalidCursorError('v deve ser inteiro positivo');
  }
  if (typeof c.o !== 'number' || !Number.isInteger(c.o) || c.o < 0) {
    throw new InvalidCursorError('o deve ser inteiro >= 0');
  }
  if (c.a !== 'ativos' && c.a !== 'cancelados') {
    throw new InvalidCursorError('alvo inválido');
  }

  return { v: c.v, o: c.o, a: c.a };
}