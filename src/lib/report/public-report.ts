import { ZodError } from "zod";
import {
  publicOpportunityReportSchema,
  reportResponseSchema,
  type OpportunityReport,
  type ReportJob
} from "@/lib/report/schema";
import { IntakeCapacityError } from "@/lib/report/intake-store";
import type { SafeWorkflowProgress } from "@/lib/workflow/schema";

export const PUBLIC_REPORT_FAILURE_MESSAGE =
  "The report could not be completed. Please try again or use a different public website.";

const safeInputErrors = new Set([
  "Enter a website URL.",
  "Enter a valid website URL.",
  "Only public http and https websites can be analyzed.",
  "URLs with embedded credentials are not supported.",
  "Only standard public web ports can be analyzed.",
  "Only public websites can be analyzed.",
  "Private network addresses cannot be analyzed.",
  "That website could not be resolved.",
  "Enter a work email address.",
  "Enter a valid work email address.",
  "Disposable email addresses are not supported.",
  "That email domain is not eligible for a report.",
  "That website is not eligible for a report.",
  "The report request is too large.",
  "The report request is not valid JSON.",
  "Too many reports have been requested recently. Try again later."
]);

export function createPublicReportResponse(
  job: ReportJob,
  report: OpportunityReport | null,
  { publicId = job.publicId }: { publicId?: string } = {}
) {
  const failed = job.status === "failed";

  return reportResponseSchema.parse({
    job: {
      publicId,
      status: job.status,
      currentStep: job.currentStep,
      progress: job.progress,
      steps: job.steps.map((step) => ({
        id: step.id,
        label: step.label,
        status: step.status,
        detail: step.status === "failed" ? PUBLIC_REPORT_FAILURE_MESSAGE : step.detail
      })),
      errorSummary: failed ? PUBLIC_REPORT_FAILURE_MESSAGE : null
    },
    report: report ? publicOpportunityReportSchema.parse(report) : null
  });
}

export function createPublicWorkflowResponse(
  publicId: string,
  progress: SafeWorkflowProgress
) {
  const status =
    progress.state === "complete"
      ? "complete"
      : progress.state === "failed"
        ? "failed"
        : progress.state === "queued"
          ? "queued"
          : "running";

  return reportResponseSchema.parse({
    job: {
      publicId,
      status,
      currentStep: progress.currentStep,
      progress: progress.percent,
      steps: progress.steps.map((step) => ({
        ...step,
        detail: step.detail ?? undefined
      })),
      errorSummary: progress.errorSummary
    },
    report: null
  });
}

export function getPublicReportError(error: unknown) {
  if (error instanceof ZodError) {
    const field = error.issues[0]?.path[0];
    return {
      message:
        field === "email"
          ? "Enter a work email address."
          : field === "url"
            ? "Enter a valid website URL."
            : "The report request is invalid.",
      status: 400
    };
  }

  if (error instanceof IntakeCapacityError) {
    return {
      message: "Report capacity is temporarily limited. Try again later.",
      status: 429
    };
  }

  if (error instanceof Error && safeInputErrors.has(error.message)) {
    return {
      message: error.message,
      status: error.message.startsWith("Too many reports") ? 429 : 400
    };
  }

  return {
    message: "The report could not be started. Please try again.",
    status: 500
  };
}
