import "server-only";
import type { ServerEnv } from "@/lib/env";
import { getServerEnv } from "@/lib/env";
import { createWorkflowWakeupHeaders, WORKFLOW_WAKEUP_PATH } from "@/lib/workflow/wakeup-auth";

export async function wakeWorkflowConsumer(
  options: {
    env?: ServerEnv;
    fetcher?: typeof fetch;
    now?: Date;
    nonce?: string;
    baseUrl?: string;
  } = {}
) {
  const env = options.env ?? getServerEnv();
  if (!env.WORKFLOW_WAKEUP_SECRET) throw new Error("Workflow wakeup authorization is not configured.");
  const baseUrl = options.baseUrl ?? process.env.DEPLOY_PRIME_URL ?? env.NEXT_PUBLIC_SITE_URL;
  const url = new URL(WORKFLOW_WAKEUP_PATH, baseUrl);
  const response = await (options.fetcher ?? fetch)(url, {
    method: "POST",
    headers: createWorkflowWakeupHeaders(env.WORKFLOW_WAKEUP_SECRET, {
      now: options.now,
      nonce: options.nonce
    }),
    redirect: "error",
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error("Workflow consumer wakeup was not accepted.");
}

export async function wakeWorkflowConsumerBestEffort(options: Parameters<typeof wakeWorkflowConsumer>[0] = {}) {
  try {
    await wakeWorkflowConsumer(options);
    return true;
  } catch {
    return false;
  }
}
