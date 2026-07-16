import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { CreateReportIntakeInput } from "@/lib/report/intake-schema";
import { IntakeCapacityError } from "@/lib/report/intake-store";
import { createInitialSteps } from "@/lib/report/steps";
import { SupabaseReportIntakeStore } from "@/lib/report/supabase-intake-store";

describe("Supabase report intake adapter", () => {
  it("maps the transactional intake RPC without sending a raw token", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          company_id: "company-id",
          contact_id: "contact-id",
          lead_id: "lead-id",
          report_request_id: "request-id",
          report_id: "report-id",
          access_token_id: "token-id",
          public_progress_id: "progress_public_identifier_123",
          legacy_public_id: "a".repeat(18),
          request_status: "queued",
          request_created_at: "2026-07-12T12:00:00.000Z",
          reused: false
        }
      ],
      error: null
    });
    const store = new SupabaseReportIntakeStore({ rpc } as unknown as SupabaseClient);
    const input = createInput();

    const result = await store.createOrReuseIntake(input);

    expect(result).toMatchObject({
      companyId: "company-id",
      reportRequestId: "request-id",
      reportId: "report-id",
      requestStatus: "queued",
      reused: false
    });
    expect(rpc).toHaveBeenCalledWith(
      "create_report_intake",
      expect.objectContaining({ p_access_token_hash: input.accessTokenHash })
    );
    expect(JSON.stringify(rpc.mock.calls[0])).not.toContain("lc_report_");
  });

  it("maps a resolved access token and checks protected legacy identifiers", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            report_id: "report-id",
            report_request_id: "request-id",
            access_token_id: "token-id",
            stored_token_hash: "a".repeat(64),
            token_status: "active",
            expires_at: "2026-08-12T12:00:00.000Z",
            public_progress_id: "progress_public_identifier_123",
            display_domain: "example.com",
            legacy_public_id: "b".repeat(18),
            request_status: "running",
            request_created_at: "2026-07-12T12:00:00.000Z"
          }
        ],
        error: null
      })
      .mockResolvedValueOnce({ data: true, error: null });
    const store = new SupabaseReportIntakeStore({ rpc } as unknown as SupabaseClient);

    await expect(
      store.resolveAccess(
        "a".repeat(64),
        { requestSignalHash: "b".repeat(64), userAgentCategory: "browser" },
        "2026-07-12T12:01:00.000Z"
      )
    ).resolves.toMatchObject({
      reportId: "report-id",
      displayDomain: "example.com",
      requestStatus: "running"
    });
    await expect(store.isLegacyIdProtected("b".repeat(18))).resolves.toBe(true);
  });

  it("converts capacity failures to the public-safe intake error type", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "report_intake_capacity" }
    });
    const store = new SupabaseReportIntakeStore({ rpc } as unknown as SupabaseClient);

    await expect(store.createOrReuseIntake(createInput())).rejects.toBeInstanceOf(
      IntakeCapacityError
    );
  });
});

function createInput(): CreateReportIntakeInput {
  return {
    canonicalDomain: "example.com",
    canonicalWebsiteUrl: "https://example.com/",
    normalizedSubmittedUrl: "https://example.com/",
    normalizedEmail: "owner@example.com",
    emailDomain: "example.com",
    submissionSource: "homepage_hero",
    idempotencyKeyHash: "1".repeat(64),
    requestFingerprint: "2".repeat(64),
    publicProgressId: "progress_public_identifier_123",
    legacyPublicId: "a".repeat(18),
    accessTokenHash: "3".repeat(64),
    accessExpiresAt: "2026-08-12T12:00:00.000Z",
    legacyJobExpiresAt: "2026-08-12T12:00:00.000Z",
    visitorHash: "4".repeat(64),
    initialSteps: createInitialSteps(),
    pairCooldownSince: "2026-07-11T12:00:00.000Z",
    domainCooldownSince: "2026-07-12T11:00:00.000Z",
    contactCooldownSince: "2026-07-12T11:00:00.000Z",
    maxActivePerCompany: 2,
    maxActivePerContact: 2,
    rateLimitSince: "2026-07-12T11:00:00.000Z",
    maxRequestsPerSignal: 10,
    requestMetadata: {
      requestSignalHash: "5".repeat(64),
      userAgentCategory: "browser"
    }
  };
}
