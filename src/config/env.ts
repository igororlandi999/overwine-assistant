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

  /**
   * Chave do provedor de IA (Google Gemini) usada SOMENTE por /api/chat.
   * OPCIONAL de propósito: getEnv() é chamado por http.ts (toda rota via
   * applyCors); torná-la obrigatória derrubaria health/auth/orders/sync
   * enquanto não estivesse configurada. Ausente => apenas /api/chat responde
   * 502 ai_provider_error; o restante do backend segue normal.
   */
  GEMINI_API_KEY: z.string().min(20).optional(),

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

  // ── Pedidos em tempo real (notificações do ML) ──────────────────────────
  /**
   * Segredo exigido na URL de callback registrada no painel do Mercado Livre
   * (`?k=<segredo>`). O ML NÃO assina as notificações: não há HMAC, header de
   * assinatura nem lista de IPs publicada. Um segredo na própria URL é o único
   * mecanismo disponível para que só o ML consiga entregar aqui.
   *
   * OPCIONAL de propósito, e com a mesma razão da GEMINI_API_KEY: getEnv() é
   * chamada por praticamente toda rota, e torná-la obrigatória derrubaria o
   * backend inteiro enquanto a variável não estivesse configurada. Ausente =>
   * o endpoint de notificações responde 503 e NADA MAIS muda: a reconciliação
   * de hora em hora continua sendo a fonte de atualização, exatamente como
   * antes desta fase.
   */
  ML_WEBHOOK_SECRET: z.string().min(16, 'ML_WEBHOOK_SECRET deve ter no mínimo 16 caracteres').optional(),

  // ── Multi-conta (etapa 0) ───────────────────────────────────────────────
  /**
   * Liga a aceitação de contas além da legada nas rotas (`contas=`/`conta=`).
   * Desligada (padrão), o backend se comporta exatamente como antes do plano
   * multi-conta: só a conta Overwine × Mercado Livre existe para as rotas, e
   * qualquer outro id responde 400 `conta_nao_habilitada`. Lida em
   * src/config/contas.ts, não por getEnv(), para não acoplar as rotas.
   */
  MULTI_CONTA_ENABLED: z.enum(['true', 'false']).default('false'),

  // ── Auto-refresh do dashboard ───────────────────────────────────────────
  /**
   * Idade (s) de `lastSyncAt` a partir da qual uma aba aberta pode pedir uma
   * sincronização incremental. Medimos quando CHECAMOS, não quando MUDOU:
   * `manifest.updatedAt` fica parado num dia sem vendas, e usá-lo aqui faria o
   * dashboard pedir sincronização para sempre, sem nunca achar nada.
   */
  ORDERS_REFRESH_IDADE_MAX_S: z.coerce.number().int().positive().default(25),

  /**
   * Janela global de cooldown (s) do auto-refresh. É o que impede que N abas
   * abertas virem N sincronizações: a primeira adquire, as outras recebem
   * `cooldown` e não tocam no Mercado Livre.
   */
  ORDERS_REFRESH_COOLDOWN_S: z.coerce.number().int().positive().default(15),

  /**
   * De quanto em quanto tempo (s) o auto-refresh troca o passo RÁPIDO (uma
   * página do ML, só os pedidos mais recentes) pela revisão PROFUNDA (o passo
   * incremental de 5 páginas, que revisita os 250 conhecidos mais recentes e
   * captura mudança de status fora da primeira página). O rápido é o que dá a
   * latência de segundos; o profundo é o que garante consistência sem depender
   * do GitHub Actions.
   */
  ORDERS_REFRESH_REVISAO_S: z.coerce.number().int().positive().default(600),

  /**
   * Cooldown (s) imposto quando o Mercado Livre responde 429. Um rate limit
   * não se resolve insistindo: a aba aberta pediria de novo em segundos.
   */
  ORDERS_REFRESH_COOLDOWN_429_S: z.coerce.number().int().positive().default(120),

  /**
   * Pedidos processados por dreno. Cada um custa 1 chamada a GET /orders/{id}
   * mais leituras de chunk; 20 cabe folgado nos 30 s de maxDuration da função
   * e é muito acima do volume real de eventos por minuto.
   */
  ORDERS_WEBHOOK_MAX_DRENO: z.coerce.number().int().positive().default(20),
    // ── Snapshot de catálogo (Onda E) ───────────────────────────
  /** Anúncios por chunk no Redis. */
  ITEMS_CATALOG_CHUNK_SIZE: z.coerce.number().int().positive().default(500),

  /** TTL soft: após 15 min o snapshot é marcado como stale. */
  ITEMS_CATALOG_SOFT_TTL_S: z.coerce.number().int().positive().default(900),

  /** TTL hard: após 24 h o catálogo precisa ser reconstruído. */
  ITEMS_CATALOG_HARD_TTL_S: z.coerce.number().int().positive().default(86400),

  /** TTL do lock de reconstrução. */
  ITEMS_CATALOG_LOCK_TTL_S: z.coerce.number().int().positive().default(60),

  /** Cooldown entre reconstruções forçadas. */
  ITEMS_CATALOG_COOLDOWN_S: z.coerce.number().int().positive().default(60),

  /** Teto de chamadas ao ML por construção. */
  ITEMS_CATALOG_MAX_CALLS: z.coerce.number().int().positive().default(200),
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

