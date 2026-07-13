import "server-only";
import { getServerEnv, hasSupabaseEnv } from "@/lib/env";
import { DeterministicWorkflowAdapter } from "@/lib/workflow/deterministic-adapter";
import { MemoryWorkflowStore } from "@/lib/workflow/memory-store";
import { getWorkflowQueue } from "@/lib/workflow/queue-factory";
import { DurableWorkflowRunner } from "@/lib/workflow/runner";
import type { WorkflowDispatcher, WorkflowStore } from "@/lib/workflow/store";
import { WorkflowConfigurationError } from "@/lib/workflow/store";
import { SupabaseQueueOrchestrator } from "@/lib/workflow/supabase-queue-orchestrator";
import { SupabaseWorkflowStore } from "@/lib/workflow/supabase-store";

let workflowStore: WorkflowStore | null = null;
let workflowDispatcher: WorkflowDispatcher | null = null;

export function getWorkflowStore(): WorkflowStore {
  if (workflowStore) return workflowStore;
  const env = getServerEnv();

  if (env.REPORT_USE_MEMORY_STORE) {
    if (process.env.NODE_ENV === "production") {
      throw new WorkflowConfigurationError("Production requires Supabase workflow storage.");
    }
    workflowStore = new MemoryWorkflowStore();
    return workflowStore;
  }

  if (hasSupabaseEnv(env) && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    workflowStore = SupabaseWorkflowStore.fromEnv({ url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY });
    return workflowStore;
  }

  if (process.env.NODE_ENV === "production") {
    throw new WorkflowConfigurationError("Production requires Supabase workflow storage.");
  }

  throw new WorkflowConfigurationError("Memory workflow storage must be explicitly enabled.");
}

export function getWorkflowDispatcher(store = getWorkflowStore()): WorkflowDispatcher {
  if (workflowDispatcher) return workflowDispatcher;
  const env = getServerEnv();
  workflowDispatcher = env.REPORT_USE_MEMORY_STORE
    ? new DeterministicWorkflowAdapter(store, new DurableWorkflowRunner(store, { leaseSeconds: env.WORKFLOW_LEASE_SECONDS }))
    : new SupabaseQueueOrchestrator(store, getWorkflowQueue());
  return workflowDispatcher;
}

export function setWorkflowStoreForTests(store: WorkflowStore | null) {
  workflowStore = store;
  workflowDispatcher = null;
}

export function setWorkflowDispatcherForTests(dispatcher: WorkflowDispatcher | null) {
  workflowDispatcher = dispatcher;
}
