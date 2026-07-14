/**
 * Sessões do dashboard — token opaco, aleatório, SEM nenhuma credencial do ML.
 *
 * Decisão de arquitetura (cookies cross-site):
 * O dashboard vive em igororlandi999.github.io e o backend em *.vercel.app —
 * domínios diferentes = cookie de terceiros. Isso exigiria SameSite=None e
 * funcionaria hoje no Chrome/Firefox, mas o Safari (ITP) bloqueia cookies
 * de terceiros por padrão, quebrando o dashboard no iPhone/Mac. Por isso a
 * sessão usa um token opaco enviado via header Authorization: Bearer sess_...
 * mantido EM MEMÓRIA no frontend (nunca em localStorage).
 *
 * - Vida útil: 12h deslizantes (renova a cada uso), máximo absoluto de 24h.
 * - Armazenada no Redis: sess:<id> → { createdAt, lastSeenAt }.
 * - Brute force: rate limit por IP + bloqueio progressivo (ver api/auth).
 */
import { randomBytes } from 'node:crypto';
import type { Cache } from './cache/cache.js';

const SLIDING_TTL_S = 12 * 3600;
const ABSOLUTE_MAX_MS = 24 * 3600 * 1000;
const PREFIX = 'sess_';

interface SessionData {
  createdAt: number;
  lastSeenAt: number;
}

export interface SessionInfo {
  id: string;
  expiresAt: number; // estimativa (janela deslizante)
}

export async function createSession(cache: Cache): Promise<SessionInfo> {
  const id = PREFIX + randomBytes(32).toString('hex');
  const now = Date.now();
  const data: SessionData = { createdAt: now, lastSeenAt: now };
  await cache.set(`sess:${id}`, JSON.stringify(data), SLIDING_TTL_S);
  return { id, expiresAt: now + SLIDING_TTL_S * 1000 };
}

/** Valida e renova (janela deslizante). Retorna null se inválida/expirada. */
export async function validateSession(cache: Cache, token: string | null): Promise<SessionInfo | null> {
  if (!token || !token.startsWith(PREFIX) || token.length < 40 || token.length > 200) return null;
  const raw = await cache.get(`sess:${token}`);
  if (!raw) return null;

  let data: SessionData;
  try {
    data = JSON.parse(raw) as SessionData;
  } catch {
    await cache.del(`sess:${token}`);
    return null;
  }

  const now = Date.now();
  if (now - data.createdAt > ABSOLUTE_MAX_MS) {
    await cache.del(`sess:${token}`);
    return null;
  }

  // Renovação deslizante (regrava com TTL cheio), no máximo 1x/min p/ economizar Redis.
  if (now - data.lastSeenAt > 60_000) {
    data.lastSeenAt = now;
    await cache.set(`sess:${token}`, JSON.stringify(data), SLIDING_TTL_S);
  }
  return { id: token, expiresAt: Math.min(now + SLIDING_TTL_S * 1000, data.createdAt + ABSOLUTE_MAX_MS) };
}

export async function destroySession(cache: Cache, token: string): Promise<void> {
  if (token.startsWith(PREFIX)) await cache.del(`sess:${token}`);
}
