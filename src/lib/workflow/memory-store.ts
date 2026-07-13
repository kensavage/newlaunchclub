import "server-only";
import crypto from "node:crypto";
import {
  INITIAL_REPORT_BUDGET_CENTS,
  INITIAL_WORKFLOW_STEPS,
  WEEKLY_REFRESH_BUDGET_CENTS,
  WORKFLOW_EVENT_NAME,
  type CostBudgetRecord,
  type CostEntryRecord,
  type OutboxEventRecord,
  type SafeWorkflowProgress,
  type WorkflowAttemptRecord,
  type WorkflowDetail,
  type WorkflowErrorRecord,
  type WorkflowHistoryEvent,
  type WorkflowLeaseRecord,
  type WorkflowRecord,
  type WorkflowStepKey,
  type WorkflowStepRecord
} from "@/lib/workflow/schema";
import {
  WorkflowBudgetError,
  WorkflowStateError,
  type AdminActor,
  type CleanupResult,
  type CreateWorkflowInput,
  type LegacyReadiness,
  type RecoveryPreparation,
  type StepFailureInput,
  type StepLeaseResult,
  type WorkflowListFilter,
  type WorkflowStore
} from "@/lib/workflow/store";

interface RecoveryTokenRecord {
  id: string;
  reportId: string;
  tokenHash: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

interface ReportIdentityRecord {
  reportId: string;
  publicProgressId: string;
  normalizedEmail: string;
}

interface SecurityTokenRecord {
  id: string;
  reportId: string;
  tokenHash: string;
  status: "active" | "rotated" | "revoked" | "expired";
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

interface MemoryWorkflowState {
  workflows: Map<string, WorkflowRecord>;
  workflowByRequest: Map<string, string>;
  steps: Map<string, WorkflowStepRecord>;
  attempts: WorkflowAttemptRecord[];
  events: WorkflowHistoryEvent[];
  leases: Map<string, WorkflowLeaseRecord>;
  errors: WorkflowErrorRecord[];
  outbox: Map<string, OutboxEventRecord>;
  budgets: Map<string, CostBudgetRecord>;
  costs: CostEntryRecord[];
  identities: Map<string, ReportIdentityRecord>;
  recoveryTokens: Map<string, RecoveryTokenRecord>;
  securityTokens: SecurityTokenRecord[];
  legacyAccesses: Array<{ createdAt: string; legacyPublicIdHash: string }>;
  lock: Promise<void>;
}

declare global {
  var __launchClubWorkflowStore: MemoryWorkflowState | undefined;
}

function createState(): MemoryWorkflowState {
  return {
    workflows: new Map(),
    workflowByRequest: new Map(),
    steps: new Map(),
    attempts: [],
    events: [],
    leases: new Map(),
    errors: [],
    outbox: new Map(),
    budgets: new Map(),
    costs: [],
    identities: new Map(),
    recoveryTokens: new Map(),
    securityTokens: [],
    legacyAccesses: [],
    lock: Promise.resolve()
  };
}

function getState() {
  globalThis.__launchClubWorkflowStore ??= createState();
  return globalThis.__launchClubWorkflowStore;
}

export class MemoryWorkflowStore implements WorkflowStore {
  private get state() {
    return getState();
  }

  async registerReportIdentity(input: ReportIdentityRecord) {
    await this.withLock(async () => {
      this.state.identities.set(input.reportId, { ...input });
    });
  }

  async createInitialWorkflow(input: CreateWorkflowInput, now = new Date().toISOString()) {
    return this.withLock(async () => {
      const existingId = this.state.workflowByRequest.get(input.reportRequestId);
      const existing = existingId ? this.state.workflows.get(existingId) : null;
      if (existing) return existing;

      const workflow: WorkflowRecord = {
        id: crypto.randomUUID(),
        reportRequestId: input.reportRequestId,
        reportId: input.reportId,
        workflowType: "initial_report",
        workflowVersion: input.workflowVersion ?? 1,
        status: "dispatch_pending",
        currentPhase: "initialize_workflow",
        priority: input.priority ?? 0,
        inputHash: input.inputHash,
        orchestratorBackend: input.orchestratorBackend ?? "deterministic",
        externalEventId: null,
        startedAt: null,
        completedAt: null,
        pausedAt: null,
        cancelledAt: null,
        createdAt: now,
        updatedAt: now
      };

      this.state.workflows.set(workflow.id, workflow);
      this.state.workflowByRequest.set(workflow.reportRequestId, workflow.id);
      for (const stepKey of INITIAL_WORKFLOW_STEPS) {
        const step: WorkflowStepRecord = {
          id: crypto.randomUUID(),
          workflowId: workflow.id,
          stepKey,
          stepVersion: 1,
          status: "pending",
          inputHash: hashStable(`${input.inputHash}:${stepKey}:1`),
          outputReference: null,
          attemptCount: 0,
          maximumAttempts: input.maximumAttempts ?? Math.min(20, Math.max(1, Number(process.env.WORKFLOW_MAX_ATTEMPTS ?? 4))),
          optional: false,
          estimatedCostCents: 0,
          actualCostCents: 0,
          scheduledAt: now,
          startedAt: null,
          completedAt: null,
          createdAt: now,
          updatedAt: now
        };
        this.state.steps.set(step.id, step);
      }

      this.addEvent(workflow.id, "workflow_created", input.correlationId, "system", {}, now);
      this.addEvent(workflow.id, "dispatch_requested", input.correlationId, "system", {}, now);
      this.ensureBudgetInternal(workflow.id, "initial_report", now);
      const payload = {
        workflowId: workflow.id,
        reportRequestId: workflow.reportRequestId,
        reportId: workflow.reportId,
        correlationId: input.correlationId,
        workflowVersion: workflow.workflowVersion
      };
      const outbox: OutboxEventRecord = {
        id: crypto.randomUUID(),
        eventType: WORKFLOW_EVENT_NAME,
        aggregateType: "research_workflow",
        aggregateId: workflow.id,
        payload,
        idempotencyKey: `${WORKFLOW_EVENT_NAME}:${workflow.id}:${workflow.workflowVersion}`,
        status: "pending",
        attemptCount: 0,
        availableAt: now,
        leasedAt: null,
        leaseOwner: null,
        sentAt: null,
        lastSafeError: null,
        createdAt: now,
        updatedAt: now
      };
      this.state.outbox.set(outbox.id, outbox);
      return workflow;
    });
  }

  async getWorkflow(workflowId: string) {
    return this.state.workflows.get(workflowId) ?? null;
  }

  async getWorkflowByReportRequest(reportRequestId: string) {
    const workflowId = this.state.workflowByRequest.get(reportRequestId);
    return workflowId ? this.state.workflows.get(workflowId) ?? null : null;
  }

  async getWorkflowDetail(workflowId: string): Promise<WorkflowDetail | null> {
    const workflow = this.state.workflows.get(workflowId);
    if (!workflow) return null;
    const steps = this.stepsFor(workflowId);
    const stepIds = new Set(steps.map((step) => step.id));
    return {
      workflow,
      steps,
      attempts: this.state.attempts.filter((attempt) => attempt.workflowId === workflowId),
      events: this.state.events.filter((event) => event.workflowId === workflowId),
      leases: [...this.state.leases.values()].filter((lease) => lease.workflowId === workflowId),
      errors: this.state.errors.filter((error) => error.workflowId === workflowId),
      budget: this.state.budgets.get(workflowId) ?? null,
      costEntries: this.state.costs.filter(
        (entry) => entry.workflowId === workflowId || (entry.stepId && stepIds.has(entry.stepId))
      )
    };
  }

  async getPublicProgress(reportRequestId: string) {
    const workflow = await this.getWorkflowByReportRequest(reportRequestId);
    return workflow ? mapPublicProgress(workflow) : null;
  }

  async listWorkflows(filter: WorkflowListFilter = {}) {
    return [...this.state.workflows.values()]
      .filter((workflow) => !filter.status || workflow.status === filter.status)
      .filter(
        (workflow) => !filter.stalledBefore || workflow.updatedAt < filter.stalledBefore
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit ?? 50);
  }

  async claimOutbox({ owner, limit, leaseSeconds, now = new Date().toISOString() }: {
    owner: string;
    limit: number;
    leaseSeconds: number;
    now?: string;
  }) {
    return this.withLock(async () => {
      const leaseCutoff = Date.parse(now) - leaseSeconds * 1000;
      const claimable = [...this.state.outbox.values()]
        .filter(
          (event) =>
            event.status !== "sent" &&
            Date.parse(event.availableAt) <= Date.parse(now) &&
            (event.status !== "leased" || !event.leasedAt || Date.parse(event.leasedAt) <= leaseCutoff)
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit);
      for (const event of claimable) {
        event.status = "leased";
        event.leaseOwner = owner;
        event.leasedAt = now;
        event.attemptCount += 1;
        event.updatedAt = now;
      }
      return claimable;
    });
  }

  async markOutboxSent({ outboxId, owner, externalEventId, now = new Date().toISOString() }: {
    outboxId: string;
    owner: string;
    externalEventId: string;
    now?: string;
  }) {
    return this.withLock(async () => {
      const outbox = this.state.outbox.get(outboxId);
      if (!outbox || outbox.status === "sent") return outbox?.status === "sent";
      if (outbox.leaseOwner !== owner || outbox.status !== "leased") return false;
      outbox.status = "sent";
      outbox.sentAt = now;
      outbox.updatedAt = now;
      outbox.lastSafeError = null;
      const workflow = this.state.workflows.get(outbox.aggregateId);
      if (workflow) {
        workflow.externalEventId = externalEventId;
        if (workflow.status === "dispatch_pending") workflow.status = "queued";
        workflow.updatedAt = now;
        this.addEvent(workflow.id, "dispatch_sent", outbox.payload.correlationId, "orchestrator", {}, now);
      }
      return true;
    });
  }

  async markOutboxFailed({ outboxId, owner, safeError, retryAt, now = new Date().toISOString() }: {
    outboxId: string;
    owner: string;
    safeError: string;
    retryAt: string;
    now?: string;
  }) {
    return this.withLock(async () => {
      const outbox = this.state.outbox.get(outboxId);
      if (!outbox || outbox.leaseOwner !== owner || outbox.status !== "leased") return false;
      outbox.status = "retry_scheduled";
      outbox.availableAt = retryAt;
      outbox.lastSafeError = safeError.slice(0, 200);
      outbox.leaseOwner = null;
      outbox.leasedAt = null;
      outbox.updatedAt = now;
      return true;
    });
  }

  async beginStep({ workflowId, stepKey, owner, leaseSeconds, now = new Date().toISOString() }: {
    workflowId: string;
    stepKey: WorkflowStepKey;
    owner: string;
    leaseSeconds: number;
    now?: string;
  }): Promise<StepLeaseResult> {
    return this.withLock(async () => {
      const workflow = this.requireWorkflow(workflowId);
      const step = this.requireStep(workflowId, stepKey);
      if (step.status === "succeeded") {
        return { disposition: "already_succeeded", workflow, step, lease: null, attemptId: null };
      }
      const stepIndex = INITIAL_WORKFLOW_STEPS.indexOf(stepKey);
      const prerequisiteIncomplete = this.stepsFor(workflowId)
        .slice(0, stepIndex)
        .some((candidate) => candidate.status !== "succeeded");
      if (
        prerequisiteIncomplete ||
        workflow.status === "paused" ||
        workflow.status === "cancelled" ||
        workflow.status === "failed" ||
        Date.parse(step.scheduledAt) > Date.parse(now)
      ) {
        return { disposition: "unavailable", workflow, step, lease: null, attemptId: null };
      }

      const scopeKey = `step:${step.id}`;
      const current = this.activeLease(workflowId, scopeKey);
      if (current && !current.releasedAt && Date.parse(current.expiresAt) > Date.parse(now)) {
        return { disposition: "unavailable", workflow, step, lease: null, attemptId: null };
      }
      if (current && !current.releasedAt) current.releasedAt = now;
      if (step.attemptCount >= step.maximumAttempts) {
        step.status = "failed_terminal";
        workflow.status = "failed";
        workflow.updatedAt = now;
        return { disposition: "unavailable", workflow, step, lease: null, attemptId: null };
      }

      const fencingToken = Math.max(
        0,
        ...[...this.state.leases.values()]
          .filter((lease) => lease.workflowId === workflowId && lease.scopeKey === scopeKey)
          .map((lease) => lease.fencingToken)
      ) + 1;
      const lease: WorkflowLeaseRecord = {
        id: crypto.randomUUID(),
        workflowId,
        stepId: step.id,
        scopeKey,
        leaseOwner: owner,
        fencingToken,
        expiresAt: new Date(Date.parse(now) + leaseSeconds * 1000).toISOString(),
        heartbeatAt: now,
        releasedAt: null,
        createdAt: now
      };
      this.state.leases.set(lease.id, lease);
      step.attemptCount += 1;
      step.status = "running";
      step.startedAt ??= now;
      step.updatedAt = now;
      workflow.status = "running";
      workflow.currentPhase = stepKey;
      workflow.startedAt ??= now;
      workflow.updatedAt = now;
      const attempt: WorkflowAttemptRecord = {
        id: crypto.randomUUID(),
        workflowId,
        stepId: step.id,
        attemptNumber: step.attemptCount,
        leaseOwner: owner,
        startedAt: now,
        finishedAt: null,
        outcome: "running",
        retryClassification: null,
        safeErrorCode: null,
        safeErrorSummary: null,
        providerRequestReference: null,
        estimatedCostCents: step.estimatedCostCents,
        actualCostCents: 0,
        createdAt: now
      };
      this.state.attempts.push(attempt);
      this.addEvent(workflowId, "step_started", workflowId, "orchestrator", { step: stepKey }, now);
      return { disposition: "acquired", workflow, step, lease, attemptId: attempt.id };
    });
  }

  async heartbeatLease({ workflowId, stepKey, owner, fencingToken, leaseSeconds, now = new Date().toISOString() }: {
    workflowId: string;
    stepKey: WorkflowStepKey;
    owner: string;
    fencingToken: number;
    leaseSeconds: number;
    now?: string;
  }) {
    return this.withLock(async () => {
      const step = this.requireStep(workflowId, stepKey);
      const lease = this.activeLease(workflowId, `step:${step.id}`);
      if (!lease || lease.leaseOwner !== owner || lease.fencingToken !== fencingToken || Date.parse(lease.expiresAt) <= Date.parse(now)) return false;
      lease.heartbeatAt = now;
      lease.expiresAt = new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
      return true;
    });
  }

  async completeStep({ workflowId, stepKey, owner, fencingToken, outputReference = "database", now = new Date().toISOString() }: {
    workflowId: string;
    stepKey: WorkflowStepKey;
    owner: string;
    fencingToken: number;
    outputReference?: string;
    now?: string;
  }) {
    return this.withLock(async () => {
      const workflow = this.requireWorkflow(workflowId);
      const step = this.requireStep(workflowId, stepKey);
      if (step.status === "succeeded") return true;
      const lease = this.activeLease(workflowId, `step:${step.id}`);
      if (!lease || lease.leaseOwner !== owner || lease.fencingToken !== fencingToken || Date.parse(lease.expiresAt) <= Date.parse(now)) return false;
      step.status = "succeeded";
      step.outputReference = outputReference.slice(0, 250);
      step.completedAt = now;
      step.updatedAt = now;
      lease.releasedAt = now;
      const attempt = this.currentAttempt(step.id);
      if (attempt) {
        attempt.outcome = "succeeded";
        attempt.finishedAt = now;
      }
      this.addEvent(workflowId, "step_succeeded", workflowId, "orchestrator", { step: stepKey }, now);
      if (stepKey === "mark_ready_for_provider_research") {
        workflow.status = "ready_for_provider_research";
        workflow.currentPhase = "provider_research";
        this.addEvent(workflowId, "workflow_ready_for_provider_research", workflowId, "orchestrator", {}, now);
      }
      workflow.updatedAt = now;
      return true;
    });
  }

  async failStep(input: StepFailureInput) {
    await this.withLock(async () => {
      const now = input.now ?? new Date().toISOString();
      const workflow = this.requireWorkflow(input.workflowId);
      const step = this.requireStep(input.workflowId, input.stepKey);
      const lease = this.activeLease(input.workflowId, `step:${step.id}`);
      if (input.classification === "lease_conflict") return;
      if (!lease || lease.leaseOwner !== input.owner || lease.fencingToken !== input.fencingToken) return;
      lease.releasedAt = now;
      const attempt = this.currentAttempt(step.id);
      const mayRetry = input.classification === "transient" && step.attemptCount < step.maximumAttempts;
      step.status = mayRetry ? "retry_scheduled" : "failed_terminal";
      step.scheduledAt = input.retryAt ?? now;
      step.updatedAt = now;
      workflow.status = mayRetry ? "waiting_retry" : input.classification === "budget_blocked" ? "paused" : "failed";
      workflow.updatedAt = now;
      if (attempt) {
        attempt.outcome = mayRetry ? "retry_scheduled" : "failed";
        attempt.retryClassification = input.classification;
        attempt.safeErrorCode = input.safeCode.slice(0, 80);
        attempt.safeErrorSummary = input.safeSummary.slice(0, 240);
        attempt.finishedAt = now;
      }
      this.state.errors.push({
        id: crypto.randomUUID(),
        workflowId: workflow.id,
        stepId: step.id,
        attemptId: attempt?.id ?? null,
        classification: input.classification,
        safeCode: input.safeCode.slice(0, 80),
        safeSummary: input.safeSummary.slice(0, 240),
        resolvedAt: null,
        createdAt: now
      });
      this.addEvent(workflow.id, mayRetry ? "step_retry_scheduled" : "step_failed", workflow.id, "orchestrator", { step: input.stepKey, classification: input.classification }, now);
    });
  }

  async ensureBudget(workflowId: string, budgetType: "initial_report" | "weekly_refresh" = "initial_report") {
    return this.withLock(async () => this.ensureBudgetInternal(workflowId, budgetType, new Date().toISOString()));
  }

  async reserveCost({ workflowId, stepId, amountCents, idempotencyKey, now = new Date().toISOString() }: {
    workflowId: string;
    stepId: string | null;
    amountCents: number;
    idempotencyKey: string;
    now?: string;
  }) {
    return this.withLock(async () => {
      assertCents(amountCents);
      const duplicate = this.state.costs.find((entry) => entry.idempotencyKey === idempotencyKey);
      if (duplicate) return duplicate;
      const budget = this.ensureBudgetInternal(workflowId, "initial_report", now);
      if (budget.spentCents + budget.reservedCents + amountCents > budget.limitCents) {
        this.addEvent(workflowId, "cost_limit_reached", workflowId, "system", {}, now);
        throw new WorkflowBudgetError();
      }
      budget.reservedCents += amountCents;
      budget.updatedAt = now;
      const entry = this.addCost(workflowId, stepId, null, "reservation", amountCents, idempotencyKey, now);
      this.addEvent(workflowId, "cost_reserved", workflowId, "system", { amountCents }, now);
      return entry;
    });
  }

  async recordActualCost({ workflowId, stepId, attemptId, reservedCents, actualCents, idempotencyKey, now = new Date().toISOString() }: {
    workflowId: string;
    stepId: string | null;
    attemptId: string | null;
    reservedCents: number;
    actualCents: number;
    idempotencyKey: string;
    now?: string;
  }) {
    return this.withLock(async () => {
      assertCents(reservedCents);
      assertCents(actualCents);
      const duplicate = this.state.costs.find((entry) => entry.idempotencyKey === idempotencyKey);
      if (duplicate) return duplicate;
      const budget = this.ensureBudgetInternal(workflowId, "initial_report", now);
      if (actualCents > reservedCents || budget.reservedCents < reservedCents) throw new WorkflowBudgetError();
      budget.reservedCents -= reservedCents;
      budget.spentCents += actualCents;
      budget.updatedAt = now;
      const entry = this.addCost(workflowId, stepId, attemptId, "actual", actualCents, idempotencyKey, now);
      if (reservedCents > actualCents) {
        this.addCost(workflowId, stepId, attemptId, "release", reservedCents - actualCents, `${idempotencyKey}:unused`, now);
      }
      this.addEvent(workflowId, "cost_recorded", workflowId, "system", { actualCents }, now);
      return entry;
    });
  }

  async releaseCost({ workflowId, stepId, amountCents, idempotencyKey, now = new Date().toISOString() }: {
    workflowId: string;
    stepId: string | null;
    amountCents: number;
    idempotencyKey: string;
    now?: string;
  }) {
    return this.withLock(async () => {
      assertCents(amountCents);
      const duplicate = this.state.costs.find((entry) => entry.idempotencyKey === idempotencyKey);
      if (duplicate) return duplicate;
      const budget = this.ensureBudgetInternal(workflowId, "initial_report", now);
      if (budget.reservedCents < amountCents) throw new WorkflowBudgetError();
      budget.reservedCents -= amountCents;
      budget.updatedAt = now;
      return this.addCost(workflowId, stepId, null, "release", amountCents, idempotencyKey, now);
    });
  }

  async pauseWorkflow(workflowId: string, actor: AdminActor, now = new Date().toISOString()) {
    await this.adminTransition(workflowId, actor, ["queued", "dispatch_pending", "running", "waiting_retry"], "paused", "workflow_paused", now);
  }

  async resumeWorkflow(workflowId: string, actor: AdminActor, now = new Date().toISOString()) {
    await this.adminTransition(workflowId, actor, ["paused"], "dispatch_pending", "workflow_resumed", now);
    await this.withLock(async () => this.ensureRetryOutbox(this.requireWorkflow(workflowId), now));
  }

  async cancelWorkflow(workflowId: string, actor: AdminActor, now = new Date().toISOString()) {
    await this.adminTransition(workflowId, actor, ["queued", "dispatch_pending", "running", "waiting_retry", "paused"], "cancelled", "workflow_cancelled", now);
    for (const step of this.stepsFor(workflowId)) {
      if (step.status !== "succeeded") step.status = "cancelled";
    }
  }

  async retryWorkflow(workflowId: string, actor: AdminActor, now = new Date().toISOString()) {
    await this.withLock(async () => {
      const workflow = this.requireWorkflow(workflowId);
      if (workflow.status !== "failed" && workflow.status !== "waiting_retry") throw new WorkflowStateError();
      const failed = this.stepsFor(workflowId).find((step) => step.status === "failed_terminal" || step.status === "retry_scheduled");
      if (!failed || failed.attemptCount >= failed.maximumAttempts) throw new WorkflowStateError("The failed step has exhausted its attempts.");
      failed.status = "pending";
      failed.scheduledAt = now;
      failed.updatedAt = now;
      workflow.status = "dispatch_pending";
      workflow.updatedAt = now;
      this.addEvent(workflowId, "administrator_retry_requested", workflowId, "administrator", { actorId: actor.actorId, step: failed.stepKey }, now);
      this.ensureRetryOutbox(workflow, now);
    });
  }

  async retryStep(workflowId: string, stepKey: WorkflowStepKey, actor: AdminActor, now = new Date().toISOString()) {
    await this.withLock(async () => {
      const workflow = this.requireWorkflow(workflowId);
      const step = this.requireStep(workflowId, stepKey);
      if (step.status === "succeeded" || (step.status !== "failed_terminal" && step.status !== "retry_scheduled") || step.attemptCount >= step.maximumAttempts) throw new WorkflowStateError();
      step.status = "pending";
      step.scheduledAt = now;
      step.updatedAt = now;
      workflow.status = "dispatch_pending";
      workflow.updatedAt = now;
      this.addEvent(workflowId, "administrator_retry_requested", workflowId, "administrator", { actorId: actor.actorId, step: stepKey }, now);
      this.ensureRetryOutbox(workflow, now);
    });
  }

  async releaseExpiredLease(workflowId: string, stepKey: WorkflowStepKey, actor: AdminActor, now = new Date().toISOString()) {
    return this.withLock(async () => {
      const step = this.requireStep(workflowId, stepKey);
      const lease = this.activeLease(workflowId, `step:${step.id}`);
      if (!lease || Date.parse(lease.expiresAt) > Date.parse(now)) return false;
      lease.releasedAt = now;
      if (step.status === "running" || step.status === "leased") step.status = "retry_scheduled";
      this.addEvent(workflowId, "administrator_lease_released", workflowId, "administrator", { actorId: actor.actorId, step: stepKey }, now);
      return true;
    });
  }

  async prepareAccessRecovery({ publicProgressId, normalizedEmail, recoveryTokenHash, rawRecoveryToken, expiresAt, now = new Date().toISOString() }: {
    publicProgressId: string;
    normalizedEmail: string;
    recoveryTokenHash: string;
    rawRecoveryToken: string;
    expiresAt: string;
    now?: string;
  }): Promise<RecoveryPreparation> {
    return this.withLock(async () => {
      const identity = [...this.state.identities.values()].find(
        (item) => item.publicProgressId === publicProgressId && item.normalizedEmail === normalizedEmail
      );
      if (!identity) return { accepted: true, delivery: null };
      for (const token of this.state.recoveryTokens.values()) {
        if (token.reportId === identity.reportId && !token.consumedAt) token.consumedAt = now;
      }
      const token: RecoveryTokenRecord = {
        id: crypto.randomUUID(),
        reportId: identity.reportId,
        tokenHash: recoveryTokenHash,
        expiresAt,
        consumedAt: null,
        createdAt: now
      };
      this.state.recoveryTokens.set(token.id, token);
      return { accepted: true, delivery: { reportId: identity.reportId, normalizedEmail, recoveryToken: rawRecoveryToken, expiresAt } };
    });
  }

  async consumeAccessRecovery({ recoveryTokenHash, newAccessTokenHash, accessExpiresAt, now = new Date().toISOString() }: {
    recoveryTokenHash: string;
    newAccessTokenHash: string;
    accessExpiresAt: string;
    now?: string;
  }) {
    return this.withLock(async () => {
      const token = [...this.state.recoveryTokens.values()].find((item) => item.tokenHash === recoveryTokenHash);
      if (!token || token.consumedAt || Date.parse(token.expiresAt) <= Date.parse(now)) return null;
      token.consumedAt = now;
      for (const access of this.state.securityTokens) {
        if (access.reportId === token.reportId && access.status === "active") {
          access.status = "rotated";
          access.revokedAt = now;
        }
      }
      this.state.securityTokens.push({ id: crypto.randomUUID(), reportId: token.reportId, tokenHash: newAccessTokenHash, status: "active", expiresAt: accessExpiresAt, revokedAt: null, createdAt: now });
      return { reportId: token.reportId };
    });
  }

  async cleanupSecurityArtifacts({ revokedTokenBefore, accessEventsBefore, recoveryTokenBefore }: {
    revokedTokenBefore: string;
    accessEventsBefore: string;
    recoveryTokenBefore: string;
  }): Promise<CleanupResult> {
    return this.withLock(async () => {
      const tokenCount = this.state.securityTokens.length;
      this.state.securityTokens = this.state.securityTokens.filter((token) => !token.revokedAt || token.revokedAt >= revokedTokenBefore);
      const recoveryCount = this.state.recoveryTokens.size;
      for (const [id, token] of this.state.recoveryTokens) {
        if (token.createdAt < recoveryTokenBefore && (token.consumedAt || token.expiresAt < recoveryTokenBefore)) this.state.recoveryTokens.delete(id);
      }
      const legacyCount = this.state.legacyAccesses.length;
      this.state.legacyAccesses = this.state.legacyAccesses.filter((access) => access.createdAt >= accessEventsBefore);
      return { tokenHashesDeleted: tokenCount - this.state.securityTokens.length, accessEventsDeleted: legacyCount - this.state.legacyAccesses.length, recoveryTokensDeleted: recoveryCount - this.state.recoveryTokens.size };
    });
  }

  async recordLegacyAccess({ legacyPublicIdHash, now = new Date().toISOString() }: {
    legacyPublicIdHash: string;
    requestSignalHash: string;
    userAgentCategory: "browser" | "bot" | "unknown";
    now?: string;
  }) {
    await this.withLock(async () => {
      this.state.legacyAccesses.push({ createdAt: now, legacyPublicIdHash });
    });
  }

  async getLegacyReadiness(now = new Date().toISOString()): Promise<LegacyReadiness> {
    const cutoff = Date.parse(now) - 30 * 24 * 60 * 60 * 1000;
    const recent = this.state.legacyAccesses.filter((access) => Date.parse(access.createdAt) >= cutoff).length;
    return { remainingActiveLegacyLinks: 0, legacyAccessesLast30Days: recent, readyForRetirement: recent === 0 };
  }

  snapshot() {
    return {
      workflows: [...this.state.workflows.values()],
      steps: [...this.state.steps.values()],
      attempts: [...this.state.attempts],
      events: [...this.state.events],
      leases: [...this.state.leases.values()],
      errors: [...this.state.errors],
      outbox: [...this.state.outbox.values()],
      budgets: [...this.state.budgets.values()],
      costs: [...this.state.costs],
      recoveryTokens: [...this.state.recoveryTokens.values()],
      legacyAccesses: [...this.state.legacyAccesses]
    };
  }

  private stepsFor(workflowId: string) {
    return [...this.state.steps.values()].filter((step) => step.workflowId === workflowId).sort((a, b) => INITIAL_WORKFLOW_STEPS.indexOf(a.stepKey) - INITIAL_WORKFLOW_STEPS.indexOf(b.stepKey));
  }

  private requireWorkflow(workflowId: string) {
    const workflow = this.state.workflows.get(workflowId);
    if (!workflow) throw new WorkflowStateError("Workflow not found.");
    return workflow;
  }

  private requireStep(workflowId: string, stepKey: WorkflowStepKey) {
    const step = this.stepsFor(workflowId).find((item) => item.stepKey === stepKey);
    if (!step) throw new WorkflowStateError("Workflow step not found.");
    return step;
  }

  private activeLease(workflowId: string, scopeKey: string) {
    return [...this.state.leases.values()].filter((lease) => lease.workflowId === workflowId && lease.scopeKey === scopeKey && !lease.releasedAt).sort((a, b) => b.fencingToken - a.fencingToken)[0] ?? null;
  }

  private currentAttempt(stepId: string) {
    return this.state.attempts.filter((attempt) => attempt.stepId === stepId).sort((a, b) => b.attemptNumber - a.attemptNumber)[0] ?? null;
  }

  private ensureBudgetInternal(workflowId: string, budgetType: "initial_report" | "weekly_refresh", now: string) {
    const existing = this.state.budgets.get(workflowId);
    if (existing) return existing;
    const budget: CostBudgetRecord = { workflowId, budgetType, limitCents: budgetType === "initial_report" ? INITIAL_REPORT_BUDGET_CENTS : WEEKLY_REFRESH_BUDGET_CENTS, reservedCents: 0, spentCents: 0, createdAt: now, updatedAt: now };
    this.state.budgets.set(workflowId, budget);
    return budget;
  }

  private addCost(workflowId: string, stepId: string | null, attemptId: string | null, entryType: CostEntryRecord["entryType"], amountCents: number, idempotencyKey: string, now: string) {
    const entry: CostEntryRecord = { id: crypto.randomUUID(), workflowId, stepId, attemptId, entryType, amountCents, idempotencyKey, createdAt: now };
    this.state.costs.push(entry);
    return entry;
  }

  private addEvent(workflowId: string, eventType: string, correlationId: string, actorType: WorkflowHistoryEvent["actorType"], safeMetadata: Record<string, unknown>, now: string) {
    this.state.events.push({ id: crypto.randomUUID(), workflowId, eventType, safeMetadata, correlationId, actorType, createdAt: now });
  }

  private async adminTransition(workflowId: string, actor: AdminActor, allowed: WorkflowRecord["status"][], next: WorkflowRecord["status"], eventType: string, now: string) {
    await this.withLock(async () => {
      const workflow = this.requireWorkflow(workflowId);
      if (workflow.status === next) return;
      if (!allowed.includes(workflow.status)) throw new WorkflowStateError();
      workflow.status = next;
      workflow.updatedAt = now;
      workflow.pausedAt = next === "paused" ? now : null;
      workflow.cancelledAt = next === "cancelled" ? now : workflow.cancelledAt;
      this.addEvent(workflowId, eventType, workflowId, "administrator", { actorId: actor.actorId }, now);
    });
  }

  private ensureRetryOutbox(workflow: WorkflowRecord, now: string) {
    const retryNumber = this.state.events.filter((event) => event.workflowId === workflow.id && (event.eventType === "administrator_retry_requested" || event.eventType === "workflow_resumed")).length;
    const idempotencyKey = `${WORKFLOW_EVENT_NAME}:${workflow.id}:${workflow.workflowVersion}:admin-retry:${retryNumber}`;
    if ([...this.state.outbox.values()].some((event) => event.idempotencyKey === idempotencyKey)) return;
    const correlationId = crypto.randomUUID();
    const outbox: OutboxEventRecord = { id: crypto.randomUUID(), eventType: WORKFLOW_EVENT_NAME, aggregateType: "research_workflow", aggregateId: workflow.id, payload: { workflowId: workflow.id, reportRequestId: workflow.reportRequestId, reportId: workflow.reportId, correlationId, workflowVersion: workflow.workflowVersion }, idempotencyKey, status: "pending", attemptCount: 0, availableAt: now, leasedAt: null, leaseOwner: null, sentAt: null, lastSafeError: null, createdAt: now, updatedAt: now };
    this.state.outbox.set(outbox.id, outbox);
  }

  private async withLock<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.state.lock;
    let release!: () => void;
    this.state.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function resetMemoryWorkflowStoreForTests() {
  globalThis.__launchClubWorkflowStore = undefined;
}

export function mapPublicProgress(workflow: WorkflowRecord): SafeWorkflowProgress {
  const failed = workflow.status === "failed";
  const state: SafeWorkflowProgress["state"] =
    workflow.status === "ready_for_provider_research" ? "research_ready" :
    workflow.status === "waiting_retry" || workflow.status === "paused" ? "temporarily_delayed" :
    workflow.status === "partially_complete" ? "partially_complete" :
    workflow.status === "completed" ? "complete" :
    failed || workflow.status === "cancelled" ? "failed" :
    workflow.status === "queued" || workflow.status === "dispatch_pending" ? "queued" : "preparing_research";
  const preparationStatus =
    state === "failed" ? "failed" as const : state === "complete" ? "complete" as const : "running" as const;
  const preparationDetail =
    state === "temporarily_delayed" ? "Preparation is temporarily delayed." : null;

  return {
    state,
    currentStep: preparationStatus === "failed" ? "failed" : "crawl",
    steps: [
      {
        id: "queued",
        label: "Request received",
        status: "complete",
        detail: null
      },
      {
        id: preparationStatus === "failed" ? "failed" : "crawl",
        label: "Preparing research",
        status: preparationStatus,
        detail: preparationDetail
      }
    ],
    errorSummary: failed ? "The research workflow could not be prepared. Please try again." : null
  };
}

function assertCents(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new WorkflowBudgetError();
}

function hashStable(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
