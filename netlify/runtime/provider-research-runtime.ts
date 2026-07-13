import type { ServerEnv } from "../../src/lib/env-schema";
import { SupabaseProviderResearchStore } from "../../src/lib/research/supabase-store-runtime";

export function getNetlifyProviderResearchStore(env: ServerEnv) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || env.REPORT_USE_MEMORY_STORE) {
    throw new Error("The Netlify provider research runtime requires durable Supabase storage.");
  }
  return SupabaseProviderResearchStore.fromEnv({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY
  });
}
