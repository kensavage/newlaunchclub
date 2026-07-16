import { describe, expect, it } from "vitest";
import {
  assertDomainAllowed,
  isDomainCoveredByPolicy,
  normalizeWorkEmail,
  parseDomainPolicy,
  readJsonBodyWithLimit
} from "@/lib/report/intake-validation";

describe("report intake validation", () => {
  it("normalizes work email addresses and internationalized domains", () => {
    expect(normalizeWorkEmail(" OWNER@BÜCHER.DE ")).toEqual({
      normalizedEmail: "owner@xn--bcher-kva.de",
      emailDomain: "xn--bcher-kva.de"
    });
  });

  it("rejects invalid and reliably known disposable email addresses", () => {
    expect(() => normalizeWorkEmail("missing-at-symbol.example.com")).toThrow(/valid work email/i);
    expect(() => normalizeWorkEmail("person@mailinator.com")).toThrow(/disposable/i);
    expect(() =>
      normalizeWorkEmail("person@temporary.example", {
        additionalDisposableDomains: ["temporary.example"]
      })
    ).toThrow(/disposable/i);
  });

  it("applies suffix-aware configurable domain policies", () => {
    const policy = parseDomainPolicy(" blocked.example, *.denied.example ");

    expect(isDomainCoveredByPolicy("app.blocked.example", policy)).toBe(true);
    expect(isDomainCoveredByPolicy("notblocked.example", policy)).toBe(false);
    expect(() => assertDomainAllowed("shop.denied.example", policy)).toThrow(/not eligible/i);
    expect(() =>
      normalizeWorkEmail("owner@app.blocked.example", { blockedDomains: policy })
    ).toThrow(/not eligible/i);
  });

  it("rejects request bodies over the configured byte limit", async () => {
    const request = new Request("https://launchclub.ai/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", padding: "x".repeat(100) })
    });

    await expect(readJsonBodyWithLimit(request, 32)).rejects.toThrow(/too large/i);
  });

  it("returns a safe validation error for malformed JSON", async () => {
    const request = new Request("https://launchclub.ai/api/reports", {
      method: "POST",
      body: "{not-json"
    });

    await expect(readJsonBodyWithLimit(request, 1_024)).rejects.toThrow(/not valid JSON/i);
  });
});
