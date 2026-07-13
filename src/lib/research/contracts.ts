import { z } from "zod";
import type { FailureClassification } from "@/lib/workflow/schema";

export const WEBSITE_RESEARCH_MAX_PAGES = 20;
export const SEARCH_QUERY_HARD_MAX = 30;
export const COMPANY_PROFILE_PROMPT_VERSION = "company-profile-v1";
export const SEARCH_QUERY_PROMPT_VERSION = "search-query-discovery-v1";

export const claimStatusSchema = z.enum([
  "measured",
  "inferred",
  "unavailable",
  "unmeasured"
]);
export const confidenceSchema = z.enum(["low", "medium", "high"]);
export const profileClaimFieldSchema = z.enum([
  "company_name",
  "brand_name",
  "website",
  "industry",
  "subindustry",
  "business_model",
  "target_customers",
  "geographic_location",
  "geographic_service_area",
  "profile_summary"
]);
export const profileEntityTypeSchema = z.enum([
  "product",
  "service",
  "person",
  "value_proposition",
  "differentiator",
  "proof",
  "trust_signal",
  "review_reference",
  "content_asset",
  "authority_source",
  "likely_competitor"
]);

export const evidencePointerSchema = z.object({
  pageIndex: z.number().int().min(0).max(WEBSITE_RESEARCH_MAX_PAGES - 1),
  excerpt: z.string().trim().min(1).max(1_000)
}).strict();

export const companyProfileClaimSchema = z.object({
  fieldKey: profileClaimFieldSchema,
  status: claimStatusSchema,
  confidence: confidenceSchema.nullable(),
  value: z.string().trim().min(1).max(4_000).nullable(),
  normalizedValue: z.string().trim().min(1).max(1_000).nullable(),
  evidence: z.array(evidencePointerSchema).max(8)
}).strict().superRefine((claim, context) => {
  const supported = claim.status === "measured" || claim.status === "inferred";
  if (supported && (!claim.value || !claim.confidence)) {
    context.addIssue({ code: "custom", message: "Supported claims require a value and confidence." });
  }
  if (!supported && (claim.value || claim.normalizedValue || claim.confidence || claim.evidence.length)) {
    context.addIssue({ code: "custom", message: "Unavailable and unmeasured claims must be empty." });
  }
  if (claim.status === "measured" && claim.evidence.length === 0) {
    context.addIssue({ code: "custom", message: "Measured claims require page evidence." });
  }
});

export const companyProfileEntitySchema = z.object({
  type: profileEntityTypeSchema,
  name: z.string().trim().min(1).max(500),
  role: z.string().trim().min(1).max(500).nullable(),
  url: z.string().url().nullable(),
  status: z.enum(["measured", "inferred"]),
  confidence: confidenceSchema,
  evidence: z.array(evidencePointerSchema).max(8)
}).strict().superRefine((entity, context) => {
  if (entity.status === "measured" && entity.evidence.length === 0) {
    context.addIssue({ code: "custom", message: "Measured entities require page evidence." });
  }
});

export const companyProfileDraftSchema = z.object({
  companyName: z.string().trim().min(1).max(300).nullable(),
  brandName: z.string().trim().min(1).max(300).nullable(),
  website: z.string().url(),
  industry: z.string().trim().min(1).max(300).nullable(),
  subindustry: z.string().trim().min(1).max(300).nullable(),
  businessModel: z.string().trim().min(1).max(300).nullable(),
  summary: z.string().trim().min(1).max(4_000).nullable(),
  claims: z.array(companyProfileClaimSchema).length(profileClaimFieldSchema.options.length),
  entities: z.array(companyProfileEntitySchema).max(50)
}).strict().superRefine((profile, context) => {
  const keys = profile.claims.map((claim) => claim.fieldKey);
  if (new Set(keys).size !== profileClaimFieldSchema.options.length) {
    context.addIssue({ code: "custom", message: "Each company-profile field must appear exactly once." });
  }
  for (const field of profileClaimFieldSchema.options) {
    if (!keys.includes(field)) {
      context.addIssue({ code: "custom", message: `Missing company-profile field: ${field}.` });
    }
  }
  const topLevelFields = {
    company_name: profile.companyName,
    brand_name: profile.brandName,
    website: profile.website,
    industry: profile.industry,
    subindustry: profile.subindustry,
    business_model: profile.businessModel,
    profile_summary: profile.summary
  } as const;
  for (const [fieldKey, topLevelValue] of Object.entries(topLevelFields)) {
    const claim = profile.claims.find((candidate) => candidate.fieldKey === fieldKey);
    const supported = claim?.status === "measured" || claim?.status === "inferred";
    if (!claim || (supported ? claim.value !== topLevelValue : topLevelValue !== null)) {
      context.addIssue({
        code: "custom",
        message: `Top-level company profile field does not match claim: ${fieldKey}.`
      });
    }
  }
});

export const searchQueryCategorySchema = z.enum([
  "commercial",
  "comparison",
  "problem_aware",
  "best_provider",
  "local",
  "near_me",
  "product",
  "service",
  "alternative",
  "review",
  "recommendation",
  "how_to",
  "industry_education",
  "competitor_comparison",
  "founder",
  "brand",
  "ai_assistant"
]);
export const searchIntentSchema = z.enum([
  "commercial",
  "transactional",
  "informational",
  "navigational",
  "local",
  "research"
]);
export const searchQueryDraftSchema = z.object({
  query: z.string().trim().min(3).max(500),
  category: searchQueryCategorySchema,
  intent: searchIntentSchema,
  geographicRelevance: z.string().trim().min(1).max(500).nullable(),
  priority: z.number().int().min(1).max(5),
  rationale: z.string().trim().min(1).max(2_000),
  evidenceClaimKeys: z.array(profileClaimFieldSchema).max(6)
}).strict();
export const searchQuerySetDraftSchema = z.object({
  queries: z.array(searchQueryDraftSchema).min(1).max(SEARCH_QUERY_HARD_MAX)
}).strict();

export type CompanyProfileDraft = z.infer<typeof companyProfileDraftSchema>;
export type SearchQueryDraft = z.infer<typeof searchQueryDraftSchema>;

export interface ProviderUsage {
  creditsUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}

export interface WebsiteResearchSubmission {
  provider: "firecrawl" | "mock";
  jobId: string;
  state: "submitted" | "completed";
  httpStatus: number | null;
  providerCreatedAt: string | null;
  usage: ProviderUsage;
}

export interface WebsiteResearchPage {
  pageIndex: number;
  sourceUrl: string;
  canonicalUrl: string;
  title: string | null;
  description: string | null;
  markdown: string;
  contentHash: string;
  rawArtifact: Record<string, unknown>;
  providerCreatedAt: string | null;
  crawledAt: string;
  freshUntil: string;
}

export type WebsiteResearchPoll =
  | {
      state: "running";
      httpStatus: number | null;
      retryAfterSeconds: number;
      usage: ProviderUsage;
    }
  | {
      state: "completed";
      httpStatus: number | null;
      providerCompletedAt: string | null;
      usage: ProviderUsage;
      pages: WebsiteResearchPage[];
    };

export interface WebsiteResearchProvider {
  readonly provider: "firecrawl" | "mock";
  submit(input: {
    url: string;
    maximumPages: number;
    maximumDepth: 1;
  }): Promise<WebsiteResearchSubmission>;
  poll(input: {
    jobId: string;
    expectedUrl: string;
    maximumPages: number;
  }): Promise<WebsiteResearchPoll>;
}

export interface WebsiteEvidencePage {
  snapshotId: string;
  pageIndex: number;
  sourceUrl: string;
  canonicalUrl: string;
  title: string | null;
  description: string | null;
  markdown: string;
  contentHash: string;
  crawledAt: string;
  providerCreatedAt: string | null;
  freshUntil: string;
}

export interface StructuredAnalysisResult<T> {
  provider: "openai" | "mock";
  model: string;
  providerRequestId: string;
  providerCreatedAt: string | null;
  promptTemplateVersion: string;
  usage: Required<Pick<ProviderUsage, "inputTokens" | "outputTokens" | "totalTokens">> & ProviderUsage;
  output: T;
}

export interface StructuredAnalysisProvider {
  readonly provider: "openai" | "mock";
  extractCompanyProfile(input: {
    normalizedUrl: string;
    domain: string;
    pages: WebsiteEvidencePage[];
  }): Promise<StructuredAnalysisResult<CompanyProfileDraft>>;
  discoverSearchQueries(input: {
    profile: CompanyProfileReadModel;
    queryCount: number;
  }): Promise<StructuredAnalysisResult<{ queries: SearchQueryDraft[] }>>;
}

export interface CompanyProfileReadModel {
  profileVersionId: string;
  profileVersion: number;
  companyName: string | null;
  brandName: string | null;
  website: string;
  industry: string | null;
  subindustry: string | null;
  businessModel: string | null;
  summary: string | null;
  researchFreshAt: string;
  freshUntil: string;
  claims: Array<{
    id: string;
    fieldKey: z.infer<typeof profileClaimFieldSchema>;
    status: z.infer<typeof claimStatusSchema>;
    confidence: z.infer<typeof confidenceSchema> | null;
    value: string | null;
    normalizedValue: string | null;
  }>;
  entities: Array<{
    id: string;
    type: z.infer<typeof profileEntityTypeSchema>;
    name: string;
    normalizedName: string;
    role: string | null;
    url: string | null;
    status: "measured" | "inferred";
    confidence: z.infer<typeof confidenceSchema>;
  }>;
}

export type ProviderOperationKind =
  | "website_research"
  | "company_profile_extraction"
  | "search_query_discovery";

export interface ProviderOperationRecord {
  id: string;
  workflowId: string;
  stepId: string;
  provider: "firecrawl" | "openai" | "mock";
  operationKind: ProviderOperationKind;
  idempotencyKey: string;
  requestFingerprint: string;
  state:
    | "reserved"
    | "submitting"
    | "submitted"
    | "polling"
    | "retry_scheduled"
    | "succeeded"
    | "failed"
    | "outcome_unknown"
    | "cancelled";
  providerJobId: string | null;
  attemptCount: number;
  maximumAttempts: number;
  nextRetryAt: string | null;
  estimatedCostCents: number;
  actualCostCents: number | null;
  providerUsage: ProviderUsage;
  lastHttpStatus: number | null;
  lastSafeErrorCode: string | null;
  lastSafeErrorSummary: string | null;
  providerStartedAt: string | null;
  providerCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ProviderResearchError extends Error {
  constructor(
    public readonly classification: FailureClassification,
    public readonly safeCode: string,
    public readonly safeSummary: string,
    options: {
      retryAfterSeconds?: number;
      httpStatus?: number | null;
      outcomeUncertain?: boolean;
      cause?: unknown;
    } = {}
  ) {
    super(safeSummary, { cause: options.cause });
    this.name = "ProviderResearchError";
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.httpStatus = options.httpStatus ?? null;
    this.outcomeUncertain = options.outcomeUncertain ?? false;
  }

  readonly retryAfterSeconds: number | null;
  readonly httpStatus: number | null;
  readonly outcomeUncertain: boolean;
}

export function normalizeDiscoveredQueries(
  value: unknown,
  options: { maximum: number; hasVerifiedGeography: boolean }
) {
  const parsed = searchQuerySetDraftSchema.parse(value);
  const deduped = new Map<string, SearchQueryDraft>();
  for (const query of parsed.queries) {
    const normalized = normalizeQuery(query.query);
    if (!options.hasVerifiedGeography && query.geographicRelevance) {
      throw new ProviderResearchError(
        "permanent",
        "unsupported_query_geography",
        "Generated search geography was not supported by measured website evidence."
      );
    }
    if (!deduped.has(normalized)) deduped.set(normalized, { ...query, query: query.query.trim() });
  }
  return [...deduped.values()].slice(0, Math.min(options.maximum, SEARCH_QUERY_HARD_MAX));
}

export function normalizeQuery(query: string) {
  return query.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function assertQueriesSupportedByProfile(
  queries: SearchQueryDraft[],
  profile: CompanyProfileReadModel
) {
  const supportedClaims = new Set(profile.claims
    .filter((claim) =>
      (claim.status === "measured" || claim.status === "inferred") && Boolean(claim.value)
    )
    .map((claim) => claim.fieldKey));
  if (queries.some((query) =>
    query.evidenceClaimKeys.some((fieldKey) => !supportedClaims.has(fieldKey))
  )) {
    throw new ProviderResearchError(
      "permanent",
      "unsupported_query_claim",
      "Generated search queries referenced an unsupported company-profile claim."
    );
  }
  return queries;
}
