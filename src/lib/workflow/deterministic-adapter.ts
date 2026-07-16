import type { WorkflowQueuePayload, WorkflowStepKey } from "@/lib/workflow/schema";
import type { AdminActor, WorkflowDispatcher, WorkflowStore } from "@/lib/workflow/store";
import { DurableWorkflowRunner } from "@/lib/workflow/runner";

const deterministicActor: AdminActor = {
  actorId: "deterministic-adapter",
  authenticated: true
};

export class DeterministicWorkflowAdapter implements WorkflowDispatcher {
  private readonly runner: DurableWorkflowRunner;

  constructor(private readonly store: WorkflowStore, runner?: DurableWorkflowRunner) {
    this.runner = runner ?? new DurableWorkflowRunner(store);
  }

  async dispatchWorkflow(payload: WorkflowQueuePayload) {
    await this.runner.run(payload, `deterministic:${payload.correlationId}`);
    return { eventId: `deterministic:${payload.correlationId}` };
  }

  async resumeWorkflow(workflowId: string) {
    await this.store.resumeWorkflow(workflowId, deterministicActor);
  }

  async pauseWorkflow(workflowId: string) {
    await this.store.pauseWorkflow(workflowId, deterministicActor);
  }

  async cancelWorkflow(workflowId: string) {
    await this.store.cancelWorkflow(workflowId, deterministicActor);
  }

  async retryWorkflow(workflowId: string) {
    await this.store.retryWorkflow(workflowId, deterministicActor);
  }

  async retryStep(workflowId: string, stepKey: WorkflowStepKey) {
    await this.store.retryStep(workflowId, stepKey, deterministicActor);
  }

  async getWorkflowStatus(workflowId: string) {
    return this.store.getWorkflow(workflowId);
  }
}
