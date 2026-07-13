import "server-only";
import crypto from "node:crypto";
import type { WorkflowQueue } from "@/lib/workflow/queue";

export const WORKFLOW_WAKEUP_PATH = "/api/internal/v3-workflow-wakeup";
export const WORKFLOW_WAKEUP_TIMESTAMP_HEADER = "x-launchclub-wakeup-timestamp";
export const WORKFLOW_WAKEUP_NONCE_HEADER = "x-launchclub-wakeup-nonce";
export const WORKFLOW_WAKEUP_SIGNATURE_HEADER = "x-launchclub-wakeup-signature";

export function createWorkflowWakeupHeaders(
  secret: string,
  options: { now?: Date; nonce?: string } = {}
) {
  assertWakeupSecret(secret);
  const timestamp = Math.floor((options.now ?? new Date()).getTime() / 1_000).toString();
  const nonce = options.nonce ?? crypto.randomBytes(24).toString("base64url");
  return {
    [WORKFLOW_WAKEUP_TIMESTAMP_HEADER]: timestamp,
    [WORKFLOW_WAKEUP_NONCE_HEADER]: nonce,
    [WORKFLOW_WAKEUP_SIGNATURE_HEADER]: sign(secret, timestamp, nonce)
  };
}

export async function verifyWorkflowWakeupRequest(
  request: Request,
  queue: Pick<WorkflowQueue, "consumeWakeupNonce">,
  options: { secret: string; ttlSeconds: number; now?: Date }
) {
  if (request.method !== "POST") return false;
  try {
    assertWakeupSecret(options.secret);
  } catch {
    return false;
  }

  const now = options.now ?? new Date();
  const timestamp = request.headers.get(WORKFLOW_WAKEUP_TIMESTAMP_HEADER) ?? "";
  const nonce = request.headers.get(WORKFLOW_WAKEUP_NONCE_HEADER) ?? "";
  const presented = request.headers.get(WORKFLOW_WAKEUP_SIGNATURE_HEADER) ?? "";
  if (!/^\d{10}$/.test(timestamp) || !/^[A-Za-z0-9_-]{24,128}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(presented)) {
    return false;
  }

  const timestampMilliseconds = Number(timestamp) * 1_000;
  if (Math.abs(now.getTime() - timestampMilliseconds) > options.ttlSeconds * 1_000) return false;
  if (!secureEqual(sign(options.secret, timestamp, nonce), presented)) return false;

  return queue.consumeWakeupNonce({
    nonceHash: crypto.createHash("sha256").update(nonce).digest("hex"),
    expiresAt: new Date(timestampMilliseconds + options.ttlSeconds * 1_000).toISOString(),
    now: now.toISOString()
  });
}

function sign(secret: string, timestamp: string, nonce: string) {
  return crypto
    .createHmac("sha256", secret)
    .update(`launchclub:v3-workflow-wakeup:${timestamp}:${nonce}`)
    .digest("hex");
}

function secureEqual(expected: string, presented: string) {
  const expectedBytes = Buffer.from(expected, "hex");
  const presentedBytes = Buffer.from(presented, "hex");
  return expectedBytes.length === presentedBytes.length && crypto.timingSafeEqual(expectedBytes, presentedBytes);
}

function assertWakeupSecret(secret: string) {
  if (secret.length < 32) throw new Error("Workflow wakeup authorization is not configured.");
}
