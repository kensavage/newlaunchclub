import "server-only";
import type { ServerEnv } from "@/lib/env";
import { getServerEnv } from "@/lib/env";
import {
  sendWorkflowWakeup,
  type WorkflowWakeupLogger,
  type WorkflowWakeupSource
} from "@/lib/workflow/wakeup-runtime";

export async function wakeWorkflowConsumer(
  options: {
    env?: ServerEnv;
    fetcher?: typeof fetch;
    now?: Date;
    nonce?: string;
    baseUrl?: string;
    source?: WorkflowWakeupSource;
    logger?: WorkflowWakeupLogger;
  } = {}
) {
  const env = options.env ?? getServerEnv();
  await sendWorkflowWakeup({
    secret: env.WORKFLOW_WAKEUP_SECRET,
    preferredUrl: options.baseUrl,
    deployPrimeUrl: process.env.DEPLOY_PRIME_URL,
    fallbackUrl: env.NEXT_PUBLIC_SITE_URL,
    fetcher: options.fetcher,
    now: options.now,
    nonce: options.nonce,
    source: options.source,
    logger: options.logger
  });
}

export async function wakeWorkflowConsumerBestEffort(options: Parameters<typeof wakeWorkflowConsumer>[0] = {}) {
  try {
    await wakeWorkflowConsumer(options);
    return true;
  } catch {
    return false;
  }
}
