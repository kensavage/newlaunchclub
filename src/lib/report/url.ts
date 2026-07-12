import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import net from "node:net";

const blockedHostnamePattern =
  /(^|\.)(localhost|local|internal|home|lan)$|^(metadata|metadata\.google\.internal)$/i;

export interface NormalizedSubmittedUrl {
  submittedUrl: string;
  normalizedUrl: string;
  domain: string;
  canonicalWebsiteUrl: string;
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

  if (parsed.port && !isStandardWebPort(parsed.protocol, parsed.port)) {
    throw new Error("Only standard public web ports can be analyzed.");
  }

  parsed.hash = "";
  parsed.search = "";
  parsed.hostname = parsed.hostname.replace(/\.$/, "").toLowerCase();

  const hostname = stripIpv6Brackets(parsed.hostname);
  assertPublicHostname(hostname);

  return {
    submittedUrl: trimmed,
    normalizedUrl: parsed.toString(),
    domain: hostname.replace(/^www\./, ""),
    canonicalWebsiteUrl: `${parsed.protocol}//${parsed.host}/`
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

  if (!net.isIP(hostname) && !hostname.includes(".")) {
    throw new Error("Only public websites can be analyzed.");
  }
}

export async function assertPublicResolvableUrl(normalizedUrl: string) {
  const hostname = stripIpv6Brackets(new URL(normalizedUrl).hostname);
  let records: LookupAddress[];

  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("That website could not be resolved.");
  }

  if (!records.length) {
    throw new Error("That website could not be resolved.");
  }

  if (records.some((record) => isPrivateIp(record.address))) {
    throw new Error("Private network addresses cannot be analyzed.");
  }
}

export function isPrivateIp(address: string) {
  const normalizedAddress = stripIpv6Brackets(address).split("%")[0].toLowerCase();

  if (net.isIP(normalizedAddress) === 6) {
    const value = parseIpv6(normalizedAddress);
    if (value === null) return true;

    const mappedPrefix = ipv6Cidr("::ffff:0:0", 96);
    if (isInIpv6Cidr(value, mappedPrefix)) {
      const mappedIpv4 = ((value[6] << 16) | value[7]) >>> 0;
      return isPrivateIp(
        [mappedIpv4 >>> 24, (mappedIpv4 >>> 16) & 255, (mappedIpv4 >>> 8) & 255, mappedIpv4 & 255].join(
          "."
        )
      );
    }

    return blockedIpv6Cidrs.some((cidr) => isInIpv6Cidr(value, cidr));
  }

  const parts = normalizedAddress.split(".").map(Number);

  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [a, b, c] = parts;

  return (
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a === 0 ||
    a >= 224
  );
}

export async function assertSafeRedirectTarget(redirectUrl: string) {
  const normalized = normalizeSubmittedUrl(redirectUrl);
  await assertPublicResolvableUrl(normalized.normalizedUrl);
  return normalized;
}

function isStandardWebPort(protocol: string, port: string) {
  return (protocol === "http:" && port === "80") || (protocol === "https:" && port === "443");
}

function stripIpv6Brackets(value: string) {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

interface Ipv6Cidr {
  network: number[];
  prefixLength: number;
}

const blockedIpv6Cidrs = [
  ipv6Cidr("::", 128),
  ipv6Cidr("::1", 128),
  ipv6Cidr("64:ff9b:1::", 48),
  ipv6Cidr("100::", 64),
  ipv6Cidr("2001::", 23),
  ipv6Cidr("2001:db8::", 32),
  ipv6Cidr("2002::", 16),
  ipv6Cidr("3fff::", 20),
  ipv6Cidr("5f00::", 16),
  ipv6Cidr("fc00::", 7),
  ipv6Cidr("fe80::", 10),
  ipv6Cidr("ff00::", 8)
];

function ipv6Cidr(address: string, prefixLength: number): Ipv6Cidr {
  const value = parseIpv6(address);
  if (value === null) throw new Error("Invalid internal IPv6 CIDR.");
  return { network: value, prefixLength };
}

function isInIpv6Cidr(value: number[], { network, prefixLength }: Ipv6Cidr) {
  if (prefixLength === 0) return true;
  const completeGroups = Math.floor(prefixLength / 16);
  const remainingBits = prefixLength % 16;

  for (let index = 0; index < completeGroups; index += 1) {
    if (value[index] !== network[index]) return false;
  }

  if (remainingBits === 0) return true;
  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return (value[completeGroups] & mask) === (network[completeGroups] & mask);
}

function parseIpv6(address: string): number[] | null {
  let value = address;

  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const ipv4 = value.slice(lastColon + 1).split(".").map(Number);
    if (
      ipv4.length !== 4 ||
      ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
      return null;
    }
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    value = `${value.slice(0, lastColon)}:${high}:${low}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || omitted < 0) return null;

  const groups = [...left, ...Array.from({ length: omitted }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[a-f0-9]{1,4}$/i.test(group))) {
    return null;
  }

  return groups.map((group) => Number.parseInt(group, 16));
}
