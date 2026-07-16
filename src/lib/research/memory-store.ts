import crypto from "node:crypto";
import {
  companyProfileDraftSchema,
  assertQueriesSupportedByProfile,
  normalizeDiscoveredQueries,
  type CompanyProfileReadModel,
  type ContentSelectionResult,
  type ProviderOperationKind,
  type ProviderOperationRecord,
  type SearchQueryDraft,
  type StoredAnalysisResponseArtifact,
  type WebsiteEvidencePage
} from "@/lib/research/contracts";
import { sha256 } from "@/lib/research/integrity";
import type {
  ProviderAttemptLease,
  ProviderResearchInput,
  ProviderResearchStore
} from "@/lib/research/store";
import type { WorkflowStore } from "@/lib/workflow/store";

interface MemoryAttempt {
  id: string;
  operationId: string;
  attemptNumber: number;
  phase: "submit" | "poll" | "persist";
  state: "started" | "succeeded" | "retry_scheduled" | "failed" | "outcome_unknown" | "cancelled";
  retryAt: string | null;
}

interface MemoryPageRecord {
  artifactId: string;
  snapshotId: string;
  operationId: string;
  page: WebsiteEvidencePage;
  rawArtifact: Record<string, unknown>;
}

interface MemoryProfileRecord {
  operationId: string;
  readModel: CompanyProfileReadModel;
  outputHash: string;
  modelInvocationId: string;
  providerRequestId: string;
}

interface MemoryQuerySetRecord {
  operationId: string;
  querySetId: string;
  querySetVersion: number;
  modelInvocationId: string;
  profileVersionId: string;
  providerRequestId: string;
  queries: SearchQueryDraft[];
}

interface MemoryAnalysisResponseRecord {
  artifact: StoredAnalysisResponseArtifact;
}

interface MemoryProcessingDiagnostic {
  artifactId: string;
  phase: StoredAnalysisResponseArtifact["processingPhase"];
  status: "succeeded" | "failed";
  classification: StoredAnalysisResponseArtifact["currentFailureClassification"];
  safeCode: string | null;
  safeSummary: string | null;
  createdAt: string;
}

export class MemoryProviderResearchStore implements ProviderResearchStore {
  private readonly inputs = new Map<string, ProviderResearchInput>();
  private readonly operations = new Map<string, ProviderOperationRecord>();
  private readonly operationByKey = new Map<string, string>();
  private readonly attempts: MemoryAttempt[] = [];
  private readonly pages: MemoryPageRecord[] = [];
  private readonly profiles: MemoryProfileRecord[] = [];
  private readonly querySets: MemoryQuerySetRecord[] = [];
  private readonly contentSelections = new Map<string, ContentSelectionResult>();
  private readonly analysisResponses = new Map<string, MemoryAnalysisResponseRecord>();
  private readonly processingDiagnostics: MemoryProcessingDiagnostic[] = [];

  constructor(inputs: ProviderResearchInput[] = []) {
    for (const input of inputs) this.inputs.set(input.workflowId, structuredClone(input));
  }

  seedInput(input: ProviderResearchInput) {
    this.inputs.set(input.workflowId, structuredClone(input));
  }

  async getResearchInput(workflowId: string) {
    return this.inputs.get(workflowId) ?? null;
  }

  async ensureOperation(input: Parameters<ProviderResearchStore["ensureOperation"]>[0]) {
    const existingId = this.operationByKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.operations.get(existingId)!;
      if (existing.workflowId !== input.workflowId || existing.operationKind !== input.operationKind ||
        existing.requestFingerprint !== input.requestFingerprint) {
        throw new Error("Provider operation idempotency conflict.");
      }
      return existing;
    }
    const researchInput = this.inputs.get(input.workflowId);
    if (!researchInput || researchInput.legacyPublicId) throw new Error("Provider research input is unavailable.");
    const now = input.now ?? new Date().toISOString();
    const operation: ProviderOperationRecord = {
      id: crypto.randomUUID(),
      workflowId: input.workflowId,
      stepId: `memory-step:${input.stepKey}`,
      provider: input.provider,
      operationKind: input.operationKind,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      state: "reserved",
      providerJobId: null,
      attemptCount: 0,
      maximumAttempts: input.maximumAttempts,
      nextRetryAt: null,
      estimatedCostCents: input.estimatedCostCents,
      reservedCostCents: 0,
      actualCostCents: null,
      outcome: null,
      reconciliationRequired: false,
      reservationGeneration: 1,
      settledAt: null,
      providerUsage: {},
      lastHttpStatus: null,
      lastSafeErrorCode: null,
      lastSafeErrorSummary: null,
      providerStartedAt: null,
      providerCompletedAt: null,
      providerResponseStatus: null,
      providerResponseReceivedAt: null,
      processingStatus: "pending",
      processingPhase: null,
      createdAt: now,
      updatedAt: now
    };
    this.operations.set(operation.id, operation);
    this.operationByKey.set(operation.idempotencyKey, operation.id);
    return operation;
  }

  async getOperation(workflowId: string, operationKind: ProviderOperationKind) {
    return [...this.operations.values()].reverse().find(
      (operation) => operation.workflowId === workflowId && operation.operationKind === operationKind
    ) ?? null;
  }

  async reserveOperationCost(
    operationId: string,
    workflowStore: WorkflowStore,
    now = new Date().toISOString()
  ) {
    const operation = this.requireOperation(operationId);
    if (operation.reconciliationRequired || operation.state === "outcome_unknown") {
      throw new Error("Provider operation requires reconciliation.");
    }
    const detail = await workflowStore.getWorkflowDetail(operation.workflowId);
    const step = detail?.steps.find((candidate) => candidate.stepKey === operation.operationKind);
    if (
      ((operation.state === "failed" && operation.outcome === "definitively_rejected") ||
        (operation.state === "cancelled" && operation.outcome === "cancelled")) &&
      step?.status === "running"
    ) {
      operation.state = "reserved";
      operation.outcome = null;
      operation.actualCostCents = null;
      operation.providerJobId = null;
      operation.nextRetryAt = null;
      operation.lastHttpStatus = null;
      operation.lastSafeErrorCode = null;
      operation.lastSafeErrorSummary = null;
      operation.providerUsage = {};
      operation.settledAt = null;
      operation.reservationGeneration += 1;
    }
    if (operation.state === "succeeded" || operation.outcome === "succeeded" || operation.reservedCostCents > 0) {
      return operation;
    }
    if (operation.estimatedCostCents > 0) {
      await workflowStore.reserveCost({
        workflowId: operation.workflowId,
        stepId: operation.stepId,
        amountCents: operation.estimatedCostCents,
        idempotencyKey: `${operation.idempotencyKey}:reservation:${operation.reservationGeneration}`,
        now
      });
      operation.reservedCostCents = operation.estimatedCostCents;
    }
    operation.updatedAt = now;
    return operation;
  }

  async settleProviderOperation(
    input: Parameters<ProviderResearchStore["settleProviderOperation"]>[0],
    workflowStore: WorkflowStore
  ) {
    const operation = this.requireOperation(input.operationId);
    const now = input.now ?? new Date().toISOString();
    if (input.outcome === "succeeded") {
      if (operation.state !== "succeeded" || operation.actualCostCents === null) {
        throw new Error("Only a successful provider operation can be settled as successful.");
      }
      if (operation.reservedCostCents > 0) {
        await workflowStore.recordActualCost({
          workflowId: operation.workflowId,
          stepId: operation.stepId,
          attemptId: input.workflowAttemptId,
          reservedCents: operation.reservedCostCents,
          actualCents: operation.actualCostCents,
          idempotencyKey: `${operation.idempotencyKey}:settlement:${operation.reservationGeneration}:actual`,
          now
        });
      }
      operation.reservedCostCents = 0;
      operation.outcome = "succeeded";
      operation.reconciliationRequired = false;
      operation.nextRetryAt = null;
      operation.lastSafeErrorCode = null;
      operation.lastSafeErrorSummary = null;
      operation.settledAt ??= now;
      operation.updatedAt = now;
      const completed = await workflowStore.completeStep({
        workflowId: operation.workflowId,
        stepKey: operation.operationKind,
        owner: input.owner,
        fencingToken: input.fencingToken,
        outputReference: input.outputReference ?? `provider-operation:${operation.id}`,
        now
      });
      if (!completed) throw new Error("Provider workflow settlement lost its lease.");
      return operation;
    }

    const attemptState = input.outcome === "transient_retryable"
      ? "retry_scheduled"
      : input.outcome === "outcome_uncertain"
        ? "outcome_unknown"
        : input.outcome === "cancelled"
          ? "cancelled"
          : "failed";
    if (input.providerAttemptId) {
      this.finishAttemptIdempotently(input.providerAttemptId, operation.id, attemptState);
    }

    operation.lastHttpStatus = input.httpStatus;
    operation.lastSafeErrorCode = input.safeCode;
    operation.lastSafeErrorSummary = input.safeSummary;
    operation.outcome = input.outcome;
    operation.updatedAt = now;

    if (input.outcome === "transient_retryable") {
      operation.state = operation.providerJobId ? "submitted" : "retry_scheduled";
      operation.nextRetryAt = input.retryAt;
      await workflowStore.failStep({
        workflowId: operation.workflowId,
        stepKey: operation.operationKind,
        owner: input.owner,
        fencingToken: input.fencingToken,
        classification: "transient",
        safeCode: input.safeCode ?? "provider_temporarily_unavailable",
        safeSummary: input.safeSummary ?? "Provider research is temporarily delayed.",
        retryAt: input.retryAt ?? undefined,
        now
      });
      return operation;
    }

    operation.nextRetryAt = null;
    operation.reconciliationRequired = input.outcome === "outcome_uncertain";
    operation.state = input.outcome === "outcome_uncertain"
      ? "outcome_unknown"
      : input.outcome === "cancelled"
        ? "cancelled"
        : "failed";
    if (input.outcome !== "outcome_uncertain" && operation.reservedCostCents > 0) {
      await workflowStore.releaseCost({
        workflowId: operation.workflowId,
        stepId: operation.stepId,
        amountCents: operation.reservedCostCents,
        idempotencyKey: `${operation.idempotencyKey}:settlement:${operation.reservationGeneration}:release`,
        now
      });
      operation.reservedCostCents = 0;
    }
    operation.settledAt = input.outcome === "outcome_uncertain" ? null : now;
    await workflowStore.failStep({
      workflowId: operation.workflowId,
      stepKey: operation.operationKind,
      owner: input.owner,
      fencingToken: input.fencingToken,
      classification: input.outcome === "outcome_uncertain"
        ? "configuration_error"
        : input.outcome === "cancelled"
          ? "cancelled"
          : input.classification ?? "permanent",
      safeCode: input.outcome === "outcome_uncertain"
        ? "provider_outcome_unknown"
        : input.safeCode ?? "provider_operation_failed",
      safeSummary: input.outcome === "outcome_uncertain"
        ? "A provider outcome requires administrator reconciliation."
        : input.safeSummary ?? "Provider research could not continue.",
      now
    });
    return operation;
  }

  async blockProviderConfiguration(
    input: Parameters<ProviderResearchStore["blockProviderConfiguration"]>[0],
    workflowStore: WorkflowStore
  ) {
    await workflowStore.failStep({
      workflowId: input.workflowId,
      stepKey: input.stepKey,
      owner: input.owner,
      fencingToken: input.fencingToken,
      classification: "configuration_error",
      safeCode: input.safeCode,
      safeSummary: input.safeSummary,
      now: input.now
    });
  }

  async reconcileUncertainOperation(
    input: Parameters<ProviderResearchStore["reconcileUncertainOperation"]>[0],
    workflowStore?: WorkflowStore
  ) {
    const operation = this.requireOperation(input.operationId);
    const now = input.now ?? new Date().toISOString();
    if (!operation.reconciliationRequired) return operation;
    if (!workflowStore) throw new Error("Workflow storage is required for reconciliation.");
    if (input.resolution === "accepted_retryable") {
      if (!operation.providerJobId) throw new Error("An accepted provider job identifier is required.");
      operation.state = "submitted";
      operation.outcome = "transient_retryable";
      operation.reconciliationRequired = false;
      operation.nextRetryAt = now;
      await workflowStore.retryStep(
        operation.workflowId,
        operation.operationKind,
        { actorId: input.actorId, authenticated: true },
        now
      );
    } else if (input.resolution === "paid_cancelled") {
      const actual = input.actualCostCents ?? operation.reservedCostCents;
      if (actual < 0 || actual > operation.reservedCostCents) throw new Error("Invalid reconciled provider cost.");
      if (operation.reservedCostCents > 0) {
        await workflowStore.recordActualCost({
          workflowId: operation.workflowId,
          stepId: operation.stepId,
          attemptId: null,
          reservedCents: operation.reservedCostCents,
          actualCents: actual,
          idempotencyKey: `${operation.idempotencyKey}:reconciliation:${operation.reservationGeneration}:actual`,
          now
        });
      }
      operation.actualCostCents = actual;
      operation.reservedCostCents = 0;
      operation.state = "cancelled";
      operation.outcome = "cancelled";
      operation.reconciliationRequired = false;
      operation.settledAt = now;
    } else {
      if (operation.reservedCostCents > 0) {
        await workflowStore.releaseCost({
          workflowId: operation.workflowId,
          stepId: operation.stepId,
          amountCents: operation.reservedCostCents,
          idempotencyKey: `${operation.idempotencyKey}:reconciliation:${operation.reservationGeneration}:release`,
          now
        });
      }
      operation.reservedCostCents = 0;
      operation.state = "failed";
      operation.outcome = "definitively_rejected";
      operation.reconciliationRequired = false;
      operation.settledAt = now;
    }
    operation.updatedAt = now;
    return operation;
  }

  async beginOperationAttempt(operationId: string, phase: "submit" | "poll" | "persist", now = new Date().toISOString()): Promise<ProviderAttemptLease> {
    const operation = this.requireOperation(operationId);
    if (["succeeded", "failed", "outcome_unknown", "cancelled"].includes(operation.state)) {
      throw new Error("Provider operation is terminal.");
    }
    if (operation.attemptCount >= operation.maximumAttempts) throw new Error("Provider attempts exhausted.");
    if (phase === "submit" && operation.state === "submitting") {
      operation.state = "outcome_unknown";
      throw new Error("Provider submission outcome is unknown.");
    }
    if (phase === "submit" && operation.providerJobId) throw new Error("Provider job already exists.");
    if (phase === "poll" && !operation.providerJobId) throw new Error("Provider job is missing.");
    if (phase === "poll") {
      for (const attempt of this.attempts) {
        if (attempt.operationId === operationId && attempt.phase === "poll" && attempt.state === "started") {
          attempt.state = "retry_scheduled";
          attempt.retryAt = now;
        }
      }
    }
    operation.attemptCount += 1;
    operation.state = phase === "submit" ? "submitting" : "polling";
    operation.providerStartedAt ??= now;
    operation.nextRetryAt = null;
    operation.updatedAt = now;
    const attempt: MemoryAttempt = {
      id: crypto.randomUUID(),
      operationId,
      attemptNumber: operation.attemptCount,
      phase,
      state: "started",
      retryAt: null
    };
    this.attempts.push(attempt);
    return { operation, attemptId: attempt.id, attemptNumber: attempt.attemptNumber };
  }

  async recordProviderJob(input: Parameters<ProviderResearchStore["recordProviderJob"]>[0]) {
    const operation = this.requireOperation(input.operationId);
    this.finishAttempt(input.attemptId, input.operationId, "succeeded");
    operation.state = "submitted";
    operation.providerJobId = input.providerJobId;
    operation.lastHttpStatus = input.httpStatus;
    operation.providerUsage = structuredClone(input.providerUsage);
    operation.providerStartedAt ??= input.providerCreatedAt;
    operation.updatedAt = input.now ?? new Date().toISOString();
    return operation;
  }

  async scheduleOperationRetry(input: Parameters<ProviderResearchStore["scheduleOperationRetry"]>[0]) {
    const operation = this.requireOperation(input.operationId);
    const attempt = this.finishAttempt(input.attemptId, input.operationId, "retry_scheduled");
    attempt.retryAt = input.retryAt;
    operation.state = operation.providerJobId ? "submitted" : "retry_scheduled";
    operation.nextRetryAt = input.retryAt;
    operation.lastHttpStatus = input.httpStatus;
    operation.lastSafeErrorCode = input.safeCode;
    operation.lastSafeErrorSummary = input.safeSummary;
    operation.updatedAt = input.now ?? new Date().toISOString();
    return operation;
  }

  async failOperation(input: Parameters<ProviderResearchStore["failOperation"]>[0]) {
    const operation = this.requireOperation(input.operationId);
    if (input.attemptId) this.finishAttempt(input.attemptId, input.operationId, input.state);
    operation.state = input.state;
    operation.lastHttpStatus = input.httpStatus;
    operation.lastSafeErrorCode = input.safeCode;
    operation.lastSafeErrorSummary = input.safeSummary;
    operation.updatedAt = input.now ?? new Date().toISOString();
    return operation;
  }

  async storeWebsitePage(operationId: string, page: Parameters<ProviderResearchStore["storeWebsitePage"]>[1]) {
    const operation = this.requireOperation(operationId);
    if (operation.operationKind !== "website_research") throw new Error("Website operation required.");
    if (sha256(page.markdown) !== page.contentHash) throw new Error("Research content hash mismatch.");
    const existing = this.pages.find((record) => record.operationId === operationId && record.page.pageIndex === page.pageIndex);
    if (existing) {
      if (existing.page.contentHash !== page.contentHash) throw new Error("Snapshot idempotency conflict.");
      return {
        artifactId: existing.artifactId,
        snapshotId: existing.snapshotId,
        contentHash: existing.page.contentHash,
        byteSize: Buffer.byteLength(existing.page.markdown)
      };
    }
    const record: MemoryPageRecord = {
      artifactId: crypto.randomUUID(),
      snapshotId: crypto.randomUUID(),
      operationId,
      rawArtifact: structuredClone(page.rawArtifact),
      page: {
        snapshotId: "",
        pageIndex: page.pageIndex,
        sourceUrl: page.sourceUrl,
        canonicalUrl: page.canonicalUrl,
        title: page.title,
        description: page.description,
        markdown: page.markdown,
        contentHash: page.contentHash,
        crawledAt: page.crawledAt,
        providerCreatedAt: page.providerCreatedAt,
        freshUntil: page.freshUntil
      }
    };
    record.page.snapshotId = record.snapshotId;
    this.pages.push(record);
    return {
      artifactId: record.artifactId,
      snapshotId: record.snapshotId,
      contentHash: page.contentHash,
      byteSize: Buffer.byteLength(page.markdown)
    };
  }

  async completeWebsiteOperation(input: Parameters<ProviderResearchStore["completeWebsiteOperation"]>[0]) {
    const operation = this.requireOperation(input.operationId);
    if (!this.pages.some((page) => page.operationId === operation.id)) throw new Error("Website research has no pages.");
    this.finishAttempt(input.attemptId, operation.id, "succeeded");
    operation.state = "succeeded";
    operation.processingStatus = "succeeded";
    operation.processingPhase = "complete";
    operation.actualCostCents = input.actualCostCents;
    operation.providerUsage = structuredClone(input.providerUsage);
    operation.lastHttpStatus = input.httpStatus;
    operation.providerCompletedAt = input.providerCompletedAt;
    operation.nextRetryAt = null;
    operation.updatedAt = input.now ?? new Date().toISOString();
    return operation;
  }

  async getWebsiteEvidence(workflowId: string) {
    const operation = await this.getOperation(workflowId, "website_research");
    if (!operation || operation.state !== "succeeded") return null;
    return {
      operationId: operation.id,
      pages: this.pages.filter((page) => page.operationId === operation.id)
        .sort((left, right) => left.page.pageIndex - right.page.pageIndex)
        .map((page) => structuredClone(page.page))
    };
  }

  async persistContentSelection(input: Parameters<ProviderResearchStore["persistContentSelection"]>[0]) {
    const existing = this.contentSelections.get(input.operationId);
    if (existing) {
      if (existing.inputHash !== input.selection.inputHash) {
        throw new Error("Content-selection idempotency conflict.");
      }
      return { selectionRunId: `memory-selection:${input.operationId}` };
    }
    this.requireOperation(input.operationId);
    this.contentSelections.set(input.operationId, structuredClone(input.selection));
    return { selectionRunId: `memory-selection:${input.operationId}` };
  }

  async getContentSelection(operationId: string) {
    const selection = this.contentSelections.get(operationId);
    return selection ? structuredClone(selection) : null;
  }

  async getAnalysisResponse(operationId: string) {
    const record = this.analysisResponses.get(operationId);
    return record ? structuredClone(record.artifact) : null;
  }

  async captureAnalysisResponse(
    input: Parameters<ProviderResearchStore["captureAnalysisResponse"]>[0],
    workflowStore: WorkflowStore
  ) {
    const operation = this.requireOperation(input.operationId);
    const existing = this.analysisResponses.get(operation.id);
    if (existing) {
      if (existing.artifact.providerResponseId !== input.response.providerResponseId) {
        throw new Error("Analysis-response idempotency conflict.");
      }
      return structuredClone(existing.artifact);
    }
    if (operation.operationKind === "website_research") throw new Error("Analysis operation required.");
    if (input.actualCostCents > operation.reservedCostCents && input.actualCostCents !== 0) {
      throw new Error("Provider cost exceeded reservation.");
    }
    const now = input.now ?? new Date().toISOString();
    if (operation.reservedCostCents > 0) {
      await workflowStore.recordActualCost({
        workflowId: operation.workflowId,
        stepId: operation.stepId,
        attemptId: null,
        reservedCents: operation.reservedCostCents,
        actualCents: input.actualCostCents,
        idempotencyKey: `${operation.idempotencyKey}:provider-response:${operation.reservationGeneration}:actual`,
        now
      });
    }
    operation.state = "submitting";
    operation.providerJobId = input.response.providerResponseId;
    operation.reservedCostCents = 0;
    operation.actualCostCents = input.actualCostCents;
    operation.outcome = "succeeded";
    operation.reconciliationRequired = false;
    operation.providerUsage = structuredClone(input.response.usage);
    operation.providerCompletedAt = input.response.responseReceivedAt;
    operation.providerResponseStatus = input.response.responseStatus;
    operation.providerResponseReceivedAt = input.response.responseReceivedAt;
    operation.processingStatus = "pending";
    operation.processingPhase = "response_capture";
    operation.settledAt = now;
    operation.updatedAt = now;
    const artifact: StoredAnalysisResponseArtifact = {
      id: crypto.randomUUID(),
      operationId: operation.id,
      providerAttemptId: input.attemptId,
      ...structuredClone(input.response),
      actualCostCents: input.actualCostCents,
      parseStatus: "pending",
      parseAttempts: 0,
      persistenceStatus: "pending",
      persistenceAttempts: 0,
      processingPhase: "response_capture",
      firstFailureClassification: null,
      firstSafeCode: null,
      firstSafeSummary: null,
      currentFailureClassification: null,
      currentSafeCode: null,
      currentSafeSummary: null,
      reconciliationStatus: input.response.artifactComplete ? "not_required" : "retrieval_required",
      retrievalAttempts: 0,
      parsedAt: null,
      persistedAt: null
    };
    this.analysisResponses.set(operation.id, { artifact });
    return structuredClone(artifact);
  }

  async recordAnalysisResponseRetrieval(
    input: Parameters<ProviderResearchStore["recordAnalysisResponseRetrieval"]>[0]
  ) {
    const record = this.requireAnalysisArtifact(input.artifactId);
    if (record.artifact.providerResponseId !== input.response.providerResponseId) {
      throw new Error("Retrieved response identifier mismatch.");
    }
    const response = structuredClone(input.response);
    Object.assign(record.artifact, response, {
      id: record.artifact.id,
      operationId: record.artifact.operationId,
      providerAttemptId: record.artifact.providerAttemptId,
      actualCostCents: record.artifact.actualCostCents,
      retrievalAttempts: record.artifact.retrievalAttempts + 1,
      reconciliationStatus: response.artifactComplete ? "recovered" : "retrieval_required",
      processingPhase: "retrieval"
    });
    return structuredClone(record.artifact);
  }

  async recordAnalysisProcessingResult(
    input: Parameters<ProviderResearchStore["recordAnalysisProcessingResult"]>[0]
  ) {
    const record = this.requireAnalysisArtifact(input.artifactId);
    const artifact = record.artifact;
    const now = input.now ?? new Date().toISOString();
    if (input.phase === "parse" || input.phase === "response_validation" || input.phase === "evidence_validation") {
      artifact.parseAttempts += 1;
      artifact.parseStatus = input.status;
      if (input.status === "succeeded") artifact.parsedAt = now;
    }
    if (input.phase === "persistence" || input.phase === "complete") {
      artifact.persistenceAttempts += 1;
      artifact.persistenceStatus = input.status;
      if (input.status === "succeeded") artifact.persistedAt = now;
    }
    if (input.phase === "retrieval" && input.status === "failed") {
      artifact.retrievalAttempts += 1;
      artifact.reconciliationStatus = "retrieval_failed";
    }
    artifact.processingPhase = input.phase;
    if (input.status === "failed") {
      artifact.firstFailureClassification ??= input.classification ?? null;
      artifact.firstSafeCode ??= input.safeCode ?? null;
      artifact.firstSafeSummary ??= input.safeSummary ?? null;
      artifact.currentFailureClassification = input.classification ?? null;
      artifact.currentSafeCode = input.safeCode ?? null;
      artifact.currentSafeSummary = input.safeSummary ?? null;
      this.requireOperation(artifact.operationId).processingStatus = "failed";
    } else {
      artifact.currentFailureClassification = null;
      artifact.currentSafeCode = null;
      artifact.currentSafeSummary = null;
      this.requireOperation(artifact.operationId).processingStatus = input.phase === "complete"
        ? "succeeded"
        : "processing";
    }
    this.requireOperation(artifact.operationId).processingPhase = input.phase;
    this.processingDiagnostics.push({
      artifactId: artifact.id,
      phase: input.phase,
      status: input.status,
      classification: input.classification ?? null,
      safeCode: input.safeCode ?? null,
      safeSummary: input.safeSummary ?? null,
      createdAt: now
    });
    return structuredClone(artifact);
  }

  async persistCompanyProfile(input: Parameters<ProviderResearchStore["persistCompanyProfile"]>[0]) {
    const operation = this.requireOperation(input.operationId);
    const existing = this.profiles.find((profile) => profile.operationId === operation.id);
    if (existing) {
      return {
        profileVersionId: existing.readModel.profileVersionId,
        profileVersion: existing.readModel.profileVersion,
        modelInvocationId: existing.modelInvocationId
      };
    }
    const output = companyProfileDraftSchema.parse(input.result.output);
    const evidence = await this.getWebsiteEvidence(operation.workflowId);
    const pagesByIndex = new Map(evidence?.pages.map((page) => [page.pageIndex, page]));
    for (const pointer of [
      ...output.claims.flatMap((claim) => claim.evidence),
      ...output.entities.flatMap((entity) => entity.evidence)
    ]) {
      const page = pagesByIndex.get(pointer.pageIndex);
      if (!page || !page.markdown.includes(pointer.excerpt)) {
        throw new Error("Profile evidence snapshot missing.");
      }
    }
    const profileVersion = this.profiles.filter((profile) =>
      this.requireOperation(profile.operationId).workflowId === operation.workflowId
    ).length + 1;
    const profileVersionId = crypto.randomUUID();
    const modelInvocationId = crypto.randomUUID();
    const readModel: CompanyProfileReadModel = {
      profileVersionId,
      profileVersion,
      companyName: output.companyName,
      brandName: output.brandName,
      website: output.website,
      industry: output.industry,
      subindustry: output.subindustry,
      businessModel: output.businessModel,
      summary: output.summary,
      researchFreshAt: input.researchFreshAt,
      freshUntil: input.freshUntil,
      claims: output.claims.map((claim) => ({
        id: crypto.randomUUID(),
        fieldKey: claim.fieldKey,
        status: claim.status,
        confidence: claim.confidence,
        value: claim.value,
        normalizedValue: claim.normalizedValue
      })),
      entities: dedupeEntities(output.entities).map((entity) => ({
        id: crypto.randomUUID(),
        type: entity.type,
        name: entity.name,
        normalizedName: normalizeEntity(entity.name),
        role: entity.role,
        url: entity.url,
        status: entity.status,
        confidence: entity.confidence
      }))
    };
    this.profiles.push({
      operationId: operation.id,
      readModel,
      outputHash: input.outputHash,
      modelInvocationId,
      providerRequestId: input.result.providerRequestId
    });
    this.finishAttemptIdempotently(input.attemptId, operation.id, "succeeded");
    operation.state = "succeeded";
    operation.processingStatus = "succeeded";
    operation.processingPhase = "complete";
    operation.actualCostCents = input.actualCostCents;
    operation.providerUsage = structuredClone(input.result.usage);
    operation.providerCompletedAt = input.now ?? new Date().toISOString();
    return { profileVersionId, profileVersion, modelInvocationId };
  }

  async getLatestCompanyProfile(workflowId: string) {
    const profiles = this.profiles.filter((profile) =>
      this.requireOperation(profile.operationId).workflowId === workflowId
    );
    return profiles.at(-1)?.readModel ?? null;
  }

  async persistSearchQueries(input: Parameters<ProviderResearchStore["persistSearchQueries"]>[0]) {
    const operation = this.requireOperation(input.operationId);
    const existing = this.querySets.find((querySet) => querySet.operationId === operation.id);
    if (existing) return {
      querySetId: existing.querySetId,
      querySetVersion: existing.querySetVersion,
      modelInvocationId: existing.modelInvocationId,
      queryCount: existing.queries.length
    };
    const profile = await this.getLatestCompanyProfile(operation.workflowId);
    if (!profile || profile.profileVersionId !== input.profileVersionId) throw new Error("Profile version mismatch.");
    const hasVerifiedGeography = profile.claims.some((claim) =>
      (claim.fieldKey === "geographic_location" || claim.fieldKey === "geographic_service_area") &&
      claim.status === "measured" && Boolean(claim.value)
    );
    const queries = normalizeDiscoveredQueries(input.result.output, {
      maximum: 30,
      hasVerifiedGeography
    });
    assertQueriesSupportedByProfile(queries, profile);
    const querySet: MemoryQuerySetRecord = {
      operationId: operation.id,
      querySetId: crypto.randomUUID(),
      querySetVersion: this.querySets.filter((item) =>
        this.requireOperation(item.operationId).workflowId === operation.workflowId
      ).length + 1,
      modelInvocationId: crypto.randomUUID(),
      profileVersionId: profile.profileVersionId,
      providerRequestId: input.result.providerRequestId,
      queries
    };
    this.querySets.push(querySet);
    this.finishAttemptIdempotently(input.attemptId, operation.id, "succeeded");
    operation.state = "succeeded";
    operation.processingStatus = "succeeded";
    operation.processingPhase = "complete";
    operation.actualCostCents = input.actualCostCents;
    operation.providerUsage = structuredClone(input.result.usage);
    operation.providerCompletedAt = input.now ?? new Date().toISOString();
    return {
      querySetId: querySet.querySetId,
      querySetVersion: querySet.querySetVersion,
      modelInvocationId: querySet.modelInvocationId,
      queryCount: queries.length
    };
  }

  snapshot() {
    return structuredClone({
      operations: [...this.operations.values()],
      attempts: this.attempts,
      pages: this.pages,
      profiles: this.profiles,
      querySets: this.querySets,
      contentSelections: [...this.contentSelections.entries()],
      analysisResponses: [...this.analysisResponses.values()],
      processingDiagnostics: this.processingDiagnostics
    });
  }

  private requireOperation(operationId: string) {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error("Provider operation not found.");
    return operation;
  }

  private requireAnalysisArtifact(artifactId: string) {
    const record = [...this.analysisResponses.values()].find((item) => item.artifact.id === artifactId);
    if (!record) throw new Error("Analysis response artifact not found.");
    return record;
  }

  private finishAttempt(attemptId: string, operationId: string, state: MemoryAttempt["state"]) {
    const attempt = this.attempts.find((item) => item.id === attemptId && item.operationId === operationId);
    if (!attempt || attempt.state !== "started") throw new Error("Provider attempt fenced.");
    attempt.state = state;
    return attempt;
  }

  private finishAttemptIdempotently(
    attemptId: string,
    operationId: string,
    state: MemoryAttempt["state"]
  ) {
    const attempt = this.attempts.find((item) => item.id === attemptId && item.operationId === operationId);
    if (!attempt) throw new Error("Provider attempt fenced.");
    if (attempt.state === state) return attempt;
    if (attempt.state !== "started") throw new Error("Provider attempt fenced.");
    attempt.state = state;
    return attempt;
  }
}

function normalizeEntity(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function dedupeEntities<T extends { type: string; name: string }>(entities: T[]) {
  const deduped = new Map<string, T>();
  for (const entity of entities) {
    const key = `${entity.type}:${normalizeEntity(entity.name)}`;
    if (!deduped.has(key)) deduped.set(key, entity);
  }
  return [...deduped.values()];
}
