-- PR4 durable analysis-response recovery and deterministic crawl-context selection.
-- Migrations 0005 and 0006 remain immutable; this migration only extends their contracts.

alter table public.provider_operations
  add column if not exists provider_response_status text
    check (provider_response_status in (
      'completed', 'failed', 'in_progress', 'cancelled', 'queued', 'incomplete'
    )),
  add column if not exists provider_response_received_at timestamptz,
  add column if not exists processing_status text not null default 'pending'
    check (processing_status in ('pending', 'processing', 'succeeded', 'failed')),
  add column if not exists processing_phase text
    check (processing_phase in (
      'response_capture', 'response_validation', 'retrieval', 'parse',
      'evidence_validation', 'persistence', 'complete'
    ));

alter table public.provider_operation_attempts
  add column if not exists provider_response_status text
    check (provider_response_status in (
      'completed', 'failed', 'in_progress', 'cancelled', 'queued', 'incomplete'
    )),
  add column if not exists provider_response_received_at timestamptz;

create table public.analysis_response_artifacts (
  id uuid primary key default gen_random_uuid(),
  provider_operation_id uuid not null unique
    references public.provider_operations(id) on delete cascade,
  provider_attempt_id uuid not null
    references public.provider_operation_attempts(id) on delete restrict,
  provider text not null check (provider in ('openai', 'mock')),
  provider_response_id text not null,
  provider_request_id text,
  response_status text not null check (response_status in (
    'completed', 'failed', 'in_progress', 'cancelled', 'queued', 'incomplete'
  )),
  model_identifier text not null,
  prompt_template_version text not null,
  schema_version text not null,
  provider_created_at timestamptz,
  response_received_at timestamptz not null,
  provider_usage jsonb not null default '{}'::jsonb,
  actual_cost_cents integer not null check (actual_cost_cents >= 0),
  output_text text,
  output_hash text,
  refusal text,
  incomplete_reason text check (incomplete_reason in ('max_output_tokens', 'content_filter')),
  provider_error_code text,
  artifact_complete boolean not null,
  sanitized_metadata jsonb not null default '{}'::jsonb,
  parse_status text not null default 'pending'
    check (parse_status in ('pending', 'succeeded', 'failed')),
  parse_attempts integer not null default 0 check (parse_attempts >= 0),
  persistence_status text not null default 'pending'
    check (persistence_status in ('pending', 'succeeded', 'failed')),
  persistence_attempts integer not null default 0 check (persistence_attempts >= 0),
  first_failure_classification text check (first_failure_classification in (
    'transient', 'permanent', 'budget_blocked', 'cancelled',
    'lease_conflict', 'configuration_error'
  )),
  first_safe_code text,
  first_safe_summary text,
  current_failure_classification text check (current_failure_classification in (
    'transient', 'permanent', 'budget_blocked', 'cancelled',
    'lease_conflict', 'configuration_error'
  )),
  current_safe_code text,
  current_safe_summary text,
  processing_phase text not null default 'response_capture' check (processing_phase in (
    'response_capture', 'response_validation', 'retrieval', 'parse',
    'evidence_validation', 'persistence', 'complete'
  )),
  reconciliation_status text not null default 'not_required' check (reconciliation_status in (
    'not_required', 'retrieval_required', 'retrieval_failed', 'recovered'
  )),
  retrieval_attempts integer not null default 0 check (retrieval_attempts >= 0),
  parsed_at timestamptz,
  persisted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint analysis_response_artifacts_provider_response_key
    unique (provider, provider_response_id),
  check (char_length(provider_response_id) between 1 and 250),
  check (provider_request_id is null or char_length(provider_request_id) <= 250),
  check (char_length(model_identifier) between 1 and 120),
  check (char_length(prompt_template_version) between 1 and 80),
  check (char_length(schema_version) between 1 and 80),
  check (jsonb_typeof(provider_usage) = 'object' and octet_length(provider_usage::text) < 32768),
  check (output_text is null or char_length(output_text) <= 120000),
  check (output_hash is null or output_hash ~ '^[a-f0-9]{64}$'),
  check (refusal is null or char_length(refusal) <= 4000),
  check (provider_error_code is null or char_length(provider_error_code) <= 120),
  check (jsonb_typeof(sanitized_metadata) = 'object'
    and octet_length(sanitized_metadata::text) < 32768),
  check (first_safe_code is null or char_length(first_safe_code) <= 80),
  check (first_safe_summary is null or char_length(first_safe_summary) <= 240),
  check (current_safe_code is null or char_length(current_safe_code) <= 80),
  check (current_safe_summary is null or char_length(current_safe_summary) <= 240)
);

create table public.analysis_response_diagnostics (
  id uuid primary key default gen_random_uuid(),
  analysis_response_artifact_id uuid not null
    references public.analysis_response_artifacts(id) on delete cascade,
  diagnostic_sequence integer not null check (diagnostic_sequence > 0),
  processing_phase text not null check (processing_phase in (
    'response_capture', 'response_validation', 'retrieval', 'parse',
    'evidence_validation', 'persistence', 'complete'
  )),
  processing_status text not null check (processing_status in ('succeeded', 'failed')),
  failure_classification text check (failure_classification in (
    'transient', 'permanent', 'budget_blocked', 'cancelled',
    'lease_conflict', 'configuration_error'
  )),
  safe_code text,
  safe_summary text,
  created_at timestamptz not null default now(),
  constraint analysis_response_diagnostics_sequence_key
    unique (analysis_response_artifact_id, diagnostic_sequence),
  check ((processing_status = 'failed') = (failure_classification is not null)),
  check (safe_code is null or char_length(safe_code) <= 80),
  check (safe_summary is null or char_length(safe_summary) <= 240)
);

create table public.analysis_response_retrieval_attempts (
  id uuid primary key default gen_random_uuid(),
  analysis_response_artifact_id uuid not null
    references public.analysis_response_artifacts(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  retrieval_status text not null check (retrieval_status in ('succeeded', 'failed')),
  provider_request_id text,
  safe_code text,
  safe_summary text,
  created_at timestamptz not null default now(),
  constraint analysis_response_retrieval_attempts_number_key
    unique (analysis_response_artifact_id, attempt_number),
  check (provider_request_id is null or char_length(provider_request_id) <= 250),
  check (safe_code is null or char_length(safe_code) <= 80),
  check (safe_summary is null or char_length(safe_summary) <= 240)
);

create table public.content_selection_runs (
  id uuid primary key default gen_random_uuid(),
  provider_operation_id uuid not null unique
    references public.provider_operations(id) on delete cascade,
  selection_version text not null,
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  limits jsonb not null,
  total_original_characters integer not null check (total_original_characters >= 0),
  total_selected_characters integer not null check (total_selected_characters >= 0),
  legal_selected_characters integer not null check (legal_selected_characters >= 0),
  created_at timestamptz not null default now(),
  check (char_length(selection_version) between 1 and 80),
  check (jsonb_typeof(limits) = 'object' and octet_length(limits::text) < 8192),
  check (legal_selected_characters <= total_selected_characters)
);

create table public.content_selection_pages (
  id uuid primary key default gen_random_uuid(),
  content_selection_run_id uuid not null
    references public.content_selection_runs(id) on delete cascade,
  source_snapshot_id uuid not null references public.source_snapshots(id) on delete restrict,
  page_index integer not null check (page_index between 0 and 1000),
  page_classification text not null check (page_classification in (
    'homepage', 'about', 'product_service', 'solution_use_case', 'pricing',
    'proof', 'team', 'contact_location', 'documentation', 'legal_admin', 'general'
  )),
  page_rank integer not null check (page_rank > 0),
  included boolean not null,
  inclusion_reason text,
  exclusion_reason text,
  original_characters integer not null check (original_characters >= 0),
  selected_characters integer not null check (selected_characters >= 0),
  selected_order integer check (selected_order > 0),
  selected_content_hash text,
  selected_markdown text not null default '',
  created_at timestamptz not null default now(),
  constraint content_selection_pages_snapshot_key
    unique (content_selection_run_id, source_snapshot_id),
  constraint content_selection_pages_rank_key
    unique (content_selection_run_id, page_rank),
  check (inclusion_reason is null or char_length(inclusion_reason) <= 240),
  check (exclusion_reason is null or char_length(exclusion_reason) <= 240),
  check (selected_content_hash is null or selected_content_hash ~ '^[a-f0-9]{64}$'),
  check (char_length(selected_markdown) <= 30000),
  check (
    (included and inclusion_reason is not null and exclusion_reason is null
      and selected_order is not null and selected_characters > 0
      and selected_content_hash is not null and char_length(selected_markdown) = selected_characters)
    or
    (not included and inclusion_reason is null and exclusion_reason is not null
      and selected_order is null and selected_characters = 0
      and selected_content_hash is null and selected_markdown = '')
  )
);

create unique index content_selection_pages_included_order_key
  on public.content_selection_pages(content_selection_run_id, selected_order)
  where selected_order is not null;
create index analysis_response_diagnostics_artifact_created_idx
  on public.analysis_response_diagnostics(analysis_response_artifact_id, created_at);
create index analysis_response_retrieval_artifact_created_idx
  on public.analysis_response_retrieval_attempts(analysis_response_artifact_id, created_at);
create index content_selection_pages_run_included_idx
  on public.content_selection_pages(content_selection_run_id, included, page_rank);

alter table public.analysis_response_artifacts enable row level security;
alter table public.analysis_response_diagnostics enable row level security;
alter table public.analysis_response_retrieval_attempts enable row level security;
alter table public.content_selection_runs enable row level security;
alter table public.content_selection_pages enable row level security;

revoke all on table public.analysis_response_artifacts
  from public, anon, authenticated, service_role;
revoke all on table public.analysis_response_diagnostics
  from public, anon, authenticated, service_role;
revoke all on table public.analysis_response_retrieval_attempts
  from public, anon, authenticated, service_role;
revoke all on table public.content_selection_runs
  from public, anon, authenticated, service_role;
revoke all on table public.content_selection_pages
  from public, anon, authenticated, service_role;

drop trigger if exists analysis_response_diagnostics_immutable
  on public.analysis_response_diagnostics;
create trigger analysis_response_diagnostics_immutable
before update or delete on public.analysis_response_diagnostics
for each row execute function public.reject_immutable_research_update();

drop trigger if exists analysis_response_retrieval_attempts_immutable
  on public.analysis_response_retrieval_attempts;
create trigger analysis_response_retrieval_attempts_immutable
before update or delete on public.analysis_response_retrieval_attempts
for each row execute function public.reject_immutable_research_update();

drop trigger if exists content_selection_runs_immutable on public.content_selection_runs;
create trigger content_selection_runs_immutable
before update or delete on public.content_selection_runs
for each row execute function public.reject_immutable_research_update();

drop trigger if exists content_selection_pages_immutable on public.content_selection_pages;
create trigger content_selection_pages_immutable
before update or delete on public.content_selection_pages
for each row execute function public.reject_immutable_research_update();

create or replace function public.guard_analysis_response_artifact_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.provider_operation_id <> old.provider_operation_id
    or new.provider_attempt_id <> old.provider_attempt_id
    or new.provider <> old.provider
    or new.provider_response_id <> old.provider_response_id
    or new.model_identifier <> old.model_identifier
    or new.prompt_template_version <> old.prompt_template_version
    or new.schema_version <> old.schema_version
    or new.actual_cost_cents <> old.actual_cost_cents
    or new.response_received_at <> old.response_received_at then
    raise exception using message = 'analysis_response_identity_is_immutable', errcode = 'P0001';
  end if;
  if old.artifact_complete and (
    new.output_text is distinct from old.output_text
    or new.output_hash is distinct from old.output_hash
    or new.refusal is distinct from old.refusal
    or new.provider_usage is distinct from old.provider_usage
    or new.response_status is distinct from old.response_status
  ) then
    raise exception using message = 'complete_analysis_response_is_immutable', errcode = 'P0001';
  end if;
  if old.first_failure_classification is not null and (
    new.first_failure_classification is distinct from old.first_failure_classification
    or new.first_safe_code is distinct from old.first_safe_code
    or new.first_safe_summary is distinct from old.first_safe_summary
  ) then
    raise exception using message = 'first_analysis_failure_is_immutable', errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_analysis_response_artifact_update_trigger
  on public.analysis_response_artifacts;
create trigger guard_analysis_response_artifact_update_trigger
before update on public.analysis_response_artifacts
for each row execute function public.guard_analysis_response_artifact_update();

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
    'reservedCostCents', p_operation.reserved_cost_cents,
    'actualCostCents', p_operation.actual_cost_cents,
    'outcome', p_operation.outcome_class,
    'reconciliationRequired', p_operation.reconciliation_required,
    'reservationGeneration', p_operation.reservation_generation,
    'settledAt', p_operation.settled_at,
    'providerUsage', p_operation.provider_usage,
    'lastHttpStatus', p_operation.last_http_status,
    'lastSafeErrorCode', p_operation.last_safe_error_code,
    'lastSafeErrorSummary', p_operation.last_safe_error_summary,
    'providerStartedAt', p_operation.provider_started_at,
    'providerCompletedAt', p_operation.provider_completed_at,
    'providerResponseStatus', p_operation.provider_response_status,
    'providerResponseReceivedAt', p_operation.provider_response_received_at,
    'processingStatus', p_operation.processing_status,
    'processingPhase', p_operation.processing_phase,
    'createdAt', p_operation.created_at, 'updatedAt', p_operation.updated_at
  );
$$;

create or replace function public.analysis_response_artifact_json(
  p_artifact public.analysis_response_artifacts
)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_artifact.id,
    'operationId', p_artifact.provider_operation_id,
    'providerAttemptId', p_artifact.provider_attempt_id,
    'provider', p_artifact.provider,
    'providerResponseId', p_artifact.provider_response_id,
    'providerRequestId', p_artifact.provider_request_id,
    'responseStatus', p_artifact.response_status,
    'model', p_artifact.model_identifier,
    'promptTemplateVersion', p_artifact.prompt_template_version,
    'schemaVersion', p_artifact.schema_version,
    'providerCreatedAt', p_artifact.provider_created_at,
    'responseReceivedAt', p_artifact.response_received_at,
    'usage', p_artifact.provider_usage,
    'actualCostCents', p_artifact.actual_cost_cents,
    'outputText', p_artifact.output_text,
    'refusal', p_artifact.refusal,
    'incompleteReason', p_artifact.incomplete_reason,
    'providerErrorCode', p_artifact.provider_error_code,
    'artifactComplete', p_artifact.artifact_complete,
    'sanitizedMetadata', p_artifact.sanitized_metadata,
    'parseStatus', p_artifact.parse_status,
    'parseAttempts', p_artifact.parse_attempts,
    'persistenceStatus', p_artifact.persistence_status,
    'persistenceAttempts', p_artifact.persistence_attempts,
    'processingPhase', p_artifact.processing_phase,
    'firstFailureClassification', p_artifact.first_failure_classification,
    'firstSafeCode', p_artifact.first_safe_code,
    'firstSafeSummary', p_artifact.first_safe_summary,
    'currentFailureClassification', p_artifact.current_failure_classification,
    'currentSafeCode', p_artifact.current_safe_code,
    'currentSafeSummary', p_artifact.current_safe_summary,
    'reconciliationStatus', p_artifact.reconciliation_status,
    'retrievalAttempts', p_artifact.retrieval_attempts,
    'parsedAt', p_artifact.parsed_at,
    'persistedAt', p_artifact.persisted_at
  );
$$;

create or replace function public.persist_v3_content_selection(
  p_operation_id uuid,
  p_selection_version text,
  p_input_hash text,
  p_limits jsonb,
  p_total_original_characters integer,
  p_total_selected_characters integer,
  p_legal_selected_characters integer,
  p_pages jsonb,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.provider_operations%rowtype;
  v_run public.content_selection_runs%rowtype;
  v_page jsonb;
  v_snapshot public.source_snapshots%rowtype;
begin
  select * into v_operation from public.provider_operations where id = p_operation_id;
  if v_operation.id is null or v_operation.operation_kind <> 'company_profile_extraction' then
    raise exception using message = 'content_selection_operation_invalid', errcode = 'P0001';
  end if;
  if jsonb_typeof(p_pages) <> 'array' or jsonb_array_length(p_pages) < 1
    or p_input_hash !~ '^[a-f0-9]{64}$' then
    raise exception using message = 'content_selection_payload_invalid', errcode = 'P0001';
  end if;
  insert into public.content_selection_runs (
    provider_operation_id, selection_version, input_hash, limits,
    total_original_characters, total_selected_characters,
    legal_selected_characters, created_at
  ) values (
    p_operation_id, p_selection_version, p_input_hash, p_limits,
    p_total_original_characters, p_total_selected_characters,
    p_legal_selected_characters, p_now
  ) on conflict (provider_operation_id) do nothing;
  select * into v_run from public.content_selection_runs
  where provider_operation_id = p_operation_id;
  if v_run.input_hash <> p_input_hash or v_run.selection_version <> p_selection_version then
    raise exception using message = 'content_selection_idempotency_conflict', errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.content_selection_pages
    where content_selection_run_id = v_run.id
  ) then
    return jsonb_build_object('selectionRunId', v_run.id);
  end if;
  for v_page in select value from jsonb_array_elements(p_pages) loop
    select ss.* into v_snapshot
    from public.source_snapshots ss
    join public.provider_operations po on po.id = ss.provider_operation_id
    where ss.id = (v_page ->> 'snapshotId')::uuid
      and po.workflow_id = v_operation.workflow_id
      and po.operation_kind = 'website_research'
      and ss.page_index = (v_page ->> 'pageIndex')::integer;
    if v_snapshot.id is null then
      raise exception using message = 'content_selection_snapshot_invalid', errcode = 'P0001';
    end if;
    insert into public.content_selection_pages (
      content_selection_run_id, source_snapshot_id, page_index,
      page_classification, page_rank, included, inclusion_reason,
      exclusion_reason, original_characters, selected_characters,
      selected_order, selected_content_hash, selected_markdown, created_at
    ) values (
      v_run.id, v_snapshot.id, (v_page ->> 'pageIndex')::integer,
      v_page ->> 'classification', (v_page ->> 'rank')::integer,
      (v_page ->> 'included')::boolean, nullif(v_page ->> 'inclusionReason', ''),
      nullif(v_page ->> 'exclusionReason', ''),
      (v_page ->> 'originalCharacters')::integer,
      (v_page ->> 'selectedCharacters')::integer,
      nullif(v_page ->> 'selectedOrder', '')::integer,
      nullif(v_page ->> 'selectedContentHash', ''),
      coalesce(v_page ->> 'selectedMarkdown', ''), p_now
    );
  end loop;
  if (select count(*) from public.content_selection_pages
      where content_selection_run_id = v_run.id) <> jsonb_array_length(p_pages) then
    raise exception using message = 'content_selection_page_count_invalid', errcode = 'P0001';
  end if;
  return jsonb_build_object('selectionRunId', v_run.id);
end;
$$;

create or replace function public.get_v3_content_selection(p_operation_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'version', r.selection_version,
    'inputHash', r.input_hash,
    'limits', r.limits,
    'totalOriginalCharacters', r.total_original_characters,
    'totalSelectedCharacters', r.total_selected_characters,
    'legalSelectedCharacters', r.legal_selected_characters,
    'pages', coalesce((select jsonb_agg(jsonb_build_object(
      'snapshotId', p.source_snapshot_id,
      'pageIndex', p.page_index,
      'sourceUrl', d.source_url,
      'canonicalUrl', d.canonical_url,
      'title', s.title,
      'description', s.description,
      'contentHash', s.content_hash,
      'classification', p.page_classification,
      'rank', p.page_rank,
      'included', p.included,
      'inclusionReason', p.inclusion_reason,
      'exclusionReason', p.exclusion_reason,
      'originalCharacters', p.original_characters,
      'selectedCharacters', p.selected_characters,
      'selectedOrder', p.selected_order,
      'selectedContentHash', p.selected_content_hash,
      'selectedMarkdown', p.selected_markdown
    ) order by p.page_index)
      from public.content_selection_pages p
      join public.source_snapshots s on s.id = p.source_snapshot_id
      join public.source_documents d on d.id = s.source_document_id
      where p.content_selection_run_id = r.id), '[]'::jsonb)
  ) from public.content_selection_runs r
  where r.provider_operation_id = p_operation_id;
$$;

create or replace function public.get_v3_analysis_response(p_operation_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.analysis_response_artifact_json(a)
  from public.analysis_response_artifacts a
  where a.provider_operation_id = p_operation_id;
$$;

create or replace function public.capture_v3_analysis_response(
  p_operation_id uuid,
  p_attempt_id uuid,
  p_provider_response_id text,
  p_provider_request_id text,
  p_response_status text,
  p_model_identifier text,
  p_prompt_template_version text,
  p_schema_version text,
  p_provider_created_at timestamptz,
  p_response_received_at timestamptz,
  p_provider_usage jsonb,
  p_actual_cost_cents integer,
  p_output_text text,
  p_refusal text,
  p_incomplete_reason text,
  p_provider_error_code text,
  p_artifact_complete boolean,
  p_sanitized_metadata jsonb,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.provider_operations%rowtype;
  v_attempt public.provider_operation_attempts%rowtype;
  v_budget public.report_cost_budgets%rowtype;
  v_artifact public.analysis_response_artifacts%rowtype;
  v_release integer;
  v_cost_key text;
begin
  perform pg_advisory_xact_lock(hashtextextended('provider-operation:' || p_operation_id::text, 0));
  select * into v_operation from public.provider_operations where id = p_operation_id for update;
  if v_operation.id is null
    or v_operation.operation_kind not in ('company_profile_extraction', 'search_query_discovery')
    or v_operation.provider not in ('openai', 'mock') then
    raise exception using message = 'analysis_response_operation_invalid', errcode = 'P0001';
  end if;
  select * into v_artifact from public.analysis_response_artifacts
  where provider_operation_id = p_operation_id;
  if v_artifact.id is not null then
    if v_artifact.provider_response_id <> p_provider_response_id
      or v_artifact.actual_cost_cents <> p_actual_cost_cents then
      raise exception using message = 'analysis_response_idempotency_conflict', errcode = 'P0001';
    end if;
    return public.analysis_response_artifact_json(v_artifact);
  end if;
  select * into v_attempt from public.provider_operation_attempts
  where id = p_attempt_id and provider_operation_id = p_operation_id
    and attempt_phase = 'submit' and attempt_state = 'started' for update;
  if v_attempt.id is null or v_operation.operation_state <> 'submitting' then
    raise exception using message = 'analysis_response_attempt_fenced', errcode = 'P0001';
  end if;
  if p_actual_cost_cents < 0 or p_actual_cost_cents > v_operation.reserved_cost_cents
    or (v_operation.reserved_cost_cents = 0 and p_actual_cost_cents <> 0) then
    raise exception using message = 'analysis_response_cost_invalid', errcode = 'P0001';
  end if;
  if p_response_status not in (
    'completed', 'failed', 'in_progress', 'cancelled', 'queued', 'incomplete'
  ) or p_provider_response_id is null or char_length(p_provider_response_id) not between 1 and 250
    or jsonb_typeof(p_provider_usage) <> 'object'
    or jsonb_typeof(p_sanitized_metadata) <> 'object' then
    raise exception using message = 'analysis_response_payload_invalid', errcode = 'P0001';
  end if;

  if v_operation.reserved_cost_cents > 0 then
    select * into v_budget from public.report_cost_budgets
    where workflow_id = v_operation.workflow_id for update;
    if v_budget.workflow_id is null
      or v_budget.reserved_cents < v_operation.reserved_cost_cents then
      raise exception using message = 'invalid_cost_reservation', errcode = 'P0001';
    end if;
    update public.report_cost_budgets
    set reserved_cents = reserved_cents - v_operation.reserved_cost_cents,
      spent_cents = spent_cents + p_actual_cost_cents,
      updated_at = p_now
    where workflow_id = v_operation.workflow_id;
    v_cost_key := v_operation.idempotency_key || ':provider-response:' ||
      v_operation.reservation_generation::text;
    insert into public.report_cost_entries (
      workflow_id, step_id, entry_type, amount_cents, idempotency_key, created_at
    ) values (
      v_operation.workflow_id, v_operation.step_id, 'actual', p_actual_cost_cents,
      v_cost_key || ':actual', p_now
    ) on conflict (idempotency_key) do nothing;
    v_release := v_operation.reserved_cost_cents - p_actual_cost_cents;
    if v_release > 0 then
      insert into public.report_cost_entries (
        workflow_id, step_id, entry_type, amount_cents, idempotency_key, created_at
      ) values (
        v_operation.workflow_id, v_operation.step_id, 'release', v_release,
        v_cost_key || ':unused', p_now
      ) on conflict (idempotency_key) do nothing;
    end if;
  end if;

  insert into public.analysis_response_artifacts (
    provider_operation_id, provider_attempt_id, provider,
    provider_response_id, provider_request_id, response_status,
    model_identifier, prompt_template_version, schema_version,
    provider_created_at, response_received_at, provider_usage,
    actual_cost_cents, output_text, output_hash, refusal,
    incomplete_reason, provider_error_code, artifact_complete,
    sanitized_metadata, reconciliation_status, created_at, updated_at
  ) values (
    p_operation_id, p_attempt_id, v_operation.provider,
    p_provider_response_id, nullif(p_provider_request_id, ''), p_response_status,
    p_model_identifier, p_prompt_template_version, p_schema_version,
    p_provider_created_at, p_response_received_at, p_provider_usage,
    p_actual_cost_cents, nullif(p_output_text, ''),
    case when nullif(p_output_text, '') is null then null else
      encode(pg_catalog.sha256(convert_to(p_output_text, 'UTF8')), 'hex') end,
    nullif(p_refusal, ''), p_incomplete_reason, nullif(p_provider_error_code, ''),
    p_artifact_complete, p_sanitized_metadata,
    case when p_artifact_complete then 'not_required' else 'retrieval_required' end,
    p_now, p_now
  ) returning * into v_artifact;

  update public.provider_operation_attempts
  set provider_request_reference = left(p_provider_response_id, 250),
    provider_response_status = p_response_status,
    provider_response_received_at = p_response_received_at
  where id = p_attempt_id;
  update public.provider_operations
  set provider_job_id = left(p_provider_response_id, 250),
    reserved_cost_cents = 0,
    actual_cost_cents = p_actual_cost_cents,
    outcome_class = 'succeeded', reconciliation_required = false,
    provider_usage = p_provider_usage,
    provider_completed_at = p_response_received_at,
    provider_response_status = p_response_status,
    provider_response_received_at = p_response_received_at,
    processing_status = 'pending', processing_phase = 'response_capture',
    last_safe_error_code = null, last_safe_error_summary = null,
    settled_at = coalesce(settled_at, p_now), updated_at = p_now
  where id = p_operation_id;
  insert into public.workflow_events (
    workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at
  ) values (
    v_operation.workflow_id, 'analysis_response_captured',
    jsonb_build_object('step', v_operation.operation_kind,
      'responseStatus', p_response_status, 'actualCostCents', p_actual_cost_cents),
    v_operation.workflow_id, 'orchestrator', p_now
  );
  return public.analysis_response_artifact_json(v_artifact);
end;
$$;

create or replace function public.record_v3_analysis_response_retrieval(
  p_artifact_id uuid,
  p_provider_response_id text,
  p_provider_request_id text,
  p_response_status text,
  p_provider_usage jsonb,
  p_output_text text,
  p_refusal text,
  p_incomplete_reason text,
  p_provider_error_code text,
  p_artifact_complete boolean,
  p_sanitized_metadata jsonb,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_artifact public.analysis_response_artifacts%rowtype;
  v_attempt_number integer;
begin
  select * into v_artifact from public.analysis_response_artifacts
  where id = p_artifact_id for update;
  if v_artifact.id is null or v_artifact.provider_response_id <> p_provider_response_id then
    raise exception using message = 'analysis_response_retrieval_mismatch', errcode = 'P0001';
  end if;
  if v_artifact.artifact_complete then
    return public.analysis_response_artifact_json(v_artifact);
  end if;
  v_attempt_number := v_artifact.retrieval_attempts + 1;
  insert into public.analysis_response_retrieval_attempts (
    analysis_response_artifact_id, attempt_number, retrieval_status,
    provider_request_id, created_at
  ) values (
    v_artifact.id, v_attempt_number, 'succeeded',
    nullif(p_provider_request_id, ''), p_now
  );
  update public.analysis_response_artifacts
  set provider_request_id = coalesce(nullif(p_provider_request_id, ''), provider_request_id),
    response_status = p_response_status,
    provider_usage = p_provider_usage,
    output_text = nullif(p_output_text, ''),
    output_hash = case when nullif(p_output_text, '') is null then null else
      encode(pg_catalog.sha256(convert_to(p_output_text, 'UTF8')), 'hex') end,
    refusal = nullif(p_refusal, ''), incomplete_reason = p_incomplete_reason,
    provider_error_code = nullif(p_provider_error_code, ''),
    artifact_complete = p_artifact_complete,
    sanitized_metadata = p_sanitized_metadata,
    processing_phase = 'retrieval', retrieval_attempts = v_attempt_number,
    reconciliation_status = case when p_artifact_complete then 'recovered'
      else 'retrieval_required' end,
    updated_at = p_now
  where id = p_artifact_id returning * into v_artifact;
  update public.provider_operations
  set provider_response_status = p_response_status,
    processing_status = 'processing', processing_phase = 'retrieval', updated_at = p_now
  where id = v_artifact.provider_operation_id;
  return public.analysis_response_artifact_json(v_artifact);
end;
$$;

create or replace function public.record_v3_analysis_processing_result(
  p_artifact_id uuid,
  p_phase text,
  p_status text,
  p_classification text,
  p_safe_code text,
  p_safe_summary text,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_artifact public.analysis_response_artifacts%rowtype;
  v_sequence integer;
  v_retrieval_attempt integer;
begin
  if p_phase not in (
    'response_capture', 'response_validation', 'retrieval', 'parse',
    'evidence_validation', 'persistence', 'complete'
  ) or p_status not in ('succeeded', 'failed') then
    raise exception using message = 'analysis_processing_result_invalid', errcode = 'P0001';
  end if;
  if (p_status = 'failed') <> (p_classification is not null) then
    raise exception using message = 'analysis_processing_failure_invalid', errcode = 'P0001';
  end if;
  select * into v_artifact from public.analysis_response_artifacts
  where id = p_artifact_id for update;
  if v_artifact.id is null then
    raise exception using message = 'analysis_response_artifact_not_found', errcode = 'P0001';
  end if;
  select coalesce(max(diagnostic_sequence), 0) + 1 into v_sequence
  from public.analysis_response_diagnostics
  where analysis_response_artifact_id = p_artifact_id;
  insert into public.analysis_response_diagnostics (
    analysis_response_artifact_id, diagnostic_sequence, processing_phase,
    processing_status, failure_classification, safe_code, safe_summary, created_at
  ) values (
    p_artifact_id, v_sequence, p_phase, p_status, p_classification,
    left(p_safe_code, 80), left(p_safe_summary, 240), p_now
  );

  if p_phase = 'retrieval' and p_status = 'failed' then
    v_retrieval_attempt := v_artifact.retrieval_attempts + 1;
    insert into public.analysis_response_retrieval_attempts (
      analysis_response_artifact_id, attempt_number, retrieval_status,
      safe_code, safe_summary, created_at
    ) values (
      p_artifact_id, v_retrieval_attempt, 'failed',
      left(p_safe_code, 80), left(p_safe_summary, 240), p_now
    );
  else
    v_retrieval_attempt := v_artifact.retrieval_attempts;
  end if;

  update public.analysis_response_artifacts
  set parse_status = case
      when p_phase in ('response_validation', 'parse', 'evidence_validation') then p_status
      else parse_status end,
    parse_attempts = parse_attempts + case
      when p_phase in ('response_validation', 'parse', 'evidence_validation') then 1 else 0 end,
    persistence_status = case when p_phase in ('persistence', 'complete') then p_status
      else persistence_status end,
    persistence_attempts = persistence_attempts + case
      when p_phase in ('persistence', 'complete') then 1 else 0 end,
    first_failure_classification = case when p_status = 'failed'
      then coalesce(first_failure_classification, p_classification)
      else first_failure_classification end,
    first_safe_code = case when p_status = 'failed'
      then coalesce(first_safe_code, left(p_safe_code, 80)) else first_safe_code end,
    first_safe_summary = case when p_status = 'failed'
      then coalesce(first_safe_summary, left(p_safe_summary, 240)) else first_safe_summary end,
    current_failure_classification = case when p_status = 'failed' then p_classification else null end,
    current_safe_code = case when p_status = 'failed' then left(p_safe_code, 80) else null end,
    current_safe_summary = case when p_status = 'failed' then left(p_safe_summary, 240) else null end,
    processing_phase = p_phase,
    reconciliation_status = case
      when p_phase = 'retrieval' and p_status = 'failed' then 'retrieval_failed'
      else reconciliation_status end,
    retrieval_attempts = v_retrieval_attempt,
    parsed_at = case when p_phase in ('parse', 'evidence_validation') and p_status = 'succeeded'
      then coalesce(parsed_at, p_now) else parsed_at end,
    persisted_at = case when p_phase = 'complete' and p_status = 'succeeded'
      then coalesce(persisted_at, p_now) else persisted_at end,
    updated_at = p_now
  where id = p_artifact_id returning * into v_artifact;
  update public.provider_operations
  set processing_status = case when p_status = 'failed' then 'failed'
      when p_phase = 'complete' then 'succeeded' else 'processing' end,
    processing_phase = p_phase, updated_at = p_now
  where id = v_artifact.provider_operation_id;
  return public.analysis_response_artifact_json(v_artifact);
end;
$$;

revoke execute on function public.persist_v3_content_selection(
  uuid, text, text, jsonb, integer, integer, integer, jsonb, timestamptz
) from public, anon, authenticated;
revoke execute on function public.get_v3_content_selection(uuid)
  from public, anon, authenticated;
revoke execute on function public.get_v3_analysis_response(uuid)
  from public, anon, authenticated;
revoke execute on function public.capture_v3_analysis_response(
  uuid, uuid, text, text, text, text, text, text, timestamptz, timestamptz,
  jsonb, integer, text, text, text, text, boolean, jsonb, timestamptz
) from public, anon, authenticated;
revoke execute on function public.record_v3_analysis_response_retrieval(
  uuid, text, text, text, jsonb, text, text, text, text, boolean, jsonb, timestamptz
) from public, anon, authenticated;
revoke execute on function public.record_v3_analysis_processing_result(
  uuid, text, text, text, text, text, timestamptz
) from public, anon, authenticated;
revoke execute on function public.guard_analysis_response_artifact_update()
  from public, anon, authenticated;

grant execute on function public.persist_v3_content_selection(
  uuid, text, text, jsonb, integer, integer, integer, jsonb, timestamptz
) to service_role;
grant execute on function public.get_v3_content_selection(uuid) to service_role;
grant execute on function public.get_v3_analysis_response(uuid) to service_role;
grant execute on function public.capture_v3_analysis_response(
  uuid, uuid, text, text, text, text, text, text, timestamptz, timestamptz,
  jsonb, integer, text, text, text, text, boolean, jsonb, timestamptz
) to service_role;
grant execute on function public.record_v3_analysis_response_retrieval(
  uuid, text, text, text, jsonb, text, text, text, text, boolean, jsonb, timestamptz
) to service_role;
grant execute on function public.record_v3_analysis_processing_result(
  uuid, text, text, text, text, text, timestamptz
) to service_role;
