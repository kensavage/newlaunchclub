import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/reports/[publicId]/route";
import { POST } from "@/app/api/reports/route";
import { generateReportAccessToken } from "@/lib/report/access-token";
import { setReportIntakeStoreForTests } from "@/lib/report/intake-store-factory";
import {
  MemoryReportIntakeStore,
  resetMemoryIntakeStoreForTests
} from "@/lib/report/memory-intake-store";
import { MemoryReportStore } from "@/lib/report/memory-store";
import { resetRateLimitsForTests } from "@/lib/report/rate-limit";
import { setReportStoreForTests } from "@/lib/report/store-factory";
import { DeterministicWorkflowAdapter } from "@/lib/workflow/deterministic-adapter";
import { MemoryWorkflowStore, resetMemoryWorkflowStoreForTests } from "@/lib/workflow/memory-store";
import { setWorkflowDispatcherForTests, setWorkflowStoreForTests } from "@/lib/workflow/store-factory";

describe("report intake and secure access routes", () => {
  let reportStore: MemoryReportStore;
  let intakeStore: MemoryReportIntakeStore;
  let workflowStore: MemoryWorkflowStore;

  beforeEach(() => {
    vi.stubEnv(
      "REPORT_ACCESS_TOKEN_SECRET",
      "route-test-access-secret-that-is-longer-than-thirty-two-characters"
    );
    vi.stubEnv("REPORT_RATE_LIMIT_SALT", "route-test-rate-salt-that-is-longer-than-32-characters");
    vi.stubEnv("REPORT_USE_MOCK_PROVIDERS", "true");
    vi.stubEnv("REPORT_USE_MEMORY_STORE", "true");
    resetRateLimitsForTests();
    resetMemoryIntakeStoreForTests();
    resetMemoryWorkflowStoreForTests();
    globalThis.__launchClubReportStore = undefined;
    reportStore = new MemoryReportStore();
    workflowStore = new MemoryWorkflowStore();
    intakeStore = new MemoryReportIntakeStore(reportStore, workflowStore);
    setReportStoreForTests(reportStore);
    setReportIntakeStoreForTests(intakeStore);
    setWorkflowStoreForTests(workflowStore);
    setWorkflowDispatcherForTests(new DeterministicWorkflowAdapter(workflowStore));
  });

  afterEach(() => {
    setReportIntakeStoreForTests(null);
    setReportStoreForTests(null);
    setWorkflowStoreForTests(null);
    setWorkflowDispatcherForTests(null);
    vi.unstubAllEnvs();
  });

  it("returns a queued acknowledgement and allows only the opaque token for V3 access", async () => {
    const postResponse = await POST(
      new Request("http://localhost/api/reports", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "route-request-key-123456789",
          "X-Forwarded-For": "203.0.113.75",
          "User-Agent": "Route Test Browser"
        },
        body: JSON.stringify({
          url: "example.com",
          email: "owner@example.com",
          source: "homepage_hero"
        })
      })
    );
    const acknowledgement = (await postResponse.json()) as {
      reportAccessToken: string;
      requestStatus: string;
    };
    const snapshot = intakeStore.snapshot();

    expect(postResponse.status).toBe(202);
    expect(acknowledgement.requestStatus).toBe("queued");
    expect(acknowledgement.reportAccessToken).toMatch(/^lc_report_/);
    expect(snapshot.reports[0]?.legacyPublicId).toBeNull();
    expect(workflowStore.snapshot().workflows[0]?.status).toBe("ready_for_provider_research");

    const secureResponse = await getReport(acknowledgement.reportAccessToken);
    const secureBody = await secureResponse.json();
    expect(secureResponse.status).toBe(200);
    expect(secureBody.job.publicId).toBe(acknowledgement.reportAccessToken);
    expect(secureBody.job.progress).toBeNull();
    expect(secureBody.job.currentStep).toBe("crawl");
    expect(secureBody.job.steps).toEqual([
      expect.objectContaining({ label: "Request received", status: "complete" }),
      expect.objectContaining({ label: "Preparing research", status: "running" })
    ]);
    expect(JSON.stringify(secureBody)).not.toMatch(/94|ready_for_provider_research|research_ready/);
    expect(JSON.stringify(secureBody)).not.toContain("owner@example.com");

    const hiddenWorkerIdResponse = await getReport("a".repeat(18));
    expect(hiddenWorkerIdResponse.status).toBe(404);

    const invalidTokenResponse = await getReport(generateReportAccessToken());
    expect(invalidTokenResponse.status).toBe(404);
    expect(await invalidTokenResponse.json()).toEqual(await hiddenWorkerIdResponse.json());
  });

  it("preserves grandfathered V2 report identifiers that are not protected by V3", async () => {
    const legacyPublicId = "f".repeat(18);
    await reportStore.createJob({
      publicId: legacyPublicId,
      submittedUrl: "legacy.example",
      normalizedUrl: "https://legacy.example/",
      domain: "legacy.example",
      visitorHash: "legacy-private-hash"
    });

    const response = await getReport(legacyPublicId);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.job.publicId).toBe(legacyPublicId);
    expect(JSON.stringify(body)).not.toContain("legacy-private-hash");
    expect(workflowStore.snapshot().legacyAccesses).toHaveLength(1);
    expect(JSON.stringify(workflowStore.snapshot().legacyAccesses)).not.toContain(legacyPublicId);
  });
});

function getReport(publicId: string) {
  return GET(
    new Request(`http://localhost/api/reports/${publicId}`, {
      headers: {
        "X-Forwarded-For": "203.0.113.75",
        "User-Agent": "Route Test Browser"
      }
    }),
    { params: Promise.resolve({ publicId }) }
  );
}
