import { describe, expect, it } from "vitest";
import { MemoryReportStore } from "@/lib/report/memory-store";
import {
  createPublicReportResponse,
  getPublicReportError,
  PUBLIC_REPORT_FAILURE_MESSAGE
} from "@/lib/report/public-report";
import { stepsForCurrentStep } from "@/lib/report/steps";

describe("public report sanitization", () => {
  it("never exposes visitor hashes, internal URLs, expiry data, or provider errors", async () => {
    const store = new MemoryReportStore();
    const created = await store.createJob({
      publicId: "public-safe-report",
      submittedUrl: "launchclub.ai",
      normalizedUrl: "https://launchclub.ai/",
      domain: "launchclub.ai",
      visitorHash: "private-visitor-hash"
    });
    const failed = await store.updateJob(created.publicId, {
      status: "failed",
      currentStep: "failed",
      progress: 100,
      errorSummary: "Ahrefs 401: secret-token at /Users/private/internal.ts",
      steps: stepsForCurrentStep(
        "failed",
        "failed",
        "Ahrefs 401: secret-token at /Users/private/internal.ts"
      )
    });

    const response = createPublicReportResponse(failed, null);
    const serialized = JSON.stringify(response);

    expect(response.job.errorSummary).toBe(PUBLIC_REPORT_FAILURE_MESSAGE);
    expect(serialized).not.toContain("visitorHash");
    expect(serialized).not.toContain("private-visitor-hash");
    expect(serialized).not.toContain("normalizedUrl");
    expect(serialized).not.toContain("expiresAt");
    expect(serialized).not.toContain("Ahrefs 401");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("/Users/private");
  });

  it("returns useful validation errors but sanitizes unknown failures", () => {
    expect(getPublicReportError(new Error("Enter a valid website URL."))).toEqual({
      message: "Enter a valid website URL.",
      status: 400
    });
    expect(
      getPublicReportError(new Error("SQL connection failed with password=secret"))
    ).toEqual({
      message: "The report could not be started. Please try again.",
      status: 500
    });
  });

  it("can replace the internal worker identifier with a secure public access key", async () => {
    const store = new MemoryReportStore();
    const job = await store.createJob({
      publicId: "internal-worker-id",
      submittedUrl: "example.com",
      normalizedUrl: "https://example.com/",
      domain: "example.com",
      visitorHash: "private-visitor-hash"
    });
    const secureAccessKey = `lc_report_${"a".repeat(43)}`;

    const response = createPublicReportResponse(job, null, { publicId: secureAccessKey });

    expect(response.job.publicId).toBe(secureAccessKey);
    expect(JSON.stringify(response)).not.toContain("internal-worker-id");
  });
});
