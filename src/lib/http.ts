import { timingSafeEqual, createHash } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getEnv } from '../config/env.js';
import type { Cache } from './cache/cache.js';

/**
 * CORS restrito ao dashboard (+ localhost dev). IMPORTANTE: CORS aqui é só
 * conveniência de navegador, NÃO é autenticação — toda rota protegida valida
 * a sessão no servidor, independente de origem (curl/Postman incluídos).
 */
export function applyCors(req: VercelRequest, res: VercelResponse): boolean {
  const env = getEnv();
  const origin = req.headers.origin || '';
  const allowed = [env.ALLOWED_ORIGIN, 'http://localhost:5501', 'http://127.0.0.1:5501'];
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

/** Comparação em tempo constante (evita timing attack). */
export function safeEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function clientIp(req: VercelRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : fwd || 'unknown').split(',')[0].trim();
}

/** Rate limit por chave arbitrária: `limit` requisições por janela. */
export async function rateLimitOk(
  cache: Cache,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const windowId = Math.floor(Date.now() / (windowSeconds * 1000));
  const n = await cache.incr(`rl:${key}:${windowId}`, windowSeconds);
  return n <= limit;
}

/** Extrai o token de sessão do header Authorization: Bearer sess_... */
export function readBearer(req: VercelRequest): string | null {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

export function json(res: VercelResponse, status: number, body: unknown) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}

/** Mascara IP nos logs (LGPD-friendly): 187.45.x.x */
export function maskIp(ip: string): string {
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.x.x` : ip.slice(0, 8) + '…';
}
