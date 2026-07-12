# Async Workloads Deploy Preview Acceptance

Do not run this checklist against production.

## Before Preview

- Use an approved Netlify deploy preview connected to an isolated Supabase preview database.
- Apply migrations `0001`, `0002`, and `0003` only to the preview database.
- Enable Netlify Async Workloads only for the approved preview context.
- Configure `AWL_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REPORT_ACCESS_TOKEN_SECRET`, `REPORT_RATE_LIMIT_SALT`, and `WORKFLOW_ADMIN_SECRET` as server-only preview values.
- Confirm no secret is present in a `NEXT_PUBLIC_*` variable or browser bundle.
- Confirm memory workflow storage is disabled.

## Acceptance

1. Submit one V3 intake and confirm one workflow, five steps, one $4.00 budget, and one outbox event are committed.
2. Confirm the Netlify event contains identifiers only and remains below 32 KB.
3. Confirm Supabase remains canonical before, during, and after the workload.
4. Confirm all five foundation steps persist and the workflow stops at `ready_for_provider_research`.
5. Force one transient failure and confirm only that step retries.
6. Deliver the same event twice and confirm successful steps keep one successful attempt.
7. Interrupt dispatch after event acceptance but before outbox acknowledgement, then confirm a resend is harmless.
8. Expire a lease, recover it, and confirm the old fencing token cannot complete.
9. Exhaust retries and confirm Netlify dead-letter visibility and a safe workflow error.
10. Use `npm run research:admin` to inspect and retry the failed step; confirm administrator audit events.
11. Confirm public progress contains no provider error, stack, attempt, lease, cost, email, token, or internal ID.
12. Confirm grandfathered V2 links still load and new V3 records have no legacy identifier.
13. Confirm no provider endpoint and no email provider was called.
14. Confirm no production workflow, setting, secret, migration, or data was touched.

## Decision Gate

Approve Netlify Async Workloads for PR4 only after every item passes. If it fails, document the exact failure and make a separate explicit decision before implementing the Supabase Queues fallback. Do not run both systems simultaneously.

## Launch Hardening Note

The current `@netlify/async-workloads` package is required to compile against the official adapter API, but its published dependency tree introduces additional audit findings. Recheck the package and transitive advisories before launch; do not apply an automated breaking audit fix during preview acceptance.
