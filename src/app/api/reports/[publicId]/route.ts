import { NextResponse } from "next/server";
import { reportResponseSchema } from "@/lib/report/schema";
import { getServerEnv } from "@/lib/env";
import { normalizeOpportunityReportForResponse } from "@/lib/report/normalize-report";
import { getReportStore } from "@/lib/report/store-factory";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ publicId: string }> }
) {
  const env = getServerEnv();
  const { publicId } = await params;
  const store = getReportStore();
  const job = await store.getJob(publicId);

  if (!job) {
    return NextResponse.json({ error: "Report not found." }, { status: 404 });
  }

  const storedReport = job.status === "complete" ? await store.getReport(publicId) : null;
  const report = storedReport
    ? normalizeOpportunityReportForResponse({
        report: storedReport,
        bookingUrl: env.NEXT_PUBLIC_BOOK_CALL_URL,
        enableRealAiChecks: env.ENABLE_REAL_AI_CHECKS
      })
    : null;
  const response = reportResponseSchema.parse({ job, report });

  return NextResponse.json(response);
}
