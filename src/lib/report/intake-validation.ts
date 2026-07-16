import net from "node:net";
import { domainToASCII } from "node:url";

const builtInDisposableDomains = new Set([
  "10minutemail.com",
  "guerrillamail.com",
  "maildrop.cc",
  "mailinator.com",
  "sharklasers.com",
  "temp-mail.org",
  "tempmail.com",
  "throwawaymail.com",
  "trashmail.com",
  "yopmail.com"
]);

export interface NormalizedWorkEmail {
  normalizedEmail: string;
  emailDomain: string;
}

export function normalizeWorkEmail(
  rawEmail: string,
  {
    blockedDomains = [],
    additionalDisposableDomains = []
  }: {
    blockedDomains?: string[];
    additionalDisposableDomains?: string[];
  } = {}
): NormalizedWorkEmail {
  const trimmed = rawEmail.trim().toLowerCase();

  if (!trimmed) {
    throw new Error("Enter a work email address.");
  }

  if (trimmed.length > 254 || /[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error("Enter a valid work email address.");
  }

  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex <= 0 || atIndex !== trimmed.indexOf("@")) {
    throw new Error("Enter a valid work email address.");
  }

  const localPart = trimmed.slice(0, atIndex);
  const rawDomain = trimmed.slice(atIndex + 1).replace(/\.$/, "");
  const emailDomain = domainToASCII(rawDomain).toLowerCase();

  if (
    !localPart ||
    localPart.length > 64 ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..") ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(localPart) ||
    !isValidPublicDomain(emailDomain)
  ) {
    throw new Error("Enter a valid work email address.");
  }

  const disposableDomains = new Set([
    ...builtInDisposableDomains,
    ...additionalDisposableDomains.map(normalizePolicyDomain)
  ]);

  if (isDomainCoveredByPolicy(emailDomain, [...disposableDomains])) {
    throw new Error("Disposable email addresses are not supported.");
  }

  if (isDomainCoveredByPolicy(emailDomain, blockedDomains)) {
    throw new Error("That email domain is not eligible for a report.");
  }

  return {
    normalizedEmail: `${localPart}@${emailDomain}`,
    emailDomain
  };
}

export function parseDomainPolicy(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map(normalizePolicyDomain)
    .filter(Boolean);
}

export function assertDomainAllowed(domain: string, blockedDomains: string[]) {
  if (isDomainCoveredByPolicy(domain, blockedDomains)) {
    throw new Error("That website is not eligible for a report.");
  }
}

export function isDomainCoveredByPolicy(domain: string, policyDomains: string[]) {
  const normalized = normalizePolicyDomain(domain);

  return policyDomains.some((policyDomain) => {
    const policy = normalizePolicyDomain(policyDomain);
    return Boolean(policy && (normalized === policy || normalized.endsWith(`.${policy}`)));
  });
}

export async function readJsonBodyWithLimit(request: Request, maximumBytes: number) {
  const declaredLength = Number(request.headers.get("content-length"));

  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("The report request is too large.");
  }

  if (!request.body) {
    throw new Error("The report request is not valid JSON.");
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel();
        throw new Error("The report request is too large.");
      }

      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("The report request is not valid JSON.");
  }
}

function normalizePolicyDomain(value: string) {
  return domainToASCII(value.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, ""));
}

function isValidPublicDomain(domain: string) {
  if (!domain || domain.length > 253 || net.isIP(domain) || !domain.includes(".")) {
    return false;
  }

  const labels = domain.split(".");
  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  );
}
