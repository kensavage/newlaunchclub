-- Launch Club V3 durable workflow foundation. This migration does not call research providers.

alter table public.reports alter column legacy_public_id drop not null;

create table if not exists public.research_workflows (
  id uuid primary key default gen_random_uuid(),
  report_request_id uuid not null references public.report_requests(id) on delete restrict,
  report_id uuid not null references public.reports(id) on delete restrict,
  workflow_type text not null default 'initial_report' check (workflow_type in ('initial_report', 'weekly_refresh')),
  workflow_version integer not null default 1 check (workflow_version > 0),
  status text not null default 'dispatch_pending' check (status in (
    'queued', 'dispatch_pending', 'running', 'waiting_retry', 'paused',
    'ready_for_provider_research', 'partially_complete', 'completed', 'failed', 'cancelled'
  )),
  current_phase text not null default 'initialize_workflow',
  priority integer not null default 0 check (priority between -50 and 50),
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  orchestrator_backend text not null default 'netlify' check (orchestrator_backend in ('netlify', 'deterministic')),
  external_event_id text,
  started_at timestamptz,
  completed_at timestamptz,
  paused_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint research_workflows_request_type_version_key unique (report_request_id, workflow_type, workflow_version),
  constraint research_workflows_report_type_version_key unique (report_id, workflow_type, workflow_version)
);

create unique index if not exists research_workflows_one_active_initial_idx
  on public.research_workflows (report_request_id)
  where workflow_type = 'initial_report' and status not in ('completed', 'failed', 'cancelled');

create table if not exists public.research_steps (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.research_workflows(id) on delete cascade,
  step_key text not null check (step_key in (
    'initialize_workflow', 'validate_intake_references', 'establish_cost_budget',
    'prepare_provider_research', 'mark_ready_for_provider_research'
  )),
  step_version integer not null default 1 check (step_version > 0),
  status text not null default 'pending' check (status in (
    'pending', 'leased', 'running', 'succeeded', 'retry_scheduled',
    'failed_terminal', 'skipped', 'cancelled'
  )),
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  output_reference text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  maximum_attempts integer not null default 4 check (maximum_attempts between 1 and 20),
  optional boolean not null default false,
  estimated_cost_cents integer not null default 0 check (estimated_cost_cents >= 0),
  actual_cost_cents integer not null default 0 check (actual_cost_cents >= 0),
  scheduled_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint research_steps_idempotency_key unique (workflow_id, step_key, step_version, input_hash)
);

create table if not exists public.research_attempts (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.research_workflows(id) on delete cascade,
  step_id uuid not null references public.research_steps(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  lease_owner text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text not null default 'running' check (outcome in ('running', 'succeeded', 'retry_scheduled', 'failed', 'cancelled')),
  retry_classification text check (retry_classification in ('transient', 'permanent', 'budget_blocked', 'cancelled', 'lease_conflict', 'configuration_error')),
  safe_error_code text,
  safe_error_summary text,
  provider_request_reference text,
  estimated_cost_cents integer not null default 0 check (estimated_cost_cents >= 0),
  actual_cost_cents integer not null default 0 check (actual_cost_cents >= 0),
  created_at timestamptz not null default now(),
  constraint research_attempts_step_attempt_key unique (step_id, attempt_number)
);

create table if not exists public.workflow_events (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.research_workflows(id) on delete cascade,
  event_type text not null,
  safe_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_metadata) = 'object'),
  correlation_id uuid not null,
  actor_type text not null check (actor_type in ('system', 'administrator', 'orchestrator')),
  created_at timestamptz not null default now()
);

create table if not exists public.workflow_leases (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.research_workflows(id) on delete cascade,
  step_id uuid references public.research_steps(id) on delete cascade,
  scope_key text not null,
  lease_owner text not null,
  fencing_token bigint not null check (fencing_token > 0),
  expires_at timestamptz not null,
  heartbeat_at timestamptz not null,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz not null default now()
);

create unique index if not exists workflow_leases_one_active_scope_idx
  on public.workflow_leases (workflow_id, scope_key) where released_at is null;

create table if not exists public.outbox_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  aggregate_type text not null check (aggregate_type = 'research_workflow'),
  aggregate_id uuid not null references public.research_workflows(id) on delete cascade,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) < 32768),
  idempotency_key text not null unique,
  status text not null default 'pending' check (status in ('pending', 'leased', 'sent', 'retry_scheduled')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default now(),
  leased_at timestamptz,
  lease_owner text,
  sent_at timestamptz,
  last_safe_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (payload ? 'workflowId' and payload ? 'reportRequestId' and payload ? 'reportId' and payload ? 'correlationId' and payload ? 'workflowVersion'),
  check (not (payload ?| array['email', 'accessToken', 'websiteContent', 'reportJson', 'providerResponse']))
);

create table if not exists public.workflow_errors (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.research_workflows(id) on delete cascade,
  step_id uuid references public.research_steps(id) on delete cascade,
  attempt_id uuid references public.research_attempts(id) on delete set null,
  classification text not null check (classification in ('transient', 'permanent', 'budget_blocked', 'cancelled', 'lease_conflict', 'configuration_error')),
  safe_code text not null,
  safe_summary text not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.report_cost_budgets (
  workflow_id uuid primary key references public.research_workflows(id) on delete cascade,
  budget_type text not null check (budget_type in ('initial_report', 'weekly_refresh')),
  limit_cents integer not null check (limit_cents >= 0),
  reserved_cents integer not null default 0 check (reserved_cents >= 0),
  spent_cents integer not null default 0 check (spent_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (reserved_cents + spent_cents <= limit_cents)
);

create table if not exists public.report_cost_entries (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.research_workflows(id) on delete cascade,
  step_id uuid references public.research_steps(id) on delete set null,
  attempt_id uuid references public.research_attempts(id) on delete set null,
  entry_type text not null check (entry_type in ('reservation', 'actual', 'release')),
  amount_cents integer not null check (amount_cents >= 0),
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.report_access_recovery_tokens (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists research_workflows_status_updated_idx on public.research_workflows (status, updated_at);
create index if not exists research_steps_workflow_status_idx on public.research_steps (workflow_id, status, scheduled_at);
create index if not exists workflow_events_workflow_created_idx on public.workflow_events (workflow_id, created_at);
create index if not exists workflow_leases_expiry_idx on public.workflow_leases (expires_at) where released_at is null;
create index if not exists outbox_events_claim_idx on public.outbox_events (status, available_at, created_at) where status <> 'sent';
create index if not exists workflow_errors_open_idx on public.workflow_errors (workflow_id, created_at) where resolved_at is null;
create index if not exists recovery_tokens_expiry_idx on public.report_access_recovery_tokens (expires_at);

alter table public.research_workflows enable row level security;
alter table public.research_steps enable row level security;
alter table public.research_attempts enable row level security;
alter table public.workflow_events enable row level security;
alter table public.workflow_leases enable row level security;
alter table public.outbox_events enable row level security;
alter table public.workflow_errors enable row level security;
alter table public.report_cost_budgets enable row level security;
alter table public.report_cost_entries enable row level security;
alter table public.report_access_recovery_tokens enable row level security;

revoke all privileges on table public.research_workflows, public.research_steps,
  public.research_attempts, public.workflow_events, public.workflow_leases,
  public.outbox_events, public.workflow_errors, public.report_cost_budgets,
  public.report_cost_entries, public.report_access_recovery_tokens from anon, authenticated;

create or replace function public.reject_workflow_event_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using message = 'workflow_events_are_append_only', errcode = 'P0001';
end;
$$;

drop trigger if exists workflow_events_append_only on public.workflow_events;
create trigger workflow_events_append_only before update or delete on public.workflow_events
for each row execute function public.reject_workflow_event_mutation();

create or replace function public.research_workflow_json(p_workflow public.research_workflows)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_workflow.id, 'reportRequestId', p_workflow.report_request_id,
    'reportId', p_workflow.report_id, 'workflowType', p_workflow.workflow_type,
    'workflowVersion', p_workflow.workflow_version, 'status', p_workflow.status,
    'currentPhase', p_workflow.current_phase, 'priority', p_workflow.priority,
    'inputHash', p_workflow.input_hash, 'orchestratorBackend', p_workflow.orchestrator_backend,
    'externalEventId', p_workflow.external_event_id, 'startedAt', p_workflow.started_at,
    'completedAt', p_workflow.completed_at, 'pausedAt', p_workflow.paused_at,
    'cancelledAt', p_workflow.cancelled_at, 'createdAt', p_workflow.created_at,
    'updatedAt', p_workflow.updated_at
  );
$$;

create or replace function public.research_step_json(p_step public.research_steps)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_step.id, 'workflowId', p_step.workflow_id, 'stepKey', p_step.step_key,
    'stepVersion', p_step.step_version, 'status', p_step.status, 'inputHash', p_step.input_hash,
    'outputReference', p_step.output_reference, 'attemptCount', p_step.attempt_count,
    'maximumAttempts', p_step.maximum_attempts, 'optional', p_step.optional,
    'estimatedCostCents', p_step.estimated_cost_cents, 'actualCostCents', p_step.actual_cost_cents,
    'scheduledAt', p_step.scheduled_at, 'startedAt', p_step.started_at,
    'completedAt', p_step.completed_at, 'createdAt', p_step.created_at, 'updatedAt', p_step.updated_at
  );
$$;

create or replace function public.workflow_lease_json(p_lease public.workflow_leases)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_lease.id, 'workflowId', p_lease.workflow_id, 'stepId', p_lease.step_id,
    'scopeKey', p_lease.scope_key, 'leaseOwner', p_lease.lease_owner,
    'fencingToken', p_lease.fencing_token, 'expiresAt', p_lease.expires_at,
    'heartbeatAt', p_lease.heartbeat_at, 'releasedAt', p_lease.released_at,
    'createdAt', p_lease.created_at
  );
$$;

create or replace function public.outbox_event_json(p_event public.outbox_events)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_event.id, 'eventType', p_event.event_type, 'aggregateType', p_event.aggregate_type,
    'aggregateId', p_event.aggregate_id, 'payload', p_event.payload,
    'idempotencyKey', p_event.idempotency_key, 'status', p_event.status,
    'attemptCount', p_event.attempt_count, 'availableAt', p_event.available_at,
    'leasedAt', p_event.leased_at, 'leaseOwner', p_event.lease_owner,
    'sentAt', p_event.sent_at, 'lastSafeError', p_event.last_safe_error,
    'createdAt', p_event.created_at, 'updatedAt', p_event.updated_at
  );
$$;

create or replace function public.cost_budget_json(p_budget public.report_cost_budgets)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'workflowId', p_budget.workflow_id, 'budgetType', p_budget.budget_type,
    'limitCents', p_budget.limit_cents, 'reservedCents', p_budget.reserved_cents,
    'spentCents', p_budget.spent_cents, 'createdAt', p_budget.created_at, 'updatedAt', p_budget.updated_at
  );
$$;

create or replace function public.cost_entry_json(p_entry public.report_cost_entries)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_entry.id, 'workflowId', p_entry.workflow_id, 'stepId', p_entry.step_id,
    'attemptId', p_entry.attempt_id, 'entryType', p_entry.entry_type,
    'amountCents', p_entry.amount_cents, 'idempotencyKey', p_entry.idempotency_key,
    'createdAt', p_entry.created_at
  );
$$;

create or replace function public.create_initial_research_workflow(
  p_report_request_id uuid,
  p_report_id uuid,
  p_input_hash text,
  p_correlation_id uuid,
  p_priority integer default 0,
  p_workflow_version integer default 1,
  p_orchestrator_backend text default 'netlify',
  p_maximum_attempts integer default 4,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_workflow public.research_workflows%rowtype;
  v_step_key text;
begin
  perform pg_advisory_xact_lock(hashtextextended('research-workflow:' || p_report_request_id::text, 0));
  select * into v_workflow from public.research_workflows
  where report_request_id = p_report_request_id and workflow_type = 'initial_report' and workflow_version = p_workflow_version;
  if v_workflow.id is not null then
    return public.research_workflow_json(v_workflow);
  end if;

  if not exists (select 1 from public.report_requests where id = p_report_request_id)
    or not exists (select 1 from public.reports where id = p_report_id and report_request_id = p_report_request_id) then
    raise exception using message = 'workflow_intake_reference_invalid', errcode = 'P0001';
  end if;

  insert into public.research_workflows (
    report_request_id, report_id, workflow_type, workflow_version, status, current_phase,
    priority, input_hash, orchestrator_backend, created_at, updated_at
  ) values (
    p_report_request_id, p_report_id, 'initial_report', p_workflow_version, 'dispatch_pending',
    'initialize_workflow', p_priority, p_input_hash, p_orchestrator_backend, p_now, p_now
  ) returning * into v_workflow;

  foreach v_step_key in array array[
    'initialize_workflow', 'validate_intake_references', 'establish_cost_budget',
    'prepare_provider_research', 'mark_ready_for_provider_research'
  ] loop
    insert into public.research_steps (
      workflow_id, step_key, step_version, status, input_hash, maximum_attempts,
      scheduled_at, created_at, updated_at
    ) values (
      v_workflow.id, v_step_key, 1, 'pending', md5(p_input_hash || ':' || v_step_key || ':1') || md5(v_step_key || p_input_hash),
      least(greatest(p_maximum_attempts, 1), 20), p_now, p_now, p_now
    );
  end loop;

  insert into public.report_cost_budgets (workflow_id, budget_type, limit_cents, created_at, updated_at)
  values (v_workflow.id, 'initial_report', 400, p_now, p_now);

  insert into public.workflow_events (workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at)
  values
    (v_workflow.id, 'workflow_created', '{}'::jsonb, p_correlation_id, 'system', p_now),
    (v_workflow.id, 'dispatch_requested', '{}'::jsonb, p_correlation_id, 'system', p_now);

  insert into public.outbox_events (
    event_type, aggregate_type, aggregate_id, payload, idempotency_key, status,
    available_at, created_at, updated_at
  ) values (
    'launchclub.report.requested.v1', 'research_workflow', v_workflow.id,
    jsonb_build_object(
      'workflowId', v_workflow.id, 'reportRequestId', p_report_request_id,
      'reportId', p_report_id, 'correlationId', p_correlation_id,
      'workflowVersion', p_workflow_version
    ),
    'launchclub.report.requested.v1:' || v_workflow.id::text || ':' || p_workflow_version::text,
    'pending', p_now, p_now, p_now
  );

  return public.research_workflow_json(v_workflow);
end;
$$;

create or replace function public.prepare_v3_report_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.legacy_public_id is not null then
    delete from public.report_jobs where public_id = new.legacy_public_id;
    new.legacy_public_id := null;
  end if;
  return new;
end;
$$;

create or replace function public.create_v3_workflow_after_report_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_request public.report_requests%rowtype;
begin
  select * into v_request from public.report_requests where id = new.report_request_id;
  perform public.create_initial_research_workflow(
    new.report_request_id, new.id, v_request.request_fingerprint, new.report_request_id,
    0, 1, 'netlify',
    coalesce(nullif(current_setting('app.settings.workflow_max_attempts', true), '')::integer, 4),
    new.created_at
  );
  return new;
end;
$$;

drop trigger if exists reports_prepare_v3_insert on public.reports;
create trigger reports_prepare_v3_insert before insert on public.reports
for each row execute function public.prepare_v3_report_insert();

drop trigger if exists reports_create_v3_workflow on public.reports;
create trigger reports_create_v3_workflow after insert on public.reports
for each row execute function public.create_v3_workflow_after_report_insert();

create or replace function public.get_research_workflow(p_workflow_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.research_workflow_json(rw) from public.research_workflows rw where rw.id = p_workflow_id;
$$;

create or replace function public.get_research_workflow_by_request(p_report_request_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.research_workflow_json(rw) from public.research_workflows rw
  where rw.report_request_id = p_report_request_id and rw.workflow_type = 'initial_report'
  order by rw.workflow_version desc limit 1;
$$;

create or replace function public.list_research_workflows(p_status text default null, p_limit integer default 50, p_stalled_before timestamptz default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.research_workflow_json(q) order by q.created_at desc), '[]'::jsonb)
  from (
    select * from public.research_workflows rw
    where (p_status is null or rw.status = p_status)
      and (p_stalled_before is null or rw.updated_at < p_stalled_before)
    order by rw.created_at desc limit least(greatest(p_limit, 1), 200)
  ) q;
$$;

create or replace function public.get_research_workflow_detail(p_workflow_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'workflow', public.research_workflow_json(rw),
    'steps', coalesce((select jsonb_agg(public.research_step_json(rs) order by rs.created_at) from public.research_steps rs where rs.workflow_id = rw.id), '[]'::jsonb),
    'attempts', coalesce((select jsonb_agg(jsonb_build_object(
      'id', ra.id, 'workflowId', ra.workflow_id, 'stepId', ra.step_id,
      'attemptNumber', ra.attempt_number, 'leaseOwner', ra.lease_owner,
      'startedAt', ra.started_at, 'finishedAt', ra.finished_at, 'outcome', ra.outcome,
      'retryClassification', ra.retry_classification, 'safeErrorCode', ra.safe_error_code,
      'safeErrorSummary', ra.safe_error_summary, 'providerRequestReference', ra.provider_request_reference,
      'estimatedCostCents', ra.estimated_cost_cents, 'actualCostCents', ra.actual_cost_cents,
      'createdAt', ra.created_at
    ) order by ra.created_at) from public.research_attempts ra where ra.workflow_id = rw.id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
      'id', we.id, 'workflowId', we.workflow_id, 'eventType', we.event_type,
      'safeMetadata', we.safe_metadata, 'correlationId', we.correlation_id,
      'actorType', we.actor_type, 'createdAt', we.created_at
    ) order by we.created_at) from public.workflow_events we where we.workflow_id = rw.id), '[]'::jsonb),
    'leases', coalesce((select jsonb_agg(public.workflow_lease_json(wl) order by wl.created_at) from public.workflow_leases wl where wl.workflow_id = rw.id), '[]'::jsonb),
    'errors', coalesce((select jsonb_agg(jsonb_build_object(
      'id', e.id, 'workflowId', e.workflow_id, 'stepId', e.step_id, 'attemptId', e.attempt_id,
      'classification', e.classification, 'safeCode', e.safe_code, 'safeSummary', e.safe_summary,
      'resolvedAt', e.resolved_at, 'createdAt', e.created_at
    ) order by e.created_at) from public.workflow_errors e where e.workflow_id = rw.id), '[]'::jsonb),
    'budget', (select public.cost_budget_json(b) from public.report_cost_budgets b where b.workflow_id = rw.id),
    'costEntries', coalesce((select jsonb_agg(public.cost_entry_json(ce) order by ce.created_at) from public.report_cost_entries ce where ce.workflow_id = rw.id), '[]'::jsonb)
  ) from public.research_workflows rw where rw.id = p_workflow_id;
$$;

create or replace function public.claim_workflow_outbox(p_owner text, p_limit integer, p_lease_seconds integer, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  with candidates as (
    select id from public.outbox_events
    where status <> 'sent' and available_at <= p_now
      and (status <> 'leased' or leased_at <= p_now - make_interval(secs => p_lease_seconds))
    order by created_at for update skip locked limit least(greatest(p_limit, 1), 100)
  ), claimed as (
    update public.outbox_events o set status = 'leased', attempt_count = attempt_count + 1,
      leased_at = p_now, lease_owner = p_owner, updated_at = p_now
    from candidates c where o.id = c.id returning o.*
  ) select coalesce(jsonb_agg(public.outbox_event_json(c) order by c.created_at), '[]'::jsonb) into v_result from claimed c;
  return v_result;
end;
$$;

create or replace function public.mark_workflow_outbox_sent(p_outbox_id uuid, p_owner text, p_external_event_id text, p_now timestamptz default now())
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_event public.outbox_events%rowtype;
begin
  select * into v_event from public.outbox_events where id = p_outbox_id for update;
  if v_event.status = 'sent' then return true; end if;
  if v_event.status <> 'leased' or v_event.lease_owner <> p_owner then return false; end if;
  update public.outbox_events set status = 'sent', sent_at = p_now, updated_at = p_now, last_safe_error = null where id = p_outbox_id;
  update public.research_workflows set external_event_id = p_external_event_id,
    status = case when status = 'dispatch_pending' then 'queued' else status end,
    updated_at = p_now where id = v_event.aggregate_id;
  insert into public.workflow_events (workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at)
  values (v_event.aggregate_id, 'dispatch_sent', '{}'::jsonb, (v_event.payload ->> 'correlationId')::uuid, 'orchestrator', p_now);
  return true;
end;
$$;

create or replace function public.mark_workflow_outbox_failed(p_outbox_id uuid, p_owner text, p_safe_error text, p_retry_at timestamptz, p_now timestamptz default now())
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.outbox_events set status = 'retry_scheduled', available_at = p_retry_at,
    lease_owner = null, leased_at = null, last_safe_error = left(p_safe_error, 200), updated_at = p_now
  where id = p_outbox_id and status = 'leased' and lease_owner = p_owner;
  return found;
end;
$$;

create or replace function public.begin_research_step(p_workflow_id uuid, p_step_key text, p_owner text, p_lease_seconds integer, p_now timestamptz default now())
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
    where prior.workflow_id = p_workflow_id
      and prior.status <> 'succeeded'
      and case prior.step_key
        when 'initialize_workflow' then 1 when 'validate_intake_references' then 2
        when 'establish_cost_budget' then 3 when 'prepare_provider_research' then 4 else 5 end
        < case p_step_key
          when 'initialize_workflow' then 1 when 'validate_intake_references' then 2
          when 'establish_cost_budget' then 3 when 'prepare_provider_research' then 4 else 5 end
  ) then
    return jsonb_build_object('disposition', 'unavailable', 'workflow', public.research_workflow_json(v_workflow), 'step', public.research_step_json(v_step), 'lease', null, 'attemptId', null);
  end if;
  if v_workflow.status in ('paused', 'cancelled', 'failed', 'completed') or v_step.scheduled_at > p_now or v_step.attempt_count >= v_step.maximum_attempts then
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

create or replace function public.heartbeat_research_lease(p_workflow_id uuid, p_step_key text, p_owner text, p_fencing_token bigint, p_lease_seconds integer, p_now timestamptz default now())
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.workflow_leases wl set heartbeat_at = p_now, expires_at = p_now + make_interval(secs => p_lease_seconds)
  from public.research_steps rs where wl.workflow_id = p_workflow_id and wl.step_id = rs.id and rs.step_key = p_step_key
    and wl.lease_owner = p_owner and wl.fencing_token = p_fencing_token and wl.released_at is null and wl.expires_at > p_now;
  return found;
end;
$$;

create or replace function public.complete_research_step(p_workflow_id uuid, p_step_key text, p_owner text, p_fencing_token bigint, p_output_reference text, p_now timestamptz default now())
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
  else
    update public.research_workflows set updated_at = p_now where id = p_workflow_id;
  end if;
  return true;
end;
$$;

create or replace function public.fail_research_step(p_workflow_id uuid, p_step_key text, p_owner text, p_fencing_token bigint, p_classification text, p_safe_code text, p_safe_summary text, p_retry_at timestamptz default null, p_now timestamptz default now())
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_step public.research_steps%rowtype; v_lease public.workflow_leases%rowtype; v_retry boolean;
begin
  if p_classification = 'lease_conflict' then return false; end if;
  select * into v_step from public.research_steps where workflow_id = p_workflow_id and step_key = p_step_key order by step_version desc limit 1 for update;
  select * into v_lease from public.workflow_leases where workflow_id = p_workflow_id and step_id = v_step.id and released_at is null for update;
  if v_lease.id is null or v_lease.lease_owner <> p_owner or v_lease.fencing_token <> p_fencing_token then return false; end if;
  v_retry := p_classification = 'transient' and v_step.attempt_count < v_step.maximum_attempts;
  update public.workflow_leases set released_at = p_now, release_reason = 'failed' where id = v_lease.id;
  update public.research_steps set status = case when v_retry then 'retry_scheduled' else 'failed_terminal' end,
    scheduled_at = coalesce(p_retry_at, p_now), updated_at = p_now where id = v_step.id;
  update public.research_attempts set outcome = case when v_retry then 'retry_scheduled' else 'failed' end,
    retry_classification = p_classification, safe_error_code = left(p_safe_code, 80),
    safe_error_summary = left(p_safe_summary, 240), finished_at = p_now
    where step_id = v_step.id and attempt_number = v_step.attempt_count;
  insert into public.workflow_errors (workflow_id, step_id, classification, safe_code, safe_summary, created_at)
  values (p_workflow_id, v_step.id, p_classification, left(p_safe_code, 80), left(p_safe_summary, 240), p_now);
  update public.research_workflows set status = case when v_retry then 'waiting_retry' when p_classification = 'budget_blocked' then 'paused' else 'failed' end, updated_at = p_now where id = p_workflow_id;
  insert into public.workflow_events (workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at)
  values (p_workflow_id, case when v_retry then 'step_retry_scheduled' else 'step_failed' end,
    jsonb_build_object('step', p_step_key, 'classification', p_classification), p_workflow_id, 'orchestrator', p_now);
  return true;
end;
$$;

create or replace function public.ensure_report_cost_budget(p_workflow_id uuid, p_budget_type text default 'initial_report')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_budget public.report_cost_budgets%rowtype;
begin
  insert into public.report_cost_budgets (workflow_id, budget_type, limit_cents)
  values (p_workflow_id, p_budget_type, case when p_budget_type = 'initial_report' then 400 else 100 end)
  on conflict (workflow_id) do nothing;
  select * into v_budget from public.report_cost_budgets where workflow_id = p_workflow_id;
  return public.cost_budget_json(v_budget);
end;
$$;

create or replace function public.reserve_report_cost(p_workflow_id uuid, p_step_id uuid, p_amount_cents integer, p_idempotency_key text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_budget public.report_cost_budgets%rowtype; v_entry public.report_cost_entries%rowtype;
begin
  if p_amount_cents < 0 then raise exception using message = 'invalid_cost', errcode = 'P0001'; end if;
  select * into v_entry from public.report_cost_entries where idempotency_key = p_idempotency_key;
  if v_entry.id is not null then return public.cost_entry_json(v_entry); end if;
  select * into v_budget from public.report_cost_budgets where workflow_id = p_workflow_id for update;
  if v_budget.workflow_id is null then perform public.ensure_report_cost_budget(p_workflow_id, 'initial_report'); select * into v_budget from public.report_cost_budgets where workflow_id = p_workflow_id for update; end if;
  if v_budget.reserved_cents + v_budget.spent_cents + p_amount_cents > v_budget.limit_cents then
    insert into public.workflow_events (workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at) values (p_workflow_id, 'cost_limit_reached', '{}'::jsonb, p_workflow_id, 'system', p_now);
    raise exception using message = 'workflow_budget_exceeded', errcode = 'P0001';
  end if;
  update public.report_cost_budgets set reserved_cents = reserved_cents + p_amount_cents, updated_at = p_now where workflow_id = p_workflow_id;
  insert into public.report_cost_entries (workflow_id, step_id, entry_type, amount_cents, idempotency_key, created_at)
  values (p_workflow_id, p_step_id, 'reservation', p_amount_cents, p_idempotency_key, p_now) returning * into v_entry;
  insert into public.workflow_events (workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at) values (p_workflow_id, 'cost_reserved', jsonb_build_object('amountCents', p_amount_cents), p_workflow_id, 'system', p_now);
  return public.cost_entry_json(v_entry);
end;
$$;

create or replace function public.record_report_cost(p_workflow_id uuid, p_step_id uuid, p_attempt_id uuid, p_reserved_cents integer, p_actual_cents integer, p_idempotency_key text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_budget public.report_cost_budgets%rowtype; v_entry public.report_cost_entries%rowtype;
begin
  select * into v_entry from public.report_cost_entries where idempotency_key = p_idempotency_key;
  if v_entry.id is not null then return public.cost_entry_json(v_entry); end if;
  if p_reserved_cents < 0 or p_actual_cents < 0 or p_actual_cents > p_reserved_cents then raise exception using message = 'invalid_cost', errcode = 'P0001'; end if;
  select * into v_budget from public.report_cost_budgets where workflow_id = p_workflow_id for update;
  if v_budget.reserved_cents < p_reserved_cents then raise exception using message = 'invalid_cost_reservation', errcode = 'P0001'; end if;
  update public.report_cost_budgets set reserved_cents = reserved_cents - p_reserved_cents, spent_cents = spent_cents + p_actual_cents, updated_at = p_now where workflow_id = p_workflow_id;
  insert into public.report_cost_entries (workflow_id, step_id, attempt_id, entry_type, amount_cents, idempotency_key, created_at)
  values (p_workflow_id, p_step_id, p_attempt_id, 'actual', p_actual_cents, p_idempotency_key, p_now) returning * into v_entry;
  if p_reserved_cents > p_actual_cents then
    insert into public.report_cost_entries (workflow_id, step_id, attempt_id, entry_type, amount_cents, idempotency_key, created_at)
    values (p_workflow_id, p_step_id, p_attempt_id, 'release', p_reserved_cents - p_actual_cents, p_idempotency_key || ':unused', p_now);
  end if;
  insert into public.workflow_events (workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at) values (p_workflow_id, 'cost_recorded', jsonb_build_object('actualCents', p_actual_cents), p_workflow_id, 'system', p_now);
  return public.cost_entry_json(v_entry);
end;
$$;

create or replace function public.release_report_cost(p_workflow_id uuid, p_step_id uuid, p_amount_cents integer, p_idempotency_key text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_entry public.report_cost_entries%rowtype;
begin
  select * into v_entry from public.report_cost_entries where idempotency_key = p_idempotency_key;
  if v_entry.id is not null then return public.cost_entry_json(v_entry); end if;
  update public.report_cost_budgets set reserved_cents = reserved_cents - p_amount_cents, updated_at = p_now
  where workflow_id = p_workflow_id and p_amount_cents >= 0 and reserved_cents >= p_amount_cents;
  if not found then raise exception using message = 'invalid_cost_release', errcode = 'P0001'; end if;
  insert into public.report_cost_entries (workflow_id, step_id, entry_type, amount_cents, idempotency_key, created_at)
  values (p_workflow_id, p_step_id, 'release', p_amount_cents, p_idempotency_key, p_now) returning * into v_entry;
  return public.cost_entry_json(v_entry);
end;
$$;

create or replace function public.get_public_workflow_progress(p_report_request_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with workflow as (
    select * from public.research_workflows where report_request_id = p_report_request_id and workflow_type = 'initial_report' order by workflow_version desc limit 1
  )
  select jsonb_build_object(
    'state', case
      when w.status = 'ready_for_provider_research' then 'research_ready'
      when w.status in ('waiting_retry', 'paused') then 'temporarily_delayed'
      when w.status = 'partially_complete' then 'partially_complete'
      when w.status = 'completed' then 'complete'
      when w.status in ('failed', 'cancelled') then 'failed'
      when w.status in ('queued', 'dispatch_pending') then 'queued'
      else 'preparing_research' end,
    'currentStep', case when w.status in ('failed', 'cancelled') then 'failed' else 'crawl' end,
    'steps', jsonb_build_array(
      jsonb_build_object('id', 'queued', 'label', 'Request received', 'status', 'complete', 'detail', null),
      jsonb_build_object(
        'id', case when w.status in ('failed', 'cancelled') then 'failed' else 'crawl' end,
        'label', 'Preparing research',
        'status', case when w.status in ('failed', 'cancelled') then 'failed' when w.status = 'completed' then 'complete' else 'running' end,
        'detail', case when w.status in ('waiting_retry', 'paused') then 'Preparation is temporarily delayed.' else null end
      )
    ),
    'errorSummary', case when w.status = 'failed' then 'The research workflow could not be prepared. Please try again.' else null end
  ) from workflow w;
$$;

create or replace function public.admin_transition_research_workflow(p_workflow_id uuid, p_command text, p_step_key text, p_actor_id text, p_now timestamptz default now())
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_workflow public.research_workflows%rowtype; v_step public.research_steps%rowtype; v_event text;
begin
  select * into v_workflow from public.research_workflows where id = p_workflow_id for update;
  if v_workflow.id is null then raise exception using message = 'workflow_not_found', errcode = 'P0001'; end if;
  if p_command = 'pause' then
    if v_workflow.status not in ('queued', 'dispatch_pending', 'running', 'waiting_retry', 'paused') then raise exception using message = 'invalid_workflow_transition', errcode = 'P0001'; end if;
    if v_workflow.status = 'paused' then return true; end if;
    update public.research_workflows set status = 'paused', paused_at = p_now, updated_at = p_now where id = p_workflow_id; v_event := 'workflow_paused';
  elsif p_command = 'resume' then
    if v_workflow.status <> 'paused' then raise exception using message = 'invalid_workflow_transition', errcode = 'P0001'; end if;
    update public.research_workflows set status = 'dispatch_pending', paused_at = null, updated_at = p_now where id = p_workflow_id; v_event := 'workflow_resumed';
    insert into public.outbox_events (event_type, aggregate_type, aggregate_id, payload, idempotency_key, available_at, created_at, updated_at)
    values ('launchclub.report.requested.v1', 'research_workflow', p_workflow_id,
      jsonb_build_object('workflowId', p_workflow_id, 'reportRequestId', v_workflow.report_request_id, 'reportId', v_workflow.report_id, 'correlationId', gen_random_uuid(), 'workflowVersion', v_workflow.workflow_version),
      'launchclub.report.requested.v1:' || p_workflow_id::text || ':resume:' || (select (count(*) + 1)::text from public.workflow_events where workflow_id = p_workflow_id and event_type = 'workflow_resumed'),
      p_now, p_now, p_now) on conflict (idempotency_key) do nothing;
  elsif p_command = 'cancel' then
    if v_workflow.status not in ('queued', 'dispatch_pending', 'running', 'waiting_retry', 'paused', 'cancelled') then raise exception using message = 'invalid_workflow_transition', errcode = 'P0001'; end if;
    if v_workflow.status = 'cancelled' then return true; end if;
    update public.research_workflows set status = 'cancelled', cancelled_at = p_now, updated_at = p_now where id = p_workflow_id;
    update public.research_steps set status = 'cancelled', updated_at = p_now where workflow_id = p_workflow_id and status <> 'succeeded'; v_event := 'workflow_cancelled';
  elsif p_command in ('retry', 'retry_step') then
    select * into v_step from public.research_steps where workflow_id = p_workflow_id
      and (p_command = 'retry' or step_key = p_step_key) and status in ('failed_terminal', 'retry_scheduled')
      order by created_at limit 1 for update;
    if v_step.id is null or v_step.attempt_count >= v_step.maximum_attempts or v_step.status = 'succeeded' then raise exception using message = 'invalid_workflow_retry', errcode = 'P0001'; end if;
    update public.research_steps set status = 'pending', scheduled_at = p_now, updated_at = p_now where id = v_step.id;
    update public.research_workflows set status = 'dispatch_pending', updated_at = p_now where id = p_workflow_id; v_event := 'administrator_retry_requested';
    insert into public.outbox_events (event_type, aggregate_type, aggregate_id, payload, idempotency_key, available_at, created_at, updated_at)
    values ('launchclub.report.requested.v1', 'research_workflow', p_workflow_id,
      jsonb_build_object('workflowId', p_workflow_id, 'reportRequestId', v_workflow.report_request_id, 'reportId', v_workflow.report_id, 'correlationId', gen_random_uuid(), 'workflowVersion', v_workflow.workflow_version),
      'launchclub.report.requested.v1:' || p_workflow_id::text || ':admin:' || v_step.id::text || ':' || v_step.attempt_count::text,
      p_now, p_now, p_now) on conflict (idempotency_key) do nothing;
  else raise exception using message = 'unknown_workflow_command', errcode = 'P0001';
  end if;
  insert into public.workflow_events (workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at)
  values (p_workflow_id, v_event, jsonb_build_object('actorId', left(p_actor_id, 120), 'step', v_step.step_key), p_workflow_id, 'administrator', p_now);
  insert into public.audit_logs (entity_type, entity_id, event_type, actor_type, created_at, metadata)
  values ('research_workflow', p_workflow_id, v_event, 'admin', p_now, jsonb_build_object('actorId', left(p_actor_id, 120)));
  return true;
end;
$$;

create or replace function public.admin_release_expired_research_lease(p_workflow_id uuid, p_step_key text, p_actor_id text, p_now timestamptz default now())
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_lease_id uuid;
begin
  select wl.id into v_lease_id from public.workflow_leases wl join public.research_steps rs on rs.id = wl.step_id
  where wl.workflow_id = p_workflow_id and rs.step_key = p_step_key and wl.released_at is null and wl.expires_at <= p_now for update;
  if v_lease_id is null then return false; end if;
  update public.workflow_leases set released_at = p_now, release_reason = 'administrator' where id = v_lease_id;
  update public.research_steps set status = 'retry_scheduled', scheduled_at = p_now, updated_at = p_now where workflow_id = p_workflow_id and step_key = p_step_key and status in ('leased', 'running');
  insert into public.workflow_events (workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at)
  values (p_workflow_id, 'administrator_lease_released', jsonb_build_object('actorId', left(p_actor_id, 120), 'step', p_step_key), p_workflow_id, 'administrator', p_now);
  insert into public.audit_logs (entity_type, entity_id, event_type, actor_type, created_at, metadata)
  values ('research_workflow', p_workflow_id, 'administrator_lease_released', 'admin', p_now, jsonb_build_object('actorId', left(p_actor_id, 120)));
  return true;
end;
$$;

create or replace function public.prepare_report_access_recovery(p_public_progress_id text, p_normalized_email text, p_recovery_token_hash text, p_expires_at timestamptz, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_report_id uuid;
begin
  select r.id into v_report_id from public.report_requests rr
  join public.company_contacts cc on cc.id = rr.contact_id
  join public.reports r on r.report_request_id = rr.id
  where rr.public_progress_id = p_public_progress_id and cc.normalized_email = lower(p_normalized_email);
  if v_report_id is null then return null; end if;
  update public.report_access_recovery_tokens set consumed_at = p_now where report_id = v_report_id and consumed_at is null;
  insert into public.report_access_recovery_tokens (report_id, token_hash, expires_at, created_at)
  values (v_report_id, p_recovery_token_hash, p_expires_at, p_now);
  return jsonb_build_object('reportId', v_report_id, 'normalizedEmail', lower(p_normalized_email));
end;
$$;

create or replace function public.consume_report_access_recovery(p_recovery_token_hash text, p_new_access_token_hash text, p_access_expires_at timestamptz, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_recovery public.report_access_recovery_tokens%rowtype; v_access_id uuid;
begin
  select * into v_recovery from public.report_access_recovery_tokens where token_hash = p_recovery_token_hash for update;
  if v_recovery.id is null or v_recovery.consumed_at is not null or v_recovery.expires_at <= p_now then return null; end if;
  update public.report_access_recovery_tokens set consumed_at = p_now where id = v_recovery.id;
  insert into public.report_access_events (report_id, access_token_id, event_type, created_at, request_metadata)
  select report_id, id, 'rotated', p_now, '{}'::jsonb from public.report_access_tokens where report_id = v_recovery.report_id and token_status = 'active';
  update public.report_access_tokens set token_status = 'rotated', revoked_at = p_now where report_id = v_recovery.report_id and token_status = 'active';
  insert into public.report_access_tokens (report_id, token_hash, token_status, created_at, expires_at)
  values (v_recovery.report_id, p_new_access_token_hash, 'active', p_now, p_access_expires_at) returning id into v_access_id;
  insert into public.report_access_events (report_id, access_token_id, event_type, created_at, request_metadata)
  values (v_recovery.report_id, v_access_id, 'issued', p_now, '{}'::jsonb);
  return jsonb_build_object('reportId', v_recovery.report_id);
end;
$$;

create or replace function public.cleanup_report_security_artifacts(p_revoked_token_before timestamptz, p_access_events_before timestamptz, p_recovery_token_before timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_tokens integer; v_events integer; v_recovery integer;
begin
  delete from public.report_access_tokens where token_status in ('revoked', 'rotated', 'expired') and revoked_at < p_revoked_token_before; get diagnostics v_tokens = row_count;
  delete from public.report_access_events where created_at < p_access_events_before; get diagnostics v_events = row_count;
  delete from public.report_access_recovery_tokens where created_at < p_recovery_token_before and (consumed_at is not null or expires_at < p_recovery_token_before); get diagnostics v_recovery = row_count;
  return jsonb_build_object('tokenHashesDeleted', v_tokens, 'accessEventsDeleted', v_events, 'recoveryTokensDeleted', v_recovery);
end;
$$;

create or replace function public.record_legacy_report_access(p_legacy_public_id_hash text, p_request_signal_hash text, p_user_agent_category text, p_now timestamptz default now())
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_logs (entity_type, entity_id, event_type, actor_type, created_at, metadata)
  values ('legacy_report_link', null, 'legacy_report_accessed', 'visitor', p_now,
    jsonb_build_object('legacyLinkHash', p_legacy_public_id_hash, 'requestSignalHash', p_request_signal_hash, 'userAgentCategory', p_user_agent_category));
  return true;
end;
$$;

create or replace function public.get_legacy_report_retirement_readiness(p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'remainingActiveLegacyLinks', (select count(*) from public.report_jobs rj left join public.reports r on r.legacy_public_id = rj.public_id where r.id is null and rj.expires_at > p_now),
    'legacyAccessesLast30Days', (select count(*) from public.audit_logs where event_type = 'legacy_report_accessed' and created_at >= p_now - interval '30 days'),
    'readyForRetirement', ((select count(*) from public.report_jobs rj left join public.reports r on r.legacy_public_id = rj.public_id where r.id is null and rj.expires_at > p_now) = 0 and (select count(*) from public.audit_logs where event_type = 'legacy_report_accessed' and created_at >= p_now - interval '30 days') = 0)
  );
$$;

revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.create_initial_research_workflow(uuid, uuid, text, uuid, integer, integer, text, integer, timestamptz) to service_role;
grant execute on function public.get_research_workflow(uuid) to service_role;
grant execute on function public.get_research_workflow_by_request(uuid) to service_role;
grant execute on function public.get_research_workflow_detail(uuid) to service_role;
grant execute on function public.list_research_workflows(text, integer, timestamptz) to service_role;
grant execute on function public.claim_workflow_outbox(text, integer, integer, timestamptz) to service_role;
grant execute on function public.mark_workflow_outbox_sent(uuid, text, text, timestamptz) to service_role;
grant execute on function public.mark_workflow_outbox_failed(uuid, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.begin_research_step(uuid, text, text, integer, timestamptz) to service_role;
grant execute on function public.heartbeat_research_lease(uuid, text, text, bigint, integer, timestamptz) to service_role;
grant execute on function public.complete_research_step(uuid, text, text, bigint, text, timestamptz) to service_role;
grant execute on function public.fail_research_step(uuid, text, text, bigint, text, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.ensure_report_cost_budget(uuid, text) to service_role;
grant execute on function public.reserve_report_cost(uuid, uuid, integer, text, timestamptz) to service_role;
grant execute on function public.record_report_cost(uuid, uuid, uuid, integer, integer, text, timestamptz) to service_role;
grant execute on function public.release_report_cost(uuid, uuid, integer, text, timestamptz) to service_role;
grant execute on function public.get_public_workflow_progress(uuid) to service_role;
grant execute on function public.admin_transition_research_workflow(uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.admin_release_expired_research_lease(uuid, text, text, timestamptz) to service_role;
grant execute on function public.prepare_report_access_recovery(text, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.consume_report_access_recovery(text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.cleanup_report_security_artifacts(timestamptz, timestamptz, timestamptz) to service_role;
grant execute on function public.record_legacy_report_access(text, text, text, timestamptz) to service_role;
grant execute on function public.get_legacy_report_retirement_readiness(timestamptz) to service_role;

-- PR2 RPCs remain callable by service_role after the schema-wide revoke above.
grant execute on function public.create_report_intake(
  text, text, text, text, text, text, text, text, text, text, text, timestamptz,
  timestamptz, text, jsonb, timestamptz, timestamptz, timestamptz, integer, integer,
  timestamptz, integer, jsonb
) to service_role;
grant execute on function public.resolve_report_access(text, jsonb, timestamptz) to service_role;
grant execute on function public.rotate_report_access(uuid, text, timestamptz, jsonb) to service_role;
grant execute on function public.revoke_report_access(uuid, text) to service_role;
grant execute on function public.is_protected_report_legacy_id(text) to service_role;
