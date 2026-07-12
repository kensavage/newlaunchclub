import {
  ErrorDoNotRetry,
  ErrorRetryAfterDelay,
  asyncWorkloadFn,
  type AsyncWorkloadConfig
} from "@netlify/async-workloads";
import { getWorkflowStore } from "../../src/lib/workflow/store-factory";
import { getServerEnv } from "../../src/lib/env";
import { DurableWorkflowRunner, classifyWorkflowFailure } from "../../src/lib/workflow/runner";
import {
  INITIAL_WORKFLOW_STEPS,
  WORKFLOW_EVENT_NAME,
  workflowEventPayloadSchema,
  type WorkflowEventPayload
} from "../../src/lib/workflow/schema";

interface LaunchClubWorkflowEvent {
  eventName: typeof WORKFLOW_EVENT_NAME;
  eventData: WorkflowEventPayload;
}

export default asyncWorkloadFn<LaunchClubWorkflowEvent>(async (event) => {
  const payload = workflowEventPayloadSchema.safeParse(event.eventData);
  if (!payload.success) throw new ErrorDoNotRetry("Invalid workflow identifiers.");

  const store = getWorkflowStore();
  const runner = new DurableWorkflowRunner(store, { leaseSeconds: getServerEnv().WORKFLOW_LEASE_SECONDS });
  for (const stepKey of INITIAL_WORKFLOW_STEPS) {
    try {
      const result = await event.step.run(`${payload.data.workflowId}:${stepKey}:v1`, () =>
        runner.runStep(payload.data.workflowId, stepKey, `netlify:${event.eventId}:${stepKey}`)
      );
      if (result === "unavailable" || result === "lease_conflict") {
        const workflow = await store.getWorkflow(payload.data.workflowId);
        if (workflow?.status === "paused" || workflow?.status === "cancelled" || workflow?.status === "failed") return;
        throw new ErrorRetryAfterDelay({ message: "Workflow step is currently owned by another delivery.", retryDelay: "2s" });
      }
    } catch (error) {
      if (error instanceof ErrorRetryAfterDelay || error instanceof ErrorDoNotRetry) throw error;
      const classification = classifyWorkflowFailure(error);
      if (classification === "transient") {
        throw new ErrorRetryAfterDelay({ message: "Workflow step is temporarily unavailable.", retryDelay: "2s", error: error instanceof Error ? error : undefined });
      }
      throw new ErrorDoNotRetry("Workflow step requires administrator review.");
    }
  }
});

export const config: AsyncWorkloadConfig<LaunchClubWorkflowEvent> = {
  name: "Launch Club V3 report workflow",
  events: [WORKFLOW_EVENT_NAME],
  maxRetries: 4,
  backoffSchedule: (attempt) => Math.min(60_000, 1_000 * 2 ** attempt)
};
