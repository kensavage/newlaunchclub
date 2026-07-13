import crypto from "node:crypto";
import {
  companyProfileDraftSchema,
  assertQueriesSupportedByProfile,
  normalizeDiscoveredQueries,
  type CompanyProfileReadModel,
  type ProviderOperationKind,
  type ProviderOperationRecord,
  type SearchQueryDraft,
  type WebsiteEvidencePage
} from "@/lib/research/contracts";
import { sha256 } from "@/lib/research/integrity";
import type {
  ProviderAttemptLease,
  ProviderResearchInput,
  ProviderResearchStore
} from "@/lib/research/store";

interface MemoryAttempt {
  id: string;
  operationId: string;
  attemptNumber: number;
  phase: "submit" | "poll" | "persist";
  state: "started" | "succeeded" | "retry_scheduled" | "failed" | "outcome_unknown" | "cancelled";
  retryAt: string | null;
}

interface MemoryPageRecord {
  artifactId: string;
  snapshotId: string;
  operationId: string;
  page: WebsiteEvidencePage;
  rawArtifact: Record<string, unknown>;
}

interface MemoryProfileRecord {
  operationId: string;
  readModel: CompanyProfileReadModel;
  outputHash: string;
  modelInvocationId: string;
  providerRequestId: string;
}

interface MemoryQuerySetRecord {
  operationId: string;
  querySetId: string;
  querySetVersion: number;
  modelInvocationId: string;
  profileVersionId: string;
  providerRequestId: string;
  queries: SearchQueryDraft[];
}

export class MemoryProviderResearchStore implements ProviderResearchStore {
  private readonly inputs = new Map<string, ProviderResearchInput>();
  private readonly operations = new Map<string, ProviderOperationRecord>();
  private readonly operationByKey = new Map<string, string>();
  private readonly attempts: MemoryAttempt[] = [];
  private readonly pages: MemoryPageRecord[] = [];
  private readonly profiles: MemoryProfileRecord[] = [];
  private readonly querySets: MemoryQuerySetRecord[] = [];

  constructor(inputs: ProviderResearchInput[] = []) {
    for (const input of inputs) this.inputs.set(input.workflowId, structuredClone(input));
  }

  seedInput(input: ProviderResearchInput) {
    this.inputs.set(input.workflowId, structuredClone(input));
  }

  async getResearchInput(workflowId: string) {
    return this.inputs.get(workflowId) ?? null;
  }

  async ensureOperation(input: Parameters<ProviderResearchStore["ensureOperation"]>[0]) {
    const existingId = this.operationByKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.operations.get(existingId)!;
      if (existing.workflowId !== input.workflowId || existing.operationKind !== input.operationKind ||
        existing.requestFingerprint !== input.requestFingerprint) {
        throw new Error("Provider operation idempotency conflict.");
      }
      return existing;
    }
    const researchInput = this.inputs.get(input.workflowId);
    if (!researchInput || researchInput.legacyPublicId) throw new Error("Provider research input is unavailable.");
    const now = input.now ?? new Date().toISOString();
    const operation: ProviderOperationRecord = {
      id: crypto.randomUUID(),
      workflowId: input.workflowId,
      stepId: `memory-step:${input.stepKey}`,
      provider: input.provider,
      operationKind: input.operationKind,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      state: "reserved",
      providerJobId: null,
      attemptCount: 0,
      maximumAttempts: input.maximumAttempts,
      nextRetryAt: null,
      estimatedCostCents: input.estimatedCostCents,
      actualCostCents: null,
      providerUsage: {},
      lastHttpStatus: null,
      lastSafeErrorCode: null,
      lastSafeErrorSummary: null,
      providerStartedAt: null,
      providerCompletedAt: null,
      createdAt: now,
      updatedAt: now
    };
    this.operations.set(operation.id, operation);
    this.operationByKey.set(operation.idempotencyKey, operation.id);
    return operation;
  }

  async getOperation(workflowId: string, operationKind: ProviderOperationKind) {
    return [...this.operations.values()].find(
      (operation) => operation.workflowId === workflowId && operation.operationKind === operationKind
    ) ?? null;
  }

  async beginOperationAttempt(operationId: string, phase: "submit" | "poll" | "persist", now = new Date().toISOString()): Promise<ProviderAttemptLease> {
    const operation = this.requireOperation(operationId);
    if (["succeeded", "failed", "outcome_unknown", "cancelled"].includes(operation.state)) {
      throw new Error("Provider operation is terminal.");
    }
    if (operation.attemptCount >= operation.maximumAttempts) throw new Error("Provider attempts exhausted.");
    if (phase === "submit" && operation.state === "submitting") {
      operation.state = "outcome_unknown";
      throw new Error("Provider submission outcome is unknown.");
    }
    if (phase === "submit" && operation.providerJobId) throw new Error("Provider job already exists.");
    if (phase === "poll" && !operation.providerJobId) throw new Error("Provider job is missing.");
    if (phase === "poll") {
      for (const attempt of this.attempts) {
        if (attempt.operationId === operationId && attempt.phase === "poll" && attempt.state === "started") {
          attempt.state = "retry_scheduled";
          attempt.retryAt = now;
        }
      }
    }
    operation.attemptCount += 1;
    operation.state = phase === "submit" ? "submitting" : "polling";
    operation.providerStartedAt ??= now;
    operation.nextRetryAt = null;
    operation.updatedAt = now;
    const attempt: MemoryAttempt = {
      id: crypto.randomUUID(),
      operationId,
      attemptNumber: operation.attemptCount,
      phase,
      state: "started",
      retryAt: null
    };
    this.attempts.push(attempt);
    return { operation, attemptId: attempt.id, attemptNumber: attempt.attemptNumber };
  }

  async recordProviderJob(input: Parameters<ProviderResearchStore["recordProviderJob"]>[0]) {
    const operation = this.requireOperation(input.operationId);
    this.finishAttempt(input.attemptId, input.operationId, "succeeded");
    operation.state = "submitted";
    operation.providerJobId = input.providerJobId;
    operation.lastHttpStatus = input.httpStatus;
    operation.providerUsage = structuredClone(input.providerUsage);
    operation.providerStartedAt ??= input.providerCreatedAt;
    operation.updatedAt = input.now ?? new Date().toISOString();
    return operation;
  }

  async scheduleOperationRetry(input: Parameters<ProviderResearchStore["scheduleOperationRetry"]>[0]) {
    const operation = this.requireOperation(input.operationId);
    const attempt = this.finishAttempt(input.attemptId, input.operationId, "retry_scheduled");
    attempt.retryAt = input.retryAt;
    operation.state = operation.providerJobId ? "submitted" : "retry_scheduled";
    operation.nextRetryAt = input.retryAt;
    operation.lastHttpStatus = input.httpStatus;
    operation.lastSafeErrorCode = input.safeCode;
    operation.lastSafeErrorSummary = input.safeSummary;
    operation.updatedAt = input.now ?? new Date().toISOString();
    return operation;
  }

  async failOperation(input: Parameters<ProviderResearchStore["failOperation"]>[0]) {
    const operation = this.requireOperation(input.operationId);
    if (input.attemptId) this.finishAttempt(input.attemptId, input.operationId, input.state);
    operation.state = input.state;
    operation.lastHttpStatus = input.httpStatus;
    operation.lastSafeErrorCode = input.safeCode;
    operation.lastSafeErrorSummary = input.safeSummary;
    operation.updatedAt = input.now ?? new Date().toISOString();
    return operation;
  }

  async storeWebsitePage(operationId: string, page: Parameters<ProviderResearchStore["storeWebsitePage"]>[1]) {
    const operation = this.requireOperation(operationId);
    if (operation.operationKind !== "website_research") throw new Error("Website operation required.");
    if (sha256(page.markdown) !== page.contentHash) throw new Error("Research content hash mismatch.");
    const existing = this.pages.find((record) => record.operationId === operationId && record.page.pageIndex === page.pageIndex);
    if (existing) {
      if (existing.page.contentHash !== page.contentHash) throw new Error("Snapshot idempotency conflict.");
      return {
        artifactId: existing.artifactId,
        snapshotId: existing.snapshotId,
        contentHash: existing.page.contentHash,
        byteSize: Buffer.byteLength(existing.page.markdown)
      };
    }
    const record: MemoryPageRecord = {
      artifactId: crypto.randomUUID(),
      snapshotId: crypto.randomUUID(),
      operationId,
      rawArtifact: structuredClone(page.rawArtifact),
      page: {
        snapshotId: "",
        pageIndex: page.pageIndex,
        sourceUrl: page.sourceUrl,
        canonicalUrl: page.canonicalUrl,
        title: page.title,
        description: page.description,
        markdown: page.markdown,
        contentHash: page.contentHash,
        crawledAt: page.crawledAt,
        providerCreatedAt: page.providerCreatedAt,
        freshUntil: page.freshUntil
      }
    };
    record.page.snapshotId = record.snapshotId;
    this.pages.push(record);
    return {
      artifactId: record.artifactId,
      snapshotId: record.snapshotId,
      contentHash: page.contentHash,
      byteSize: Buffer.byteLength(page.markdown)
    };
  }

  async completeWebsiteOperation(input: Parameters<ProviderResearchStore["completeWebsiteOperation"]>[0]) {
    const operation = this.requireOperation(input.operationId);
    if (!this.pages.some((page) => page.operationId === operation.id)) throw new Error("Website research has no pages.");
    this.finishAttempt(input.attemptId, operation.id, "succeeded");
    operation.state = "succeeded";
    operation.actualCostCents = input.actualCostCents;
    operation.providerUsage = structuredClone(input.providerUsage);
    operation.lastHttpStatus = input.httpStatus;
    operation.providerCompletedAt = input.providerCompletedAt;
    operation.nextRetryAt = null;
    operation.updatedAt = input.now ?? new Date().toISOString();
    return operation;
  }

  async getWebsiteEvidence(workflowId: string) {
    const operation = await this.getOperation(workflowId, "website_research");
    if (!operation || operation.state !== "succeeded") return null;
    return {
      operationId: operation.id,
      pages: this.pages.filter((page) => page.operationId === operation.id)
        .sort((left, right) => left.page.pageIndex - right.page.pageIndex)
        .map((page) => structuredClone(page.page))
    };
  }

  async persistCompanyProfile(input: Parameters<ProviderResearchStore["persistCompanyProfile"]>[0]) {
    const operation = this.requireOperation(input.operationId);
    const existing = this.profiles.find((profile) => profile.operationId === operation.id);
    if (existing) {
      return {
        profileVersionId: existing.readModel.profileVersionId,
        profileVersion: existing.readModel.profileVersion,
        modelInvocationId: existing.modelInvocationId
      };
    }
    const output = companyProfileDraftSchema.parse(input.result.output);
    const evidence = await this.getWebsiteEvidence(operation.workflowId);
    const pagesByIndex = new Map(evidence?.pages.map((page) => [page.pageIndex, page]));
    for (const pointer of [
      ...output.claims.flatMap((claim) => claim.evidence),
      ...output.entities.flatMap((entity) => entity.evidence)
    ]) {
      const page = pagesByIndex.get(pointer.pageIndex);
      if (!page || !page.markdown.includes(pointer.excerpt)) {
        throw new Error("Profile evidence snapshot missing.");
      }
    }
    const profileVersion = this.profiles.filter((profile) =>
      this.requireOperation(profile.operationId).workflowId === operation.workflowId
    ).length + 1;
    const profileVersionId = crypto.randomUUID();
    const modelInvocationId = crypto.randomUUID();
    const readModel: CompanyProfileReadModel = {
      profileVersionId,
      profileVersion,
      companyName: output.companyName,
      brandName: output.brandName,
      website: output.website,
      industry: output.industry,
      subindustry: output.subindustry,
      businessModel: output.businessModel,
      summary: output.summary,
      researchFreshAt: input.researchFreshAt,
      freshUntil: input.freshUntil,
      claims: output.claims.map((claim) => ({
        id: crypto.randomUUID(),
        fieldKey: claim.fieldKey,
        status: claim.status,
        confidence: claim.confidence,
        value: claim.value,
        normalizedValue: claim.normalizedValue
      })),
      entities: dedupeEntities(output.entities).map((entity) => ({
        id: crypto.randomUUID(),
        type: entity.type,
        name: entity.name,
        normalizedName: normalizeEntity(entity.name),
        role: entity.role,
        url: entity.url,
        status: entity.status,
        confidence: entity.confidence
      }))
    };
    this.profiles.push({
      operationId: operation.id,
      readModel,
      outputHash: input.outputHash,
      modelInvocationId,
      providerRequestId: input.result.providerRequestId
    });
    this.finishAttempt(input.attemptId, operation.id, "succeeded");
    operation.state = "succeeded";
    operation.actualCostCents = input.actualCostCents;
    operation.providerUsage = structuredClone(input.result.usage);
    operation.providerCompletedAt = input.now ?? new Date().toISOString();
    return { profileVersionId, profileVersion, modelInvocationId };
  }

  async getLatestCompanyProfile(workflowId: string) {
    const profiles = this.profiles.filter((profile) =>
      this.requireOperation(profile.operationId).workflowId === workflowId
    );
    return profiles.at(-1)?.readModel ?? null;
  }

  async persistSearchQueries(input: Parameters<ProviderResearchStore["persistSearchQueries"]>[0]) {
    const operation = this.requireOperation(input.operationId);
    const existing = this.querySets.find((querySet) => querySet.operationId === operation.id);
    if (existing) return {
      querySetId: existing.querySetId,
      querySetVersion: existing.querySetVersion,
      modelInvocationId: existing.modelInvocationId,
      queryCount: existing.queries.length
    };
    const profile = await this.getLatestCompanyProfile(operation.workflowId);
    if (!profile || profile.profileVersionId !== input.profileVersionId) throw new Error("Profile version mismatch.");
    const hasVerifiedGeography = profile.claims.some((claim) =>
      (claim.fieldKey === "geographic_location" || claim.fieldKey === "geographic_service_area") &&
      claim.status === "measured" && Boolean(claim.value)
    );
    const queries = normalizeDiscoveredQueries(input.result.output, {
      maximum: 30,
      hasVerifiedGeography
    });
    assertQueriesSupportedByProfile(queries, profile);
    const querySet: MemoryQuerySetRecord = {
      operationId: operation.id,
      querySetId: crypto.randomUUID(),
      querySetVersion: this.querySets.filter((item) =>
        this.requireOperation(item.operationId).workflowId === operation.workflowId
      ).length + 1,
      modelInvocationId: crypto.randomUUID(),
      profileVersionId: profile.profileVersionId,
      providerRequestId: input.result.providerRequestId,
      queries
    };
    this.querySets.push(querySet);
    this.finishAttempt(input.attemptId, operation.id, "succeeded");
    operation.state = "succeeded";
    operation.actualCostCents = input.actualCostCents;
    operation.providerUsage = structuredClone(input.result.usage);
    operation.providerCompletedAt = input.now ?? new Date().toISOString();
    return {
      querySetId: querySet.querySetId,
      querySetVersion: querySet.querySetVersion,
      modelInvocationId: querySet.modelInvocationId,
      queryCount: queries.length
    };
  }

  snapshot() {
    return structuredClone({
      operations: [...this.operations.values()],
      attempts: this.attempts,
      pages: this.pages,
      profiles: this.profiles,
      querySets: this.querySets
    });
  }

  private requireOperation(operationId: string) {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error("Provider operation not found.");
    return operation;
  }

  private finishAttempt(attemptId: string, operationId: string, state: MemoryAttempt["state"]) {
    const attempt = this.attempts.find((item) => item.id === attemptId && item.operationId === operationId);
    if (!attempt || attempt.state !== "started") throw new Error("Provider attempt fenced.");
    attempt.state = state;
    return attempt;
  }
}

function normalizeEntity(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function dedupeEntities<T extends { type: string; name: string }>(entities: T[]) {
  const deduped = new Map<string, T>();
  for (const entity of entities) {
    const key = `${entity.type}:${normalizeEntity(entity.name)}`;
    if (!deduped.has(key)) deduped.set(key, entity);
  }
  return [...deduped.values()];
}
