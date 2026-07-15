import crypto from "node:crypto";
import type { OpportunityReport, ReportJob, ReportStepId } from "@/lib/report/schema";
import { RESEARCH_READY_PROGRESS_DETAIL } from "@/lib/workflow/schema";

export interface CreateReportJobInput {
  publicId: string;
  submittedUrl: string;
  normalizedUrl: string;
  domain: string;
  visitorHash: string;
}

export interface VendorEventInput {
  publicId: string;
  provider: string;
  endpoint: string;
  purpose: string;
  status: "success" | "error" | "skipped";
  durationMs: number;
  errorSummary?: string;
  estimatedCost?: number;
}

export interface ReportStore {
  createJob(input: CreateReportJobInput): Promise<ReportJob>;
  getJob(publicId: string): Promise<ReportJob | null>;
  updateJob(
    publicId: string,
    patch: Partial<
      Pick<ReportJob, "status" | "currentStep" | "progress" | "steps" | "errorSummary">
    >
  ): Promise<ReportJob>;
  saveReport(publicId: string, report: OpportunityReport): Promise<void>;
  getReport(publicId: string): Promise<OpportunityReport | null>;
  findRecentCompletedReportByDomain(domain: string): Promise<{ job: ReportJob; report: OpportunityReport } | null>;
  recordVendorEvent(event: VendorEventInput): Promise<void>;
}

export function createPublicId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 18);
}

export function createExpiryDate(days = 30) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function createNow() {
  return new Date().toISOString();
}

export function sanitizeError(error: unknown) {
  if (error instanceof Error) {
    return error.message.slice(0, 280);
  }

  return "Unexpected report generation error.";
}

export function getStepDetail(step: ReportStepId) {
  const details: Record<ReportStepId, string> = {
    queued: "The report job is waiting to start.",
    crawl: "Reading the homepage and same-domain pages linked from it so the report understands the business.",
    analysis: "Identifying the company, category, primary keyword, and buyer queries.",
    keywords: "Checking keyword demand and search-result surfaces.",
    research_ready: RESEARCH_READY_PROGRESS_DETAIL,
    reddit: "Looking for relevant discussions and subreddit opportunities.",
    "ai-search": "Creating AI-search prompt and citation opportunity examples.",
    synthesis: "Prioritizing the low-hanging fruit and formatting the report.",
    complete: "The report is ready.",
    failed: "The report could not be completed."
  };

  return details[step];
}
