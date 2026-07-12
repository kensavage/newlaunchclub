import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getServerEnv } from "@/lib/env";
import {
  createReportIntake,
  resolveSecureReportAccess,
  revokeSecureReportAccess,
  rotateSecureReportAccess
} from "@/lib/report/intake-service";
import {
  MemoryReportIntakeStore,
  resetMemoryIntakeStoreForTests
} from "@/lib/report/memory-intake-store";
import { MemoryReportStore } from "@/lib/report/memory-store";
import { resetRateLimitsForTests } from "@/lib/report/rate-limit";
import { resetMemoryWorkflowStoreForTests } from "@/lib/workflow/memory-store";

const context = {
  ip: "203.0.113.42",
  userAgent: "Mozilla/5.0 Test Browser"
};

describe("report intake service", () => {
  beforeEach(() => {
    vi.stubEnv(
      "REPORT_ACCESS_TOKEN_SECRET",
      "test-only-report-access-secret-that-is-more-than-thirty-two-characters"
    );
    vi.stubEnv("REPORT_RATE_LIMIT_SALT", "test-only-rate-limit-salt-that-is-more-than-32-characters");
    vi.stubEnv("REPORT_USE_MOCK_PROVIDERS", "true");
    vi.stubEnv("REPORT_USE_MEMORY_STORE", "true");
    vi.stubEnv("REPORT_BLOCKED_DOMAINS", "");
    vi.stubEnv("REPORT_DISPOSABLE_EMAIL_DOMAINS", "");
    resetRateLimitsForTests();
    resetMemoryIntakeStoreForTests();
    resetMemoryWorkflowStoreForTests();
    globalThis.__launchClubReportStore = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes identity data and returns an immediate safe queued acknowledgement", async () => {
    const env = getServerEnv();
    const reportStore = new MemoryReportStore();
    const store = new MemoryReportIntakeStore(reportStore);
    const payload = {
      url: "https://WWW.Example.com/services?utm_source=ad#top",
      email: " OWNER@Example.com ",
      idempotencyKey: "browser-request-key-123456789",
      source: "homepage_hero"
    };

    const acknowledgement = await createReportIntake(payload, context, { env, store });
    const retry = await createReportIntake(payload, context, { env, store });
    const snapshot = store.snapshot();

    expect(acknowledgement.response).toMatchObject({
      requestStatus: "queued",
      displayDomain: "example.com",
      reused: false
    });
    expect(acknowledgement.shouldDispatch).toBe(true);
    expect(acknowledgement.response.progressId).toMatch(/^progress_/);
    expect(acknowledgement.response.reportUrl).toBe(
      `/reports/${acknowledgement.response.reportAccessToken}`
    );
    expect(retry.response.reused).toBe(true);
    expect(retry.shouldDispatch).toBe(false);
    expect(retry.response.reportAccessToken).toBe(acknowledgement.response.reportAccessToken);
    expect(snapshot.companies[0]).toMatchObject({
      canonicalDomain: "example.com",
      canonicalWebsiteUrl: "https://www.example.com/"
    });
    expect(snapshot.contacts[0]).toMatchObject({
      normalizedEmail: "owner@example.com",
      emailDomain: "example.com"
    });
    expect(JSON.stringify(snapshot)).not.toContain(acknowledgement.response.reportAccessToken);
    expect(JSON.stringify(acknowledgement.response)).not.toContain(snapshot.requests[0]?.id);
    expect(JSON.stringify(acknowledgement.response)).not.toContain("owner@example.com");
  });

  it("checks DNS resolution without crawling or calling a research provider", async () => {
    const env = { ...getServerEnv(), REPORT_USE_MOCK_PROVIDERS: false };
    const store = new MemoryReportIntakeStore(new MemoryReportStore());
    const assertResolvable = vi.fn().mockResolvedValue(undefined);

    await createReportIntake(
      {
        url: "example.com/path?tracking=true",
        email: "owner@example.com",
        idempotencyKey: "dns-check-request-123456789",
        source: "homepage_hero"
      },
      context,
      { env, store, assertResolvable }
    );

    expect(assertResolvable).toHaveBeenCalledExactlyOnceWith("https://example.com/path");
  });

  it("enforces blocked-domain policy before creating records", async () => {
    const env = { ...getServerEnv(), REPORT_BLOCKED_DOMAINS: "blocked.example" };
    const store = new MemoryReportIntakeStore(new MemoryReportStore());

    await expect(
      createReportIntake(
        {
          url: "shop.blocked.example",
          email: "owner@company.example",
          idempotencyKey: "blocked-request-key-123456789",
          source: "homepage_hero"
        },
        context,
        { env, store }
      )
    ).rejects.toThrow(/website is not eligible/i);

    expect(store.snapshot().companies).toHaveLength(0);
  });

  it("applies configurable privacy-safe request rate limits", async () => {
    const env = { ...getServerEnv(), REPORT_RATE_LIMIT_IP_COUNT: 1 };
    const store = new MemoryReportIntakeStore(new MemoryReportStore());

    await createReportIntake(
      {
        url: "first.example",
        email: "owner@first.example",
        idempotencyKey: "first-request-key-123456789",
        source: "homepage_hero"
      },
      context,
      { env, store }
    );

    await expect(
      createReportIntake(
        {
          url: "second.example",
          email: "owner@second.example",
          idempotencyKey: "second-request-key-123456789",
          source: "homepage_hero"
        },
        context,
        { env, store }
      )
    ).rejects.toThrow(/too many reports/i);
  });

  it("resolves, rotates, revokes, and safely rejects secure access", async () => {
    const env = getServerEnv();
    const store = new MemoryReportIntakeStore(new MemoryReportStore());
    const acknowledgement = await createReportIntake(
      {
        url: "example.com",
        email: "owner@example.com",
        idempotencyKey: "access-request-key-123456789",
        source: "homepage_hero"
      },
      context,
      { env, store }
    );
    const reportId = store.snapshot().reports[0]?.id;
    expect(reportId).toBeTruthy();

    expect(
      await resolveSecureReportAccess(acknowledgement.response.reportAccessToken, context, {
        env,
        store
      })
    ).not.toBeNull();
    expect(await resolveSecureReportAccess("invalid-token", context, { env, store })).toBeNull();

    const rotatedToken = await rotateSecureReportAccess(reportId!, context, { env, store });
    expect(
      await resolveSecureReportAccess(acknowledgement.response.reportAccessToken, context, {
        env,
        store
      })
    ).toBeNull();
    expect(await resolveSecureReportAccess(rotatedToken, context, { env, store })).not.toBeNull();

    await revokeSecureReportAccess(reportId!, "manual test revocation", { env, store });
    expect(await resolveSecureReportAccess(rotatedToken, context, { env, store })).toBeNull();
  });
});
