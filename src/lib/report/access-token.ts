import "server-only";
import crypto from "node:crypto";

const REPORT_ACCESS_TOKEN_PREFIX = "lc_report_";
const REPORT_ACCESS_TOKEN_PATTERN = /^lc_report_[A-Za-z0-9_-]{43}$/;

export function generateReportAccessToken() {
  return `${REPORT_ACCESS_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

export function deriveReportAccessToken({
  secret,
  canonicalDomain,
  normalizedEmail,
  idempotencyKey
}: {
  secret: string;
  canonicalDomain: string;
  normalizedEmail: string;
  idempotencyKey: string;
}) {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(
      JSON.stringify([
        "launchclub-report-access-v1",
        canonicalDomain,
        normalizedEmail,
        idempotencyKey
      ])
    )
    .digest("base64url");

  return `${REPORT_ACCESS_TOKEN_PREFIX}${digest}`;
}

export function hashReportAccessToken(rawToken: string) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export function verifyReportAccessToken(rawToken: string, storedHash: string) {
  if (!isReportAccessToken(rawToken) || !/^[a-f0-9]{64}$/i.test(storedHash)) {
    return false;
  }

  const actual = Buffer.from(hashReportAccessToken(rawToken), "hex");
  const expected = Buffer.from(storedHash, "hex");

  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function isReportAccessToken(value: string) {
  return REPORT_ACCESS_TOKEN_PATTERN.test(value);
}

export function createPrivateFingerprint(secret: string, purpose: string, value: string) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${purpose}:${value}`)
    .digest("hex");
}

export function createIdempotencyKey() {
  return crypto.randomUUID();
}
