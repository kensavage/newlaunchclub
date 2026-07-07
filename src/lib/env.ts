import "server-only";
import { z } from "zod";

const booleanStringSchema = z
  .string()
  .optional()
  .transform((value) => value === "true");

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
  ENABLE_REAL_AI_CHECKS: booleanStringSchema,
  ENABLE_MEME_IMAGE_GENERATION: booleanStringSchema,
  REPORT_USE_MOCK_PROVIDERS: booleanStringSchema,
  REPORT_USE_INLINE_WORKER: booleanStringSchema,
  NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_BOOK_CALL_URL: z
    .string()
    .default("mailto:hello@launchclub.ai?subject=Buyer%20Visibility%20Sprint")
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function getServerEnv(): ServerEnv {
  return serverEnvSchema.parse(process.env);
}

export function hasSupabaseEnv(env = getServerEnv()) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

export function shouldUseMockProviders(env = getServerEnv()) {
  return (
    env.REPORT_USE_MOCK_PROVIDERS ||
    !(
      env.OPENAI_API_KEY &&
      env.FIRECRAWL_API_KEY &&
      env.AHREFS_API_KEY
    )
  );
}
