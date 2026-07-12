import "server-only";
import { AsyncWorkloadsClient } from "@netlify/async-workloads";
import { WORKFLOW_EVENT_NAME, workflowEventPayloadSchema, type WorkflowEventPayload, type WorkflowStepKey } from "@/lib/workflow/schema";
import type { WorkflowDispatcher, WorkflowStore } from "@/lib/workflow/store";

interface LaunchClubWorkflowEvent {
  eventName: typeof WORKFLOW_EVENT_NAME;
  eventData: WorkflowEventPayload;
}
export class NetlifyWorkflowAdapter implements WorkflowDispatcher {
  private readonly client: AsyncWorkloadsClient<LaunchClubWorkflowEvent>;

  constructor(private readonly store: WorkflowStore, options: { baseUrl?: string; apiKey?: string } = {}) {
    this.client = new AsyncWorkloadsClient<LaunchClubWorkflowEvent>(options);
  }

  async dispatchWorkflow(input: WorkflowEventPayload) {
    const payload = workflowEventPayloadSchema.parse(input);
    assertWorkflowEventPayloadSize(payload);
    const result = await this.client.send(WORKFLOW_EVENT_NAME, { data: payload });
    if (result.sendStatus !== "succeeded") throw new Error("Workflow dispatch was not acknowledged.");
    return { eventId: result.eventId };
  }

  async resumeWorkflow(workflowId: string) {
    throw new Error(`Use the authenticated administrator service to resume ${workflowId}.`);
  }

  async pauseWorkflow(workflowId: string) {
    throw new Error(`Use the authenticated administrator service to pause ${workflowId}.`);
  }

  async cancelWorkflow(workflowId: string) {
    throw new Error(`Use the authenticated administrator service to cancel ${workflowId}.`);
  }

  async retryWorkflow(workflowId: string) {
    throw new Error(`Use the authenticated administrator service to retry ${workflowId}.`);
  }

  async retryStep(workflowId: string, stepKey: WorkflowStepKey) {
    throw new Error(`Use the authenticated administrator service to retry ${workflowId}:${stepKey}.`);
  }

  async getWorkflowStatus(workflowId: string) {
    return this.store.getWorkflow(workflowId);
  }
}

export function assertWorkflowEventPayloadSize(payload: WorkflowEventPayload, maximumBytes = 32_768) {
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (bytes > maximumBytes) throw new Error("Workflow event payload exceeds the safe identifier-only limit.");
  return bytes;
}
