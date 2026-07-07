import { describe, expect, it } from "vitest";
import {
  assertPublicHostname,
  isPrivateIp,
  normalizeSubmittedUrl
} from "@/lib/report/url";

describe("submitted URL normalization and SSRF protection", () => {
  it("normalizes public domains and strips query/hash noise", () => {
    expect(normalizeSubmittedUrl("launchclub.ai/?utm_source=test#hero")).toEqual({
      submittedUrl: "launchclub.ai/?utm_source=test#hero",
      normalizedUrl: "https://launchclub.ai/",
      domain: "launchclub.ai"
    });
  });

  it("rejects non-http schemes and embedded credentials", () => {
    expect(() => normalizeSubmittedUrl("file:///etc/passwd")).toThrow(/http and https/i);
    expect(() => normalizeSubmittedUrl("https://user:pass@example.com")).toThrow(/credentials/i);
  });

  it("blocks local hostnames and private IP ranges", () => {
    expect(() => assertPublicHostname("localhost")).toThrow(/public websites/i);
    expect(() => assertPublicHostname("app.internal")).toThrow(/public websites/i);
    expect(() => normalizeSubmittedUrl("http://127.0.0.1")).toThrow(/private network/i);
    expect(() => normalizeSubmittedUrl("http://192.168.0.12")).toThrow(/private network/i);
    expect(isPrivateIp("10.2.3.4")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });
});
