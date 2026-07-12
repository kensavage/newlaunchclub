import { ZodError } from "zod";
import {
  publicOpportunityReportSchema,
  reportResponseSchema,
  type OpportunityReport,
  type ReportJob
} from "@/lib/report/schema";

export const PUBLIC_REPORT_FAILURE_MESSAGE =
  "The report could not be completed. Please try again or use a different public website.";

const safeInputErrors = new Set([
  "Enter a website URL.",
  "Enter a valid website URL.",
  "Only public http and https websites can be analyzed.",
  "URLs with embedded credentials are not supported.",
  "Only public websites can be analyzed.",
  "Private network addresses cannot be analyzed.",
  "That website could not be resolved.",
  "Too many reports have been requested recently. Try again later."
]);

export function createPublicReportResponse(job: ReportJob, report: OpportunityReport | null) {
  const failed = job.status === "failed";

  return reportResponseSchema.parse({
    job: {
      publicId: job.publicId,
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

export function getPublicReportError(error: unknown) {
  if (error instanceof ZodError) {
    return { message: "Enter a valid website URL.", status: 400 };
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
