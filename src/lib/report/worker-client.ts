import "server-only";
import { getServerEnv } from "@/lib/env";
import { runReportJob } from "@/lib/report/pipeline";

export async function triggerReportWorker(publicId: string) {
  const env = getServerEnv();

  if (env.REPORT_USE_INLINE_WORKER || process.env.NETLIFY !== "true") {
    void runReportJob(publicId).catch((error) => {
      console.error("Inline report worker failed", error);
    });
    return;
  }

  const workerUrl = new URL("/.netlify/functions/run-report", env.NEXT_PUBLIC_SITE_URL);
  const response = await fetch(workerUrl.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ publicId })
  });

  if (!response.ok && response.status !== 202) {
    throw new Error("Report worker could not be started.");
  }
}
