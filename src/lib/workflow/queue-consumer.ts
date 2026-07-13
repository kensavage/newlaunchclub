import "server-only";
import crypto from "node:crypto";
import { parseWorkflowQueuePayload, type WorkflowQueue, type WorkflowQueueMessage } from "@/lib/workflow/queue";
import { DurableWorkflowRunner } from "@/lib/workflow/runner";
import { INITIAL_WORKFLOW_STEPS, type FailureClassification, type WorkflowDetail, type WorkflowStepRecord } from "@/lib/workflow/schema";
import type { WorkflowStore } from "@/lib/workflow/store";

interface WorkflowStepRunner {
  runStep(workflowId: string, stepKey: WorkflowStepRecord["stepKey"], owner: string): Promise<
    "already_succeeded" | "unavailable" | "succeeded" | "lease_conflict"
  >;
}

export interface WorkflowQueueConsumerOptions {
  batchSize?: number;
  visibilityTimeoutSeconds?: number;
  leaseSeconds?: number;
  maximumRuntimeMilliseconds?: number;
  cleanupReserveMilliseconds?: number;
  now?: () => Date;
  runner?: WorkflowStepRunner;
}

export interface WorkflowQueueConsumerResult {
  received: number;
  succeeded: number;
  archived: number;
  deferred: number;
  deadLettered: number;
  invalid: number;
  leaseConflicts: number;
  needsWake: boolean;
}

export class WorkflowQueueConsumer {
  private readonly batchSize: number;
  private readonly visibilityTimeoutSeconds: number;
  private readonly maximumRuntimeMilliseconds: number;
  private readonly cleanupReserveMilliseconds: number;
  private readonly now: () => Date;
  private readonly runner: WorkflowStepRunner;

  constructor(
    private readonly store: WorkflowStore,
    private readonly queue: WorkflowQueue,
    options: WorkflowQueueConsumerOptions = {}
  ) {
    this.batchSize = options.batchSize ?? 5;
    this.visibilityTimeoutSeconds = options.visibilityTimeoutSeconds ?? 120;
    this.maximumRuntimeMilliseconds = options.maximumRuntimeMilliseconds ?? 13 * 60_000;
    this.cleanupReserveMilliseconds = options.cleanupReserveMilliseconds ?? 10_000;
    this.now = options.now ?? (() => new Date());
    this.runner = options.runner ?? new DurableWorkflowRunner(store, { leaseSeconds: options.leaseSeconds });
  }

  async consume(): Promise<WorkflowQueueConsumerResult> {
    const startedAt = this.now().getTime();
    const deadline = startedAt + this.maximumRuntimeMilliseconds - this.cleanupReserveMilliseconds;
    const messages = await this.queue.read({
      batchSize: this.batchSize,
      visibilityTimeoutSeconds: this.visibilityTimeoutSeconds
    });
    const result: WorkflowQueueConsumerResult = {
      received: messages.length,
      succeeded: 0,
      archived: 0,
      deferred: 0,
      deadLettered: 0,
      invalid: 0,
      leaseConflicts: 0,
      needsWake: false
    };
    const handledWorkflows = new Set<string>();

    for (const message of messages) {
      if (this.now().getTime() >= deadline) {
        await this.queue.release(message.messageId, 0);
        result.deferred += 1;
        result.needsWake = true;
        continue;
      }

      const outcome = await this.processMessage(message, handledWorkflows);
      result.succeeded += outcome === "succeeded" ? 1 : 0;
      result.archived += outcome === "archived" ? 1 : 0;
      result.deferred += outcome === "deferred" ? 1 : 0;
      result.deadLettered += outcome === "dead_lettered" ? 1 : 0;
      result.invalid += outcome === "invalid" ? 1 : 0;
      result.leaseConflicts += outcome === "lease_conflict" ? 1 : 0;
      if (outcome === "succeeded" || outcome === "deferred" || outcome === "lease_conflict") {
        result.needsWake = true;
      }
    }

    return result;
  }

  private async processMessage(
    message: WorkflowQueueMessage,
    handledWorkflows: Set<string>
  ): Promise<"succeeded" | "archived" | "deferred" | "dead_lettered" | "invalid" | "lease_conflict"> {
    const parsed = (() => {
      try {
        return parseWorkflowQueuePayload(message.payload);
      } catch {
        return null;
      }
    })();

    if (!parsed) {
      await this.queue.deadLetter({
        messageId: message.messageId,
        workflowId: null,
        classification: "configuration_error",
        readCount: message.readCount,
        attemptCount: 0,
        lastSafeError: "The queue message did not match the identifier-only contract."
      });
      return "invalid";
    }

    if (handledWorkflows.has(parsed.workflowId)) {
      await this.queue.release(message.messageId, 1);
      return "deferred";
    }
    handledWorkflows.add(parsed.workflowId);

    let detail = await this.store.getWorkflowDetail(parsed.workflowId);
    if (!detail || !matchesCanonicalWorkflow(detail, parsed)) {
      await this.queue.deadLetter({
        messageId: message.messageId,
        workflowId: detail?.workflow.id ?? null,
        classification: "configuration_error",
        readCount: message.readCount,
        attemptCount: 0,
        lastSafeError: "The queue message did not match canonical workflow state."
      });
      return "dead_lettered";
    }

    if (detail.workflow.status === "cancelled" || detail.workflow.status === "paused") {
      await this.queue.archive(message.messageId);
      return "archived";
    }
    if (detail.workflow.status === "ready_for_provider_research" || detail.workflow.status === "completed") {
      await this.queue.archive(message.messageId);
      return "archived";
    }
    if (detail.workflow.status === "failed") {
      await this.deadLetter(message, detail);
      return "dead_lettered";
    }

    const step = nextEligibleStep(detail);
    if (!step) {
      await this.queue.archive(message.messageId);
      return "archived";
    }
    if (step.status === "failed_terminal") {
      await this.deadLetter(message, detail, step);
      return "dead_lettered";
    }
    if (step.status === "retry_scheduled" && Date.parse(step.scheduledAt) > this.now().getTime()) {
      await this.queue.release(message.messageId, delayUntil(step.scheduledAt, this.now()));
      return "deferred";
    }

    let stepOutcome: Awaited<ReturnType<WorkflowStepRunner["runStep"]>>;
    try {
      stepOutcome = await this.runner.runStep(
        parsed.workflowId,
        step.stepKey,
        `pgmq:${message.messageId}:${crypto.randomUUID()}`
      );
    } catch {
      detail = await this.store.getWorkflowDetail(parsed.workflowId);
      const currentStep = detail?.steps.find((item) => item.stepKey === step.stepKey);
      if (detail?.workflow.status === "waiting_retry" && currentStep?.status === "retry_scheduled") {
        await this.queue.release(message.messageId, delayUntil(currentStep.scheduledAt, this.now()));
        return "deferred";
      }
      if (detail?.workflow.status === "paused") {
        await this.deadLetter(message, detail, currentStep);
        return "dead_lettered";
      }
      await this.deadLetter(message, detail, currentStep);
      return "dead_lettered";
    }

    if (stepOutcome === "unavailable" || stepOutcome === "lease_conflict") {
      await this.queue.release(message.messageId, 2);
      return "lease_conflict";
    }

    detail = await this.store.getWorkflowDetail(parsed.workflowId);
    if (detail?.workflow.status === "ready_for_provider_research" || detail?.workflow.status === "completed") {
      await this.queue.archive(message.messageId);
      return "archived";
    }
    await this.queue.release(message.messageId, 0);
    return "succeeded";
  }

  private async deadLetter(
    message: WorkflowQueueMessage,
    detail: WorkflowDetail | null,
    step?: WorkflowStepRecord
  ) {
    const latestError = detail?.errors.at(-1);
    await this.queue.deadLetter({
      messageId: message.messageId,
      workflowId: detail?.workflow.id ?? null,
      classification: latestError?.classification ?? "configuration_error",
      readCount: message.readCount,
      attemptCount: step?.attemptCount ?? 0,
      lastSafeError: safeQueueFailure(latestError?.classification)
    });
  }
}

function matchesCanonicalWorkflow(
  detail: WorkflowDetail,
  payload: ReturnType<typeof parseWorkflowQueuePayload>
) {
  return detail.workflow.id === payload.workflowId &&
    detail.workflow.reportRequestId === payload.reportRequestId &&
    detail.workflow.reportId === payload.reportId &&
    detail.workflow.workflowVersion === payload.workflowVersion;
}

function nextEligibleStep(detail: WorkflowDetail) {
  return INITIAL_WORKFLOW_STEPS
    .map((stepKey) => detail.steps.find((step) => step.stepKey === stepKey))
    .find((step) => step && step.status !== "succeeded" && step.status !== "skipped");
}

function delayUntil(timestamp: string, now: Date) {
  return Math.max(1, Math.min(3_600, Math.ceil((Date.parse(timestamp) - now.getTime()) / 1_000)));
}

function safeQueueFailure(classification: FailureClassification | undefined) {
  if (classification === "permanent") return "The workflow step failed permanently.";
  if (classification === "budget_blocked") return "The workflow step was stopped by its cost budget.";
  if (classification === "cancelled") return "The workflow was cancelled.";
  if (classification === "transient") return "The workflow step exhausted its retry allowance.";
  return "The workflow requires administrator review.";
}
