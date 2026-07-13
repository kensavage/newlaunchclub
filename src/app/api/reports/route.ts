import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { createReportIntake } from "@/lib/report/intake-service";
import { readJsonBodyWithLimit } from "@/lib/report/intake-validation";
import { getPublicReportError } from "@/lib/report/public-report";
import { getRequestIp } from "@/lib/report/rate-limit";
import { wakeWorkflowConsumerBestEffort } from "@/lib/workflow/wakeup-client";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getServerEnv();

  try {
    const body = await readJsonBodyWithLimit(request, env.REPORT_MAX_REQUEST_BYTES);
    const idempotencyHeader = request.headers.get("idempotency-key")?.trim();
    const payload =
      body && typeof body === "object" && !Array.isArray(body)
        ? {
            ...body,
            idempotencyKey:
              "idempotencyKey" in body && body.idempotencyKey
                ? body.idempotencyKey
                : idempotencyHeader
          }
        : body;
    const acknowledgement = await createReportIntake(payload, {
      ip: getRequestIp(request),
      userAgent: request.headers.get("user-agent")
    });

    if (acknowledgement.shouldDispatch && process.env.NETLIFY === "true") {
      await wakeWorkflowConsumerBestEffort({ env });
    }

    return NextResponse.json(acknowledgement.response, {
      status: acknowledgement.response.reused ? 200 : 202,
      headers: responseHeaders()
    });
  } catch (error) {
    const publicError = getPublicReportError(error);

    return NextResponse.json(
      { error: publicError.message },
      { status: publicError.status, headers: responseHeaders() }
    );
  }
}

function responseHeaders() {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive"
  };
}
