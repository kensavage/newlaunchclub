import dns from "node:dns/promises";
import net from "node:net";

const blockedHostnamePattern = /(^|\.)localhost$|(^|\.)local$|(^|\.)internal$/i;

export interface NormalizedSubmittedUrl {
  submittedUrl: string;
  normalizedUrl: string;
  domain: string;
}

export function normalizeSubmittedUrl(rawUrl: string): NormalizedSubmittedUrl {
  const trimmed = rawUrl.trim();

  if (!trimmed) {
    throw new Error("Enter a website URL.");
  }

  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;

  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error("Enter a valid website URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only public http and https websites can be analyzed.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not supported.");
  }

  parsed.hash = "";
  parsed.search = "";

  const hostname = parsed.hostname.toLowerCase();
  assertPublicHostname(hostname);

  return {
    submittedUrl: trimmed,
    normalizedUrl: parsed.toString(),
    domain: hostname.replace(/^www\./, "")
  };
}

export function assertPublicHostname(hostname: string) {
  if (blockedHostnamePattern.test(hostname)) {
    throw new Error("Only public websites can be analyzed.");
  }

  if (hostname === "0.0.0.0" || hostname === "::" || hostname === "::1") {
    throw new Error("Private network addresses cannot be analyzed.");
  }

  if (net.isIP(hostname) && isPrivateIp(hostname)) {
    throw new Error("Private network addresses cannot be analyzed.");
  }
}

export async function assertPublicResolvableUrl(normalizedUrl: string) {
  const { hostname } = new URL(normalizedUrl);
  const records = await dns.lookup(hostname, { all: true, verbatim: false });

  if (!records.length) {
    throw new Error("That website could not be resolved.");
  }

  if (records.some((record) => isPrivateIp(record.address))) {
    throw new Error("Private network addresses cannot be analyzed.");
  }
}

export function isPrivateIp(address: string) {
  if (address.includes(":")) {
    const value = address.toLowerCase();
    return (
      value === "::1" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("fe80:") ||
      value === "::"
    );
  }

  const parts = address.split(".").map(Number);

  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }

  const [a, b] = parts;

  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}
