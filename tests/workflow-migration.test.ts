// @vitest-environment node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "@/lib/research/integrity";
import {
  SYNTHETIC_RESEARCH_TIME,
  syntheticCompanyProfile,
  syntheticQueries
} from "./fixtures/provider-research";

describe("V3 isolated PostgreSQL migration stack", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec("create role anon; create role authenticated; create role service_role;");
    for (const name of [
      "0001_ai_search_report_tables.sql",
      "0002_v3_identity_intake_access.sql",
      "0003_v3_durable_workflow.sql",
      "0004_v3_supabase_queue.sql",
      "0005_v3_provider_research_evidence.sql"
    ]) {
      let sql = await readFile(path.join(process.cwd(), "supabase/migrations", name), "utf8");
      if (name.startsWith("0001")) sql = sql.replace("create extension if not exists pgcrypto;", "");
      if (name.startsWith("0004")) {
        await installPgmqStub(db);
        sql = sql.replace("create extension if not exists pgmq;", "");
      }
      await db.exec(sql);
    }
  }, 30_000);

  afterAll(async () => db.close());

  it("creates workflow, steps, budget, and a logged queue message atomically without a new legacy link", async () => {
    const result = await db.query<{ reused: boolean; legacy_public_id: string | null; report_request_id: string }>(intakeSql());
    expect(result.rows[0]).toMatchObject({ reused: false, legacy_public_id: null });
    const counts = await db.query<{ workflows: number; steps: number; outbox: number; queue_messages: number; legacy_jobs: number; budget_cents: number; backend: string; outbox_status: string }>(`
      select
        (select count(*)::integer from research_workflows) workflows,
        (select count(*)::integer from research_steps) steps,
        (select count(*)::integer from outbox_events) outbox,
        (select count(*)::integer from pgmq.q_v3_report_workflows) queue_messages,
        (select count(*)::integer from report_jobs) legacy_jobs,
        (select limit_cents from report_cost_budgets limit 1) budget_cents,
        (select orchestrator_backend from research_workflows limit 1) backend,
        (select status from outbox_events limit 1) outbox_status
    `);
    expect(counts.rows[0]).toEqual({ workflows: 1, steps: 5, outbox: 1, queue_messages: 1, legacy_jobs: 0, budget_cents: 400, backend: "supabase_queue", outbox_status: "sent" });

    const publicProgress = await db.query<{ progress: { currentStep: string; steps: Array<{ label: string; status: string }> } }>(`
      select get_public_workflow_progress('${result.rows[0]!.report_request_id}') progress
    `);
    expect(publicProgress.rows[0]?.progress).toMatchObject({
      currentStep: "crawl",
      steps: [
        { label: "Request received", status: "complete" },
        { label: "Preparing research", status: "running" }
      ]
    });
    expect(JSON.stringify(publicProgress.rows[0]?.progress)).not.toMatch(/94|ready_for_provider_research|research_ready/);

    const duplicate = await db.query<{ reused: boolean }>(intakeSql());
    expect(duplicate.rows[0]?.reused).toBe(true);
    expect((await db.query<{ count: number }>("select count(*)::integer count from research_workflows")).rows[0]?.count).toBe(1);
    expect((await db.query<{ count: number }>("select count(*)::integer count from pgmq.q_v3_report_workflows")).rows[0]?.count).toBe(1);
  });

  it("uses a Basic logged queue, strict payloads, and visibility-timeout redelivery", async () => {
    const queue = await db.query<{ persistence: string; unlogged: boolean }>(`
      select c.relpersistence persistence, m.is_unlogged unlogged
      from pg_class c cross join pgmq.meta m
      where c.relname = 'q_v3_report_workflows' and m.queue_name = 'v3_report_workflows'
    `);
    expect(queue.rows[0]).toEqual({ persistence: "p", unlogged: false });

    const first = await db.query<{ messages: Array<{ messageId: string; readCount: number }> }>("select read_v3_workflow_messages(1, 30) messages");
    expect(first.rows[0]?.messages[0]?.readCount).toBe(1);
    expect((await db.query<{ messages: unknown[] }>("select read_v3_workflow_messages(1, 30) messages")).rows[0]?.messages).toHaveLength(0);
    await db.query(`select release_v3_workflow_message('${first.rows[0]!.messages[0]!.messageId}', 0)`);
    const redelivery = await db.query<{ messages: Array<{ readCount: number }> }>("select read_v3_workflow_messages(1, 30) messages");
    expect(redelivery.rows[0]?.messages[0]?.readCount).toBe(2);

    const payload = (await db.query<{ payload: unknown }>("select payload from outbox_events limit 1")).rows[0]!.payload;
    await expect(db.query(`select enqueue_v3_workflow_message('${JSON.stringify({ ...(payload as object), email: "no@example.com" }).replaceAll("'", "''")}'::jsonb, 'invalid-extra', now())`)).rejects.toThrow(/workflow_queue_payload_invalid/);
  });

  it("rolls the entire intake transaction back when pgmq send fails", async () => {
    const before = (await db.query<{ requests: number; workflows: number }>("select (select count(*)::integer from report_requests) requests, (select count(*)::integer from research_workflows) workflows")).rows[0]!;
    await db.query("update pgmq.test_config set fail_send = true");
    await expect(db.query(intakeSql("failure.example", "f"))).rejects.toThrow(/pgmq_send_failed/);
    await db.query("update pgmq.test_config set fail_send = false");
    const after = (await db.query<{ requests: number; workflows: number }>("select (select count(*)::integer from report_requests) requests, (select count(*)::integer from research_workflows) workflows")).rows[0]!;
    expect(after).toEqual(before);
  });

  it("enqueues resume atomically with the audited administrator transition", async () => {
    await db.exec("begin");
    try {
      const workflowId = (await db.query<{ id: string }>("select id from research_workflows limit 1")).rows[0]!.id;
      const before = (await db.query<{ count: number }>("select count(*)::integer count from pgmq.q_v3_report_workflows")).rows[0]!.count;
      await db.query(`select admin_transition_research_workflow('${workflowId}', 'pause', null, 'test-admin', now())`);
      await db.query(`select admin_transition_research_workflow('${workflowId}', 'resume', null, 'test-admin', now())`);
      const state = await db.query<{ count: number; status: string; audit: number }>(`
        select
          (select count(*)::integer from pgmq.q_v3_report_workflows) count,
          (select status from research_workflows where id = '${workflowId}') status,
          (select count(*)::integer from audit_logs where entity_id = '${workflowId}' and event_type = 'workflow_resumed') audit
      `);
      expect(state.rows[0]).toEqual({ count: before + 1, status: "dispatch_pending", audit: 1 });
    } finally {
      await db.exec("rollback");
    }
  });

  it("enforces lease ownership, heartbeat, expiry recovery, and fencing in PostgreSQL", async () => {
    const workflowId = (await db.query<{ id: string }>("select id from research_workflows limit 1")).rows[0]!.id;
    const first = await db.query<{ payload: { disposition: string; lease: { fencingToken: number } } }>(`select begin_research_step('${workflowId}', 'initialize_workflow', 'lease-one', 30, '2030-01-01T00:00:00Z') payload`);
    expect(first.rows[0]?.payload.disposition).toBe("acquired");
    expect((await db.query<{ ok: boolean }>(`select heartbeat_research_lease('${workflowId}', 'initialize_workflow', 'lease-one', 1, 30, '2030-01-01T00:00:20Z') ok`)).rows[0]?.ok).toBe(true);
    const second = await db.query<{ payload: { lease: { fencingToken: number } } }>(`select begin_research_step('${workflowId}', 'initialize_workflow', 'lease-two', 30, '2030-01-01T00:00:51Z') payload`);
    expect(second.rows[0]?.payload.lease.fencingToken).toBe(2);
    expect((await db.query<{ ok: boolean }>(`select complete_research_step('${workflowId}', 'initialize_workflow', 'lease-one', 1, 'old', '2030-01-01T00:00:52Z') ok`)).rows[0]?.ok).toBe(false);
    expect((await db.query<{ ok: boolean }>(`select complete_research_step('${workflowId}', 'initialize_workflow', 'lease-two', 2, 'new', '2030-01-01T00:00:52Z') ok`)).rows[0]?.ok).toBe(true);
  });

  it("enforces exact-cent budget reservations and idempotent cost records", async () => {
    const workflowId = (await db.query<{ id: string }>("select id from research_workflows limit 1")).rows[0]!.id;
    const first = await db.query<{ entry: { id: string } }>(`select reserve_report_cost('${workflowId}', null, 175, 'sql-reserve-one', now()) entry`);
    const duplicate = await db.query<{ entry: { id: string } }>(`select reserve_report_cost('${workflowId}', null, 175, 'sql-reserve-one', now()) entry`);
    expect(duplicate.rows[0]?.entry.id).toBe(first.rows[0]?.entry.id);
    await expect(db.query(`select reserve_report_cost('${workflowId}', null, 226, 'sql-over-budget', now())`)).rejects.toThrow(/workflow_budget_exceeded/);
    await db.query(`select record_report_cost('${workflowId}', null, null, 175, 123, 'sql-actual-one', now())`);
    expect((await db.query<{ reserved: number; spent: number }>(`select reserved_cents reserved, spent_cents spent from report_cost_budgets where workflow_id='${workflowId}'`)).rows[0]).toEqual({ reserved: 0, spent: 123 });
  });

  it("records a dead letter and atomically enqueues administrator retry work", async () => {
    const workflowId = (await db.query<{ id: string }>("select id from research_workflows limit 1")).rows[0]!.id;
    const step = await db.query<{ payload: { lease: { fencingToken: number } } }>(`select begin_research_step('${workflowId}', 'validate_intake_references', 'failure-owner', 60, now()) payload`);
    await db.query(`select fail_research_step('${workflowId}', 'validate_intake_references', 'failure-owner', ${step.rows[0]!.payload.lease.fencingToken}, 'permanent', 'permanent', 'Safe failure.', null, now())`);
    const messageId = (await db.query<{ id: string }>("select msg_id::text id from pgmq.q_v3_report_workflows limit 1")).rows[0]!.id;
    await db.query(`select dead_letter_v3_workflow_message('${messageId}', '${workflowId}', 'permanent', 2, 1, 'Safe failure.', now())`);
    await db.query(`select admin_transition_research_workflow('${workflowId}', 'retry_step', 'validate_intake_references', 'test-admin', now())`);
    const state = await db.query<{ queued: number; retry_status: string; audit: number }>(`
      select
        (select count(*)::integer from pgmq.q_v3_report_workflows) queued,
        (select retry_status from workflow_queue_dead_letters where workflow_id = '${workflowId}') retry_status,
        (select count(*)::integer from audit_logs where entity_id = '${workflowId}' and event_type = 'administrator_retry_requested') audit
    `);
    expect(state.rows[0]).toEqual({ queued: 1, retry_status: "retried", audit: 1 });
  });

  it("creates the PR4 continuation atomically and denies browser roles access to research internals", async () => {
    await db.exec("begin");
    try {
      const context = await setupProviderWorkflow(db, "provider-security.example", "p");
      const duplicate = await db.query<{ prepared: boolean }>(`
        select prepare_v3_provider_research('${context.workflowId}', 160, 120, 80, 4, now()) prepared
      `);
      expect(duplicate.rows[0]?.prepared).toBe(false);

      const state = await db.query<{
        provider_steps: number;
        total_steps: number;
        status: string;
        queued: number;
        rls_tables: number;
        browser_grants: number;
      }>(`
        select
          (select count(*)::integer from research_steps where workflow_id = '${context.workflowId}'
            and step_key in ('website_research', 'company_profile_extraction', 'search_query_discovery')) provider_steps,
          (select count(*)::integer from research_steps where workflow_id = '${context.workflowId}') total_steps,
          (select status from research_workflows where id = '${context.workflowId}') status,
          (select count(*)::integer from pgmq.q_v3_report_workflows
            where message ->> 'workflowId' = '${context.workflowId}') queued,
          (select count(*)::integer from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname in (
              'provider_operations', 'provider_operation_attempts', 'source_documents',
              'research_artifacts', 'source_snapshots', 'model_invocations',
              'company_profile_versions', 'company_profile_claims',
              'company_profile_claim_evidence', 'company_profile_entities',
              'company_profile_entity_evidence', 'search_query_sets', 'search_queries',
              'search_query_claim_evidence'
            ) and c.relrowsecurity) rls_tables,
          (select count(*)::integer from information_schema.role_table_grants
            where grantee in ('anon', 'authenticated') and table_schema = 'public'
              and table_name in ('provider_operations', 'research_artifacts', 'source_snapshots',
                'model_invocations', 'company_profile_versions', 'search_queries')) browser_grants
      `);
      expect(state.rows[0]).toEqual({
        provider_steps: 3,
        total_steps: 8,
        status: "dispatch_pending",
        queued: 2,
        rls_tables: 14,
        browser_grants: 0
      });

      const progress = await db.query<{ progress: { currentStep: string; steps: Array<{ label: string; status: string }> } }>(`
        select get_public_workflow_progress('${context.reportRequestId}') progress
      `);
      expect(progress.rows[0]?.progress).toMatchObject({
        currentStep: "crawl",
        steps: [
          { label: "Request received", status: "complete" },
          { label: "Reviewing your website", status: "pending" },
          { label: "Building your company profile", status: "pending" },
          { label: "Preparing your market research", status: "pending" }
        ]
      });
      expect(JSON.stringify(progress.rows[0]?.progress)).not.toMatch(/Google|Reddit|AI visibility|competitor|opportunity|percent/i);

      await db.exec("savepoint browser_denial");
      await db.exec("set local role anon");
      await expect(db.query("select * from public.research_artifacts")).rejects.toThrow(/permission denied/i);
      await db.exec("rollback to savepoint browser_denial; release savepoint browser_denial; reset role");
    } finally {
      await db.exec("rollback");
    }
  });

  it("stores hash-verified page artifacts as immutable snapshots and appends a new crawl", async () => {
    await db.exec("begin");
    try {
      const context = await setupProviderWorkflow(db, "provider-evidence.example", "q");
      const first = await beginWebsiteOperation(db, context.workflowId, "first", 30);
      const firstContent = "First immutable website snapshot.";

      await expectSqlFailure(db, "bad_content_hash", () => db.query(storeWebsitePageSql({
        operationId: first.operationId,
        content: firstContent,
        contentHash: "0".repeat(64)
      })), /research_content_hash_mismatch/);

      const firstStored = await db.query<{ stored: { artifactId: string; snapshotId: string; contentHash: string; byteSize: number } }>(
        storeWebsitePageSql({ operationId: first.operationId, content: firstContent })
      );
      const duplicateStored = await db.query<{ stored: { artifactId: string; snapshotId: string } }>(
        storeWebsitePageSql({ operationId: first.operationId, content: firstContent })
      );
      expect(duplicateStored.rows[0]?.stored).toMatchObject({
        artifactId: firstStored.rows[0]!.stored.artifactId,
        snapshotId: firstStored.rows[0]!.stored.snapshotId
      });

      const conflictingContent = "Conflicting content for the same operation page.";
      await expectSqlFailure(db, "artifact_conflict", () => db.query(storeWebsitePageSql({
        operationId: first.operationId,
        content: conflictingContent
      })), /research_artifact_idempotency_conflict/);
      await completeWebsiteOperation(db, first.operationId, first.pollAttemptId, 5);

      await expectSqlFailure(db, "snapshot_immutable", () => db.query(`
        update source_snapshots set title = 'Overwritten'
        where id = '${firstStored.rows[0]!.stored.snapshotId}'
      `), /research_history_is_immutable/);

      const second = await beginWebsiteOperation(db, context.workflowId, "second", 30);
      const secondContent = "Second immutable website snapshot after a new crawl.";
      await db.query(storeWebsitePageSql({ operationId: second.operationId, content: secondContent }));
      await completeWebsiteOperation(db, second.operationId, second.pollAttemptId, 6);

      const evidence = await db.query<{
        documents: number;
        snapshots: number;
        artifacts: number;
        distinct_hashes: number;
        bytes_match: boolean;
      }>(`
        select
          (select count(*)::integer from source_documents sd where sd.report_id = '${context.reportId}') documents,
          (select count(*)::integer from source_snapshots ss join provider_operations po on po.id = ss.provider_operation_id
            where po.workflow_id = '${context.workflowId}') snapshots,
          (select count(*)::integer from research_artifacts ra join provider_operations po on po.id = ra.provider_operation_id
            where po.workflow_id = '${context.workflowId}') artifacts,
          (select count(distinct ss.content_hash)::integer from source_snapshots ss join provider_operations po on po.id = ss.provider_operation_id
            where po.workflow_id = '${context.workflowId}') distinct_hashes,
          (select bool_and(byte_size = octet_length(convert_to(markdown_content, 'UTF8')))
            from source_snapshots ss join provider_operations po on po.id = ss.provider_operation_id
            where po.workflow_id = '${context.workflowId}') bytes_match
      `);
      expect(evidence.rows[0]).toEqual({
        documents: 1,
        snapshots: 2,
        artifacts: 2,
        distinct_hashes: 2,
        bytes_match: true
      });

      const idempotent = await db.query<{ operation: { id: string } }>(ensureOperationSql({
        workflowId: context.workflowId,
        kind: "website_research",
        provider: "firecrawl",
        suffix: "second",
        cost: 30
      }));
      expect(idempotent.rows[0]?.operation.id).toBe(second.operationId);
      await expectSqlFailure(db, "operation_conflict", () => db.query(ensureOperationSql({
        workflowId: context.workflowId,
        kind: "website_research",
        provider: "firecrawl",
        suffix: "second",
        cost: 30,
        requestFingerprint: sha256("different-request")
      })), /provider_operation_idempotency_conflict/);
    } finally {
      await db.exec("rollback");
    }
  });

  it("refuses PR4 provider work when the legacy V2 pipeline owns the report", async () => {
    await db.exec("begin");
    try {
      const context = await setupReadyFoundationWorkflow(db, "legacy-owner.example", "s");
      await db.exec(`
        insert into report_jobs (
          public_id, submitted_url, normalized_url, domain, status, current_step,
          progress, steps, visitor_hash, expires_at
        ) values (
          'legacyowner1234567', 'https://legacy-owner.example/',
          'https://legacy-owner.example/', 'legacy-owner.example', 'running',
          'crawl', 10, '[]'::jsonb, '${sha256("legacy-owner")}',
          now() + interval '1 day'
        );
        update reports set legacy_public_id = 'legacyowner1234567'
        where id = '${context.reportId}'
      `);
      await expectSqlFailure(db, "legacy_pipeline_guard", () => db.query(`
        select prepare_v3_provider_research('${context.workflowId}', 160, 120, 80, 4, now())
      `), /legacy_provider_pipeline_owns_report/);
      expect((await db.query<{ count: number }>(`
        select count(*)::integer count from research_steps
        where workflow_id = '${context.workflowId}' and step_key = 'website_research'
      `)).rows[0]?.count).toBe(0);
    } finally {
      await db.exec("rollback");
    }
  });

  it("versions company intelligence, preserves claim provenance, and stores deduplicated query-only output", async () => {
    await db.exec("begin");
    try {
      const context = await setupProviderWorkflow(db, "provider-profile.example", "r");
      const website = await beginWebsiteOperation(db, context.workflowId, "profile-source", 0);
      await db.query(storeWebsitePageSql({
        operationId: website.operationId,
        content: "Example Labs provides buyer research for B2B growth teams. Its public case studies document customer proof."
      }));
      await completeWebsiteOperation(db, website.operationId, website.pollAttemptId, 0);

      const firstProfile = syntheticCompanyProfile("https://provider-profile.example/");
      const firstProfileResult = await persistProfile(db, context.workflowId, "first", firstProfile);
      const secondProfile = syntheticCompanyProfile("https://provider-profile.example/");
      secondProfile.summary = "Example Labs provides versioned buyer intelligence for B2B teams.";
      const secondProfileResult = await persistProfile(db, context.workflowId, "second", secondProfile);
      expect(firstProfileResult.profileVersion).toBe(1);
      expect(secondProfileResult.profileVersion).toBe(2);

      await expectSqlFailure(db, "profile_immutable", () => db.query(`
        update company_profile_versions set profile_summary = 'Overwritten'
        where id = '${firstProfileResult.profileVersionId}'
      `), /research_history_is_immutable/);

      const profileState = await db.query<{
        profiles: number;
        claims: number;
        claim_evidence: number;
        entities: number;
        entity_evidence: number;
        trust_signals: number;
        original_summary: string;
      }>(`
        select
          (select count(*)::integer from company_profile_versions where workflow_id = '${context.workflowId}') profiles,
          (select count(*)::integer from company_profile_claims where profile_version_id = '${secondProfileResult.profileVersionId}') claims,
          (select count(*)::integer from company_profile_claim_evidence ce join company_profile_claims c on c.id = ce.claim_id
            where c.profile_version_id = '${secondProfileResult.profileVersionId}') claim_evidence,
          (select count(*)::integer from company_profile_entities where profile_version_id = '${secondProfileResult.profileVersionId}') entities,
          (select count(*)::integer from company_profile_entity_evidence ee join company_profile_entities e on e.id = ee.profile_entity_id
            where e.profile_version_id = '${secondProfileResult.profileVersionId}') entity_evidence,
          (select count(*)::integer from company_profile_entities where profile_version_id = '${secondProfileResult.profileVersionId}'
            and entity_type = 'trust_signal') trust_signals,
          (select profile_summary from company_profile_versions where id = '${firstProfileResult.profileVersionId}') original_summary
      `);
      expect(profileState.rows[0]).toEqual({
        profiles: 2,
        claims: 10,
        claim_evidence: 8,
        entities: 2,
        entity_evidence: 2,
        trust_signals: 1,
        original_summary: firstProfile.summary
      });

      const [firstQuery, secondQuery] = syntheticQueries(2);
      const queries = [
        firstQuery!,
        { ...firstQuery!, query: `  ${firstQuery!.query.toUpperCase()}  ` },
        secondQuery!
      ];
      const queryResult = await persistQueries(
        db,
        context.workflowId,
        secondProfileResult.profileVersionId,
        "first",
        queries
      );
      expect(queryResult).toMatchObject({ querySetVersion: 1, queryCount: 2 });

      const queryState = await db.query<{
        queries: number;
        claim_links: number;
        model_invocations: number;
        provider_request_ids: number;
        profile_version_id: string;
      }>(`
        select
          (select count(*)::integer from search_queries where query_set_id = '${queryResult.querySetId}') queries,
          (select count(*)::integer from search_query_claim_evidence qe join search_queries q on q.id = qe.search_query_id
            where q.query_set_id = '${queryResult.querySetId}') claim_links,
          (select count(*)::integer from model_invocations where workflow_id = '${context.workflowId}') model_invocations,
          (select count(distinct provider_request_id)::integer from model_invocations
            where workflow_id = '${context.workflowId}') provider_request_ids,
          (select profile_version_id::text from search_query_sets where id = '${queryResult.querySetId}') profile_version_id
      `);
      expect(queryState.rows[0]).toEqual({
        queries: 2,
        claim_links: 4,
        model_invocations: 3,
        provider_request_ids: 3,
        profile_version_id: secondProfileResult.profileVersionId
      });

      const geographyOperation = await beginModelOperation(
        db,
        context.workflowId,
        "search_query_discovery",
        "unsupported-geography",
        0
      );
      const geographicQuery = [{ ...firstQuery!, geographicRelevance: "New York" }];
      await expectSqlFailure(db, "unsupported_geography", () => db.query(persistQueriesSql({
        operationId: geographyOperation.operationId,
        attemptId: geographyOperation.attemptId,
        profileVersionId: secondProfileResult.profileVersionId,
        queries: geographicQuery,
        suffix: "unsupported-geography"
      })), /query_geography_not_supported/);
    } finally {
      await db.exec("rollback");
    }
  });
});

function intakeSql(domain = "example.com", seed = "a") {
  return `select * from create_report_intake(
    '${domain}', 'https://${domain}/', 'https://${domain}/', 'owner@${domain}',
    '${domain}', 'homepage_hero', '${sha256(`${seed}:request`)}', '${sha256(`${seed}:visitor`)}',
    'progress_${seed.repeat(20)}', '${seed.repeat(18)}', '${sha256(`${seed}:access`)}',
    now() + interval '365 days', now() + interval '365 days', '${sha256(`${seed}:contact`)}', '[]'::jsonb,
    now() - interval '24 hours', now() - interval '60 minutes', now() - interval '60 minutes',
    2, 2, now() - interval '60 minutes', 10,
    jsonb_build_object('requestSignalHash', '${sha256(`${seed}:signal`)}', 'userAgentCategory', 'browser')
  )`;
}

async function installPgmqStub(db: PGlite) {
  await db.exec(`
    create schema pgmq;
    create type pgmq.message_record as (
      msg_id bigint, read_ct integer, enqueued_at timestamptz,
      last_read_at timestamptz, vt timestamptz, message jsonb, headers jsonb
    );
    create table pgmq.meta (queue_name text primary key, is_unlogged boolean not null default false);
    create table pgmq.test_config (fail_send boolean not null default false);
    insert into pgmq.test_config values (false);
    create table pgmq.q_v3_report_workflows (
      msg_id bigserial primary key, read_ct integer not null default 0,
      enqueued_at timestamptz not null default clock_timestamp(), last_read_at timestamptz,
      vt timestamptz not null default clock_timestamp(), message jsonb not null, headers jsonb
    );
    create table pgmq.a_v3_report_workflows (like pgmq.q_v3_report_workflows including all);
    create function pgmq.create(queue_name text) returns void language plpgsql as $$
    begin insert into pgmq.meta values (queue_name, false) on conflict do nothing; end $$;
    create function pgmq.send(queue_name text, msg jsonb) returns setof bigint language plpgsql as $$
    begin
      if (select fail_send from pgmq.test_config) then raise exception 'pgmq_send_failed'; end if;
      return query insert into pgmq.q_v3_report_workflows(message) values (msg) returning msg_id;
    end $$;
    create function pgmq.read(queue_name text, visibility_seconds integer, qty integer) returns setof pgmq.message_record language plpgsql as $$
    begin
      return query
      with candidates as (
        select msg_id from pgmq.q_v3_report_workflows
        where pgmq.q_v3_report_workflows.vt <= clock_timestamp()
        order by msg_id limit qty for update skip locked
      )
      update pgmq.q_v3_report_workflows q set
        read_ct = q.read_ct + 1, last_read_at = clock_timestamp(),
        vt = clock_timestamp() + make_interval(secs => visibility_seconds)
      from candidates c where q.msg_id = c.msg_id
      returning q.msg_id, q.read_ct, q.enqueued_at, q.last_read_at, q.vt, q.message, q.headers;
    end $$;
    create function pgmq.set_vt(queue_name text, target_id bigint, delay integer) returns setof pgmq.message_record language plpgsql as $$
    begin
      return query update pgmq.q_v3_report_workflows q
      set vt = clock_timestamp() + make_interval(secs => delay)
      where q.msg_id = target_id
      returning q.msg_id, q.read_ct, q.enqueued_at, q.last_read_at, q.vt, q.message, q.headers;
    end $$;
    create function pgmq.archive(queue_name text, target_id bigint) returns boolean language plpgsql as $$
    declare moved integer;
    begin
      with archived as (delete from pgmq.q_v3_report_workflows where msg_id = target_id returning *)
      insert into pgmq.a_v3_report_workflows select * from archived;
      get diagnostics moved = row_count;
      return moved > 0;
    end $$;
  `);
}

async function setupProviderWorkflow(db: PGlite, domain: string, seed: string) {
  const context = await setupReadyFoundationWorkflow(db, domain, seed);
  const continuation = await db.query<{ prepared: boolean }>(`
    select prepare_v3_provider_research('${context.workflowId}', 160, 120, 80, 4, now()) prepared
  `);
  expect(continuation.rows[0]?.prepared).toBe(true);
  return context;
}

async function setupReadyFoundationWorkflow(db: PGlite, domain: string, seed: string) {
  const intake = await db.query<{
    report_request_id: string;
    report_id: string;
  }>(intakeSql(domain, seed));
  const reportRequestId = intake.rows[0]!.report_request_id;
  const reportId = intake.rows[0]!.report_id;
  const workflow = await db.query<{ id: string }>(`
    select id from research_workflows where report_request_id = '${reportRequestId}'
  `);
  const workflowId = workflow.rows[0]!.id;
  await db.exec(`
    update research_steps set status = 'succeeded', completed_at = now(), updated_at = now()
    where workflow_id = '${workflowId}' and step_key in (
      'initialize_workflow', 'validate_intake_references', 'establish_cost_budget',
      'prepare_provider_research', 'mark_ready_for_provider_research'
    );
    update research_workflows set status = 'ready_for_provider_research',
      current_phase = 'provider_research', updated_at = now()
    where id = '${workflowId}';
  `);
  return { workflowId, reportRequestId, reportId };
}

function ensureOperationSql(input: {
  workflowId: string;
  kind: "website_research" | "company_profile_extraction" | "search_query_discovery";
  provider: "firecrawl" | "openai" | "mock";
  suffix: string;
  cost: number;
  requestFingerprint?: string;
}) {
  const fingerprint = input.requestFingerprint ?? sha256(`${input.kind}:${input.suffix}`);
  return `select ensure_provider_operation(
    '${input.workflowId}', '${input.kind}', '${input.provider}', '${input.kind}',
    'provider-test:${input.workflowId}:${input.kind}:${input.suffix}',
    '${fingerprint}', ${input.cost}, 12, '${SYNTHETIC_RESEARCH_TIME}'
  ) operation`;
}

async function beginWebsiteOperation(
  db: PGlite,
  workflowId: string,
  suffix: string,
  cost: number
) {
  const ensured = await db.query<{ operation: { id: string } }>(ensureOperationSql({
    workflowId,
    kind: "website_research",
    provider: "firecrawl",
    suffix,
    cost
  }));
  const operationId = ensured.rows[0]!.operation.id;
  const submit = await db.query<{ attempt: { attemptId: string } }>(`
    select begin_provider_operation_attempt('${operationId}', 'submit', '${SYNTHETIC_RESEARCH_TIME}') attempt
  `);
  await db.query(`select record_provider_job(
    '${operationId}', '${submit.rows[0]!.attempt.attemptId}', 'job-${suffix}', 200,
    '{}'::jsonb, '${SYNTHETIC_RESEARCH_TIME}', '${SYNTHETIC_RESEARCH_TIME}'
  )`);
  const poll = await db.query<{ attempt: { attemptId: string } }>(`
    select begin_provider_operation_attempt('${operationId}', 'poll', '${SYNTHETIC_RESEARCH_TIME}') attempt
  `);
  return { operationId, pollAttemptId: poll.rows[0]!.attempt.attemptId };
}

function storeWebsitePageSql(input: {
  operationId: string;
  content: string;
  contentHash?: string;
}) {
  const contentHash = input.contentHash ?? sha256(input.content);
  const rawPayload = {
    markdown: input.content,
    metadata: { sourceURL: "https://evidence.example/", statusCode: 200 }
  };
  return `select store_website_research_page(
    '${input.operationId}', 0, 'https://evidence.example/', 'https://evidence.example/',
    'Synthetic evidence', 'Synthetic website evidence', ${sqlLiteral(input.content)},
    '${contentHash}', ${sqlJson(rawPayload)}, '${SYNTHETIC_RESEARCH_TIME}',
    '${SYNTHETIC_RESEARCH_TIME}', '2026-01-17T12:00:00.000Z'
  ) stored`;
}

async function completeWebsiteOperation(
  db: PGlite,
  operationId: string,
  pollAttemptId: string,
  actualCostCents: number
) {
  await db.query(`select complete_website_research_operation(
    '${operationId}', '${pollAttemptId}', 200, '{"creditsUsed":1}'::jsonb,
    ${actualCostCents}, '${SYNTHETIC_RESEARCH_TIME}', '${SYNTHETIC_RESEARCH_TIME}'
  )`);
}

async function beginModelOperation(
  db: PGlite,
  workflowId: string,
  kind: "company_profile_extraction" | "search_query_discovery",
  suffix: string,
  cost: number
) {
  const ensured = await db.query<{ operation: { id: string } }>(ensureOperationSql({
    workflowId,
    kind,
    provider: "mock",
    suffix,
    cost
  }));
  const operationId = ensured.rows[0]!.operation.id;
  const attempt = await db.query<{ attempt: { attemptId: string } }>(`
    select begin_provider_operation_attempt('${operationId}', 'submit', '${SYNTHETIC_RESEARCH_TIME}') attempt
  `);
  return { operationId, attemptId: attempt.rows[0]!.attempt.attemptId };
}

async function persistProfile(
  db: PGlite,
  workflowId: string,
  suffix: string,
  profile: ReturnType<typeof syntheticCompanyProfile>
) {
  const operation = await beginModelOperation(
    db,
    workflowId,
    "company_profile_extraction",
    suffix,
    0
  );
  const result = await db.query<{
    profile: { profileVersionId: string; profileVersion: number; modelInvocationId: string };
  }>(`select persist_company_profile(
    '${operation.operationId}', '${operation.attemptId}', 'mock-structured-analysis-v1',
    'mock-profile-${suffix}', 'company-profile-v1', '${sha256(`profile-input:${suffix}`)}',
    '${sha256(JSON.stringify(profile))}', 11, 5, 16, '{"cachedInputTokens":0}'::jsonb,
    0, 0, '${SYNTHETIC_RESEARCH_TIME}', ${sqlJson(profile)},
    '${SYNTHETIC_RESEARCH_TIME}', '2026-01-17T12:00:00.000Z', '${SYNTHETIC_RESEARCH_TIME}'
  ) profile`);
  return result.rows[0]!.profile;
}

async function persistQueries(
  db: PGlite,
  workflowId: string,
  profileVersionId: string,
  suffix: string,
  queries: ReturnType<typeof syntheticQueries>
) {
  const operation = await beginModelOperation(
    db,
    workflowId,
    "search_query_discovery",
    suffix,
    0
  );
  const result = await db.query<{
    query_set: {
      querySetId: string;
      querySetVersion: number;
      modelInvocationId: string;
      queryCount: number;
    };
  }>(persistQueriesSql({
    operationId: operation.operationId,
    attemptId: operation.attemptId,
    profileVersionId,
    queries,
    suffix
  }));
  return result.rows[0]!.query_set;
}

function persistQueriesSql(input: {
  operationId: string;
  attemptId: string;
  profileVersionId: string;
  queries: ReturnType<typeof syntheticQueries>;
  suffix: string;
}) {
  return `select persist_search_query_set(
    '${input.operationId}', '${input.attemptId}', '${input.profileVersionId}',
    'mock-structured-analysis-v1', 'mock-queries-${input.suffix}', 'search-query-discovery-v1',
    '${sha256(`query-input:${input.suffix}`)}', '${sha256(JSON.stringify(input.queries))}',
    9, 4, 13, '{"cachedInputTokens":0}'::jsonb, 0, 0,
    '${SYNTHETIC_RESEARCH_TIME}', ${sqlJson(input.queries)},
    '${SYNTHETIC_RESEARCH_TIME}', '2026-01-17T12:00:00.000Z', '${SYNTHETIC_RESEARCH_TIME}'
  ) query_set`;
}

async function expectSqlFailure(
  db: PGlite,
  savepoint: string,
  operation: () => Promise<unknown>,
  pattern: RegExp
) {
  await db.exec(`savepoint ${savepoint}`);
  try {
    await expect(operation()).rejects.toThrow(pattern);
  } finally {
    await db.exec(`rollback to savepoint ${savepoint}; release savepoint ${savepoint}`);
  }
}

function sqlJson(value: unknown) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

function sqlLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
