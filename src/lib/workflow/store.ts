import type {
  CostBudgetRecord,
  CostEntryRecord,
  FailureClassification,
  OutboxEventRecord,
  SafeWorkflowProgress,
  WorkflowDetail,
  WorkflowQueuePayload,
  WorkflowLeaseRecord,
  WorkflowRecord,
  WorkflowStatus,
  WorkflowStepKey,
  WorkflowStepRecord
} from "@/lib/workflow/schema";

export interface CreateWorkflowInput {
  reportRequestId: string;
  reportId: string;
  inputHash: string;
  correlationId: string;
  priority?: number;
  workflowVersion?: number;
  orchestratorBackend?: "supabase_queue" | "deterministic";
  maximumAttempts?: number;
}

export interface StepLeaseResult {
  disposition: "acquired" | "already_succeeded" | "unavailable";
  workflow: WorkflowRecord;
  step: WorkflowStepRecord;
  lease: WorkflowLeaseRecord | null;
  attemptId: string | null;
}

export interface StepFailureInput {
  workflowId: string;
  stepKey: WorkflowStepKey;
  owner: string;
  fencingToken: number;
  classification: FailureClassification;
  safeCode: string;
  safeSummary: string;
  retryAt?: string;
  now?: string;
}

export interface WorkflowListFilter {
  status?: WorkflowStatus;
  limit?: number;
  stalledBefore?: string;
}

export interface AdminActor {
  actorId: string;
  authenticated: true;
}

export interface RecoveryPreparation {
  accepted: true;
  delivery: null | {
    reportId: string;
    normalizedEmail: string;
    recoveryToken: string;
    expiresAt: string;
  };
}

export interface CleanupResult {
  tokenHashesDeleted: number;
  accessEventsDeleted: number;
  recoveryTokensDeleted: number;
}

export interface LegacyReadiness {
  remainingActiveLegacyLinks: number;
  legacyAccessesLast30Days: number;
  readyForRetirement: boolean;
}

export interface WorkflowStore {
  registerReportIdentity(input: {
    reportId: string;
    publicProgressId: string;
    normalizedEmail: string;
  }): Promise<void>;
  createInitialWorkflow(input: CreateWorkflowInput, now?: string): Promise<WorkflowRecord>;
  getWorkflow(workflowId: string): Promise<WorkflowRecord | null>;
  getWorkflowByReportRequest(reportRequestId: string): Promise<WorkflowRecord | null>;
  getWorkflowDetail(workflowId: string): Promise<WorkflowDetail | null>;
  getPublicProgress(reportRequestId: string): Promise<SafeWorkflowProgress | null>;
  listWorkflows(filter?: WorkflowListFilter): Promise<WorkflowRecord[]>;
  prepareProviderResearchContinuation(input: {
    workflowId: string;
    websiteEstimatedCostCents: number;
    profileEstimatedCostCents: number;
    queryEstimatedCostCents: number;
    maximumAttempts: number;
    now?: string;
  }): Promise<boolean>;

  claimOutbox(input: {
    owner: string;
    limit: number;
    leaseSeconds: number;
    now?: string;
  }): Promise<OutboxEventRecord[]>;
  markOutboxSent(input: {
    outboxId: string;
    owner: string;
    externalEventId: string;
    now?: string;
  }): Promise<boolean>;
  markOutboxFailed(input: {
    outboxId: string;
    owner: string;
    safeError: string;
    retryAt: string;
    now?: string;
  }): Promise<boolean>;

  beginStep(input: {
    workflowId: string;
    stepKey: WorkflowStepKey;
    owner: string;
    leaseSeconds: number;
    now?: string;
  }): Promise<StepLeaseResult>;
  heartbeatLease(input: {
    workflowId: string;
    stepKey: WorkflowStepKey;
    owner: string;
    fencingToken: number;
    leaseSeconds: number;
    now?: string;
  }): Promise<boolean>;
  completeStep(input: {
    workflowId: string;
    stepKey: WorkflowStepKey;
    owner: string;
    fencingToken: number;
    outputReference?: string;
    now?: string;
  }): Promise<boolean>;
  failStep(input: StepFailureInput): Promise<void>;

  ensureBudget(workflowId: string, budgetType?: "initial_report" | "weekly_refresh"): Promise<CostBudgetRecord>;
  reserveCost(input: {
    workflowId: string;
    stepId: string | null;
    amountCents: number;
    idempotencyKey: string;
    now?: string;
  }): Promise<CostEntryRecord>;
  recordActualCost(input: {
    workflowId: string;
    stepId: string | null;
    attemptId: string | null;
    reservedCents: number;
    actualCents: number;
    idempotencyKey: string;
    now?: string;
  }): Promise<CostEntryRecord>;
  releaseCost(input: {
    workflowId: string;
    stepId: string | null;
    amountCents: number;
    idempotencyKey: string;
    now?: string;
  }): Promise<CostEntryRecord>;

  pauseWorkflow(workflowId: string, actor: AdminActor, now?: string): Promise<void>;
  resumeWorkflow(workflowId: string, actor: AdminActor, now?: string): Promise<void>;
  cancelWorkflow(workflowId: string, actor: AdminActor, now?: string): Promise<void>;
  retryWorkflow(workflowId: string, actor: AdminActor, now?: string): Promise<void>;
  retryStep(workflowId: string, stepKey: WorkflowStepKey, actor: AdminActor, now?: string): Promise<void>;
  releaseExpiredLease(workflowId: string, stepKey: WorkflowStepKey, actor: AdminActor, now?: string): Promise<boolean>;

  prepareAccessRecovery(input: {
    publicProgressId: string;
    normalizedEmail: string;
    recoveryTokenHash: string;
    rawRecoveryToken: string;
    expiresAt: string;
    now?: string;
  }): Promise<RecoveryPreparation>;
  consumeAccessRecovery(input: {
    recoveryTokenHash: string;
    newAccessTokenHash: string;
    accessExpiresAt: string;
    now?: string;
  }): Promise<{ reportId: string } | null>;
  cleanupSecurityArtifacts(input: {
    revokedTokenBefore: string;
    accessEventsBefore: string;
    recoveryTokenBefore: string;
  }): Promise<CleanupResult>;
  recordLegacyAccess(input: {
    legacyPublicIdHash: string;
    requestSignalHash: string;
    userAgentCategory: "browser" | "bot" | "unknown";
    now?: string;
  }): Promise<void>;
  getLegacyReadiness(now?: string): Promise<LegacyReadiness>;
}

export interface WorkflowDispatcher {
  dispatchWorkflow(payload: WorkflowQueuePayload): Promise<{ eventId: string }>;
  resumeWorkflow(workflowId: string): Promise<void>;
  pauseWorkflow(workflowId: string): Promise<void>;
  cancelWorkflow(workflowId: string): Promise<void>;
  retryWorkflow(workflowId: string): Promise<void>;
  retryStep(workflowId: string, stepKey: WorkflowStepKey): Promise<void>;
  getWorkflowStatus(workflowId: string): Promise<WorkflowRecord | null>;
}

export class WorkflowStateError extends Error {
  constructor(message = "The workflow transition is not allowed.") {
    super(message);
    this.name = "WorkflowStateError";
  }
}

export class WorkflowBudgetError extends Error {
  constructor() {
    super("The workflow cost budget would be exceeded.");
    this.name = "WorkflowBudgetError";
  }
}

export class WorkflowConfigurationError extends Error {
  constructor(message = "The workflow is not configured.") {
    super(message);
    this.name = "WorkflowConfigurationError";
  }
}
