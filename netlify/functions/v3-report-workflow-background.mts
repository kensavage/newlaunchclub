import { getNetlifyRuntimeEnv } from "../runtime/env";
import { getNetlifyWorkflowQueue, getNetlifyWorkflowStore } from "../runtime/workflow-runtime";
import { getNetlifyProviderResearchStore } from "../runtime/provider-research-runtime";
import { wakeNetlifyWorkflowConsumerBestEffort } from "../runtime/wakeup-client";
import { WorkflowQueueConsumer } from "../../src/lib/workflow/queue-consumer-runtime";
import {
  emitWorkflowWakeupLog,
  verifyWorkflowWakeupRequest
} from "../../src/lib/workflow/wakeup-runtime";
import { DurableWorkflowRunner } from "../../src/lib/workflow/runner";
import { CompositeResearchWorkflowRunner } from "../../src/lib/research/composite-runner";
import {
  createProviderResearchProviders,
  getProviderResearchReservationPolicy
} from "../../src/lib/research/provider-factory";
import {
  ConfigurationFailureProviderResearchRunner,
  ProviderResearchContinuation,
  ProviderResearchWorkflowRunner
} from "../../src/lib/research/runner";
import { ProviderResearchError } from "../../src/lib/research/contracts";

export default async function consumeV3WorkflowQueue(request: Request) {
  const env = getNetlifyRuntimeEnv();
  const queue = getNetlifyWorkflowQueue(env);
  const authorized = env.WORKFLOW_WAKEUP_SECRET
    ? await verifyWorkflowWakeupRequest(request, queue, {
        secret: env.WORKFLOW_WAKEUP_SECRET,
        ttlSeconds: env.WORKFLOW_WAKEUP_TTL_SECONDS
      })
    : false;
  if (!authorized) {
    emitWorkflowWakeupLog({
      event: "workflow_wakeup",
      stage: "receiver",
      outcome: "rejected",
      source: "unknown",
      reason: "authentication_failed"
    });
    return new Response("Not found", { status: 404 });
  }

  emitWorkflowWakeupLog({
    event: "workflow_wakeup",
    stage: "receiver",
    outcome: "accepted",
    source: "unknown"
  });

  try {
    const workflowStore = getNetlifyWorkflowStore(env);
    let runner;
    let providerResearchContinuation;
    if (env.V3_PROVIDER_RESEARCH_ENABLED) {
      const reservations = getProviderResearchReservationPolicy(env);
      providerResearchContinuation = new ProviderResearchContinuation(
        workflowStore,
        reservations,
        env.WORKFLOW_MAX_ATTEMPTS
      );
      try {
        const providers = createProviderResearchProviders(env);
        const providerRunner = new ProviderResearchWorkflowRunner(
          workflowStore,
          getNetlifyProviderResearchStore(env),
          providers,
          {
            leaseSeconds: env.WORKFLOW_LEASE_SECONDS,
            maximumAttempts: env.WORKFLOW_MAX_ATTEMPTS
          }
        );
        runner = new CompositeResearchWorkflowRunner(
          new DurableWorkflowRunner(workflowStore, { leaseSeconds: env.WORKFLOW_LEASE_SECONDS }),
          providerRunner
        );
      } catch (error) {
        const failure = error instanceof ProviderResearchError
          ? error
          : new ProviderResearchError(
              "configuration_error",
              "provider_research_configuration",
              "Provider research requires administrator configuration."
            );
        runner = new CompositeResearchWorkflowRunner(
          new DurableWorkflowRunner(workflowStore, { leaseSeconds: env.WORKFLOW_LEASE_SECONDS }),
          new ConfigurationFailureProviderResearchRunner(
            workflowStore,
            failure,
            env.WORKFLOW_LEASE_SECONDS
          )
        );
      }
    }
    const consumer = new WorkflowQueueConsumer(workflowStore, queue, {
      batchSize: env.WORKFLOW_QUEUE_BATCH_SIZE,
      visibilityTimeoutSeconds: env.WORKFLOW_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
      leaseSeconds: env.WORKFLOW_LEASE_SECONDS,
      maximumRuntimeMilliseconds: env.WORKFLOW_CONSUMER_MAX_RUNTIME_SECONDS * 1_000,
      runner,
      providerResearchContinuation
    });
    const result = await consumer.consume();
    if (result.needsWake) {
      await wakeNetlifyWorkflowConsumerBestEffort({ env, source: "continuation" });
    }
  } catch {
    emitWorkflowWakeupLog({
      event: "workflow_wakeup",
      stage: "processing",
      outcome: "failed",
      source: "unknown",
      reason: "consumer_failed"
    });
  }

  return new Response(null, { status: 202 });
}

export const config = {
  background: true
};
