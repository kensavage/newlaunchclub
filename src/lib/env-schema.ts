import { z } from "zod";

const booleanStringSchema = z
  .string()
  .optional()
  .transform((value) => value === "true");

const optionalPositiveNumberSchema = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.coerce.number().positive().max(1_000_000).optional()
);

function integerEnvSchema(defaultValue: number, minimum: number, maximum: number) {
  return z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    z.coerce.number().int().min(minimum).max(maximum).default(defaultValue)
  );
}

const serverEnvSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL_FAST: z.string().default("gpt-5.4-nano"),
  OPENAI_MODEL_SYNTHESIS: z.string().default("gpt-5.4-mini"),
  FIRECRAWL_API_KEY: z.string().optional(),
  DATAFORSEO_LOGIN: z.string().optional(),
  DATAFORSEO_PASSWORD: z.string().optional(),
  AHREFS_API_KEY: z.string().optional(),
  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  REDDIT_USER_AGENT: z
    .string()
    .default("web:ai-search-opportunity-report:v0.1.0 (by /u/launchclub)"),
  MEMES_AI_API_URL: z.string().url().optional(),
  MEMES_AI_API_KEY: z.string().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  REPORT_RATE_LIMIT_SALT: z.string().default("local-dev-salt"),
  REPORT_ACCESS_TOKEN_SECRET: z.string().min(32).optional(),
  REPORT_ACCESS_TOKEN_TTL_DAYS: integerEnvSchema(365, 1, 3650),
  REPORT_REVOKED_TOKEN_RETENTION_DAYS: integerEnvSchema(90, 1, 3650),
  REPORT_ACCESS_EVENT_RETENTION_MONTHS: integerEnvSchema(13, 1, 120),
  REPORT_RECOVERY_TOKEN_TTL_MINUTES: integerEnvSchema(15, 5, 120),
  REPORT_RECOVERY_TOKEN_RETENTION_DAYS: integerEnvSchema(90, 1, 3650),
  WORKFLOW_LEASE_SECONDS: integerEnvSchema(120, 15, 3600),
  WORKFLOW_MAX_ATTEMPTS: integerEnvSchema(4, 1, 20),
  WORKFLOW_ADMIN_SECRET: z.string().min(32).optional(),
  WORKFLOW_WAKEUP_SECRET: z.string().min(32).optional(),
  WORKFLOW_WAKEUP_TTL_SECONDS: integerEnvSchema(300, 30, 900),
  WORKFLOW_QUEUE_BATCH_SIZE: integerEnvSchema(5, 1, 25),
  WORKFLOW_QUEUE_VISIBILITY_TIMEOUT_SECONDS: integerEnvSchema(120, 30, 900),
  WORKFLOW_CONSUMER_MAX_RUNTIME_SECONDS: integerEnvSchema(780, 30, 840),
  V3_PROVIDER_RESEARCH_ENABLED: booleanStringSchema,
  V3_PROVIDER_MAX_CRAWL_PAGES: integerEnvSchema(7, 2, 20),
  V3_PROVIDER_QUERY_COUNT: integerEnvSchema(18, 5, 30),
  V3_PROVIDER_POLL_INTERVAL_SECONDS: integerEnvSchema(10, 2, 300),
  V3_PROVIDER_EVIDENCE_TTL_HOURS: integerEnvSchema(48, 1, 720),
  V3_PROVIDER_MAX_RESERVATION_CENTS: integerEnvSchema(400, 0, 400),
  V3_FIRECRAWL_RESERVATION_CENTS: integerEnvSchema(160, 0, 400),
  V3_OPENAI_PROFILE_RESERVATION_CENTS: integerEnvSchema(120, 0, 400),
  V3_OPENAI_QUERY_RESERVATION_CENTS: integerEnvSchema(80, 0, 400),
  V3_FIRECRAWL_CENTS_PER_CREDIT: optionalPositiveNumberSchema,
  V3_OPENAI_INPUT_CENTS_PER_MILLION_TOKENS: optionalPositiveNumberSchema,
  V3_OPENAI_OUTPUT_CENTS_PER_MILLION_TOKENS: optionalPositiveNumberSchema,
  REPORT_REQUEST_COOLDOWN_HOURS: integerEnvSchema(24, 1, 720),
  REPORT_DOMAIN_COOLDOWN_MINUTES: integerEnvSchema(60, 1, 10_080),
  REPORT_CONTACT_COOLDOWN_MINUTES: integerEnvSchema(60, 1, 10_080),
  REPORT_MAX_ACTIVE_PER_COMPANY: integerEnvSchema(2, 1, 20),
  REPORT_MAX_ACTIVE_PER_CONTACT: integerEnvSchema(2, 1, 20),
  REPORT_RATE_LIMIT_WINDOW_MINUTES: integerEnvSchema(60, 1, 1_440),
  REPORT_RATE_LIMIT_IP_COUNT: integerEnvSchema(10, 1, 1_000),
  REPORT_RATE_LIMIT_DOMAIN_COUNT: integerEnvSchema(8, 1, 1_000),
  REPORT_RATE_LIMIT_CONTACT_COUNT: integerEnvSchema(6, 1, 1_000),
  REPORT_MAX_REQUEST_BYTES: integerEnvSchema(8_192, 1_024, 65_536),
  REPORT_BLOCKED_DOMAINS: z.string().optional(),
  REPORT_DISPOSABLE_EMAIL_DOMAINS: z.string().optional(),
  ENABLE_REAL_AI_CHECKS: booleanStringSchema,
  ENABLE_MEME_IMAGE_GENERATION: booleanStringSchema,
  REPORT_USE_MOCK_PROVIDERS: booleanStringSchema,
  REPORT_USE_INLINE_WORKER: booleanStringSchema,
  REPORT_USE_MEMORY_STORE: booleanStringSchema,
  NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_BOOK_CALL_URL: z
    .string()
    .default("mailto:hello@launchclub.ai?subject=Buyer%20Visibility%20Sprint")
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  return serverEnvSchema.parse(source);
}

export function hasSupabaseEnv(env: ServerEnv) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

export function shouldUseMockProviders(env: ServerEnv) {
  return (
    env.REPORT_USE_MOCK_PROVIDERS ||
    !(env.OPENAI_API_KEY && env.FIRECRAWL_API_KEY && env.AHREFS_API_KEY)
  );
}
