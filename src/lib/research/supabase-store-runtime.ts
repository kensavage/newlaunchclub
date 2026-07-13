import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  CompanyProfileReadModel,
  ProviderOperationKind,
  ProviderOperationRecord
} from "@/lib/research/contracts";
import type {
  ProviderAttemptLease,
  ProviderResearchInput,
  ProviderResearchStore
} from "@/lib/research/store";

export class SupabaseProviderResearchStore implements ProviderResearchStore {
  constructor(private readonly supabase: SupabaseClient) {}

  static fromEnv(input: { url: string; serviceRoleKey: string }) {
    return new SupabaseProviderResearchStore(createClient(input.url, input.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    }));
  }

  getResearchInput(workflowId: string) {
    return this.rpcNullable<ProviderResearchInput>("get_provider_research_input", {
      p_workflow_id: workflowId
    });
  }

  ensureOperation(input: Parameters<ProviderResearchStore["ensureOperation"]>[0]) {
    return this.rpc<ProviderOperationRecord>("ensure_provider_operation", {
      p_workflow_id: input.workflowId,
      p_step_key: input.stepKey,
      p_provider: input.provider,
      p_operation_kind: input.operationKind,
      p_idempotency_key: input.idempotencyKey,
      p_request_fingerprint: input.requestFingerprint,
      p_estimated_cost_cents: input.estimatedCostCents,
      p_maximum_attempts: input.maximumAttempts,
      p_now: input.now ?? new Date().toISOString()
    });
  }

  getOperation(workflowId: string, operationKind: ProviderOperationKind) {
    return this.rpcNullable<ProviderOperationRecord>("get_provider_operation", {
      p_workflow_id: workflowId,
      p_operation_kind: operationKind
    });
  }

  beginOperationAttempt(operationId: string, phase: "submit" | "poll" | "persist", now = new Date().toISOString()) {
    return this.rpc<ProviderAttemptLease>("begin_provider_operation_attempt", {
      p_operation_id: operationId,
      p_phase: phase,
      p_now: now
    });
  }

  recordProviderJob(input: Parameters<ProviderResearchStore["recordProviderJob"]>[0]) {
    return this.rpc<ProviderOperationRecord>("record_provider_job", {
      p_operation_id: input.operationId,
      p_attempt_id: input.attemptId,
      p_provider_job_id: input.providerJobId,
      p_http_status: input.httpStatus,
      p_provider_usage: input.providerUsage,
      p_provider_created_at: input.providerCreatedAt,
      p_now: input.now ?? new Date().toISOString()
    });
  }

  scheduleOperationRetry(input: Parameters<ProviderResearchStore["scheduleOperationRetry"]>[0]) {
    return this.rpc<ProviderOperationRecord>("schedule_provider_operation_retry", {
      p_operation_id: input.operationId,
      p_attempt_id: input.attemptId,
      p_http_status: input.httpStatus,
      p_retry_at: input.retryAt,
      p_safe_code: input.safeCode,
      p_safe_summary: input.safeSummary,
      p_now: input.now ?? new Date().toISOString()
    });
  }

  failOperation(input: Parameters<ProviderResearchStore["failOperation"]>[0]) {
    return this.rpc<ProviderOperationRecord>("fail_provider_operation", {
      p_operation_id: input.operationId,
      p_attempt_id: input.attemptId,
      p_state: input.state,
      p_http_status: input.httpStatus,
      p_safe_code: input.safeCode,
      p_safe_summary: input.safeSummary,
      p_now: input.now ?? new Date().toISOString()
    });
  }

  storeWebsitePage(operationId: string, page: Parameters<ProviderResearchStore["storeWebsitePage"]>[1]) {
    return this.rpc<Awaited<ReturnType<ProviderResearchStore["storeWebsitePage"]>>>(
      "store_website_research_page",
      {
        p_operation_id: operationId,
        p_page_index: page.pageIndex,
        p_source_url: page.sourceUrl,
        p_canonical_url: page.canonicalUrl,
        p_title: page.title,
        p_description: page.description,
        p_markdown_content: page.markdown,
        p_content_hash: page.contentHash,
        p_raw_payload: page.rawArtifact,
        p_provider_created_at: page.providerCreatedAt,
        p_crawled_at: page.crawledAt,
        p_fresh_until: page.freshUntil
      }
    );
  }

  completeWebsiteOperation(input: Parameters<ProviderResearchStore["completeWebsiteOperation"]>[0]) {
    return this.rpc<ProviderOperationRecord>("complete_website_research_operation", {
      p_operation_id: input.operationId,
      p_attempt_id: input.attemptId,
      p_http_status: input.httpStatus,
      p_provider_usage: input.providerUsage,
      p_actual_cost_cents: input.actualCostCents,
      p_provider_completed_at: input.providerCompletedAt,
      p_now: input.now ?? new Date().toISOString()
    });
  }

  getWebsiteEvidence(workflowId: string) {
    return this.rpcNullable<Awaited<ReturnType<ProviderResearchStore["getWebsiteEvidence"]>>>(
      "get_website_research_evidence",
      { p_workflow_id: workflowId }
    );
  }

  persistCompanyProfile(input: Parameters<ProviderResearchStore["persistCompanyProfile"]>[0]) {
    return this.rpc<Awaited<ReturnType<ProviderResearchStore["persistCompanyProfile"]>>>(
      "persist_company_profile",
      modelPersistenceArgs(input, {
        p_profile: input.result.output,
        p_research_fresh_at: input.researchFreshAt,
        p_fresh_until: input.freshUntil
      })
    );
  }

  getLatestCompanyProfile(workflowId: string) {
    return this.rpcNullable<CompanyProfileReadModel>("get_latest_company_profile", {
      p_workflow_id: workflowId
    });
  }

  persistSearchQueries(input: Parameters<ProviderResearchStore["persistSearchQueries"]>[0]) {
    return this.rpc<Awaited<ReturnType<ProviderResearchStore["persistSearchQueries"]>>>(
      "persist_search_query_set",
      modelPersistenceArgs(input, {
        p_profile_version_id: input.profileVersionId,
        p_queries: input.result.output.queries,
        p_research_fresh_at: input.researchFreshAt,
        p_fresh_until: input.freshUntil
      })
    );
  }

  private async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.supabase.rpc(name, args);
    if (error) throw new Error(`Provider research storage operation failed: ${name}.`);
    return data as T;
  }

  private async rpcNullable<T>(name: string, args: Record<string, unknown>): Promise<T | null> {
    return (await this.rpc<T | null>(name, args)) ?? null;
  }
}

function modelPersistenceArgs(
  input: Parameters<ProviderResearchStore["persistCompanyProfile"]>[0] |
    Parameters<ProviderResearchStore["persistSearchQueries"]>[0],
  extra: Record<string, unknown>
) {
  return {
    p_operation_id: input.operationId,
    p_attempt_id: input.attemptId,
    p_model_identifier: input.result.model,
    p_provider_request_id: input.result.providerRequestId,
    p_prompt_template_version: input.result.promptTemplateVersion,
    p_input_hash: input.inputHash,
    p_output_hash: input.outputHash,
    p_input_tokens: input.result.usage.inputTokens,
    p_output_tokens: input.result.usage.outputTokens,
    p_total_tokens: input.result.usage.totalTokens,
    p_provider_usage: input.result.usage,
    p_reserved_cost_cents: input.reservedCostCents,
    p_actual_cost_cents: input.actualCostCents,
    p_provider_created_at: input.result.providerCreatedAt,
    p_now: input.now ?? new Date().toISOString(),
    ...extra
  };
}
