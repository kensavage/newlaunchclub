import { describe, expect, it } from "vitest";
import {
  createPrivateFingerprint,
  deriveReportAccessToken,
  generateReportAccessToken,
  hashReportAccessToken,
  isReportAccessToken,
  verifyReportAccessToken
} from "@/lib/report/access-token";

describe("secure report access tokens", () => {
  it("generates opaque 256-bit tokens with a recognizable non-secret prefix", () => {
    const first = generateReportAccessToken();
    const second = generateReportAccessToken();

    expect(first).not.toBe(second);
    expect(isReportAccessToken(first)).toBe(true);
    expect(first).toMatch(/^lc_report_[A-Za-z0-9_-]{43}$/);
  });

  it("derives a stable retry token without exposing the signing secret", () => {
    const input = {
      secret: "a-secure-test-secret-that-is-longer-than-32-characters",
      canonicalDomain: "example.com",
      normalizedEmail: "owner@example.com",
      idempotencyKey: "retry-key-123456789"
    };

    const first = deriveReportAccessToken(input);
    const second = deriveReportAccessToken(input);

    expect(first).toBe(second);
    expect(first).not.toContain(input.secret);
    expect(isReportAccessToken(first)).toBe(true);
  });

  it("stores and verifies only a one-way token hash", () => {
    const rawToken = generateReportAccessToken();
    const tokenHash = hashReportAccessToken(rawToken);

    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHash).not.toContain(rawToken);
    expect(verifyReportAccessToken(rawToken, tokenHash)).toBe(true);
    expect(verifyReportAccessToken(generateReportAccessToken(), tokenHash)).toBe(false);
    expect(verifyReportAccessToken("not-a-token", tokenHash)).toBe(false);
  });

  it("creates stable privacy-safe fingerprints with purpose separation", () => {
    const secret = "another-secure-test-secret-that-is-at-least-32-characters";
    expect(createPrivateFingerprint(secret, "ip", "127.0.0.1")).not.toBe(
      createPrivateFingerprint(secret, "email", "127.0.0.1")
    );
  });
});
