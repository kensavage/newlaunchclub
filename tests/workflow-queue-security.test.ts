// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEnv } from "@/lib/env";
import { getWorkflowQueue, setWorkflowQueueForTests } from "@/lib/workflow/queue-factory";
import { WorkflowConfigurationError } from "@/lib/workflow/store";
import {
  wakeWorkflowConsumer,
  wakeWorkflowConsumerBestEffort
} from "@/lib/workflow/wakeup-client";
import { resolveWorkflowWakeupOrigin, WORKFLOW_WAKEUP_PATH } from "@/lib/workflow/wakeup-runtime";

const root = process.cwd();
const migration = readFileSync(path.join(root, "supabase/migrations/0004_v3_supabase_queue.sql"), "utf8");
const backgroundFunction = readFileSync(path.join(root, "netlify/functions/v3-report-workflow-background.mts"), "utf8");
const scheduledFunction = readFileSync(path.join(root, "netlify/functions/wake-v3-report-workflows.mts"), "utf8");
const intakeRoute = readFileSync(path.join(root, "src/app/api/reports/route.ts"), "utf8");

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
    expect(scheduledFunction).toContain("wakeNetlifyWorkflowConsumer");
    expect(scheduledFunction).toContain('source: "scheduled"');
    expect(scheduledFunction).not.toMatch(/workflowId|reportRequestId|reportId|WORKFLOW_ADMIN_SECRET/);
  });

  it("records safe receiver acceptance and rejection outcomes", () => {
    expect(backgroundFunction).toContain('stage: "receiver"');
    expect(backgroundFunction).toContain('outcome: "accepted"');
    expect(backgroundFunction).toContain('outcome: "rejected"');
    expect(backgroundFunction).toContain('reason: "authentication_failed"');
    expect(backgroundFunction).not.toMatch(/console\.error|error\.message|JSON\.stringify\(request/);
  });

  it("attempts the immediate wake without relying on build-only Netlify metadata", () => {
    expect(intakeRoute).toContain("acknowledgement.shouldDispatch");
    expect(intakeRoute).toContain('source: "intake"');
    expect(intakeRoute).not.toContain("process.env.NETLIFY");
    expect(intakeRoute.indexOf("const acknowledgement = await createReportIntake")).toBeLessThan(
      intakeRoute.indexOf("await wakeWorkflowConsumerBestEffort")
    );
  });

  it("targets the exact Background Function path with no stale internal route", () => {
    expect(WORKFLOW_WAKEUP_PATH).toBe("/.netlify/functions/v3-report-workflow-background");
    expect(backgroundFunction).not.toContain("/api/internal/v3-workflow-wakeup");
    expect(scheduledFunction).not.toContain("/api/internal/v3-workflow-wakeup");
  });

  it("prefers the deploy origin and validates the configured fallback", () => {
    expect(resolveWorkflowWakeupOrigin({
      deployPrimeUrl: "https://deploy-preview-1--launchclub-new.netlify.app",
      fallbackUrl: "https://fallback.example"
    })).toBe("https://deploy-preview-1--launchclub-new.netlify.app");
    expect(resolveWorkflowWakeupOrigin({ fallbackUrl: "https://fallback.example" })).toBe("https://fallback.example");
    expect(resolveWorkflowWakeupOrigin({ fallbackUrl: "http://localhost:3000" })).toBe("http://localhost:3000");
    expect(() => resolveWorkflowWakeupOrigin({ fallbackUrl: "http://remote.example" })).toThrow(/HTTPS/);
    expect(() => resolveWorkflowWakeupOrigin({ fallbackUrl: "https://user:pass@fallback.example" })).toThrow(/bare origin/);
    expect(() => resolveWorkflowWakeupOrigin({ fallbackUrl: "https://fallback.example/path" })).toThrow(/bare origin/);
  });

  it("keeps queue and service-role credentials out of every client component", () => {
    const clientFiles = listFiles(path.join(root, "src")).filter((filePath) =>
      /^\s*["']use client["'];/m.test(readFileSync(filePath, "utf8"))
    );
    expect(clientFiles.length).toBeGreaterThan(0);
    for (const filePath of clientFiles) {
      const source = readFileSync(filePath, "utf8");
      expect(source, filePath).not.toMatch(/OPENAI_API_KEY|FIRECRAWL_API_KEY|SUPABASE_SERVICE_ROLE_KEY|WORKFLOW_WAKEUP_SECRET|WORKFLOW_ADMIN_SECRET|V3_PROVIDER_RESEARCH_ENABLED|pgmq|workflow\/queue/);
    }
  });

  it("rejects memory queue storage in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("REPORT_USE_MEMORY_STORE", "true");
    expect(() => getWorkflowQueue()).toThrow(WorkflowConfigurationError);
  });

  it("sends a signed empty wakeup with no workflow or administrator data", async () => {
    vi.stubEnv("DEPLOY_PRIME_URL", "https://deploy-preview-1--launchclub-new.netlify.app");
    const logger = vi.fn();
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe(`https://deploy-preview-1--launchclub-new.netlify.app${WORKFLOW_WAKEUP_PATH}`);
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
      nonce: "nonce_123456789012345678901234",
      source: "intake",
      logger
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(logger.mock.calls.map(([entry]) => entry)).toEqual([
      {
        event: "workflow_wakeup",
        stage: "dispatch",
        outcome: "attempted",
        source: "intake"
      },
      {
        event: "workflow_wakeup",
        stage: "dispatch",
        outcome: "accepted",
        source: "intake",
        httpStatus: 202
      }
    ]);
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(
      /queue-wakeup-secret|nonce_123456789012345678901234|workflowId|reportId/
    );
  });

  it("reports a safe dispatch failure while preserving best-effort behavior", async () => {
    const logger = vi.fn();
    const accepted = await wakeWorkflowConsumerBestEffort({
      env: {
        WORKFLOW_WAKEUP_SECRET: "queue-wakeup-secret-that-is-longer-than-thirty-two-characters",
        NEXT_PUBLIC_SITE_URL: "https://deploy-preview-1--launchclub-new.netlify.app"
      } as ServerEnv,
      fetcher: vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch,
      source: "intake",
      logger
    });

    expect(accepted).toBe(false);
    expect(logger.mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({ outcome: "attempted", source: "intake" }),
      expect.objectContaining({
        outcome: "failed",
        source: "intake",
        reason: "http_rejected",
        httpStatus: 503
      })
    ]);
    expect(JSON.stringify(logger.mock.calls)).not.toContain("queue-wakeup-secret");
  });

  it("does not hardcode a production origin in either runtime entry point", () => {
    const runtimeSources = [
      backgroundFunction,
      scheduledFunction,
      readFileSync(path.join(root, "netlify/runtime/wakeup-client.ts"), "utf8"),
      readFileSync(path.join(root, "src/lib/workflow/wakeup-runtime.ts"), "utf8")
    ].join("\n");
    expect(runtimeSources).not.toContain("https://launchclub.ai");
  });
});

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const filePath = path.join(directory, name);
    if (statSync(filePath).isDirectory()) return listFiles(filePath);
    return /\.[cm]?[jt]sx?$/.test(filePath) ? [filePath] : [];
  });
}
