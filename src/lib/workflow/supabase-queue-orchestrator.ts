import "server-only";
import { parseWorkflowQueuePayload, workflowQueueIdempotencyKey, type WorkflowQueue } from "@/lib/workflow/queue";
import type { WorkflowQueuePayload, WorkflowStepKey } from "@/lib/workflow/schema";
import type { AdminActor, WorkflowDispatcher, WorkflowStore } from "@/lib/workflow/store";

const orchestratorActor: AdminActor = {
  actorId: "supabase-queue-orchestrator",
  authenticated: true
};

export class SupabaseQueueOrchestrator implements WorkflowDispatcher {
  constructor(private readonly store: WorkflowStore, private readonly queue: WorkflowQueue) {}

  async dispatchWorkflow(input: WorkflowQueuePayload) {
    const payload = parseWorkflowQueuePayload(input);
    const result = await this.queue.enqueue(payload, workflowQueueIdempotencyKey(payload));
    return { eventId: `pgmq:${result.messageId}` };
  }

  async resumeWorkflow(workflowId: string) {
    await this.store.resumeWorkflow(workflowId, orchestratorActor);
  }

  async pauseWorkflow(workflowId: string) {
    await this.store.pauseWorkflow(workflowId, orchestratorActor);
  }

  async cancelWorkflow(workflowId: string) {
    await this.store.cancelWorkflow(workflowId, orchestratorActor);
  }

  async retryWorkflow(workflowId: string) {
    await this.store.retryWorkflow(workflowId, orchestratorActor);
  }

  async retryStep(workflowId: string, stepKey: WorkflowStepKey) {
    await this.store.retryStep(workflowId, stepKey, orchestratorActor);
  }

  async getWorkflowStatus(workflowId: string) {
    return this.store.getWorkflow(workflowId);
  }
}
