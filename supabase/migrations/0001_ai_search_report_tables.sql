create extension if not exists pgcrypto;

create table if not exists public.report_jobs (
  public_id text primary key,
  submitted_url text not null,
  normalized_url text not null,
  domain text not null,
  status text not null check (status in ('queued', 'running', 'complete', 'failed')),
  current_step text not null check (
    current_step in (
      'queued',
      'crawl',
      'analysis',
      'keywords',
      'reddit',
      'ai-search',
      'synthesis',
      'complete',
      'failed'
    )
  ),
  progress integer not null default 0 check (progress >= 0 and progress <= 100),
  steps jsonb not null default '[]'::jsonb,
  error_summary text,
  visitor_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists public.report_results (
  public_id text primary key references public.report_jobs(public_id) on delete cascade,
  report_json jsonb not null,
  evidence_summary jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.vendor_events (
  id bigserial primary key,
  public_id text not null references public.report_jobs(public_id) on delete cascade,
  provider text not null,
  endpoint text not null,
  purpose text not null,
  status text not null check (status in ('success', 'error', 'skipped')),
  duration_ms integer not null default 0 check (duration_ms >= 0),
  error_summary text,
  estimated_cost numeric(12, 6),
  created_at timestamptz not null default now()
);

create index if not exists report_jobs_domain_status_created_idx
  on public.report_jobs (domain, status, created_at desc);

create index if not exists report_jobs_visitor_created_idx
  on public.report_jobs (visitor_hash, created_at desc);

create index if not exists report_jobs_expires_at_idx
  on public.report_jobs (expires_at);

create index if not exists vendor_events_public_id_created_idx
  on public.vendor_events (public_id, created_at desc);

create index if not exists vendor_events_provider_status_idx
  on public.vendor_events (provider, status, created_at desc);

alter table public.report_jobs enable row level security;
alter table public.report_results enable row level security;
alter table public.vendor_events enable row level security;
