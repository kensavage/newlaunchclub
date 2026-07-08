import { getServerEnv, hasSupabaseEnv } from "@/lib/env";
import { MemoryReportStore } from "@/lib/report/memory-store";
import type { ReportStore } from "@/lib/report/store";
import { SupabaseReportStore } from "@/lib/report/supabase-store";

let store: ReportStore | null = null;

export function getReportStore(): ReportStore {
  if (store) return store;

  const env = getServerEnv();

  if (env.REPORT_USE_MEMORY_STORE) {
    store = new MemoryReportStore();
    return store;
  }

  if (hasSupabaseEnv(env) && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    store = SupabaseReportStore.fromEnv({
      url: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY
    });
  } else {
    store = new MemoryReportStore();
  }

  return store;
}

export function setReportStoreForTests(nextStore: ReportStore | null) {
  store = nextStore;
}
