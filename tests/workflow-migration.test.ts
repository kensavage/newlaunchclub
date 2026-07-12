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
    for (const name of ["0001_ai_search_report_tables.sql", "0002_v3_identity_intake_access.sql", "0003_v3_durable_workflow.sql"]) {
      let sql = await readFile(path.join(process.cwd(), "supabase/migrations", name), "utf8");
      if (name.startsWith("0001")) sql = sql.replace("create extension if not exists pgcrypto;", "");
      await db.exec(sql);
    }
  }, 30_000);

  afterAll(async () => db.close());

  it("creates workflow, steps, budget, and outbox atomically through the real intake RPC without a new legacy link", async () => {
    const result = await db.query<{ reused: boolean; legacy_public_id: string | null; report_request_id: string }>(intakeSql());
    expect(result.rows[0]).toMatchObject({ reused: false, legacy_public_id: null });
    const counts = await db.query<{ workflows: number; steps: number; outbox: number; legacy_jobs: number; budget_cents: number }>(`
      select
        (select count(*)::integer from research_workflows) workflows,
        (select count(*)::integer from research_steps) steps,
        (select count(*)::integer from outbox_events) outbox,
        (select count(*)::integer from report_jobs) legacy_jobs,
        (select limit_cents from report_cost_budgets limit 1) budget_cents
    `);
    expect(counts.rows[0]).toEqual({ workflows: 1, steps: 5, outbox: 1, legacy_jobs: 0, budget_cents: 400 });

    const duplicate = await db.query<{ reused: boolean }>(intakeSql());
    expect(duplicate.rows[0]?.reused).toBe(true);
    expect((await db.query<{ count: number }>("select count(*)::integer count from research_workflows")).rows[0]?.count).toBe(1);
  });

  it("uses SKIP LOCKED outbox claims and survives send-before-ack crashes", async () => {
    const first = await db.query<{ payload: Array<{ id: string }> }>("select claim_workflow_outbox('owner-one', 1, 60, '2030-01-01T00:00:00Z') payload");
    expect(first.rows[0]?.payload).toHaveLength(1);
    const blocked = await db.query<{ payload: unknown[] }>("select claim_workflow_outbox('owner-two', 1, 60, '2030-01-01T00:00:30Z') payload");
    expect(blocked.rows[0]?.payload).toHaveLength(0);
    const reclaimed = await db.query<{ payload: Array<{ id: string }> }>("select claim_workflow_outbox('owner-two', 1, 60, '2030-01-01T00:01:01Z') payload");
    expect(reclaimed.rows[0]?.payload).toHaveLength(1);
    const oldAck = await db.query<{ accepted: boolean }>(`select mark_workflow_outbox_sent('${reclaimed.rows[0]!.payload[0]!.id}', 'owner-one', 'late-event') accepted`);
    expect(oldAck.rows[0]?.accepted).toBe(false);
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
});

function intakeSql() {
  return `select * from create_report_intake(
    'example.com', 'https://example.com/', 'https://example.com/', 'owner@example.com',
    'example.com', 'homepage_hero', '${"a".repeat(64)}', '${"b".repeat(64)}',
    'progress_12345678901234567890', 'aaaaaaaaaaaaaaaaaa', '${"c".repeat(64)}',
    now() + interval '365 days', now() + interval '365 days', '${"d".repeat(64)}', '[]'::jsonb,
    now() - interval '24 hours', now() - interval '60 minutes', now() - interval '60 minutes',
    2, 2, now() - interval '60 minutes', 10,
    jsonb_build_object('requestSignalHash', '${"e".repeat(64)}', 'userAgentCategory', 'browser')
  )`;
}
