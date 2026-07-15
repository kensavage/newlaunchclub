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
      "0005_v3_provider_research_evidence.sql",
      "0006_v3_provider_failure_settlement.sql",
      "0007_v3_openai_response_recovery_context_selection.sql",
      "0008_v3_idempotent_provider_settlement.sql"
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
              'search_query_claim_evidence', 'provider_operation_reconciliations',
              'analysis_response_artifacts', 'analysis_response_diagnostics',
              'analysis_response_retrieval_attempts', 'content_selection_runs',
              'content_selection_pages'
            ) and c.relrowsecurity) rls_tables,
          (select count(*)::integer from information_schema.role_table_grants
            where grantee in ('anon', 'authenticated') and table_schema = 'public'
              and table_name in ('provider_operations', 'research_artifacts', 'source_snapshots',
                'model_invocations', 'company_profile_versions', 'search_queries',
                'analysis_response_artifacts', 'analysis_response_diagnostics',
                'analysis_response_retrieval_attempts', 'content_selection_runs',
                'content_selection_pages')) browser_grants
      `);
      expect(state.rows[0]).toEqual({
        provider_steps: 3,
        total_steps: 8,
        status: "dispatch_pending",
        queued: 2,
        rls_tables: 20,
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
      await db.exec("savepoint browser_table_denial");
      await expect(db.query("select * from public.research_artifacts")).rejects.toThrow(/permission denied/i);
      await db.exec("rollback to savepoint browser_table_denial; release savepoint browser_table_denial");
      await db.exec("savepoint browser_response_denial");
      await expect(db.query("select * from public.analysis_response_artifacts"))
        .rejects.toThrow(/permission denied/i);
      await db.exec("rollback to savepoint browser_response_denial; release savepoint browser_response_denial");
      await db.exec("savepoint browser_rpc_denial");
      await expect(db.query(`select reserve_v3_provider_operation_cost(gen_random_uuid(), now())`))
        .rejects.toThrow(/permission denied/i);
      await db.exec("rollback to savepoint browser_rpc_denial; release savepoint browser_rpc_denial");
      await db.exec("savepoint browser_recovery_rpc_denial");
      await expect(db.query(`select get_v3_analysis_response(gen_random_uuid())`))
        .rejects.toThrow(/permission denied/i);
      await db.exec("rollback to savepoint browser_recovery_rpc_denial; release savepoint browser_recovery_rpc_denial");
      await db.exec("rollback to savepoint browser_denial; release savepoint browser_denial; reset role");

      await db.exec("savepoint service_role_scope");
      await db.exec("set local role service_role");
      await db.exec("savepoint service_role_table_denial");
      await expect(db.query("select * from public.analysis_response_artifacts"))
        .rejects.toThrow(/permission denied/i);
      await db.exec("rollback to savepoint service_role_table_denial; release savepoint service_role_table_denial");
      await expect(db.query(`select get_v3_analysis_response(gen_random_uuid())`)).resolves.toBeDefined();
      await db.exec("rollback to savepoint service_role_scope; release savepoint service_role_scope; reset role");
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

  it("atomically retries Firecrawl, resolves stale errors on success, and settles cost once", async () => {
    await db.exec("begin");
    try {
      const context = await setupProviderWorkflow(db, "settlement-success.example", "t");
      const first = await beginLeasedProviderOperation(db, {
        workflowId: context.workflowId,
        kind: "website_research",
        provider: "firecrawl",
        owner: "firecrawl-first",
        suffix: "settlement-success",
        cost: 20
      });
      await db.query(settleProviderSql({
        ...first,
        outcome: "transient_retryable",
        classification: "transient",
        safeCode: "provider_job_pending",
        safeSummary: "Website research is still running.",
        retryAt: "now() + interval '1 second'"
      }));
      const delayed = await db.query<{
        operation_state: string;
        outcome_class: string;
        reserved_cost_cents: number;
        step_status: string;
        workflow_status: string;
        open_errors: number;
      }>(`
        select po.operation_state, po.outcome_class, po.reserved_cost_cents,
          rs.status step_status, rw.status workflow_status,
          (select count(*)::integer from workflow_errors
            where workflow_id = rw.id and resolved_at is null) open_errors
        from provider_operations po
        join research_steps rs on rs.id = po.step_id
        join research_workflows rw on rw.id = po.workflow_id
        where po.id = '${first.operationId}'
      `);
      expect(delayed.rows[0]).toEqual({
        operation_state: "submitted",
        outcome_class: "transient_retryable",
        reserved_cost_cents: 20,
        step_status: "retry_scheduled",
        workflow_status: "waiting_retry",
        open_errors: 1
      });

      await db.query(`select admin_transition_research_workflow(
        '${context.workflowId}', 'retry_step', 'website_research', 'test-admin', now()
      )`);
      const secondLease = await beginWorkflowStep(
        db,
        context.workflowId,
        "website_research",
        "firecrawl-second"
      );
      const secondPoll = await db.query<{ attempt: { attemptId: string } }>(`
        select begin_provider_operation_attempt('${first.operationId}', 'poll', now()) attempt
      `);
      const content = "Settlement success evidence for a completed Firecrawl job.";
      await db.query(storeWebsitePageSql({ operationId: first.operationId, content }));
      await db.query(`select complete_website_research_operation(
        '${first.operationId}', '${secondPoll.rows[0]!.attempt.attemptId}', 200,
        '{"creditsUsed":5}'::jsonb, 5, now(), now()
      )`);
      const successSql = settleProviderSql({
        operationId: first.operationId,
        providerAttemptId: null,
        workflowAttemptId: secondLease.workflowAttemptId,
        owner: "firecrawl-second",
        fencingToken: secondLease.fencingToken,
        outcome: "succeeded",
        classification: null,
        safeCode: null,
        safeSummary: null,
        retryAt: "null",
        outputReference: "provider-operation:website"
      });
      await db.query(successSql);
      await db.query(successSql);

      const settled = await db.query<{
        operation_state: string;
        outcome_class: string;
        reserved_cost_cents: number;
        reserved: number;
        spent: number;
        available: number;
        historical_errors: number;
        open_errors: number;
        actual_entries: number;
        snapshots: number;
      }>(`
        select po.operation_state, po.outcome_class, po.reserved_cost_cents,
          b.reserved_cents reserved, b.spent_cents spent,
          b.limit_cents - b.reserved_cents - b.spent_cents available,
          (select count(*)::integer from workflow_errors
            where workflow_id = po.workflow_id and safe_code = 'provider_job_pending') historical_errors,
          (select count(*)::integer from workflow_errors
            where workflow_id = po.workflow_id and resolved_at is null) open_errors,
          (select count(*)::integer from report_cost_entries
            where workflow_id = po.workflow_id and entry_type = 'actual') actual_entries,
          (select count(*)::integer from source_snapshots
            where provider_operation_id = po.id) snapshots
        from provider_operations po
        join report_cost_budgets b on b.workflow_id = po.workflow_id
        where po.id = '${first.operationId}'
      `);
      expect(settled.rows[0]).toEqual({
        operation_state: "succeeded",
        outcome_class: "succeeded",
        reserved_cost_cents: 0,
        reserved: 0,
        spent: 5,
        available: 395,
        historical_errors: 1,
        open_errors: 0,
        actual_entries: 1,
        snapshots: 1
      });
    } finally {
      await db.exec("rollback");
    }
  });

  it("releases a definitive OpenAI rejection while preserving earlier Firecrawl spend", async () => {
    await db.exec("begin");
    try {
      const context = await setupProviderWorkflow(db, "settlement-rejection.example", "u");
      await completeAndSettleWebsite(db, context.workflowId, "rejection-source", 20, 5);
      const profile = await beginLeasedProviderOperation(db, {
        workflowId: context.workflowId,
        kind: "company_profile_extraction",
        provider: "openai",
        owner: "openai-rejected",
        suffix: "rejected-profile",
        cost: 25
      });
      await db.query(settleProviderSql({
        ...profile,
        outcome: "definitively_rejected",
        classification: "configuration_error",
        safeCode: "provider_authentication_failed",
        safeSummary: "The analysis provider requires administrator configuration.",
        retryAt: "null"
      }));
      const state = await db.query<{
        operation_state: string;
        outcome_class: string;
        reserved_cost_cents: number;
        workflow_status: string;
        step_status: string;
        reserved: number;
        spent: number;
        available: number;
        retries: number;
      }>(`
        select po.operation_state, po.outcome_class, po.reserved_cost_cents,
          rw.status workflow_status, rs.status step_status,
          b.reserved_cents reserved, b.spent_cents spent,
          b.limit_cents - b.reserved_cents - b.spent_cents available,
          (select count(*)::integer from provider_operations
            where workflow_id = rw.id and operation_state = 'retry_scheduled') retries
        from provider_operations po
        join research_workflows rw on rw.id = po.workflow_id
        join research_steps rs on rs.id = po.step_id
        join report_cost_budgets b on b.workflow_id = po.workflow_id
        where po.id = '${profile.operationId}'
      `);
      expect(state.rows[0]).toEqual({
        operation_state: "failed",
        outcome_class: "definitively_rejected",
        reserved_cost_cents: 0,
        workflow_status: "paused",
        step_status: "failed_terminal",
        reserved: 0,
        spent: 5,
        available: 395,
        retries: 0
      });

      await db.query(`select admin_transition_research_workflow(
        '${context.workflowId}', 'retry_step', 'company_profile_extraction', 'test-admin', now()
      )`);
      await beginWorkflowStep(db, context.workflowId, "company_profile_extraction", "openai-corrected");
      await db.query(`select reserve_v3_provider_operation_cost('${profile.operationId}', now())`);
      const retried = await db.query<{ generation: number; reserved: number }>(`
        select po.reservation_generation generation, b.reserved_cents reserved
        from provider_operations po join report_cost_budgets b on b.workflow_id = po.workflow_id
        where po.id = '${profile.operationId}'
      `);
      expect(retried.rows[0]).toEqual({ generation: 2, reserved: 25 });

      await db.query(`select admin_transition_research_workflow(
        '${context.workflowId}', 'cancel', null, 'test-admin', now()
      )`);
      const cancelled = await db.query<{ state: string; reserved: number; spent: number }>(`
        select po.operation_state state, b.reserved_cents reserved, b.spent_cents spent
        from provider_operations po join report_cost_budgets b on b.workflow_id = po.workflow_id
        where po.id = '${profile.operationId}'
      `);
      expect(cancelled.rows[0]).toEqual({ state: "cancelled", reserved: 0, spent: 5 });
    } finally {
      await db.exec("rollback");
    }
  });

  it("retains uncertain reservations until one idempotent administrator reconciliation", async () => {
    await db.exec("begin");
    try {
      const context = await setupProviderWorkflow(db, "settlement-uncertain.example", "v");
      const uncertain = await beginLeasedProviderOperation(db, {
        workflowId: context.workflowId,
        kind: "website_research",
        provider: "firecrawl",
        owner: "uncertain-owner",
        suffix: "uncertain-submit",
        cost: 20
      });
      await db.query(settleProviderSql({
        ...uncertain,
        outcome: "outcome_uncertain",
        classification: "configuration_error",
        safeCode: "provider_timeout",
        safeSummary: "The provider submission outcome is unknown.",
        retryAt: "null"
      }));
      const quarantined = await db.query<{
        state: string;
        reconciliation_required: boolean;
        reserved: number;
        workflow_status: string;
      }>(`
        select po.operation_state state, po.reconciliation_required,
          b.reserved_cents reserved, rw.status workflow_status
        from provider_operations po
        join report_cost_budgets b on b.workflow_id = po.workflow_id
        join research_workflows rw on rw.id = po.workflow_id
        where po.id = '${uncertain.operationId}'
      `);
      expect(quarantined.rows[0]).toEqual({
        state: "outcome_unknown",
        reconciliation_required: true,
        reserved: 20,
        workflow_status: "paused"
      });
      await expectSqlFailure(db, "uncertain_retry", () => db.query(`
        select admin_transition_research_workflow(
          '${context.workflowId}', 'retry_step', 'website_research', 'test-admin', now()
        )
      `), /provider_reconciliation_required/);

      await expectSqlFailure(db, "reconciliation_cost_scope", () => db.query(`
        select admin_reconcile_v3_provider_operation(
          '${uncertain.operationId}', 'definitively_rejected', 1, 'test-admin', now()
        )
      `), /provider_reconciled_cost_invalid/);
      const reconcileSql = `select admin_reconcile_v3_provider_operation(
        '${uncertain.operationId}', 'definitively_rejected', null, 'test-admin', now()
      )`;
      await db.query(reconcileSql);
      await db.query(reconcileSql);
      const reconciled = await db.query<{
        state: string;
        reconciliation_required: boolean;
        reserved: number;
        reconciliations: number;
        historical_errors: number;
        open_errors: number;
      }>(`
        select po.operation_state state, po.reconciliation_required,
          b.reserved_cents reserved,
          (select count(*)::integer from provider_operation_reconciliations
            where provider_operation_id = po.id) reconciliations,
          (select count(*)::integer from workflow_errors
            where workflow_id = po.workflow_id and safe_code = 'provider_outcome_unknown') historical_errors,
          (select count(*)::integer from workflow_errors
            where workflow_id = po.workflow_id and safe_code = 'provider_outcome_unknown'
              and resolved_at is null) open_errors
        from provider_operations po
        join report_cost_budgets b on b.workflow_id = po.workflow_id
        where po.id = '${uncertain.operationId}'
      `);
      expect(reconciled.rows[0]).toEqual({
        state: "failed",
        reconciliation_required: false,
        reserved: 0,
        reconciliations: 1,
        historical_errors: 1,
        open_errors: 0
      });
    } finally {
      await db.exec("rollback");
    }
  });

  it("preserves a possibly paid cancellation until actual spend is reconciled", async () => {
    await db.exec("begin");
    try {
      const context = await setupProviderWorkflow(db, "settlement-cancel.example", "w");
      const submitted = await beginLeasedProviderOperation(db, {
        workflowId: context.workflowId,
        kind: "website_research",
        provider: "firecrawl",
        owner: "cancel-owner",
        suffix: "cancel-submitted",
        cost: 20
      });
      await db.query(`select admin_transition_research_workflow(
        '${context.workflowId}', 'cancel', null, 'test-admin', now()
      )`);
      const held = await db.query<{
        state: string;
        reconciliation_required: boolean;
        reserved: number;
        spent: number;
      }>(`
        select po.operation_state state, po.reconciliation_required,
          b.reserved_cents reserved, b.spent_cents spent
        from provider_operations po join report_cost_budgets b on b.workflow_id = po.workflow_id
        where po.id = '${submitted.operationId}'
      `);
      expect(held.rows[0]).toEqual({
        state: "outcome_unknown",
        reconciliation_required: true,
        reserved: 20,
        spent: 0
      });

      const reconciliation = `select admin_reconcile_v3_provider_operation(
        '${submitted.operationId}', 'paid_cancelled', 5, 'test-admin', now()
      )`;
      await db.query(reconciliation);
      await db.query(reconciliation);
      const final = await db.query<{
        state: string;
        reserved: number;
        spent: number;
        available: number;
        reconciliations: number;
      }>(`
        select po.operation_state state, b.reserved_cents reserved, b.spent_cents spent,
          b.limit_cents - b.reserved_cents - b.spent_cents available,
          (select count(*)::integer from provider_operation_reconciliations
            where provider_operation_id = po.id) reconciliations
        from provider_operations po join report_cost_budgets b on b.workflow_id = po.workflow_id
        where po.id = '${submitted.operationId}'
      `);
      expect(final.rows[0]).toEqual({
        state: "cancelled",
        reserved: 0,
        spent: 5,
        available: 395,
        reconciliations: 1
      });
    } finally {
      await db.exec("rollback");
    }
  });

  it("captures analysis responses and context selection atomically with immutable failure history", async () => {
    await db.exec("begin");
    try {
      const context = await setupProviderWorkflow(db, "response-recovery.example", "x");
      const website = await beginLeasedProviderOperation(db, {
        workflowId: context.workflowId,
        kind: "website_research",
        provider: "firecrawl",
        owner: "response-recovery-website",
        suffix: "response-recovery-website",
        cost: 10
      });
      const websiteContent = [
        "Example Labs provides buyer research for B2B growth teams.",
        "Its documented methodology and public case studies help customers make evidence-based decisions."
      ].join(" ");
      const storedPage = await db.query<{ stored: { snapshotId: string } }>(storeWebsitePageSql({
        operationId: website.operationId,
        content: websiteContent
      }));
      await db.query(`select complete_website_research_operation(
        '${website.operationId}', '${website.providerAttemptId}', 200,
        '{"creditsUsed":1}'::jsonb, 2, now(), now()
      )`);
      await db.query(settleProviderSql({
        ...website,
        providerAttemptId: null,
        outcome: "succeeded",
        classification: null,
        safeCode: null,
        safeSummary: null,
        retryAt: "null"
      }));

      const profile = await beginLeasedProviderOperation(db, {
        workflowId: context.workflowId,
        kind: "company_profile_extraction",
        provider: "mock",
        owner: "response-recovery-profile",
        suffix: "response-recovery-profile",
        cost: 30
      });
      const snapshotId = storedPage.rows[0]!.stored.snapshotId;
      const selectionPage = {
        snapshotId,
        pageIndex: 0,
        classification: "homepage",
        rank: 1,
        included: true,
        inclusionReason: "Selected as homepage business evidence.",
        exclusionReason: null,
        originalCharacters: websiteContent.length,
        selectedCharacters: websiteContent.length,
        selectedOrder: 1,
        selectedContentHash: sha256(websiteContent),
        selectedMarkdown: websiteContent
      };
      const persistSelection = `select persist_v3_content_selection(
        '${profile.operationId}', 'company-profile-context-v1', '${sha256("selection-input")}',
        '{"maximumTotalCharacters":48000,"maximumPageCharacters":12000,"maximumLegalCharacters":3600,"maximumPages":8,"duplicateThreshold":0.88}'::jsonb,
        ${websiteContent.length}, ${websiteContent.length}, 0,
        ${sqlJson([selectionPage])}, now()
      ) selection`;
      await db.query(persistSelection);
      await db.query(persistSelection);

      const output = JSON.stringify(syntheticCompanyProfile("https://response-recovery.example/"));
      const capture = `select capture_v3_analysis_response(
        '${profile.operationId}', '${profile.providerAttemptId}',
        'resp_recovery_profile', 'request_recovery_profile', 'completed',
        'mock-structured-analysis-v2', 'company-profile-v2', 'company-profile-schema-v2',
        now(), now(), '{"inputTokens":120,"outputTokens":40,"totalTokens":160,"cachedInputTokens":0}'::jsonb,
        7, ${sqlLiteral(output)}, null, null, null, true,
        '{"outputItemTypes":["message"],"messageStatuses":["completed"],"storedForRecovery":true,"outputTruncated":false}'::jsonb,
        now()
      ) artifact`;
      const firstCapture = await db.query<{ artifact: { id: string; actualCostCents: number } }>(capture);
      const duplicateCapture = await db.query<{ artifact: { id: string; actualCostCents: number } }>(capture);
      expect(duplicateCapture.rows[0]?.artifact).toEqual(firstCapture.rows[0]?.artifact);

      const artifactId = firstCapture.rows[0]!.artifact.id;
      await db.query(`select record_v3_analysis_processing_result(
        '${artifactId}', 'parse', 'failed', 'permanent',
        'structured_output_schema_invalid', 'Captured output failed schema validation.', now()
      )`);
      await db.query(`select record_v3_analysis_processing_result(
        '${artifactId}', 'persistence', 'failed', 'transient',
        'analysis_persistence_interrupted', 'Business persistence was interrupted.', now()
      )`);
      await db.query(`select record_v3_analysis_processing_result(
        '${artifactId}', 'parse', 'succeeded', null, null, null, now()
      )`);

      const state = await db.query<{
        provider_state: string;
        provider_outcome: string;
        provider_response_status: string;
        processing_status: string;
        first_code: string;
        current_code: string | null;
        reserved: number;
        spent: number;
        actual_entries: number;
        release_entries: number;
        diagnostics: number;
        selections: number;
        selection_pages: number;
      }>(`
        select po.operation_state provider_state, po.outcome_class provider_outcome,
          po.provider_response_status, po.processing_status,
          a.first_safe_code first_code, a.current_safe_code current_code,
          b.reserved_cents reserved, b.spent_cents spent,
          (select count(*)::integer from report_cost_entries
            where idempotency_key like '%response-recovery-profile%:provider-response:%:actual') actual_entries,
          (select count(*)::integer from report_cost_entries
            where idempotency_key like '%response-recovery-profile%:provider-response:%:unused') release_entries,
          (select count(*)::integer from analysis_response_diagnostics
            where analysis_response_artifact_id = a.id) diagnostics,
          (select count(*)::integer from content_selection_runs
            where provider_operation_id = po.id) selections,
          (select count(*)::integer from content_selection_pages csp
            join content_selection_runs csr on csr.id = csp.content_selection_run_id
            where csr.provider_operation_id = po.id) selection_pages
        from provider_operations po
        join analysis_response_artifacts a on a.provider_operation_id = po.id
        join report_cost_budgets b on b.workflow_id = po.workflow_id
        where po.id = '${profile.operationId}'
      `);
      expect(state.rows[0]).toEqual({
        provider_state: "submitting",
        provider_outcome: "succeeded",
        provider_response_status: "completed",
        processing_status: "processing",
        first_code: "structured_output_schema_invalid",
        current_code: null,
        reserved: 0,
        spent: 9,
        actual_entries: 1,
        release_entries: 1,
        diagnostics: 3,
        selections: 1,
        selection_pages: 1
      });

      await expectSqlFailure(db, "first_failure_immutable", () => db.query(`
        update analysis_response_artifacts set first_safe_code = 'overwritten'
        where id = '${artifactId}'
      `), /first_analysis_failure_is_immutable/);
      await expectSqlFailure(db, "artifact_identity_immutable", () => db.query(`
        update analysis_response_artifacts set actual_cost_cents = 8
        where id = '${artifactId}'
      `), /analysis_response_identity_is_immutable/);
    } finally {
      await db.exec("rollback");
    }
  });

  it("settles a paid captured response exactly once across identical and concurrent replay", async () => {
    await db.exec("begin");
    try {
      const fixture = await setupCapturedProfileSettlementFixture(
        db,
        "settlement-replay.example",
        "y"
      );
      const settlement = settleProviderSql({
        ...fixture.profile,
        providerAttemptId: null,
        outcome: "succeeded",
        classification: null,
        safeCode: null,
        safeSummary: null,
        retryAt: "null",
        outputReference: fixture.outputReference
      });

      await Promise.all([db.query(settlement), db.query(settlement)]);
      await db.query(settlement);

      const state = await db.query<{
        step_status: string;
        spent: number;
        reserved: number;
        receipts: number;
        actual_entries: number;
        release_entries: number;
        success_events: number;
        attempts: number;
      }>(`
        select rs.status step_status, b.spent_cents spent,
          b.reserved_cents reserved,
          (select count(*)::integer from provider_operation_settlements
            where provider_operation_id = po.id) receipts,
          (select count(*)::integer from report_cost_entries
            where idempotency_key = po.idempotency_key || ':provider-response:' ||
              po.reservation_generation::text || ':actual') actual_entries,
          (select count(*)::integer from report_cost_entries
            where idempotency_key = po.idempotency_key || ':provider-response:' ||
              po.reservation_generation::text || ':unused') release_entries,
          (select count(*)::integer from workflow_events
            where workflow_id = po.workflow_id
              and event_type = 'provider_operation_succeeded'
              and safe_metadata ->> 'step' = 'company_profile_extraction') success_events,
          rs.attempt_count attempts
        from provider_operations po
        join research_steps rs on rs.id = po.step_id
        join report_cost_budgets b on b.workflow_id = po.workflow_id
        where po.id = '${fixture.profile.operationId}'
      `);
      expect(state.rows[0]).toEqual({
        step_status: "succeeded",
        spent: 3,
        reserved: 0,
        receipts: 1,
        actual_entries: 1,
        release_entries: 1,
        success_events: 1,
        attempts: 1
      });
    } finally {
      await db.exec("rollback");
    }
  });

  it("settles captured query generation once and stops at search-intelligence readiness", async () => {
    await db.exec("begin");
    try {
      const fixture = await setupCapturedProfileSettlementFixture(
        db,
        "query-settlement.example",
        "q"
      );
      await db.query(settleProviderSql({
        ...fixture.profile,
        providerAttemptId: null,
        outcome: "succeeded",
        classification: null,
        safeCode: null,
        safeSummary: null,
        retryAt: "null",
        outputReference: fixture.outputReference
      }));

      const queryOperation = await beginLeasedProviderOperation(db, {
        workflowId: fixture.workflowId,
        kind: "search_query_discovery",
        provider: "openai",
        owner: "captured-query-q",
        suffix: "captured-query-q",
        cost: 25
      });
      const queries = syntheticQueries(15);
      const responseText = JSON.stringify({ queries });
      const captured = await db.query<{ artifact: { id: string } }>(`
        select capture_v3_analysis_response(
          '${queryOperation.operationId}', '${queryOperation.providerAttemptId}',
          'resp-captured-query-q', 'request-captured-query-q', 'completed',
          'gpt-test', 'search-query-discovery-v2', 'search-query-schema-v2',
          now(), now(),
          '{"inputTokens":140,"outputTokens":60,"totalTokens":200,"cachedInputTokens":0}'::jsonb,
          2, ${sqlLiteral(responseText)}, null, null, null, true,
          '{"outputItemTypes":["message"],"messageStatuses":["completed"],"storedForRecovery":true,"outputTruncated":false}'::jsonb,
          now()
        ) artifact
      `);
      const artifactId = captured.rows[0]!.artifact.id;
      await db.query(`select record_v3_analysis_processing_result(
        '${artifactId}', 'parse', 'succeeded', null, null, null, now()
      )`);
      const persisted = await db.query<{
        query_set: { querySetId: string; queryCount: number };
      }>(persistQueriesSql({
        operationId: queryOperation.operationId,
        attemptId: queryOperation.providerAttemptId,
        profileVersionId: fixture.profileVersionId,
        queries,
        suffix: "captured-query-q"
      }));
      await db.query(`select record_v3_analysis_processing_result(
        '${artifactId}', 'complete', 'succeeded', null, null, null, now()
      )`);
      const outputReference = `search-query-set:${persisted.rows[0]!.query_set.querySetId}`;
      const settlement = settleProviderSql({
        ...queryOperation,
        providerAttemptId: null,
        outcome: "succeeded",
        classification: null,
        safeCode: null,
        safeSummary: null,
        retryAt: "null",
        outputReference
      });
      await db.query(settlement);
      await db.query(settlement);

      const state = await db.query<{
        workflow_status: string;
        phase: string;
        step_status: string;
        spent: number;
        reserved: number;
        receipts: number;
        query_count: number;
        distinct_queries: number;
        response_artifacts: number;
        readiness_events: number;
        report_status: string;
        report_reference: string | null;
        result_rows: number;
      }>(`
        select rw.status workflow_status, rw.current_phase phase,
          rs.status step_status, b.spent_cents spent,
          b.reserved_cents reserved,
          (select count(*)::integer from provider_operation_settlements
            where provider_operation_id = po.id) receipts,
          (select count(*)::integer from search_queries
            where query_set_id = '${persisted.rows[0]!.query_set.querySetId}') query_count,
          (select count(distinct normalized_query)::integer from search_queries
            where query_set_id = '${persisted.rows[0]!.query_set.querySetId}') distinct_queries,
          (select count(*)::integer from analysis_response_artifacts
            where provider_operation_id = po.id and artifact_complete) response_artifacts,
          (select count(*)::integer from workflow_events
            where workflow_id = rw.id
              and event_type = 'workflow_ready_for_search_intelligence') readiness_events,
          r.report_status, r.current_revision_reference report_reference,
          (select count(*)::integer from report_results rr
            where rr.public_id = r.legacy_public_id) result_rows
        from research_workflows rw
        join research_steps rs on rs.workflow_id = rw.id
          and rs.step_key = 'search_query_discovery'
        join provider_operations po on po.step_id = rs.id
        join report_cost_budgets b on b.workflow_id = rw.id
        join reports r on r.id = rw.report_id
        where rw.id = '${fixture.workflowId}'
      `);
      expect(persisted.rows[0]!.query_set.queryCount).toBe(15);
      expect(state.rows[0]).toEqual({
        workflow_status: "ready_for_search_intelligence",
        phase: "search_intelligence",
        step_status: "succeeded",
        spent: 5,
        reserved: 0,
        receipts: 1,
        query_count: 15,
        distinct_queries: 15,
        response_artifacts: 1,
        readiness_events: 1,
        report_status: "queued",
        report_reference: null,
        result_rows: 0
      });
    } finally {
      await db.exec("rollback");
    }
  });

  it("rejects conflicting settlement outcome, identity, exact cost, and currency", async () => {
    await db.exec("begin");
    try {
      const fixture = await setupCapturedProfileSettlementFixture(
        db,
        "settlement-conflict.example",
        "z"
      );
      const settlementInput = {
        ...fixture.profile,
        providerAttemptId: null,
        outcome: "succeeded" as const,
        classification: null,
        safeCode: null,
        safeSummary: null,
        retryAt: "null",
        outputReference: fixture.outputReference
      };
      await db.query(settleProviderSql(settlementInput));

      await expectSqlFailure(db, "settlement_outcome_conflict", () => db.query(
        settleProviderSql({
          ...settlementInput,
          outcome: "cancelled",
          outputReference: null
        })
      ), /provider_settlement_idempotency_conflict/);
      await expectSqlFailure(db, "settlement_identity_conflict", () => db.query(
        settleProviderSql({
          ...settlementInput,
          workflowAttemptId: "00000000-0000-4000-8000-000000000008"
        })
      ), /provider_settlement_idempotency_conflict/);
      await expectSqlFailure(db, "settlement_cost_conflict", async () => {
        await db.query(`update provider_operations set actual_cost_cents = 2
          where id = '${fixture.profile.operationId}'`);
        return db.query(settleProviderSql(settlementInput));
      }, /provider_settlement_idempotency_conflict/);
      await expectSqlFailure(db, "settlement_currency_conflict", async () => {
        await db.query(`update provider_operations set currency_code = 'EUR'
          where id = '${fixture.profile.operationId}'`);
        return db.query(settleProviderSql(settlementInput));
      }, /provider_settlement_currency_conflict/);

      const unchanged = await db.query<{
        spent: number;
        receipts: number;
        events: number;
      }>(`
        select b.spent_cents spent,
          (select count(*)::integer from provider_operation_settlements
            where provider_operation_id = po.id) receipts,
          (select count(*)::integer from workflow_events
            where workflow_id = po.workflow_id
              and event_type = 'provider_operation_succeeded'
              and safe_metadata ->> 'step' = 'company_profile_extraction') events
        from provider_operations po
        join report_cost_budgets b on b.workflow_id = po.workflow_id
        where po.id = '${fixture.profile.operationId}'
      `);
      expect(unchanged.rows[0]).toEqual({ spent: 3, receipts: 1, events: 1 });
    } finally {
      await db.exec("rollback");
    }
  });

  it("recovers a persisted paid response through the audited administrator transition", async () => {
    await db.exec("begin");
    try {
      const fixture = await setupCapturedProfileSettlementFixture(
        db,
        "settlement-recovery.example",
        "r"
      );
      const queueBefore = (await db.query<{ count: number }>(`
        select count(*)::integer count from pgmq.q_v3_report_workflows
      `)).rows[0]!.count;
      await db.query(`update workflow_leases
        set expires_at = now() - interval '1 second'
        where workflow_id = '${fixture.workflowId}'
          and step_id = (select id from research_steps
            where workflow_id = '${fixture.workflowId}'
              and step_key = 'company_profile_extraction')
          and released_at is null`);

      const recovery = `select admin_transition_research_workflow(
        '${fixture.workflowId}', 'recover_settled_step',
        'company_profile_extraction', 'pr4-test-admin', now()
      )`;
      await db.query(recovery);
      await db.query(recovery);

      const state = await db.query<{
        workflow_status: string;
        step_status: string;
        attempts: number;
        running_attempts: number;
        receipts: number;
        spent: number;
        reserved: number;
        queue_count: number;
        recovery_events: number;
        audits: number;
        active_leases: number;
      }>(`
        select rw.status workflow_status, rs.status step_status,
          rs.attempt_count attempts,
          (select count(*)::integer from research_attempts
            where step_id = rs.id and outcome = 'running') running_attempts,
          (select count(*)::integer from provider_operation_settlements
            where provider_operation_id = po.id) receipts,
          b.spent_cents spent, b.reserved_cents reserved,
          (select count(*)::integer from pgmq.q_v3_report_workflows) queue_count,
          (select count(*)::integer from workflow_events
            where workflow_id = rw.id
              and event_type = 'administrator_settled_step_recovered') recovery_events,
          (select count(*)::integer from audit_logs
            where entity_id = rw.id
              and event_type = 'administrator_settled_step_recovered') audits,
          (select count(*)::integer from workflow_leases
            where workflow_id = rw.id and released_at is null) active_leases
        from research_workflows rw
        join research_steps rs on rs.workflow_id = rw.id
          and rs.step_key = 'company_profile_extraction'
        join provider_operations po on po.step_id = rs.id
        join report_cost_budgets b on b.workflow_id = rw.id
        where rw.id = '${fixture.workflowId}'
      `);
      expect(state.rows[0]).toEqual({
        workflow_status: "dispatch_pending",
        step_status: "succeeded",
        attempts: 1,
        running_attempts: 0,
        receipts: 1,
        spent: 3,
        reserved: 0,
        queue_count: queueBefore + 1,
        recovery_events: 1,
        audits: 1,
        active_leases: 0
      });
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

async function beginWorkflowStep(
  db: PGlite,
  workflowId: string,
  kind: "website_research" | "company_profile_extraction" | "search_query_discovery",
  owner: string
) {
  const result = await db.query<{
    payload: { disposition: string; attemptId: string; lease: { fencingToken: number } };
  }>(`select begin_research_step(
    '${workflowId}', '${kind}', ${sqlLiteral(owner)}, 120, now()
  ) payload`);
  expect(result.rows[0]?.payload.disposition).toBe("acquired");
  return {
    workflowAttemptId: result.rows[0]!.payload.attemptId,
    fencingToken: result.rows[0]!.payload.lease.fencingToken
  };
}

async function beginLeasedProviderOperation(
  db: PGlite,
  input: {
    workflowId: string;
    kind: "website_research" | "company_profile_extraction" | "search_query_discovery";
    provider: "firecrawl" | "openai" | "mock";
    owner: string;
    suffix: string;
    cost: number;
  }
) {
  const lease = await beginWorkflowStep(db, input.workflowId, input.kind, input.owner);
  const ensured = await db.query<{ operation: { id: string } }>(ensureOperationSql({
    workflowId: input.workflowId,
    kind: input.kind,
    provider: input.provider,
    suffix: input.suffix,
    cost: input.cost
  }));
  const operationId = ensured.rows[0]!.operation.id;
  await db.query(`select reserve_v3_provider_operation_cost('${operationId}', now())`);
  const submit = await db.query<{ attempt: { attemptId: string } }>(`
    select begin_provider_operation_attempt('${operationId}', 'submit', now()) attempt
  `);
  let providerAttemptId = submit.rows[0]!.attempt.attemptId;
  if (input.kind === "website_research") {
    await db.query(`select record_provider_job(
      '${operationId}', '${providerAttemptId}', 'job-${input.suffix}', 200,
      '{}'::jsonb, now(), now()
    )`);
    const poll = await db.query<{ attempt: { attemptId: string } }>(`
      select begin_provider_operation_attempt('${operationId}', 'poll', now()) attempt
    `);
    providerAttemptId = poll.rows[0]!.attempt.attemptId;
  }
  return {
    operationId,
    providerAttemptId,
    workflowAttemptId: lease.workflowAttemptId,
    owner: input.owner,
    fencingToken: lease.fencingToken,
    outputReference: `provider-operation:${operationId}`
  };
}

function settleProviderSql(input: {
  operationId: string;
  providerAttemptId: string | null;
  workflowAttemptId: string;
  owner: string;
  fencingToken: number;
  outcome: "succeeded" | "definitively_rejected" | "transient_retryable" | "outcome_uncertain" | "cancelled";
  classification: string | null;
  safeCode: string | null;
  safeSummary: string | null;
  retryAt: string;
  outputReference?: string | null;
}) {
  return `select settle_v3_provider_operation(
    '${input.operationId}', ${input.providerAttemptId ? `'${input.providerAttemptId}'` : "null"},
    '${input.workflowAttemptId}', ${sqlLiteral(input.owner)}, ${input.fencingToken},
    '${input.outcome}', ${input.classification ? sqlLiteral(input.classification) : "null"},
    null, ${input.safeCode ? sqlLiteral(input.safeCode) : "null"},
    ${input.safeSummary ? sqlLiteral(input.safeSummary) : "null"},
    ${input.retryAt}, ${input.outputReference ? sqlLiteral(input.outputReference) : "null"}, now()
  )`;
}

async function completeAndSettleWebsite(
  db: PGlite,
  workflowId: string,
  suffix: string,
  reservedCostCents: number,
  actualCostCents: number
) {
  const operation = await beginLeasedProviderOperation(db, {
    workflowId,
    kind: "website_research",
    provider: "firecrawl",
    owner: `website-${suffix}`,
    suffix,
    cost: reservedCostCents
  });
  await db.query(storeWebsitePageSql({
    operationId: operation.operationId,
    content: `Website evidence for ${suffix}.`
  }));
  await db.query(`select complete_website_research_operation(
    '${operation.operationId}', '${operation.providerAttemptId}', 200,
    '{"creditsUsed":5}'::jsonb, ${actualCostCents}, now(), now()
  )`);
  await db.query(settleProviderSql({
    ...operation,
    providerAttemptId: null,
    outcome: "succeeded",
    classification: null,
    safeCode: null,
    safeSummary: null,
    retryAt: "null"
  }));
  return operation;
}

async function setupCapturedProfileSettlementFixture(
  db: PGlite,
  domain: string,
  seed: string
) {
  const context = await setupProviderWorkflow(db, domain, seed);
  const website = await beginLeasedProviderOperation(db, {
    workflowId: context.workflowId,
    kind: "website_research",
    provider: "firecrawl",
    owner: `captured-website-${seed}`,
    suffix: `captured-website-${seed}`,
    cost: 10
  });
  const websiteContent = [
    "Example Labs provides buyer research for B2B growth teams.",
    "Its documented methodology and public case studies help customers make evidence-based decisions."
  ].join(" ");
  await db.query(storeWebsitePageSql({
    operationId: website.operationId,
    content: websiteContent
  }));
  await db.query(`select complete_website_research_operation(
    '${website.operationId}', '${website.providerAttemptId}', 200,
    '{"creditsUsed":2}'::jsonb, 2, now(), now()
  )`);
  await db.query(settleProviderSql({
    ...website,
    providerAttemptId: null,
    outcome: "succeeded",
    classification: null,
    safeCode: null,
    safeSummary: null,
    retryAt: "null"
  }));

  const profile = await beginLeasedProviderOperation(db, {
    workflowId: context.workflowId,
    kind: "company_profile_extraction",
    provider: "openai",
    owner: `captured-profile-${seed}`,
    suffix: `captured-profile-${seed}`,
    cost: 25
  });
  const profileOutput = syntheticCompanyProfile(`https://${domain}/`);
  const responseText = JSON.stringify(profileOutput);
  const capture = await db.query<{ artifact: { id: string } }>(`
    select capture_v3_analysis_response(
      '${profile.operationId}', '${profile.providerAttemptId}',
      'resp-captured-${seed}', 'request-captured-${seed}', 'completed',
      'gpt-test', 'company-profile-v2', 'company-profile-schema-v2',
      now(), now(),
      '{"inputTokens":100,"outputTokens":25,"totalTokens":125,"cachedInputTokens":0}'::jsonb,
      1, ${sqlLiteral(responseText)}, null, null, null, true,
      '{"outputItemTypes":["message"],"messageStatuses":["completed"],"storedForRecovery":true,"outputTruncated":false}'::jsonb,
      now()
    ) artifact
  `);
  const artifactId = capture.rows[0]!.artifact.id;
  await db.query(`select record_v3_analysis_processing_result(
    '${artifactId}', 'parse', 'succeeded', null, null, null, now()
  )`);
  const persisted = await db.query<{ profile: { profileVersionId: string } }>(`
    select persist_company_profile(
      '${profile.operationId}', '${profile.providerAttemptId}', 'gpt-test',
      'resp-captured-${seed}', 'company-profile-v2',
      '${sha256(`captured-profile-input:${seed}`)}',
      '${sha256(responseText)}', 100, 25, 125,
      '{"inputTokens":100,"outputTokens":25,"totalTokens":125,"cachedInputTokens":0}'::jsonb,
      25, 1, now(), ${sqlJson(profileOutput)}, now(),
      now() + interval '48 hours', now()
    ) profile
  `);
  await db.query(`select record_v3_analysis_processing_result(
    '${artifactId}', 'complete', 'succeeded', null, null, null, now()
  )`);
  return {
    ...context,
    profile,
    artifactId,
    profileVersionId: persisted.rows[0]!.profile.profileVersionId,
    outputReference: `company-profile:${persisted.rows[0]!.profile.profileVersionId}`
  };
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
