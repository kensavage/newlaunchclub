import { z } from "zod";
import type { ReportStep } from "@/lib/report/schema";

export const intakeSubmissionSourceSchema = z.enum([
  "homepage_hero",
  "homepage_footer",
  "blog_footer",
  "contact_footer",
  "website_report_form"
]);

export const reportIntakeRequestSchema = z.object({
  url: z.string().min(1).max(2048),
  email: z.string().min(1).max(254),
  idempotencyKey: z
    .string()
    .trim()
    .min(16)
    .max(200)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .optional(),
  source: intakeSubmissionSourceSchema.default("website_report_form")
});

export const reportRequestStatusSchema = z.enum([
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled"
]);

export const reportIntakeResponseSchema = z.object({
  requestStatus: reportRequestStatusSchema,
  progressId: z.string().min(20),
  reportAccessToken: z.string().min(40),
  reportUrl: z.string().startsWith("/reports/"),
  displayDomain: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  nextAction: z.string().min(1),
  reused: z.boolean()
});

export type IntakeSubmissionSource = z.infer<typeof intakeSubmissionSourceSchema>;
export type ReportRequestStatus = z.infer<typeof reportRequestStatusSchema>;
export type ReportIntakeRequest = z.infer<typeof reportIntakeRequestSchema>;
export type ReportIntakeResponse = z.infer<typeof reportIntakeResponseSchema>;

export interface PrivacySafeRequestMetadata {
  requestSignalHash: string;
  userAgentCategory: "browser" | "bot" | "unknown";
}

export interface CreateReportIntakeInput {
  canonicalDomain: string;
  canonicalWebsiteUrl: string;
  normalizedSubmittedUrl: string;
  normalizedEmail: string;
  emailDomain: string;
  submissionSource: IntakeSubmissionSource;
  idempotencyKeyHash: string;
  requestFingerprint: string;
  publicProgressId: string;
  legacyPublicId: string;
  accessTokenHash: string;
  accessExpiresAt: string;
  legacyJobExpiresAt: string;
  visitorHash: string;
  initialSteps: ReportStep[];
  pairCooldownSince: string;
  domainCooldownSince: string;
  contactCooldownSince: string;
  maxActivePerCompany: number;
  maxActivePerContact: number;
  rateLimitSince: string;
  maxRequestsPerSignal: number;
  requestMetadata: PrivacySafeRequestMetadata;
}

export interface ReportIntakeResult {
  companyId: string;
  contactId: string;
  leadId: string;
  reportRequestId: string;
  reportId: string;
  accessTokenId: string;
  publicProgressId: string;
  legacyPublicId: string;
  requestStatus: ReportRequestStatus;
  createdAt: string;
  reused: boolean;
}

export interface ResolvedReportAccess {
  reportId: string;
  reportRequestId: string;
  accessTokenId: string;
  storedTokenHash: string;
  tokenStatus: "active";
  expiresAt: string;
  publicProgressId: string;
  displayDomain: string;
  legacyPublicId: string;
  requestStatus: ReportRequestStatus;
  createdAt: string;
}
