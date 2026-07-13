import { loadEnvConfig } from "@next/env";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

loadEnvConfig(process.cwd());

async function main() {
  const { WorkflowAdministratorService, createServerCliAdminActor } = await import("../src/lib/workflow/admin-service");
  const { getWorkflowStore } = await import("../src/lib/workflow/store-factory");
  const [command = "help", ...args] = process.argv.slice(2);
  const store = getWorkflowStore();
  const service = new WorkflowAdministratorService(store, createServerCliAdminActor());

  if (command === "list") {
    const status = option(args, "--status");
    const limit = Number(option(args, "--limit") ?? 50);
    const stalledMinutes = option(args, "--stalled-minutes");
    print(await service.list({ status, limit, stalledMinutes: stalledMinutes ? Number(stalledMinutes) : undefined }));
  } else if (command === "show") {
    print(await service.show(required(args[0], "workflow ID")));
  } else if (command === "retry") {
    await service.retry(required(args[0], "workflow ID"));
    print({ ok: true });
  } else if (command === "retry-step") {
    await service.retryStep(required(args[0], "workflow ID"), required(args[1], "step key"));
    print({ ok: true });
  } else if (command === "pause") {
    await service.pause(required(args[0], "workflow ID"));
    print({ ok: true });
  } else if (command === "resume") {
    await service.resume(required(args[0], "workflow ID"));
    print({ ok: true });
  } else if (command === "cancel") {
    const workflowId = required(args[0], "workflow ID");
    const confirmed = args.includes("--yes") || await confirm(`Cancel workflow ${workflowId}? Type CANCEL to continue: `);
    if (!confirmed) throw new Error("Cancellation was not confirmed.");
    await service.cancel(workflowId);
    print({ ok: true });
  } else if (command === "release-expired-lease") {
    print({ released: await service.releaseExpiredLease(required(args[0], "workflow ID"), required(args[1], "step key")) });
  } else {
    stdout.write([
      "Launch Club research administrator CLI",
      "",
      "Commands:",
      "  list [--status STATUS] [--limit N] [--stalled-minutes N]",
      "  show WORKFLOW_ID",
      "  retry WORKFLOW_ID",
      "  retry-step WORKFLOW_ID STEP_KEY",
      "  pause WORKFLOW_ID",
      "  resume WORKFLOW_ID",
      "  cancel WORKFLOW_ID [--yes]",
      "  release-expired-lease WORKFLOW_ID STEP_KEY",
      ""
    ].join("\n"));
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Administrator command failed."}\n`);
  process.exitCode = 1;
});

function option(args: string[], key: string) {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(value: string | undefined, label: string) {
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
}

async function confirm(prompt: string) {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return (await readline.question(prompt)).trim() === "CANCEL";
  } finally {
    readline.close();
  }
}

function print(value: unknown) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
