import { beforeEach, describe, expect, it } from "vitest";
import { generateReportAccessToken, hashReportAccessToken } from "@/lib/report/access-token";
import type { CreateReportIntakeInput } from "@/lib/report/intake-schema";
import { IntakeCapacityError, IntakeRateLimitError } from "@/lib/report/intake-store";
import {
  MemoryReportIntakeStore,
  resetMemoryIntakeStoreForTests
} from "@/lib/report/memory-intake-store";
import { MemoryReportStore } from "@/lib/report/memory-store";
import { createInitialSteps } from "@/lib/report/steps";

const requestMetadata = {
  requestSignalHash: "a".repeat(64),
  userAgentCategory: "browser" as const
};

describe("transactional report intake store", () => {
  beforeEach(() => {
    resetMemoryIntakeStoreForTests();
    globalThis.__launchClubReportStore = undefined;
  });

  it("creates the relational intake records and stores no raw access token", async () => {
    const reportStore = new MemoryReportStore();
    const store = new MemoryReportIntakeStore(reportStore);
    const rawToken = generateReportAccessToken();
    const input = createInput({ accessTokenHash: hashReportAccessToken(rawToken) });

    const result = await store.createOrReuseIntake(input);
    const snapshot = store.snapshot();

    expect(result.reused).toBe(false);
    expect(snapshot.companies).toHaveLength(1);
    expect(snapshot.contacts).toHaveLength(1);
    expect(snapshot.leads).toHaveLength(1);
    expect(snapshot.requests).toHaveLength(1);
    expect(snapshot.reports).toHaveLength(1);
    expect(snapshot.tokens).toHaveLength(1);
    expect(snapshot.accessEvents[0]?.eventType).toBe("issued");
    expect(JSON.stringify(snapshot)).not.toContain(rawToken);
    expect(await reportStore.getJob(result.legacyPublicId)).not.toBeNull();
    expect(await store.isLegacyIdProtected(result.legacyPublicId)).toBe(true);
  });

  it("deduplicates companies, contacts, leads, and idempotent requests", async () => {
    const store = new MemoryReportIntakeStore(new MemoryReportStore());
    const input = createInput();

    const first = await store.createOrReuseIntake(input);
    const retry = await store.createOrReuseIntake(input);
    const snapshot = store.snapshot();

    expect(retry).toMatchObject({
      companyId: first.companyId,
      contactId: first.contactId,
      leadId: first.leadId,
      reportRequestId: first.reportRequestId,
      reportId: first.reportId,
      reused: true
    });
    expect(snapshot.companies).toHaveLength(1);
    expect(snapshot.contacts).toHaveLength(1);
    expect(snapshot.leads).toHaveLength(1);
    expect(snapshot.requests).toHaveLength(1);
    expect(snapshot.reports).toHaveLength(1);
    expect(snapshot.tokens).toHaveLength(1);
  });

  it("reuses a recent company-contact request without creating duplicate research work", async () => {
    const store = new MemoryReportIntakeStore(new MemoryReportStore());
    const first = await store.createOrReuseIntake(createInput());
    const second = await store.createOrReuseIntake(
      createInput({
        idempotencyKeyHash: "b".repeat(64),
        accessTokenHash: "c".repeat(64),
        publicProgressId: "progress_second_request_123456",
        legacyPublicId: "b".repeat(18),
        submissionSource: "homepage_footer"
      })
    );

    expect(second.reportRequestId).toBe(first.reportRequestId);
    expect(second.reportId).toBe(first.reportId);
    expect(second.reused).toBe(true);
    expect(store.snapshot().requests).toHaveLength(1);
    expect(store.snapshot().tokens.filter((token) => token.tokenStatus === "active")).toHaveLength(1);
  });

  it("always reuses an active request even after the completed-report cooldown has elapsed", async () => {
    const store = new MemoryReportIntakeStore(new MemoryReportStore());
    const first = await store.createOrReuseIntake(createInput());
    store.snapshot().requests[0]!.createdAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const second = await store.createOrReuseIntake(
      createInput({
        idempotencyKeyHash: "6".repeat(64),
        accessTokenHash: "7".repeat(64),
        publicProgressId: "progress_old_active_request_12345",
        legacyPublicId: "9".repeat(18)
      })
    );

    expect(second.reportRequestId).toBe(first.reportRequestId);
    expect(second.reused).toBe(true);
    expect(store.snapshot().requests).toHaveLength(1);
  });

  it("serializes concurrent duplicate submissions", async () => {
    const store = new MemoryReportIntakeStore(new MemoryReportStore());
    const input = createInput();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.createOrReuseIntake(input))
    );

    expect(new Set(results.map((result) => result.reportRequestId))).toHaveLength(1);
    expect(store.snapshot().requests).toHaveLength(1);
    expect(store.snapshot().reports).toHaveLength(1);
  });

  it("enforces privacy-safe domain and contact cooldowns without persisting denied records", async () => {
    const store = new MemoryReportIntakeStore(new MemoryReportStore());
    await store.createOrReuseIntake(createInput());

    await expect(
      store.createOrReuseIntake(
        createInput({
          normalizedEmail: "other@another-company.com",
          emailDomain: "another-company.com",
          idempotencyKeyHash: "d".repeat(64),
          accessTokenHash: "e".repeat(64),
          publicProgressId: "progress_other_contact_1234567",
          legacyPublicId: "c".repeat(18)
        })
      )
    ).rejects.toBeInstanceOf(IntakeCapacityError);

    await expect(
      store.createOrReuseIntake(
        createInput({
          canonicalDomain: "another.example",
          canonicalWebsiteUrl: "https://another.example/",
          normalizedSubmittedUrl: "https://another.example/",
          idempotencyKeyHash: "f".repeat(64),
          accessTokenHash: "1".repeat(64),
          publicProgressId: "progress_other_company_1234567",
          legacyPublicId: "d".repeat(18)
        })
      )
    ).rejects.toBeInstanceOf(IntakeCapacityError);

    expect(store.snapshot().companies).toHaveLength(1);
    expect(store.snapshot().contacts).toHaveLength(1);
    expect(store.snapshot().requests).toHaveLength(1);
  });

  it("enforces a serialized rate limit from privacy-safe persisted audit signals", async () => {
    const store = new MemoryReportIntakeStore(new MemoryReportStore());
    await store.createOrReuseIntake(createInput({ maxRequestsPerSignal: 1 }));

    await expect(
      store.createOrReuseIntake(
        createInput({
          canonicalDomain: "other.example",
          canonicalWebsiteUrl: "https://other.example/",
          normalizedSubmittedUrl: "https://other.example/",
          normalizedEmail: "owner@other.example",
          emailDomain: "other.example",
          idempotencyKeyHash: "8".repeat(64),
          accessTokenHash: "9".repeat(64),
          publicProgressId: "progress_rate_limited_1234567",
          legacyPublicId: "e".repeat(18),
          maxRequestsPerSignal: 1
        })
      )
    ).rejects.toBeInstanceOf(IntakeRateLimitError);

    expect(store.snapshot().requests).toHaveLength(1);
  });

  it("expires, revokes, and rotates access tokens safely", async () => {
    const store = new MemoryReportIntakeStore(new MemoryReportStore());
    const firstRawToken = generateReportAccessToken();
    const input = createInput({ accessTokenHash: hashReportAccessToken(firstRawToken) });
    const intake = await store.createOrReuseIntake(input);

    expect(
      await store.resolveAccess(hashReportAccessToken(firstRawToken), requestMetadata)
    ).not.toBeNull();

    const rotatedRawToken = generateReportAccessToken();
    await store.rotateAccess(
      intake.reportId,
      hashReportAccessToken(rotatedRawToken),
      new Date(Date.now() + 60_000).toISOString(),
      requestMetadata
    );

    expect(await store.resolveAccess(hashReportAccessToken(firstRawToken), requestMetadata)).toBeNull();
    expect(
      await store.resolveAccess(hashReportAccessToken(rotatedRawToken), requestMetadata)
    ).not.toBeNull();

    await store.revokeAccess(intake.reportId, "test revocation");
    expect(
      await store.resolveAccess(hashReportAccessToken(rotatedRawToken), requestMetadata)
    ).toBeNull();
  });

  it("rejects expired and invalid token hashes without revealing a report", async () => {
    const store = new MemoryReportIntakeStore(new MemoryReportStore());
    const rawToken = generateReportAccessToken();
    const input = createInput({
      accessTokenHash: hashReportAccessToken(rawToken),
      accessExpiresAt: new Date(Date.now() - 1_000).toISOString()
    });
    await store.createOrReuseIntake(input);

    expect(await store.resolveAccess(hashReportAccessToken(rawToken), requestMetadata)).toBeNull();
    expect(await store.resolveAccess("f".repeat(64), requestMetadata)).toBeNull();
    expect(await store.resolveAccess("e".repeat(64), requestMetadata)).toBeNull();
    expect(store.snapshot().tokens[0]?.tokenStatus).toBe("expired");
    expect(
      store.snapshot().auditLogs.filter((audit) => audit.eventType === "report_access_denied")
    ).toHaveLength(1);
  });
});

function createInput(overrides: Partial<CreateReportIntakeInput> = {}): CreateReportIntakeInput {
  const now = Date.now();
  return {
    canonicalDomain: "example.com",
    canonicalWebsiteUrl: "https://example.com/",
    normalizedSubmittedUrl: "https://example.com/",
    normalizedEmail: "owner@example.com",
    emailDomain: "example.com",
    submissionSource: "homepage_hero",
    idempotencyKeyHash: "a".repeat(64),
    requestFingerprint: "2".repeat(64),
    publicProgressId: "progress_example_request_123456",
    legacyPublicId: "a".repeat(18),
    accessTokenHash: "3".repeat(64),
    accessExpiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    legacyJobExpiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
    visitorHash: "4".repeat(64),
    initialSteps: createInitialSteps(),
    pairCooldownSince: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    domainCooldownSince: new Date(now - 60 * 60 * 1000).toISOString(),
    contactCooldownSince: new Date(now - 60 * 60 * 1000).toISOString(),
    maxActivePerCompany: 2,
    maxActivePerContact: 2,
    rateLimitSince: new Date(now - 60 * 60 * 1000).toISOString(),
    maxRequestsPerSignal: 10,
    requestMetadata,
    ...overrides
  };
}
