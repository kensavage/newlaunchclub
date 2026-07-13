import crypto from "node:crypto";
import type { WorkflowQueue } from "@/lib/workflow/queue-runtime";

export const WORKFLOW_WAKEUP_PATH = "/.netlify/functions/v3-report-workflow-background";
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

export function resolveWorkflowWakeupOrigin(options: {
  preferredUrl?: string;
  deployPrimeUrl?: string;
  fallbackUrl?: string;
}) {
  const candidate = options.preferredUrl ?? options.deployPrimeUrl ?? options.fallbackUrl;
  if (!candidate) throw new Error("Workflow wakeup destination is not configured.");

  const url = new URL(candidate);
  const isLocalHttp = url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error("Workflow wakeup destination must use HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Workflow wakeup destination must be a bare origin.");
  }
  return url.origin;
}

export async function sendWorkflowWakeup(options: {
  secret?: string;
  fallbackUrl?: string;
  deployPrimeUrl?: string;
  preferredUrl?: string;
  fetcher?: typeof fetch;
  now?: Date;
  nonce?: string;
}) {
  if (!options.secret) throw new Error("Workflow wakeup authorization is not configured.");
  const origin = resolveWorkflowWakeupOrigin(options);
  const url = new URL(WORKFLOW_WAKEUP_PATH, origin);
  const response = await (options.fetcher ?? fetch)(url, {
    method: "POST",
    headers: createWorkflowWakeupHeaders(options.secret, {
      now: options.now,
      nonce: options.nonce
    }),
    redirect: "error",
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error("Workflow consumer wakeup was not accepted.");
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

function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
