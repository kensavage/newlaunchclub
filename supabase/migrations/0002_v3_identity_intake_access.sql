create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  canonical_domain text not null unique,
  canonical_website_url text not null,
  display_name text,
  client_status text not null default 'prospect'
    check (client_status in ('prospect', 'client', 'former_client')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (canonical_domain = lower(canonical_domain))
);

create table if not exists public.company_contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  normalized_email text not null,
  email_domain text not null,
  contact_status text not null default 'active'
    check (contact_status in ('active', 'unsubscribed', 'invalid', 'blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_contacts_company_email_key unique (company_id, normalized_email),
  check (normalized_email = lower(normalized_email)),
  check (email_domain = lower(email_domain))
);

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  primary_contact_id uuid not null references public.company_contacts(id) on delete restrict,
  lifecycle_status text not null default 'report_requested'
    check (
      lifecycle_status in (
        'report_requested',
        'report_viewed',
        'call_booked',
        'call_completed',
        'sprint_purchased',
        'sprint_active',
        'accelerator',
        'closed_lost',
        'unsubscribed'
      )
    ),
  source text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leads_company_contact_key unique (company_id, primary_contact_id)
);

create table if not exists public.report_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  contact_id uuid not null references public.company_contacts(id) on delete restrict,
  lead_id uuid not null references public.leads(id) on delete restrict,
  request_status text not null default 'queued'
    check (request_status in ('queued', 'running', 'complete', 'failed', 'cancelled')),
  normalized_submitted_url text not null,
  submission_source text not null,
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  public_progress_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, contact_id, idempotency_key_hash)
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  report_request_id uuid not null unique references public.report_requests(id) on delete restrict,
  report_status text not null default 'queued'
    check (report_status in ('queued', 'running', 'complete', 'failed', 'cancelled')),
  current_revision_reference text,
  legacy_public_id text not null unique references public.report_jobs(public_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.report_access_tokens (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  token_status text not null default 'active'
    check (token_status in ('active', 'revoked', 'rotated', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_accessed_at timestamptz,
  check (expires_at > created_at)
);

create table if not exists public.report_access_events (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  access_token_id uuid references public.report_access_tokens(id) on delete set null,
  event_type text not null
    check (event_type in ('issued', 'accessed', 'denied', 'expired', 'revoked', 'rotated')),
  created_at timestamptz not null default now(),
  request_metadata jsonb not null default '{}'::jsonb,
  check (jsonb_typeof(request_metadata) = 'object')
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid,
  event_type text not null,
  actor_type text not null default 'system'
    check (actor_type in ('system', 'visitor', 'admin', 'provider')),
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  check (jsonb_typeof(metadata) = 'object')
);

create index if not exists company_contacts_email_created_idx
  on public.company_contacts (normalized_email, created_at desc);

create index if not exists report_requests_company_status_created_idx
  on public.report_requests (company_id, request_status, created_at desc);

create index if not exists report_requests_contact_status_created_idx
  on public.report_requests (contact_id, request_status, created_at desc);

create index if not exists report_requests_fingerprint_created_idx
  on public.report_requests (request_fingerprint, created_at desc);

create index if not exists reports_company_status_created_idx
  on public.reports (company_id, report_status, created_at desc);

create index if not exists report_access_tokens_report_status_idx
  on public.report_access_tokens (report_id, token_status, expires_at desc);

create unique index if not exists report_access_tokens_one_active_idx
  on public.report_access_tokens (report_id)
  where token_status = 'active';

create index if not exists report_access_events_report_created_idx
  on public.report_access_events (report_id, created_at desc);

create index if not exists audit_logs_entity_created_idx
  on public.audit_logs (entity_type, entity_id, created_at desc);

create index if not exists audit_logs_request_signal_created_idx
  on public.audit_logs ((metadata ->> 'requestSignalHash'), created_at desc)
  where event_type in ('report_intake_created', 'report_intake_reused');

create index if not exists audit_logs_access_signal_created_idx
  on public.audit_logs ((metadata ->> 'requestSignalHash'), created_at desc)
  where event_type = 'report_access_denied';

alter table public.companies enable row level security;
alter table public.company_contacts enable row level security;
alter table public.leads enable row level security;
alter table public.report_requests enable row level security;
alter table public.reports enable row level security;
alter table public.report_access_tokens enable row level security;
alter table public.report_access_events enable row level security;
alter table public.audit_logs enable row level security;

revoke all privileges on table public.companies from anon, authenticated;
revoke all privileges on table public.company_contacts from anon, authenticated;
revoke all privileges on table public.leads from anon, authenticated;
revoke all privileges on table public.report_requests from anon, authenticated;
revoke all privileges on table public.reports from anon, authenticated;
revoke all privileges on table public.report_access_tokens from anon, authenticated;
revoke all privileges on table public.report_access_events from anon, authenticated;
revoke all privileges on table public.audit_logs from anon, authenticated;

create or replace function public.create_report_intake(
  p_canonical_domain text,
  p_canonical_website_url text,
  p_normalized_submitted_url text,
  p_normalized_email text,
  p_email_domain text,
  p_submission_source text,
  p_idempotency_key_hash text,
  p_request_fingerprint text,
  p_public_progress_id text,
  p_legacy_public_id text,
  p_access_token_hash text,
  p_access_expires_at timestamptz,
  p_legacy_job_expires_at timestamptz,
  p_visitor_hash text,
  p_initial_steps jsonb,
  p_pair_cooldown_since timestamptz,
  p_domain_cooldown_since timestamptz,
  p_contact_cooldown_since timestamptz,
  p_max_active_per_company integer,
  p_max_active_per_contact integer,
  p_rate_limit_since timestamptz,
  p_max_requests_per_signal integer,
  p_request_metadata jsonb
)
returns table (
  company_id uuid,
  contact_id uuid,
  lead_id uuid,
  report_request_id uuid,
  report_id uuid,
  access_token_id uuid,
  public_progress_id text,
  legacy_public_id text,
  request_status text,
  request_created_at timestamptz,
  reused boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_contact_id uuid;
  v_lead_id uuid;
  v_request_id uuid;
  v_report_id uuid;
  v_token_id uuid;
  v_progress_id text;
  v_legacy_public_id text;
  v_request_status text;
  v_request_created_at timestamptz;
  v_reused boolean := false;
  v_now timestamptz := pg_catalog.now();
begin
  if coalesce(p_request_metadata ->> 'requestSignalHash', '') !~ '^[a-f0-9]{64}$'
    or p_max_requests_per_signal < 1 then
    raise exception using message = 'report_intake_invalid_metadata', errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'launchclub-request-signal:' || (p_request_metadata ->> 'requestSignalHash'),
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('launchclub-domain:' || p_canonical_domain, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('launchclub-contact:' || p_normalized_email, 0)
  );

  if (
    select pg_catalog.count(*)
    from public.audit_logs as al
    where al.event_type in ('report_intake_created', 'report_intake_reused')
      and al.created_at >= p_rate_limit_since
      and (al.metadata ->> 'requestSignalHash') = (p_request_metadata ->> 'requestSignalHash')
  ) >= p_max_requests_per_signal then
    raise exception using message = 'report_intake_rate_limited', errcode = 'P0001';
  end if;

  insert into public.companies (
    canonical_domain,
    canonical_website_url,
    client_status,
    created_at,
    updated_at
  )
  values (p_canonical_domain, p_canonical_website_url, 'prospect', v_now, v_now)
  on conflict (canonical_domain) do update
    set canonical_website_url = excluded.canonical_website_url,
        updated_at = excluded.updated_at
  returning id into v_company_id;

  insert into public.company_contacts (
    company_id,
    normalized_email,
    email_domain,
    contact_status,
    created_at,
    updated_at
  )
  values (v_company_id, p_normalized_email, p_email_domain, 'active', v_now, v_now)
  on conflict on constraint company_contacts_company_email_key do update
    set email_domain = excluded.email_domain,
        updated_at = excluded.updated_at
  returning id into v_contact_id;

  insert into public.leads (
    company_id,
    primary_contact_id,
    lifecycle_status,
    source,
    created_at,
    updated_at
  )
  values (v_company_id, v_contact_id, 'report_requested', p_submission_source, v_now, v_now)
  on conflict on constraint leads_company_contact_key do update
    set updated_at = excluded.updated_at
  returning id into v_lead_id;

  update public.report_requests as rr
  set request_status = rj.status,
      updated_at = rj.updated_at
  from public.reports as r
  join public.report_jobs as rj on rj.public_id = r.legacy_public_id
  where r.report_request_id = rr.id
    and (
      rr.company_id = v_company_id
      or exists (
        select 1
        from public.company_contacts as related_contact
        where related_contact.id = rr.contact_id
          and related_contact.normalized_email = p_normalized_email
      )
    )
    and rr.request_status is distinct from rj.status;

  update public.reports as r
  set report_status = rj.status,
      updated_at = rj.updated_at,
      completed_at = case when rj.status = 'complete' then rj.updated_at else null end
  from public.report_jobs as rj
  where rj.public_id = r.legacy_public_id
    and r.company_id = v_company_id
    and r.report_status is distinct from rj.status;

  select rr.id, r.id, rr.public_progress_id, r.legacy_public_id, rr.request_status, rr.created_at
  into v_request_id, v_report_id, v_progress_id, v_legacy_public_id, v_request_status, v_request_created_at
  from public.report_requests as rr
  join public.reports as r on r.report_request_id = rr.id
  where rr.company_id = v_company_id
    and rr.contact_id = v_contact_id
    and rr.idempotency_key_hash = p_idempotency_key_hash
  order by rr.created_at desc
  limit 1;

  if v_request_id is null then
    select rr.id, r.id, rr.public_progress_id, r.legacy_public_id, rr.request_status, rr.created_at
    into v_request_id, v_report_id, v_progress_id, v_legacy_public_id, v_request_status, v_request_created_at
    from public.report_requests as rr
    join public.reports as r on r.report_request_id = rr.id
    where rr.company_id = v_company_id
      and rr.contact_id = v_contact_id
      and (
        rr.request_status in ('queued', 'running')
        or (rr.request_status = 'complete' and rr.created_at >= p_pair_cooldown_since)
      )
    order by rr.created_at desc
    limit 1;
  end if;

  if v_request_id is not null then
    v_reused := true;
  else
    if exists (
      select 1
      from public.report_requests as rr
      where rr.company_id = v_company_id
        and rr.contact_id <> v_contact_id
        and rr.request_status in ('queued', 'running', 'complete')
        and rr.created_at >= p_domain_cooldown_since
    ) or exists (
      select 1
      from public.report_requests as rr
      join public.company_contacts as cc on cc.id = rr.contact_id
      where cc.normalized_email = p_normalized_email
        and rr.company_id <> v_company_id
        and rr.request_status in ('queued', 'running', 'complete')
        and rr.created_at >= p_contact_cooldown_since
    ) then
      raise exception using message = 'report_intake_capacity', errcode = 'P0001';
    end if;

    if (
      select pg_catalog.count(*)
      from public.report_requests as rr
      where rr.company_id = v_company_id
        and rr.request_status in ('queued', 'running')
    ) >= p_max_active_per_company or (
      select pg_catalog.count(*)
      from public.report_requests as rr
      where rr.contact_id = v_contact_id
        and rr.request_status in ('queued', 'running')
    ) >= p_max_active_per_contact then
      raise exception using message = 'report_intake_capacity', errcode = 'P0001';
    end if;

    insert into public.report_jobs (
      public_id,
      submitted_url,
      normalized_url,
      domain,
      status,
      current_step,
      progress,
      steps,
      error_summary,
      visitor_hash,
      created_at,
      updated_at,
      expires_at
    )
    values (
      p_legacy_public_id,
      p_normalized_submitted_url,
      p_normalized_submitted_url,
      p_canonical_domain,
      'queued',
      'queued',
      5,
      p_initial_steps,
      null,
      p_visitor_hash,
      v_now,
      v_now,
      p_legacy_job_expires_at
    );

    insert into public.report_requests as inserted_request (
      company_id,
      contact_id,
      lead_id,
      request_status,
      normalized_submitted_url,
      submission_source,
      idempotency_key_hash,
      request_fingerprint,
      public_progress_id,
      created_at,
      updated_at
    )
    values (
      v_company_id,
      v_contact_id,
      v_lead_id,
      'queued',
      p_normalized_submitted_url,
      p_submission_source,
      p_idempotency_key_hash,
      p_request_fingerprint,
      p_public_progress_id,
      v_now,
      v_now
    )
    returning
      inserted_request.id,
      inserted_request.public_progress_id,
      inserted_request.request_status,
      inserted_request.created_at
    into v_request_id, v_progress_id, v_request_status, v_request_created_at;

    insert into public.reports as inserted_report (
      company_id,
      report_request_id,
      report_status,
      current_revision_reference,
      legacy_public_id,
      created_at,
      updated_at
    )
    values (
      v_company_id,
      v_request_id,
      'queued',
      null,
      p_legacy_public_id,
      v_now,
      v_now
    )
    returning inserted_report.id, inserted_report.legacy_public_id
    into v_report_id, v_legacy_public_id;
  end if;

  select rat.id
  into v_token_id
  from public.report_access_tokens as rat
  where rat.report_id = v_report_id
    and rat.token_hash = p_access_token_hash
    and rat.token_status = 'active'
    and rat.revoked_at is null
    and rat.expires_at > v_now
  limit 1;

  if v_token_id is null then
    if exists (
      select 1
      from public.report_access_tokens as rat
      where rat.report_id = v_report_id
        and rat.token_hash = p_access_token_hash
    ) then
      raise exception using message = 'report_access_reissue_required', errcode = 'P0001';
    end if;

    insert into public.report_access_events (
      report_id,
      access_token_id,
      event_type,
      created_at,
      request_metadata
    )
    select rat.report_id, rat.id, 'rotated', v_now, coalesce(p_request_metadata, '{}'::jsonb)
    from public.report_access_tokens as rat
    where rat.report_id = v_report_id
      and rat.token_status = 'active';

    update public.report_access_tokens as rat
    set token_status = 'rotated',
        revoked_at = v_now
    where rat.report_id = v_report_id
      and rat.token_status = 'active';
    insert into public.report_access_tokens (
      report_id,
      token_hash,
      token_status,
      created_at,
      expires_at,
      revoked_at,
      last_accessed_at
    )
    values (v_report_id, p_access_token_hash, 'active', v_now, p_access_expires_at, null, null)
    returning id into v_token_id;

    insert into public.report_access_events (
      report_id,
      access_token_id,
      event_type,
      created_at,
      request_metadata
    )
    values (
      v_report_id,
      v_token_id,
      'issued',
      v_now,
      coalesce(p_request_metadata, '{}'::jsonb)
    );
  end if;

  insert into public.audit_logs (
    entity_type,
    entity_id,
    event_type,
    actor_type,
    created_at,
    metadata
  )
  values (
    'report_request',
    v_request_id,
    case when v_reused then 'report_intake_reused' else 'report_intake_created' end,
    'visitor',
    v_now,
    pg_catalog.jsonb_build_object(
      'requestFingerprint', p_request_fingerprint,
      'submissionSource', p_submission_source
    ) || coalesce(p_request_metadata, '{}'::jsonb)
  );

  return query
  select
    v_company_id,
    v_contact_id,
    v_lead_id,
    v_request_id,
    v_report_id,
    v_token_id,
    v_progress_id,
    v_legacy_public_id,
    v_request_status,
    v_request_created_at,
    v_reused;
end;
$$;

create or replace function public.resolve_report_access(
  p_token_hash text,
  p_request_metadata jsonb,
  p_now timestamptz default now()
)
returns table (
  report_id uuid,
  report_request_id uuid,
  access_token_id uuid,
  stored_token_hash text,
  token_status text,
  expires_at timestamptz,
  public_progress_id text,
  display_domain text,
  legacy_public_id text,
  request_status text,
  request_created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token public.report_access_tokens%rowtype;
  v_report public.reports%rowtype;
  v_request public.report_requests%rowtype;
  v_company public.companies%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'launchclub-access-signal:' || coalesce(p_request_metadata ->> 'requestSignalHash', ''),
      0
    )
  );

  select * into v_token
  from public.report_access_tokens
  where token_hash = p_token_hash
  limit 1;

  if v_token.id is null then
    insert into public.audit_logs (entity_type, entity_id, event_type, actor_type, created_at, metadata)
    select
      'report_access',
      null::uuid,
      'report_access_denied',
      'visitor',
      p_now,
      coalesce(p_request_metadata, '{}'::jsonb)
    where not exists (
      select 1
      from public.audit_logs as al
      where al.event_type = 'report_access_denied'
        and al.created_at >= p_now - interval '1 minute'
        and coalesce(al.metadata ->> 'requestSignalHash', '') =
          coalesce(p_request_metadata ->> 'requestSignalHash', '')
    );
    return;
  end if;

  if v_token.token_status <> 'active' or v_token.revoked_at is not null then
    insert into public.audit_logs (entity_type, entity_id, event_type, actor_type, created_at, metadata)
    select
      'report',
      v_token.report_id,
      'report_access_denied',
      'visitor',
      p_now,
      coalesce(p_request_metadata, '{}'::jsonb)
    where not exists (
      select 1
      from public.audit_logs as al
      where al.event_type = 'report_access_denied'
        and al.created_at >= p_now - interval '1 minute'
        and coalesce(al.metadata ->> 'requestSignalHash', '') =
          coalesce(p_request_metadata ->> 'requestSignalHash', '')
    );
    return;
  end if;

  if v_token.expires_at <= p_now then
    update public.report_access_tokens
    set token_status = 'expired', revoked_at = p_now
    where id = v_token.id;

    insert into public.report_access_events (
      report_id,
      access_token_id,
      event_type,
      created_at,
      request_metadata
    )
    values (
      v_token.report_id,
      v_token.id,
      'expired',
      p_now,
      coalesce(p_request_metadata, '{}'::jsonb)
    );
    return;
  end if;

  select * into v_report from public.reports where id = v_token.report_id;
  select * into v_request from public.report_requests where id = v_report.report_request_id;
  select * into v_company from public.companies where id = v_report.company_id;

  update public.report_requests as rr
  set request_status = rj.status,
      updated_at = rj.updated_at
  from public.report_jobs as rj
  where rr.id = v_request.id
    and rj.public_id = v_report.legacy_public_id;

  update public.reports as r
  set report_status = rj.status,
      updated_at = rj.updated_at,
      completed_at = case when rj.status = 'complete' then rj.updated_at else null end
  from public.report_jobs as rj
  where r.id = v_report.id
    and rj.public_id = v_report.legacy_public_id;

  if v_token.last_accessed_at is null or p_now - v_token.last_accessed_at >= interval '1 minute' then
    insert into public.report_access_events (
      report_id,
      access_token_id,
      event_type,
      created_at,
      request_metadata
    )
    values (
      v_report.id,
      v_token.id,
      'accessed',
      p_now,
      coalesce(p_request_metadata, '{}'::jsonb)
    );
  end if;

  update public.report_access_tokens set last_accessed_at = p_now where id = v_token.id;
  select rr.* into v_request
  from public.report_requests as rr
  where rr.id = v_request.id;

  return query
  select
    v_report.id,
    v_request.id,
    v_token.id,
    v_token.token_hash,
    'active'::text,
    v_token.expires_at,
    v_request.public_progress_id,
    v_company.canonical_domain,
    v_report.legacy_public_id,
    v_request.request_status,
    v_request.created_at;
end;
$$;

create or replace function public.is_protected_report_legacy_id(
  p_legacy_public_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists(
    select 1
    from public.reports
    where legacy_public_id = p_legacy_public_id
  );
$$;

create or replace function public.rotate_report_access(
  p_report_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_request_metadata jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token_id uuid;
  v_now timestamptz := pg_catalog.now();
begin
  if not exists (select 1 from public.reports where id = p_report_id) then
    raise exception using message = 'report_not_found', errcode = 'P0001';
  end if;

  insert into public.report_access_events (
    report_id,
    access_token_id,
    event_type,
    created_at,
    request_metadata
  )
  select report_id, id, 'rotated', v_now, coalesce(p_request_metadata, '{}'::jsonb)
  from public.report_access_tokens
  where report_id = p_report_id and token_status = 'active';

  update public.report_access_tokens
  set token_status = 'rotated', revoked_at = v_now
  where report_id = p_report_id and token_status = 'active';

  insert into public.report_access_tokens (
    report_id,
    token_hash,
    token_status,
    created_at,
    expires_at
  )
  values (p_report_id, p_token_hash, 'active', v_now, p_expires_at)
  returning id into v_token_id;

  insert into public.report_access_events (
    report_id,
    access_token_id,
    event_type,
    created_at,
    request_metadata
  )
  values (
    p_report_id,
    v_token_id,
    'issued',
    v_now,
    coalesce(p_request_metadata, '{}'::jsonb)
  );

  insert into public.audit_logs (entity_type, entity_id, event_type, actor_type, created_at, metadata)
  values ('report', p_report_id, 'report_access_rotated', 'system', v_now, '{}'::jsonb);

  return v_token_id;
end;
$$;

create or replace function public.revoke_report_access(
  p_report_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
begin
  insert into public.report_access_events (
    report_id,
    access_token_id,
    event_type,
    created_at,
    request_metadata
  )
  select report_id, id, 'revoked', v_now, '{}'::jsonb
  from public.report_access_tokens
  where report_id = p_report_id and token_status = 'active';

  update public.report_access_tokens
  set token_status = 'revoked', revoked_at = v_now
  where report_id = p_report_id and token_status = 'active';

  insert into public.audit_logs (entity_type, entity_id, event_type, actor_type, created_at, metadata)
  values (
    'report',
    p_report_id,
    'report_access_revoked',
    'system',
    v_now,
    pg_catalog.jsonb_build_object('reason', pg_catalog.left(p_reason, 120))
  );
end;
$$;

revoke execute on function public.create_report_intake(
  text, text, text, text, text, text, text, text, text, text, text, timestamptz,
  timestamptz, text, jsonb, timestamptz, timestamptz, timestamptz, integer, integer,
  timestamptz, integer, jsonb
) from public, anon, authenticated;

revoke execute on function public.resolve_report_access(text, jsonb, timestamptz)
  from public, anon, authenticated;

revoke execute on function public.rotate_report_access(uuid, text, timestamptz, jsonb)
  from public, anon, authenticated;

revoke execute on function public.revoke_report_access(uuid, text)
  from public, anon, authenticated;

revoke execute on function public.is_protected_report_legacy_id(text)
  from public, anon, authenticated;

grant execute on function public.create_report_intake(
  text, text, text, text, text, text, text, text, text, text, text, timestamptz,
  timestamptz, text, jsonb, timestamptz, timestamptz, timestamptz, integer, integer,
  timestamptz, integer, jsonb
) to service_role;

grant execute on function public.resolve_report_access(text, jsonb, timestamptz)
  to service_role;

grant execute on function public.rotate_report_access(uuid, text, timestamptz, jsonb)
  to service_role;

grant execute on function public.revoke_report_access(uuid, text)
  to service_role;

grant execute on function public.is_protected_report_legacy_id(text)
  to service_role;
