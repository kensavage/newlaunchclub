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
    expect(completedJob?.steps.map((step) => step.label)).not.toContain("Report ready");
    expect(completedJob?.steps.at(-1)).toMatchObject({
      id: "synthesis",
      label: "Building browser report",
      status: "complete"
    });
    expect(report).not.toBeNull();
    const parsedReport = opportunityReportSchema.parse(report);
    expect(parsedReport.keywordOpportunities.length).toBeGreaterThanOrEqual(8);
    expect(parsedReport.keywordOpportunities.every((item) => item.monthlySearchVolume === null)).toBe(true);
    expect(
      parsedReport.keywordOpportunities.every(
        (item) => item.evidence.monthlySearchVolume.evidenceStatus === "Not measured"
      )
    ).toBe(true);
    expect(parsedReport.aiCitationOpportunities).toHaveLength(4);
    expect(parsedReport.aiCitationOpportunities.every((item) => item.isSimulation)).toBe(true);
    expect(
      parsedReport.aiCitationOpportunities.every(
        (item) => item.evidence.evidenceStatus === "Not measured"
      )
    ).toBe(true);
    expect(parsedReport.redditOpportunities.every((item) => item.estimatedMonthlyViews === null)).toBe(true);
    expect(
      parsedReport.redditOpportunities.every(
        (item) => item.evidence.discussion.evidenceStatus === "Not measured"
      )
    ).toBe(true);
    expect(parsedReport.businessEvidence.evidenceStatus).toBe("Not measured");
    expect(parsedReport.opportunityScoreEvidence.evidenceStatus).toBe("Not measured");
    expect(parsedReport.claims.every((claim) => claim.evidenceStatus !== "Measured")).toBe(true);
    expect(parsedReport.evidenceSummary.aiSearchSource).toMatch(/planning simulations/i);
    expect(parsedReport.evidenceSummary.crawlSummary).toMatch(/homepage \+ 1 linked internal page/i);
  });

  it("runs Reddit discovery concurrently with keyword and market research", async () => {
    class ConcurrentResearchProviders extends MockProviderBundle {
      redditStartedAt = 0;
      keywordFinishedAt = 0;

      override async getKeywordMetrics(keywords: string[]) {
        const metrics = await super.getKeywordMetrics(keywords);
        await new Promise((resolve) => setTimeout(resolve, 60));
        this.keywordFinishedAt = performance.now();
        return metrics;
      }

      override async getRedditEvidence() {
        this.redditStartedAt = performance.now();
        return super.getRedditEvidence();
      }
    }

    const store = new MemoryReportStore();
    const providers = new ConcurrentResearchProviders();
    const job = await store.createJob({
      publicId: "parallel-research-test",
      submittedUrl: "launchclub.ai",
      normalizedUrl: "https://launchclub.ai/",
      domain: "launchclub.ai",
      visitorHash: "visitor-hash"
    });

    await runReportJob(job.publicId, { store, providers });

    expect(providers.redditStartedAt).toBeGreaterThan(0);
    expect(providers.keywordFinishedAt).toBeGreaterThan(0);
    expect(providers.redditStartedAt).toBeLessThan(providers.keywordFinishedAt);
  });
});
