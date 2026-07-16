import type {
  CompanyProfileDraft,
  CompanyProfileReadModel,
  AnalysisProcessingPhase,
  AnalysisResponseArtifactDraft,
  ContentSelectionResult,
  ProviderOperationKind,
  ProviderOperationRecord,
  ProviderOutcome,
  ProviderUsage,
  SearchQueryDraft,
  StructuredAnalysisResult,
  StoredAnalysisResponseArtifact,
  WebsiteEvidencePage,
  WebsiteResearchPage
} from "@/lib/research/contracts";
import type { ProviderResearchWorkflowStepKey, FailureClassification } from "@/lib/workflow/schema";
import type { WorkflowStore } from "@/lib/workflow/store";

export interface ProviderResearchInput {
  workflowId: string;
  reportRequestId: string;
  reportId: string;
  companyId: string;
  normalizedUrl: string;
  domain: string;
  requestFingerprint: string;
  legacyPublicId: string | null;
}

export interface ProviderAttemptLease {
  operation: ProviderOperationRecord;
  attemptId: string;
  attemptNumber: number;
}

export interface ProviderOperationSettlementInput {
  operationId: string;
  providerAttemptId: string | null;
  workflowAttemptId: string;
  owner: string;
  fencingToken: number;
  outcome: ProviderOutcome;
  classification: FailureClassification | null;
  httpStatus: number | null;
  safeCode: string | null;
  safeSummary: string | null;
  retryAt: string | null;
  outputReference: string | null;
  now?: string;
}

export interface ProviderConfigurationBlockInput {
  workflowId: string;
  stepKey: ProviderResearchWorkflowStepKey;
  workflowAttemptId: string;
  owner: string;
  fencingToken: number;
  safeCode: string;
  safeSummary: string;
  now?: string;
}

export interface ProviderResearchStore {
  getResearchInput(workflowId: string): Promise<ProviderResearchInput | null>;
  ensureOperation(input: {
    workflowId: string;
    stepKey: ProviderOperationKind;
    provider: "firecrawl" | "openai" | "mock";
    operationKind: ProviderOperationKind;
    idempotencyKey: string;
    requestFingerprint: string;
    estimatedCostCents: number;
    maximumAttempts: number;
    now?: string;
  }): Promise<ProviderOperationRecord>;
  getOperation(workflowId: string, operationKind: ProviderOperationKind): Promise<ProviderOperationRecord | null>;
  reserveOperationCost(
    operationId: string,
    workflowStore: WorkflowStore,
    now?: string
  ): Promise<ProviderOperationRecord>;
  settleProviderOperation(
    input: ProviderOperationSettlementInput,
    workflowStore: WorkflowStore
  ): Promise<ProviderOperationRecord>;
  blockProviderConfiguration(
    input: ProviderConfigurationBlockInput,
    workflowStore: WorkflowStore
  ): Promise<void>;
  reconcileUncertainOperation(input: {
    operationId: string;
    resolution: "definitively_rejected" | "accepted_retryable" | "paid_cancelled";
    actualCostCents: number | null;
    actorId: string;
    now?: string;
  }, workflowStore?: WorkflowStore): Promise<ProviderOperationRecord>;
  beginOperationAttempt(operationId: string, phase: "submit" | "poll" | "persist", now?: string): Promise<ProviderAttemptLease>;
  recordProviderJob(input: {
    operationId: string;
    attemptId: string;
    providerJobId: string;
    httpStatus: number | null;
    providerUsage: ProviderUsage;
    providerCreatedAt: string | null;
    now?: string;
  }): Promise<ProviderOperationRecord>;
  scheduleOperationRetry(input: {
    operationId: string;
    attemptId: string;
    httpStatus: number | null;
    retryAt: string;
    safeCode: string;
    safeSummary: string;
    now?: string;
  }): Promise<ProviderOperationRecord>;
  failOperation(input: {
    operationId: string;
    attemptId: string | null;
    state: "failed" | "outcome_unknown" | "cancelled";
    httpStatus: number | null;
    safeCode: string;
    safeSummary: string;
    now?: string;
  }): Promise<ProviderOperationRecord>;
  storeWebsitePage(operationId: string, page: WebsiteResearchPage): Promise<{
    artifactId: string;
    snapshotId: string;
    contentHash: string;
    byteSize: number;
  }>;
  completeWebsiteOperation(input: {
    operationId: string;
    attemptId: string;
    httpStatus: number | null;
    providerUsage: ProviderUsage;
    actualCostCents: number;
    providerCompletedAt: string | null;
    now?: string;
  }): Promise<ProviderOperationRecord>;
  getWebsiteEvidence(workflowId: string): Promise<{
    operationId: string;
    pages: WebsiteEvidencePage[];
  } | null>;
  persistContentSelection(input: {
    operationId: string;
    selection: ContentSelectionResult;
    now?: string;
  }): Promise<{ selectionRunId: string }>;
  getContentSelection(operationId: string): Promise<ContentSelectionResult | null>;
  getAnalysisResponse(operationId: string): Promise<StoredAnalysisResponseArtifact | null>;
  captureAnalysisResponse(
    input: {
      operationId: string;
      attemptId: string;
      response: AnalysisResponseArtifactDraft;
      actualCostCents: number;
      now?: string;
    },
    workflowStore: WorkflowStore
  ): Promise<StoredAnalysisResponseArtifact>;
  recordAnalysisResponseRetrieval(input: {
    artifactId: string;
    response: AnalysisResponseArtifactDraft;
    now?: string;
  }): Promise<StoredAnalysisResponseArtifact>;
  recordAnalysisProcessingResult(input: {
    artifactId: string;
    phase: AnalysisProcessingPhase;
    status: "succeeded" | "failed";
    classification?: FailureClassification | null;
    safeCode?: string | null;
    safeSummary?: string | null;
    now?: string;
  }): Promise<StoredAnalysisResponseArtifact>;
  persistCompanyProfile(input: {
    operationId: string;
    attemptId: string;
    result: StructuredAnalysisResult<CompanyProfileDraft>;
    inputHash: string;
    outputHash: string;
    reservedCostCents: number;
    actualCostCents: number;
    researchFreshAt: string;
    freshUntil: string;
    now?: string;
  }): Promise<{ profileVersionId: string; profileVersion: number; modelInvocationId: string }>;
  getLatestCompanyProfile(workflowId: string): Promise<CompanyProfileReadModel | null>;
  persistSearchQueries(input: {
    operationId: string;
    attemptId: string;
    profileVersionId: string;
    result: StructuredAnalysisResult<{ queries: SearchQueryDraft[] }>;
    inputHash: string;
    outputHash: string;
    reservedCostCents: number;
    actualCostCents: number;
    researchFreshAt: string;
    freshUntil: string;
    now?: string;
  }): Promise<{ querySetId: string; querySetVersion: number; modelInvocationId: string; queryCount: number }>;
}
