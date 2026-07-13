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
import { MemoryWorkflowStore, resetMemoryWorkflowStoreForTests } from "@/lib/workflow/memory-store";
import { setWorkflowStoreForTests } from "@/lib/workflow/store-factory";

describe("report intake and secure access routes", () => {
  let reportStore: MemoryReportStore;
  let intakeStore: MemoryReportIntakeStore;
  let workflowStore: MemoryWorkflowStore;
  let wakeFetch: ReturnType<typeof vi.fn>;
  let wakeSawDurableWorkflow: boolean;

  beforeEach(() => {
    vi.stubEnv(
      "REPORT_ACCESS_TOKEN_SECRET",
      "route-test-access-secret-that-is-longer-than-thirty-two-characters"
    );
    vi.stubEnv("REPORT_RATE_LIMIT_SALT", "route-test-rate-salt-that-is-longer-than-32-characters");
    vi.stubEnv("REPORT_USE_MOCK_PROVIDERS", "true");
    vi.stubEnv("REPORT_USE_MEMORY_STORE", "true");
    vi.stubEnv(
      "WORKFLOW_WAKEUP_SECRET",
      "route-test-wakeup-secret-that-is-longer-than-thirty-two-characters"
    );
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://deploy-preview-1--launchclub-new.netlify.app");
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
    wakeSawDurableWorkflow = false;
    wakeFetch = vi.fn(async () => {
      wakeSawDurableWorkflow =
        intakeStore.snapshot().requests.length === 1 &&
        workflowStore.snapshot().workflows.length === 1 &&
        workflowStore.snapshot().outbox.length === 1;
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", wakeFetch);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    setReportIntakeStoreForTests(null);
    setReportStoreForTests(null);
    setWorkflowStoreForTests(null);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
    expect(workflowStore.snapshot().workflows[0]?.status).toBe("dispatch_pending");
    expect(wakeFetch).toHaveBeenCalledOnce();
    expect(wakeSawDurableWorkflow).toBe(true);
    expect(String(wakeFetch.mock.calls[0]?.[0])).toBe(
      "https://deploy-preview-1--launchclub-new.netlify.app/.netlify/functions/v3-report-workflow-background"
    );
    expect(wakeFetch.mock.calls[0]?.[1]?.body).toBeUndefined();

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

  it("does not attempt an immediate wake before a successful intake transaction", async () => {
    const response = await POST(
      new Request("http://localhost/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "example.com",
          email: "not-an-email",
          source: "homepage_hero"
        })
      })
    );

    expect(response.status).toBe(400);
    expect(wakeFetch).not.toHaveBeenCalled();
    expect(workflowStore.snapshot().workflows).toHaveLength(0);
    expect(workflowStore.snapshot().outbox).toHaveLength(0);
  });

  it("keeps durable queued work intact when the immediate wake fails", async () => {
    wakeFetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const startedAt = performance.now();
    const response = await POST(
      new Request("http://localhost/api/reports", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "route-failed-wake-key-123456"
        },
        body: JSON.stringify({
          url: "example.com",
          email: "owner@example.com",
          source: "homepage_hero"
        })
      })
    );
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(response.status).toBe(202);
    expect(elapsedMilliseconds).toBeLessThan(1_000);
    expect(workflowStore.snapshot().workflows[0]?.status).toBe("dispatch_pending");
    expect(workflowStore.snapshot().steps).toHaveLength(5);
    expect(workflowStore.snapshot().outbox).toHaveLength(1);
    const logs = vi.mocked(console.info).mock.calls.map(([message]) => String(message)).join("\n");
    expect(logs).toContain('"outcome":"failed"');
    expect(logs).toContain('"httpStatus":503');
    expect(logs).not.toContain("route-test-wakeup-secret");
    expect(logs).not.toContain("owner@example.com");
  });

  it("does not dispatch a duplicate wake for a reused intake", async () => {
    const request = () => new Request("http://localhost/api/reports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "route-reused-wake-key-123456"
      },
      body: JSON.stringify({
        url: "example.com",
        email: "owner@example.com",
        source: "homepage_hero"
      })
    });

    expect((await POST(request())).status).toBe(202);
    expect((await POST(request())).status).toBe(200);
    expect(wakeFetch).toHaveBeenCalledOnce();
    expect(workflowStore.snapshot().workflows).toHaveLength(1);
    expect(workflowStore.snapshot().outbox).toHaveLength(1);
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
