# Supabase Queue Deploy Preview Acceptance

Do not run this checklist against production.

## Before Preview

- Use an approved Netlify Deploy Preview connected to an isolated development Supabase project.
- Apply migrations `0001`, `0002`, `0003`, and `0004` only to that project.
- Confirm `v3_report_workflows` is a Basic logged queue and `pgmq_public` is not exposed.
- Configure preview-only `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REPORT_ACCESS_TOKEN_SECRET`, `REPORT_RATE_LIMIT_SALT`, `WORKFLOW_ADMIN_SECRET`, `WORKFLOW_WAKEUP_SECRET`, and `NEXT_PUBLIC_SITE_URL`.
- Keep `REPORT_USE_MEMORY_STORE=false` and `REPORT_USE_INLINE_WORKER=false`.
- Confirm no preview variable points to a production URL, project, key, or domain.
- Confirm no secret is present in a `NEXT_PUBLIC_*` variable or browser bundle.
- Do not publish the branch or activate a production schedule.

## Acceptance

1. Submit one V3 intake and confirm one workflow, five steps, one 400-cent budget, one active queue message, and one sent outbox ledger row commit together.
2. Force queue send failure in the isolated database and confirm the complete intake rolls back.
3. Repeat the same intake and confirm no duplicate workflow or actionable queue message.
4. Confirm the queue message contains only five identifiers plus `requestedAt` and is below 32 KB.
5. Use **Run now** on `wake-v3-report-workflows`; confirm it sends no queue contents.
6. Confirm the Background Function rejects missing, expired, invalid, and replayed HMAC wakeups.
7. Confirm one delivery runs only the next eligible foundation step.
8. Deliver the same message twice and confirm successful steps retain one attempt.
9. Simulate a crash after step success and before queue acknowledgement; confirm redelivery advances without rerunning that step.
10. Allow visibility timeout expiry and confirm the message becomes readable again with an incremented queue read count.
11. Force a transient failure and confirm only the failed step retries.
12. Exhaust retries and confirm a safe dead-letter record plus archived original message.
13. Force a permanent failure and confirm no automatic retry.
14. Use `npm run research:admin` to retry; confirm the transition, audit record, dead-letter retry state, and replacement queue message commit together.
15. Confirm pause performs no work, resume enqueues once, cancel prevents old messages from resuming, and lease conflicts do not create failures.
16. Trigger immediate and scheduled wakeups together; confirm leases and queue visibility prevent duplicate execution.
17. Confirm public progress contains only `Request received` and `Preparing research`, with no percentage or later stage.
18. Confirm grandfathered V2 links still load and new V3 records have no legacy identifier.
19. Confirm no provider endpoint and no email provider was called.
20. Confirm no production workflow, setting, secret, migration, schedule, function, or data was touched.

## Monitoring

- Inspect active queue depth, oldest visible message, message `read_ct`, workflow statuses, expired leases, and `workflow_queue_dead_letters`.
- Treat old visible messages, repeated reads without step progress, or growing dead letters as acceptance failures.
- Keep logs free of headers, HMAC values, service-role credentials, raw provider errors, and queue payloads.

## Cleanup

1. Stop preview submissions.
2. Archive or explicitly account for every remaining preview queue message.
3. Capture the acceptance evidence without secrets.
4. Delete the Deploy Preview.
5. Revoke preview-only secrets.
6. Delete the isolated Supabase project.

## Decision Gate

PR4 may begin only after every item passes and production activation receives a separate explicit approval. Do not deploy the queue migration, Background Function, or schedule to production during preview acceptance.
