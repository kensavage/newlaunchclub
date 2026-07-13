import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { createPrivateFingerprint, isReportAccessToken } from "@/lib/report/access-token";
import { createRequestMetadata, resolveSecureReportAccess } from "@/lib/report/intake-service";
import { getReportIntakeStore } from "@/lib/report/intake-store-factory";
import { normalizeOpportunityReportForResponse } from "@/lib/report/normalize-report";
import { createPublicReportResponse, createPublicWorkflowResponse } from "@/lib/report/public-report";
import { getRequestIp } from "@/lib/report/rate-limit";
import { getReportStore } from "@/lib/report/store-factory";
import { getWorkflowStore } from "@/lib/workflow/store-factory";

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
    let legacyPublicId: string | null;
    let responsePublicId: string;
    let grandfatheredLegacyAccess = false;

    if (isReportAccessToken(routeIdentifier)) {
      const access = await resolveSecureReportAccess(routeIdentifier, requestContext);
      if (!access) return reportNotFound();
      const progress = await getWorkflowStore().getPublicProgress(access.reportRequestId);
      if (progress) {
        return NextResponse.json(createPublicWorkflowResponse(routeIdentifier, progress), {
          headers: responseHeaders()
        });
      }
      legacyPublicId = access.legacyPublicId;
      responsePublicId = routeIdentifier;
    } else if (legacyPublicIdPattern.test(routeIdentifier)) {
      const protectedBySecureAccess = await getReportIntakeStore().isLegacyIdProtected(routeIdentifier);
      if (protectedBySecureAccess) return reportNotFound();
      legacyPublicId = routeIdentifier;
      responsePublicId = routeIdentifier;
      grandfatheredLegacyAccess = true;
    } else {
      return reportNotFound();
    }

    if (!legacyPublicId) return reportNotFound();
    const store = getReportStore();
    const job = await store.getJob(legacyPublicId);
    if (!job) return reportNotFound();

    if (grandfatheredLegacyAccess) {
      const secret = env.REPORT_ACCESS_TOKEN_SECRET ?? env.REPORT_RATE_LIMIT_SALT;
      const metadata = createRequestMetadata(requestContext, secret);
      await getWorkflowStore().recordLegacyAccess({
        legacyPublicIdHash: createPrivateFingerprint(secret, "legacy-report-link", legacyPublicId),
        requestSignalHash: metadata.requestSignalHash,
        userAgentCategory: metadata.userAgentCategory
      });
    }

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
