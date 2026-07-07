import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerEnv } from "@/lib/env";
import {
  assertPublicResolvableUrl,
  normalizeSubmittedUrl
} from "@/lib/report/url";
import {
  assertRateLimit,
  getRequestIp,
  hashVisitorKey
} from "@/lib/report/rate-limit";
import { getReportStore } from "@/lib/report/store-factory";
import { createPublicId, sanitizeError } from "@/lib/report/store";
import { triggerReportWorker } from "@/lib/report/worker-client";

export const runtime = "nodejs";

const createReportRequestSchema = z.object({
  url: z.string().min(1).max(2048)
});

export async function POST(request: Request) {
  const env = getServerEnv();

  try {
    const body = createReportRequestSchema.parse(await request.json());
    const normalized = normalizeSubmittedUrl(body.url);

    if (!env.REPORT_USE_MOCK_PROVIDERS) {
      await assertPublicResolvableUrl(normalized.normalizedUrl);
    }

    const ip = getRequestIp(request);
    const visitorHash = hashVisitorKey(`${ip}:${normalized.domain}`, env.REPORT_RATE_LIMIT_SALT);

    const store = getReportStore();
    const cached = await store.findRecentCompletedReportByDomain(normalized.domain);

    if (cached) {
      return NextResponse.json(
        {
          publicId: cached.job.publicId,
          reportUrl: `/reports/${cached.job.publicId}`,
          reused: true
        },
        { status: 200 }
      );
    }

    assertRateLimit(visitorHash);

    const job = await store.createJob({
      publicId: createPublicId(),
      submittedUrl: normalized.submittedUrl,
      normalizedUrl: normalized.normalizedUrl,
      domain: normalized.domain,
      visitorHash
    });

    await triggerReportWorker(job.publicId);

    return NextResponse.json(
      {
        publicId: job.publicId,
        reportUrl: `/reports/${job.publicId}`,
        reused: false
      },
      { status: 202 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: sanitizeError(error)
      },
      { status: 400 }
    );
  }
}
