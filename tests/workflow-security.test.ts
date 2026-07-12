import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareReportAccessRecovery, consumeReportAccessRecovery, hashRecoveryToken } from "@/lib/workflow/recovery";
import { cleanupReportSecurityArtifacts } from "@/lib/workflow/retention";
import { MemoryWorkflowStore, resetMemoryWorkflowStoreForTests } from "@/lib/workflow/memory-store";
import { getWorkflowStore, setWorkflowStoreForTests } from "@/lib/workflow/store-factory";
import { WorkflowConfigurationError } from "@/lib/workflow/store";

describe("workflow recovery, retention, and legacy policy", () => {
  beforeEach(() => {
    resetMemoryWorkflowStoreForTests();
    vi.stubEnv("REPORT_USE_MEMORY_STORE", "true");
    vi.stubEnv("REPORT_RECOVERY_TOKEN_TTL_MINUTES", "15");
    vi.stubEnv("REPORT_ACCESS_TOKEN_TTL_DAYS", "365");
    vi.stubEnv("REPORT_REVOKED_TOKEN_RETENTION_DAYS", "90");
    vi.stubEnv("REPORT_ACCESS_EVENT_RETENTION_MONTHS", "13");
    vi.stubEnv("REPORT_RECOVERY_TOKEN_RETENTION_DAYS", "90");
  });

  afterEach(() => {
    setWorkflowStoreForTests(null);
    vi.unstubAllEnvs();
  });

  it("returns a non-enumerating recovery response and stores only a short-lived token hash", async () => {
    const store = new MemoryWorkflowStore();
    await store.registerReportIdentity({ reportId: "22222222-2222-4222-8222-222222222222", publicProgressId: "progress_12345678901234567890", normalizedEmail: "owner@example.com" });
    const now = new Date("2026-01-01T00:00:00.000Z");
    const valid = await prepareReportAccessRecovery({ publicProgressId: "progress_12345678901234567890", email: " OWNER@example.com " }, store, { now, token: "server-only-recovery-token" });
    const unknown = await prepareReportAccessRecovery({ publicProgressId: "progress_unknown_1234567890", email: "nobody@example.com" }, store, { now, token: "unknown-token" });

    expect(valid.publicResponse).toEqual(unknown.publicResponse);
    expect(valid.delivery?.recoveryToken).toBe("server-only-recovery-token");
    expect(JSON.stringify(store.snapshot())).not.toContain("server-only-recovery-token");
    expect(store.snapshot().recoveryTokens[0]?.tokenHash).toBe(hashRecoveryToken("server-only-recovery-token"));
  });

  it("consumes recovery once, rotates prior access, and leaves report records untouched during cleanup", async () => {
    const store = new MemoryWorkflowStore();
    await store.registerReportIdentity({ reportId: "22222222-2222-4222-8222-222222222222", publicProgressId: "progress_12345678901234567890", normalizedEmail: "owner@example.com" });
    const firstTime = new Date("2025-01-01T00:00:00.000Z");
    await prepareReportAccessRecovery({ publicProgressId: "progress_12345678901234567890", email: "owner@example.com" }, store, { now: firstTime, token: "first-recovery" });
    expect(await consumeReportAccessRecovery({ recoveryToken: "first-recovery", newAccessTokenHash: "a".repeat(64) }, store, { now: firstTime })).toEqual({ reportId: "22222222-2222-4222-8222-222222222222" });
    expect(await consumeReportAccessRecovery({ recoveryToken: "first-recovery", newAccessTokenHash: "b".repeat(64) }, store, { now: firstTime })).toBeNull();

    const secondTime = new Date("2025-01-02T00:00:00.000Z");
    await prepareReportAccessRecovery({ publicProgressId: "progress_12345678901234567890", email: "owner@example.com" }, store, { now: secondTime, token: "second-recovery" });
    await consumeReportAccessRecovery({ recoveryToken: "second-recovery", newAccessTokenHash: "b".repeat(64) }, store, { now: secondTime });
    const cleanup = await cleanupReportSecurityArtifacts(store, new Date("2026-01-01T00:00:00.000Z"));
    expect(cleanup.tokenHashesDeleted).toBe(1);
    expect(store.snapshot().workflows).toHaveLength(0);
  });

  it("instruments privacy-safe legacy access and enforces the 30-day retirement gate", async () => {
    const store = new MemoryWorkflowStore();
    await store.recordLegacyAccess({ legacyPublicIdHash: "a".repeat(64), requestSignalHash: "b".repeat(64), userAgentCategory: "browser", now: "2026-01-01T00:00:00.000Z" });
    expect(await store.getLegacyReadiness("2026-01-15T00:00:00.000Z")).toMatchObject({ legacyAccessesLast30Days: 1, readyForRetirement: false });
    expect(await store.getLegacyReadiness("2026-02-15T00:00:00.000Z")).toMatchObject({ legacyAccessesLast30Days: 0, readyForRetirement: true });
    expect(JSON.stringify(store.snapshot().legacyAccesses)).not.toContain("owner@");
  });

  it("fails closed when production lacks Supabase workflow storage", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    setWorkflowStoreForTests(null);
    expect(() => getWorkflowStore()).toThrow(WorkflowConfigurationError);
  });
});
