# V3 Durable Workflow Foundation

## Scope

PR3 adds durable, resumable orchestration and stops at `ready_for_provider_research`. It does not call Firecrawl, Ahrefs, OpenAI, Reddit, YouTube, or any paid research provider. It does not generate or complete an opportunity report and does not send email.

## Architecture Decision

Supabase is both the canonical workflow state store and the durable message system. The queue is a Basic logged `pgmq` queue named `v3_report_workflows`. A plain Netlify Background Function consumes messages, and a lightweight Netlify Scheduled Function wakes that consumer. Intake can also send a best-effort wakeup after commit. A failed or missing wakeup cannot lose work because the message is already durable in PostgreSQL.

This replaces Netlify Async Workloads. Its package pulled a legacy Netlify SDK and Stackbit dependency tree into the primary application, producing 14 high, 15 moderate, and three additional low production audit findings. Isolating that package in another Netlify project was rejected. The queue pivot removes that dependency and avoids a second orchestration system.

## Canonical Transaction

The PR2 intake transaction inserts the report request and report. Its report trigger creates exactly one initial workflow, five stable steps, the 400-cent budget, history events, and the `pgmq` message before the transaction commits. If `pgmq.send` fails, the complete intake transaction rolls back.

Messages contain only workflow ID, report request ID, report ID, correlation ID, workflow version, and requested timestamp. The schema rejects extra fields and enforces a 32 KB application limit. Queue tables remain in `pgmq`; `pgmq_public` is not created or exposed, and browser roles receive no queue access.

The initial steps are:

1. `initialize_workflow`
2. `validate_intake_references`
3. `establish_cost_budget`
4. `prepare_provider_research`
5. `mark_ready_for_provider_research`

The successful PR3 state is `ready_for_provider_research`, not `completed`.

`outbox_events` is retained for future external integrations. V3 queue rows are inserted directly in the same database transaction; sent outbox rows now provide only an idempotency key and queue-message audit link. No outbox dispatcher moves V3 work between systems.

## Delivery And Consumer

Delivery is at least once. The consumer reads a small batch with a visibility timeout and validates each message against canonical workflow state. It runs only the next eligible existing runner step, then either archives the message after terminal PR3 preparation or makes it visible for the next step. It stops before the Netlify execution limit and reserves cleanup time.

The standalone Netlify functions do not import Next.js boundary modules. Shared queue, consumer, Supabase-store, environment-schema, HMAC, and URL-construction code has runtime-neutral implementations. The existing Next.js entry modules remain protected by `server-only` and re-export only the neutral implementations needed by the application. The Netlify environment reader and durable-store factory live under `netlify/runtime` and are reachable only from the function entry points.

Duplicate delivery is harmless. Completed steps are checked in Supabase before execution. A crash after durable step success but before queue release or archive causes redelivery, but the completed step is not rerun. Simultaneous intake and scheduled wakeups are safe because `pgmq` visibility, workflow leases, stable step identities, and fencing tokens all apply.

Paused and cancelled workflows do no additional work. Old messages are archived; resume and administrator retry create new idempotent messages inside the same administrator transaction.

## Leases, Retries, And Dead Letters

Step acquisition is transactional. Every lease has an owner, expiry, heartbeat, and monotonically increasing fencing token. Completion requires the current owner and fencing token before expiry. A stale owner cannot commit after recovery, and a lease conflict does not count as a workflow failure.

Failures are classified as `transient`, `permanent`, `budget_blocked`, `cancelled`, `lease_conflict`, or `configuration_error`. Transient failures preserve the same queue message and defer its visibility until the step retry time. Existing step attempt limits decide when retry is exhausted.

Terminal failures are copied to `workflow_queue_dead_letters` and the original queue message is archived. The dead-letter record stores only message ID, workflow ID when valid, safe classification, queue read count, workflow attempt count, safe summary, failure time, and administrator retry status. It never stores provider responses, website content, tokens, email, or secrets. Administrator retry marks the dead letter retried and records the replacement message ID.

## Wakeup Security

The Background Function accepts only timestamped HMAC wakeups signed with `WORKFLOW_WAKEUP_SECRET` at `/.netlify/functions/v3-report-workflow-background`. Each request has a random nonce whose SHA-256 hash is consumed once in `workflow_wakeup_nonces`; a replay is rejected. Wakeups contain no queue or workflow payload. The wakeup secret is independent from `WORKFLOW_ADMIN_SECRET` and grants no administrator capability.

Wakeups prefer a valid `DEPLOY_PRIME_URL` when deploy metadata is available. Netlify exposes only `URL`, `SITE_NAME`, and `SITE_ID` as automatic read-only variables inside the current Functions runtime, so the function uses the deploy-context-specific `NEXT_PUBLIC_SITE_URL` as a validated fallback. Both inputs must be bare HTTPS origins; plain HTTP is accepted only for a loopback development origin. No production host is hardcoded, and the obsolete `/api/internal/v3-workflow-wakeup` route is not called.

The scheduled function only wakes the Background Function and performs no workflow step. Its five-minute source schedule is not active until the code is deliberately deployed. Netlify does not automatically run schedules in Deploy Previews; preview acceptance uses the Functions page **Run now** action.

## Cost Contract

Money is stored as integer cents. Initial reports receive a 400-cent limit and future weekly refreshes receive a 100-cent limit. Paid work must reserve its maximum cost transactionally, record actual cost idempotently, and release the unused reservation. PR3 makes no paid calls.

## Public Progress

PR3 displays only `Request received` and `Preparing research`, with no percentage. It does not expose internal states, IDs, provider errors, stack traces, attempts, queue reads, leases, administrator notes, or costs. Later research stages remain absent until PR4 performs real research.

## Administrator Recovery

The existing `npm run research:admin` CLI continues to support `list`, `show`, `retry`, `retry-step`, `pause`, `resume`, `cancel`, and `release-expired-lease`. `WORKFLOW_ADMIN_SECRET` is required. State transitions, audit logging, dead-letter retry state, and replacement queue insertion commit together. Cancellation still requires interactive confirmation unless `--yes` is supplied.

## Local Testing

Unit tests use `MemoryWorkflowQueue` and the existing memory workflow store. PostgreSQL migration tests run migrations `0001` through `0004` in disposable PGlite and provide a local implementation of the official `pgmq.send`, `read`, `set_vt`, and `archive` contracts. They verify atomic rollback, logged queue configuration, visibility redelivery, strict payloads, leases, fencing, dead letters, and administrator retry without connecting to hosted Supabase.

## Deploy Preview

Use a dedicated development Supabase project and a Netlify Deploy Preview with preview-only credentials. Apply migrations `0001`, `0002`, `0003`, and `0004` in order to that database. Confirm the queue is Basic/logged, `pgmq_public` is disabled, memory storage is false, and no production URL, key, data, domain, or function is referenced.

Invoke the scheduled wakeup manually with **Run now**. Verify one intake creates one workflow, five steps, one 400-cent budget, one active queue message, and a sent outbox ledger row. Complete duplicate, crash, transient, permanent, dead-letter, pause, resume, cancel, expired-lease, HMAC replay, progress, and V2 compatibility acceptance before PR4.

## Production Activation

Production activation requires a separate approval after preview acceptance. Before deployment, create and retain production-only `WORKFLOW_WAKEUP_SECRET` and `WORKFLOW_ADMIN_SECRET`, apply `0004`, verify queue grants, inspect the function bundle, verify queue monitoring, and explicitly approve the scheduled function deployment. Do not run the queue consumer and any former Async Workloads consumer simultaneously.

## Monitoring And Cleanup

Monitor active message age, `read_ct`, visibility timeouts, dead-letter count, workflow status, expired leases, and open safe workflow errors. Alert on messages older than the expected retry window or a growing dead-letter count.

For preview cleanup, stop submissions, inspect or archive remaining messages, delete the preview Netlify deploy, revoke preview secrets, and delete the isolated Supabase project. Production queue removal requires pausing intake, draining or dead-lettering active messages, disabling the schedule, retaining required audit history, calling the approved `pgmq` queue removal operation, and applying a separately reviewed cleanup migration.

## Access Recovery And Retention

Recovery requires the original normalized work email and public progress ID. The public response is always `{ "accepted": true }`, whether or not a report matches. Recovery tokens are short lived, single use, and stored only as SHA-256 hashes. Successful consumption rotates active access tokens. Delivery is a server-only contract for a later phase; no message is sent in PR3.

Defaults remain 365 days for active access, 90 days for revoked or expired token hashes, 13 months for privacy-safe access events, 15 minutes for recovery tokens, and 90 days for recovery-token cleanup. Cleanup is implemented but not scheduled.

## V2 Compatibility

Grandfathered V2 18-character URLs remain available. Access is recorded with HMAC-derived link and request fingerprints. New V3 reports do not receive a V2 identifier. Compatibility may be retired only after all active links are migrated, usage remains zero for 30 consecutive days, and removal receives explicit approval.
