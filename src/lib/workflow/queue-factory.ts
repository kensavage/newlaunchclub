import "server-only";
import { getServerEnv, hasSupabaseEnv } from "@/lib/env";
import { MemoryWorkflowQueue, SupabaseWorkflowQueue, type WorkflowQueue } from "@/lib/workflow/queue";
import { WorkflowConfigurationError } from "@/lib/workflow/store";

let workflowQueue: WorkflowQueue | null = null;

export function getWorkflowQueue(): WorkflowQueue {
  if (workflowQueue) return workflowQueue;
  const env = getServerEnv();

  if (env.REPORT_USE_MEMORY_STORE) {
    if (process.env.NODE_ENV === "production") {
      throw new WorkflowConfigurationError("Production requires the durable Supabase workflow queue.");
    }
    workflowQueue = new MemoryWorkflowQueue();
    return workflowQueue;
  }

  if (hasSupabaseEnv(env) && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    workflowQueue = SupabaseWorkflowQueue.fromEnv({
      url: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY
    });
    return workflowQueue;
  }

  throw new WorkflowConfigurationError("The durable Supabase workflow queue is not configured.");
}

export function setWorkflowQueueForTests(queue: WorkflowQueue | null) {
  workflowQueue = queue;
}
