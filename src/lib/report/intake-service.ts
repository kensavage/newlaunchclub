import "server-only";
import crypto from "node:crypto";
import type { ServerEnv } from "@/lib/env";
import { getServerEnv } from "@/lib/env";
import {
  createPrivateFingerprint,
  deriveReportAccessToken,
  generateReportAccessToken,
  hashReportAccessToken,
  isReportAccessToken,
  verifyReportAccessToken
} from "@/lib/report/access-token";
import {
  reportIntakeRequestSchema,
  reportIntakeResponseSchema,
  type PrivacySafeRequestMetadata,
  type ReportIntakeResponse,
  type ResolvedReportAccess
} from "@/lib/report/intake-schema";
import { getReportIntakeStore } from "@/lib/report/intake-store-factory";
import type { ReportIntakeStore } from "@/lib/report/intake-store";
import {
  assertDomainAllowed,
  normalizeWorkEmail,
  parseDomainPolicy
} from "@/lib/report/intake-validation";
import { assertRateLimit } from "@/lib/report/rate-limit";
import { createInitialSteps } from "@/lib/report/steps";
import { createPublicId } from "@/lib/report/store";
import { assertPublicResolvableUrl, normalizeSubmittedUrl } from "@/lib/report/url";

export interface ReportRequestContext {
  ip: string;
  userAgent: string | null;
}

export interface ReportIntakeServiceDependencies {
  env?: ServerEnv;
  store?: ReportIntakeStore;
  now?: () => Date;
  assertResolvable?: (normalizedUrl: string) => Promise<void>;
  createProgressId?: () => string;
  createLegacyPublicId?: () => string;
}

export interface ReportIntakeAcknowledgement {
  response: ReportIntakeResponse;
  reportRequestId: string;
  reportId: string;
  shouldDispatch: boolean;
}

export async function createReportIntake(
  payload: unknown,
  context: ReportRequestContext,
  dependencies: ReportIntakeServiceDependencies = {}
): Promise<ReportIntakeAcknowledgement> {
  const env = dependencies.env ?? getServerEnv();
  const store = dependencies.store ?? getReportIntakeStore();
  const now = (dependencies.now ?? (() => new Date()))();
  const request = reportIntakeRequestSchema.parse(payload);
  const normalizedUrl = normalizeSubmittedUrl(request.url);
  const blockedDomains = parseDomainPolicy(env.REPORT_BLOCKED_DOMAINS);
  const disposableDomains = parseDomainPolicy(env.REPORT_DISPOSABLE_EMAIL_DOMAINS);
  const email = normalizeWorkEmail(request.email, {
    blockedDomains,
    additionalDisposableDomains: disposableDomains
  });

  assertDomainAllowed(normalizedUrl.domain, blockedDomains);

  if (!env.REPORT_USE_MOCK_PROVIDERS) {
    await (dependencies.assertResolvable ?? assertPublicResolvableUrl)(normalizedUrl.normalizedUrl);
  }

  const secret = getIntakeSecret(env);
  const idempotencyKey = request.idempotencyKey ?? crypto.randomUUID();
  const requestMetadata = createRequestMetadata(context, secret);
  const domainSignal = createPrivateFingerprint(secret, "intake-domain", normalizedUrl.domain);
  const contactSignal = createPrivateFingerprint(secret, "intake-contact", email.normalizedEmail);
  const rateLimitWindowMs = env.REPORT_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000;

  assertRateLimit(
    `intake:ip:${requestMetadata.requestSignalHash}`,
    env.REPORT_RATE_LIMIT_IP_COUNT,
    rateLimitWindowMs
  );
  assertRateLimit(
    `intake:domain:${domainSignal}`,
    env.REPORT_RATE_LIMIT_DOMAIN_COUNT,
    rateLimitWindowMs
  );
  assertRateLimit(
    `intake:contact:${contactSignal}`,
    env.REPORT_RATE_LIMIT_CONTACT_COUNT,
    rateLimitWindowMs
  );

  const accessToken = deriveReportAccessToken({
    secret,
    canonicalDomain: normalizedUrl.domain,
    normalizedEmail: email.normalizedEmail,
    idempotencyKey
  });
  const result = await store.createOrReuseIntake({
    canonicalDomain: normalizedUrl.domain,
    canonicalWebsiteUrl: normalizedUrl.canonicalWebsiteUrl,
    normalizedSubmittedUrl: normalizedUrl.normalizedUrl,
    normalizedEmail: email.normalizedEmail,
    emailDomain: email.emailDomain,
    submissionSource: request.source,
    idempotencyKeyHash: createPrivateFingerprint(secret, "idempotency", idempotencyKey),
    requestFingerprint: createPrivateFingerprint(
      secret,
      "report-request",
      JSON.stringify([normalizedUrl.domain, email.normalizedEmail])
    ),
    publicProgressId:
      dependencies.createProgressId?.() ?? `progress_${crypto.randomBytes(18).toString("base64url")}`,
    legacyPublicId: dependencies.createLegacyPublicId?.() ?? createPublicId(),
    accessTokenHash: hashReportAccessToken(accessToken),
    accessExpiresAt: addTime(now, env.REPORT_ACCESS_TOKEN_TTL_DAYS, "days"),
    legacyJobExpiresAt: addTime(now, env.REPORT_ACCESS_TOKEN_TTL_DAYS, "days"),
    visitorHash: createPrivateFingerprint(
      secret,
      "legacy-visitor",
      JSON.stringify([context.ip, normalizedUrl.domain])
    ),
    initialSteps: createInitialSteps(),
    pairCooldownSince: subtractTime(now, env.REPORT_REQUEST_COOLDOWN_HOURS, "hours"),
    domainCooldownSince: subtractTime(now, env.REPORT_DOMAIN_COOLDOWN_MINUTES, "minutes"),
    contactCooldownSince: subtractTime(now, env.REPORT_CONTACT_COOLDOWN_MINUTES, "minutes"),
    maxActivePerCompany: env.REPORT_MAX_ACTIVE_PER_COMPANY,
    maxActivePerContact: env.REPORT_MAX_ACTIVE_PER_CONTACT,
    rateLimitSince: subtractTime(now, env.REPORT_RATE_LIMIT_WINDOW_MINUTES, "minutes"),
    maxRequestsPerSignal: env.REPORT_RATE_LIMIT_IP_COUNT,
    requestMetadata
  });

  const response = reportIntakeResponseSchema.parse({
    requestStatus: result.requestStatus,
    progressId: result.publicProgressId,
    reportAccessToken: accessToken,
    reportUrl: `/reports/${encodeURIComponent(accessToken)}`,
    displayDomain: normalizedUrl.domain,
    createdAt: result.createdAt,
    nextAction: getNextAction(result.requestStatus),
    reused: result.reused
  });

  return {
    response,
    reportRequestId: result.reportRequestId,
    reportId: result.reportId,
    shouldDispatch: !result.reused && result.requestStatus === "queued"
  };
}

export async function resolveSecureReportAccess(
  rawToken: string,
  context: ReportRequestContext,
  dependencies: ReportIntakeServiceDependencies = {}
): Promise<ResolvedReportAccess | null> {
  if (!isReportAccessToken(rawToken)) return null;

  const env = dependencies.env ?? getServerEnv();
  const secret = getIntakeSecret(env);
  const store = dependencies.store ?? getReportIntakeStore();
  const now = (dependencies.now ?? (() => new Date()))().toISOString();
  const resolved = await store.resolveAccess(
    hashReportAccessToken(rawToken),
    createRequestMetadata(context, secret),
    now
  );

  if (
    !resolved ||
    Date.parse(resolved.expiresAt) <= Date.parse(now) ||
    !verifyReportAccessToken(rawToken, resolved.storedTokenHash)
  ) {
    return null;
  }

  return resolved;
}

export async function rotateSecureReportAccess(
  reportId: string,
  context: ReportRequestContext,
  dependencies: ReportIntakeServiceDependencies = {}
) {
  const env = dependencies.env ?? getServerEnv();
  const secret = getIntakeSecret(env);
  const store = dependencies.store ?? getReportIntakeStore();
  const now = (dependencies.now ?? (() => new Date()))();
  const rawToken = generateReportAccessToken();

  await store.rotateAccess(
    reportId,
    hashReportAccessToken(rawToken),
    addTime(now, env.REPORT_ACCESS_TOKEN_TTL_DAYS, "days"),
    createRequestMetadata(context, secret)
  );

  return rawToken;
}

export async function revokeSecureReportAccess(
  reportId: string,
  reason: string,
  dependencies: ReportIntakeServiceDependencies = {}
) {
  const store = dependencies.store ?? getReportIntakeStore();
  await store.revokeAccess(reportId, reason.slice(0, 120));
}

export function createRequestMetadata(
  context: ReportRequestContext,
  secret: string
): PrivacySafeRequestMetadata {
  return {
    requestSignalHash: createPrivateFingerprint(secret, "request-ip", context.ip),
    userAgentCategory: categorizeUserAgent(context.userAgent)
  };
}

function getIntakeSecret(env: ServerEnv) {
  const secret = env.REPORT_ACCESS_TOKEN_SECRET ?? env.REPORT_RATE_LIMIT_SALT;

  if (secret.length >= 32) return secret;

  if (process.env.NODE_ENV !== "production") {
    return crypto.createHash("sha256").update(`development-only:${secret}`).digest("hex");
  }

  throw new Error("Secure report intake is not configured.");
}

function categorizeUserAgent(userAgent: string | null): PrivacySafeRequestMetadata["userAgentCategory"] {
  if (!userAgent) return "unknown";
  return /bot|crawler|spider|preview|curl|wget/i.test(userAgent) ? "bot" : "browser";
}

function getNextAction(status: ReportIntakeResponse["requestStatus"]) {
  if (status === "complete") return "Open the report using the secure report link.";
  if (status === "running") return "Report generation is currently in progress.";
  if (status === "failed" || status === "cancelled") return "Submit a new request to try again.";
  return "The report is queued and will begin when processing is available.";
}

function addTime(date: Date, amount: number, unit: "days") {
  const milliseconds = unit === "days" ? amount * 24 * 60 * 60 * 1000 : 0;
  return new Date(date.getTime() + milliseconds).toISOString();
}

function subtractTime(date: Date, amount: number, unit: "hours" | "minutes") {
  const milliseconds =
    unit === "hours" ? amount * 60 * 60 * 1000 : amount * 60 * 1000;
  return new Date(date.getTime() - milliseconds).toISOString();
}
