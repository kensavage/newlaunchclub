-- PR4 forward-only repair: idempotent provider settlement and audited recovery.

alter table public.provider_operations
  add column if not exists currency_code text not null default 'USD'
    check (currency_code ~ '^[A-Z]{3}$');
alter table public.report_cost_budgets
  add column if not exists currency_code text not null default 'USD'
    check (currency_code ~ '^[A-Z]{3}$');
alter table public.report_cost_entries
  add column if not exists currency_code text not null default 'USD'
    check (currency_code ~ '^[A-Z]{3}$');

create table if not exists public.provider_operation_settlements (
  provider_operation_id uuid primary key
    references public.provider_operations(id) on delete cascade,
  workflow_id uuid not null references public.research_workflows(id) on delete cascade,
  step_id uuid not null references public.research_steps(id) on delete cascade,
  workflow_attempt_id uuid not null references public.research_attempts(id) on delete restrict,
  provider_attempt_id uuid references public.provider_operation_attempts(id) on delete restrict,
  settlement_outcome text not null check (settlement_outcome in (
    'succeeded', 'definitively_rejected', 'cancelled'
  )),
  actual_cost_cents integer not null check (actual_cost_cents >= 0),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  reservation_generation integer not null check (reservation_generation >= 0),
  output_reference text,
  cost_source text not null check (cost_source in ('reservation', 'provider_response')),
  created_at timestamptz not null default now(),
  check (output_reference is null or char_length(output_reference) between 1 and 250)
);

alter table public.provider_operation_settlements enable row level security;
revoke all on table public.provider_operation_settlements
  from public, anon, authenticated, service_role;

drop trigger if exists provider_operation_settlements_immutable
  on public.provider_operation_settlements;
create trigger provider_operation_settlements_immutable
before update or delete on public.provider_operation_settlements
for each row execute function public.reject_immutable_research_update();

insert into public.provider_operation_settlements (
  provider_operation_id, workflow_id, step_id, workflow_attempt_id,
  provider_attempt_id, settlement_outcome, actual_cost_cents, currency_code,
  reservation_generation, output_reference, cost_source, created_at
)
select
  po.id, po.workflow_id, po.step_id, ra.id, null, 'succeeded',
  po.actual_cost_cents, po.currency_code, po.reservation_generation,
  rs.output_reference,
  case when ara.id is null then 'reservation' else 'provider_response' end,
  coalesce(po.settled_at, rs.completed_at, po.updated_at)
from public.provider_operations po
join public.research_steps rs on rs.id = po.step_id
join lateral (
  select id
  from public.research_attempts
  where step_id = rs.id and outcome = 'succeeded'
  order by attempt_number desc
  limit 1
) ra on true
left join public.analysis_response_artifacts ara
  on ara.provider_operation_id = po.id
where po.operation_state = 'succeeded'
  and po.outcome_class = 'succeeded'
  and po.reserved_cost_cents = 0
  and po.actual_cost_cents is not null
  and rs.status = 'succeeded'
on conflict (provider_operation_id) do nothing;

alter function public.settle_v3_provider_operation(
  uuid, uuid, uuid, text, bigint, text, text, integer,
  text, text, timestamptz, text, timestamptz
) rename to settle_v3_provider_operation_pre_0008;

revoke execute on function public.settle_v3_provider_operation_pre_0008(
  uuid, uuid, uuid, text, bigint, text, text, integer,
  text, text, timestamptz, text, timestamptz
) from public, anon, authenticated, service_role;

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
  v_artifact public.analysis_response_artifacts%rowtype;
  v_settlement public.provider_operation_settlements%rowtype;
  v_result jsonb;
  v_expected_cost integer;
  v_expected_output_reference text;
  v_actual_key text;
  v_release_key text;
  v_expected_release integer;
  v_actual_entries integer;
  v_actual_amount integer;
  v_release_entries integer;
  v_release_amount integer;
  v_cost_source text;
  v_terminal boolean;
begin
  if p_outcome not in (
    'succeeded', 'definitively_rejected', 'transient_retryable',
    'outcome_uncertain', 'cancelled'
  ) then
    raise exception using message = 'provider_outcome_invalid', errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'provider-operation:' || p_operation_id::text, 0
  ));
  select * into v_operation
  from public.provider_operations
  where id = p_operation_id
  for update;
  if v_operation.id is null then
    raise exception using message = 'provider_operation_not_found', errcode = 'P0001';
  end if;
  select * into v_step
  from public.research_steps
  where id = v_operation.step_id
  for update;
  select * into v_workflow
  from public.research_workflows
  where id = v_operation.workflow_id
  for update;
  select * into v_budget
  from public.report_cost_budgets
  where workflow_id = v_operation.workflow_id
  for update;
  if v_budget.workflow_id is null
    or v_budget.currency_code <> v_operation.currency_code then
    raise exception using message = 'provider_settlement_currency_conflict', errcode = 'P0001';
  end if;

  v_expected_cost := coalesce(v_operation.actual_cost_cents, 0);
  v_expected_output_reference := case when p_outcome = 'succeeded' then
    left(coalesce(
      p_output_reference,
      'provider-operation:' || v_operation.id::text
    ), 250)
  else null end;
  select * into v_settlement
  from public.provider_operation_settlements
  where provider_operation_id = p_operation_id;

  if v_settlement.provider_operation_id is not null then
    if v_settlement.workflow_id <> v_operation.workflow_id
      or v_settlement.step_id <> v_operation.step_id
      or v_settlement.workflow_attempt_id <> p_workflow_attempt_id
      or v_settlement.provider_attempt_id is distinct from p_provider_attempt_id
      or v_settlement.settlement_outcome <> p_outcome
      or v_settlement.actual_cost_cents <> v_expected_cost
      or v_settlement.currency_code <> v_operation.currency_code
      or v_settlement.reservation_generation <> v_operation.reservation_generation
      or v_settlement.output_reference is distinct from v_expected_output_reference then
      raise exception using message = 'provider_settlement_idempotency_conflict', errcode = 'P0001';
    end if;
    if (p_outcome = 'succeeded' and v_step.status = 'succeeded')
      or (p_outcome = 'definitively_rejected' and v_step.status = 'failed_terminal')
      or (p_outcome = 'cancelled' and v_step.status = 'cancelled') then
      return public.provider_operation_json(v_operation);
    end if;
    raise exception using message = 'provider_settlement_state_incomplete', errcode = 'P0001';
  end if;

  if p_outcome = 'succeeded'
    and v_operation.operation_kind in (
      'company_profile_extraction', 'search_query_discovery'
    )
    and v_operation.operation_state = 'succeeded'
    and v_operation.reserved_cost_cents = 0
    and v_operation.actual_cost_cents > 0 then
    select * into v_artifact
    from public.analysis_response_artifacts
    where provider_operation_id = v_operation.id;
    if v_artifact.id is null
      or not v_artifact.artifact_complete
      or v_artifact.actual_cost_cents <> v_operation.actual_cost_cents
      or v_artifact.parse_status <> 'succeeded'
      or v_artifact.persistence_status <> 'succeeded'
      or v_artifact.current_failure_classification is not null then
      raise exception using message = 'provider_response_settlement_incomplete', errcode = 'P0001';
    end if;
    if v_operation.operation_kind = 'company_profile_extraction'
      and not exists (
        select 1
        from public.model_invocations mi
        join public.company_profile_versions cpv
          on cpv.model_invocation_id = mi.id
        where mi.provider_operation_id = v_operation.id
      ) then
      raise exception using message = 'provider_response_persistence_missing', errcode = 'P0001';
    end if;
    if v_operation.operation_kind = 'search_query_discovery'
      and not exists (
        select 1
        from public.model_invocations mi
        join public.search_query_sets sqs
          on sqs.model_invocation_id = mi.id
        where mi.provider_operation_id = v_operation.id
      ) then
      raise exception using message = 'provider_response_persistence_missing', errcode = 'P0001';
    end if;

    v_actual_key := v_operation.idempotency_key || ':provider-response:' ||
      v_operation.reservation_generation::text || ':actual';
    select count(*)::integer, coalesce(sum(amount_cents), 0)::integer
    into v_actual_entries, v_actual_amount
    from public.report_cost_entries
    where workflow_id = v_operation.workflow_id
      and step_id = v_operation.step_id
      and entry_type = 'actual'
      and idempotency_key = v_actual_key
      and currency_code = v_operation.currency_code;
    if v_actual_entries <> 1
      or v_actual_amount <> v_operation.actual_cost_cents then
      raise exception using message = 'provider_response_settlement_ledger_invalid', errcode = 'P0001';
    end if;

    v_expected_release := v_operation.estimated_cost_cents -
      v_operation.actual_cost_cents;
    if v_expected_release < 0 then
      raise exception using message = 'provider_response_settlement_ledger_invalid', errcode = 'P0001';
    end if;
    v_release_key := v_operation.idempotency_key || ':provider-response:' ||
      v_operation.reservation_generation::text || ':unused';
    select count(*)::integer, coalesce(sum(amount_cents), 0)::integer
    into v_release_entries, v_release_amount
    from public.report_cost_entries
    where workflow_id = v_operation.workflow_id
      and step_id = v_operation.step_id
      and entry_type = 'release'
      and idempotency_key = v_release_key
      and currency_code = v_operation.currency_code;
    if (v_expected_release = 0 and v_release_entries <> 0)
      or (v_expected_release > 0 and (
        v_release_entries <> 1 or v_release_amount <> v_expected_release
      )) then
      raise exception using message = 'provider_response_settlement_ledger_invalid', errcode = 'P0001';
    end if;

    select * into v_lease
    from public.workflow_leases
    where workflow_id = v_operation.workflow_id
      and step_id = v_step.id
      and released_at is null
    for update;
    if v_lease.id is null
      or v_lease.lease_owner <> p_owner
      or v_lease.fencing_token <> p_fencing_token
      or v_lease.expires_at <= p_now then
      raise exception using message = 'provider_settlement_lease_conflict', errcode = 'P0001';
    end if;
    if not exists (
      select 1
      from public.research_attempts
      where id = p_workflow_attempt_id
        and workflow_id = v_operation.workflow_id
        and step_id = v_step.id
        and outcome = 'running'
    ) then
      raise exception using message = 'provider_workflow_attempt_fenced', errcode = 'P0001';
    end if;

    insert into public.provider_operation_settlements (
      provider_operation_id, workflow_id, step_id, workflow_attempt_id,
      provider_attempt_id, settlement_outcome, actual_cost_cents,
      currency_code, reservation_generation, output_reference,
      cost_source, created_at
    ) values (
      v_operation.id, v_operation.workflow_id, v_operation.step_id,
      p_workflow_attempt_id, p_provider_attempt_id, p_outcome,
      v_operation.actual_cost_cents, v_operation.currency_code,
      v_operation.reservation_generation, v_expected_output_reference,
      'provider_response', p_now
    );
    update public.provider_operations
    set reconciliation_required = false, next_retry_at = null,
      last_safe_error_code = null, last_safe_error_summary = null,
      settled_at = coalesce(settled_at, p_now), updated_at = p_now
    where id = v_operation.id
    returning * into v_operation;
    update public.workflow_errors
    set resolved_at = p_now
    where workflow_id = v_operation.workflow_id
      and step_id = v_step.id
      and classification = 'transient'
      and resolved_at is null;
    update public.research_steps
    set status = 'succeeded', output_reference = v_expected_output_reference,
      actual_cost_cents = v_operation.actual_cost_cents,
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
      set status = 'ready_for_search_intelligence',
        current_phase = 'search_intelligence', updated_at = p_now
      where id = v_operation.workflow_id;
      insert into public.workflow_events (
        workflow_id, event_type, safe_metadata, correlation_id,
        actor_type, created_at
      ) values (
        v_operation.workflow_id, 'workflow_ready_for_search_intelligence',
        '{}'::jsonb, v_operation.workflow_id, 'orchestrator', p_now
      );
    else
      update public.research_workflows
      set updated_at = p_now
      where id = v_operation.workflow_id;
    end if;
    insert into public.workflow_events (
      workflow_id, event_type, safe_metadata, correlation_id,
      actor_type, created_at
    ) values (
      v_operation.workflow_id, 'provider_operation_succeeded',
      jsonb_build_object(
        'step', v_operation.operation_kind,
        'actualCostCents', v_operation.actual_cost_cents
      ),
      v_operation.workflow_id, 'orchestrator', p_now
    );
    return public.provider_operation_json(v_operation);
  end if;

  v_result := public.settle_v3_provider_operation_pre_0008(
    p_operation_id, p_provider_attempt_id, p_workflow_attempt_id,
    p_owner, p_fencing_token, p_outcome, p_classification,
    p_http_status, p_safe_code, p_safe_summary, p_retry_at,
    p_output_reference, p_now
  );

  select * into v_operation
  from public.provider_operations
  where id = p_operation_id;
  select * into v_step
  from public.research_steps
  where id = v_operation.step_id;
  v_terminal := (p_outcome = 'succeeded' and v_step.status = 'succeeded')
    or (p_outcome = 'definitively_rejected' and v_step.status = 'failed_terminal')
    or (p_outcome = 'cancelled' and v_step.status = 'cancelled');
  if v_terminal then
    v_expected_cost := coalesce(v_operation.actual_cost_cents, 0);
    v_expected_output_reference := case when p_outcome = 'succeeded' then
      left(coalesce(
        p_output_reference,
        'provider-operation:' || v_operation.id::text
      ), 250)
    else null end;
    v_cost_source := case when exists (
      select 1
      from public.analysis_response_artifacts
      where provider_operation_id = v_operation.id
    ) then 'provider_response' else 'reservation' end;
    insert into public.provider_operation_settlements (
      provider_operation_id, workflow_id, step_id, workflow_attempt_id,
      provider_attempt_id, settlement_outcome, actual_cost_cents,
      currency_code, reservation_generation, output_reference,
      cost_source, created_at
    ) values (
      v_operation.id, v_operation.workflow_id, v_operation.step_id,
      p_workflow_attempt_id, p_provider_attempt_id, p_outcome,
      v_expected_cost, v_operation.currency_code,
      v_operation.reservation_generation, v_expected_output_reference,
      v_cost_source, p_now
    );
  end if;
  return v_result;
end;
$$;

revoke execute on function public.settle_v3_provider_operation(
  uuid, uuid, uuid, text, bigint, text, text, integer,
  text, text, timestamptz, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.settle_v3_provider_operation(
  uuid, uuid, uuid, text, bigint, text, text, integer,
  text, text, timestamptz, text, timestamptz
) to service_role;

alter function public.admin_transition_research_workflow(
  uuid, text, text, text, timestamptz
) rename to admin_transition_research_workflow_pre_0008;

revoke execute on function public.admin_transition_research_workflow_pre_0008(
  uuid, text, text, text, timestamptz
) from public, anon, authenticated, service_role;

create or replace function public.admin_transition_research_workflow(
  p_workflow_id uuid,
  p_command text,
  p_step_key text,
  p_actor_id text,
  p_now timestamptz default now()
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_workflow public.research_workflows%rowtype;
  v_step public.research_steps%rowtype;
  v_operation public.provider_operations%rowtype;
  v_artifact public.analysis_response_artifacts%rowtype;
  v_settlement public.provider_operation_settlements%rowtype;
  v_attempt public.research_attempts%rowtype;
  v_lease public.workflow_leases%rowtype;
  v_new_lease public.workflow_leases%rowtype;
  v_fence bigint;
  v_owner text;
  v_queue_result jsonb;
  v_payload jsonb;
  v_output_reference text;
begin
  if p_command <> 'recover_settled_step' then
    return public.admin_transition_research_workflow_pre_0008(
      p_workflow_id, p_command, p_step_key, p_actor_id, p_now
    );
  end if;
  if p_actor_id is null or char_length(p_actor_id) not between 1 and 120
    or p_step_key not in (
      'company_profile_extraction', 'search_query_discovery'
    ) then
    raise exception using message = 'settled_step_recovery_invalid', errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'workflow-admin-recovery:' || p_workflow_id::text, 0
  ));
  select * into v_workflow
  from public.research_workflows
  where id = p_workflow_id
  for update;
  select * into v_step
  from public.research_steps
  where workflow_id = p_workflow_id
    and step_key = p_step_key
  order by step_version desc
  limit 1
  for update;
  select * into v_operation
  from public.provider_operations
  where workflow_id = p_workflow_id
    and step_id = v_step.id
    and operation_kind = p_step_key
  for update;
  if v_workflow.id is null or v_step.id is null or v_operation.id is null then
    raise exception using message = 'settled_step_recovery_not_found', errcode = 'P0001';
  end if;
  select * into v_settlement
  from public.provider_operation_settlements
  where provider_operation_id = v_operation.id;
  if v_step.status = 'succeeded' then
    if v_settlement.provider_operation_id is null then
      raise exception using message = 'settled_step_recovery_receipt_missing', errcode = 'P0001';
    end if;
    return true;
  end if;
  if v_workflow.status <> 'running'
    or v_step.status <> 'running'
    or v_operation.operation_state <> 'succeeded'
    or v_operation.outcome_class <> 'succeeded'
    or v_operation.reserved_cost_cents <> 0
    or v_operation.actual_cost_cents is null
    or v_settlement.provider_operation_id is not null then
    raise exception using message = 'settled_step_recovery_state_invalid', errcode = 'P0001';
  end if;
  select * into v_artifact
  from public.analysis_response_artifacts
  where provider_operation_id = v_operation.id;
  if v_artifact.id is null
    or not v_artifact.artifact_complete
    or v_artifact.actual_cost_cents <> v_operation.actual_cost_cents
    or v_artifact.parse_status <> 'succeeded'
    or v_artifact.persistence_status <> 'succeeded'
    or v_artifact.current_failure_classification is not null then
    raise exception using message = 'settled_step_recovery_artifact_invalid', errcode = 'P0001';
  end if;
  if p_step_key = 'company_profile_extraction'
    and not exists (
      select 1
      from public.model_invocations mi
      join public.company_profile_versions cpv
        on cpv.model_invocation_id = mi.id
      where mi.provider_operation_id = v_operation.id
    ) then
    raise exception using message = 'settled_step_recovery_output_missing', errcode = 'P0001';
  end if;
  if p_step_key = 'search_query_discovery'
    and not exists (
      select 1
      from public.model_invocations mi
      join public.search_query_sets sqs
        on sqs.model_invocation_id = mi.id
      where mi.provider_operation_id = v_operation.id
    ) then
    raise exception using message = 'settled_step_recovery_output_missing', errcode = 'P0001';
  end if;
  select * into v_attempt
  from public.research_attempts
  where workflow_id = p_workflow_id
    and step_id = v_step.id
    and attempt_number = v_step.attempt_count
    and outcome = 'running'
  for update;
  if v_attempt.id is null then
    raise exception using message = 'settled_step_recovery_attempt_invalid', errcode = 'P0001';
  end if;
  select * into v_lease
  from public.workflow_leases
  where workflow_id = p_workflow_id
    and step_id = v_step.id
    and released_at is null
  for update;
  if v_lease.id is not null and v_lease.expires_at > p_now then
    raise exception using message = 'settled_step_recovery_lease_active', errcode = 'P0001';
  end if;
  if v_lease.id is not null then
    update public.workflow_leases
    set released_at = p_now, release_reason = 'administrator'
    where id = v_lease.id;
  end if;
  select coalesce(max(fencing_token), 0) + 1 into v_fence
  from public.workflow_leases
  where workflow_id = p_workflow_id
    and scope_key = 'step:' || v_step.id::text;
  v_owner := 'admin-recovery:' || left(p_actor_id, 120);
  insert into public.workflow_leases (
    workflow_id, step_id, scope_key, lease_owner, fencing_token,
    expires_at, heartbeat_at, created_at
  ) values (
    p_workflow_id, v_step.id, 'step:' || v_step.id::text,
    v_owner, v_fence, p_now + interval '5 minutes', p_now, p_now
  ) returning * into v_new_lease;
  v_output_reference := 'provider-operation:' || v_operation.id::text;
  perform public.settle_v3_provider_operation(
    v_operation.id, null, v_attempt.id, v_owner, v_new_lease.fencing_token,
    'succeeded', null, v_operation.last_http_status, null, null,
    null, v_output_reference, p_now
  );

  if p_step_key = 'company_profile_extraction' then
    v_payload := jsonb_build_object(
      'workflowId', v_workflow.id,
      'reportRequestId', v_workflow.report_request_id,
      'reportId', v_workflow.report_id,
      'correlationId', gen_random_uuid(),
      'workflowVersion', v_workflow.workflow_version,
      'requestedAt', p_now
    );
    v_queue_result := public.enqueue_v3_workflow_message(
      v_payload,
      'launchclub.report.requested.v1:' || v_workflow.id::text ||
        ':recover-settled:' || v_step.id::text || ':' ||
        v_step.attempt_count::text,
      p_now
    );
    update public.workflow_queue_dead_letters
    set retry_status = 'retried',
      retried_message_id = (v_queue_result ->> 'messageId')::bigint,
      retried_at = p_now
    where workflow_id = p_workflow_id and retry_status = 'pending';
  end if;
  insert into public.workflow_events (
    workflow_id, event_type, safe_metadata, correlation_id,
    actor_type, created_at
  ) values (
    p_workflow_id, 'administrator_settled_step_recovered',
    jsonb_build_object('actorId', left(p_actor_id, 120), 'step', p_step_key),
    p_workflow_id, 'administrator', p_now
  );
  insert into public.audit_logs (
    entity_type, entity_id, event_type, actor_type, created_at, metadata
  ) values (
    'research_workflow', p_workflow_id,
    'administrator_settled_step_recovered', 'admin', p_now,
    jsonb_build_object('actorId', left(p_actor_id, 120), 'step', p_step_key)
  );
  return true;
end;
$$;

revoke execute on function public.admin_transition_research_workflow(
  uuid, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.admin_transition_research_workflow(
  uuid, text, text, text, timestamptz
) to service_role;
