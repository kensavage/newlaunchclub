-- Launch Club V3 durable messaging pivot. This migration does not call research providers.

create extension if not exists pgmq;

do $$
begin
  if not exists (select 1 from pgmq.meta where queue_name = 'v3_report_workflows') then
    perform pgmq.create('v3_report_workflows');
  end if;
end;
$$;

revoke all on schema pgmq from public, anon, authenticated;
revoke all privileges on all tables in schema pgmq from public, anon, authenticated;
revoke execute on all functions in schema pgmq from public, anon, authenticated;

alter table public.research_workflows
  drop constraint if exists research_workflows_orchestrator_backend_check;
update public.research_workflows
set orchestrator_backend = 'supabase_queue'
where orchestrator_backend = 'netlify';
alter table public.research_workflows
  alter column orchestrator_backend set default 'supabase_queue';
alter table public.research_workflows
  add constraint research_workflows_orchestrator_backend_check
  check (orchestrator_backend in ('supabase_queue', 'deterministic'));

create table if not exists public.workflow_queue_dead_letters (
  id uuid primary key default gen_random_uuid(),
  queue_name text not null default 'v3_report_workflows' check (queue_name = 'v3_report_workflows'),
  message_id bigint not null unique check (message_id > 0),
  workflow_id uuid references public.research_workflows(id) on delete set null,
  classification text not null check (classification in (
    'transient', 'permanent', 'budget_blocked', 'cancelled',
    'lease_conflict', 'configuration_error'
  )),
  read_count integer not null check (read_count >= 0),
  attempt_count integer not null check (attempt_count >= 0),
  last_safe_error text not null check (char_length(last_safe_error) between 1 and 240),
  failed_at timestamptz not null,
  retry_status text not null default 'pending' check (retry_status in ('pending', 'retried', 'dismissed')),
  retried_message_id bigint,
  retried_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.workflow_wakeup_nonces (
  nonce_hash text primary key check (nonce_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists workflow_queue_dead_letters_workflow_idx
  on public.workflow_queue_dead_letters (workflow_id, failed_at desc);
create index if not exists workflow_wakeup_nonces_expiry_idx
  on public.workflow_wakeup_nonces (expires_at);

alter table public.workflow_queue_dead_letters enable row level security;
alter table public.workflow_wakeup_nonces enable row level security;
revoke all privileges on table public.workflow_queue_dead_letters, public.workflow_wakeup_nonces
  from anon, authenticated;

alter table public.outbox_events add column if not exists external_event_id text;
comment on table public.outbox_events is
  'Reserved for future external integrations. V3 pgmq delivery is atomic and does not use an outbox dispatcher; sent rows provide message idempotency and audit linkage.';

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
    select external_event_id into v_existing_message_id
    from public.outbox_events
    where idempotency_key = p_idempotency_key;
    if v_existing_message_id is null then
      raise exception using message = 'workflow_queue_idempotency_incomplete', errcode = 'P0001';
    end if;
    return jsonb_build_object('messageId', v_existing_message_id);
  end if;

  select * into v_message_id
  from pgmq.send('v3_report_workflows', p_payload);

  update public.outbox_events
  set status = 'sent', attempt_count = 1, external_event_id = v_message_id::text,
    sent_at = p_now, updated_at = p_now
  where id = v_outbox_id;
  update public.research_workflows
  set external_event_id = v_message_id::text, status = 'dispatch_pending', updated_at = p_now
  where id = v_workflow.id and status not in ('paused', 'cancelled', 'failed', 'completed');
  insert into public.workflow_events (
    workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at
  ) values (
    v_workflow.id, 'queue_message_enqueued',
    jsonb_build_object('messageId', v_message_id::text),
    (p_payload ->> 'correlationId')::uuid, 'system', p_now
  );
  return jsonb_build_object('messageId', v_message_id::text);
end;
$$;

create or replace function public.read_v3_workflow_messages(
  p_batch_size integer,
  p_visibility_timeout_seconds integer
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if p_batch_size not between 1 and 25
    or p_visibility_timeout_seconds not between 30 and 900 then
    raise exception using message = 'workflow_queue_read_invalid', errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'messageId', q.msg_id::text,
    'readCount', q.read_ct,
    'enqueuedAt', q.enqueued_at,
    'visibleAt', q.vt,
    'payload', q.message
  ) order by q.msg_id), '[]'::jsonb)
  into v_result
  from pgmq.read('v3_report_workflows', p_visibility_timeout_seconds, p_batch_size) q;
  return v_result;
end;
$$;

create or replace function public.archive_v3_workflow_message(p_message_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_archived boolean;
begin
  select pgmq.archive('v3_report_workflows', p_message_id::bigint) into v_archived;
  return coalesce(v_archived, false);
end;
$$;

create or replace function public.release_v3_workflow_message(
  p_message_id text,
  p_delay_seconds integer
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_delay_seconds not between 0 and 3600 then
    raise exception using message = 'workflow_queue_visibility_invalid', errcode = 'P0001';
  end if;
  perform 1 from pgmq.set_vt('v3_report_workflows', p_message_id::bigint, p_delay_seconds);
  return found;
end;
$$;

create or replace function public.dead_letter_v3_workflow_message(
  p_message_id text,
  p_workflow_id uuid,
  p_classification text,
  p_read_count integer,
  p_attempt_count integer,
  p_last_safe_error text,
  p_failed_at timestamptz default now()
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_inserted boolean;
begin
  if p_classification not in (
    'transient', 'permanent', 'budget_blocked', 'cancelled',
    'lease_conflict', 'configuration_error'
  ) or p_read_count < 0 or p_attempt_count < 0 then
    raise exception using message = 'workflow_dead_letter_invalid', errcode = 'P0001';
  end if;
  insert into public.workflow_queue_dead_letters (
    message_id, workflow_id, classification, read_count, attempt_count,
    last_safe_error, failed_at
  ) values (
    p_message_id::bigint, p_workflow_id, p_classification, p_read_count,
    p_attempt_count, left(p_last_safe_error, 240), p_failed_at
  ) on conflict (message_id) do nothing;
  v_inserted := found;
  if v_inserted and p_workflow_id is not null then
    insert into public.workflow_events (
      workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at
    ) values (
      p_workflow_id, 'queue_message_dead_lettered',
      jsonb_build_object(
        'messageId', p_message_id,
        'classification', p_classification,
        'readCount', p_read_count,
        'attemptCount', p_attempt_count
      ), p_workflow_id, 'orchestrator', p_failed_at
    );
  end if;
  perform pgmq.archive('v3_report_workflows', p_message_id::bigint);
  return true;
end;
$$;

create or replace function public.consume_v3_workflow_wakeup_nonce(
  p_nonce_hash text,
  p_expires_at timestamptz,
  p_now timestamptz default now()
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_nonce_hash !~ '^[a-f0-9]{64}$' or p_expires_at <= p_now then return false; end if;
  delete from public.workflow_wakeup_nonces where expires_at <= p_now;
  insert into public.workflow_wakeup_nonces (nonce_hash, expires_at, created_at)
  values (p_nonce_hash, p_expires_at, p_now)
  on conflict (nonce_hash) do nothing;
  return found;
end;
$$;

create or replace function public.create_initial_research_workflow(
  p_report_request_id uuid,
  p_report_id uuid,
  p_input_hash text,
  p_correlation_id uuid,
  p_priority integer default 0,
  p_workflow_version integer default 1,
  p_orchestrator_backend text default 'supabase_queue',
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
  if v_workflow.id is not null then return public.research_workflow_json(v_workflow); end if;

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
      v_workflow.id, v_step_key, 1, 'pending',
      md5(p_input_hash || ':' || v_step_key || ':1') || md5(v_step_key || p_input_hash),
      least(greatest(p_maximum_attempts, 1), 20), p_now, p_now, p_now
    );
  end loop;

  insert into public.report_cost_budgets (workflow_id, budget_type, limit_cents, created_at, updated_at)
  values (v_workflow.id, 'initial_report', 400, p_now, p_now);
  insert into public.workflow_events (workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at)
  values
    (v_workflow.id, 'workflow_created', '{}'::jsonb, p_correlation_id, 'system', p_now),
    (v_workflow.id, 'dispatch_requested', '{}'::jsonb, p_correlation_id, 'system', p_now);

  perform public.enqueue_v3_workflow_message(
    jsonb_build_object(
      'workflowId', v_workflow.id,
      'reportRequestId', p_report_request_id,
      'reportId', p_report_id,
      'correlationId', p_correlation_id,
      'workflowVersion', p_workflow_version,
      'requestedAt', p_now
    ),
    'launchclub.report.requested.v1:' || v_workflow.id::text || ':' || p_workflow_version::text || ':initial',
    p_now
  );
  select * into v_workflow from public.research_workflows where id = v_workflow.id;
  return public.research_workflow_json(v_workflow);
end;
$$;

create or replace function public.create_v3_workflow_after_report_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_request public.report_requests%rowtype;
begin
  select * into v_request from public.report_requests where id = new.report_request_id;
  perform public.create_initial_research_workflow(
    new.report_request_id, new.id, v_request.request_fingerprint, new.report_request_id,
    0, 1, 'supabase_queue',
    coalesce(nullif(current_setting('app.settings.workflow_max_attempts', true), '')::integer, 4),
    new.created_at
  );
  return new;
end;
$$;

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
  v_event text;
  v_correlation_id uuid;
  v_queue_result jsonb;
begin
  select * into v_workflow from public.research_workflows where id = p_workflow_id for update;
  if v_workflow.id is null then raise exception using message = 'workflow_not_found', errcode = 'P0001'; end if;
  if p_command = 'pause' then
    if v_workflow.status not in ('queued', 'dispatch_pending', 'running', 'waiting_retry', 'paused') then raise exception using message = 'invalid_workflow_transition', errcode = 'P0001'; end if;
    if v_workflow.status = 'paused' then return true; end if;
    update public.research_workflows set status = 'paused', paused_at = p_now, updated_at = p_now where id = p_workflow_id;
    v_event := 'workflow_paused';
  elsif p_command = 'resume' then
    if v_workflow.status <> 'paused' then raise exception using message = 'invalid_workflow_transition', errcode = 'P0001'; end if;
    update public.research_workflows set status = 'dispatch_pending', paused_at = null, updated_at = p_now where id = p_workflow_id;
    v_event := 'workflow_resumed';
    v_correlation_id := gen_random_uuid();
    v_queue_result := public.enqueue_v3_workflow_message(
      jsonb_build_object(
        'workflowId', p_workflow_id, 'reportRequestId', v_workflow.report_request_id,
        'reportId', v_workflow.report_id, 'correlationId', v_correlation_id,
        'workflowVersion', v_workflow.workflow_version, 'requestedAt', p_now
      ),
      'launchclub.report.requested.v1:' || p_workflow_id::text || ':resume:' ||
        (select (count(*) + 1)::text from public.workflow_events where workflow_id = p_workflow_id and event_type = 'workflow_resumed'),
      p_now
    );
  elsif p_command = 'cancel' then
    if v_workflow.status not in ('queued', 'dispatch_pending', 'running', 'waiting_retry', 'paused', 'cancelled') then raise exception using message = 'invalid_workflow_transition', errcode = 'P0001'; end if;
    if v_workflow.status = 'cancelled' then return true; end if;
    update public.research_workflows set status = 'cancelled', cancelled_at = p_now, updated_at = p_now where id = p_workflow_id;
    update public.research_steps set status = 'cancelled', updated_at = p_now where workflow_id = p_workflow_id and status <> 'succeeded';
    v_event := 'workflow_cancelled';
  elsif p_command in ('retry', 'retry_step') then
    select * into v_step from public.research_steps where workflow_id = p_workflow_id
      and (p_command = 'retry' or step_key = p_step_key)
      and status in ('failed_terminal', 'retry_scheduled')
      order by created_at limit 1 for update;
    if v_step.id is null or v_step.attempt_count >= v_step.maximum_attempts or v_step.status = 'succeeded' then raise exception using message = 'invalid_workflow_retry', errcode = 'P0001'; end if;
    update public.research_steps set status = 'pending', scheduled_at = p_now, updated_at = p_now where id = v_step.id;
    update public.research_workflows set status = 'dispatch_pending', updated_at = p_now where id = p_workflow_id;
    v_event := 'administrator_retry_requested';
    v_correlation_id := gen_random_uuid();
    v_queue_result := public.enqueue_v3_workflow_message(
      jsonb_build_object(
        'workflowId', p_workflow_id, 'reportRequestId', v_workflow.report_request_id,
        'reportId', v_workflow.report_id, 'correlationId', v_correlation_id,
        'workflowVersion', v_workflow.workflow_version, 'requestedAt', p_now
      ),
      'launchclub.report.requested.v1:' || p_workflow_id::text || ':admin:' || v_step.id::text || ':' || v_step.attempt_count::text,
      p_now
    );
    update public.workflow_queue_dead_letters
    set retry_status = 'retried', retried_message_id = (v_queue_result ->> 'messageId')::bigint,
      retried_at = p_now
    where workflow_id = p_workflow_id and retry_status = 'pending';
  else
    raise exception using message = 'unknown_workflow_command', errcode = 'P0001';
  end if;

  insert into public.workflow_events (workflow_id, event_type, safe_metadata, correlation_id, actor_type, created_at)
  values (
    p_workflow_id, v_event,
    jsonb_build_object('actorId', left(p_actor_id, 120), 'step', v_step.step_key),
    coalesce(v_correlation_id, p_workflow_id), 'administrator', p_now
  );
  insert into public.audit_logs (entity_type, entity_id, event_type, actor_type, created_at, metadata)
  values ('research_workflow', p_workflow_id, v_event, 'admin', p_now, jsonb_build_object('actorId', left(p_actor_id, 120)));
  return true;
end;
$$;

revoke execute on function public.enqueue_v3_workflow_message(jsonb, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.read_v3_workflow_messages(integer, integer) from public, anon, authenticated;
revoke execute on function public.archive_v3_workflow_message(text) from public, anon, authenticated;
revoke execute on function public.release_v3_workflow_message(text, integer) from public, anon, authenticated;
revoke execute on function public.dead_letter_v3_workflow_message(text, uuid, text, integer, integer, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.consume_v3_workflow_wakeup_nonce(text, timestamptz, timestamptz) from public, anon, authenticated;

grant execute on function public.enqueue_v3_workflow_message(jsonb, text, timestamptz) to service_role;
grant execute on function public.read_v3_workflow_messages(integer, integer) to service_role;
grant execute on function public.archive_v3_workflow_message(text) to service_role;
grant execute on function public.release_v3_workflow_message(text, integer) to service_role;
grant execute on function public.dead_letter_v3_workflow_message(text, uuid, text, integer, integer, text, timestamptz) to service_role;
grant execute on function public.consume_v3_workflow_wakeup_nonce(text, timestamptz, timestamptz) to service_role;
