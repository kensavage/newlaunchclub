import { runReportJob } from "../../src/lib/report/pipeline";

async function runReport(request: Request) {
  const body = (await request.json().catch(() => null)) as { publicId?: string } | null;

  if (!body?.publicId) {
    return Response.json({ error: "Missing publicId" }, { status: 400 });
  }

  await runReportJob(body.publicId);
  return Response.json({ ok: true }, { status: 202 });
}

export default runReport;

export const config = {
  background: true
} as const;
