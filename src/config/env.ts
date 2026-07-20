import { z } from 'zod';

const schema = z.object({
  ML_CLIENT_ID: z.string().min(1),
  ML_CLIENT_SECRET: z.string().min(10),
  ML_USER_ID: z.string().regex(/^\d+$/),
  ML_REDIRECT_URI: z.string().url(),
  ADMIN_KEY: z.string().min(16, 'ADMIN_KEY deve ter no mínimo 16 caracteres'),
  DASHBOARD_PASSWORD: z.string().min(8, 'DASHBOARD_PASSWORD deve ter no mínimo 8 caracteres'),
  ALLOWED_ORIGIN: z.string().url(),
  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  /** Desativa o /api/admin/seed após a semeadura ("false" = bloqueado). */
  SEED_ENABLED: z.enum(['true', 'false']).default('true'),

  // ── Sincronização de pedidos (Fase 4b) — todas com default ──────────────
  /** Pedidos por chunk no Redis (evita chave única gigante). */
  ORDERS_CHUNK_SIZE: z.coerce.number().int().positive().default(500),
  /** Páginas processadas por invocação (serverless 15s) — o resto é retomável. */
  ORDERS_SYNC_MAX_PAGES: z.coerce.number().int().positive().default(5),
  /** Teto de segurança contra loop patológico — NÃO é o limite legado de 8000. */
  ORDERS_SYNC_MAX_TOTAL: z.coerce.number().int().positive().default(50000),
  /** TTL do lock de sync (> duração de uma invocação). */
  ORDERS_SYNC_LOCK_TTL_S: z.coerce.number().int().positive().default(120),
  /** Tentativas por página antes de desistir do passo (retomável). */
  ORDERS_PAGE_RETRIES: z.coerce.number().int().min(0).default(2),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Valida e retorna as variáveis de ambiente. Falha cedo com mensagem clara. */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const faltando = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Variáveis de ambiente inválidas — ${faltando}`);
  }
  cached = parsed.data;
  return cached;
}

/** Reset para testes (env é cacheada). */
export function resetEnvForTests() {
  cached = null;
}
