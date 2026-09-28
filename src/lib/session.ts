/**
 * Sessões do dashboard — token opaco, aleatório, SEM nenhuma credencial do ML.
 *
 * Decisão de arquitetura (cookies cross-site):
 * O dashboard vive em igororlandi999.github.io e o backend em *.vercel.app —
 * domínios diferentes = cookie de terceiros. Isso exigiria SameSite=None e
 * funcionaria hoje no Chrome/Firefox, mas o Safari (ITP) bloqueia cookies
 * de terceiros por padrão, quebrando o dashboard no iPhone/Mac. Por isso a
 * sessão usa um token opaco enviado via header Authorization: Bearer sess_...
 *
 * O frontend guarda esse token — e SÓ ele — em localStorage ("manter
 * conectado") ou sessionStorage. Nunca a senha, nunca token do ML: o id da
 * sessão não contém nem dá acesso a credencial alguma, e é revogável um a um
 * (cada login cria a sua; logout apaga a sua).
 *
 * Duas vidas úteis, escolhidas no login:
 * - sessão comum: 12h deslizantes (renova a cada uso), máximo absoluto de 24h;
 * - sessão persistente ("manter conectado"): 30 dias deslizantes, máximo
 *   absoluto de 90 dias. Não é eterna: um navegador que ficar 30 dias sem
 *   abrir o dashboard volta para a senha, e nenhum token vive mais de 90 dias
 *   desde o login, por mais que seja usado.
 * - Armazenada no Redis: sess:<id> → { createdAt, lastSeenAt, persistente }.
 *   O TTL do Redis é a expiração deslizante: sessão sem uso some sozinha.
 * - 256 bits de entropia (32 bytes aleatórios em hex).
 * - Brute force: rate limit por IP + bloqueio progressivo (ver api/auth).
 */
import { randomBytes } from 'node:crypto';
import type { Cache } from './cache/cache.js';

const SLIDING_TTL_S = 12 * 3600;
const ABSOLUTE_MAX_MS = 24 * 3600 * 1000;
export const PERSISTENT_SLIDING_TTL_S = 30 * 24 * 3600;
export const PERSISTENT_ABSOLUTE_MAX_MS = 90 * 24 * 3600 * 1000;
const PREFIX = 'sess_';

interface SessionData {
  createdAt: number;
  lastSeenAt: number;
  /** Ausente em sessões criadas antes desta versão → equivale a false. */
  persistente?: boolean;
}

export interface SessionInfo {
  id: string;
  expiresAt: number; // estimativa (janela deslizante)
  persistente: boolean;
}

function janela(persistente: boolean): { ttlS: number; maxMs: number; renovarAposMs: number } {
  return persistente
    // Renovar o TTL de 30 dias a cada uso seria uma escrita por requisição;
    // uma por hora basta para a janela deslizante e não muda o resultado.
    ? { ttlS: PERSISTENT_SLIDING_TTL_S, maxMs: PERSISTENT_ABSOLUTE_MAX_MS, renovarAposMs: 3600_000 }
    : { ttlS: SLIDING_TTL_S, maxMs: ABSOLUTE_MAX_MS, renovarAposMs: 60_000 };
}

export async function createSession(
  cache: Cache,
  opts: { persistente?: boolean } = {}
): Promise<SessionInfo> {
  const persistente = opts.persistente === true;
  const id = PREFIX + randomBytes(32).toString('hex');
  const now = Date.now();
  const data: SessionData = { createdAt: now, lastSeenAt: now, persistente };
  const { ttlS } = janela(persistente);
  await cache.set(`sess:${id}`, JSON.stringify(data), ttlS);
  return { id, expiresAt: now + ttlS * 1000, persistente };
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

  const persistente = data.persistente === true;
  const { ttlS, maxMs, renovarAposMs } = janela(persistente);
  const now = Date.now();
  if (now - data.createdAt > maxMs) {
    await cache.del(`sess:${token}`);
    return null;
  }

  // Renovação deslizante (regrava com TTL cheio), com um mínimo entre
  // renovações para economizar Redis.
  if (now - data.lastSeenAt > renovarAposMs) {
    data.lastSeenAt = now;
    await cache.set(`sess:${token}`, JSON.stringify(data), ttlS);
  }
  return {
    id: token,
    expiresAt: Math.min(now + ttlS * 1000, data.createdAt + maxMs),
    persistente,
  };
}

export async function destroySession(cache: Cache, token: string): Promise<void> {
  if (token.startsWith(PREFIX)) await cache.del(`sess:${token}`);
}
