// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEnv } from "@/lib/env";
import { getWorkflowQueue, setWorkflowQueueForTests } from "@/lib/workflow/queue-factory";
import { WorkflowConfigurationError } from "@/lib/workflow/store";
import { wakeWorkflowConsumer } from "@/lib/workflow/wakeup-client";

const root = process.cwd();
const migration = readFileSync(path.join(root, "supabase/migrations/0004_v3_supabase_queue.sql"), "utf8");
const backgroundFunction = readFileSync(path.join(root, "netlify/functions/v3-report-workflow-background.mts"), "utf8");
const scheduledFunction = readFileSync(path.join(root, "netlify/functions/wake-v3-report-workflows.mts"), "utf8");

describe("workflow queue security boundaries", () => {
  afterEach(() => {
    setWorkflowQueueForTests(null);
    vi.unstubAllEnvs();
  });

  it("creates one Basic logged queue without pgmq_public browser exposure", () => {
    expect(migration).toContain("pgmq.create('v3_report_workflows')");
    expect(migration).not.toContain("create_unlogged");
    expect(migration).not.toContain("pgmq_public");
    expect(migration).toContain("revoke all on schema pgmq from public, anon, authenticated");
    expect(migration).toContain("grant execute on function public.read_v3_workflow_messages(integer, integer) to service_role");
    expect(migration).not.toMatch(/grant[^;]+(?:anon|authenticated)/i);
  });

  it("authorizes the Background Function before reading queue messages", () => {
    expect(backgroundFunction).toContain("verifyWorkflowWakeupRequest");
    expect(backgroundFunction.indexOf("verifyWorkflowWakeupRequest")).toBeLessThan(
      backgroundFunction.indexOf("consumer.consume()")
    );
    expect(backgroundFunction).not.toContain("WORKFLOW_ADMIN_SECRET");
    expect(backgroundFunction).not.toContain("authorization");
  });

  it("keeps the scheduled wakeup payload-free and separate from administration", () => {
    expect(scheduledFunction).toContain("wakeWorkflowConsumer");
    expect(scheduledFunction).not.toMatch(/workflowId|reportRequestId|reportId|WORKFLOW_ADMIN_SECRET/);
  });

  it("keeps queue and service-role credentials out of every client component", () => {
    const clientFiles = listFiles(path.join(root, "src")).filter((filePath) =>
      /^\s*["']use client["'];/m.test(readFileSync(filePath, "utf8"))
    );
    expect(clientFiles.length).toBeGreaterThan(0);
    for (const filePath of clientFiles) {
      const source = readFileSync(filePath, "utf8");
      expect(source, filePath).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|WORKFLOW_WAKEUP_SECRET|WORKFLOW_ADMIN_SECRET|pgmq|workflow\/queue/);
    }
  });

  it("rejects memory queue storage in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("REPORT_USE_MEMORY_STORE", "true");
    expect(() => getWorkflowQueue()).toThrow(WorkflowConfigurationError);
  });

  it("sends a signed empty wakeup with no workflow or administrator data", async () => {
    const fetcher = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeUndefined();
      expect(JSON.stringify(init?.headers)).not.toMatch(/workflowId|reportId|WORKFLOW_ADMIN_SECRET/);
      return new Response(null, { status: 202 });
    });
    await wakeWorkflowConsumer({
      env: {
        WORKFLOW_WAKEUP_SECRET: "queue-wakeup-secret-that-is-longer-than-thirty-two-characters",
        NEXT_PUBLIC_SITE_URL: "https://preview.example"
      } as ServerEnv,
      fetcher: fetcher as typeof fetch,
      now: new Date("2026-01-01T00:00:00.000Z"),
      nonce: "nonce_123456789012345678901234"
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const filePath = path.join(directory, name);
    if (statSync(filePath).isDirectory()) return listFiles(filePath);
    return /\.[cm]?[jt]sx?$/.test(filePath) ? [filePath] : [];
  });
}
