import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { isReportAccessToken } from "@/lib/report/access-token";
import { resolveSecureReportAccess } from "@/lib/report/intake-service";
import { getReportIntakeStore } from "@/lib/report/intake-store-factory";
import { normalizeOpportunityReportForResponse } from "@/lib/report/normalize-report";
import { createPublicReportResponse } from "@/lib/report/public-report";
import { getRequestIp } from "@/lib/report/rate-limit";
import { getReportStore } from "@/lib/report/store-factory";

export const runtime = "nodejs";

const legacyPublicIdPattern = /^[a-f0-9]{18}$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> }
) {
  try {
    const env = getServerEnv();
    const { publicId: routeIdentifier } = await params;
    const requestContext = {
      ip: getRequestIp(request),
      userAgent: request.headers.get("user-agent")
    };
    let legacyPublicId: string;
    let responsePublicId: string;

    if (isReportAccessToken(routeIdentifier)) {
      const access = await resolveSecureReportAccess(routeIdentifier, requestContext);
      if (!access) return reportNotFound();
      legacyPublicId = access.legacyPublicId;
      responsePublicId = routeIdentifier;
    } else if (legacyPublicIdPattern.test(routeIdentifier)) {
      const protectedBySecureAccess = await getReportIntakeStore().isLegacyIdProtected(routeIdentifier);
      if (protectedBySecureAccess) return reportNotFound();
      legacyPublicId = routeIdentifier;
      responsePublicId = routeIdentifier;
    } else {
      return reportNotFound();
    }

    const store = getReportStore();
    const job = await store.getJob(legacyPublicId);
    if (!job) return reportNotFound();

    const storedReport = job.status === "complete" ? await store.getReport(legacyPublicId) : null;
    const normalizedReport = storedReport
      ? normalizeOpportunityReportForResponse({
          report: storedReport,
          bookingUrl: env.NEXT_PUBLIC_BOOK_CALL_URL
        })
      : null;
    const report = normalizedReport
      ? {
          ...normalizedReport,
          publicId: responsePublicId
        }
      : null;

    return NextResponse.json(
      createPublicReportResponse(job, report, { publicId: responsePublicId }),
      { headers: responseHeaders() }
    );
  } catch {
    return NextResponse.json(
      { error: "The report could not be loaded. Please try again." },
      { status: 500, headers: responseHeaders() }
    );
  }
}

function reportNotFound() {
  return NextResponse.json(
    { error: "Report not found." },
    { status: 404, headers: responseHeaders() }
  );
}

function responseHeaders() {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive"
  };
}
