import "server-only";
import crypto from "node:crypto";
import { getServerEnv } from "@/lib/env";
import type { WorkflowStore } from "@/lib/workflow/store";

export interface ReportAccessRecoveryDelivery {
  reportId: string;
  normalizedEmail: string;
  recoveryToken: string;
  expiresAt: string;
}
export async function prepareReportAccessRecovery(
  input: { publicProgressId: string; email: string },
  store: WorkflowStore,
  options: { now?: Date; token?: string } = {}
) {
  const env = getServerEnv();
  const now = options.now ?? new Date();
  const token = options.token ?? crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + env.REPORT_RECOVERY_TOKEN_TTL_MINUTES * 60_000).toISOString();
  const result = await store.prepareAccessRecovery({
    publicProgressId: input.publicProgressId.trim(),
    normalizedEmail: normalizeRecoveryEmail(input.email),
    recoveryTokenHash: hashRecoveryToken(token),
    rawRecoveryToken: token,
    expiresAt,
    now: now.toISOString()
  });

  // A future Resend adapter receives this server-only delivery contract. Public callers get accepted only.
  return {
    publicResponse: { accepted: true as const },
    delivery: result.delivery
  };
}

export async function consumeReportAccessRecovery(
  input: { recoveryToken: string; newAccessTokenHash: string },
  store: WorkflowStore,
  options: { now?: Date } = {}
) {
  const env = getServerEnv();
  const now = options.now ?? new Date();
  return store.consumeAccessRecovery({
    recoveryTokenHash: hashRecoveryToken(input.recoveryToken),
    newAccessTokenHash: input.newAccessTokenHash,
    accessExpiresAt: new Date(now.getTime() + env.REPORT_ACCESS_TOKEN_TTL_DAYS * 86_400_000).toISOString(),
    now: now.toISOString()
  });
}

export function hashRecoveryToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizeRecoveryEmail(email: string) {
  return email.trim().toLowerCase().normalize("NFKC");
}
