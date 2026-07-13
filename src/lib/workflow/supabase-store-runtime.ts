import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  CostBudgetRecord,
  CostEntryRecord,
  OutboxEventRecord,
  SafeWorkflowProgress,
  WorkflowDetail,
  WorkflowRecord,
  WorkflowStepKey
} from "@/lib/workflow/schema";
import type {
  AdminActor,
  CleanupResult,
  CreateWorkflowInput,
  LegacyReadiness,
  RecoveryPreparation,
  StepFailureInput,
  StepLeaseResult,
  WorkflowListFilter,
  WorkflowStore
} from "@/lib/workflow/store";

export class SupabaseWorkflowStore implements WorkflowStore {
  constructor(private readonly supabase: SupabaseClient) {}

  static fromEnv({ url, serviceRoleKey }: { url: string; serviceRoleKey: string }) {
    return new SupabaseWorkflowStore(createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    }));
  }

  async registerReportIdentity() {
    // Identity is already canonical in report_requests/company_contacts.
  }

  async createInitialWorkflow(input: CreateWorkflowInput, now = new Date().toISOString()) {
    return this.rpcJson<WorkflowRecord>("create_initial_research_workflow", {
      p_report_request_id: input.reportRequestId,
      p_report_id: input.reportId,
      p_input_hash: input.inputHash,
      p_correlation_id: input.correlationId,
      p_priority: input.priority ?? 0,
      p_workflow_version: input.workflowVersion ?? 1,
      p_orchestrator_backend: input.orchestratorBackend ?? "supabase_queue",
      p_maximum_attempts: input.maximumAttempts ?? 4,
      p_now: now
    });
  }

  async getWorkflow(workflowId: string) {
    return this.rpcJsonNullable<WorkflowRecord>("get_research_workflow", { p_workflow_id: workflowId });
  }

  async getWorkflowByReportRequest(reportRequestId: string) {
    return this.rpcJsonNullable<WorkflowRecord>("get_research_workflow_by_request", { p_report_request_id: reportRequestId });
  }

  async getWorkflowDetail(workflowId: string) {
    return this.rpcJsonNullable<WorkflowDetail>("get_research_workflow_detail", { p_workflow_id: workflowId });
  }

  async getPublicProgress(reportRequestId: string) {
    return this.rpcJsonNullable<SafeWorkflowProgress>("get_public_workflow_progress", { p_report_request_id: reportRequestId });
  }

  async listWorkflows(filter: WorkflowListFilter = {}) {
    return this.rpcJson<WorkflowRecord[]>("list_research_workflows", {
      p_status: filter.status ?? null,
      p_limit: filter.limit ?? 50,
      p_stalled_before: filter.stalledBefore ?? null
    });
  }

  async claimOutbox({ owner, limit, leaseSeconds, now = new Date().toISOString() }: {
    owner: string; limit: number; leaseSeconds: number; now?: string;
  }) {
    return this.rpcJson<OutboxEventRecord[]>("claim_workflow_outbox", { p_owner: owner, p_limit: limit, p_lease_seconds: leaseSeconds, p_now: now });
  }

  async markOutboxSent({ outboxId, owner, externalEventId, now = new Date().toISOString() }: {
    outboxId: string; owner: string; externalEventId: string; now?: string;
  }) {
    return this.rpcJson<boolean>("mark_workflow_outbox_sent", { p_outbox_id: outboxId, p_owner: owner, p_external_event_id: externalEventId, p_now: now });
  }

  async markOutboxFailed({ outboxId, owner, safeError, retryAt, now = new Date().toISOString() }: {
    outboxId: string; owner: string; safeError: string; retryAt: string; now?: string;
  }) {
    return this.rpcJson<boolean>("mark_workflow_outbox_failed", { p_outbox_id: outboxId, p_owner: owner, p_safe_error: safeError, p_retry_at: retryAt, p_now: now });
  }

  async beginStep({ workflowId, stepKey, owner, leaseSeconds, now = new Date().toISOString() }: {
    workflowId: string; stepKey: WorkflowStepKey; owner: string; leaseSeconds: number; now?: string;
  }) {
    return this.rpcJson<StepLeaseResult>("begin_research_step", { p_workflow_id: workflowId, p_step_key: stepKey, p_owner: owner, p_lease_seconds: leaseSeconds, p_now: now });
  }

  async heartbeatLease({ workflowId, stepKey, owner, fencingToken, leaseSeconds, now = new Date().toISOString() }: {
    workflowId: string; stepKey: WorkflowStepKey; owner: string; fencingToken: number; leaseSeconds: number; now?: string;
  }) {
    return this.rpcJson<boolean>("heartbeat_research_lease", { p_workflow_id: workflowId, p_step_key: stepKey, p_owner: owner, p_fencing_token: fencingToken, p_lease_seconds: leaseSeconds, p_now: now });
  }

  async completeStep({ workflowId, stepKey, owner, fencingToken, outputReference = "database", now = new Date().toISOString() }: {
    workflowId: string; stepKey: WorkflowStepKey; owner: string; fencingToken: number; outputReference?: string; now?: string;
  }) {
    return this.rpcJson<boolean>("complete_research_step", { p_workflow_id: workflowId, p_step_key: stepKey, p_owner: owner, p_fencing_token: fencingToken, p_output_reference: outputReference, p_now: now });
  }

  async failStep(input: StepFailureInput) {
    await this.rpcJson("fail_research_step", {
      p_workflow_id: input.workflowId,
      p_step_key: input.stepKey,
      p_owner: input.owner,
      p_fencing_token: input.fencingToken,
      p_classification: input.classification,
      p_safe_code: input.safeCode,
      p_safe_summary: input.safeSummary,
      p_retry_at: input.retryAt ?? null,
      p_now: input.now ?? new Date().toISOString()
    });
  }

  async ensureBudget(workflowId: string, budgetType: "initial_report" | "weekly_refresh" = "initial_report") {
    return this.rpcJson<CostBudgetRecord>("ensure_report_cost_budget", { p_workflow_id: workflowId, p_budget_type: budgetType });
  }

  async reserveCost(input: { workflowId: string; stepId: string | null; amountCents: number; idempotencyKey: string; now?: string }) {
    return this.rpcJson<CostEntryRecord>("reserve_report_cost", { p_workflow_id: input.workflowId, p_step_id: input.stepId, p_amount_cents: input.amountCents, p_idempotency_key: input.idempotencyKey, p_now: input.now ?? new Date().toISOString() });
  }

  async recordActualCost(input: { workflowId: string; stepId: string | null; attemptId: string | null; reservedCents: number; actualCents: number; idempotencyKey: string; now?: string }) {
    return this.rpcJson<CostEntryRecord>("record_report_cost", { p_workflow_id: input.workflowId, p_step_id: input.stepId, p_attempt_id: input.attemptId, p_reserved_cents: input.reservedCents, p_actual_cents: input.actualCents, p_idempotency_key: input.idempotencyKey, p_now: input.now ?? new Date().toISOString() });
  }

  async releaseCost(input: { workflowId: string; stepId: string | null; amountCents: number; idempotencyKey: string; now?: string }) {
    return this.rpcJson<CostEntryRecord>("release_report_cost", { p_workflow_id: input.workflowId, p_step_id: input.stepId, p_amount_cents: input.amountCents, p_idempotency_key: input.idempotencyKey, p_now: input.now ?? new Date().toISOString() });
  }

  async pauseWorkflow(workflowId: string, actor: AdminActor, now = new Date().toISOString()) {
    await this.adminCommand(workflowId, "pause", null, actor, now);
  }

  async resumeWorkflow(workflowId: string, actor: AdminActor, now = new Date().toISOString()) {
    await this.adminCommand(workflowId, "resume", null, actor, now);
  }

  async cancelWorkflow(workflowId: string, actor: AdminActor, now = new Date().toISOString()) {
    await this.adminCommand(workflowId, "cancel", null, actor, now);
  }

  async retryWorkflow(workflowId: string, actor: AdminActor, now = new Date().toISOString()) {
    await this.adminCommand(workflowId, "retry", null, actor, now);
  }

  async retryStep(workflowId: string, stepKey: WorkflowStepKey, actor: AdminActor, now = new Date().toISOString()) {
    await this.adminCommand(workflowId, "retry_step", stepKey, actor, now);
  }

  async releaseExpiredLease(workflowId: string, stepKey: WorkflowStepKey, actor: AdminActor, now = new Date().toISOString()) {
    return this.rpcJson<boolean>("admin_release_expired_research_lease", { p_workflow_id: workflowId, p_step_key: stepKey, p_actor_id: actor.actorId, p_now: now });
  }

  async prepareAccessRecovery(input: { publicProgressId: string; normalizedEmail: string; recoveryTokenHash: string; rawRecoveryToken: string; expiresAt: string; now?: string }): Promise<RecoveryPreparation> {
    const result = await this.rpcJsonNullable<{ reportId: string; normalizedEmail: string }>("prepare_report_access_recovery", { p_public_progress_id: input.publicProgressId, p_normalized_email: input.normalizedEmail, p_recovery_token_hash: input.recoveryTokenHash, p_expires_at: input.expiresAt, p_now: input.now ?? new Date().toISOString() });
    return { accepted: true, delivery: result ? { reportId: result.reportId, normalizedEmail: result.normalizedEmail, recoveryToken: input.rawRecoveryToken, expiresAt: input.expiresAt } : null };
  }

  async consumeAccessRecovery(input: { recoveryTokenHash: string; newAccessTokenHash: string; accessExpiresAt: string; now?: string }) {
    return this.rpcJsonNullable<{ reportId: string }>("consume_report_access_recovery", { p_recovery_token_hash: input.recoveryTokenHash, p_new_access_token_hash: input.newAccessTokenHash, p_access_expires_at: input.accessExpiresAt, p_now: input.now ?? new Date().toISOString() });
  }

  async cleanupSecurityArtifacts(input: { revokedTokenBefore: string; accessEventsBefore: string; recoveryTokenBefore: string }): Promise<CleanupResult> {
    return this.rpcJson<CleanupResult>("cleanup_report_security_artifacts", { p_revoked_token_before: input.revokedTokenBefore, p_access_events_before: input.accessEventsBefore, p_recovery_token_before: input.recoveryTokenBefore });
  }

  async recordLegacyAccess(input: { legacyPublicIdHash: string; requestSignalHash: string; userAgentCategory: "browser" | "bot" | "unknown"; now?: string }) {
    await this.rpcJson("record_legacy_report_access", { p_legacy_public_id_hash: input.legacyPublicIdHash, p_request_signal_hash: input.requestSignalHash, p_user_agent_category: input.userAgentCategory, p_now: input.now ?? new Date().toISOString() });
  }

  async getLegacyReadiness(now = new Date().toISOString()) {
    return this.rpcJson<LegacyReadiness>("get_legacy_report_retirement_readiness", { p_now: now });
  }

  private async adminCommand(workflowId: string, command: string, stepKey: WorkflowStepKey | null, actor: AdminActor, now: string) {
    await this.rpcJson("admin_transition_research_workflow", { p_workflow_id: workflowId, p_command: command, p_step_key: stepKey, p_actor_id: actor.actorId, p_now: now });
  }

  private async rpcJson<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.supabase.rpc(name, args);
    if (error) throw new Error(`Workflow storage operation failed: ${name}.`);
    return data as T;
  }

  private async rpcJsonNullable<T>(name: string, args: Record<string, unknown>): Promise<T | null> {
    const data = await this.rpcJson<T | null>(name, args);
    return data ?? null;
  }
}
