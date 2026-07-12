import { z } from "zod";

export const WORKFLOW_EVENT_NAME = "launchclub.report.requested.v1" as const;
export const INITIAL_REPORT_BUDGET_CENTS = 400;
export const WEEKLY_REFRESH_BUDGET_CENTS = 100;

export const INITIAL_WORKFLOW_STEPS = [
  "initialize_workflow",
  "validate_intake_references",
  "establish_cost_budget",
  "prepare_provider_research",
  "mark_ready_for_provider_research"
] as const;

export const workflowStatusSchema = z.enum([
  "queued",
  "dispatch_pending",
  "running",
  "waiting_retry",
  "paused",
  "ready_for_provider_research",
  "partially_complete",
  "completed",
  "failed",
  "cancelled"
]);

export const stepStatusSchema = z.enum([
  "pending",
  "leased",
  "running",
  "succeeded",
  "retry_scheduled",
  "failed_terminal",
  "skipped",
  "cancelled"
]);

export const failureClassificationSchema = z.enum([
  "transient",
  "permanent",
  "budget_blocked",
  "cancelled",
  "lease_conflict",
  "configuration_error"
]);

export const workflowEventPayloadSchema = z
  .object({
    workflowId: z.string().uuid(),
    reportRequestId: z.string().uuid(),
    reportId: z.string().uuid(),
    correlationId: z.string().uuid(),
    workflowVersion: z.number().int().positive()
  })
  .strict();

export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;
export type StepStatus = z.infer<typeof stepStatusSchema>;
export type FailureClassification = z.infer<typeof failureClassificationSchema>;
export type WorkflowEventPayload = z.infer<typeof workflowEventPayloadSchema>;
export type WorkflowStepKey = (typeof INITIAL_WORKFLOW_STEPS)[number];

export interface WorkflowRecord {
  id: string;
  reportRequestId: string;
  reportId: string;
  workflowType: "initial_report";
  workflowVersion: number;
  status: WorkflowStatus;
  currentPhase: WorkflowStepKey | "provider_research";
  priority: number;
  inputHash: string;
  orchestratorBackend: "netlify" | "deterministic";
  externalEventId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  pausedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface WorkflowStepRecord {
  id: string;
  workflowId: string;
  stepKey: WorkflowStepKey;
  stepVersion: number;
  status: StepStatus;
  inputHash: string;
  outputReference: string | null;
  attemptCount: number;
  maximumAttempts: number;
  optional: boolean;
  estimatedCostCents: number;
  actualCostCents: number;
  scheduledAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowAttemptRecord {
  id: string;
  workflowId: string;
  stepId: string;
  attemptNumber: number;
  leaseOwner: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: "running" | "succeeded" | "retry_scheduled" | "failed" | "cancelled";
  retryClassification: FailureClassification | null;
  safeErrorCode: string | null;
  safeErrorSummary: string | null;
  providerRequestReference: string | null;
  estimatedCostCents: number;
  actualCostCents: number;
  createdAt: string;
}

export interface WorkflowHistoryEvent {
  id: string;
  workflowId: string;
  eventType: string;
  safeMetadata: Record<string, unknown>;
  correlationId: string;
  actorType: "system" | "administrator" | "orchestrator";
  createdAt: string;
}

export interface WorkflowLeaseRecord {
  id: string;
  workflowId: string;
  stepId: string | null;
  scopeKey: string;
  leaseOwner: string;
  fencingToken: number;
  expiresAt: string;
  heartbeatAt: string;
  releasedAt: string | null;
  createdAt: string;
}

export interface OutboxEventRecord {
  id: string;
  eventType: typeof WORKFLOW_EVENT_NAME;
  aggregateType: "research_workflow";
  aggregateId: string;
  payload: WorkflowEventPayload;
  idempotencyKey: string;
  status: "pending" | "leased" | "sent" | "retry_scheduled";
  attemptCount: number;
  availableAt: string;
  leasedAt: string | null;
  leaseOwner: string | null;
  sentAt: string | null;
  lastSafeError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowErrorRecord {
  id: string;
  workflowId: string;
  stepId: string | null;
  attemptId: string | null;
  classification: FailureClassification;
  safeCode: string;
  safeSummary: string;
  resolvedAt: string | null;
  createdAt: string;
}

export interface CostBudgetRecord {
  workflowId: string;
  budgetType: "initial_report" | "weekly_refresh";
  limitCents: number;
  reservedCents: number;
  spentCents: number;
  createdAt: string;
  updatedAt: string;
}

export interface CostEntryRecord {
  id: string;
  workflowId: string;
  stepId: string | null;
  attemptId: string | null;
  entryType: "reservation" | "actual" | "release";
  amountCents: number;
  idempotencyKey: string;
  createdAt: string;
}

export interface WorkflowDetail {
  workflow: WorkflowRecord;
  steps: WorkflowStepRecord[];
  attempts: WorkflowAttemptRecord[];
  events: WorkflowHistoryEvent[];
  leases: WorkflowLeaseRecord[];
  errors: WorkflowErrorRecord[];
  budget: CostBudgetRecord | null;
  costEntries: CostEntryRecord[];
}

export interface SafeWorkflowProgress {
  state:
    | "queued"
    | "preparing_research"
    | "research_ready"
    | "temporarily_delayed"
    | "partially_complete"
    | "complete"
    | "failed";
  percent: number;
  currentStep: string;
  steps: Array<{
    id: string;
    label: string;
    status: "pending" | "running" | "complete" | "failed";
    detail: string | null;
  }>;
  errorSummary: string | null;
}
