import "server-only";
import crypto from "node:crypto";
import { getServerEnv } from "@/lib/env";
import { INITIAL_WORKFLOW_STEPS, workflowStatusSchema, type WorkflowStepKey } from "@/lib/workflow/schema";
import type { AdminActor, WorkflowStore } from "@/lib/workflow/store";

export function createServerCliAdminActor(): AdminActor {
  const secret = getServerEnv().WORKFLOW_ADMIN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("WORKFLOW_ADMIN_SECRET must be configured for administrator recovery.");
  }
  return {
    actorId: `server-cli:${crypto.createHash("sha256").update(secret).digest("hex").slice(0, 16)}`,
    authenticated: true
  };
}
export class WorkflowAdministratorService {
  constructor(private readonly store: WorkflowStore, private readonly actor: AdminActor) {
    if (!actor.authenticated) throw new Error("Administrator authentication is required.");
  }

  list(options: { status?: string; limit?: number; stalledMinutes?: number } = {}) {
    const status = options.status ? workflowStatusSchema.parse(options.status) : undefined;
    const stalledBefore = options.stalledMinutes
      ? new Date(Date.now() - options.stalledMinutes * 60_000).toISOString()
      : undefined;
    return this.store.listWorkflows({ status, limit: options.limit, stalledBefore });
  }

  show(workflowId: string) {
    return this.store.getWorkflowDetail(workflowId);
  }

  retry(workflowId: string) {
    return this.store.retryWorkflow(workflowId, this.actor);
  }

  retryStep(workflowId: string, stepKey: string) {
    return this.store.retryStep(workflowId, parseStepKey(stepKey), this.actor);
  }

  pause(workflowId: string) {
    return this.store.pauseWorkflow(workflowId, this.actor);
  }

  resume(workflowId: string) {
    return this.store.resumeWorkflow(workflowId, this.actor);
  }

  cancel(workflowId: string) {
    return this.store.cancelWorkflow(workflowId, this.actor);
  }

  releaseExpiredLease(workflowId: string, stepKey: string) {
    return this.store.releaseExpiredLease(workflowId, parseStepKey(stepKey), this.actor);
  }
}

function parseStepKey(value: string): WorkflowStepKey {
  if (!INITIAL_WORKFLOW_STEPS.includes(value as WorkflowStepKey)) {
    throw new Error(`Unknown workflow step: ${value}`);
  }
  return value as WorkflowStepKey;
}
