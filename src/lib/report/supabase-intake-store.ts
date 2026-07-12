import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  CreateReportIntakeInput,
  PrivacySafeRequestMetadata,
  ReportIntakeResult,
  ReportRequestStatus,
  ResolvedReportAccess
} from "@/lib/report/intake-schema";
import {
  IntakeCapacityError,
  IntakeRateLimitError,
  type ReportIntakeStore
} from "@/lib/report/intake-store";

interface IntakeRpcRow {
  company_id: string;
  contact_id: string;
  lead_id: string;
  report_request_id: string;
  report_id: string;
  access_token_id: string;
  public_progress_id: string;
  legacy_public_id: string;
  request_status: ReportRequestStatus;
  request_created_at: string;
  reused: boolean;
}

interface AccessRpcRow {
  report_id: string;
  report_request_id: string;
  access_token_id: string;
  stored_token_hash: string;
  token_status: "active";
  expires_at: string;
  public_progress_id: string;
  display_domain: string;
  legacy_public_id: string;
  request_status: ReportRequestStatus;
  request_created_at: string;
}

export class SupabaseReportIntakeStore implements ReportIntakeStore {
  constructor(private readonly supabase: SupabaseClient) {}

  static fromEnv({ url, serviceRoleKey }: { url: string; serviceRoleKey: string }) {
    return new SupabaseReportIntakeStore(
      createClient(url, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false }
      })
    );
  }

  async createOrReuseIntake(input: CreateReportIntakeInput): Promise<ReportIntakeResult> {
    const { data, error } = await this.supabase.rpc("create_report_intake", {
      p_canonical_domain: input.canonicalDomain,
      p_canonical_website_url: input.canonicalWebsiteUrl,
      p_normalized_submitted_url: input.normalizedSubmittedUrl,
      p_normalized_email: input.normalizedEmail,
      p_email_domain: input.emailDomain,
      p_submission_source: input.submissionSource,
      p_idempotency_key_hash: input.idempotencyKeyHash,
      p_request_fingerprint: input.requestFingerprint,
      p_public_progress_id: input.publicProgressId,
      p_legacy_public_id: input.legacyPublicId,
      p_access_token_hash: input.accessTokenHash,
      p_access_expires_at: input.accessExpiresAt,
      p_legacy_job_expires_at: input.legacyJobExpiresAt,
      p_visitor_hash: input.visitorHash,
      p_initial_steps: input.initialSteps,
      p_pair_cooldown_since: input.pairCooldownSince,
      p_domain_cooldown_since: input.domainCooldownSince,
      p_contact_cooldown_since: input.contactCooldownSince,
      p_max_active_per_company: input.maxActivePerCompany,
      p_max_active_per_contact: input.maxActivePerContact,
      p_rate_limit_since: input.rateLimitSince,
      p_max_requests_per_signal: input.maxRequestsPerSignal,
      p_request_metadata: input.requestMetadata
    });

    if (error) {
      if (error.message.includes("report_intake_rate_limited")) {
        throw new IntakeRateLimitError();
      }
      if (error.message.includes("report_intake_capacity")) {
        throw new IntakeCapacityError();
      }
      throw new Error("Report intake could not be stored.");
    }

    const row = firstRow<IntakeRpcRow>(data);
    if (!row) throw new Error("Report intake did not return a result.");

    return {
      companyId: row.company_id,
      contactId: row.contact_id,
      leadId: row.lead_id,
      reportRequestId: row.report_request_id,
      reportId: row.report_id,
      accessTokenId: row.access_token_id,
      publicProgressId: row.public_progress_id,
      legacyPublicId: row.legacy_public_id,
      requestStatus: row.request_status,
      createdAt: row.request_created_at,
      reused: row.reused
    };
  }

  async resolveAccess(
    tokenHash: string,
    requestMetadata: PrivacySafeRequestMetadata,
    now = new Date().toISOString()
  ): Promise<ResolvedReportAccess | null> {
    const { data, error } = await this.supabase.rpc("resolve_report_access", {
      p_token_hash: tokenHash,
      p_request_metadata: requestMetadata,
      p_now: now
    });

    if (error) throw new Error("Report access could not be verified.");
    const row = firstRow<AccessRpcRow>(data);
    if (!row) return null;

    return {
      reportId: row.report_id,
      reportRequestId: row.report_request_id,
      accessTokenId: row.access_token_id,
      storedTokenHash: row.stored_token_hash,
      tokenStatus: row.token_status,
      expiresAt: row.expires_at,
      publicProgressId: row.public_progress_id,
      displayDomain: row.display_domain,
      legacyPublicId: row.legacy_public_id,
      requestStatus: row.request_status,
      createdAt: row.request_created_at
    };
  }

  async rotateAccess(
    reportId: string,
    tokenHash: string,
    expiresAt: string,
    requestMetadata: PrivacySafeRequestMetadata
  ) {
    const { data, error } = await this.supabase.rpc("rotate_report_access", {
      p_report_id: reportId,
      p_token_hash: tokenHash,
      p_expires_at: expiresAt,
      p_request_metadata: requestMetadata
    });

    if (error || typeof data !== "string") {
      throw new Error("Report access could not be rotated.");
    }

    return data;
  }

  async revokeAccess(reportId: string, reason: string) {
    const { error } = await this.supabase.rpc("revoke_report_access", {
      p_report_id: reportId,
      p_reason: reason
    });

    if (error) throw new Error("Report access could not be revoked.");
  }

  async isLegacyIdProtected(legacyPublicId: string) {
    const { data, error } = await this.supabase.rpc("is_protected_report_legacy_id", {
      p_legacy_public_id: legacyPublicId
    });

    if (error) throw new Error("Report access could not be verified.");
    return data === true;
  }
}

function firstRow<T>(value: unknown): T | null {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null;
  return value && typeof value === "object" ? (value as T) : null;
}
