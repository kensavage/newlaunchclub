import { describe, expect, it } from "vitest";
import {
  assertPublicHostname,
  assertSafeRedirectTarget,
  isPrivateIp,
  normalizeSubmittedUrl
} from "@/lib/report/url";

describe("submitted URL normalization and SSRF protection", () => {
  it("normalizes public domains and strips query/hash noise", () => {
    expect(normalizeSubmittedUrl("launchclub.ai/?utm_source=test#hero")).toEqual({
      submittedUrl: "launchclub.ai/?utm_source=test#hero",
      normalizedUrl: "https://launchclub.ai/",
      domain: "launchclub.ai",
      canonicalWebsiteUrl: "https://launchclub.ai/"
    });
  });

  it("normalizes internationalized domains and preserves a safe submitted path", () => {
    expect(normalizeSubmittedUrl("https://BÜCHER.de/catalog?source=test")).toEqual({
      submittedUrl: "https://BÜCHER.de/catalog?source=test",
      normalizedUrl: "https://xn--bcher-kva.de/catalog",
      domain: "xn--bcher-kva.de",
      canonicalWebsiteUrl: "https://xn--bcher-kva.de/"
    });
  });

  it("rejects non-http schemes and embedded credentials", () => {
    expect(() => normalizeSubmittedUrl("file:///etc/passwd")).toThrow(/http and https/i);
    expect(() => normalizeSubmittedUrl("https://user:pass@example.com")).toThrow(/credentials/i);
    expect(() => normalizeSubmittedUrl("https://example.com:8443")).toThrow(/standard public web ports/i);
  });

  it("blocks local hostnames and private IP ranges", () => {
    expect(() => assertPublicHostname("localhost")).toThrow(/public websites/i);
    expect(() => assertPublicHostname("app.internal")).toThrow(/public websites/i);
    expect(() => normalizeSubmittedUrl("http://127.0.0.1")).toThrow(/private network/i);
    expect(() => normalizeSubmittedUrl("http://192.168.0.12")).toThrow(/private network/i);
    expect(() => normalizeSubmittedUrl("http://[::1]")).toThrow(/private network/i);
    expect(() => normalizeSubmittedUrl("http://[::ffff:127.0.0.1]")).toThrow(/private network/i);
    expect(isPrivateIp("10.2.3.4")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("2001:db8::1")).toBe(true);
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });

  it("rejects a redirect target that crosses into a private address", async () => {
    await expect(assertSafeRedirectTarget("http://127.0.0.1/latest/meta-data")).rejects.toThrow(
      /private network/i
    );
  });
});
