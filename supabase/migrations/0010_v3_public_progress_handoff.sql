-- Keep public progress aligned with the canonical PR4 search-intelligence handoff.
-- This migration changes no tables or data.

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
      when w.status = 'completed' then 'complete'
      when w.status in ('failed', 'cancelled') then 'failed'
      when s.query_status in ('leased', 'running') then 'preparing_research'
      when s.profile_status in ('leased', 'running') then 'preparing_research'
      when s.website_status in ('leased', 'running') then 'preparing_research'
      when w.status in ('queued', 'dispatch_pending') then 'queued'
      else 'preparing_research' end,
    'currentStep', case
      when w.status = 'ready_for_search_intelligence' then 'research_ready'
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
        'status', case
          when w.status in ('failed', 'cancelled') then 'failed'
          when w.status = 'completed' then 'complete'
          else 'running' end,
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

revoke execute on function public.get_public_workflow_progress(uuid)
  from public, anon, authenticated;
grant execute on function public.get_public_workflow_progress(uuid) to service_role;

comment on function public.get_public_workflow_progress(uuid) is
  'Returns privacy-safe report progress, including the PR4 search-intelligence handoff.';
