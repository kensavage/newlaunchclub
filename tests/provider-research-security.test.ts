// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const researchDirectory = path.join(root, "src/lib/research");
const researchSources = [
  ...listFiles(researchDirectory),
  path.join(root, "netlify/runtime/provider-research-runtime.ts"),
  path.join(root, "netlify/functions/v3-report-workflow-background.mts")
].map((filePath) => readFileSync(filePath, "utf8")).join("\n");
const migration = [
  "0005_v3_provider_research_evidence.sql",
  "0006_v3_provider_failure_settlement.sql"
].map((name) => readFileSync(path.join(root, "supabase/migrations", name), "utf8")).join("\n");
const envSchema = readFileSync(path.join(root, "src/lib/env-schema.ts"), "utf8");

describe("PR4 provider research security and scope boundaries", () => {
  it("keeps every provider control and credential server-only", () => {
    expect(envSchema).toContain("V3_PROVIDER_RESEARCH_ENABLED");
    expect(envSchema).toContain("V3_PROVIDER_MAX_RESERVATION_CENTS");
    expect(envSchema).not.toMatch(/NEXT_PUBLIC_(?:V3_PROVIDER|OPENAI|FIRECRAWL|SUPABASE_SERVICE)/);
    for (const filePath of listFiles(path.join(root, "src"))) {
      const source = readFileSync(filePath, "utf8");
      if (!/^\s*["']use client["'];/m.test(source)) continue;
      expect(source, filePath).not.toMatch(
        /OPENAI_API_KEY|FIRECRAWL_API_KEY|SUPABASE_SERVICE_ROLE_KEY|V3_PROVIDER_RESEARCH_ENABLED/
      );
    }
  });

  it("keeps PR4 independent from the V2 paid report pipeline and all PR5 providers", () => {
    expect(researchSources).not.toMatch(/@\/lib\/providers\/|runReportJob|report\/pipeline/);
    expect(researchSources).not.toMatch(/Ahrefs|DataForSEO|RedditProvider|YouTube|podcast/i);
    expect(researchSources).not.toMatch(/report_results|report_jobs|sendgrid|mailgun|resend/i);
    expect(researchSources).not.toMatch(/next\/|from ["']server-only["']/);
  });

  it("never completes a report or performs delivery in PR4 migrations", () => {
    expect(migration).toContain("ready_for_search_intelligence");
    expect(migration).not.toMatch(/set\s+status\s*=\s*'completed'/i);
    expect(migration).not.toMatch(/insert\s+into\s+public\.(?:report_results|report_jobs)/i);
    expect(migration).not.toMatch(/email|sendgrid|mailgun|resend/i);
  });

  it("grants privileged research operations only to the service role", () => {
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toMatch(/grant execute on function public\.prepare_v3_provider_research[\s\S]+to service_role/);
    for (const functionName of [
      "reserve_v3_provider_operation_cost",
      "settle_v3_provider_operation",
      "block_v3_provider_configuration",
      "admin_reconcile_v3_provider_operation"
    ]) {
      expect(migration).toContain(`function public.${functionName}(`);
      expect(migration).toMatch(new RegExp(
        `revoke execute on function public\\.${functionName}\\([\\s\\S]+?from public, anon, authenticated;`
      ));
      expect(migration).toMatch(new RegExp(
        `grant execute on function public\\.${functionName}\\([\\s\\S]+?to service_role;`
      ));
    }
    expect(migration).toContain("alter table public.provider_operation_reconciliations enable row level security");
    expect(migration).not.toMatch(/grant[^;]+(?:anon|authenticated)/i);
  });
});

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const filePath = path.join(directory, name);
    if (statSync(filePath).isDirectory()) return listFiles(filePath);
    return /\.[cm]?[jt]sx?$/.test(filePath) ? [filePath] : [];
  });
}
