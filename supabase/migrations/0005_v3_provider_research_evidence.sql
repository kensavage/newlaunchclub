-- Launch Club V3 provider research and immutable evidence foundation.
-- This migration defines storage and workflow contracts only. It does not call providers.

alter table public.research_workflows
  drop constraint if exists research_workflows_status_check;
alter table public.research_workflows
  add constraint research_workflows_status_check check (status in (
    'queued', 'dispatch_pending', 'running', 'waiting_retry', 'paused',
    'ready_for_provider_research', 'ready_for_search_intelligence',
    'partially_complete', 'completed', 'failed', 'cancelled'
  ));

alter table public.research_steps
  drop constraint if exists research_steps_step_key_check;
alter table public.research_steps
  add constraint research_steps_step_key_check check (step_key in (
    'initialize_workflow', 'validate_intake_references', 'establish_cost_budget',
    'prepare_provider_research', 'mark_ready_for_provider_research',
    'website_research', 'company_profile_extraction', 'search_query_discovery'
  ));

create table if not exists public.provider_operations (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.research_workflows(id) on delete cascade,
  step_id uuid not null references public.research_steps(id) on delete cascade,
  provider text not null check (provider in ('firecrawl', 'openai', 'mock')),
  operation_kind text not null check (operation_kind in (
    'website_research', 'company_profile_extraction', 'search_query_discovery'
  )),
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 250),
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  operation_state text not null default 'reserved' check (operation_state in (
    'reserved', 'submitting', 'submitted', 'polling', 'retry_scheduled',
    'succeeded', 'failed', 'outcome_unknown', 'cancelled'
  )),
  provider_job_id text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  maximum_attempts integer not null default 4 check (maximum_attempts between 1 and 50),
  next_retry_at timestamptz,
  estimated_cost_cents integer not null check (estimated_cost_cents >= 0),
  actual_cost_cents integer check (actual_cost_cents >= 0),
  provider_usage jsonb not null default '{}'::jsonb
    check (jsonb_typeof(provider_usage) = 'object' and octet_length(provider_usage::text) < 32768),
  last_http_status integer check (last_http_status between 100 and 599),
  last_safe_error_code text,
  last_safe_error_summary text,
  provider_started_at timestamptz,
  provider_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_operations_workflow_kind_fingerprint_key
    unique (workflow_id, operation_kind, request_fingerprint),
  check (provider_job_id is null or char_length(provider_job_id) between 1 and 250),
  check (last_safe_error_code is null or char_length(last_safe_error_code) <= 80),
  check (last_safe_error_summary is null or char_length(last_safe_error_summary) <= 240)
);

create table if not exists public.provider_operation_attempts (
  id uuid primary key default gen_random_uuid(),
  provider_operation_id uuid not null references public.provider_operations(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  attempt_phase text not null check (attempt_phase in ('submit', 'poll', 'persist')),
  attempt_state text not null default 'started' check (attempt_state in (
    'started', 'succeeded', 'retry_scheduled', 'failed', 'outcome_unknown', 'cancelled'
  )),
  http_status integer check (http_status between 100 and 599),
  provider_request_reference text,
  retry_at timestamptz,
  safe_error_code text,
  safe_error_summary text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint provider_operation_attempts_number_key unique (provider_operation_id, attempt_number),
  check (provider_request_reference is null or char_length(provider_request_reference) <= 250),
  check (safe_error_code is null or char_length(safe_error_code) <= 80),
  check (safe_error_summary is null or char_length(safe_error_summary) <= 240)
);

create table if not exists public.source_documents (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete restrict,
  source_url text not null check (source_url ~ '^https?://'),
  canonical_url text not null check (canonical_url ~ '^https?://'),
  source_kind text not null default 'website_page' check (source_kind = 'website_page'),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint source_documents_report_canonical_key unique (report_id, canonical_url)
);

create table if not exists public.research_artifacts (
  id uuid primary key default gen_random_uuid(),
  provider_operation_id uuid not null references public.provider_operations(id) on delete cascade,
  source_document_id uuid references public.source_documents(id) on delete cascade,
  artifact_type text not null check (artifact_type in ('website_page_payload', 'provider_metadata')),
  page_index integer not null check (page_index between 0 and 1000),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  byte_size integer not null check (byte_size between 2 and 524288),
  raw_payload jsonb not null
    check (jsonb_typeof(raw_payload) = 'object' and octet_length(raw_payload::text) <= 524288),
  provider_created_at timestamptz,
  captured_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint research_artifacts_operation_page_type_key
    unique (provider_operation_id, page_index, artifact_type)
);

create table if not exists public.source_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_document_id uuid not null references public.source_documents(id) on delete cascade,
  provider_operation_id uuid not null references public.provider_operations(id) on delete cascade,
  research_artifact_id uuid not null unique references public.research_artifacts(id) on delete cascade,
  page_index integer not null check (page_index between 0 and 1000),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  byte_size integer not null check (byte_size between 1 and 262144),
  title text,
  description text,
  markdown_content text not null check (char_length(markdown_content) between 1 and 262144),
  crawled_at timestamptz not null,
  provider_created_at timestamptz,
  fresh_until timestamptz not null,
  created_at timestamptz not null default now(),
  constraint source_snapshots_operation_page_key unique (provider_operation_id, page_index),
  check (fresh_until >= crawled_at),
  check (title is null or char_length(title) <= 500),
  check (description is null or char_length(description) <= 2000)
);

create table if not exists public.model_invocations (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.research_workflows(id) on delete cascade,
  provider_operation_id uuid not null unique references public.provider_operations(id) on delete cascade,
  invocation_kind text not null check (invocation_kind in (
    'company_profile_extraction', 'search_query_discovery'
  )),
  provider text not null check (provider in ('openai', 'mock')),
  provider_request_id text not null check (char_length(provider_request_id) between 1 and 250),
  model_identifier text not null check (char_length(model_identifier) between 1 and 120),
  prompt_template_version text not null check (char_length(prompt_template_version) between 1 and 80),
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  output_hash text not null check (output_hash ~ '^[a-f0-9]{64}$'),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  total_tokens integer not null default 0 check (total_tokens >= 0),
  provider_usage jsonb not null default '{}'::jsonb
    check (jsonb_typeof(provider_usage) = 'object' and octet_length(provider_usage::text) < 32768),
  reserved_cost_cents integer not null check (reserved_cost_cents >= 0),
  actual_cost_cents integer not null check (actual_cost_cents >= 0),
  provider_created_at timestamptz,
  completed_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (actual_cost_cents <= reserved_cost_cents),
  check (total_tokens >= input_tokens and total_tokens >= output_tokens)
);

create table if not exists public.company_profile_versions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.research_workflows(id) on delete cascade,
  report_id uuid not null references public.reports(id) on delete cascade,
  model_invocation_id uuid not null unique references public.model_invocations(id) on delete cascade,
  profile_version integer not null check (profile_version > 0),
  company_name text,
  brand_name text,
  website_url text not null check (website_url ~ '^https?://'),
  industry text,
  subindustry text,
  business_model text,
  profile_summary text,
  research_fresh_at timestamptz not null,
  fresh_until timestamptz not null,
  created_at timestamptz not null default now(),
  constraint company_profile_versions_workflow_version_key unique (workflow_id, profile_version),
  check (fresh_until >= research_fresh_at),
  check (company_name is null or char_length(company_name) <= 300),
  check (brand_name is null or char_length(brand_name) <= 300),
  check (industry is null or char_length(industry) <= 300),
  check (subindustry is null or char_length(subindustry) <= 300),
  check (business_model is null or char_length(business_model) <= 300),
  check (profile_summary is null or char_length(profile_summary) <= 4000)
);

create table if not exists public.company_profile_claims (
  id uuid primary key default gen_random_uuid(),
  profile_version_id uuid not null references public.company_profile_versions(id) on delete cascade,
  field_key text not null check (field_key in (
    'company_name', 'brand_name', 'website', 'industry', 'subindustry',
    'business_model', 'target_customers', 'geographic_location',
    'geographic_service_area', 'profile_summary'
  )),
  claim_status text not null check (claim_status in (
    'measured', 'inferred', 'unavailable', 'unmeasured'
  )),
  confidence text check (confidence in ('low', 'medium', 'high')),
  value_text text,
  normalized_value text,
  created_at timestamptz not null default now(),
  constraint company_profile_claims_profile_field_key unique (profile_version_id, field_key),
  check (value_text is null or char_length(value_text) <= 4000),
  check (normalized_value is null or char_length(normalized_value) <= 1000),
  check (
    (claim_status in ('unavailable', 'unmeasured') and value_text is null and confidence is null)
    or (claim_status in ('measured', 'inferred') and value_text is not null and confidence is not null)
  )
);

create table if not exists public.company_profile_claim_evidence (
  claim_id uuid not null references public.company_profile_claims(id) on delete cascade,
  source_snapshot_id uuid not null references public.source_snapshots(id) on delete restrict,
  evidence_excerpt text not null check (char_length(evidence_excerpt) between 1 and 1000),
  evidence_hash text not null check (evidence_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  primary key (claim_id, source_snapshot_id, evidence_hash)
);

create table if not exists public.company_profile_entities (
  id uuid primary key default gen_random_uuid(),
  profile_version_id uuid not null references public.company_profile_versions(id) on delete cascade,
  entity_type text not null check (entity_type in (
    'product', 'service', 'person', 'value_proposition', 'differentiator',
    'proof', 'trust_signal', 'review_reference', 'content_asset', 'authority_source', 'likely_competitor'
  )),
  display_name text not null check (char_length(display_name) between 1 and 500),
  normalized_name text not null check (char_length(normalized_name) between 1 and 500),
  entity_role text,
  entity_url text check (entity_url is null or entity_url ~ '^https?://'),
  claim_status text not null check (claim_status in ('measured', 'inferred')),
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  created_at timestamptz not null default now(),
  constraint company_profile_entities_dedupe_key
    unique (profile_version_id, entity_type, normalized_name),
  check (entity_role is null or char_length(entity_role) <= 500)
);

create table if not exists public.company_profile_entity_evidence (
  profile_entity_id uuid not null references public.company_profile_entities(id) on delete cascade,
  source_snapshot_id uuid not null references public.source_snapshots(id) on delete restrict,
  evidence_excerpt text not null check (char_length(evidence_excerpt) between 1 and 1000),
  evidence_hash text not null check (evidence_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  primary key (profile_entity_id, source_snapshot_id, evidence_hash)
);

create table if not exists public.search_query_sets (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.research_workflows(id) on delete cascade,
  profile_version_id uuid not null references public.company_profile_versions(id) on delete restrict,
  model_invocation_id uuid not null unique references public.model_invocations(id) on delete cascade,
  query_set_version integer not null check (query_set_version > 0),
  prompt_template_version text not null check (char_length(prompt_template_version) between 1 and 80),
  research_fresh_at timestamptz not null,
  fresh_until timestamptz not null,
  created_at timestamptz not null default now(),
  constraint search_query_sets_workflow_version_key unique (workflow_id, query_set_version),
  check (fresh_until >= research_fresh_at)
);

create table if not exists public.search_queries (
  id uuid primary key default gen_random_uuid(),
  query_set_id uuid not null references public.search_query_sets(id) on delete cascade,
  query_text text not null check (char_length(query_text) between 3 and 500),
  normalized_query text not null check (char_length(normalized_query) between 3 and 500),
  query_category text not null check (query_category in (
    'commercial', 'comparison', 'problem_aware', 'best_provider', 'local',
    'near_me', 'product', 'service', 'alternative', 'review', 'recommendation',
    'how_to', 'industry_education', 'competitor_comparison', 'founder', 'brand',
    'ai_assistant'
  )),
  estimated_intent text not null check (estimated_intent in (
    'commercial', 'transactional', 'informational', 'navigational', 'local', 'research'
  )),
  geographic_relevance text,
  priority smallint not null check (priority between 1 and 5),
  rationale text not null check (char_length(rationale) between 1 and 2000),
  created_at timestamptz not null default now(),
  constraint search_queries_set_normalized_key unique (query_set_id, normalized_query),
  check (geographic_relevance is null or char_length(geographic_relevance) <= 500)
);

create table if not exists public.search_query_claim_evidence (
  search_query_id uuid not null references public.search_queries(id) on delete cascade,
  profile_claim_id uuid not null references public.company_profile_claims(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (search_query_id, profile_claim_id)
);

create index if not exists provider_operations_workflow_state_idx
  on public.provider_operations (workflow_id, operation_state, updated_at);
create index if not exists provider_operations_retry_idx
  on public.provider_operations (next_retry_at) where operation_state = 'retry_scheduled';
create index if not exists provider_operation_attempts_operation_idx
  on public.provider_operation_attempts (provider_operation_id, attempt_number desc);
create index if not exists source_documents_report_idx
  on public.source_documents (report_id, last_seen_at desc);
create index if not exists research_artifacts_operation_idx
  on public.research_artifacts (provider_operation_id, page_index);
create index if not exists source_snapshots_document_created_idx
  on public.source_snapshots (source_document_id, created_at desc);
create index if not exists source_snapshots_operation_idx
  on public.source_snapshots (provider_operation_id, page_index);
create index if not exists company_profile_versions_workflow_idx
  on public.company_profile_versions (workflow_id, profile_version desc);
create index if not exists company_profile_claim_evidence_snapshot_idx
  on public.company_profile_claim_evidence (source_snapshot_id);
create index if not exists company_profile_entity_evidence_snapshot_idx
  on public.company_profile_entity_evidence (source_snapshot_id);
create index if not exists search_query_sets_workflow_idx
  on public.search_query_sets (workflow_id, query_set_version desc);
create index if not exists search_queries_category_priority_idx
  on public.search_queries (query_set_id, query_category, priority desc);

alter table public.provider_operations enable row level security;
alter table public.provider_operation_attempts enable row level security;
alter table public.source_documents enable row level security;
alter table public.research_artifacts enable row level security;
alter table public.source_snapshots enable row level security;
alter table public.model_invocations enable row level security;
alter table public.company_profile_versions enable row level security;
alter table public.company_profile_claims enable row level security;
alter table public.company_profile_claim_evidence enable row level security;
alter table public.company_profile_entities enable row level security;
alter table public.company_profile_entity_evidence enable row level security;
alter table public.search_query_sets enable row level security;
alter table public.search_queries enable row level security;
alter table public.search_query_claim_evidence enable row level security;

revoke all privileges on table
  public.provider_operations, public.provider_operation_attempts,
  public.source_documents, public.research_artifacts, public.source_snapshots,
  public.model_invocations, public.company_profile_versions,
  public.company_profile_claims, public.company_profile_claim_evidence,
  public.company_profile_entities, public.company_profile_entity_evidence,
  public.search_query_sets, public.search_queries, public.search_query_claim_evidence
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.provider_operations, public.provider_operation_attempts,
  public.source_documents, public.research_artifacts, public.source_snapshots,
  public.model_invocations, public.company_profile_versions,
  public.company_profile_claims, public.company_profile_claim_evidence,
  public.company_profile_entities, public.company_profile_entity_evidence,
  public.search_query_sets, public.search_queries, public.search_query_claim_evidence
to service_role;

create or replace function public.reject_immutable_research_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using message = 'research_history_is_immutable', errcode = 'P0001';
end;
$$;

do $$
declare v_table text;
begin
  foreach v_table in array array[
    'research_artifacts', 'source_snapshots', 'model_invocations',
    'company_profile_versions', 'company_profile_claims',
    'company_profile_claim_evidence', 'company_profile_entities',
    'company_profile_entity_evidence', 'search_query_sets', 'search_queries',
    'search_query_claim_evidence'
  ] loop
    execute format('drop trigger if exists immutable_research_update on public.%I', v_table);
    execute format(
      'create trigger immutable_research_update before update on public.%I for each row execute function public.reject_immutable_research_update()',
      v_table
    );
  end loop;
end;
$$;

comment on function public.reject_immutable_research_update() is
  'Prevents historical evidence from being overwritten. Service-role deletes remain available for controlled synthetic-fixture cleanup.';

create or replace function public.research_step_position(p_step_key text)
returns integer language sql immutable set search_path = '' as $$
  select case p_step_key
    when 'initialize_workflow' then 1
    when 'validate_intake_references' then 2
    when 'establish_cost_budget' then 3
    when 'prepare_provider_research' then 4
    when 'mark_ready_for_provider_research' then 5
    when 'website_research' then 6
    when 'company_profile_extraction' then 7
    when 'search_query_discovery' then 8
    else 999
  end;
$$;

create or replace function public.provider_operation_json(p_operation public.provider_operations)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_operation.id, 'workflowId', p_operation.workflow_id,
    'stepId', p_operation.step_id, 'provider', p_operation.provider,
    'operationKind', p_operation.operation_kind,
    'idempotencyKey', p_operation.idempotency_key,
    'requestFingerprint', p_operation.request_fingerprint,
    'state', p_operation.operation_state, 'providerJobId', p_operation.provider_job_id,
    'attemptCount', p_operation.attempt_count,
    'maximumAttempts', p_operation.maximum_attempts,
    'nextRetryAt', p_operation.next_retry_at,
    'estimatedCostCents', p_operation.estimated_cost_cents,
    'actualCostCents', p_operation.actual_cost_cents,
    'providerUsage', p_operation.provider_usage,
    'lastHttpStatus', p_operation.last_http_status,
    'lastSafeErrorCode', p_operation.last_safe_error_code,
    'lastSafeErrorSummary', p_operation.last_safe_error_summary,
    'providerStartedAt', p_operation.provider_started_at,
    'providerCompletedAt', p_operation.provider_completed_at,
    'createdAt', p_operation.created_at, 'updatedAt', p_operation.updated_at
  );
$$;

create or replace function public.prepare_v3_provider_research(
  p_workflow_id uuid,
  p_website_estimated_cost_cents integer,
  p_profile_estimated_cost_cents integer,
  p_query_estimated_cost_cents integer,
  p_maximum_attempts integer default 4,
  p_now timestamptz default now()
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_workflow public.research_workflows%rowtype;
  v_report public.reports%rowtype;
  v_step_key text;
  v_step_cost integer;
  v_step_attempts integer;
  v_payload jsonb;
begin
  if p_website_estimated_cost_cents < 0 or p_profile_estimated_cost_cents < 0
    or p_query_estimated_cost_cents < 0
    or p_website_estimated_cost_cents + p_profile_estimated_cost_cents + p_query_estimated_cost_cents > 400
    or p_maximum_attempts not between 1 and 20 then
    raise exception using message = 'provider_research_configuration_invalid', errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('provider-research:' || p_workflow_id::text, 0));
  select * into v_workflow from public.research_workflows where id = p_workflow_id for update;
  if v_workflow.id is null then
    raise exception using message = 'workflow_not_found', errcode = 'P0001';
  end if;
  select * into v_report from public.reports where id = v_workflow.report_id;
  if v_report.legacy_public_id is not null then
    raise exception using message = 'legacy_provider_pipeline_owns_report', errcode = 'P0001';
  end if;
  if v_workflow.status = 'ready_for_search_intelligence' then return false; end if;

  if exists (
    select 1 from public.research_steps
    where workflow_id = p_workflow_id and step_key = 'website_research'
  ) then
    return false;
  end if;
  if v_workflow.status <> 'ready_for_provider_research' then
    raise exception using message = 'workflow_not_ready_for_provider_research', errcode = 'P0001';
  end if;

  foreach v_step_key in array array[
    'website_research', 'company_profile_extraction', 'search_query_discovery'
  ] loop
    v_step_cost := case v_step_key
      when 'website_research' then p_website_estimated_cost_cents
      when 'company_profile_extraction' then p_profile_estimated_cost_cents
      else p_query_estimated_cost_cents end;
    v_step_attempts := case when v_step_key = 'website_research'
      then greatest(20, p_maximum_attempts) else p_maximum_attempts end;
    insert into public.research_steps (
      workflow_id, step_key, step_version, status, input_hash, maximum_attempts,
      optional, estimated_cost_cents, scheduled_at, created_at, updated_at
    ) values (
      p_workflow_id, v_step_key, 1, 'pending',
      md5(v_workflow.input_hash || ':' || v_step_key || ':1') || md5(v_step_key || v_workflow.input_hash),
      v_step_attempts, false, v_step_cost, p_now, p_now, p_now
    ) on conflict (workflow_id, step_key, step_version, input_hash) do nothing;
  end loop;

  update public.research_workflows
  set status = 'dispatch_pending', current_phase = 'website_research', updated_at = p_now
  where id = p_workflow_id;
  insert into public.workflow_events (
    workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at
  ) values (
    p_workflow_id, 'provider_research_continuation_created', '{}'::jsonb,
    p_workflow_id, 'orchestrator', p_now
  );

  v_payload := jsonb_build_object(
    'workflowId', v_workflow.id,
    'reportRequestId', v_workflow.report_request_id,
    'reportId', v_workflow.report_id,
    'correlationId', gen_random_uuid(),
    'workflowVersion', v_workflow.workflow_version,
    'requestedAt', p_now
  );
  perform public.enqueue_v3_workflow_message(
    v_payload,
    'launchclub.report.requested.v1:' || p_workflow_id::text || ':provider-research:v1',
    p_now
  );
  return true;
end;
$$;

create or replace function public.get_provider_research_input(p_workflow_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'workflowId', rw.id,
    'reportRequestId', rw.report_request_id,
    'reportId', rw.report_id,
    'companyId', rr.company_id,
    'normalizedUrl', rr.normalized_submitted_url,
    'domain', c.canonical_domain,
    'requestFingerprint', rr.request_fingerprint,
    'legacyPublicId', r.legacy_public_id
  )
  from public.research_workflows rw
  join public.report_requests rr on rr.id = rw.report_request_id
  join public.reports r on r.id = rw.report_id
  join public.companies c on c.id = rr.company_id
  where rw.id = p_workflow_id and rw.workflow_type = 'initial_report';
$$;

create or replace function public.ensure_provider_operation(
  p_workflow_id uuid,
  p_step_key text,
  p_provider text,
  p_operation_kind text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_estimated_cost_cents integer,
  p_maximum_attempts integer,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_step public.research_steps%rowtype;
  v_operation public.provider_operations%rowtype;
  v_legacy_public_id text;
begin
  select r.legacy_public_id into v_legacy_public_id
  from public.research_workflows rw join public.reports r on r.id = rw.report_id
  where rw.id = p_workflow_id;
  if not found then raise exception using message = 'workflow_not_found', errcode = 'P0001'; end if;
  if v_legacy_public_id is not null then
    raise exception using message = 'legacy_provider_pipeline_owns_report', errcode = 'P0001';
  end if;
  select * into v_step from public.research_steps
  where workflow_id = p_workflow_id and step_key = p_step_key
  order by step_version desc limit 1;
  if v_step.id is null or p_step_key <> p_operation_kind then
    raise exception using message = 'provider_operation_step_invalid', errcode = 'P0001';
  end if;

  insert into public.provider_operations (
    workflow_id, step_id, provider, operation_kind, idempotency_key,
    request_fingerprint, estimated_cost_cents, maximum_attempts, created_at, updated_at
  ) values (
    p_workflow_id, v_step.id, p_provider, p_operation_kind, p_idempotency_key,
    p_request_fingerprint, p_estimated_cost_cents, p_maximum_attempts, p_now, p_now
  ) on conflict (idempotency_key) do nothing;

  select * into v_operation from public.provider_operations
  where idempotency_key = p_idempotency_key;
  if v_operation.workflow_id <> p_workflow_id
    or v_operation.operation_kind <> p_operation_kind
    or v_operation.request_fingerprint <> p_request_fingerprint then
    raise exception using message = 'provider_operation_idempotency_conflict', errcode = 'P0001';
  end if;
  return public.provider_operation_json(v_operation);
end;
$$;

create or replace function public.get_provider_operation(
  p_workflow_id uuid,
  p_operation_kind text
)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.provider_operation_json(po)
  from public.provider_operations po
  where po.workflow_id = p_workflow_id and po.operation_kind = p_operation_kind
  order by po.created_at desc limit 1;
$$;

create or replace function public.begin_provider_operation_attempt(
  p_operation_id uuid,
  p_phase text,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.provider_operations%rowtype;
  v_attempt_id uuid;
  v_attempt_number integer;
begin
  select * into v_operation from public.provider_operations where id = p_operation_id for update;
  if v_operation.id is null then raise exception using message = 'provider_operation_not_found', errcode = 'P0001'; end if;
  if v_operation.operation_state in ('succeeded', 'failed', 'outcome_unknown', 'cancelled') then
    raise exception using message = 'provider_operation_terminal', errcode = 'P0001';
  end if;
  if v_operation.attempt_count >= v_operation.maximum_attempts then
    raise exception using message = 'provider_operation_attempts_exhausted', errcode = 'P0001';
  end if;
  if p_phase = 'submit' then
    if v_operation.provider_job_id is not null then
      raise exception using message = 'provider_job_already_recorded', errcode = 'P0001';
    end if;
    if v_operation.operation_state = 'submitting' then
      update public.provider_operations set operation_state = 'outcome_unknown',
        last_safe_error_code = 'submission_outcome_unknown',
        last_safe_error_summary = 'The prior provider submission outcome requires administrator review.',
        updated_at = p_now where id = p_operation_id;
      raise exception using message = 'provider_operation_outcome_unknown', errcode = 'P0001';
    end if;
  elsif p_phase = 'poll' then
    if v_operation.provider_job_id is null then
      raise exception using message = 'provider_job_missing', errcode = 'P0001';
    end if;
    update public.provider_operation_attempts
    set attempt_state = 'retry_scheduled', retry_at = p_now, completed_at = p_now
    where provider_operation_id = p_operation_id and attempt_phase = 'poll'
      and attempt_state = 'started';
  elsif p_phase <> 'persist' then
    raise exception using message = 'provider_attempt_phase_invalid', errcode = 'P0001';
  end if;

  v_attempt_number := v_operation.attempt_count + 1;
  insert into public.provider_operation_attempts (
    provider_operation_id, attempt_number, attempt_phase, attempt_state,
    started_at, created_at
  ) values (
    p_operation_id, v_attempt_number, p_phase, 'started', p_now, p_now
  ) returning id into v_attempt_id;
  update public.provider_operations
  set operation_state = case when p_phase = 'submit' then 'submitting' else 'polling' end,
    attempt_count = v_attempt_number, provider_started_at = coalesce(provider_started_at, p_now),
    next_retry_at = null, updated_at = p_now
  where id = p_operation_id returning * into v_operation;
  return jsonb_build_object(
    'operation', public.provider_operation_json(v_operation),
    'attemptId', v_attempt_id, 'attemptNumber', v_attempt_number
  );
end;
$$;

create or replace function public.record_provider_job(
  p_operation_id uuid,
  p_attempt_id uuid,
  p_provider_job_id text,
  p_http_status integer,
  p_provider_usage jsonb,
  p_provider_created_at timestamptz,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_operation public.provider_operations%rowtype;
begin
  update public.provider_operation_attempts
  set attempt_state = 'succeeded', http_status = p_http_status,
    provider_request_reference = left(p_provider_job_id, 250), completed_at = p_now
  where id = p_attempt_id and provider_operation_id = p_operation_id
    and attempt_phase = 'submit' and attempt_state = 'started';
  if not found then raise exception using message = 'provider_attempt_fenced', errcode = 'P0001'; end if;
  update public.provider_operations
  set operation_state = 'submitted', provider_job_id = left(p_provider_job_id, 250),
    provider_usage = coalesce(p_provider_usage, '{}'::jsonb),
    last_http_status = p_http_status, provider_started_at = coalesce(p_provider_created_at, provider_started_at),
    last_safe_error_code = null, last_safe_error_summary = null, updated_at = p_now
  where id = p_operation_id and operation_state = 'submitting'
  returning * into v_operation;
  if v_operation.id is null then raise exception using message = 'provider_operation_fenced', errcode = 'P0001'; end if;
  return public.provider_operation_json(v_operation);
end;
$$;

create or replace function public.schedule_provider_operation_retry(
  p_operation_id uuid,
  p_attempt_id uuid,
  p_http_status integer,
  p_retry_at timestamptz,
  p_safe_code text,
  p_safe_summary text,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_operation public.provider_operations%rowtype;
begin
  update public.provider_operation_attempts
  set attempt_state = 'retry_scheduled', http_status = p_http_status,
    retry_at = p_retry_at, safe_error_code = left(p_safe_code, 80),
    safe_error_summary = left(p_safe_summary, 240), completed_at = p_now
  where id = p_attempt_id and provider_operation_id = p_operation_id and attempt_state = 'started';
  if not found then raise exception using message = 'provider_attempt_fenced', errcode = 'P0001'; end if;
  update public.provider_operations
  set operation_state = case when provider_job_id is null then 'retry_scheduled' else 'submitted' end,
    next_retry_at = p_retry_at, last_http_status = p_http_status,
    last_safe_error_code = left(p_safe_code, 80),
    last_safe_error_summary = left(p_safe_summary, 240), updated_at = p_now
  where id = p_operation_id returning * into v_operation;
  return public.provider_operation_json(v_operation);
end;
$$;

create or replace function public.fail_provider_operation(
  p_operation_id uuid,
  p_attempt_id uuid,
  p_state text,
  p_http_status integer,
  p_safe_code text,
  p_safe_summary text,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_operation public.provider_operations%rowtype;
begin
  if p_state not in ('failed', 'outcome_unknown', 'cancelled') then
    raise exception using message = 'provider_terminal_state_invalid', errcode = 'P0001';
  end if;
  if p_attempt_id is not null then
    update public.provider_operation_attempts
    set attempt_state = p_state, http_status = p_http_status,
      safe_error_code = left(p_safe_code, 80), safe_error_summary = left(p_safe_summary, 240),
      completed_at = p_now
    where id = p_attempt_id and provider_operation_id = p_operation_id and attempt_state = 'started';
  end if;
  update public.provider_operations
  set operation_state = p_state, last_http_status = p_http_status,
    last_safe_error_code = left(p_safe_code, 80),
    last_safe_error_summary = left(p_safe_summary, 240), updated_at = p_now
  where id = p_operation_id returning * into v_operation;
  if v_operation.id is null then raise exception using message = 'provider_operation_not_found', errcode = 'P0001'; end if;
  return public.provider_operation_json(v_operation);
end;
$$;

create or replace function public.store_website_research_page(
  p_operation_id uuid,
  p_page_index integer,
  p_source_url text,
  p_canonical_url text,
  p_title text,
  p_description text,
  p_markdown_content text,
  p_content_hash text,
  p_raw_payload jsonb,
  p_provider_created_at timestamptz,
  p_crawled_at timestamptz,
  p_fresh_until timestamptz
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.provider_operations%rowtype;
  v_workflow public.research_workflows%rowtype;
  v_request public.report_requests%rowtype;
  v_document public.source_documents%rowtype;
  v_artifact public.research_artifacts%rowtype;
  v_snapshot public.source_snapshots%rowtype;
  v_artifact_hash text;
begin
  select * into v_operation from public.provider_operations where id = p_operation_id;
  if v_operation.id is null or v_operation.operation_kind <> 'website_research'
    or v_operation.operation_state not in ('polling', 'submitted') then
    raise exception using message = 'website_research_operation_invalid', errcode = 'P0001';
  end if;
  if encode(pg_catalog.sha256(convert_to(p_markdown_content, 'UTF8')), 'hex') <> p_content_hash then
    raise exception using message = 'research_content_hash_mismatch', errcode = 'P0001';
  end if;
  select * into v_workflow from public.research_workflows where id = v_operation.workflow_id;
  select * into v_request from public.report_requests where id = v_workflow.report_request_id;

  insert into public.source_documents (
    report_id, company_id, source_url, canonical_url, source_kind,
    first_seen_at, last_seen_at, created_at
  ) values (
    v_workflow.report_id, v_request.company_id, p_source_url, p_canonical_url,
    'website_page', p_crawled_at, p_crawled_at, p_crawled_at
  ) on conflict (report_id, canonical_url) do update
    set last_seen_at = greatest(public.source_documents.last_seen_at, excluded.last_seen_at)
  returning * into v_document;

  v_artifact_hash := encode(pg_catalog.sha256(convert_to(p_raw_payload::text, 'UTF8')), 'hex');
  insert into public.research_artifacts (
    provider_operation_id, source_document_id, artifact_type, page_index,
    content_hash, byte_size, raw_payload, provider_created_at, captured_at, created_at
  ) values (
    p_operation_id, v_document.id, 'website_page_payload', p_page_index,
    v_artifact_hash, octet_length(p_raw_payload::text), p_raw_payload,
    p_provider_created_at, p_crawled_at, p_crawled_at
  ) on conflict (provider_operation_id, page_index, artifact_type) do nothing;
  select * into v_artifact from public.research_artifacts
  where provider_operation_id = p_operation_id and page_index = p_page_index
    and artifact_type = 'website_page_payload';

  if v_artifact.content_hash <> v_artifact_hash then
    raise exception using message = 'research_artifact_idempotency_conflict', errcode = 'P0001';
  end if;
  insert into public.source_snapshots (
    source_document_id, provider_operation_id, research_artifact_id, page_index,
    content_hash, byte_size, title, description, markdown_content,
    crawled_at, provider_created_at, fresh_until, created_at
  ) values (
    v_document.id, p_operation_id, v_artifact.id, p_page_index,
    p_content_hash, octet_length(convert_to(p_markdown_content, 'UTF8')),
    left(p_title, 500), left(p_description, 2000), p_markdown_content,
    p_crawled_at, p_provider_created_at, p_fresh_until, p_crawled_at
  ) on conflict (provider_operation_id, page_index) do nothing;
  select * into v_snapshot from public.source_snapshots
  where provider_operation_id = p_operation_id and page_index = p_page_index;
  if v_snapshot.content_hash <> p_content_hash then
    raise exception using message = 'source_snapshot_idempotency_conflict', errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'artifactId', v_artifact.id, 'snapshotId', v_snapshot.id,
    'contentHash', v_snapshot.content_hash, 'byteSize', v_snapshot.byte_size
  );
end;
$$;

create or replace function public.complete_website_research_operation(
  p_operation_id uuid,
  p_attempt_id uuid,
  p_http_status integer,
  p_provider_usage jsonb,
  p_actual_cost_cents integer,
  p_provider_completed_at timestamptz,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_operation public.provider_operations%rowtype;
begin
  if not exists (select 1 from public.source_snapshots where provider_operation_id = p_operation_id) then
    raise exception using message = 'website_research_has_no_pages', errcode = 'P0001';
  end if;
  update public.provider_operation_attempts
  set attempt_state = 'succeeded', http_status = p_http_status, completed_at = p_now
  where id = p_attempt_id and provider_operation_id = p_operation_id
    and attempt_phase = 'poll' and attempt_state = 'started';
  if not found then raise exception using message = 'provider_attempt_fenced', errcode = 'P0001'; end if;
  update public.provider_operations
  set operation_state = 'succeeded', actual_cost_cents = p_actual_cost_cents,
    provider_usage = coalesce(p_provider_usage, '{}'::jsonb),
    last_http_status = p_http_status, provider_completed_at = p_provider_completed_at,
    next_retry_at = null, last_safe_error_code = null, last_safe_error_summary = null,
    updated_at = p_now
  where id = p_operation_id and operation_kind = 'website_research'
    and operation_state in ('polling', 'submitted')
  returning * into v_operation;
  if v_operation.id is null then raise exception using message = 'provider_operation_fenced', errcode = 'P0001'; end if;
  return public.provider_operation_json(v_operation);
end;
$$;

create or replace function public.get_website_research_evidence(p_workflow_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with operation as (
    select * from public.provider_operations
    where workflow_id = p_workflow_id and operation_kind = 'website_research'
      and operation_state = 'succeeded'
    order by provider_completed_at desc nulls last, created_at desc limit 1
  )
  select jsonb_build_object(
    'operationId', o.id,
    'pages', coalesce(jsonb_agg(jsonb_build_object(
      'snapshotId', ss.id, 'pageIndex', ss.page_index,
      'sourceUrl', sd.source_url, 'canonicalUrl', sd.canonical_url,
      'title', ss.title, 'description', ss.description,
      'markdown', ss.markdown_content, 'contentHash', ss.content_hash,
      'crawledAt', ss.crawled_at, 'providerCreatedAt', ss.provider_created_at,
      'freshUntil', ss.fresh_until
    ) order by ss.page_index), '[]'::jsonb)
  )
  from operation o
  join public.source_snapshots ss on ss.provider_operation_id = o.id
  join public.source_documents sd on sd.id = ss.source_document_id
  group by o.id;
$$;

create or replace function public.persist_company_profile(
  p_operation_id uuid,
  p_attempt_id uuid,
  p_model_identifier text,
  p_provider_request_id text,
  p_prompt_template_version text,
  p_input_hash text,
  p_output_hash text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_total_tokens integer,
  p_provider_usage jsonb,
  p_reserved_cost_cents integer,
  p_actual_cost_cents integer,
  p_provider_created_at timestamptz,
  p_profile jsonb,
  p_research_fresh_at timestamptz,
  p_fresh_until timestamptz,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.provider_operations%rowtype;
  v_workflow public.research_workflows%rowtype;
  v_invocation_id uuid;
  v_profile_id uuid;
  v_profile_version integer;
  v_claim jsonb;
  v_entity jsonb;
  v_evidence jsonb;
  v_claim_id uuid;
  v_entity_id uuid;
  v_snapshot_id uuid;
begin
  select * into v_operation from public.provider_operations where id = p_operation_id for update;
  if v_operation.id is null or v_operation.operation_kind <> 'company_profile_extraction'
    or v_operation.operation_state <> 'submitting' then
    raise exception using message = 'company_profile_operation_invalid', errcode = 'P0001';
  end if;
  if jsonb_typeof(p_profile) <> 'object' or jsonb_typeof(p_profile -> 'claims') <> 'array'
    or jsonb_typeof(p_profile -> 'entities') <> 'array'
    or jsonb_array_length(p_profile -> 'claims') < 10
    or octet_length(p_profile::text) > 262144 then
    raise exception using message = 'company_profile_payload_invalid', errcode = 'P0001';
  end if;
  select * into v_workflow from public.research_workflows where id = v_operation.workflow_id;

  select id into v_invocation_id from public.model_invocations where provider_operation_id = p_operation_id;
  if v_invocation_id is not null then
    select id into v_profile_id from public.company_profile_versions where model_invocation_id = v_invocation_id;
    return jsonb_build_object('profileVersionId', v_profile_id, 'modelInvocationId', v_invocation_id);
  end if;

  insert into public.model_invocations (
    workflow_id, provider_operation_id, invocation_kind, provider, provider_request_id, model_identifier,
    prompt_template_version, input_hash, output_hash, input_tokens, output_tokens,
    total_tokens, provider_usage, reserved_cost_cents, actual_cost_cents,
    provider_created_at, completed_at, created_at
  ) values (
    v_workflow.id, p_operation_id, 'company_profile_extraction', v_operation.provider,
    p_provider_request_id, p_model_identifier, p_prompt_template_version, p_input_hash, p_output_hash,
    p_input_tokens, p_output_tokens, p_total_tokens, coalesce(p_provider_usage, '{}'::jsonb),
    p_reserved_cost_cents, p_actual_cost_cents, p_provider_created_at, p_now, p_now
  ) returning id into v_invocation_id;

  select coalesce(max(profile_version), 0) + 1 into v_profile_version
  from public.company_profile_versions where workflow_id = v_workflow.id;
  insert into public.company_profile_versions (
    workflow_id, report_id, model_invocation_id, profile_version,
    company_name, brand_name, website_url, industry, subindustry, business_model,
    profile_summary, research_fresh_at, fresh_until, created_at
  ) values (
    v_workflow.id, v_workflow.report_id, v_invocation_id, v_profile_version,
    nullif(p_profile ->> 'companyName', ''), nullif(p_profile ->> 'brandName', ''),
    p_profile ->> 'website', nullif(p_profile ->> 'industry', ''),
    nullif(p_profile ->> 'subindustry', ''), nullif(p_profile ->> 'businessModel', ''),
    nullif(p_profile ->> 'summary', ''), p_research_fresh_at, p_fresh_until, p_now
  ) returning id into v_profile_id;

  for v_claim in select value from jsonb_array_elements(p_profile -> 'claims') loop
    if v_claim ->> 'status' = 'measured'
      and jsonb_array_length(coalesce(v_claim -> 'evidence', '[]'::jsonb)) = 0 then
      raise exception using message = 'measured_claim_requires_evidence', errcode = 'P0001';
    end if;
    insert into public.company_profile_claims (
      profile_version_id, field_key, claim_status, confidence,
      value_text, normalized_value, created_at
    ) values (
      v_profile_id, v_claim ->> 'fieldKey', v_claim ->> 'status',
      nullif(v_claim ->> 'confidence', ''), nullif(v_claim ->> 'value', ''),
      nullif(v_claim ->> 'normalizedValue', ''), p_now
    ) returning id into v_claim_id;
    for v_evidence in select value from jsonb_array_elements(coalesce(v_claim -> 'evidence', '[]'::jsonb)) loop
      select ss.id into v_snapshot_id
      from public.source_snapshots ss
      join public.provider_operations po on po.id = ss.provider_operation_id
      where po.workflow_id = v_workflow.id and po.operation_kind = 'website_research'
        and po.operation_state = 'succeeded'
        and ss.page_index = (v_evidence ->> 'pageIndex')::integer
        and position(v_evidence ->> 'excerpt' in ss.markdown_content) > 0
      order by po.provider_completed_at desc nulls last limit 1;
      if v_snapshot_id is null then raise exception using message = 'claim_evidence_snapshot_missing', errcode = 'P0001'; end if;
      insert into public.company_profile_claim_evidence (
        claim_id, source_snapshot_id, evidence_excerpt, evidence_hash, created_at
      ) values (
        v_claim_id, v_snapshot_id, left(v_evidence ->> 'excerpt', 1000),
        encode(pg_catalog.sha256(convert_to(v_evidence ->> 'excerpt', 'UTF8')), 'hex'), p_now
      );
    end loop;
  end loop;

  for v_entity in select value from jsonb_array_elements(p_profile -> 'entities') loop
    if v_entity ->> 'status' = 'measured'
      and jsonb_array_length(coalesce(v_entity -> 'evidence', '[]'::jsonb)) = 0 then
      raise exception using message = 'measured_entity_requires_evidence', errcode = 'P0001';
    end if;
    insert into public.company_profile_entities (
      profile_version_id, entity_type, display_name, normalized_name, entity_role,
      entity_url, claim_status, confidence, created_at
    ) values (
      v_profile_id, v_entity ->> 'type', v_entity ->> 'name',
      lower(regexp_replace(trim(v_entity ->> 'name'), '\\s+', ' ', 'g')),
      nullif(v_entity ->> 'role', ''), nullif(v_entity ->> 'url', ''),
      v_entity ->> 'status', v_entity ->> 'confidence', p_now
    ) on conflict (profile_version_id, entity_type, normalized_name) do nothing
    returning id into v_entity_id;
    if v_entity_id is null then
      select id into v_entity_id from public.company_profile_entities
      where profile_version_id = v_profile_id and entity_type = v_entity ->> 'type'
        and normalized_name = lower(regexp_replace(trim(v_entity ->> 'name'), '\\s+', ' ', 'g'));
    end if;
    for v_evidence in select value from jsonb_array_elements(coalesce(v_entity -> 'evidence', '[]'::jsonb)) loop
      select ss.id into v_snapshot_id
      from public.source_snapshots ss
      join public.provider_operations po on po.id = ss.provider_operation_id
      where po.workflow_id = v_workflow.id and po.operation_kind = 'website_research'
        and po.operation_state = 'succeeded'
        and ss.page_index = (v_evidence ->> 'pageIndex')::integer
        and position(v_evidence ->> 'excerpt' in ss.markdown_content) > 0
      order by po.provider_completed_at desc nulls last limit 1;
      if v_snapshot_id is null then raise exception using message = 'entity_evidence_snapshot_missing', errcode = 'P0001'; end if;
      insert into public.company_profile_entity_evidence (
        profile_entity_id, source_snapshot_id, evidence_excerpt, evidence_hash, created_at
      ) values (
        v_entity_id, v_snapshot_id, left(v_evidence ->> 'excerpt', 1000),
        encode(pg_catalog.sha256(convert_to(v_evidence ->> 'excerpt', 'UTF8')), 'hex'), p_now
      ) on conflict do nothing;
    end loop;
  end loop;

  update public.provider_operation_attempts
  set attempt_state = 'succeeded', completed_at = p_now
  where id = p_attempt_id and provider_operation_id = p_operation_id
    and attempt_phase = 'submit' and attempt_state = 'started';
  if not found then raise exception using message = 'provider_attempt_fenced', errcode = 'P0001'; end if;
  update public.provider_operations
  set operation_state = 'succeeded', actual_cost_cents = p_actual_cost_cents,
    provider_usage = coalesce(p_provider_usage, '{}'::jsonb),
    provider_completed_at = p_now, next_retry_at = null,
    last_safe_error_code = null, last_safe_error_summary = null, updated_at = p_now
  where id = p_operation_id;
  return jsonb_build_object(
    'profileVersionId', v_profile_id, 'profileVersion', v_profile_version,
    'modelInvocationId', v_invocation_id
  );
end;
$$;

create or replace function public.get_latest_company_profile(p_workflow_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with profile as (
    select * from public.company_profile_versions
    where workflow_id = p_workflow_id order by profile_version desc limit 1
  )
  select jsonb_build_object(
    'profileVersionId', p.id, 'profileVersion', p.profile_version,
    'companyName', p.company_name, 'brandName', p.brand_name,
    'website', p.website_url, 'industry', p.industry, 'subindustry', p.subindustry,
    'businessModel', p.business_model, 'summary', p.profile_summary,
    'researchFreshAt', p.research_fresh_at, 'freshUntil', p.fresh_until,
    'claims', coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'fieldKey', c.field_key, 'status', c.claim_status,
      'confidence', c.confidence, 'value', c.value_text,
      'normalizedValue', c.normalized_value
    ) order by c.field_key) from public.company_profile_claims c
      where c.profile_version_id = p.id), '[]'::jsonb),
    'entities', coalesce((select jsonb_agg(jsonb_build_object(
      'id', e.id, 'type', e.entity_type, 'name', e.display_name,
      'normalizedName', e.normalized_name, 'role', e.entity_role,
      'url', e.entity_url, 'status', e.claim_status, 'confidence', e.confidence
    ) order by e.entity_type, e.normalized_name) from public.company_profile_entities e
      where e.profile_version_id = p.id), '[]'::jsonb)
  ) from profile p;
$$;

create or replace function public.persist_search_query_set(
  p_operation_id uuid,
  p_attempt_id uuid,
  p_profile_version_id uuid,
  p_model_identifier text,
  p_provider_request_id text,
  p_prompt_template_version text,
  p_input_hash text,
  p_output_hash text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_total_tokens integer,
  p_provider_usage jsonb,
  p_reserved_cost_cents integer,
  p_actual_cost_cents integer,
  p_provider_created_at timestamptz,
  p_queries jsonb,
  p_research_fresh_at timestamptz,
  p_fresh_until timestamptz,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.provider_operations%rowtype;
  v_profile public.company_profile_versions%rowtype;
  v_invocation_id uuid;
  v_query_set_id uuid;
  v_query_set_version integer;
  v_query jsonb;
  v_claim_key text;
  v_query_id uuid;
  v_claim_id uuid;
  v_normalized_query text;
  v_has_verified_geography boolean;
begin
  select * into v_operation from public.provider_operations where id = p_operation_id for update;
  select * into v_profile from public.company_profile_versions where id = p_profile_version_id;
  if v_operation.id is null or v_operation.operation_kind <> 'search_query_discovery'
    or v_operation.operation_state <> 'submitting'
    or v_profile.id is null or v_profile.workflow_id <> v_operation.workflow_id then
    raise exception using message = 'search_query_operation_invalid', errcode = 'P0001';
  end if;
  if jsonb_typeof(p_queries) <> 'array' or jsonb_array_length(p_queries) not between 1 and 30
    or octet_length(p_queries::text) > 262144 then
    raise exception using message = 'search_query_payload_invalid', errcode = 'P0001';
  end if;
  select exists (
    select 1 from public.company_profile_claims
    where profile_version_id = p_profile_version_id
      and field_key in ('geographic_location', 'geographic_service_area')
      and claim_status = 'measured' and value_text is not null
  ) into v_has_verified_geography;

  select id into v_invocation_id from public.model_invocations where provider_operation_id = p_operation_id;
  if v_invocation_id is not null then
    select id into v_query_set_id from public.search_query_sets where model_invocation_id = v_invocation_id;
    return jsonb_build_object('querySetId', v_query_set_id, 'modelInvocationId', v_invocation_id);
  end if;

  insert into public.model_invocations (
    workflow_id, provider_operation_id, invocation_kind, provider, provider_request_id, model_identifier,
    prompt_template_version, input_hash, output_hash, input_tokens, output_tokens,
    total_tokens, provider_usage, reserved_cost_cents, actual_cost_cents,
    provider_created_at, completed_at, created_at
  ) values (
    v_operation.workflow_id, p_operation_id, 'search_query_discovery', v_operation.provider,
    p_provider_request_id, p_model_identifier, p_prompt_template_version, p_input_hash, p_output_hash,
    p_input_tokens, p_output_tokens, p_total_tokens, coalesce(p_provider_usage, '{}'::jsonb),
    p_reserved_cost_cents, p_actual_cost_cents, p_provider_created_at, p_now, p_now
  ) returning id into v_invocation_id;

  select coalesce(max(query_set_version), 0) + 1 into v_query_set_version
  from public.search_query_sets where workflow_id = v_operation.workflow_id;
  insert into public.search_query_sets (
    workflow_id, profile_version_id, model_invocation_id, query_set_version,
    prompt_template_version, research_fresh_at, fresh_until, created_at
  ) values (
    v_operation.workflow_id, p_profile_version_id, v_invocation_id, v_query_set_version,
    p_prompt_template_version, p_research_fresh_at, p_fresh_until, p_now
  ) returning id into v_query_set_id;

  for v_query in select value from jsonb_array_elements(p_queries) loop
    if nullif(v_query ->> 'geographicRelevance', '') is not null and not v_has_verified_geography then
      raise exception using message = 'query_geography_not_supported', errcode = 'P0001';
    end if;
    v_normalized_query := lower(regexp_replace(trim(v_query ->> 'query'), '\\s+', ' ', 'g'));
    insert into public.search_queries (
      query_set_id, query_text, normalized_query, query_category, estimated_intent,
      geographic_relevance, priority, rationale, created_at
    ) values (
      v_query_set_id, trim(v_query ->> 'query'), v_normalized_query,
      v_query ->> 'category', v_query ->> 'intent',
      nullif(v_query ->> 'geographicRelevance', ''),
      (v_query ->> 'priority')::smallint, v_query ->> 'rationale', p_now
    ) on conflict (query_set_id, normalized_query) do nothing
    returning id into v_query_id;
    if v_query_id is null then
      select id into v_query_id from public.search_queries
      where query_set_id = v_query_set_id and normalized_query = v_normalized_query;
    end if;
    for v_claim_key in select value #>> '{}' from jsonb_array_elements(coalesce(v_query -> 'evidenceClaimKeys', '[]'::jsonb)) loop
      select id into v_claim_id from public.company_profile_claims
      where profile_version_id = p_profile_version_id and field_key = v_claim_key
        and claim_status in ('measured', 'inferred') and value_text is not null;
      if v_claim_id is null then raise exception using message = 'query_claim_evidence_missing', errcode = 'P0001'; end if;
      insert into public.search_query_claim_evidence (search_query_id, profile_claim_id, created_at)
      values (v_query_id, v_claim_id, p_now) on conflict do nothing;
    end loop;
  end loop;

  update public.provider_operation_attempts
  set attempt_state = 'succeeded', completed_at = p_now
  where id = p_attempt_id and provider_operation_id = p_operation_id
    and attempt_phase = 'submit' and attempt_state = 'started';
  if not found then raise exception using message = 'provider_attempt_fenced', errcode = 'P0001'; end if;
  update public.provider_operations
  set operation_state = 'succeeded', actual_cost_cents = p_actual_cost_cents,
    provider_usage = coalesce(p_provider_usage, '{}'::jsonb),
    provider_completed_at = p_now, next_retry_at = null,
    last_safe_error_code = null, last_safe_error_summary = null, updated_at = p_now
  where id = p_operation_id;
  return jsonb_build_object(
    'querySetId', v_query_set_id, 'querySetVersion', v_query_set_version,
    'modelInvocationId', v_invocation_id,
    'queryCount', (select count(*) from public.search_queries where query_set_id = v_query_set_id)
  );
end;
$$;

create or replace function public.begin_research_step(
  p_workflow_id uuid,
  p_step_key text,
  p_owner text,
  p_lease_seconds integer,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_workflow public.research_workflows%rowtype;
  v_step public.research_steps%rowtype;
  v_lease public.workflow_leases%rowtype;
  v_fence bigint;
  v_attempt_id uuid;
begin
  select * into v_workflow from public.research_workflows where id = p_workflow_id for update;
  select * into v_step from public.research_steps where workflow_id = p_workflow_id and step_key = p_step_key order by step_version desc limit 1 for update;
  if v_workflow.id is null or v_step.id is null then raise exception using message = 'workflow_step_not_found', errcode = 'P0001'; end if;
  if v_step.status = 'succeeded' then
    return jsonb_build_object('disposition', 'already_succeeded', 'workflow', public.research_workflow_json(v_workflow), 'step', public.research_step_json(v_step), 'lease', null, 'attemptId', null);
  end if;
  if exists (
    select 1 from public.research_steps prior
    where prior.workflow_id = p_workflow_id and prior.status <> 'succeeded'
      and public.research_step_position(prior.step_key) < public.research_step_position(p_step_key)
  ) then
    return jsonb_build_object('disposition', 'unavailable', 'workflow', public.research_workflow_json(v_workflow), 'step', public.research_step_json(v_step), 'lease', null, 'attemptId', null);
  end if;
  if v_workflow.status in ('paused', 'cancelled', 'failed', 'completed', 'ready_for_search_intelligence')
    or v_step.scheduled_at > p_now or v_step.attempt_count >= v_step.maximum_attempts then
    return jsonb_build_object('disposition', 'unavailable', 'workflow', public.research_workflow_json(v_workflow), 'step', public.research_step_json(v_step), 'lease', null, 'attemptId', null);
  end if;
  select * into v_lease from public.workflow_leases where workflow_id = p_workflow_id and scope_key = 'step:' || v_step.id::text and released_at is null for update;
  if v_lease.id is not null and v_lease.expires_at > p_now then
    return jsonb_build_object('disposition', 'unavailable', 'workflow', public.research_workflow_json(v_workflow), 'step', public.research_step_json(v_step), 'lease', null, 'attemptId', null);
  end if;
  if v_lease.id is not null then update public.workflow_leases set released_at = p_now, release_reason = 'expired' where id = v_lease.id; end if;
  select coalesce(max(fencing_token), 0) + 1 into v_fence from public.workflow_leases where workflow_id = p_workflow_id and scope_key = 'step:' || v_step.id::text;
  insert into public.workflow_leases (workflow_id, step_id, scope_key, lease_owner, fencing_token, expires_at, heartbeat_at, created_at)
  values (p_workflow_id, v_step.id, 'step:' || v_step.id::text, p_owner, v_fence, p_now + make_interval(secs => p_lease_seconds), p_now, p_now) returning * into v_lease;
  update public.research_steps set status = 'running', attempt_count = attempt_count + 1, started_at = coalesce(started_at, p_now), updated_at = p_now where id = v_step.id returning * into v_step;
  update public.research_workflows set status = 'running', current_phase = p_step_key, started_at = coalesce(started_at, p_now), updated_at = p_now where id = p_workflow_id returning * into v_workflow;
  insert into public.research_attempts (workflow_id, step_id, attempt_number, lease_owner, started_at, estimated_cost_cents, created_at)
  values (p_workflow_id, v_step.id, v_step.attempt_count, p_owner, p_now, v_step.estimated_cost_cents, p_now) returning id into v_attempt_id;
  insert into public.workflow_events (workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at)
  values (p_workflow_id, 'step_started', jsonb_build_object('step', p_step_key), p_workflow_id, 'orchestrator', p_now);
  return jsonb_build_object('disposition', 'acquired', 'workflow', public.research_workflow_json(v_workflow), 'step', public.research_step_json(v_step), 'lease', public.workflow_lease_json(v_lease), 'attemptId', v_attempt_id);
end;
$$;

create or replace function public.complete_research_step(
  p_workflow_id uuid,
  p_step_key text,
  p_owner text,
  p_fencing_token bigint,
  p_output_reference text,
  p_now timestamptz default now()
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_step public.research_steps%rowtype; v_lease public.workflow_leases%rowtype;
begin
  select * into v_step from public.research_steps where workflow_id = p_workflow_id and step_key = p_step_key order by step_version desc limit 1 for update;
  if v_step.status = 'succeeded' then return true; end if;
  select * into v_lease from public.workflow_leases where workflow_id = p_workflow_id and step_id = v_step.id and released_at is null for update;
  if v_lease.id is null or v_lease.lease_owner <> p_owner or v_lease.fencing_token <> p_fencing_token or v_lease.expires_at <= p_now then return false; end if;
  update public.research_steps set status = 'succeeded', output_reference = left(p_output_reference, 250), completed_at = p_now, updated_at = p_now where id = v_step.id;
  update public.workflow_leases set released_at = p_now, release_reason = 'completed' where id = v_lease.id;
  update public.research_attempts set outcome = 'succeeded', finished_at = p_now where step_id = v_step.id and attempt_number = v_step.attempt_count;
  insert into public.workflow_events (workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at)
  values (p_workflow_id, 'step_succeeded', jsonb_build_object('step', p_step_key), p_workflow_id, 'orchestrator', p_now);
  if p_step_key = 'mark_ready_for_provider_research' then
    update public.research_workflows set status = 'ready_for_provider_research', current_phase = 'provider_research', updated_at = p_now where id = p_workflow_id;
    insert into public.workflow_events (workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at)
    values (p_workflow_id, 'workflow_ready_for_provider_research', '{}'::jsonb, p_workflow_id, 'orchestrator', p_now);
  elsif p_step_key = 'search_query_discovery' then
    update public.research_workflows set status = 'ready_for_search_intelligence', current_phase = 'search_intelligence', updated_at = p_now where id = p_workflow_id;
    insert into public.workflow_events (workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at)
    values (p_workflow_id, 'workflow_ready_for_search_intelligence', '{}'::jsonb, p_workflow_id, 'orchestrator', p_now);
  else
    update public.research_workflows set updated_at = p_now where id = p_workflow_id;
  end if;
  return true;
end;
$$;

create or replace function public.get_public_workflow_progress(p_report_request_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with workflow as (
    select * from public.research_workflows
    where report_request_id = p_report_request_id and workflow_type = 'initial_report'
    order by workflow_version desc limit 1
  ), step_state as (
    select
      coalesce(max(status) filter (where step_key = 'website_research'), 'pending') website_status,
      coalesce(max(status) filter (where step_key = 'company_profile_extraction'), 'pending') profile_status,
      coalesce(max(status) filter (where step_key = 'search_query_discovery'), 'pending') query_status,
      count(*) filter (where step_key = 'website_research') provider_steps
    from public.research_steps where workflow_id = (select id from workflow)
  )
  select jsonb_build_object(
    'state', case
      when w.status = 'ready_for_search_intelligence' then 'research_ready'
      when w.status in ('waiting_retry', 'paused') then 'temporarily_delayed'
      when w.status = 'partially_complete' then 'partially_complete'
      when w.status in ('failed', 'cancelled') then 'failed'
      when s.query_status in ('leased', 'running') then 'preparing_research'
      when s.profile_status in ('leased', 'running') then 'preparing_research'
      when s.website_status in ('leased', 'running') then 'preparing_research'
      when w.status in ('queued', 'dispatch_pending') then 'queued'
      else 'preparing_research' end,
    'currentStep', case
      when w.status in ('failed', 'cancelled') then 'failed'
      when s.query_status in ('leased', 'running', 'retry_scheduled', 'succeeded') then 'keywords'
      when s.profile_status in ('leased', 'running', 'retry_scheduled', 'succeeded') then 'analysis'
      when s.website_status in ('leased', 'running', 'retry_scheduled', 'succeeded') then 'crawl'
      else 'crawl' end,
    'steps', case when s.provider_steps = 0 then jsonb_build_array(
      jsonb_build_object('id', 'queued', 'label', 'Request received', 'status', 'complete', 'detail', null),
      jsonb_build_object(
        'id', case when w.status in ('failed', 'cancelled') then 'failed' else 'crawl' end,
        'label', 'Preparing research',
        'status', case when w.status in ('failed', 'cancelled') then 'failed' else 'running' end,
        'detail', case when w.status in ('waiting_retry', 'paused') then 'Preparation is temporarily delayed.' else null end
      )
    ) else jsonb_build_array(
      jsonb_build_object('id', 'queued', 'label', 'Request received', 'status', 'complete', 'detail', null),
      jsonb_build_object(
        'id', 'crawl', 'label', 'Reviewing your website',
        'status', case
          when s.website_status = 'succeeded' then 'complete'
          when s.website_status in ('leased', 'running', 'retry_scheduled') then 'running'
          when s.website_status in ('failed_terminal', 'cancelled') then 'failed'
          else 'pending' end,
        'detail', case when s.website_status = 'retry_scheduled' then 'Website review is temporarily delayed.' else null end
      ),
      jsonb_build_object(
        'id', 'analysis', 'label', 'Building your company profile',
        'status', case
          when s.profile_status = 'succeeded' then 'complete'
          when s.profile_status in ('leased', 'running', 'retry_scheduled') then 'running'
          when s.profile_status in ('failed_terminal', 'cancelled') then 'failed'
          else 'pending' end,
        'detail', case when s.profile_status = 'retry_scheduled' then 'Company analysis is temporarily delayed.' else null end
      ),
      jsonb_build_object(
        'id', 'keywords', 'label', 'Preparing your market research',
        'status', case
          when s.query_status = 'succeeded' then 'complete'
          when s.query_status in ('leased', 'running', 'retry_scheduled') then 'running'
          when s.query_status in ('failed_terminal', 'cancelled') then 'failed'
          else 'pending' end,
        'detail', case when s.query_status = 'retry_scheduled' then 'Market research preparation is temporarily delayed.' else null end
      )
    ) end,
    'errorSummary', case when w.status = 'failed' then 'The research could not continue. Please try again.' else null end
  ) from workflow w cross join step_state s;
$$;

revoke execute on function public.prepare_v3_provider_research(uuid, integer, integer, integer, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.get_provider_research_input(uuid) from public, anon, authenticated;
revoke execute on function public.ensure_provider_operation(uuid, text, text, text, text, text, integer, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.get_provider_operation(uuid, text) from public, anon, authenticated;
revoke execute on function public.begin_provider_operation_attempt(uuid, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.record_provider_job(uuid, uuid, text, integer, jsonb, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.schedule_provider_operation_retry(uuid, uuid, integer, timestamptz, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.fail_provider_operation(uuid, uuid, text, integer, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.store_website_research_page(uuid, integer, text, text, text, text, text, text, jsonb, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.complete_website_research_operation(uuid, uuid, integer, jsonb, integer, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.get_website_research_evidence(uuid) from public, anon, authenticated;
revoke execute on function public.persist_company_profile(uuid, uuid, text, text, text, text, text, integer, integer, integer, jsonb, integer, integer, timestamptz, jsonb, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.get_latest_company_profile(uuid) from public, anon, authenticated;
revoke execute on function public.persist_search_query_set(uuid, uuid, uuid, text, text, text, text, text, integer, integer, integer, jsonb, integer, integer, timestamptz, jsonb, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;

grant execute on function public.prepare_v3_provider_research(uuid, integer, integer, integer, integer, timestamptz) to service_role;
grant execute on function public.get_provider_research_input(uuid) to service_role;
grant execute on function public.ensure_provider_operation(uuid, text, text, text, text, text, integer, integer, timestamptz) to service_role;
grant execute on function public.get_provider_operation(uuid, text) to service_role;
grant execute on function public.begin_provider_operation_attempt(uuid, text, timestamptz) to service_role;
grant execute on function public.record_provider_job(uuid, uuid, text, integer, jsonb, timestamptz, timestamptz) to service_role;
grant execute on function public.schedule_provider_operation_retry(uuid, uuid, integer, timestamptz, text, text, timestamptz) to service_role;
grant execute on function public.fail_provider_operation(uuid, uuid, text, integer, text, text, timestamptz) to service_role;
grant execute on function public.store_website_research_page(uuid, integer, text, text, text, text, text, text, jsonb, timestamptz, timestamptz, timestamptz) to service_role;
grant execute on function public.complete_website_research_operation(uuid, uuid, integer, jsonb, integer, timestamptz, timestamptz) to service_role;
grant execute on function public.get_website_research_evidence(uuid) to service_role;
grant execute on function public.persist_company_profile(uuid, uuid, text, text, text, text, text, integer, integer, integer, jsonb, integer, integer, timestamptz, jsonb, timestamptz, timestamptz, timestamptz) to service_role;
grant execute on function public.get_latest_company_profile(uuid) to service_role;
grant execute on function public.persist_search_query_set(uuid, uuid, uuid, text, text, text, text, text, integer, integer, integer, jsonb, integer, integer, timestamptz, jsonb, timestamptz, timestamptz, timestamptz) to service_role;
