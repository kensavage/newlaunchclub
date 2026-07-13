import "server-only";
import { getServerEnv } from "@/lib/env";
import type { WorkflowStore } from "@/lib/workflow/store";

export async function cleanupReportSecurityArtifacts(store: WorkflowStore, now = new Date()) {
  const env = getServerEnv();
  return store.cleanupSecurityArtifacts({
    revokedTokenBefore: subtractDays(now, env.REPORT_REVOKED_TOKEN_RETENTION_DAYS),
    accessEventsBefore: subtractMonths(now, env.REPORT_ACCESS_EVENT_RETENTION_MONTHS),
    recoveryTokenBefore: subtractDays(now, env.REPORT_RECOVERY_TOKEN_RETENTION_DAYS)
  });
}
function subtractDays(date: Date, days: number) {
  return new Date(date.getTime() - days * 86_400_000).toISOString();
}

function subtractMonths(date: Date, months: number) {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() - months);
  return next.toISOString();
}
