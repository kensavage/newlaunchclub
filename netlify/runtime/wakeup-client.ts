import type { ServerEnv } from "./env";
import { getNetlifyRuntimeEnv } from "./env";
import {
  sendWorkflowWakeup,
  type WorkflowWakeupLogger,
  type WorkflowWakeupSource
} from "../../src/lib/workflow/wakeup-runtime";

export async function wakeNetlifyWorkflowConsumer(
  options: {
    env?: ServerEnv;
    fetcher?: typeof fetch;
    now?: Date;
    nonce?: string;
    source?: WorkflowWakeupSource;
    logger?: WorkflowWakeupLogger;
  } = {}
) {
  const env = options.env ?? getNetlifyRuntimeEnv();
  await sendWorkflowWakeup({
    secret: env.WORKFLOW_WAKEUP_SECRET,
    deployPrimeUrl: process.env.DEPLOY_PRIME_URL,
    fallbackUrl: env.NEXT_PUBLIC_SITE_URL,
    fetcher: options.fetcher,
    now: options.now,
    nonce: options.nonce,
    source: options.source,
    logger: options.logger
  });
}

export async function wakeNetlifyWorkflowConsumerBestEffort(
  options: Parameters<typeof wakeNetlifyWorkflowConsumer>[0] = {}
) {
  try {
    await wakeNetlifyWorkflowConsumer(options);
    return true;
  } catch {
    return false;
  }
}
