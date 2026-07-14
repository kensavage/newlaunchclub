-- PR4 provider readiness, explicit outcomes, and atomic failure settlement.
-- Migration 0005 remains immutable; this migration extends its durable contracts.

alter table public.provider_operations
  add column if not exists reserved_cost_cents integer not null default 0
    check (reserved_cost_cents >= 0),
  add column if not exists outcome_class text
    check (outcome_class in (
      'succeeded', 'definitively_rejected', 'transient_retryable',
      'outcome_uncertain', 'cancelled'
    )),
  add column if not exists reconciliation_required boolean not null default false,
  add column if not exists reservation_generation integer not null default 1
    check (reservation_generation > 0),
  add column if not exists settled_at timestamptz;

update public.provider_operations
set outcome_class = case operation_state
    when 'succeeded' then 'succeeded'
    when 'failed' then 'definitively_rejected'
    when 'outcome_unknown' then 'outcome_uncertain'
    when 'cancelled' then 'cancelled'
    when 'retry_scheduled' then 'transient_retryable'
    else outcome_class
  end,
  reconciliation_required = operation_state = 'outcome_unknown',
  settled_at = case
    when operation_state in ('succeeded', 'failed', 'cancelled') then coalesce(settled_at, updated_at)
    else settled_at
  end;

create table if not exists public.provider_operation_reconciliations (
  id uuid primary key default gen_random_uuid(),
  provider_operation_id uuid not null unique
    references public.provider_operations(id) on delete cascade,
  resolution text not null check (resolution in (
    'definitively_rejected', 'accepted_retryable', 'paid_cancelled'
  )),
  actual_cost_cents integer check (actual_cost_cents >= 0),
  actor_id text not null check (char_length(actor_id) between 1 and 120),
  created_at timestamptz not null default now()
);

alter table public.provider_operation_reconciliations enable row level security;
revoke all on table public.provider_operation_reconciliations from anon, authenticated;

drop trigger if exists provider_operation_reconciliations_immutable
  on public.provider_operation_reconciliations;
create trigger provider_operation_reconciliations_immutable
before update or delete on public.provider_operation_reconciliations
for each row execute function public.reject_immutable_research_update();

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
    'createdAt', p_operation.created_at, 'updatedAt', p_operation.updated_at
  );
$$;

create or replace function public.reserve_v3_provider_operation_cost(
  p_operation_id uuid,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.provider_operations%rowtype;
  v_step public.research_steps%rowtype;
  v_budget public.report_cost_budgets%rowtype;
  v_key text;
begin
  perform pg_advisory_xact_lock(hashtextextended('provider-operation:' || p_operation_id::text, 0));
  select * into v_operation from public.provider_operations where id = p_operation_id for update;
  if v_operation.id is null then
    raise exception using message = 'provider_operation_not_found', errcode = 'P0001';
  end if;
  select * into v_step from public.research_steps where id = v_operation.step_id for update;

  if v_operation.reconciliation_required or v_operation.operation_state = 'outcome_unknown' then
    raise exception using message = 'provider_reconciliation_required', errcode = 'P0001';
  end if;
  if v_operation.operation_state = 'succeeded' then
    return public.provider_operation_json(v_operation);
  end if;
  if ((v_operation.operation_state = 'failed'
      and v_operation.outcome_class = 'definitively_rejected')
    or (v_operation.operation_state = 'cancelled'
      and v_operation.outcome_class = 'cancelled'))
    and v_step.status = 'running' then
    update public.provider_operations
    set operation_state = 'reserved', provider_job_id = null,
      actual_cost_cents = null, outcome_class = null,
      reconciliation_required = false, reservation_generation = reservation_generation + 1,
      next_retry_at = null, last_http_status = null,
      last_safe_error_code = null, last_safe_error_summary = null,
      provider_usage = '{}'::jsonb,
      provider_started_at = null, provider_completed_at = null,
      settled_at = null, updated_at = p_now
    where id = p_operation_id returning * into v_operation;
  elsif v_operation.operation_state in ('failed', 'cancelled') then
    raise exception using message = 'provider_operation_terminal', errcode = 'P0001';
  end if;

  if v_operation.reserved_cost_cents > 0 or v_operation.estimated_cost_cents = 0 then
    return public.provider_operation_json(v_operation);
  end if;

  select * into v_budget from public.report_cost_budgets
  where workflow_id = v_operation.workflow_id for update;
  if v_budget.workflow_id is null then
    raise exception using message = 'provider_budget_missing', errcode = 'P0001';
  end if;
  if v_budget.reserved_cents + v_budget.spent_cents + v_operation.estimated_cost_cents
    > v_budget.limit_cents then
    raise exception using message = 'workflow_budget_exceeded', errcode = 'P0001';
  end if;

  v_key := v_operation.idempotency_key || ':reservation:' || v_operation.reservation_generation::text;
  if not exists (select 1 from public.report_cost_entries where idempotency_key = v_key) then
    update public.report_cost_budgets
    set reserved_cents = reserved_cents + v_operation.estimated_cost_cents,
      updated_at = p_now
    where workflow_id = v_operation.workflow_id;
    insert into public.report_cost_entries (
      workflow_id, step_id, entry_type, amount_cents, idempotency_key, created_at
    ) values (
      v_operation.workflow_id, v_operation.step_id, 'reservation',
      v_operation.estimated_cost_cents, v_key, p_now
    );
    insert into public.workflow_events (
      workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at
    ) values (
      v_operation.workflow_id, 'provider_cost_reserved',
      jsonb_build_object('operationKind', v_operation.operation_kind,
        'amountCents', v_operation.estimated_cost_cents),
      v_operation.workflow_id, 'system', p_now
    );
  end if;

  update public.provider_operations
  set reserved_cost_cents = estimated_cost_cents, updated_at = p_now
  where id = p_operation_id returning * into v_operation;
  return public.provider_operation_json(v_operation);
end;
$$;

create or replace function public.settle_v3_provider_operation(
  p_operation_id uuid,
  p_provider_attempt_id uuid,
  p_workflow_attempt_id uuid,
  p_owner text,
  p_fencing_token bigint,
  p_outcome text,
  p_classification text,
  p_http_status integer,
  p_safe_code text,
  p_safe_summary text,
  p_retry_at timestamptz,
  p_output_reference text,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.provider_operations%rowtype;
  v_step public.research_steps%rowtype;
  v_workflow public.research_workflows%rowtype;
  v_lease public.workflow_leases%rowtype;
  v_budget public.report_cost_budgets%rowtype;
  v_provider_attempt public.provider_operation_attempts%rowtype;
  v_attempt_state text;
  v_workflow_status text;
  v_cost_key text;
  v_release integer;
begin
  if p_outcome not in (
    'succeeded', 'definitively_rejected', 'transient_retryable',
    'outcome_uncertain', 'cancelled'
  ) then
    raise exception using message = 'provider_outcome_invalid', errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('provider-operation:' || p_operation_id::text, 0));
  select * into v_operation from public.provider_operations where id = p_operation_id for update;
  if v_operation.id is null then
    raise exception using message = 'provider_operation_not_found', errcode = 'P0001';
  end if;
  select * into v_step from public.research_steps where id = v_operation.step_id for update;
  select * into v_workflow from public.research_workflows
  where id = v_operation.workflow_id for update;

  if p_outcome = 'succeeded'
    and v_operation.outcome_class = 'succeeded'
    and v_operation.reserved_cost_cents = 0
    and v_step.status = 'succeeded' then
    return public.provider_operation_json(v_operation);
  end if;

  v_attempt_state := case p_outcome
    when 'transient_retryable' then 'retry_scheduled'
    when 'outcome_uncertain' then 'outcome_unknown'
    when 'cancelled' then 'cancelled'
    when 'definitively_rejected' then 'failed'
    else 'succeeded'
  end;
  if p_outcome <> 'succeeded' then
    if p_provider_attempt_id is null then
      raise exception using message = 'provider_attempt_required', errcode = 'P0001';
    end if;
    select * into v_provider_attempt from public.provider_operation_attempts
    where id = p_provider_attempt_id and provider_operation_id = p_operation_id for update;
    if v_provider_attempt.id is null then
      raise exception using message = 'provider_attempt_fenced', errcode = 'P0001';
    end if;
    if v_provider_attempt.attempt_state = v_attempt_state
      and v_operation.outcome_class = p_outcome
      and v_step.status in ('retry_scheduled', 'failed_terminal', 'cancelled') then
      return public.provider_operation_json(v_operation);
    end if;
    if v_provider_attempt.attempt_state <> 'started' then
      raise exception using message = 'provider_attempt_fenced', errcode = 'P0001';
    end if;
  end if;

  select * into v_lease from public.workflow_leases
  where workflow_id = v_operation.workflow_id and step_id = v_step.id
    and released_at is null for update;
  if v_lease.id is null or v_lease.lease_owner <> p_owner
    or v_lease.fencing_token <> p_fencing_token or v_lease.expires_at <= p_now then
    raise exception using message = 'provider_settlement_lease_conflict', errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.research_attempts
    where id = p_workflow_attempt_id and workflow_id = v_operation.workflow_id
      and step_id = v_step.id and outcome = 'running'
  ) then
    raise exception using message = 'provider_workflow_attempt_fenced', errcode = 'P0001';
  end if;

  if p_outcome = 'succeeded' then
    if v_operation.operation_state <> 'succeeded' or v_operation.actual_cost_cents is null then
      raise exception using message = 'provider_success_not_persisted', errcode = 'P0001';
    end if;
    if v_operation.actual_cost_cents > v_operation.reserved_cost_cents
      and not (v_operation.actual_cost_cents = 0 and v_operation.reserved_cost_cents = 0) then
      raise exception using message = 'provider_cost_exceeded_reservation', errcode = 'P0001';
    end if;
    if v_operation.reserved_cost_cents > 0 then
      select * into v_budget from public.report_cost_budgets
      where workflow_id = v_operation.workflow_id for update;
      if v_budget.reserved_cents < v_operation.reserved_cost_cents then
        raise exception using message = 'invalid_cost_reservation', errcode = 'P0001';
      end if;
      update public.report_cost_budgets
      set reserved_cents = reserved_cents - v_operation.reserved_cost_cents,
        spent_cents = spent_cents + v_operation.actual_cost_cents,
        updated_at = p_now
      where workflow_id = v_operation.workflow_id;
      v_cost_key := v_operation.idempotency_key || ':settlement:' ||
        v_operation.reservation_generation::text || ':actual';
      insert into public.report_cost_entries (
        workflow_id, step_id, attempt_id, entry_type, amount_cents,
        idempotency_key, created_at
      ) values (
        v_operation.workflow_id, v_step.id, p_workflow_attempt_id, 'actual',
        v_operation.actual_cost_cents, v_cost_key, p_now
      ) on conflict (idempotency_key) do nothing;
      v_release := v_operation.reserved_cost_cents - v_operation.actual_cost_cents;
      if v_release > 0 then
        insert into public.report_cost_entries (
          workflow_id, step_id, attempt_id, entry_type, amount_cents,
          idempotency_key, created_at
        ) values (
          v_operation.workflow_id, v_step.id, p_workflow_attempt_id, 'release',
          v_release, v_operation.idempotency_key || ':settlement:' ||
            v_operation.reservation_generation::text || ':unused', p_now
        ) on conflict (idempotency_key) do nothing;
      end if;
    end if;

    update public.provider_operations
    set reserved_cost_cents = 0, outcome_class = 'succeeded',
      reconciliation_required = false, next_retry_at = null,
      last_safe_error_code = null, last_safe_error_summary = null,
      settled_at = coalesce(settled_at, p_now), updated_at = p_now
    where id = p_operation_id returning * into v_operation;
    update public.workflow_errors
    set resolved_at = p_now
    where workflow_id = v_operation.workflow_id and step_id = v_step.id
      and classification = 'transient' and resolved_at is null;
    update public.research_steps
    set status = 'succeeded', output_reference = left(coalesce(
        p_output_reference, 'provider-operation:' || v_operation.id::text
      ), 250), actual_cost_cents = v_operation.actual_cost_cents,
      completed_at = p_now, updated_at = p_now
    where id = v_step.id;
    update public.research_attempts
    set outcome = 'succeeded', actual_cost_cents = v_operation.actual_cost_cents,
      finished_at = p_now
    where id = p_workflow_attempt_id;
    update public.workflow_leases
    set released_at = p_now, release_reason = 'completed'
    where id = v_lease.id;
    if v_operation.operation_kind = 'search_query_discovery' then
      update public.research_workflows
      set status = 'ready_for_search_intelligence', current_phase = 'search_intelligence',
        updated_at = p_now
      where id = v_operation.workflow_id;
      insert into public.workflow_events (
        workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at
      ) values (
        v_operation.workflow_id, 'workflow_ready_for_search_intelligence',
        '{}'::jsonb, v_operation.workflow_id, 'orchestrator', p_now
      );
    else
      update public.research_workflows set updated_at = p_now
      where id = v_operation.workflow_id;
    end if;
    insert into public.workflow_events (
      workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at
    ) values (
      v_operation.workflow_id, 'provider_operation_succeeded',
      jsonb_build_object('step', v_operation.operation_kind,
        'actualCostCents', v_operation.actual_cost_cents),
      v_operation.workflow_id, 'orchestrator', p_now
    );
    return public.provider_operation_json(v_operation);
  end if;

  update public.provider_operation_attempts
  set attempt_state = v_attempt_state, http_status = p_http_status,
    retry_at = case when p_outcome = 'transient_retryable' then p_retry_at else null end,
    safe_error_code = left(coalesce(p_safe_code, 'provider_operation_failed'), 80),
    safe_error_summary = left(coalesce(p_safe_summary, 'Provider research could not continue.'), 240),
    completed_at = p_now
  where id = p_provider_attempt_id;

  if p_outcome in ('definitively_rejected', 'cancelled')
    and v_operation.reserved_cost_cents > 0 then
    select * into v_budget from public.report_cost_budgets
    where workflow_id = v_operation.workflow_id for update;
    if v_budget.reserved_cents < v_operation.reserved_cost_cents then
      raise exception using message = 'invalid_cost_reservation', errcode = 'P0001';
    end if;
    update public.report_cost_budgets
    set reserved_cents = reserved_cents - v_operation.reserved_cost_cents,
      updated_at = p_now
    where workflow_id = v_operation.workflow_id;
    insert into public.report_cost_entries (
      workflow_id, step_id, attempt_id, entry_type, amount_cents,
      idempotency_key, created_at
    ) values (
      v_operation.workflow_id, v_step.id, p_workflow_attempt_id, 'release',
      v_operation.reserved_cost_cents,
      v_operation.idempotency_key || ':settlement:' ||
        v_operation.reservation_generation::text || ':release', p_now
    ) on conflict (idempotency_key) do nothing;
    v_operation.reserved_cost_cents := 0;
  end if;

  update public.provider_operations
  set operation_state = case p_outcome
      when 'transient_retryable' then case when provider_job_id is null
        then 'retry_scheduled' else 'submitted' end
      when 'outcome_uncertain' then 'outcome_unknown'
      when 'cancelled' then 'cancelled'
      else 'failed' end,
    reserved_cost_cents = v_operation.reserved_cost_cents,
    outcome_class = p_outcome,
    reconciliation_required = p_outcome = 'outcome_uncertain',
    next_retry_at = case when p_outcome = 'transient_retryable' then p_retry_at else null end,
    last_http_status = p_http_status,
    last_safe_error_code = left(coalesce(p_safe_code, 'provider_operation_failed'), 80),
    last_safe_error_summary = left(coalesce(p_safe_summary, 'Provider research could not continue.'), 240),
    settled_at = case when p_outcome in ('definitively_rejected', 'cancelled')
      then coalesce(settled_at, p_now) else null end,
    updated_at = p_now
  where id = p_operation_id returning * into v_operation;

  v_workflow_status := case
    when p_outcome = 'transient_retryable' then 'waiting_retry'
    when p_outcome = 'cancelled' then 'cancelled'
    when p_outcome = 'outcome_uncertain' then 'paused'
    when p_classification in ('configuration_error', 'budget_blocked') then 'paused'
    else 'failed' end;
  update public.research_steps
  set status = case
      when p_outcome = 'transient_retryable' then 'retry_scheduled'
      when p_outcome = 'cancelled' then 'cancelled'
      else 'failed_terminal' end,
    scheduled_at = coalesce(p_retry_at, p_now), updated_at = p_now
  where id = v_step.id;
  update public.research_attempts
  set outcome = case
      when p_outcome = 'transient_retryable' then 'retry_scheduled'
      when p_outcome = 'cancelled' then 'cancelled'
      else 'failed' end,
    retry_classification = case when p_outcome = 'outcome_uncertain'
      then 'configuration_error' else p_classification end,
    safe_error_code = left(case when p_outcome = 'outcome_uncertain'
      then 'provider_outcome_unknown' else coalesce(p_safe_code, 'provider_operation_failed') end, 80),
    safe_error_summary = left(case when p_outcome = 'outcome_uncertain'
      then 'A provider outcome requires administrator reconciliation.'
      else coalesce(p_safe_summary, 'Provider research could not continue.') end, 240),
    finished_at = p_now
  where id = p_workflow_attempt_id;
  update public.workflow_leases
  set released_at = p_now, release_reason = case
    when p_outcome = 'transient_retryable' then 'retry_scheduled'
    when p_outcome = 'outcome_uncertain' then 'reconciliation_required'
    else 'failed' end
  where id = v_lease.id;
  update public.research_workflows
  set status = v_workflow_status,
    current_phase = case when p_outcome = 'outcome_uncertain'
      then 'provider_reconciliation' else current_phase end,
    paused_at = case when v_workflow_status = 'paused' then p_now else paused_at end,
    cancelled_at = case when v_workflow_status = 'cancelled' then p_now else cancelled_at end,
    updated_at = p_now
  where id = v_operation.workflow_id;
  insert into public.workflow_errors (
    workflow_id, step_id, attempt_id, classification,
    safe_code, safe_summary, created_at
  ) values (
    v_operation.workflow_id, v_step.id, p_workflow_attempt_id,
    case when p_outcome = 'outcome_uncertain' then 'configuration_error'
      else coalesce(p_classification, 'permanent') end,
    left(case when p_outcome = 'outcome_uncertain' then 'provider_outcome_unknown'
      else coalesce(p_safe_code, 'provider_operation_failed') end, 80),
    left(case when p_outcome = 'outcome_uncertain'
      then 'A provider outcome requires administrator reconciliation.'
      else coalesce(p_safe_summary, 'Provider research could not continue.') end, 240),
    p_now
  );
  insert into public.workflow_events (
    workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at
  ) values (
    v_operation.workflow_id,
    case p_outcome
      when 'transient_retryable' then 'provider_retry_scheduled'
      when 'outcome_uncertain' then 'provider_reconciliation_required'
      when 'cancelled' then 'provider_operation_cancelled'
      else 'provider_operation_rejected' end,
    jsonb_build_object('step', v_operation.operation_kind, 'outcome', p_outcome),
    v_operation.workflow_id, 'orchestrator', p_now
  );

  if v_workflow_status in ('failed', 'cancelled') and exists (
    select 1 from public.provider_operations
    where workflow_id = v_operation.workflow_id and operation_state = 'retry_scheduled'
  ) then
    raise exception using message = 'terminal_workflow_has_retryable_provider_operation', errcode = 'P0001';
  end if;
  return public.provider_operation_json(v_operation);
end;
$$;

create or replace function public.block_v3_provider_configuration(
  p_workflow_id uuid,
  p_step_key text,
  p_workflow_attempt_id uuid,
  p_owner text,
  p_fencing_token bigint,
  p_safe_code text,
  p_safe_summary text,
  p_now timestamptz default now()
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_step public.research_steps%rowtype;
  v_lease public.workflow_leases%rowtype;
begin
  select * into v_step from public.research_steps
  where workflow_id = p_workflow_id and step_key = p_step_key
  order by step_version desc limit 1 for update;
  if v_step.id is null then
    raise exception using message = 'workflow_step_not_found', errcode = 'P0001';
  end if;
  if v_step.status = 'failed_terminal'
    and (select status from public.research_workflows where id = p_workflow_id) = 'paused' then
    return true;
  end if;
  if exists (
    select 1 from public.provider_operations
    where workflow_id = p_workflow_id and step_id = v_step.id
      and reserved_cost_cents > 0
  ) then
    raise exception using message = 'provider_configuration_block_requires_settlement', errcode = 'P0001';
  end if;
  select * into v_lease from public.workflow_leases
  where workflow_id = p_workflow_id and step_id = v_step.id and released_at is null
  for update;
  if v_lease.id is null or v_lease.lease_owner <> p_owner
    or v_lease.fencing_token <> p_fencing_token or v_lease.expires_at <= p_now then
    return false;
  end if;
  update public.provider_operations
  set operation_state = 'failed', outcome_class = 'definitively_rejected',
    reconciliation_required = false, next_retry_at = null,
    last_safe_error_code = left(p_safe_code, 80),
    last_safe_error_summary = left(p_safe_summary, 240),
    settled_at = coalesce(settled_at, p_now), updated_at = p_now
  where workflow_id = p_workflow_id and step_id = v_step.id
    and operation_state not in ('succeeded', 'cancelled');
  update public.research_steps
  set status = 'failed_terminal', scheduled_at = p_now, updated_at = p_now
  where id = v_step.id;
  update public.research_attempts
  set outcome = 'failed', retry_classification = 'configuration_error',
    safe_error_code = left(p_safe_code, 80),
    safe_error_summary = left(p_safe_summary, 240), finished_at = p_now
  where id = p_workflow_attempt_id and workflow_id = p_workflow_id
    and step_id = v_step.id and outcome = 'running';
  update public.workflow_leases
  set released_at = p_now, release_reason = 'configuration_blocked'
  where id = v_lease.id;
  update public.research_workflows
  set status = 'paused', current_phase = 'provider_configuration',
    paused_at = p_now, updated_at = p_now
  where id = p_workflow_id;
  insert into public.workflow_errors (
    workflow_id, step_id, attempt_id, classification, safe_code, safe_summary, created_at
  ) values (
    p_workflow_id, v_step.id, p_workflow_attempt_id, 'configuration_error',
    left(p_safe_code, 80), left(p_safe_summary, 240), p_now
  );
  insert into public.workflow_events (
    workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at
  ) values (
    p_workflow_id, 'provider_configuration_blocked',
    jsonb_build_object('step', p_step_key), p_workflow_id, 'orchestrator', p_now
  );
  return true;
end;
$$;

create or replace function public.fail_research_step(
  p_workflow_id uuid,
  p_step_key text,
  p_owner text,
  p_fencing_token bigint,
  p_classification text,
  p_safe_code text,
  p_safe_summary text,
  p_retry_at timestamptz default null,
  p_now timestamptz default now()
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_step public.research_steps%rowtype;
  v_lease public.workflow_leases%rowtype;
  v_retry boolean;
  v_cancelled boolean;
  v_status text;
begin
  if p_classification = 'lease_conflict' then return false; end if;
  select * into v_step from public.research_steps
  where workflow_id = p_workflow_id and step_key = p_step_key
  order by step_version desc limit 1 for update;
  select * into v_lease from public.workflow_leases
  where workflow_id = p_workflow_id and step_id = v_step.id and released_at is null
  for update;
  if v_lease.id is null or v_lease.lease_owner <> p_owner
    or v_lease.fencing_token <> p_fencing_token then return false; end if;
  v_retry := p_classification = 'transient' and v_step.attempt_count < v_step.maximum_attempts;
  v_cancelled := p_classification = 'cancelled';
  v_status := case
    when v_cancelled then 'cancelled'
    when v_retry then 'waiting_retry'
    when p_classification in ('budget_blocked', 'configuration_error') then 'paused'
    else 'failed' end;
  update public.workflow_leases
  set released_at = p_now, release_reason = case
    when v_retry then 'retry_scheduled'
    when v_cancelled then 'cancelled'
    else 'failed' end
  where id = v_lease.id;
  update public.research_steps
  set status = case when v_cancelled then 'cancelled'
      when v_retry then 'retry_scheduled' else 'failed_terminal' end,
    scheduled_at = coalesce(p_retry_at, p_now), updated_at = p_now
  where id = v_step.id;
  update public.research_attempts
  set outcome = case when v_cancelled then 'cancelled'
      when v_retry then 'retry_scheduled' else 'failed' end,
    retry_classification = p_classification,
    safe_error_code = left(p_safe_code, 80),
    safe_error_summary = left(p_safe_summary, 240), finished_at = p_now
  where step_id = v_step.id and attempt_number = v_step.attempt_count;
  insert into public.workflow_errors (
    workflow_id, step_id, classification, safe_code, safe_summary, created_at
  ) values (
    p_workflow_id, v_step.id, p_classification,
    left(p_safe_code, 80), left(p_safe_summary, 240), p_now
  );
  update public.research_workflows
  set status = v_status,
    paused_at = case when v_status = 'paused' then p_now else paused_at end,
    cancelled_at = case when v_status = 'cancelled' then p_now else cancelled_at end,
    updated_at = p_now
  where id = p_workflow_id;
  insert into public.workflow_events (
    workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at
  ) values (
    p_workflow_id, case when v_retry then 'step_retry_scheduled'
      when v_status = 'paused' then 'step_configuration_blocked' else 'step_failed' end,
    jsonb_build_object('step', p_step_key, 'classification', p_classification),
    p_workflow_id, 'orchestrator', p_now
  );
  return true;
end;
$$;

create or replace function public.admin_reconcile_v3_provider_operation(
  p_operation_id uuid,
  p_resolution text,
  p_actual_cost_cents integer,
  p_actor_id text,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.provider_operations%rowtype;
  v_existing public.provider_operation_reconciliations%rowtype;
  v_workflow public.research_workflows%rowtype;
  v_budget public.report_cost_budgets%rowtype;
  v_release integer;
  v_payload jsonb;
begin
  if p_resolution not in ('definitively_rejected', 'accepted_retryable', 'paid_cancelled')
    or p_actor_id is null or char_length(p_actor_id) not between 1 and 120 then
    raise exception using message = 'provider_reconciliation_invalid', errcode = 'P0001';
  end if;
  if (p_resolution = 'paid_cancelled') <> (p_actual_cost_cents is not null) then
    raise exception using message = 'provider_reconciled_cost_invalid', errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('provider-operation:' || p_operation_id::text, 0));
  select * into v_operation from public.provider_operations where id = p_operation_id for update;
  if v_operation.id is null then
    raise exception using message = 'provider_operation_not_found', errcode = 'P0001';
  end if;
  select * into v_existing from public.provider_operation_reconciliations
  where provider_operation_id = p_operation_id;
  if v_existing.id is not null then
    if v_existing.resolution <> p_resolution
      or v_existing.actual_cost_cents is distinct from p_actual_cost_cents then
      raise exception using message = 'provider_reconciliation_conflict', errcode = 'P0001';
    end if;
    return public.provider_operation_json(v_operation);
  end if;
  if not v_operation.reconciliation_required
    or v_operation.operation_state <> 'outcome_unknown'
    or v_operation.outcome_class <> 'outcome_uncertain' then
    raise exception using message = 'provider_reconciliation_not_required', errcode = 'P0001';
  end if;
  select * into v_workflow from public.research_workflows
  where id = v_operation.workflow_id for update;

  if p_resolution = 'accepted_retryable' then
    if v_workflow.status = 'cancelled' then
      raise exception using message = 'cancelled_workflow_cannot_resume_provider', errcode = 'P0001';
    end if;
    if v_operation.provider_job_id is null then
      raise exception using message = 'provider_reconciliation_job_missing', errcode = 'P0001';
    end if;
    update public.provider_operations
    set operation_state = 'submitted', outcome_class = 'transient_retryable',
      reconciliation_required = false, next_retry_at = p_now,
      settled_at = null, updated_at = p_now
    where id = p_operation_id returning * into v_operation;
    update public.research_steps
    set status = 'retry_scheduled', scheduled_at = p_now, updated_at = p_now
    where id = v_operation.step_id;
    update public.research_workflows
    set status = 'waiting_retry', current_phase = v_operation.operation_kind,
      paused_at = null, updated_at = p_now
    where id = v_operation.workflow_id;
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
      'launchclub.report.requested.v1:' || v_workflow.id::text ||
        ':reconciliation:' || p_operation_id::text,
      p_now
    );
  else
    select * into v_budget from public.report_cost_budgets
    where workflow_id = v_operation.workflow_id for update;
    if v_budget.reserved_cents < v_operation.reserved_cost_cents then
      raise exception using message = 'invalid_cost_reservation', errcode = 'P0001';
    end if;
    if p_resolution = 'paid_cancelled' then
      if p_actual_cost_cents is null or p_actual_cost_cents < 0
        or p_actual_cost_cents > v_operation.reserved_cost_cents then
        raise exception using message = 'provider_reconciled_cost_invalid', errcode = 'P0001';
      end if;
      update public.report_cost_budgets
      set reserved_cents = reserved_cents - v_operation.reserved_cost_cents,
        spent_cents = spent_cents + p_actual_cost_cents, updated_at = p_now
      where workflow_id = v_operation.workflow_id;
      insert into public.report_cost_entries (
        workflow_id, step_id, entry_type, amount_cents, idempotency_key, created_at
      ) values (
        v_operation.workflow_id, v_operation.step_id, 'actual', p_actual_cost_cents,
        v_operation.idempotency_key || ':reconciliation:' ||
          v_operation.reservation_generation::text || ':actual', p_now
      ) on conflict (idempotency_key) do nothing;
      v_release := v_operation.reserved_cost_cents - p_actual_cost_cents;
      if v_release > 0 then
        insert into public.report_cost_entries (
          workflow_id, step_id, entry_type, amount_cents, idempotency_key, created_at
        ) values (
          v_operation.workflow_id, v_operation.step_id, 'release', v_release,
          v_operation.idempotency_key || ':reconciliation:' ||
            v_operation.reservation_generation::text || ':unused', p_now
        ) on conflict (idempotency_key) do nothing;
      end if;
      update public.provider_operations
      set operation_state = 'cancelled', reserved_cost_cents = 0,
        actual_cost_cents = p_actual_cost_cents, outcome_class = 'cancelled',
        reconciliation_required = false, next_retry_at = null,
        settled_at = p_now, updated_at = p_now
      where id = p_operation_id returning * into v_operation;
    else
      update public.report_cost_budgets
      set reserved_cents = reserved_cents - v_operation.reserved_cost_cents,
        updated_at = p_now
      where workflow_id = v_operation.workflow_id;
      if v_operation.reserved_cost_cents > 0 then
        insert into public.report_cost_entries (
          workflow_id, step_id, entry_type, amount_cents, idempotency_key, created_at
        ) values (
          v_operation.workflow_id, v_operation.step_id, 'release',
          v_operation.reserved_cost_cents,
          v_operation.idempotency_key || ':reconciliation:' ||
            v_operation.reservation_generation::text || ':release', p_now
        ) on conflict (idempotency_key) do nothing;
      end if;
      update public.provider_operations
      set operation_state = 'failed', reserved_cost_cents = 0,
        outcome_class = 'definitively_rejected', reconciliation_required = false,
        next_retry_at = null, settled_at = p_now, updated_at = p_now
      where id = p_operation_id returning * into v_operation;
    end if;
  end if;

  update public.workflow_errors
  set resolved_at = p_now
  where workflow_id = v_operation.workflow_id and step_id = v_operation.step_id
    and safe_code = 'provider_outcome_unknown' and resolved_at is null;
  insert into public.provider_operation_reconciliations (
    provider_operation_id, resolution, actual_cost_cents, actor_id, created_at
  ) values (
    p_operation_id, p_resolution, p_actual_cost_cents, left(p_actor_id, 120), p_now
  );
  insert into public.workflow_events (
    workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at
  ) values (
    v_operation.workflow_id, 'provider_operation_reconciled',
    jsonb_build_object('step', v_operation.operation_kind, 'resolution', p_resolution),
    v_operation.workflow_id, 'administrator', p_now
  );
  insert into public.audit_logs (
    entity_type, entity_id, event_type, actor_type, created_at, metadata
  ) values (
    'provider_operation', p_operation_id, 'provider_operation_reconciled',
    'admin', p_now, jsonb_build_object('actorId', left(p_actor_id, 120),
      'resolution', p_resolution)
  );
  return public.provider_operation_json(v_operation);
end;
$$;

create or replace function public.guard_v3_provider_step_retry()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status in ('failed_terminal', 'cancelled')
    and new.status in ('pending', 'retry_scheduled')
    and exists (
      select 1 from public.provider_operations
      where step_id = old.id and reconciliation_required
    ) then
    raise exception using message = 'provider_reconciliation_required', errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_v3_provider_step_retry_trigger on public.research_steps;
create trigger guard_v3_provider_step_retry_trigger
before update of status on public.research_steps
for each row execute function public.guard_v3_provider_step_retry();

create or replace function public.settle_v3_provider_operations_on_terminal_workflow()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.provider_operations%rowtype;
  v_budget public.report_cost_budgets%rowtype;
  v_release integer;
begin
  if new.status = old.status or new.status not in ('failed', 'cancelled') then
    return new;
  end if;
  if new.status = 'failed' then
    if exists (
      select 1 from public.provider_operations
      where workflow_id = new.id and operation_state = 'retry_scheduled'
    ) then
      raise exception using message = 'terminal_workflow_has_retryable_provider_operation', errcode = 'P0001';
    end if;
    return new;
  end if;

  select * into v_budget from public.report_cost_budgets
  where workflow_id = new.id for update;
  for v_operation in
    select * from public.provider_operations where workflow_id = new.id for update
  loop
    if v_operation.operation_state = 'succeeded' and v_operation.reserved_cost_cents > 0 then
      if v_operation.actual_cost_cents is null
        or v_operation.actual_cost_cents > v_operation.reserved_cost_cents then
        raise exception using message = 'provider_success_cost_invalid', errcode = 'P0001';
      end if;
      update public.report_cost_budgets
      set reserved_cents = reserved_cents - v_operation.reserved_cost_cents,
        spent_cents = spent_cents + v_operation.actual_cost_cents,
        updated_at = now()
      where workflow_id = new.id;
      insert into public.report_cost_entries (
        workflow_id, step_id, entry_type, amount_cents, idempotency_key, created_at
      ) values (
        new.id, v_operation.step_id, 'actual', v_operation.actual_cost_cents,
        v_operation.idempotency_key || ':terminal:' ||
          v_operation.reservation_generation::text || ':actual', now()
      ) on conflict (idempotency_key) do nothing;
      v_release := v_operation.reserved_cost_cents - v_operation.actual_cost_cents;
      if v_release > 0 then
        insert into public.report_cost_entries (
          workflow_id, step_id, entry_type, amount_cents, idempotency_key, created_at
        ) values (
          new.id, v_operation.step_id, 'release', v_release,
          v_operation.idempotency_key || ':terminal:' ||
            v_operation.reservation_generation::text || ':unused', now()
        ) on conflict (idempotency_key) do nothing;
      end if;
      update public.provider_operations
      set reserved_cost_cents = 0, outcome_class = 'succeeded',
        reconciliation_required = false, next_retry_at = null,
        settled_at = coalesce(settled_at, now()), updated_at = now()
      where id = v_operation.id;
    elsif v_operation.operation_state in ('submitting', 'submitted', 'polling', 'outcome_unknown')
      or v_operation.reconciliation_required then
      update public.provider_operations
      set operation_state = 'outcome_unknown', outcome_class = 'outcome_uncertain',
        reconciliation_required = true, next_retry_at = null,
        last_safe_error_code = 'provider_outcome_unknown',
        last_safe_error_summary = 'A provider outcome requires administrator reconciliation.',
        settled_at = null, updated_at = now()
      where id = v_operation.id;
      update public.provider_operation_attempts
      set attempt_state = 'outcome_unknown', safe_error_code = 'provider_outcome_unknown',
        safe_error_summary = 'A provider outcome requires administrator reconciliation.',
        completed_at = now()
      where provider_operation_id = v_operation.id and attempt_state = 'started';
      if not exists (
        select 1 from public.workflow_errors
        where workflow_id = new.id and step_id = v_operation.step_id
          and safe_code = 'provider_outcome_unknown' and resolved_at is null
      ) then
        insert into public.workflow_errors (
          workflow_id, step_id, classification, safe_code, safe_summary, created_at
        ) values (
          new.id, v_operation.step_id, 'configuration_error',
          'provider_outcome_unknown',
          'A provider outcome requires administrator reconciliation.', now()
        );
      end if;
    elsif v_operation.operation_state <> 'succeeded' then
      if v_operation.reserved_cost_cents > 0 then
        update public.report_cost_budgets
        set reserved_cents = reserved_cents - v_operation.reserved_cost_cents,
          updated_at = now()
        where workflow_id = new.id;
        insert into public.report_cost_entries (
          workflow_id, step_id, entry_type, amount_cents, idempotency_key, created_at
        ) values (
          new.id, v_operation.step_id, 'release', v_operation.reserved_cost_cents,
          v_operation.idempotency_key || ':terminal:' ||
            v_operation.reservation_generation::text || ':release', now()
        ) on conflict (idempotency_key) do nothing;
      end if;
      update public.provider_operations
      set operation_state = 'cancelled', reserved_cost_cents = 0,
        outcome_class = 'cancelled', reconciliation_required = false,
        next_retry_at = null, settled_at = coalesce(settled_at, now()), updated_at = now()
      where id = v_operation.id;
      update public.provider_operation_attempts
      set attempt_state = 'cancelled', completed_at = now()
      where provider_operation_id = v_operation.id and attempt_state = 'started';
    end if;
  end loop;

  if exists (
    select 1 from public.provider_operations
    where workflow_id = new.id and operation_state = 'retry_scheduled'
  ) then
    raise exception using message = 'terminal_workflow_has_retryable_provider_operation', errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.provider_operations
    where workflow_id = new.id and reserved_cost_cents > 0
      and not reconciliation_required
  ) then
    raise exception using message = 'terminal_workflow_has_unsettled_reservation', errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists settle_v3_provider_operations_on_terminal_workflow_trigger
  on public.research_workflows;
create trigger settle_v3_provider_operations_on_terminal_workflow_trigger
before update of status on public.research_workflows
for each row execute function public.settle_v3_provider_operations_on_terminal_workflow();

revoke execute on function public.reserve_v3_provider_operation_cost(uuid, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.settle_v3_provider_operation(
  uuid, uuid, uuid, text, bigint, text, text, integer, text, text,
  timestamptz, text, timestamptz
) from public, anon, authenticated;
revoke execute on function public.block_v3_provider_configuration(
  uuid, text, uuid, text, bigint, text, text, timestamptz
) from public, anon, authenticated;
revoke execute on function public.admin_reconcile_v3_provider_operation(
  uuid, text, integer, text, timestamptz
) from public, anon, authenticated;
revoke execute on function public.guard_v3_provider_step_retry()
  from public, anon, authenticated;
revoke execute on function public.settle_v3_provider_operations_on_terminal_workflow()
  from public, anon, authenticated;

grant execute on function public.reserve_v3_provider_operation_cost(uuid, timestamptz)
  to service_role;
grant execute on function public.settle_v3_provider_operation(
  uuid, uuid, uuid, text, bigint, text, text, integer, text, text,
  timestamptz, text, timestamptz
) to service_role;
grant execute on function public.block_v3_provider_configuration(
  uuid, text, uuid, text, bigint, text, text, timestamptz
) to service_role;
grant execute on function public.admin_reconcile_v3_provider_operation(
  uuid, text, integer, text, timestamptz
) to service_role;
