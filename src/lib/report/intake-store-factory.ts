import "server-only";
import { getServerEnv, hasSupabaseEnv } from "@/lib/env";
import { MemoryReportIntakeStore } from "@/lib/report/memory-intake-store";
import type { ReportIntakeStore } from "@/lib/report/intake-store";
import { getReportStore } from "@/lib/report/store-factory";
import { SupabaseReportIntakeStore } from "@/lib/report/supabase-intake-store";

let intakeStore: ReportIntakeStore | null = null;

export function getReportIntakeStore(): ReportIntakeStore {
  if (intakeStore) return intakeStore;

  const env = getServerEnv();

  if (env.REPORT_USE_MEMORY_STORE) {
    intakeStore = new MemoryReportIntakeStore(getReportStore());
    return intakeStore;
  }

  if (hasSupabaseEnv(env) && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    intakeStore = SupabaseReportIntakeStore.fromEnv({
      url: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY
    });
  } else {
    intakeStore = new MemoryReportIntakeStore(getReportStore());
  }

  return intakeStore;
}

export function setReportIntakeStoreForTests(nextStore: ReportIntakeStore | null) {
  intakeStore = nextStore;
}
