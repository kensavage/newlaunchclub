import { hasSupabaseEnv, type ServerEnv } from "../../src/lib/env-schema";
import { SupabaseWorkflowQueue, type WorkflowQueue } from "../../src/lib/workflow/queue-runtime";
import { WorkflowConfigurationError, type WorkflowStore } from "../../src/lib/workflow/store";
import { SupabaseWorkflowStore } from "../../src/lib/workflow/supabase-store-runtime";

let workflowQueue: WorkflowQueue | null = null;
let workflowStore: WorkflowStore | null = null;

export function getNetlifyWorkflowQueue(env: ServerEnv): WorkflowQueue {
  if (workflowQueue) return workflowQueue;
  assertDurableRuntime(env);
  workflowQueue = SupabaseWorkflowQueue.fromEnv({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY
  });
  return workflowQueue;
}

export function getNetlifyWorkflowStore(env: ServerEnv): WorkflowStore {
  if (workflowStore) return workflowStore;
  assertDurableRuntime(env);
  workflowStore = SupabaseWorkflowStore.fromEnv({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY
  });
  return workflowStore;
}

function assertDurableRuntime(env: ServerEnv): asserts env is ServerEnv & {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
} {
  if (env.REPORT_USE_MEMORY_STORE || !hasSupabaseEnv(env)) {
    throw new WorkflowConfigurationError("The Netlify workflow runtime requires durable Supabase storage.");
  }
}
