// @vitest-environment node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zipFunction } from "@netlify/zip-it-and-ship-it";

const root = process.cwd();
const functionSources = [
  "netlify/functions/v3-report-workflow-background.mts",
  "netlify/functions/wake-v3-report-workflows.mts"
] as const;

type FunctionSource = (typeof functionSources)[number];
type BundleResult = NonNullable<Awaited<ReturnType<typeof zipFunction>>> & {
  inputs?: string[];
};

describe.sequential("standalone Netlify function runtime bundles", () => {
  const bundles = new Map<FunctionSource, BundleResult>();
  let outputDirectory = "";

  beforeAll(async () => {
    outputDirectory = mkdtempSync(path.join(tmpdir(), "launchclub-netlify-runtime-"));
    for (const source of functionSources) {
      const result = await zipFunction(source, outputDirectory, {
        archiveFormat: "none",
        basePath: root,
        repositoryRoot: root,
        config: {
          "*": {
            nodeBundler: "esbuild",
            nodeVersion: "22.x"
          }
        }
      });
      if (!result) throw new Error(`Netlify did not emit a bundle for ${source}.`);
      bundles.set(source, result as BundleResult);
    }
  }, 30_000);

  afterAll(() => {
    if (outputDirectory) rmSync(outputDirectory, { recursive: true, force: true });
  });

  it.each(functionSources)("loads the emitted %s function module", (source) => {
    const result = bundles.get(source)!;
    const emittedModule = path.join(
      result.path,
      path.relative(root, result.mainFile).replace(/\.[^.]+$/, ".mjs")
    );
    expect(existsSync(emittedModule)).toBe(true);

    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", `import(${JSON.stringify(pathToFileURL(emittedModule).href)})`],
      {
        encoding: "utf8",
        env: {
          HOME: process.env.HOME ?? "",
          PATH: process.env.PATH ?? "",
          NODE_ENV: "production",
          NEXT_PUBLIC_SITE_URL: "https://deploy-preview-1--launchclub-new.netlify.app",
          REPORT_USE_MEMORY_STORE: "false",
          SUPABASE_SERVICE_ROLE_KEY: "runtime-smoke-placeholder-not-a-real-key",
          SUPABASE_URL: "https://runtime-smoke-placeholder.supabase.co",
          WORKFLOW_WAKEUP_SECRET: "runtime-smoke-wakeup-secret-at-least-32-characters"
        }
      }
    );

    expect(child.status, `${child.stderr}\n${child.stdout}`).toBe(0);
  });

  it.each(functionSources)("keeps %s free of Next-only runtime dependencies", (source) => {
    const inputs = bundles.get(source)!.inputs ?? [];
    expect(inputs.some((input) => /node_modules[/\\]server-only(?:[/\\]|$)/.test(input))).toBe(false);
    expect(inputs.some((input) => /node_modules[/\\]next(?:[/\\]|$)/.test(input))).toBe(false);
    expect(inputs.some((input) => /src[/\\]lib[/\\]env\.ts$/.test(input))).toBe(false);
  });

  it("preserves the background and scheduled invocation modes", () => {
    expect(bundles.get(functionSources[0])?.invocationMode).toBe("background");
    expect(bundles.get(functionSources[1])?.schedule).toBe("*/5 * * * *");
  });
});
