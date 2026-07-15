-- Launch Club V3 queue-state preservation.
-- Queue delivery is transport state; canonical workflow progress is derived from durable steps.

create or replace function public.reconcile_v3_workflow_queue_state(
  p_workflow_id uuid,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_workflow public.research_workflows%rowtype;
  v_next_step public.research_steps%rowtype;
  v_next_status text;
  v_next_phase text;
  v_previous_status text;
  v_previous_phase text;
begin
  select * into v_workflow
  from public.research_workflows
  where id = p_workflow_id
  for update;
  if v_workflow.id is null then
    raise exception using message = 'workflow_not_found', errcode = 'P0001';
  end if;

  v_next_status := v_workflow.status;
  v_next_phase := v_workflow.current_phase;

  -- Administrative and terminal decisions cannot be undone by queue transport.
  if v_workflow.status not in (
    'paused', 'cancelled', 'failed', 'completed', 'partially_complete'
  ) then
    select * into v_next_step
    from public.research_steps
    where workflow_id = p_workflow_id
      and status not in ('succeeded', 'skipped')
    order by public.research_step_position(step_key), created_at, id
    limit 1;

    if v_next_step.id is not null then
      v_next_phase := v_next_step.step_key;
      v_next_status := case v_next_step.status
        when 'pending' then 'dispatch_pending'
        when 'leased' then 'running'
        when 'running' then 'running'
        when 'retry_scheduled' then
          case when v_next_step.scheduled_at <= p_now
            then 'dispatch_pending' else 'waiting_retry' end
        when 'failed_terminal' then 'failed'
        when 'cancelled' then 'cancelled'
        else v_workflow.status
      end;
    elsif exists (
      select 1 from public.research_steps
      where workflow_id = p_workflow_id
    ) and not exists (
      select 1 from public.research_steps
      where workflow_id = p_workflow_id and status <> 'succeeded'
    ) then
      if exists (
        select 1 from public.research_steps
        where workflow_id = p_workflow_id
          and step_key = 'search_query_discovery' and status = 'succeeded'
      ) then
        v_next_status := 'ready_for_search_intelligence';
        v_next_phase := 'search_intelligence';
      elsif exists (
        select 1 from public.research_steps
        where workflow_id = p_workflow_id
          and step_key = 'mark_ready_for_provider_research' and status = 'succeeded'
      ) then
        v_next_status := 'ready_for_provider_research';
        v_next_phase := 'provider_research';
      end if;
    end if;
  end if;

  if v_next_status is distinct from v_workflow.status
    or v_next_phase is distinct from v_workflow.current_phase then
    v_previous_status := v_workflow.status;
    v_previous_phase := v_workflow.current_phase;
    update public.research_workflows
    set status = v_next_status, current_phase = v_next_phase,
      cancelled_at = case when v_next_status = 'cancelled'
        then coalesce(cancelled_at, p_now) else cancelled_at end,
      updated_at = p_now
    where id = p_workflow_id
    returning * into v_workflow;

    insert into public.workflow_events (
      workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at
    ) values (
      p_workflow_id, 'workflow_queue_state_reconciled',
      jsonb_build_object(
        'fromStatus', v_previous_status,
        'toStatus', v_next_status,
        'fromPhase', v_previous_phase,
        'toPhase', v_next_phase
      ),
      p_workflow_id, 'orchestrator', p_now
    );
  end if;

  select * into v_workflow
  from public.research_workflows
  where id = p_workflow_id;
  return public.research_workflow_json(v_workflow);
end;
$$;

create or replace function public.enqueue_v3_workflow_message(
  p_payload jsonb,
  p_idempotency_key text,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_workflow public.research_workflows%rowtype;
  v_outbox_id uuid;
  v_existing_message_id text;
  v_existing_workflow_id uuid;
  v_existing_payload jsonb;
  v_message_id bigint;
begin
  if jsonb_typeof(p_payload) <> 'object'
    or (select count(*) from jsonb_object_keys(p_payload)) <> 6
    or not (p_payload ?& array[
      'workflowId', 'reportRequestId', 'reportId', 'correlationId',
      'workflowVersion', 'requestedAt'
    ]) then
    raise exception using message = 'workflow_queue_payload_invalid', errcode = 'P0001';
  end if;
  if octet_length(p_payload::text) >= 32768 then
    raise exception using message = 'workflow_queue_payload_too_large', errcode = 'P0001';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 250 then
    raise exception using message = 'workflow_queue_idempotency_invalid', errcode = 'P0001';
  end if;

  perform (p_payload ->> 'correlationId')::uuid;
  perform (p_payload ->> 'requestedAt')::timestamptz;
  perform (p_payload ->> 'workflowVersion')::integer;
  select * into v_workflow
  from public.research_workflows
  where id = (p_payload ->> 'workflowId')::uuid
  for update;
  if v_workflow.id is null
    or v_workflow.report_request_id <> (p_payload ->> 'reportRequestId')::uuid
    or v_workflow.report_id <> (p_payload ->> 'reportId')::uuid
    or v_workflow.workflow_version <> (p_payload ->> 'workflowVersion')::integer then
    raise exception using message = 'workflow_queue_reference_invalid', errcode = 'P0001';
  end if;

  insert into public.outbox_events (
    event_type, aggregate_type, aggregate_id, payload, idempotency_key, status,
    available_at, created_at, updated_at
  ) values (
    'launchclub.report.requested.v1', 'research_workflow', v_workflow.id,
    p_payload, p_idempotency_key, 'pending', p_now, p_now, p_now
  ) on conflict (idempotency_key) do nothing
  returning id into v_outbox_id;

  if v_outbox_id is null then
    select external_event_id, aggregate_id, payload
    into v_existing_message_id, v_existing_workflow_id, v_existing_payload
    from public.outbox_events
    where idempotency_key = p_idempotency_key;
    if v_existing_message_id is null then
      raise exception using message = 'workflow_queue_idempotency_incomplete', errcode = 'P0001';
    end if;
    if v_existing_workflow_id <> v_workflow.id or v_existing_payload <> p_payload then
      raise exception using message = 'workflow_queue_idempotency_conflict', errcode = 'P0001';
    end if;
    perform public.reconcile_v3_workflow_queue_state(v_workflow.id, p_now);
    return jsonb_build_object('messageId', v_existing_message_id);
  end if;

  select * into v_message_id
  from pgmq.send('v3_report_workflows', p_payload);

  update public.outbox_events
  set status = 'sent', attempt_count = 1, external_event_id = v_message_id::text,
    sent_at = p_now, updated_at = p_now
  where id = v_outbox_id;
  update public.research_workflows
  set external_event_id = v_message_id::text
  where id = v_workflow.id;
  insert into public.workflow_events (
    workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at
  ) values (
    v_workflow.id, 'queue_message_enqueued',
    jsonb_build_object('messageId', v_message_id::text),
    (p_payload ->> 'correlationId')::uuid, 'system', p_now
  );
  perform public.reconcile_v3_workflow_queue_state(v_workflow.id, p_now);
  return jsonb_build_object('messageId', v_message_id::text);
end;
$$;

revoke execute on function public.reconcile_v3_workflow_queue_state(uuid, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.enqueue_v3_workflow_message(jsonb, text, timestamptz)
  from public, anon, authenticated;

grant execute on function public.reconcile_v3_workflow_queue_state(uuid, timestamptz)
  to service_role;
grant execute on function public.enqueue_v3_workflow_message(jsonb, text, timestamptz)
  to service_role;
