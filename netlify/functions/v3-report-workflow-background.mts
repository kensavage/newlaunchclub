import { getServerEnv } from "../../src/lib/env";
import { WorkflowQueueConsumer } from "../../src/lib/workflow/queue-consumer";
import { getWorkflowQueue } from "../../src/lib/workflow/queue-factory";
import { getWorkflowStore } from "../../src/lib/workflow/store-factory";
import { verifyWorkflowWakeupRequest, WORKFLOW_WAKEUP_PATH } from "../../src/lib/workflow/wakeup-auth";
import { wakeWorkflowConsumerBestEffort } from "../../src/lib/workflow/wakeup-client";

export default async function consumeV3WorkflowQueue(request: Request) {
  const env = getServerEnv();
  const queue = getWorkflowQueue();
  const authorized = env.WORKFLOW_WAKEUP_SECRET
    ? await verifyWorkflowWakeupRequest(request, queue, {
        secret: env.WORKFLOW_WAKEUP_SECRET,
        ttlSeconds: env.WORKFLOW_WAKEUP_TTL_SECONDS
      })
    : false;
  if (!authorized) return new Response("Not found", { status: 404 });

  try {
    const consumer = new WorkflowQueueConsumer(getWorkflowStore(), queue, {
      batchSize: env.WORKFLOW_QUEUE_BATCH_SIZE,
      visibilityTimeoutSeconds: env.WORKFLOW_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
      leaseSeconds: env.WORKFLOW_LEASE_SECONDS,
      maximumRuntimeMilliseconds: env.WORKFLOW_CONSUMER_MAX_RUNTIME_SECONDS * 1_000
    });
    const result = await consumer.consume();
    if (result.needsWake) await wakeWorkflowConsumerBestEffort({ env });
  } catch {
    console.error("V3 workflow queue processing stopped safely; the durable message remains recoverable.");
  }

  return new Response(null, { status: 202 });
}

export const config = {
  background: true,
  path: WORKFLOW_WAKEUP_PATH
};
