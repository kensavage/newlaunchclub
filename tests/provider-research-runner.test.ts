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
    const profile = vi.spyOn(analysis, "createCompanyProfileResponse");
    const queries = vi.spyOn(analysis, "createSearchQueryResponse");
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
      currentStep: "research_ready",
      steps: [
        { label: "Request received", status: "complete" },
        { label: "Reviewing your website", status: "complete" },
        { label: "Building your company profile", status: "complete" },
        { label: "Preparing your market research", status: "complete" }
      ]
    });
    const response = createPublicWorkflowResponse("lc_report_synthetic_access_token_123", progress!);
    expect(response).toMatchObject({
      job: {
        status: "running",
        state: "research_ready",
        currentStep: "research_ready",
        progress: null
      },
      report: null
    });
    expect(JSON.stringify(response)).not.toMatch(/Google|Reddit|competitor|opportunity|report ready/i);

    await expect(runner.runStep(harness.workflow.id, "website_research", "duplicate-owner"))
      .resolves.toBe("already_succeeded");
    expect(submit).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenCalledOnce();
    expect(profile).toHaveBeenCalledOnce();
    expect(queries).toHaveBeenCalledOnce();
  });

  it("blocks Firecrawl, paid calls, and reservations when OpenAI readiness is rejected", async () => {
    const harness = await createHarness({ costs: { website: 20, profile: 25, query: 10 } });
    const website = new MockWebsiteResearchProvider();
    const analysis = new MockStructuredAnalysisProvider();
    const submit = vi.spyOn(website, "submit");
    const readiness = vi.spyOn(analysis, "checkReadiness").mockRejectedValueOnce(
      new ProviderResearchError(
        "configuration_error",
        "provider_authentication_failed",
        "The analysis provider requires administrator configuration.",
        { httpStatus: 401, outcome: "definitively_rejected" }
      )
    );
    const runner = createRunner(harness, providers({
      website,
      analysis,
      costs: { website: 20, profile: 25, query: 10 }
    }));

    await expect(runner.runStep(harness.workflow.id, "website_research", "readiness-owner"))
      .rejects.toMatchObject({
        classification: "configuration_error",
        safeCode: "provider_authentication_failed",
        httpStatus: 401
      });
    expect(readiness).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    expect(harness.researchStore.snapshot().operations).toHaveLength(0);
    expect((await harness.workflowStore.getWorkflowDetail(harness.workflow.id))?.budget)
      .toMatchObject({ limitCents: 400, reservedCents: 0, spentCents: 0 });
    expect((await harness.workflowStore.getWorkflow(harness.workflow.id))?.status).toBe("paused");
    expect(harness.workflowStore.snapshot().steps.find((step) => step.stepKey === "website_research"))
      .toMatchObject({ status: "failed_terminal" });
  });

  it("preserves Firecrawl spend and releases a later definitive OpenAI rejection", async () => {
    const harness = await createHarness({ costs: { website: 20, profile: 25, query: 10 } });
    const website = new MockWebsiteResearchProvider();
    const analysis = new MockStructuredAnalysisProvider();
    vi.spyOn(analysis, "createCompanyProfileResponse").mockRejectedValueOnce(
      new ProviderResearchError(
        "configuration_error",
        "provider_authentication_failed",
        "The analysis provider requires administrator configuration.",
        { httpStatus: 401, outcome: "definitively_rejected" }
      )
    );
    const runner = createRunner(harness, providers({
      website,
      analysis,
      costs: { website: 20, profile: 25, query: 10 },
      actualWebsiteCost: 5
    }));

    await expect(runner.runStep(harness.workflow.id, "website_research", "budget-website-owner"))
      .resolves.toBe("succeeded");
    await expect(runner.runStep(harness.workflow.id, "company_profile_extraction", "budget-profile-owner"))
      .rejects.toMatchObject({ safeCode: "provider_authentication_failed" });

    const detail = await harness.workflowStore.getWorkflowDetail(harness.workflow.id);
    expect(detail?.workflow.status).toBe("paused");
    expect(detail?.budget).toMatchObject({ limitCents: 400, reservedCents: 0, spentCents: 5 });
    expect(400 - detail!.budget!.reservedCents - detail!.budget!.spentCents).toBe(395);
    expect(harness.researchStore.snapshot().operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operationKind: "website_research",
        outcome: "succeeded",
        actualCostCents: 5,
        reservedCostCents: 0
      }),
      expect.objectContaining({
        operationKind: "company_profile_extraction",
        state: "failed",
        outcome: "definitively_rejected",
        reservedCostCents: 0
      })
    ]));
    expect(harness.researchStore.snapshot().operations.some(
      (operation) => operation.state === "retry_scheduled"
    )).toBe(false);
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
    )).resolves.toBe("succeeded");
    expect(harness.researchStore.snapshot().operations[0]).toMatchObject({ state: "succeeded" });
    expect(harness.workflowStore.snapshot().steps.find((step) => step.stepKey === "website_research"))
      .toMatchObject({ status: "succeeded" });

    const recoveryRunner = createRunner(harness, providers({ website }));
    await expect(recoveryRunner.runStep(
      harness.workflow.id,
      "website_research",
      "recovery-owner"
    )).resolves.toBe("already_succeeded");

    expect(submit).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenCalledOnce();
    expect(harness.researchStore.snapshot().pages).toHaveLength(2);
    expect(harness.workflowStore.snapshot().costs.filter((entry) => entry.entryType === "actual"))
      .toHaveLength(0);
  });

  it("makes duplicate queue delivery harmless across the complete PR4 continuation", async () => {
    let now = new Date("2026-01-15T12:00:00.000Z");
    const harness = await createHarness({ now: () => now });
    const website = new MockWebsiteResearchProvider();
    const analysis = new MockStructuredAnalysisProvider();
    const submit = vi.spyOn(website, "submit");
    const profile = vi.spyOn(analysis, "createCompanyProfileResponse");
    const queries = vi.spyOn(analysis, "createSearchQueryResponse");
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

  it("retries business persistence from the captured response without duplicate inference", async () => {
    const harness = await createHarness();
    const analysis = new MockStructuredAnalysisProvider();
    const extract = vi.spyOn(analysis, "createCompanyProfileResponse");
    const runner = createRunner(harness, providers({ analysis }));
    await runner.runStep(harness.workflow.id, "website_research", "persistence-website-owner");
    vi.spyOn(harness.researchStore, "persistCompanyProfile")
      .mockRejectedValueOnce(new TypeError("Synthetic database connection loss."));

    await expect(runner.runStep(
      harness.workflow.id,
      "company_profile_extraction",
      "persistence-profile-owner"
    )).rejects.toMatchObject({
      classification: "transient",
      safeCode: "analysis_persistence_interrupted",
      providerResponseCaptured: true
    });
    expect(harness.researchStore.snapshot().operations.find(
      (operation) => operation.operationKind === "company_profile_extraction"
    )).toMatchObject({
      state: "submitting",
      outcome: "succeeded",
      reservedCostCents: 0,
      processingStatus: "failed"
    });
    expect(harness.researchStore.snapshot().profiles).toHaveLength(0);
    expect(harness.researchStore.snapshot().analysisResponses[0]?.artifact).toMatchObject({
      firstSafeCode: "analysis_persistence_interrupted",
      currentSafeCode: "analysis_persistence_interrupted"
    });

    await new WorkflowAdministratorService(harness.workflowStore, actor)
      .retryStep(harness.workflow.id, "company_profile_extraction");
    await expect(runner.runStep(
      harness.workflow.id,
      "company_profile_extraction",
      "persistence-profile-retry-owner"
    )).resolves.toBe("succeeded");
    expect(extract).toHaveBeenCalledOnce();
    expect(harness.researchStore.snapshot().profiles).toHaveLength(1);
    expect(harness.researchStore.snapshot().analysisResponses[0]?.artifact).toMatchObject({
      firstSafeCode: "analysis_persistence_interrupted",
      currentSafeCode: null,
      persistenceStatus: "succeeded"
    });
  });

  it("recovers after a crash between durable response capture and parsing without spending twice", async () => {
    const harness = await createHarness({ costs: { website: 0, profile: 30, query: 0 } });
    const analysis = new MockStructuredAnalysisProvider();
    const createResponse = vi.spyOn(analysis, "createCompanyProfileResponse");
    let crashOnce = true;
    const runner = createRunner(harness, providers({
      analysis,
      costs: { website: 0, profile: 30, query: 0 },
      actualModelCost: 7
    }), {
      afterProviderResponseCapture: (stepKey) => {
        if (stepKey === "company_profile_extraction" && crashOnce) {
          crashOnce = false;
          throw new Error("Synthetic crash after durable response capture.");
        }
      }
    });
    await runner.runStep(harness.workflow.id, "website_research", "capture-crash-website");

    await expect(runner.runStep(
      harness.workflow.id,
      "company_profile_extraction",
      "capture-crash-profile"
    )).rejects.toMatchObject({
      safeCode: "analysis_processing_interrupted",
      providerResponseCaptured: true,
      processingPhase: "response_capture"
    });

    const failedSnapshot = harness.researchStore.snapshot();
    expect(failedSnapshot.operations.find(
      (operation) => operation.operationKind === "company_profile_extraction"
    )).toMatchObject({
      state: "submitting",
      outcome: "succeeded",
      providerResponseStatus: "completed",
      processingStatus: "failed",
      reservedCostCents: 0,
      actualCostCents: 7
    });
    expect(failedSnapshot.analysisResponses[0]?.artifact).toMatchObject({
      responseStatus: "completed",
      firstSafeCode: "analysis_processing_interrupted"
    });
    expect((await harness.workflowStore.getWorkflowDetail(harness.workflow.id))?.budget)
      .toMatchObject({ reservedCents: 0, spentCents: 7 });

    await new WorkflowAdministratorService(harness.workflowStore, actor)
      .retryStep(harness.workflow.id, "company_profile_extraction");
    await expect(runner.runStep(
      harness.workflow.id,
      "company_profile_extraction",
      "capture-crash-recovery"
    )).resolves.toBe("succeeded");

    expect(createResponse).toHaveBeenCalledOnce();
    expect(harness.workflowStore.snapshot().costs.filter((entry) => entry.entryType === "actual"))
      .toEqual([expect.objectContaining({ amountCents: 7 })]);
    expect(harness.workflowStore.snapshot().costs.filter((entry) => entry.entryType === "release"))
      .toEqual([expect.objectContaining({ amountCents: 23 })]);
    expect((await harness.workflowStore.getWorkflowDetail(harness.workflow.id))?.budget)
      .toMatchObject({ reservedCents: 0, spentCents: 7 });
  });

  it("retrieves an incomplete local artifact by response id instead of issuing replacement inference", async () => {
    const harness = await createHarness();
    const analysis = new MockStructuredAnalysisProvider();
    const originalCreate = analysis.createCompanyProfileResponse.bind(analysis);
    const createResponse = vi.spyOn(analysis, "createCompanyProfileResponse")
      .mockImplementation(async (input) => {
        const complete = await originalCreate(input);
        return {
          ...complete,
          outputText: complete.outputText!.slice(0, 24),
          artifactComplete: false,
          sanitizedMetadata: { ...complete.sanitizedMetadata, outputTruncated: true }
        };
      });
    const retrieve = vi.spyOn(analysis, "retrieveResponse");
    const runner = createRunner(harness, providers({ analysis }));
    await runner.runStep(harness.workflow.id, "website_research", "retrieve-website");

    await expect(runner.runStep(
      harness.workflow.id,
      "company_profile_extraction",
      "retrieve-profile"
    )).resolves.toBe("succeeded");

    expect(createResponse).toHaveBeenCalledOnce();
    expect(retrieve).toHaveBeenCalledOnce();
    expect(harness.researchStore.snapshot().analysisResponses[0]?.artifact).toMatchObject({
      artifactComplete: true,
      retrievalAttempts: 1,
      reconciliationStatus: "recovered",
      persistenceStatus: "succeeded"
    });
  });

  it("does not replace inference when exact-response retrieval fails", async () => {
    const harness = await createHarness();
    const analysis = new MockStructuredAnalysisProvider();
    const originalCreate = analysis.createCompanyProfileResponse.bind(analysis);
    const createResponse = vi.spyOn(analysis, "createCompanyProfileResponse")
      .mockImplementation(async (input) => {
        const complete = await originalCreate(input);
        return {
          ...complete,
          outputText: complete.outputText!.slice(0, 24),
          artifactComplete: false,
          sanitizedMetadata: { ...complete.sanitizedMetadata, outputTruncated: true }
        };
      });
    const retrieve = vi.spyOn(analysis, "retrieveResponse").mockRejectedValue(
      new ProviderResearchError(
        "transient",
        "provider_response_retrieval_failed",
        "The exact stored response is temporarily unavailable.",
        {
          retryAfterSeconds: 10,
          providerResponseCaptured: true,
          processingPhase: "retrieval"
        }
      )
    );
    const runner = createRunner(harness, providers({ analysis }));
    await runner.runStep(harness.workflow.id, "website_research", "retrieve-failure-website");

    await expect(runner.runStep(
      harness.workflow.id,
      "company_profile_extraction",
      "retrieve-failure-profile"
    )).rejects.toMatchObject({
      safeCode: "provider_response_retrieval_failed",
      providerResponseCaptured: true,
      processingPhase: "retrieval"
    });
    await new WorkflowAdministratorService(harness.workflowStore, actor)
      .retryStep(harness.workflow.id, "company_profile_extraction");
    await expect(runner.runStep(
      harness.workflow.id,
      "company_profile_extraction",
      "retrieve-failure-retry"
    )).rejects.toMatchObject({ safeCode: "provider_response_retrieval_failed" });

    expect(createResponse).toHaveBeenCalledOnce();
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(harness.researchStore.snapshot().analysisResponses[0]?.artifact).toMatchObject({
      artifactComplete: false,
      reconciliationStatus: "retrieval_failed",
      retrievalAttempts: 2,
      firstSafeCode: "provider_response_retrieval_failed"
    });
  });

  it("uses the same exact-response recovery boundary for query generation", async () => {
    const harness = await createHarness();
    const analysis = new MockStructuredAnalysisProvider();
    const originalCreate = analysis.createSearchQueryResponse.bind(analysis);
    const createQueries = vi.spyOn(analysis, "createSearchQueryResponse")
      .mockImplementation(async (input) => {
        const complete = await originalCreate(input);
        return {
          ...complete,
          outputText: complete.outputText!.slice(0, 16),
          artifactComplete: false,
          sanitizedMetadata: { ...complete.sanitizedMetadata, outputTruncated: true }
        };
      });
    const retrieve = vi.spyOn(analysis, "retrieveResponse");
    const runner = createRunner(harness, providers({ analysis }));
    await runner.runStep(harness.workflow.id, "website_research", "query-retrieve-website");
    await runner.runStep(harness.workflow.id, "company_profile_extraction", "query-retrieve-profile");

    await expect(runner.runStep(
      harness.workflow.id,
      "search_query_discovery",
      "query-retrieve-discovery"
    )).resolves.toBe("succeeded");

    expect(createQueries).toHaveBeenCalledOnce();
    expect(retrieve).toHaveBeenCalledOnce();
    const artifact = harness.researchStore.snapshot().analysisResponses.find(
      ({ artifact: candidate }) => candidate.providerResponseId.startsWith("mock-queries-")
    )?.artifact;
    expect(artifact).toMatchObject({
      artifactComplete: true,
      reconciliationStatus: "recovered",
      persistenceStatus: "succeeded",
      retrievalAttempts: 1
    });
  });

  it("retries query persistence from its captured response without a second query inference", async () => {
    const harness = await createHarness();
    const analysis = new MockStructuredAnalysisProvider();
    const createQueries = vi.spyOn(analysis, "createSearchQueryResponse");
    const runner = createRunner(harness, providers({ analysis }));
    await runner.runStep(harness.workflow.id, "website_research", "query-persist-website");
    await runner.runStep(harness.workflow.id, "company_profile_extraction", "query-persist-profile");
    vi.spyOn(harness.researchStore, "persistSearchQueries")
      .mockRejectedValueOnce(new TypeError("Synthetic query-set database interruption."));

    await expect(runner.runStep(
      harness.workflow.id,
      "search_query_discovery",
      "query-persist-failure"
    )).rejects.toMatchObject({
      safeCode: "analysis_persistence_interrupted",
      providerResponseCaptured: true,
      processingPhase: "persistence"
    });
    await new WorkflowAdministratorService(harness.workflowStore, actor)
      .retryStep(harness.workflow.id, "search_query_discovery");
    await expect(runner.runStep(
      harness.workflow.id,
      "search_query_discovery",
      "query-persist-retry"
    )).resolves.toBe("succeeded");

    expect(createQueries).toHaveBeenCalledOnce();
    const artifact = harness.researchStore.snapshot().analysisResponses.find(
      ({ artifact: candidate }) => candidate.providerResponseId.startsWith("mock-queries-")
    )?.artifact;
    expect(artifact).toMatchObject({
      firstSafeCode: "analysis_persistence_interrupted",
      currentSafeCode: null,
      persistenceStatus: "succeeded"
    });
    expect(harness.researchStore.snapshot().querySets).toHaveLength(1);
  });

  it("quarantines a returned response when durable capture itself cannot be confirmed", async () => {
    const harness = await createHarness({ costs: { website: 0, profile: 20, query: 0 } });
    const analysis = new MockStructuredAnalysisProvider();
    const createResponse = vi.spyOn(analysis, "createCompanyProfileResponse");
    vi.spyOn(harness.researchStore, "captureAnalysisResponse")
      .mockRejectedValueOnce(new TypeError("Synthetic capture transaction interruption."));
    const runner = createRunner(harness, providers({
      analysis,
      costs: { website: 0, profile: 20, query: 0 },
      actualModelCost: 5
    }));
    await runner.runStep(harness.workflow.id, "website_research", "capture-failure-website");

    await expect(runner.runStep(
      harness.workflow.id,
      "company_profile_extraction",
      "capture-failure-profile"
    )).rejects.toMatchObject({
      safeCode: "analysis_response_capture_failed",
      outcome: "outcome_uncertain"
    });

    expect(createResponse).toHaveBeenCalledOnce();
    expect(harness.researchStore.snapshot().analysisResponses).toHaveLength(0);
    expect(harness.researchStore.snapshot().operations.find(
      (operation) => operation.operationKind === "company_profile_extraction"
    )).toMatchObject({
      state: "outcome_unknown",
      reconciliationRequired: true,
      reservedCostCents: 20,
      lastSafeErrorCode: "analysis_response_capture_failed"
    });
    expect((await harness.workflowStore.getWorkflowDetail(harness.workflow.id))?.budget)
      .toMatchObject({ reservedCents: 20, spentCents: 0 });
  });

  it("recovers when the response-capture commit succeeds but its acknowledgement is lost", async () => {
    const harness = await createHarness({ costs: { website: 0, profile: 20, query: 0 } });
    const analysis = new MockStructuredAnalysisProvider();
    const createResponse = vi.spyOn(analysis, "createCompanyProfileResponse");
    const originalCapture = harness.researchStore.captureAnalysisResponse.bind(harness.researchStore);
    vi.spyOn(harness.researchStore, "captureAnalysisResponse")
      .mockImplementationOnce(async (input, workflowStore) => {
        await originalCapture(input, workflowStore);
        throw new TypeError("Synthetic lost acknowledgement after capture commit.");
      });
    const runner = createRunner(harness, providers({
      analysis,
      costs: { website: 0, profile: 20, query: 0 },
      actualModelCost: 5
    }));
    await runner.runStep(harness.workflow.id, "website_research", "capture-ack-website");

    await expect(runner.runStep(
      harness.workflow.id,
      "company_profile_extraction",
      "capture-ack-profile"
    )).resolves.toBe("succeeded");

    expect(createResponse).toHaveBeenCalledOnce();
    expect(harness.researchStore.snapshot().profiles).toHaveLength(1);
    expect(harness.researchStore.snapshot().operations.find(
      (operation) => operation.operationKind === "company_profile_extraction"
    )).toMatchObject({
      state: "succeeded",
      outcome: "succeeded",
      reconciliationRequired: false,
      reservedCostCents: 0,
      actualCostCents: 5
    });
    expect((await harness.workflowStore.getWorkflowDetail(harness.workflow.id))?.budget)
      .toMatchObject({ reservedCents: 0, spentCents: 5 });
  });

  it("recognizes committed profile persistence when only the database acknowledgement is lost", async () => {
    const harness = await createHarness();
    const analysis = new MockStructuredAnalysisProvider();
    const createResponse = vi.spyOn(analysis, "createCompanyProfileResponse");
    const originalPersist = harness.researchStore.persistCompanyProfile.bind(harness.researchStore);
    vi.spyOn(harness.researchStore, "persistCompanyProfile")
      .mockImplementationOnce(async (input) => {
        await originalPersist(input);
        throw new TypeError("Synthetic lost acknowledgement after profile commit.");
      });
    const runner = createRunner(harness, providers({ analysis }));
    await runner.runStep(harness.workflow.id, "website_research", "profile-ack-website");

    await expect(runner.runStep(
      harness.workflow.id,
      "company_profile_extraction",
      "profile-ack-profile"
    )).resolves.toBe("succeeded");

    expect(createResponse).toHaveBeenCalledOnce();
    expect(harness.researchStore.snapshot().profiles).toHaveLength(1);
    expect(harness.researchStore.snapshot().analysisResponses[0]?.artifact).toMatchObject({
      persistenceStatus: "succeeded",
      firstSafeCode: null
    });
    expect(harness.workflowStore.snapshot().errors).toEqual([]);
  });

  it("persists the Firecrawl job id, respects polling delay, and never resubmits the job", async () => {
    let now = new Date("2026-01-15T12:00:00.000Z");
    const harness = await createHarness({
      costs: { website: 25, profile: 0, query: 0 },
      now: () => now
    });
    let pollCount = 0;
    const analysis = new MockStructuredAnalysisProvider();
    const readiness = vi.spyOn(analysis, "checkReadiness");
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
      analysis,
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
    expect(readiness).toHaveBeenCalledOnce();
    expect((await harness.workflowStore.getWorkflowDetail(harness.workflow.id))?.budget)
      .toMatchObject({ limitCents: 400, reservedCents: 0, spentCents: 7 });
    const historicalErrors = harness.workflowStore.snapshot().errors.filter(
      (error) => error.safeCode === "provider_job_pending"
    );
    expect(historicalErrors).toHaveLength(1);
    expect(historicalErrors[0]?.resolvedAt).toBe("2026-01-15T12:00:21.000Z");
  });

  it("requires an administrator retry after corrected credentials and creates a fresh reservation", async () => {
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
      state: "failed",
      outcome: "definitively_rejected",
      providerJobId: null,
      reservedCostCents: 0
    });
    expect((await harness.workflowStore.getWorkflowDetail(harness.workflow.id))?.budget)
      .toMatchObject({ reservedCents: 0, spentCents: 0 });

    authenticated = true;
    await new WorkflowAdministratorService(harness.workflowStore, actor)
      .retryStep(harness.workflow.id, "website_research");
    await expect(runner.runStep(harness.workflow.id, "website_research", "auth-owner-2"))
      .resolves.toBe("succeeded");
    expect(website.submit).toHaveBeenCalledTimes(2);
    expect(harness.researchStore.snapshot().operations).toHaveLength(1);
    expect(harness.researchStore.snapshot().operations[0]?.reservationGeneration).toBe(2);
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
        classification: "transient",
        safeCode: "provider_timeout"
      });
    expect(harness.researchStore.snapshot().operations[0]).toMatchObject({
      state: "outcome_unknown",
      outcome: "outcome_uncertain",
      reconciliationRequired: true,
      reservedCostCents: 20
    });
    expect((await harness.workflowStore.getWorkflowDetail(harness.workflow.id))?.budget)
      .toMatchObject({ reservedCents: 20, spentCents: 0 });

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
      .toBe("paused");
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
  actualModelCost?: number;
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
      actualModelCost: () => options.actualModelCost ?? 0
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
