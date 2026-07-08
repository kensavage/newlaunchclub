import { describe, expect, it } from "vitest";
import { MemoryReportStore } from "@/lib/report/memory-store";
import { runReportJob } from "@/lib/report/pipeline";
import { opportunityReportSchema } from "@/lib/report/schema";
import { MockProviderBundle } from "@/lib/providers/mock";

describe("report worker pipeline", () => {
  it("runs a mocked end-to-end report job and labels AI opportunities as simulations", async () => {
    const store = new MemoryReportStore();
    const job = await store.createJob({
      publicId: "pipeline-test-report",
      submittedUrl: "launchclub.ai",
      normalizedUrl: "https://launchclub.ai/",
      domain: "launchclub.ai",
      visitorHash: "visitor-hash"
    });

    await runReportJob(job.publicId, {
      store,
      providers: new MockProviderBundle()
    });

    const completedJob = await store.getJob(job.publicId);
    const report = await store.getReport(job.publicId);

    expect(completedJob?.status).toBe("complete");
    expect(completedJob?.progress).toBe(100);
    expect(report).not.toBeNull();
    const parsedReport = opportunityReportSchema.parse(report);
    expect(parsedReport.keywordOpportunities.length).toBeGreaterThanOrEqual(8);
    expect(parsedReport.aiCitationOpportunities).toHaveLength(4);
    expect(parsedReport.aiCitationOpportunities.every((item) => item.isSimulation)).toBe(true);
    expect(parsedReport.evidenceSummary.aiSearchSource).toMatch(/simulated opportunity/i);
    expect(parsedReport.evidenceSummary.crawlSummary).toMatch(/homepage \+ 1 linked internal page/i);
  });
});
