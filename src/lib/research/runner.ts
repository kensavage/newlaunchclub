import {
  PROVIDER_RESEARCH_WORKFLOW_STEPS,
  type ProviderResearchWorkflowStepKey,
  type WorkflowStepKey
} from "@/lib/workflow/schema";
import type { WorkflowStore } from "@/lib/workflow/store";
import {
  ProviderResearchError,
  assertQueriesSupportedByProfile,
  type ProviderOperationKind,
  type ProviderOperationRecord
} from "@/lib/research/contracts";
import { sha256, stableJson } from "@/lib/research/integrity";
import {
  assertCostWithinReservation,
  type ProviderResearchProviders
} from "@/lib/research/provider-factory";
import type { ProviderResearchStore } from "@/lib/research/store";

export interface ProviderResearchRunnerOptions {
  leaseSeconds?: number;
  maximumAttempts?: number;
  now?: () => Date;
  afterProviderPersistence?: (stepKey: ProviderResearchWorkflowStepKey) => void | Promise<void>;
}

interface ProviderStepContext {
  workflowAttemptId: string;
  owner: string;
  fencingToken: number;
}

export class ProviderResearchWorkflowRunner {
  private readonly leaseSeconds: number;
  private readonly maximumAttempts: number;
  private readonly now: () => Date;

  constructor(
    private readonly workflowStore: WorkflowStore,
    private readonly researchStore: ProviderResearchStore,
    private readonly providers: ProviderResearchProviders,
    private readonly options: ProviderResearchRunnerOptions = {}
  ) {
    this.leaseSeconds = options.leaseSeconds ?? 120;
    this.maximumAttempts = options.maximumAttempts ?? 4;
    this.now = options.now ?? (() => new Date());
  }

  async runStep(workflowId: string, stepKey: WorkflowStepKey, owner: string) {
    if (!PROVIDER_RESEARCH_WORKFLOW_STEPS.includes(stepKey as ProviderResearchWorkflowStepKey)) {
      throw new ProviderResearchError(
        "configuration_error",
        "provider_step_invalid",
        "The provider research runner received an unsupported step."
      );
    }
    const providerStep = stepKey as ProviderResearchWorkflowStepKey;
    const lease = await this.workflowStore.beginStep({
      workflowId,
      stepKey: providerStep,
      owner,
      leaseSeconds: this.leaseSeconds,
      now: this.now().toISOString()
    });
    if (lease.disposition === "already_succeeded") return "already_succeeded" as const;
    if (lease.disposition !== "acquired" || !lease.lease || !lease.attemptId) return "unavailable" as const;
    const acquiredLease = lease.lease;
    const workflowAttemptId = lease.attemptId;

    try {
      const context: ProviderStepContext = {
        workflowAttemptId,
        owner,
        fencingToken: acquiredLease.fencingToken
      };
      const outputReference = await this.withHeartbeat(
        workflowId,
        providerStep,
        owner,
        acquiredLease.fencingToken,
        () => this.executeProviderStep(workflowId, providerStep, lease.step.maximumAttempts, context)
      );
      await this.options.afterProviderPersistence?.(providerStep);
      await this.settleSuccessfulOperation(workflowId, providerStep, context, outputReference);
      return "succeeded" as const;
    } catch (error) {
      const failure = safeProviderFailure(error);
      if (failure.workflowSettled) throw failure;
      const context: ProviderStepContext = {
        workflowAttemptId,
        owner,
        fencingToken: acquiredLease.fencingToken
      };
      const operation = await this.researchStore.getOperation(workflowId, providerStep);
      if (operation?.state === "succeeded") {
        await this.settleSuccessfulOperation(
          workflowId,
          providerStep,
          context,
          `provider-operation:${operation.id}`
        );
        return "succeeded" as const;
      }
      const retryAt = new Date(
        this.now().getTime() + (failure.retryAfterSeconds ?? retryDelaySeconds(lease.step.attemptCount)) * 1_000
      ).toISOString();
      if (failure.classification === "configuration_error") {
        await this.researchStore.blockProviderConfiguration({
          workflowId,
          stepKey: providerStep,
          workflowAttemptId,
          owner,
          fencingToken: acquiredLease.fencingToken,
          safeCode: failure.safeCode,
          safeSummary: "Provider research requires administrator configuration.",
          now: this.now().toISOString()
        }, this.workflowStore);
      } else {
        await this.workflowStore.failStep({
          workflowId,
          stepKey: providerStep,
          owner,
          fencingToken: acquiredLease.fencingToken,
          classification: failure.classification,
          safeCode: failure.safeCode,
          safeSummary: failure.safeSummary,
          retryAt,
          now: this.now().toISOString()
        });
      }
      if (failure.classification === "lease_conflict") return "lease_conflict" as const;
      throw failure;
    }
  }

  private async executeProviderStep(
    workflowId: string,
    stepKey: ProviderResearchWorkflowStepKey,
    stepMaximumAttempts: number,
    context: ProviderStepContext
  ) {
    const input = await this.researchStore.getResearchInput(workflowId);
    if (!input || input.legacyPublicId) {
      throw new ProviderResearchError(
        "configuration_error",
        "provider_research_input_invalid",
        "The provider research input is unavailable or owned by the legacy pipeline."
      );
    }
    if (stepKey === "website_research") {
      return this.runWebsiteResearch(input, stepMaximumAttempts, context);
    }
    if (stepKey === "company_profile_extraction") {
      return this.runCompanyProfile(input, stepMaximumAttempts, context);
    }
    return this.runSearchQueryDiscovery(input, stepMaximumAttempts, context);
  }

  private async runWebsiteResearch(
    input: NonNullable<Awaited<ReturnType<ProviderResearchStore["getResearchInput"]>>>,
    maximumAttempts: number,
    context: ProviderStepContext
  ) {
    const existingOperation = await this.researchStore.getOperation(
      input.workflowId,
      "website_research"
    );
    if (!this.providers.mockMode && !existingOperation) {
      await this.providers.analysis.checkReadiness();
    }
    const requestFingerprint = sha256(stableJson({
      requestFingerprint: input.requestFingerprint,
      operation: "website_research",
      url: input.normalizedUrl,
      maximumPages: this.providers.maximumPages,
      maximumDepth: 1
    }));
    const operation = await this.ensureReservedOperation({
      workflowId: input.workflowId,
      operationKind: "website_research",
      provider: this.providers.website.provider,
      requestFingerprint,
      estimatedCostCents: this.providers.costPolicy.websiteReservationCents,
      maximumAttempts
    });
    if (operation.state === "succeeded") {
      return `provider-operation:${operation.id}`;
    }
    assertOperationCanRun(operation);

    let current = operation;
    if (!current.providerJobId) {
      const attempt = await this.researchStore.beginOperationAttempt(current.id, "submit", this.now().toISOString());
      try {
        const submission = await this.providers.website.submit({
          url: input.normalizedUrl,
          maximumPages: this.providers.maximumPages,
          maximumDepth: 1
        });
        current = await this.researchStore.recordProviderJob({
          operationId: current.id,
          attemptId: attempt.attemptId,
          providerJobId: submission.jobId,
          httpStatus: submission.httpStatus,
          providerUsage: submission.usage,
          providerCreatedAt: submission.providerCreatedAt,
          now: this.now().toISOString()
        });
      } catch (error) {
        throw await this.reconcileOperationFailure(current, attempt.attemptId, error, context);
      }
    }

    const pollAttempt = await this.researchStore.beginOperationAttempt(current.id, "poll", this.now().toISOString());
    try {
      const result = await this.providers.website.poll({
        jobId: current.providerJobId!,
        expectedUrl: input.normalizedUrl,
        maximumPages: this.providers.maximumPages
      });
      if (result.state === "running") {
        throw new ProviderResearchError(
          "transient",
          "provider_job_pending",
          "Website research is still running.",
          { retryAfterSeconds: result.retryAfterSeconds, httpStatus: result.httpStatus }
        );
      }
      for (const page of result.pages) await this.researchStore.storeWebsitePage(current.id, page);
      const actualCostCents = assertCostWithinReservation(
        this.providers.costPolicy.actualWebsiteCost(result.usage),
        current.estimatedCostCents
      );
      current = await this.researchStore.completeWebsiteOperation({
        operationId: current.id,
        attemptId: pollAttempt.attemptId,
        httpStatus: result.httpStatus,
        providerUsage: result.usage,
        actualCostCents,
        providerCompletedAt: result.providerCompletedAt,
        now: this.now().toISOString()
      });
      return `provider-operation:${current.id}`;
    } catch (error) {
      throw await this.reconcileOperationFailure(current, pollAttempt.attemptId, error, context);
    }
  }

  private async runCompanyProfile(
    input: NonNullable<Awaited<ReturnType<ProviderResearchStore["getResearchInput"]>>>,
    maximumAttempts: number,
    context: ProviderStepContext
  ) {
    const evidence = await this.researchStore.getWebsiteEvidence(input.workflowId);
    if (!evidence?.pages.length) {
      throw new ProviderResearchError(
        "configuration_error",
        "website_evidence_missing",
        "Stored website evidence is required before company analysis."
      );
    }
    const requestFingerprint = sha256(stableJson({
      requestFingerprint: input.requestFingerprint,
      operation: "company_profile_extraction",
      evidence: evidence.pages.map((page) => [page.pageIndex, page.contentHash])
    }));
    let operation = await this.ensureReservedOperation({
      workflowId: input.workflowId,
      operationKind: "company_profile_extraction",
      provider: this.providers.analysis.provider,
      requestFingerprint,
      estimatedCostCents: this.providers.costPolicy.profileReservationCents,
      maximumAttempts
    });
    if (operation.state === "succeeded") {
      return `provider-operation:${operation.id}`;
    }
    assertOperationCanRun(operation);
    const attempt = await this.researchStore.beginOperationAttempt(operation.id, "submit", this.now().toISOString());
    try {
      const result = await this.providers.analysis.extractCompanyProfile({
        normalizedUrl: input.normalizedUrl,
        domain: input.domain,
        pages: evidence.pages
      });
      const actualCostCents = assertCostWithinReservation(
        this.providers.costPolicy.actualModelCost(result.usage),
        operation.estimatedCostCents
      );
      const researchFreshAt = latestTimestamp(evidence.pages.map((page) => page.crawledAt));
      const completedAt = this.now().toISOString();
      let persisted: Awaited<ReturnType<ProviderResearchStore["persistCompanyProfile"]>>;
      try {
        persisted = await this.researchStore.persistCompanyProfile({
          operationId: operation.id,
          attemptId: attempt.attemptId,
          result,
          inputHash: requestFingerprint,
          outputHash: sha256(stableJson(result.output)),
          reservedCostCents: operation.estimatedCostCents,
          actualCostCents,
          researchFreshAt,
          freshUntil: addHours(researchFreshAt, this.providers.evidenceTtlHours),
          now: completedAt
        });
      } catch (error) {
        throw persistenceOutcomeUnknown(error);
      }
      operation = {
        ...operation,
        state: "succeeded",
        actualCostCents,
        providerUsage: { ...result.usage },
        providerCompletedAt: completedAt,
        updatedAt: completedAt
      };
      return `company-profile:${persisted.profileVersionId}`;
    } catch (error) {
      throw await this.reconcileOperationFailure(operation, attempt.attemptId, error, context);
    }
  }

  private async runSearchQueryDiscovery(
    input: NonNullable<Awaited<ReturnType<ProviderResearchStore["getResearchInput"]>>>,
    maximumAttempts: number,
    context: ProviderStepContext
  ) {
    const profile = await this.researchStore.getLatestCompanyProfile(input.workflowId);
    if (!profile) {
      throw new ProviderResearchError(
        "configuration_error",
        "company_profile_missing",
        "A stored company profile is required before search-query discovery."
      );
    }
    const requestFingerprint = sha256(stableJson({
      requestFingerprint: input.requestFingerprint,
      operation: "search_query_discovery",
      profileVersionId: profile.profileVersionId,
      queryCount: this.providers.queryCount
    }));
    let operation = await this.ensureReservedOperation({
      workflowId: input.workflowId,
      operationKind: "search_query_discovery",
      provider: this.providers.analysis.provider,
      requestFingerprint,
      estimatedCostCents: this.providers.costPolicy.queryReservationCents,
      maximumAttempts
    });
    if (operation.state === "succeeded") {
      return `provider-operation:${operation.id}`;
    }
    assertOperationCanRun(operation);
    const attempt = await this.researchStore.beginOperationAttempt(operation.id, "submit", this.now().toISOString());
    try {
      const result = await this.providers.analysis.discoverSearchQueries({
        profile,
        queryCount: this.providers.queryCount
      });
      assertQueriesSupportedByProfile(result.output.queries, profile);
      const actualCostCents = assertCostWithinReservation(
        this.providers.costPolicy.actualModelCost(result.usage),
        operation.estimatedCostCents
      );
      const completedAt = this.now().toISOString();
      let persisted: Awaited<ReturnType<ProviderResearchStore["persistSearchQueries"]>>;
      try {
        persisted = await this.researchStore.persistSearchQueries({
          operationId: operation.id,
          attemptId: attempt.attemptId,
          profileVersionId: profile.profileVersionId,
          result,
          inputHash: requestFingerprint,
          outputHash: sha256(stableJson(result.output)),
          reservedCostCents: operation.estimatedCostCents,
          actualCostCents,
          researchFreshAt: profile.researchFreshAt,
          freshUntil: addHours(profile.researchFreshAt, this.providers.evidenceTtlHours),
          now: completedAt
        });
      } catch (error) {
        throw persistenceOutcomeUnknown(error);
      }
      operation = {
        ...operation,
        state: "succeeded",
        actualCostCents,
        providerUsage: { ...result.usage },
        providerCompletedAt: completedAt,
        updatedAt: completedAt
      };
      return `search-query-set:${persisted.querySetId}`;
    } catch (error) {
      throw await this.reconcileOperationFailure(operation, attempt.attemptId, error, context);
    }
  }

  private async ensureReservedOperation(input: {
    workflowId: string;
    operationKind: ProviderOperationKind;
    provider: "firecrawl" | "openai" | "mock";
    requestFingerprint: string;
    estimatedCostCents: number;
    maximumAttempts: number;
  }) {
    const idempotencyKey = `v3-provider:${input.workflowId}:${input.operationKind}:v1`;
    const operation = await this.researchStore.ensureOperation({
      workflowId: input.workflowId,
      stepKey: input.operationKind,
      provider: input.provider,
      operationKind: input.operationKind,
      idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      estimatedCostCents: input.estimatedCostCents,
      maximumAttempts: Math.max(this.maximumAttempts, input.maximumAttempts),
      now: this.now().toISOString()
    });
    if (["succeeded", "outcome_unknown", "cancelled"].includes(operation.state)) return operation;
    return this.researchStore.reserveOperationCost(
      operation.id,
      this.workflowStore,
      this.now().toISOString()
    );
  }

  private async settleSuccessfulOperation(
    workflowId: string,
    stepKey: ProviderResearchWorkflowStepKey,
    context: ProviderStepContext,
    outputReference: string
  ) {
    const operation = await this.researchStore.getOperation(workflowId, stepKey);
    if (!operation || operation.state !== "succeeded" || operation.actualCostCents === null) {
      throw new ProviderResearchError(
        "configuration_error",
        "provider_cost_missing",
        "The stored provider operation has no settled cost."
      );
    }
    try {
      await this.researchStore.settleProviderOperation({
        operationId: operation.id,
        providerAttemptId: null,
        workflowAttemptId: context.workflowAttemptId,
        owner: context.owner,
        fencingToken: context.fencingToken,
        outcome: "succeeded",
        classification: null,
        httpStatus: operation.lastHttpStatus,
        safeCode: null,
        safeSummary: null,
        retryAt: null,
        outputReference,
        now: this.now().toISOString()
      }, this.workflowStore);
    } catch (error) {
      throw settlementStorageFailure(error);
    }
  }

  private async reconcileOperationFailure(
    operation: ProviderOperationRecord,
    attemptId: string,
    error: unknown,
    context: ProviderStepContext
  ) {
    const failure = safeProviderFailure(error);
    const current = await this.researchStore.getOperation(operation.workflowId, operation.operationKind);
    if (current?.state === "succeeded") return failure;
    const retryAt = failure.outcome === "transient_retryable"
      ? new Date(this.now().getTime() + (failure.retryAfterSeconds ?? 10) * 1_000).toISOString()
      : null;
    try {
      await this.researchStore.settleProviderOperation({
        operationId: operation.id,
        providerAttemptId: attemptId,
        workflowAttemptId: context.workflowAttemptId,
        owner: context.owner,
        fencingToken: context.fencingToken,
        outcome: failure.outcome,
        classification: failure.classification,
        httpStatus: failure.httpStatus,
        safeCode: failure.safeCode,
        safeSummary: failure.safeSummary,
        retryAt,
        outputReference: null,
        now: this.now().toISOString()
      }, this.workflowStore);
      return markWorkflowSettled(failure);
    } catch (settlementError) {
      throw settlementStorageFailure(settlementError);
    }
  }

  private async withHeartbeat<T>(
    workflowId: string,
    stepKey: ProviderResearchWorkflowStepKey,
    owner: string,
    fencingToken: number,
    operation: () => Promise<T>
  ) {
    let leaseLost = false;
    const heartbeat = setInterval(async () => {
      try {
        leaseLost = !(await this.workflowStore.heartbeatLease({
          workflowId,
          stepKey,
          owner,
          fencingToken,
          leaseSeconds: this.leaseSeconds,
          now: this.now().toISOString()
        }));
      } catch {
        leaseLost = true;
      }
    }, Math.max(5_000, Math.floor(this.leaseSeconds * 1_000 / 3)));
    heartbeat.unref?.();
    try {
      const result = await operation();
      if (leaseLost) {
        throw new ProviderResearchError(
          "lease_conflict",
          "workflow_lease_lost",
          "The workflow lease changed while research was running."
        );
      }
      return result;
    } finally {
      clearInterval(heartbeat);
    }
  }
}

export class ProviderResearchContinuation {
  constructor(
    private readonly workflowStore: WorkflowStore,
    private readonly reservations: Pick<ProviderResearchProviders["costPolicy"],
      "websiteReservationCents" | "profileReservationCents" | "queryReservationCents">,
    private readonly maximumAttempts: number
  ) {}

  prepare(workflowId: string, now = new Date().toISOString()) {
    return this.workflowStore.prepareProviderResearchContinuation({
      workflowId,
      websiteEstimatedCostCents: this.reservations.websiteReservationCents,
      profileEstimatedCostCents: this.reservations.profileReservationCents,
      queryEstimatedCostCents: this.reservations.queryReservationCents,
      maximumAttempts: this.maximumAttempts,
      now
    });
  }
}

export class ConfigurationFailureProviderResearchRunner {
  constructor(
    private readonly workflowStore: WorkflowStore,
    private readonly failure: ProviderResearchError,
    private readonly leaseSeconds = 120,
    private readonly now: () => Date = () => new Date()
  ) {}

  async runStep(workflowId: string, stepKey: WorkflowStepKey, owner: string) {
    if (!PROVIDER_RESEARCH_WORKFLOW_STEPS.includes(stepKey as ProviderResearchWorkflowStepKey)) {
      throw this.failure;
    }
    const lease = await this.workflowStore.beginStep({
      workflowId,
      stepKey,
      owner,
      leaseSeconds: this.leaseSeconds,
      now: this.now().toISOString()
    });
    if (lease.disposition === "already_succeeded") return "already_succeeded" as const;
    if (lease.disposition !== "acquired" || !lease.lease) return "unavailable" as const;
    await this.workflowStore.failStep({
      workflowId,
      stepKey,
      owner,
      fencingToken: lease.lease.fencingToken,
      classification: "configuration_error",
      safeCode: this.failure.safeCode,
      safeSummary: "Provider research requires administrator configuration.",
      now: this.now().toISOString()
    });
    throw this.failure;
  }
}

function assertOperationCanRun(operation: ProviderOperationRecord) {
  if (operation.state === "outcome_unknown") {
    throw new ProviderResearchError(
      "configuration_error",
      "provider_outcome_unknown",
      "A prior provider outcome requires administrator review.",
      { outcome: "outcome_uncertain" }
    );
  }
  if (operation.state === "failed") {
    throw new ProviderResearchError("permanent", "provider_operation_failed", "The provider operation failed.");
  }
  if (operation.state === "cancelled") {
    throw new ProviderResearchError("cancelled", "provider_operation_cancelled", "The provider operation was cancelled.");
  }
}

function safeProviderFailure(error: unknown) {
  if (error instanceof ProviderResearchError) {
    if (error.outcomeUncertain) {
      return new ProviderResearchError(
        "configuration_error",
        "provider_outcome_unknown",
        "A provider submission outcome requires administrator review.",
        {
          httpStatus: error.httpStatus,
          outcome: "outcome_uncertain",
          workflowSettled: error.workflowSettled,
          cause: error
        }
      );
    }
    return error;
  }
  if (error instanceof TypeError) {
    return new ProviderResearchError(
      "transient",
      "provider_runtime_interrupted",
      "Provider research was interrupted and will resume safely.",
      { retryAfterSeconds: 10, cause: error }
    );
  }
  return new ProviderResearchError(
    "permanent",
    "provider_research_failed",
    "Provider research could not be completed.",
    { cause: error }
  );
}

function persistenceOutcomeUnknown(error: unknown) {
  return new ProviderResearchError(
    "configuration_error",
    "provider_persistence_outcome_unknown",
    "A paid provider result could not be reconciled safely with durable storage.",
    { outcome: "outcome_uncertain", cause: error }
  );
}

function markWorkflowSettled(error: ProviderResearchError) {
  return new ProviderResearchError(
    error.classification,
    error.safeCode,
    error.safeSummary,
    {
      retryAfterSeconds: error.retryAfterSeconds ?? undefined,
      httpStatus: error.httpStatus,
      outcome: error.outcome,
      workflowSettled: true,
      cause: error
    }
  );
}

function settlementStorageFailure(error: unknown) {
  return new ProviderResearchError(
    "transient",
    "provider_settlement_interrupted",
    "Provider settlement was interrupted and will be reconciled safely.",
    {
      retryAfterSeconds: 10,
      outcome: "outcome_uncertain",
      workflowSettled: true,
      cause: error
    }
  );
}

function retryDelaySeconds(attempt: number) {
  return Math.min(300, 2 ** Math.max(1, attempt));
}

function latestTimestamp(values: string[]) {
  return values.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest);
}

function addHours(value: string, hours: number) {
  return new Date(Date.parse(value) + hours * 60 * 60 * 1_000).toISOString();
}
