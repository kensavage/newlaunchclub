import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const migrationPath = path.join(
  repositoryRoot,
  "supabase/migrations/0002_v3_identity_intake_access.sql"
);
const migration = readFileSync(migrationPath, "utf8");

describe("V3 identity and secure-access migration contract", () => {
  it.each([
    "companies",
    "company_contacts",
    "leads",
    "report_requests",
    "reports",
    "report_access_tokens",
    "report_access_events",
    "audit_logs"
  ])("creates relational table %s", (tableName) => {
    expect(migration).toMatch(new RegExp(`create table if not exists public\\.${tableName} \\(`));
    expect(migration).toContain(`alter table public.${tableName} enable row level security;`);
    expect(migration).toContain(
      `revoke all privileges on table public.${tableName} from anon, authenticated;`
    );
  });

  it("uses server-only security-definer RPCs with an empty search path", () => {
    for (const functionName of [
      "create_report_intake",
      "resolve_report_access",
      "rotate_report_access",
      "revoke_report_access",
      "is_protected_report_legacy_id"
    ]) {
      expect(migration).toContain(`function public.${functionName}(`);
      expect(migration).toMatch(
        new RegExp(
          `function public\\.${functionName}\\([\\s\\S]*?security definer[\\s\\S]*?set search_path = ''`
        )
      );
      expect(migration).toContain(`grant execute on function public.${functionName}(`);
    }
  });

  it("stores token hashes instead of raw access tokens", () => {
    expect(migration).toContain("token_hash text not null unique");
    expect(migration).toContain("report_access_tokens_one_active_idx");
    expect(migration).not.toMatch(/raw[_ ]access[_ ]token/i);
    expect(migration).not.toMatch(/raw[_ ]token/i);
  });

  it("keeps privileged Supabase credentials out of client components", () => {
    const clientFiles = listFiles(path.join(repositoryRoot, "src")).filter((filePath) => {
      const source = readFileSync(filePath, "utf8");
      return /^\s*["']use client["'];/m.test(source);
    });

    expect(clientFiles.length).toBeGreaterThan(0);
    for (const filePath of clientFiles) {
      const source = readFileSync(filePath, "utf8");
      expect(source, filePath).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(source, filePath).not.toContain("@/lib/env");
      expect(source, filePath).not.toContain("supabase-intake-store");
    }

    expect(
      readFileSync(path.join(repositoryRoot, "src/lib/report/supabase-intake-store.ts"), "utf8")
    ).toMatch(/^import "server-only";/);
  });
});

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const filePath = path.join(directory, name);
    if (statSync(filePath).isDirectory()) return listFiles(filePath);
    return /\.[cm]?[jt]sx?$/.test(filePath) ? [filePath] : [];
  });
}
