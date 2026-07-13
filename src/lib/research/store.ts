import type {
  CompanyProfileDraft,
  CompanyProfileReadModel,
  ProviderOperationKind,
  ProviderOperationRecord,
  ProviderUsage,
  SearchQueryDraft,
  StructuredAnalysisResult,
  WebsiteEvidencePage,
  WebsiteResearchPage
} from "@/lib/research/contracts";

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
