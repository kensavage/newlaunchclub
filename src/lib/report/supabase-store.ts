import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { OpportunityReport, ReportJob } from "@/lib/report/schema";
import { createInitialSteps } from "@/lib/report/steps";
import {
  createExpiryDate,
  createNow,
  type CreateReportJobInput,
  type ReportStore,
  type VendorEventInput
} from "@/lib/report/store";

interface ReportJobRow {
  public_id: string;
  submitted_url: string;
  normalized_url: string;
  domain: string;
  status: ReportJob["status"];
  current_step: ReportJob["currentStep"];
  progress: number;
  steps: ReportJob["steps"];
  error_summary: string | null;
  visitor_hash: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

interface ReportResultRelation {
  report_json: OpportunityReport;
}

export class SupabaseReportStore implements ReportStore {
  constructor(private readonly supabase: SupabaseClient) {}

  static fromEnv({ url, serviceRoleKey }: { url: string; serviceRoleKey: string }) {
    return new SupabaseReportStore(createClient(url, serviceRoleKey, { auth: { persistSession: false } }));
  }

  async createJob(input: CreateReportJobInput): Promise<ReportJob> {
    const now = createNow();
    const row: ReportJobRow = {
      public_id: input.publicId,
      submitted_url: input.submittedUrl,
      normalized_url: input.normalizedUrl,
      domain: input.domain,
      status: "queued",
      current_step: "queued",
      progress: 5,
      steps: createInitialSteps(),
      error_summary: null,
      visitor_hash: input.visitorHash,
      created_at: now,
      updated_at: now,
      expires_at: createExpiryDate()
    };

    const { data, error } = await this.supabase.from("report_jobs").insert(row).select().single();
    if (error) throw new Error(error.message);
    return mapJobRow(data as ReportJobRow);
  }

  async getJob(publicId: string): Promise<ReportJob | null> {
    const { data, error } = await this.supabase
      .from("report_jobs")
      .select("*")
      .eq("public_id", publicId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return data ? mapJobRow(data as ReportJobRow) : null;
  }

  async updateJob(publicId: string, patch: Partial<ReportJob>): Promise<ReportJob> {
    const rowPatch: Partial<ReportJobRow> = {
      status: patch.status,
      current_step: patch.currentStep,
      progress: patch.progress,
      steps: patch.steps,
      error_summary: patch.errorSummary,
      updated_at: createNow()
    };

    const { data, error } = await this.supabase
      .from("report_jobs")
      .update(rowPatch)
      .eq("public_id", publicId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return mapJobRow(data as ReportJobRow);
  }

  async saveReport(publicId: string, report: OpportunityReport): Promise<void> {
    const { error } = await this.supabase.from("report_results").upsert({
      public_id: publicId,
      report_json: report,
      evidence_summary: report.evidenceSummary,
      created_at: createNow()
    });

    if (error) throw new Error(error.message);
  }

  async getReport(publicId: string): Promise<OpportunityReport | null> {
    const { data, error } = await this.supabase
      .from("report_results")
      .select("report_json")
      .eq("public_id", publicId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return (data?.report_json as OpportunityReport | undefined) ?? null;
  }

  async findRecentCompletedReportByDomain(domain: string) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await this.supabase
      .from("report_jobs")
      .select("*, report_results(report_json)")
      .eq("domain", domain)
      .eq("status", "complete")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) return null;

    const reportJson = getJoinedReportJson(
      (data as ReportJobRow & {
        report_results?: ReportResultRelation | ReportResultRelation[] | null;
      }).report_results
    );

    if (!reportJson) return null;

    return {
      job: mapJobRow(data as ReportJobRow),
      report: reportJson
    };
  }

  async recordVendorEvent(event: VendorEventInput): Promise<void> {
    const { error } = await this.supabase.from("vendor_events").insert({
      public_id: event.publicId,
      provider: event.provider,
      endpoint: event.endpoint,
      purpose: event.purpose,
      status: event.status,
      duration_ms: event.durationMs,
      error_summary: event.errorSummary ?? null,
      estimated_cost: event.estimatedCost ?? null,
      created_at: createNow()
    });

    if (error) throw new Error(error.message);
  }
}

function getJoinedReportJson(reportResults?: ReportResultRelation | ReportResultRelation[] | null) {
  if (Array.isArray(reportResults)) {
    return reportResults[0]?.report_json ?? null;
  }

  return reportResults?.report_json ?? null;
}

function mapJobRow(row: ReportJobRow): ReportJob {
  return {
    publicId: row.public_id,
    submittedUrl: row.submitted_url,
    normalizedUrl: row.normalized_url,
    domain: row.domain,
    status: row.status,
    currentStep: row.current_step,
    progress: row.progress,
    steps: row.steps,
    errorSummary: row.error_summary,
    visitorHash: row.visitor_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}
