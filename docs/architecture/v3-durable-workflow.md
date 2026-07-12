# V3 Durable Workflow Foundation

## Scope

PR3 adds durable, resumable orchestration and stops at `ready_for_provider_research`. It does not call Firecrawl, Ahrefs, OpenAI, Reddit, YouTube, or any paid research provider. It does not generate or complete an opportunity report and does not send email.

## Canonical State

Supabase is canonical. A PR2 intake inserts the V3 report in the existing transaction. Database triggers remove the just-created compatibility worker row, set the new report's `legacy_public_id` to `null`, and create exactly one initial workflow, five stable steps, the $4.00 budget, history events, and the dispatch outbox row before the transaction commits.

The initial steps are:

1. `initialize_workflow`
2. `validate_intake_references`
3. `establish_cost_budget`
4. `prepare_provider_research`
5. `mark_ready_for_provider_research`

The successful PR3 state is `ready_for_provider_research`, not `completed`.

## Delivery And Idempotency

Netlify Async Workloads is the primary production adapter. Events contain only workflow, request, report, correlation, and version identifiers. The application enforces a 32 KB limit, comfortably below the platform limit.

Delivery is at least once. The outbox claim uses `FOR UPDATE SKIP LOCKED`, a lease owner, and a retry time. A crash after Netlify accepts an event but before the outbox acknowledgement can cause another send. That is expected: stable database step keys and `step.run` IDs prevent successful steps from repeating.

Supabase Queues is not implemented. It remains a possible alternative only if the preview acceptance test fails and a separate decision approves it.

## Leases And Retries

Step acquisition is transactional. Every lease has an owner, expiry, heartbeat, and monotonically increasing fencing token. Completion requires the current owner and fencing token before expiry. A stale owner cannot commit after recovery.

Failures are classified as `transient`, `permanent`, `budget_blocked`, `cancelled`, `lease_conflict`, or `configuration_error`. Transient failures retry only the failed step with bounded exponential backoff and jitter. Successful steps are immutable within their current version.

## Cost Contract

Money is stored as integer cents. Initial reports receive a 400-cent limit and future weekly refreshes receive a 100-cent limit. Paid work must reserve its maximum cost transactionally, record actual cost idempotently, and release the unused reservation. PR3 makes no paid calls.

## Public Progress

The public API maps internal state to `queued`, `preparing_research`, `research_ready`, `temporarily_delayed`, `partially_complete`, `complete`, or `failed`. It does not expose internal IDs, provider errors, stack traces, attempts, leases, administrator notes, or costs. PR3 progress says research is being prepared; it does not claim external research has run.

## Administrator Recovery

There is no authenticated administrator web UI in the repository, so PR3 adds the server-side CLI:

```bash
npm run research:admin -- list
npm run research:admin -- show WORKFLOW_ID
npm run research:admin -- retry WORKFLOW_ID
npm run research:admin -- retry-step WORKFLOW_ID STEP_KEY
npm run research:admin -- pause WORKFLOW_ID
npm run research:admin -- resume WORKFLOW_ID
npm run research:admin -- cancel WORKFLOW_ID
npm run research:admin -- release-expired-lease WORKFLOW_ID STEP_KEY
```

`WORKFLOW_ADMIN_SECRET` is required. State-changing commands validate transitions and write administrator history and audit records. Cancellation requires interactive confirmation unless `--yes` is deliberately supplied.

## Access Recovery And Retention

Recovery requires the original normalized work email and public progress ID. The public response is always `{ "accepted": true }`, whether or not a report matches. Recovery tokens are short lived, single use, and stored only as SHA-256 hashes. Successful consumption rotates active access tokens. Delivery is a server-only contract for the later Resend phase; no message is sent in PR3.

Defaults are 365 days for active access, 90 days for revoked or expired token hashes, 13 months for privacy-safe access events, 15 minutes for recovery tokens, and 90 days for recovery-token cleanup. Cleanup is implemented but not scheduled.

## V2 Compatibility

Grandfathered V2 18-character URLs remain available. Access is recorded with HMAC-derived link and request fingerprints. New V3 reports do not receive a V2 identifier. Compatibility may be retired only after all active links are migrated, usage remains zero for 30 consecutive days, and removal receives explicit approval.
