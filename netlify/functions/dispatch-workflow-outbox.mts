import crypto from "node:crypto";
import { getServerEnv } from "../../src/lib/env";
import { getWorkflowDispatcher, getWorkflowStore } from "../../src/lib/workflow/store-factory";
import { dispatchWorkflowOutbox } from "../../src/lib/workflow/outbox-dispatcher";

export default async function dispatchPendingOutbox(request: Request) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = getServerEnv().WORKFLOW_ADMIN_SECRET;
  const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret || !secureEqual(secret, presented)) return new Response("Not found", { status: 404 });
  const store = getWorkflowStore();
  const result = await dispatchWorkflowOutbox(store, getWorkflowDispatcher(store), {
    leaseSeconds: getServerEnv().WORKFLOW_OUTBOX_LEASE_SECONDS
  });
  return Response.json(result, { status: result.deferred ? 202 : 200 });
}

function secureEqual(expected: string, presented: string) {
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  const presentedHash = crypto.createHash("sha256").update(presented).digest();
  return crypto.timingSafeEqual(expectedHash, presentedHash);
}
