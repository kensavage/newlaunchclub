# Supabase Queue Deploy Preview Acceptance

Do not run this checklist against production.

## Before Preview

- Use an approved Netlify Deploy Preview connected to an isolated development Supabase project.
- Apply migrations `0001` through `0007` only to that project when validating PR4. Migrations `0006` and `0007` must not be applied to production during preview acceptance.
- Confirm `v3_report_workflows` is a Basic logged queue and `pgmq_public` is not exposed.
- Configure preview-only `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REPORT_ACCESS_TOKEN_SECRET`, `REPORT_RATE_LIMIT_SALT`, `WORKFLOW_ADMIN_SECRET`, `WORKFLOW_WAKEUP_SECRET`, and `NEXT_PUBLIC_SITE_URL`.
- Set `NEXT_PUBLIC_SITE_URL` to the exact Deploy Preview origin. The scheduled function prefers valid `DEPLOY_PRIME_URL` metadata when present and otherwise uses this validated, context-specific fallback.
- Do not gate Functions runtime behavior on `NETLIFY`; it is build metadata and is not an automatic Functions runtime variable. Use the validated Deploy Preview origin above for the intake wakeup fallback.
- Keep `REPORT_USE_MEMORY_STORE=false` and `REPORT_USE_INLINE_WORKER=false`.
- Confirm no preview variable points to a production URL, project, key, or domain.
- Confirm no secret is present in a `NEXT_PUBLIC_*` variable or browser bundle.
- Do not publish the branch or activate a production schedule.

## Acceptance

1. Submit one V3 intake and confirm one workflow, five steps, one 400-cent budget, one active queue message, and one sent outbox ledger row commit together.
2. Force queue send failure in the isolated database and confirm the complete intake rolls back.
3. Repeat the same intake and confirm no duplicate workflow or actionable queue message.
4. Confirm the queue message contains only five identifiers plus `requestedAt` and is below 32 KB.
5. Without running the scheduled function, confirm intake logs a privacy-safe immediate-wakeup attempt to the exact Deploy Preview Background Function URL, the receiver logs accepted HMAC authentication, and at least one eligible step advances within 60 seconds. Treat the dispatch `202` and receiver acceptance as separate evidence.
6. Use **Run now** on `wake-v3-report-workflows` in a separate fallback test; confirm it sends an empty signed POST to `/.netlify/functions/v3-report-workflow-background` on the same Deploy Preview and sends no queue contents.
7. Confirm the Background Function rejects missing, expired, invalid, and replayed HMAC wakeups and that no active code calls `/api/internal/v3-workflow-wakeup`.
8. Confirm one delivery runs only the next eligible foundation step.
9. Deliver the same message twice and confirm successful steps retain one attempt.
10. Simulate a crash after step success and before queue acknowledgement; confirm redelivery advances without rerunning that step.
11. Allow visibility timeout expiry and confirm the message becomes readable again with an incremented queue read count.
12. Force a transient failure and confirm only the failed step retries.
13. Exhaust retries and confirm a safe dead-letter record plus archived original message.
14. Force a permanent failure and confirm no automatic retry.
15. Use `npm run research:admin` to retry; confirm the transition, audit record, dead-letter retry state, and replacement queue message commit together.
16. Confirm pause performs no work, resume enqueues once, cancel prevents old messages from resuming, and lease conflicts do not create failures.
17. Trigger immediate and scheduled wakeups together; confirm leases and queue visibility prevent duplicate execution.
18. Confirm public progress contains only `Request received` and `Preparing research`, with no percentage or later stage.
19. Confirm grandfathered V2 links still load and new V3 records have no legacy identifier.
20. Confirm no provider endpoint and no email provider was called.
21. Confirm no production workflow, setting, secret, migration, schedule, function, or data was touched.

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

## PR4 Provider Gate

Keep `V3_PROVIDER_RESEARCH_ENABLED=true` and `REPORT_USE_MOCK_PROVIDERS=true` for the first PR4 preview pass. Confirm one workflow reaches `ready_for_search_intelligence` with immutable page snapshots, auditable context selection, durable mock-response artifacts, evidence-backed profile claims, normalized queries, a null report, no email, no provider network calls, and a budget of 400 cents available, zero reserved, and zero spent. Exercise crash-after-capture, stored-response replay, duplicate delivery, and exact settlement before removing the fixture.

Live provider acceptance requires separate explicit approval. Before enabling it, confirm the configured OpenAI credential can retrieve `OPENAI_MODEL_FAST`; the application performs that same readiness request before Firecrawl. A definitive readiness rejection must pause the workflow with no provider operation, no reservation, and no Firecrawl request. For an accepted live run, audit provider identifiers, page and query caps, actual costs, released reservations, resolved transient errors, and the final `ready_for_search_intelligence` state. Never retry an uncertain provider outcome until `npm run research:admin -- reconcile-provider ...` records an administrator decision.

After an approved live gate, restore mock mode, rebuild the preview, remove test records and queue messages where allowed, and retain only privacy-safe acceptance evidence. Keep permanent development credentials active only when they remain restricted to Deploy Previews and Functions. Production configuration, data, functions, schedules, and migrations remain out of scope.
