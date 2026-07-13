// @vitest-environment node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("PR3 isolated PostgreSQL migration", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec("create role anon; create role authenticated; create role service_role;");
    for (const name of ["0001_ai_search_report_tables.sql", "0002_v3_identity_intake_access.sql", "0003_v3_durable_workflow.sql", "0004_v3_supabase_queue.sql"]) {
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
});

function intakeSql(domain = "example.com", seed = "a") {
  const seedCode = seed.charCodeAt(0).toString(16).slice(-1);
  return `select * from create_report_intake(
    '${domain}', 'https://${domain}/', 'https://${domain}/', 'owner@${domain}',
    '${domain}', 'homepage_hero', '${seedCode.repeat(64)}', '${(seedCode === "b" ? "c" : "b").repeat(64)}',
    'progress_${seed.repeat(20)}', '${seed.repeat(18)}', '${(seedCode === "c" ? "d" : "c").repeat(64)}',
    now() + interval '365 days', now() + interval '365 days', '${(seedCode === "d" ? "e" : "d").repeat(64)}', '[]'::jsonb,
    now() - interval '24 hours', now() - interval '60 minutes', now() - interval '60 minutes',
    2, 2, now() - interval '60 minutes', 10,
    jsonb_build_object('requestSignalHash', '${"e".repeat(64)}', 'userAgentCategory', 'browser')
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
