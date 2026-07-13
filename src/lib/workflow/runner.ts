import crypto from "node:crypto";
import { INITIAL_WORKFLOW_STEPS, type FailureClassification, type WorkflowQueuePayload, type WorkflowStepKey } from "@/lib/workflow/schema";
import { WorkflowBudgetError, WorkflowConfigurationError, type WorkflowStore } from "@/lib/workflow/store";

export interface WorkflowRunnerOptions {
  leaseSeconds?: number;
  retryBaseMilliseconds?: number;
  retryMaximumMilliseconds?: number;
  random?: () => number;
  now?: () => Date;
}

export class DurableWorkflowRunner {
  private readonly leaseSeconds: number;
  private readonly retryBaseMilliseconds: number;
  private readonly retryMaximumMilliseconds: number;
  private readonly random: () => number;
  private readonly now: () => Date;

  constructor(private readonly store: WorkflowStore, options: WorkflowRunnerOptions = {}) {
    this.leaseSeconds = options.leaseSeconds ?? 120;
    this.retryBaseMilliseconds = options.retryBaseMilliseconds ?? 1_000;
    this.retryMaximumMilliseconds = options.retryMaximumMilliseconds ?? 60_000;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => new Date());
  }

  async run(payload: WorkflowQueuePayload, owner = `runner:${crypto.randomUUID()}`) {
    const workflow = await this.store.getWorkflow(payload.workflowId);
    if (!workflow || workflow.reportRequestId !== payload.reportRequestId || workflow.reportId !== payload.reportId || workflow.workflowVersion !== payload.workflowVersion) {
      throw new WorkflowConfigurationError("The workflow event does not match canonical state.");
    }

    for (const stepKey of INITIAL_WORKFLOW_STEPS) {
      const result = await this.runStep(payload.workflowId, stepKey, `${owner}:${stepKey}`);
      if (result === "unavailable" || result === "lease_conflict") return;
    }
  }

  async runStep(workflowId: string, stepKey: WorkflowStepKey, owner: string) {
    const now = this.now().toISOString();
    const lease = await this.store.beginStep({ workflowId, stepKey, owner, leaseSeconds: this.leaseSeconds, now });
    if (lease.disposition === "already_succeeded") return "already_succeeded" as const;
    if (lease.disposition === "unavailable" || !lease.lease || !lease.attemptId) return "unavailable" as const;

    try {
      await this.executeFoundationStep(workflowId, stepKey);
      const completed = await this.store.completeStep({ workflowId, stepKey, owner, fencingToken: lease.lease.fencingToken, outputReference: `workflow-step:${stepKey}:v1`, now: this.now().toISOString() });
      return completed ? "succeeded" as const : "lease_conflict" as const;
    } catch (error) {
      const classification = classifyWorkflowFailure(error);
      const attemptNumber = lease.step.attemptCount;
      const delay = getRetryDelay(attemptNumber, this.retryBaseMilliseconds, this.retryMaximumMilliseconds, this.random);
      await this.store.failStep({
        workflowId,
        stepKey,
        owner,
        fencingToken: lease.lease.fencingToken,
        classification,
        safeCode: safeErrorCode(error, classification),
        safeSummary: safeErrorSummary(classification),
        retryAt: new Date(this.now().getTime() + delay).toISOString(),
        now: this.now().toISOString()
      });
      if (classification === "lease_conflict") return "lease_conflict" as const;
      throw error;
    }
  }

  private async executeFoundationStep(workflowId: string, stepKey: WorkflowStepKey) {
    if (stepKey === "initialize_workflow") {
      if (!(await this.store.getWorkflow(workflowId))) throw new WorkflowConfigurationError();
      return;
    }
    if (stepKey === "validate_intake_references") {
      const workflow = await this.store.getWorkflow(workflowId);
      if (!workflow?.reportRequestId || !workflow.reportId) throw new WorkflowConfigurationError();
      return;
    }
    if (stepKey === "establish_cost_budget") {
      await this.store.ensureBudget(workflowId, "initial_report");
    }
    // PR3 deliberately stops after preparing identifiers and durable state.
  }
}

export function classifyWorkflowFailure(error: unknown): FailureClassification {
  if (error instanceof WorkflowBudgetError) return "budget_blocked";
  if (error instanceof WorkflowConfigurationError) return "configuration_error";
  if (error instanceof Error && error.name === "AbortError") return "transient";
  if (error instanceof TypeError) return "transient";
  return "permanent";
}

export function getRetryDelay(attempt: number, baseMs: number, maximumMs: number, random: () => number) {
  const exponential = Math.min(maximumMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(exponential * (0.75 + random() * 0.5));
}

function safeErrorCode(error: unknown, classification: FailureClassification) {
  if (error instanceof WorkflowConfigurationError) return "workflow_configuration";
  if (error instanceof WorkflowBudgetError) return "workflow_budget_blocked";
  return `workflow_${classification}`;
}

function safeErrorSummary(classification: FailureClassification) {
  if (classification === "transient") return "The step was temporarily unavailable and may be retried.";
  if (classification === "configuration_error") return "The workflow requires administrator configuration.";
  if (classification === "budget_blocked") return "The step was stopped by the workflow budget.";
  return "The step could not be completed.";
}
