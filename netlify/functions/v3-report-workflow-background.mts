import { getNetlifyRuntimeEnv } from "../runtime/env";
import { getNetlifyWorkflowQueue, getNetlifyWorkflowStore } from "../runtime/workflow-runtime";
import { wakeNetlifyWorkflowConsumerBestEffort } from "../runtime/wakeup-client";
import { WorkflowQueueConsumer } from "../../src/lib/workflow/queue-consumer-runtime";
import { verifyWorkflowWakeupRequest } from "../../src/lib/workflow/wakeup-runtime";

export default async function consumeV3WorkflowQueue(request: Request) {
  const env = getNetlifyRuntimeEnv();
  const queue = getNetlifyWorkflowQueue(env);
  const authorized = env.WORKFLOW_WAKEUP_SECRET
    ? await verifyWorkflowWakeupRequest(request, queue, {
        secret: env.WORKFLOW_WAKEUP_SECRET,
        ttlSeconds: env.WORKFLOW_WAKEUP_TTL_SECONDS
      })
    : false;
  if (!authorized) return new Response("Not found", { status: 404 });

  try {
    const consumer = new WorkflowQueueConsumer(getNetlifyWorkflowStore(env), queue, {
      batchSize: env.WORKFLOW_QUEUE_BATCH_SIZE,
      visibilityTimeoutSeconds: env.WORKFLOW_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
      leaseSeconds: env.WORKFLOW_LEASE_SECONDS,
      maximumRuntimeMilliseconds: env.WORKFLOW_CONSUMER_MAX_RUNTIME_SECONDS * 1_000
    });
    const result = await consumer.consume();
    if (result.needsWake) await wakeNetlifyWorkflowConsumerBestEffort({ env });
  } catch {
    console.error("V3 workflow queue processing stopped safely; the durable message remains recoverable.");
  }

  return new Response(null, { status: 202 });
}

export const config = {
  background: true
};
