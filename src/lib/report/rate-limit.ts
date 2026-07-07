import crypto from "node:crypto";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function hashVisitorKey(value: string, salt: string) {
  return crypto.createHash("sha256").update(`${salt}:${value}`).digest("hex");
}

export function assertRateLimit(key: string, limit = 5, windowMs = 60 * 60 * 1000) {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  if (bucket.count >= limit) {
    throw new Error("Too many reports have been requested recently. Try again later.");
  }

  bucket.count += 1;
}

export function getRequestIp(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (
    forwardedFor ||
    request.headers.get("x-nf-client-connection-ip") ||
    request.headers.get("x-real-ip") ||
    "local"
  );
}
