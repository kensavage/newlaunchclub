import type {
  CreateReportIntakeInput,
  PrivacySafeRequestMetadata,
  ReportIntakeResult,
  ResolvedReportAccess
} from "@/lib/report/intake-schema";

export interface ReportIntakeStore {
  createOrReuseIntake(input: CreateReportIntakeInput): Promise<ReportIntakeResult>;
  resolveAccess(
    tokenHash: string,
    requestMetadata: PrivacySafeRequestMetadata,
    now?: string
  ): Promise<ResolvedReportAccess | null>;
  rotateAccess(
    reportId: string,
    tokenHash: string,
    expiresAt: string,
    requestMetadata: PrivacySafeRequestMetadata
  ): Promise<string>;
  revokeAccess(reportId: string, reason: string): Promise<void>;
  isLegacyIdProtected(legacyPublicId: string): Promise<boolean>;
}

export class IntakeCapacityError extends Error {
  constructor() {
    super("Report intake capacity is temporarily unavailable.");
    this.name = "IntakeCapacityError";
  }
}

export class IntakeRateLimitError extends Error {
  constructor() {
    super("Too many reports have been requested recently. Try again later.");
    this.name = "IntakeRateLimitError";
  }
}
