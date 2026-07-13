// @vitest-environment node
import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ProviderResearchProviders
} from "@/lib/research/provider-factory";
import {
  MockStructuredAnalysisProvider,
  MockWebsiteResearchProvider
} from "@/lib/research/mock-providers";
import { MemoryProviderResearchStore } from "@/lib/research/memory-store";
import { CompositeResearchWorkflowRunner } from "@/lib/research/composite-runner";
import {
  ConfigurationFailureProviderResearchRunner,
  ProviderResearchContinuation,
  ProviderResearchWorkflowRunner
} from "@/lib/research/runner";
import {
  ProviderResearchError,
  type WebsiteResearchProvider
} from "@/lib/research/contracts";
import { sha256 } from "@/lib/research/integrity";
import { createPublicWorkflowResponse } from "@/lib/report/public-report";
import { WorkflowAdministratorService } from "@/lib/workflow/admin-service";
import {
  MemoryWorkflowStore,
  resetMemoryWorkflowStoreForTests
} from "@/lib/workflow/memory-store";
import { DurableWorkflowRunner } from "@/lib/workflow/runner";
import { WorkflowQueueConsumer } from "@/lib/workflow/queue-consumer-runtime";
import { MemoryWorkflowQueue } from "@/lib/workflow/queue-runtime";
import { SYNTHETIC_RESEARCH_TIME } from "./fixtures/provider-research";

const actor = { actorId: "provider-test-admin", authenticated: true as const };

describe("PR4 durable provider research runner", () => {
  it("advances only through provider research and leaves a truthful, incomplete public report", async () => {
    const harness = await createHarness();
    const website = new MockWebsiteResearchProvider();
    const analysis = new MockStructuredAnalysisProvider();
    const submit = vi.spyOn(website, "submit");
    const poll = vi.spyOn(website, "poll");
    const profile = vi.spyOn(analysis, "extractCompanyProfile");
    const queries = vi.spyOn(analysis, "discoverSearchQueries");
    const runner = createRunner(harness, providers({ website, analysis }));

    await expect(runner.runStep(harness.workflow.id, "website_research", "website-owner"))
      .resolves.toBe("succeeded");
    await expect(runner.runStep(harness.workflow.id, "company_profile_extraction", "profile-owner"))
      .resolves.toBe("succeeded");
    await expect(runner.runStep(harness.workflow.id, "search_query_discovery", "query-owner"))
      .resolves.toBe("succeeded");

    expect((await harness.workflowStore.getWorkflow(harness.workflow.id))?.status)
      .toBe("ready_for_search_intelligence");
    expect(harness.researchStore.snapshot()).toMatchObject({
      operations: [
        { operationKind: "website_research", state: "succeeded", actualCostCents: 0 },
        { operationKind: "company_profile_extraction", state: "succeeded", actualCostCents: 0 },
        { operationKind: "search_query_discovery", state: "succeeded", actualCostCents: 0 }
      ]
    });
    expect(harness.researchStore.snapshot().pages).toHaveLength(2);
    expect(harness.researchStore.snapshot().profiles[0]?.readModel.claims).toHaveLength(10);
    expect(harness.researchStore.snapshot().profiles[0]?.providerRequestId).toMatch(/^mock-profile-/);
    expect(harness.researchStore.snapshot().querySets[0]?.queries).toHaveLength(8);
    expect(harness.researchStore.snapshot().querySets[0]?.providerRequestId).toMatch(/^mock-queries-/);
    expect((await harness.workflowStore.getWorkflowDetail(harness.workflow.id))?.budget)
      .toMatchObject({ limitCents: 400, reservedCents: 0, spentCents: 0 });

    const progress = await harness.workflowStore.getPublicProgress(harness.reportRequestId);
    expect(progress).toMatchObject({
      state: "research_ready",
      currentStep: "keywords",
      steps: [
        { label: "Request received", status: "complete" },
        { label: "Reviewing your website", status: "complete" },
        { label: "Building your company profile", status: "complete" },
        { label: "Preparing your market research", status: "complete" }
      ]
    });
    const response = createPublicWorkflowResponse("lc_report_synthetic_access_token_123", progress!);
    expect(response).toMatchObject({ job: { status: "running", progress: null }, report: null });
    expect(JSON.stringify(response)).not.toMatch(/Google|Reddit|competitor|opportunity|report ready/i);

    await expect(runner.runStep(harness.workflow.id, "website_research", "duplicate-owner"))
      .resolves.toBe("already_succeeded");
    expect(submit).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenCalledOnce();
    expect(profile).toHaveBeenCalledOnce();
    expect(queries).toHaveBeenCalledOnce();
  });

  it("reuses a successful stored provider operation after a crash before workflow completion", async () => {
    const harness = await createHarness();
    const website = new MockWebsiteResearchProvider();
    const submit = vi.spyOn(website, "submit");
    const poll = vi.spyOn(website, "poll");
    let crashOnce = true;
    const crashingRunner = createRunner(harness, providers({ website }), {
      afterProviderPersistence: () => {
        if (crashOnce) {
          crashOnce = false;
          throw new Error("Synthetic crash after persistence.");
        }
      }
    });

    await expect(crashingRunner.runStep(
      harness.workflow.id,
      "website_research",
      "crashing-owner"
    )).rejects.toMatchObject({ safeCode: "provider_research_failed" });
    expect(harness.researchStore.snapshot().operations[0]).toMatchObject({ state: "succeeded" });
    expect(harness.workflowStore.snapshot().steps.find((step) => step.stepKey === "website_research"))
      .toMatchObject({ status: "failed_terminal" });

    await new WorkflowAdministratorService(harness.workflowStore, actor)
      .retryStep(harness.workflow.id, "website_research");
    const recoveryRunner = createRunner(harness, providers({ website }));
    await expect(recoveryRunner.runStep(
      harness.workflow.id,
      "website_research",
      "recovery-owner"
    )).resolves.toBe("succeeded");

    expect(submit).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenCalledOnce();
    expect(harness.researchStore.snapshot().pages).toHaveLength(2);
    expect(harness.workflowStore.snapshot().costs.filter((entry) => entry.entryType === "actual"))
      .toHaveLength(1);
  });

  it("makes duplicate queue delivery harmless across the complete PR4 continuation", async () => {
    let now = new Date("2026-01-15T12:00:00.000Z");
    const harness = await createHarness({ now: () => now });
    const website = new MockWebsiteResearchProvider();
    const analysis = new MockStructuredAnalysisProvider();
    const submit = vi.spyOn(website, "submit");
    const profile = vi.spyOn(analysis, "extractCompanyProfile");
    const queries = vi.spyOn(analysis, "discoverSearchQueries");
    const queue = new MemoryWorkflowQueue(() => now);
    const payload = harness.workflowStore.snapshot().outbox[0]!.payload;
    await queue.enqueue(payload, "provider-primary");
    queue.seedUnsafeMessageForTests(payload);
    const compositeRunner = new CompositeResearchWorkflowRunner(
      new DurableWorkflowRunner(harness.workflowStore, { now: () => now }),
      createRunner(harness, providers({ website, analysis }), { now: () => now })
    );
    const consumer = new WorkflowQueueConsumer(harness.workflowStore, queue, {
      batchSize: 2,
      now: () => now,
      runner: compositeRunner
    });

    for (let delivery = 0; delivery < 6; delivery += 1) {
      await consumer.consume();
      now = new Date(now.getTime() + 1_000);
    }

    expect((await harness.workflowStore.getWorkflow(harness.workflow.id))?.status)
      .toBe("ready_for_search_intelligence");
    expect(queue.snapshot().messages.every((message) => message.archived)).toBe(true);
    expect(submit).toHaveBeenCalledOnce();
    expect(profile).toHaveBeenCalledOnce();
    expect(queries).toHaveBeenCalledOnce();
    expect(harness.researchStore.snapshot().operations).toHaveLength(3);
  });

  it("quarantines a paid model result when durable persistence is uncertain", async () => {
    const harness = await createHarness();
    const analysis = new MockStructuredAnalysisProvider();
    const extract = vi.spyOn(analysis, "extractCompanyProfile");
    const runner = createRunner(harness, providers({ analysis }));
    await runner.runStep(harness.workflow.id, "website_research", "persistence-website-owner");
    vi.spyOn(harness.researchStore, "persistCompanyProfile")
      .mockRejectedValueOnce(new TypeError("Synthetic database connection loss."));

    await expect(runner.runStep(
      harness.workflow.id,
      "company_profile_extraction",
      "persistence-profile-owner"
    )).rejects.toMatchObject({
      classification: "configuration_error",
      safeCode: "provider_outcome_unknown"
    });
    expect(harness.researchStore.snapshot().operations.find(
      (operation) => operation.operationKind === "company_profile_extraction"
    )).toMatchObject({ state: "outcome_unknown" });
    expect(harness.researchStore.snapshot().profiles).toHaveLength(0);

    await new WorkflowAdministratorService(harness.workflowStore, actor)
      .retryStep(harness.workflow.id, "company_profile_extraction");
    await expect(runner.runStep(
      harness.workflow.id,
      "company_profile_extraction",
      "persistence-profile-retry-owner"
    )).rejects.toMatchObject({ safeCode: "provider_outcome_unknown" });
    expect(extract).toHaveBeenCalledOnce();
  });

  it("persists the Firecrawl job id, respects polling delay, and never resubmits the job", async () => {
    let now = new Date("2026-01-15T12:00:00.000Z");
    const harness = await createHarness({
      costs: { website: 25, profile: 0, query: 0 },
      now: () => now
    });
    let pollCount = 0;
    const website: WebsiteResearchProvider = {
      provider: "firecrawl",
      submit: vi.fn(async () => ({
        provider: "firecrawl" as const,
        jobId: "durable_job_123",
        state: "submitted" as const,
        httpStatus: 200,
        providerCreatedAt: SYNTHETIC_RESEARCH_TIME,
        usage: {}
      })),
      poll: vi.fn(async () => {
        pollCount += 1;
        if (pollCount === 1) {
          return {
            state: "running" as const,
            httpStatus: 200,
            retryAfterSeconds: 20,
            usage: { creditsUsed: 1 }
          };
        }
        return {
          state: "completed" as const,
          httpStatus: 200,
          providerCompletedAt: "2026-01-15T12:00:21.000Z",
          usage: { creditsUsed: 1 },
          pages: [websitePage()]
        };
      })
    };
    const runner = createRunner(harness, providers({
      website,
      costs: { website: 25, profile: 0, query: 0 },
      actualWebsiteCost: 7
    }), { now: () => now });

    await expect(runner.runStep(harness.workflow.id, "website_research", "poll-owner-1"))
      .rejects.toMatchObject({ safeCode: "provider_job_pending", retryAfterSeconds: 20 });
    expect(harness.researchStore.snapshot().operations[0]).toMatchObject({
      state: "submitted",
      providerJobId: "durable_job_123",
      nextRetryAt: "2026-01-15T12:00:20.000Z"
    });
    expect(harness.workflowStore.snapshot().steps.find((step) => step.stepKey === "website_research"))
      .toMatchObject({ status: "retry_scheduled", scheduledAt: "2026-01-15T12:00:20.000Z" });
    expect(await harness.workflowStore.getPublicProgress(harness.reportRequestId)).toMatchObject({
      state: "temporarily_delayed",
      currentStep: "crawl",
      steps: expect.arrayContaining([
        expect.objectContaining({ label: "Request received", status: "complete" }),
        expect.objectContaining({ label: "Reviewing your website", status: "running" })
      ])
    });

    now = new Date("2026-01-15T12:00:21.000Z");
    await expect(runner.runStep(harness.workflow.id, "website_research", "poll-owner-2"))
      .resolves.toBe("succeeded");
    expect(website.submit).toHaveBeenCalledOnce();
    expect(website.poll).toHaveBeenCalledTimes(2);
    expect((await harness.workflowStore.getWorkflowDetail(harness.workflow.id))?.budget)
      .toMatchObject({ limitCents: 400, reservedCents: 0, spentCents: 7 });
  });

  it("allows an administrator retry after corrected credentials under the same operation and reservation", async () => {
    const harness = await createHarness({ costs: { website: 20, profile: 0, query: 0 } });
    let authenticated = false;
    const website: WebsiteResearchProvider = {
      provider: "firecrawl",
      submit: vi.fn(async () => {
        if (!authenticated) {
          throw new ProviderResearchError(
            "configuration_error",
            "provider_authentication_failed",
            "Provider credentials require administrator configuration.",
            { httpStatus: 401 }
          );
        }
        return {
          provider: "firecrawl" as const,
          jobId: "authenticated_job_123",
          state: "submitted" as const,
          httpStatus: 200,
          providerCreatedAt: SYNTHETIC_RESEARCH_TIME,
          usage: {}
        };
      }),
      poll: vi.fn(async () => ({
        state: "completed" as const,
        httpStatus: 200,
        providerCompletedAt: SYNTHETIC_RESEARCH_TIME,
        usage: { creditsUsed: 1 },
        pages: [websitePage()]
      }))
    };
    const runner = createRunner(harness, providers({
      website,
      costs: { website: 20, profile: 0, query: 0 },
      actualWebsiteCost: 4
    }));

    await expect(runner.runStep(harness.workflow.id, "website_research", "auth-owner-1"))
      .rejects.toMatchObject({
        classification: "configuration_error",
        safeCode: "provider_authentication_failed"
      });
    expect(harness.researchStore.snapshot().operations[0]).toMatchObject({
      state: "retry_scheduled",
      providerJobId: null
    });
    expect((await harness.workflowStore.getWorkflowDetail(harness.workflow.id))?.budget)
      .toMatchObject({ reservedCents: 20, spentCents: 0 });

    authenticated = true;
    await new WorkflowAdministratorService(harness.workflowStore, actor)
      .retryStep(harness.workflow.id, "website_research");
    await expect(runner.runStep(harness.workflow.id, "website_research", "auth-owner-2"))
      .resolves.toBe("succeeded");
    expect(website.submit).toHaveBeenCalledTimes(2);
    expect(harness.researchStore.snapshot().operations).toHaveLength(1);
    expect((await harness.workflowStore.getWorkflowDetail(harness.workflow.id))?.budget)
      .toMatchObject({ reservedCents: 0, spentCents: 4 });
  });

  it("quarantines an uncertain submission outcome so retries cannot duplicate paid work", async () => {
    const harness = await createHarness({ costs: { website: 20, profile: 0, query: 0 } });
    const submit = vi.fn(async () => {
      throw new ProviderResearchError(
        "transient",
        "provider_timeout",
        "Submission timed out.",
        { outcomeUncertain: true, retryAfterSeconds: 10 }
      );
    });
    const website: WebsiteResearchProvider = {
      provider: "firecrawl",
      submit,
      poll: vi.fn()
    };
    const runner = createRunner(harness, providers({
      website,
      costs: { website: 20, profile: 0, query: 0 }
    }));

    await expect(runner.runStep(harness.workflow.id, "website_research", "unknown-owner-1"))
      .rejects.toMatchObject({
        classification: "configuration_error",
        safeCode: "provider_outcome_unknown"
      });
    expect(harness.researchStore.snapshot().operations[0]).toMatchObject({ state: "outcome_unknown" });

    await new WorkflowAdministratorService(harness.workflowStore, actor)
      .retryStep(harness.workflow.id, "website_research");
    await expect(runner.runStep(harness.workflow.id, "website_research", "unknown-owner-2"))
      .rejects.toMatchObject({ safeCode: "provider_outcome_unknown" });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("releases unused budget for a terminal pre-execution rejection", async () => {
    const harness = await createHarness({ costs: { website: 20, profile: 0, query: 0 } });
    const website: WebsiteResearchProvider = {
      provider: "firecrawl",
      submit: vi.fn(async () => {
        throw new ProviderResearchError(
          "permanent",
          "provider_request_rejected",
          "The provider rejected the synthetic request.",
          { httpStatus: 422 }
        );
      }),
      poll: vi.fn()
    };
    const runner = createRunner(harness, providers({
      website,
      costs: { website: 20, profile: 0, query: 0 }
    }));

    await expect(runner.runStep(harness.workflow.id, "website_research", "rejected-owner"))
      .rejects.toMatchObject({ safeCode: "provider_request_rejected" });
    expect((await harness.workflowStore.getWorkflowDetail(harness.workflow.id))?.budget)
      .toMatchObject({ reservedCents: 0, spentCents: 0 });
    expect(harness.workflowStore.snapshot().costs).toEqual(expect.arrayContaining([
      expect.objectContaining({ entryType: "reservation", amountCents: 20 }),
      expect.objectContaining({ entryType: "release", amountCents: 20 })
    ]));
  });

  it("does no provider work while paused or cancelled and surfaces configuration failure as failure", async () => {
    const paused = await createHarness();
    const pausedWebsite = new MockWebsiteResearchProvider();
    const pausedSubmit = vi.spyOn(pausedWebsite, "submit");
    const pausedAdmin = new WorkflowAdministratorService(paused.workflowStore, actor);
    await pausedAdmin.pause(paused.workflow.id);
    await expect(createRunner(paused, providers({ website: pausedWebsite })).runStep(
      paused.workflow.id,
      "website_research",
      "paused-owner"
    )).resolves.toBe("unavailable");
    expect(pausedSubmit).not.toHaveBeenCalled();

    const cancelled = await createHarness();
    const cancelledWebsite = new MockWebsiteResearchProvider();
    const cancelledSubmit = vi.spyOn(cancelledWebsite, "submit");
    await new WorkflowAdministratorService(cancelled.workflowStore, actor).cancel(cancelled.workflow.id);
    await expect(createRunner(cancelled, providers({ website: cancelledWebsite })).runStep(
      cancelled.workflow.id,
      "website_research",
      "cancelled-owner"
    )).resolves.toBe("unavailable");
    expect(cancelledSubmit).not.toHaveBeenCalled();

    const missingConfiguration = await createHarness();
    const configurationRunner = new ConfigurationFailureProviderResearchRunner(
      missingConfiguration.workflowStore,
      new ProviderResearchError(
        "configuration_error",
        "provider_research_configuration",
        "Synthetic provider configuration is absent."
      )
    );
    await expect(configurationRunner.runStep(
      missingConfiguration.workflow.id,
      "website_research",
      "configuration-owner"
    )).rejects.toMatchObject({ safeCode: "provider_research_configuration" });
    expect((await missingConfiguration.workflowStore.getWorkflow(missingConfiguration.workflow.id))?.status)
      .toBe("failed");
    expect((await missingConfiguration.workflowStore.getPublicProgress(missingConfiguration.reportRequestId))?.steps[1])
      .toMatchObject({ label: "Reviewing your website", status: "failed" });
  });
});

interface Harness {
  workflowStore: MemoryWorkflowStore;
  researchStore: MemoryProviderResearchStore;
  workflow: Awaited<ReturnType<MemoryWorkflowStore["createInitialWorkflow"]>>;
  reportRequestId: string;
}

async function createHarness(options: {
  costs?: { website: number; profile: number; query: number };
  now?: () => Date;
} = {}): Promise<Harness> {
  resetMemoryWorkflowStoreForTests();
  const reportRequestId = crypto.randomUUID();
  const reportId = crypto.randomUUID();
  const workflowStore = new MemoryWorkflowStore();
  const workflow = await workflowStore.createInitialWorkflow({
    reportRequestId,
    reportId,
    correlationId: crypto.randomUUID(),
    inputHash: sha256(`research:${reportRequestId}`),
    orchestratorBackend: "deterministic"
  }, options.now?.().toISOString());
  const payload = workflowStore.snapshot().outbox[0]!.payload;
  await new DurableWorkflowRunner(workflowStore, { now: options.now }).run(payload, "foundation");
  const researchStore = new MemoryProviderResearchStore([{
    workflowId: workflow.id,
    reportRequestId,
    reportId,
    companyId: crypto.randomUUID(),
    normalizedUrl: "https://example.com/",
    domain: "example.com",
    requestFingerprint: sha256("https://example.com/"),
    legacyPublicId: null
  }]);
  const costs = options.costs ?? { website: 0, profile: 0, query: 0 };
  await new ProviderResearchContinuation(workflowStore, {
    websiteReservationCents: costs.website,
    profileReservationCents: costs.profile,
    queryReservationCents: costs.query
  }, 4).prepare(workflow.id, options.now?.().toISOString());
  return { workflowStore, researchStore, workflow, reportRequestId };
}

function providers(options: {
  website?: ProviderResearchProviders["website"];
  analysis?: ProviderResearchProviders["analysis"];
  costs?: { website: number; profile: number; query: number };
  actualWebsiteCost?: number;
} = {}): ProviderResearchProviders {
  const costs = options.costs ?? { website: 0, profile: 0, query: 0 };
  return {
    website: options.website ?? new MockWebsiteResearchProvider(),
    analysis: options.analysis ?? new MockStructuredAnalysisProvider(),
    costPolicy: {
      websiteReservationCents: costs.website,
      profileReservationCents: costs.profile,
      queryReservationCents: costs.query,
      actualWebsiteCost: () => options.actualWebsiteCost ?? 0,
      actualModelCost: () => 0
    },
    maximumPages: 7,
    queryCount: 8,
    evidenceTtlHours: 48,
    mockMode: costs.website + costs.profile + costs.query === 0
  };
}

function createRunner(
  harness: Harness,
  providerBundle: ProviderResearchProviders,
  options: ConstructorParameters<typeof ProviderResearchWorkflowRunner>[3] = {}
) {
  return new ProviderResearchWorkflowRunner(
    harness.workflowStore,
    harness.researchStore,
    providerBundle,
    { leaseSeconds: 120, maximumAttempts: 4, ...options }
  );
}

function websitePage() {
  const markdown = "Example Labs provides buyer research for B2B growth teams.";
  return {
    pageIndex: 0,
    sourceUrl: "https://example.com/",
    canonicalUrl: "https://example.com/",
    title: "Example Labs",
    description: "Buyer research",
    markdown,
    contentHash: sha256(markdown),
    rawArtifact: {
      markdown,
      metadata: { sourceURL: "https://example.com/", statusCode: 200 }
    },
    providerCreatedAt: SYNTHETIC_RESEARCH_TIME,
    crawledAt: SYNTHETIC_RESEARCH_TIME,
    freshUntil: "2026-01-17T12:00:00.000Z"
  };
}
