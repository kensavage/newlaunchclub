import "server-only";
import crypto from "node:crypto";
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
import type { ReportStore } from "@/lib/report/store";
import { MemoryWorkflowStore } from "@/lib/workflow/memory-store";
import type { WorkflowStore } from "@/lib/workflow/store";

interface CompanyRecord {
  id: string;
  canonicalDomain: string;
  canonicalWebsiteUrl: string;
  displayName: string | null;
  clientStatus: "prospect" | "client" | "former_client";
  createdAt: string;
  updatedAt: string;
}

interface ContactRecord {
  id: string;
  companyId: string;
  normalizedEmail: string;
  emailDomain: string;
  contactStatus: "active" | "unsubscribed" | "invalid" | "blocked";
  createdAt: string;
  updatedAt: string;
}

interface LeadRecord {
  id: string;
  companyId: string;
  primaryContactId: string;
  lifecycleStatus: "report_requested";
  source: string;
  createdAt: string;
  updatedAt: string;
}

interface ReportRequestRecord {
  id: string;
  companyId: string;
  contactId: string;
  leadId: string;
  status: ReportRequestStatus;
  normalizedSubmittedUrl: string;
  submissionSource: string;
  idempotencyKeyHash: string;
  requestFingerprint: string;
  publicProgressId: string;
  legacyPublicId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ReportRecord {
  id: string;
  companyId: string;
  reportRequestId: string;
  status: ReportRequestStatus;
  currentRevisionReference: string | null;
  legacyPublicId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface AccessTokenRecord {
  id: string;
  reportId: string;
  tokenHash: string;
  tokenStatus: "active" | "revoked" | "rotated" | "expired";
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastAccessedAt: string | null;
}

interface AccessEventRecord {
  id: string;
  reportId: string;
  accessTokenId: string | null;
  eventType: "issued" | "accessed" | "expired" | "revoked" | "rotated";
  createdAt: string;
  requestMetadata: PrivacySafeRequestMetadata;
}

interface AuditRecord {
  id: string;
  entityType: string;
  entityId: string | null;
  eventType: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

interface MemoryIntakeState {
  companies: Map<string, CompanyRecord>;
  companyByDomain: Map<string, string>;
  contacts: Map<string, ContactRecord>;
  contactByCompanyEmail: Map<string, string>;
  leads: Map<string, LeadRecord>;
  leadByCompanyContact: Map<string, string>;
  requests: Map<string, ReportRequestRecord>;
  requestByIdempotency: Map<string, string>;
  reports: Map<string, ReportRecord>;
  reportByRequest: Map<string, string>;
  tokens: Map<string, AccessTokenRecord>;
  tokenByHash: Map<string, string>;
  accessEvents: AccessEventRecord[];
  auditLogs: AuditRecord[];
  lock: Promise<void>;
}

declare global {
  var __launchClubIntakeStore: MemoryIntakeState | undefined;
}

function createState(): MemoryIntakeState {
  return {
    companies: new Map(),
    companyByDomain: new Map(),
    contacts: new Map(),
    contactByCompanyEmail: new Map(),
    leads: new Map(),
    leadByCompanyContact: new Map(),
    requests: new Map(),
    requestByIdempotency: new Map(),
    reports: new Map(),
    reportByRequest: new Map(),
    tokens: new Map(),
    tokenByHash: new Map(),
    accessEvents: [],
    auditLogs: [],
    lock: Promise.resolve()
  };
}

function getState() {
  globalThis.__launchClubIntakeStore ??= createState();
  return globalThis.__launchClubIntakeStore;
}

export class MemoryReportIntakeStore implements ReportIntakeStore {
  constructor(
    private readonly reportStore: ReportStore,
    private readonly workflowStore: WorkflowStore = new MemoryWorkflowStore()
  ) {}

  private get state() {
    return getState();
  }

  async createOrReuseIntake(input: CreateReportIntakeInput): Promise<ReportIntakeResult> {
    return this.withLock(async () => {
      await this.syncLegacyStatuses();

      const now = new Date().toISOString();
      const recentSignalRequests = this.state.auditLogs.filter(
        (audit) =>
          (audit.eventType === "report_intake_created" ||
            audit.eventType === "report_intake_reused") &&
          audit.createdAt >= input.rateLimitSince &&
          audit.metadata.requestSignalHash === input.requestMetadata.requestSignalHash
      ).length;

      if (recentSignalRequests >= input.maxRequestsPerSignal) {
        throw new IntakeRateLimitError();
      }

      const companyId = this.state.companyByDomain.get(input.canonicalDomain);
      const existingCompany = companyId ? this.state.companies.get(companyId) : null;
      const company =
        existingCompany ??
        ({
          id: crypto.randomUUID(),
          canonicalDomain: input.canonicalDomain,
          canonicalWebsiteUrl: input.canonicalWebsiteUrl,
          displayName: null,
          clientStatus: "prospect",
          createdAt: now,
          updatedAt: now
        } satisfies CompanyRecord);
      const contactKey = `${company.id}:${input.normalizedEmail}`;
      const contactId = this.state.contactByCompanyEmail.get(contactKey);
      const existingContact = contactId ? this.state.contacts.get(contactId) : null;
      const contact =
        existingContact ??
        ({
          id: crypto.randomUUID(),
          companyId: company.id,
          normalizedEmail: input.normalizedEmail,
          emailDomain: input.emailDomain,
          contactStatus: "active",
          createdAt: now,
          updatedAt: now
        } satisfies ContactRecord);

      const idempotencyLookup = `${contact.id}:${input.idempotencyKeyHash}`;
      const idempotentRequestId = this.state.requestByIdempotency.get(idempotencyLookup);
      if (idempotentRequestId) {
        return this.reuseRequest(idempotentRequestId, input, now);
      }

      const pairRequest = this.findLatestRequest(
        (request) =>
          request.companyId === company.id &&
          request.contactId === contact.id &&
          (isActiveStatus(request.status) ||
            (request.status === "complete" && request.createdAt >= input.pairCooldownSince))
      );
      if (pairRequest) {
        return this.reuseRequest(pairRequest.id, input, now);
      }

      const domainCooldownActive = this.findLatestRequest(
        (request) =>
          request.companyId === company.id &&
          request.contactId !== contact.id &&
          isReusableStatus(request.status) &&
          request.createdAt >= input.domainCooldownSince
      );
      const contactCooldownActive = this.findLatestRequest((request) => {
        const requestContact = this.state.contacts.get(request.contactId);
        return (
          requestContact?.normalizedEmail === input.normalizedEmail &&
          request.companyId !== company.id &&
          isReusableStatus(request.status) &&
          request.createdAt >= input.contactCooldownSince
        );
      });

      if (domainCooldownActive || contactCooldownActive) {
        throw new IntakeCapacityError();
      }

      const activeCompanyRequests = this.countRequests(
        (request) => request.companyId === company.id && isActiveStatus(request.status)
      );
      const activeContactRequests = this.countRequests(
        (request) => request.contactId === contact.id && isActiveStatus(request.status)
      );

      if (
        activeCompanyRequests >= input.maxActivePerCompany ||
        activeContactRequests >= input.maxActivePerContact
      ) {
        throw new IntakeCapacityError();
      }

      const leadKey = `${company.id}:${contact.id}`;
      const leadId = this.state.leadByCompanyContact.get(leadKey);
      const lead =
        (leadId ? this.state.leads.get(leadId) : null) ??
        ({
          id: crypto.randomUUID(),
          companyId: company.id,
          primaryContactId: contact.id,
          lifecycleStatus: "report_requested",
          source: input.submissionSource,
          createdAt: now,
          updatedAt: now
        } satisfies LeadRecord);
      const request: ReportRequestRecord = {
        id: crypto.randomUUID(),
        companyId: company.id,
        contactId: contact.id,
        leadId: lead.id,
        status: "queued",
        normalizedSubmittedUrl: input.normalizedSubmittedUrl,
        submissionSource: input.submissionSource,
        idempotencyKeyHash: input.idempotencyKeyHash,
        requestFingerprint: input.requestFingerprint,
        publicProgressId: input.publicProgressId,
        legacyPublicId: null,
        createdAt: now,
        updatedAt: now
      };
      const report: ReportRecord = {
        id: crypto.randomUUID(),
        companyId: company.id,
        reportRequestId: request.id,
        status: "queued",
        currentRevisionReference: null,
        legacyPublicId: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null
      };

      await this.workflowStore.registerReportIdentity({
        reportId: report.id,
        publicProgressId: request.publicProgressId,
        normalizedEmail: input.normalizedEmail
      });
      await this.workflowStore.createInitialWorkflow({
        reportRequestId: request.id,
        reportId: report.id,
        inputHash: input.requestFingerprint,
        correlationId: request.id,
        orchestratorBackend: "deterministic"
      }, now);

      company.canonicalWebsiteUrl = input.canonicalWebsiteUrl;
      company.updatedAt = now;
      contact.emailDomain = input.emailDomain;
      contact.updatedAt = now;
      lead.updatedAt = now;
      this.state.companies.set(company.id, company);
      this.state.companyByDomain.set(company.canonicalDomain, company.id);
      this.state.contacts.set(contact.id, contact);
      this.state.contactByCompanyEmail.set(contactKey, contact.id);
      this.state.leads.set(lead.id, lead);
      this.state.leadByCompanyContact.set(leadKey, lead.id);
      this.state.requests.set(request.id, request);
      this.state.requestByIdempotency.set(idempotencyLookup, request.id);
      this.state.reports.set(report.id, report);
      this.state.reportByRequest.set(request.id, report.id);
      const accessTokenId = this.attachAccessToken(report.id, input, now);
      this.addAudit("report_request", request.id, "report_intake_created", now, {
        requestFingerprint: input.requestFingerprint,
        submissionSource: input.submissionSource,
        ...input.requestMetadata
      });

      return toIntakeResult({ company, contact, lead, request, report, accessTokenId, reused: false });
    });
  }

  async resolveAccess(
    tokenHash: string,
    requestMetadata: PrivacySafeRequestMetadata,
    now = new Date().toISOString()
  ): Promise<ResolvedReportAccess | null> {
    return this.withLock(async () => {
      const tokenId = this.state.tokenByHash.get(tokenHash);
      const token = tokenId ? this.state.tokens.get(tokenId) : null;

      if (!token || token.tokenStatus !== "active" || token.revokedAt) {
        this.addDeniedAccessAudit(token?.reportId ?? null, now, requestMetadata);
        return null;
      }

      if (Date.parse(token.expiresAt) <= Date.parse(now)) {
        token.tokenStatus = "expired";
        token.revokedAt = now;
        this.addAccessEvent(token.reportId, token.id, "expired", now, requestMetadata);
        return null;
      }

      const report = this.state.reports.get(token.reportId);
      if (!report) return null;
      await this.syncReportStatus(report);
      const request = this.state.requests.get(report.reportRequestId);
      const company = this.state.companies.get(report.companyId);
      if (!request || !company) return null;

      if (!token.lastAccessedAt || Date.parse(now) - Date.parse(token.lastAccessedAt) >= 60_000) {
        this.addAccessEvent(report.id, token.id, "accessed", now, requestMetadata);
      }
      token.lastAccessedAt = now;

      return {
        reportId: report.id,
        reportRequestId: request.id,
        accessTokenId: token.id,
        storedTokenHash: token.tokenHash,
        tokenStatus: "active",
        expiresAt: token.expiresAt,
        publicProgressId: request.publicProgressId,
        displayDomain: company.canonicalDomain,
        legacyPublicId: report.legacyPublicId,
        requestStatus: request.status,
        createdAt: request.createdAt
      };
    });
  }

  async rotateAccess(
    reportId: string,
    tokenHash: string,
    expiresAt: string,
    requestMetadata: PrivacySafeRequestMetadata
  ) {
    return this.withLock(async () => {
      const report = this.state.reports.get(reportId);
      if (!report) throw new Error("Report was not found.");

      const now = new Date().toISOString();
      for (const token of this.state.tokens.values()) {
        if (token.reportId === reportId && token.tokenStatus === "active") {
          token.tokenStatus = "rotated";
          token.revokedAt = now;
          this.addAccessEvent(reportId, token.id, "rotated", now, requestMetadata);
        }
      }

      return this.createToken(reportId, tokenHash, expiresAt, now, requestMetadata, "issued");
    });
  }

  async revokeAccess(reportId: string, reason: string) {
    await this.withLock(async () => {
      const now = new Date().toISOString();
      for (const token of this.state.tokens.values()) {
        if (token.reportId === reportId && token.tokenStatus === "active") {
          token.tokenStatus = "revoked";
          token.revokedAt = now;
          this.addAccessEvent(reportId, token.id, "revoked", now, {
            requestSignalHash: "system",
            userAgentCategory: "unknown"
          });
        }
      }
      this.addAudit("report", reportId, "report_access_revoked", now, { reason });
    });
  }

  async isLegacyIdProtected(legacyPublicId: string) {
    return [...this.state.reports.values()].some(
      (report) => report.legacyPublicId === legacyPublicId
    );
  }

  snapshot() {
    return {
      companies: [...this.state.companies.values()],
      contacts: [...this.state.contacts.values()],
      leads: [...this.state.leads.values()],
      requests: [...this.state.requests.values()],
      reports: [...this.state.reports.values()],
      tokens: [...this.state.tokens.values()],
      accessEvents: [...this.state.accessEvents],
      auditLogs: [...this.state.auditLogs]
    };
  }

  private async reuseRequest(
    requestId: string,
    input: CreateReportIntakeInput,
    now: string
  ): Promise<ReportIntakeResult> {
    const request = this.state.requests.get(requestId);
    if (!request) throw new Error("Report request was not found.");
    const reportId = this.state.reportByRequest.get(request.id);
    const report = reportId ? this.state.reports.get(reportId) : null;
    const company = this.state.companies.get(request.companyId);
    const contact = this.state.contacts.get(request.contactId);
    const lead = this.state.leads.get(request.leadId);
    if (!report || !company || !contact || !lead) {
      throw new Error("Report intake records are incomplete.");
    }

    const accessTokenId = this.attachAccessToken(report.id, input, now);
    this.addAudit("report_request", request.id, "report_intake_reused", now, {
      requestFingerprint: input.requestFingerprint,
      ...input.requestMetadata
    });

    return toIntakeResult({ company, contact, lead, request, report, accessTokenId, reused: true });
  }

  private attachAccessToken(reportId: string, input: CreateReportIntakeInput, now: string) {
    const existingTokenId = this.state.tokenByHash.get(input.accessTokenHash);
    const existingToken = existingTokenId ? this.state.tokens.get(existingTokenId) : null;

    if (
      existingToken &&
      existingToken.reportId === reportId &&
      existingToken.tokenStatus === "active" &&
      Date.parse(existingToken.expiresAt) > Date.parse(now)
    ) {
      return existingToken.id;
    }

    if (existingToken) {
      throw new Error("Report access token can no longer be reissued.");
    }

    for (const token of this.state.tokens.values()) {
      if (token.reportId === reportId && token.tokenStatus === "active") {
        token.tokenStatus = "rotated";
        token.revokedAt = now;
        this.addAccessEvent(reportId, token.id, "rotated", now, input.requestMetadata);
      }
    }

    return this.createToken(
      reportId,
      input.accessTokenHash,
      input.accessExpiresAt,
      now,
      input.requestMetadata,
      existingToken ? "rotated" : "issued"
    );
  }

  private createToken(
    reportId: string,
    tokenHash: string,
    expiresAt: string,
    now: string,
    requestMetadata: PrivacySafeRequestMetadata,
    eventType: "issued" | "rotated"
  ) {
    const token: AccessTokenRecord = {
      id: crypto.randomUUID(),
      reportId,
      tokenHash,
      tokenStatus: "active",
      createdAt: now,
      expiresAt,
      revokedAt: null,
      lastAccessedAt: null
    };
    this.state.tokens.set(token.id, token);
    this.state.tokenByHash.set(tokenHash, token.id);
    this.addAccessEvent(reportId, token.id, eventType, now, requestMetadata);
    return token.id;
  }

  private async syncLegacyStatuses() {
    for (const report of this.state.reports.values()) {
      await this.syncReportStatus(report);
    }
  }

  private async syncReportStatus(report: ReportRecord) {
    if (!report.legacyPublicId) return;
    const job = await this.reportStore.getJob(report.legacyPublicId);
    if (!job) return;

    const request = this.state.requests.get(report.reportRequestId);
    if (!request) return;
    const status = job.status as ReportRequestStatus;
    request.status = status;
    request.updatedAt = job.updatedAt;
    report.status = status;
    report.updatedAt = job.updatedAt;
    report.completedAt = status === "complete" ? job.updatedAt : null;
  }

  private findLatestRequest(predicate: (request: ReportRequestRecord) => boolean) {
    return [...this.state.requests.values()]
      .filter(predicate)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  private countRequests(predicate: (request: ReportRequestRecord) => boolean) {
    return [...this.state.requests.values()].filter(predicate).length;
  }

  private addAccessEvent(
    reportId: string,
    accessTokenId: string | null,
    eventType: AccessEventRecord["eventType"],
    createdAt: string,
    requestMetadata: PrivacySafeRequestMetadata
  ) {
    this.state.accessEvents.push({
      id: crypto.randomUUID(),
      reportId,
      accessTokenId,
      eventType,
      createdAt,
      requestMetadata
    });
  }

  private addAudit(
    entityType: string,
    entityId: string | null,
    eventType: string,
    createdAt: string,
    metadata: Record<string, unknown>
  ) {
    this.state.auditLogs.push({
      id: crypto.randomUUID(),
      entityType,
      entityId,
      eventType,
      createdAt,
      metadata
    });
  }

  private addDeniedAccessAudit(
    reportId: string | null,
    createdAt: string,
    requestMetadata: PrivacySafeRequestMetadata
  ) {
    const alreadyRecordedRecently = this.state.auditLogs.some(
      (audit) =>
        audit.eventType === "report_access_denied" &&
        audit.metadata.requestSignalHash === requestMetadata.requestSignalHash &&
        Date.parse(createdAt) - Date.parse(audit.createdAt) < 60_000
    );

    if (!alreadyRecordedRecently) {
      this.addAudit("report", reportId, "report_access_denied", createdAt, {
        ...requestMetadata
      });
    }
  }

  private async withLock<T>(operation: () => Promise<T>) {
    const previousLock = this.state.lock;
    let release!: () => void;
    this.state.lock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previousLock;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function resetMemoryIntakeStoreForTests() {
  globalThis.__launchClubIntakeStore = undefined;
}

function isReusableStatus(status: ReportRequestStatus) {
  return status === "queued" || status === "running" || status === "complete";
}

function isActiveStatus(status: ReportRequestStatus) {
  return status === "queued" || status === "running";
}

function toIntakeResult({
  company,
  contact,
  lead,
  request,
  report,
  accessTokenId,
  reused
}: {
  company: CompanyRecord;
  contact: ContactRecord;
  lead: LeadRecord;
  request: ReportRequestRecord;
  report: ReportRecord;
  accessTokenId: string;
  reused: boolean;
}): ReportIntakeResult {
  return {
    companyId: company.id,
    contactId: contact.id,
    leadId: lead.id,
    reportRequestId: request.id,
    reportId: report.id,
    accessTokenId,
    publicProgressId: request.publicProgressId,
    legacyPublicId: report.legacyPublicId,
    requestStatus: request.status,
    createdAt: request.createdAt,
    reused
  };
}
