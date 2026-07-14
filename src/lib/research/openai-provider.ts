import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { Response as OpenAIResponse } from "openai/resources/responses/responses";
import { z } from "zod";
import {
  COMPANY_PROFILE_PROMPT_VERSION,
  ProviderResearchError,
  SEARCH_QUERY_PROMPT_VERSION,
  assertQueriesSupportedByProfile,
  companyProfileDraftSchema,
  companyProfileEntitySchema,
  normalizeDiscoveredQueries,
  searchQuerySetDraftSchema,
  type AnalysisProcessingPhase,
  type AnalysisResponseArtifactDraft,
  type CompanyProfileReadModel,
  type ContentSelectionPage,
  type StructuredAnalysisProvider,
  type WebsiteEvidencePage
} from "@/lib/research/contracts";

const MAX_OUTPUT_URL_CHARACTERS = 2_048;
const MAX_STORED_OUTPUT_CHARACTERS = 120_000;
const MAX_STORED_REFUSAL_CHARACTERS = 4_000;

// OpenAI Structured Outputs does not support JSON Schema's "uri" format.
// Keep the wire schema compatible, then apply the stricter domain schema locally.
const openAiCompanyProfileEntitySchema = companyProfileEntitySchema.safeExtend({
  url: z.string().trim().min(1).max(MAX_OUTPUT_URL_CHARACTERS).nullable()
});
const openAiCompanyProfileDraftSchema = companyProfileDraftSchema.safeExtend({
  website: z.string().trim().min(1).max(MAX_OUTPUT_URL_CHARACTERS),
  entities: z.array(openAiCompanyProfileEntitySchema).max(50)
});

export class OpenAIStructuredAnalysisProvider implements StructuredAnalysisProvider {
  readonly provider = "openai" as const;
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
    options: { fetchImplementation?: typeof fetch; timeoutMilliseconds?: number } = {}
  ) {
    this.client = new OpenAI({
      apiKey,
      fetch: options.fetchImplementation,
      timeout: options.timeoutMilliseconds ?? 60_000,
      maxRetries: 0
    });
  }

  async checkReadiness() {
    try {
      const model = await this.client.models.retrieve(this.model);
      if (!model.id) {
        throw new ProviderResearchError(
          "configuration_error",
          "provider_model_unavailable",
          "The configured analysis model is unavailable.",
          { outcome: "definitively_rejected" }
        );
      }
    } catch (error) {
      throw mapOpenAiReadinessFailure(error);
    }
  }

  async createCompanyProfileResponse(input: {
    normalizedUrl: string;
    domain: string;
    pages: ContentSelectionPage[];
  }) {
    try {
      const request = this.client.responses.create({
        model: this.model,
        store: true,
        reasoning: { effort: "none" },
        max_output_tokens: 8_000,
        input: [
          {
            role: "system",
            content: [
              "Build a factual company profile using only the supplied selected website evidence.",
              "Return every required claim field exactly once.",
              "Use measured only when a page excerpt directly supports the value.",
              "Every evidence excerpt must be one contiguous exact substring copied from the supplied markdown; do not paraphrase, combine snippets, or insert ellipses.",
              "Use inferred for a cautious interpretation, unavailable when the site does not say, and unmeasured when the requested concept cannot be evaluated.",
              "Measured claims and entities must cite the original pageIndex and a short verbatim excerpt. Never invent people, locations, reviews, proof, competitors, products, or services.",
              "A likely competitor may be included only if the website explicitly names or compares it.",
              "Do not include reasoning, private data, or facts from outside the supplied pages."
            ].join(" ")
          },
          {
            role: "user",
            content: JSON.stringify({
              website: input.normalizedUrl,
              domain: input.domain,
              pages: input.pages.filter((page) => page.included)
                .sort((left, right) => left.selectedOrder! - right.selectedOrder!)
                .map((page) => ({
                  pageIndex: page.pageIndex,
                  url: page.canonicalUrl,
                  title: page.title,
                  description: page.description,
                  classification: page.classification,
                  markdown: page.selectedMarkdown
                }))
            })
          }
        ],
        text: {
          format: zodTextFormat(openAiCompanyProfileDraftSchema, "company_profile")
        }
      });
      const { data, response, request_id } = await request.withResponse();
      return sanitizeResponse(
        data,
        request_id,
        response.status,
        COMPANY_PROFILE_PROMPT_VERSION,
        "company-profile-schema-v2",
        true
      );
    } catch (error) {
      throw mapOpenAiRequestFailure(error);
    }
  }

  parseCompanyProfileResponse(input: {
    response: AnalysisResponseArtifactDraft;
    evidencePages: WebsiteEvidencePage[];
  }) {
    const raw = parseResponseJson(input.response);
    let parsed: ReturnType<typeof companyProfileDraftSchema.parse>;
    try {
      parsed = companyProfileDraftSchema.parse(canonicalizeCompanyProfileFields(raw));
    } catch (error) {
      throw processingError(
        "structured_output_schema_invalid",
        "The captured company profile did not match the required schema.",
        "parse",
        error
      );
    }
    const output = groundCompanyProfileEvidence(parsed, input.evidencePages);
    return structuredResult(input.response, output);
  }

  async createSearchQueryResponse(input: {
    profile: CompanyProfileReadModel;
    queryCount: number;
  }) {
    try {
      const hasVerifiedGeography = hasMeasuredGeography(input.profile);
      const request = this.client.responses.create({
        model: this.model,
        store: true,
        reasoning: { effort: "none" },
        max_output_tokens: 6_000,
        input: [
          {
            role: "system",
            content: [
              `Generate no more than ${input.queryCount} useful search queries from the supplied company profile.`,
              "Cover practical commercial, comparison, problem-aware, provider, product or service, review, recommendation, educational, brand, founder, and AI-assistant language where supported.",
              "Prioritize buyer relevance and commercial usefulness. Do not execute searches.",
              "Use geographic relevance only when measured geography is explicitly present in the profile.",
              "Each query must include a concise rationale and the profile claim keys that support it. Do not invent competitors or locations."
            ].join(" ")
          },
          {
            role: "user",
            content: JSON.stringify({
              requestedQueryCount: input.queryCount,
              hasVerifiedGeography,
              profile: input.profile
            })
          }
        ],
        text: {
          format: zodTextFormat(searchQuerySetDraftSchema, "search_query_set")
        }
      });
      const { data, response, request_id } = await request.withResponse();
      return sanitizeResponse(
        data,
        request_id,
        response.status,
        SEARCH_QUERY_PROMPT_VERSION,
        "search-query-schema-v2",
        true
      );
    } catch (error) {
      throw mapOpenAiRequestFailure(error);
    }
  }

  parseSearchQueryResponse(input: {
    response: AnalysisResponseArtifactDraft;
    profile: CompanyProfileReadModel;
    queryCount: number;
  }) {
    const raw = parseResponseJson(input.response);
    let queries;
    try {
      queries = normalizeDiscoveredQueries(raw, {
        maximum: input.queryCount,
        hasVerifiedGeography: hasMeasuredGeography(input.profile)
      });
    } catch (error) {
      if (error instanceof ProviderResearchError) {
        throw withCapturedResponse(error, "evidence_validation");
      }
      throw processingError(
        "structured_output_schema_invalid",
        "The captured search-query set did not match the required schema.",
        "parse",
        error
      );
    }
    try {
      assertQueriesSupportedByProfile(queries, input.profile);
    } catch (error) {
      if (error instanceof ProviderResearchError) {
        throw withCapturedResponse(error, "evidence_validation");
      }
      throw error;
    }
    if (!queries.length) {
      throw processingError(
        "search_queries_empty",
        "The captured response did not contain usable search queries.",
        "parse"
      );
    }
    return structuredResult(input.response, { queries });
  }

  async retrieveResponse(input: {
    providerResponseId: string;
    promptTemplateVersion: string;
    schemaVersion: string;
  }) {
    try {
      const request = this.client.responses.retrieve(input.providerResponseId);
      const { data, response, request_id } = await request.withResponse();
      return sanitizeResponse(
        data,
        request_id,
        response.status,
        input.promptTemplateVersion,
        input.schemaVersion,
        true
      );
    } catch (error) {
      const mapped = mapOpenAiRequestFailure(error);
      throw new ProviderResearchError(
        "transient",
        "provider_response_retrieval_failed",
        "The stored analysis response could not be retrieved safely.",
        {
          retryAfterSeconds: mapped.retryAfterSeconds ?? 15,
          httpStatus: mapped.httpStatus,
          providerResponseCaptured: true,
          processingPhase: "retrieval",
          cause: error
        }
      );
    }
  }
}

function sanitizeResponse(
  response: OpenAIResponse,
  providerRequestId: string | null,
  httpStatus: number,
  promptTemplateVersion: string,
  schemaVersion: string,
  storedForRecovery: boolean
): AnalysisResponseArtifactDraft {
  const outputText: string[] = [];
  const refusals: string[] = [];
  const outputItemTypes: string[] = [];
  const messageStatuses: string[] = [];
  for (const item of response.output) {
    outputItemTypes.push(item.type);
    if (item.type !== "message") continue;
    messageStatuses.push(item.status);
    for (const content of item.content) {
      if (content.type === "output_text") outputText.push(content.text);
      if (content.type === "refusal") refusals.push(content.refusal);
    }
  }
  const fullOutput = outputText.join("\n");
  const outputTruncated = fullOutput.length > MAX_STORED_OUTPUT_CHARACTERS;
  const boundedOutput = fullOutput.slice(0, MAX_STORED_OUTPUT_CHARACTERS) || null;
  const refusal = refusals.join("\n").slice(0, MAX_STORED_REFUSAL_CHARACTERS) || null;
  const usage = response.usage;
  return {
    provider: "openai",
    providerResponseId: response.id,
    providerRequestId,
    responseStatus: response.status ?? "failed",
    model: String(response.model),
    promptTemplateVersion,
    schemaVersion,
    providerCreatedAt: Number.isFinite(response.created_at)
      ? new Date(response.created_at * 1_000).toISOString()
      : null,
    responseReceivedAt: new Date().toISOString(),
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
      cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? 0
    },
    outputText: boundedOutput,
    refusal,
    incompleteReason: response.incomplete_details?.reason ?? null,
    providerErrorCode: response.error?.code ?? (httpStatus >= 400 ? `http_${httpStatus}` : null),
    artifactComplete: !outputTruncated,
    sanitizedMetadata: {
      outputItemTypes: [...new Set(outputItemTypes)].slice(0, 20),
      messageStatuses: [...new Set(messageStatuses)].slice(0, 10),
      storedForRecovery,
      outputTruncated
    }
  };
}

function parseResponseJson(response: AnalysisResponseArtifactDraft) {
  assertResponseCanBeParsed(response);
  try {
    return JSON.parse(response.outputText!);
  } catch (error) {
    throw processingError(
      "structured_output_invalid_json",
      "The captured analysis response was not valid structured JSON.",
      "parse",
      error
    );
  }
}

function assertResponseCanBeParsed(response: AnalysisResponseArtifactDraft) {
  if (!response.artifactComplete || response.sanitizedMetadata.outputTruncated) {
    throw processingError(
      "structured_output_capture_incomplete",
      "The stored analysis response is incomplete and requires exact-response recovery.",
      "retrieval"
    );
  }
  if (response.responseStatus === "incomplete") {
    if (response.incompleteReason === "content_filter") {
      throw processingError(
        "provider_content_filtered",
        "The analysis response was stopped by the provider content filter.",
        "response_validation"
      );
    }
    throw processingError(
      "provider_output_incomplete",
      "The analysis response ended before the structured output was complete.",
      "response_validation"
    );
  }
  if (response.responseStatus !== "completed") {
    throw processingError(
      `provider_response_${response.responseStatus}`,
      "The analysis provider returned a terminal response without completed output.",
      "response_validation"
    );
  }
  if (response.refusal) {
    throw processingError(
      "provider_response_refused",
      "The analysis provider declined to produce the requested structured output.",
      "response_validation"
    );
  }
  if (!response.outputText?.trim()) {
    throw processingError(
      "structured_output_missing",
      "The captured analysis response did not contain structured output.",
      "response_validation"
    );
  }
}

const claimToTopLevelField = {
  company_name: "companyName",
  brand_name: "brandName",
  website: "website",
  industry: "industry",
  subindustry: "subindustry",
  business_model: "businessModel",
  profile_summary: "summary"
} as const;

function canonicalizeCompanyProfileFields(raw: unknown) {
  if (!isRecord(raw) || !Array.isArray(raw.claims)) return raw;

  const canonical = { ...raw };
  for (const [claimField, topLevelField] of Object.entries(claimToTopLevelField)) {
    const matchingClaims = raw.claims.filter(
      (claim) => isRecord(claim) && claim.fieldKey === claimField
    );
    if (matchingClaims.length !== 1) continue;

    const claim = matchingClaims[0]!;
    if (
      (claim.status === "measured" || claim.status === "inferred") &&
      typeof claim.value === "string"
    ) {
      canonical[topLevelField as keyof typeof canonical] = claim.value;
    } else if (
      (claim.status === "unavailable" || claim.status === "unmeasured") &&
      claim.value === null
    ) {
      canonical[topLevelField as keyof typeof canonical] = null;
    }
  }
  return canonical;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function groundCompanyProfileEvidence(
  profile: ReturnType<typeof companyProfileDraftSchema.parse>,
  pages: WebsiteEvidencePage[]
) {
  const pagesByIndex = new Map(pages.map((page) => [page.pageIndex, page]));
  const claims = profile.claims.map((claim) => {
    const evidence = groundedEvidence(claim.evidence, pagesByIndex);
    if (claim.status !== "measured" || evidence.length > 0) {
      return { ...claim, evidence };
    }
    const repaired = exactAnchorEvidence(claim.evidence, claim.value, pagesByIndex);
    if (!repaired) throw invalidEvidence();
    return { ...claim, evidence: [repaired] };
  });
  const entities = profile.entities.map((entity) => {
    const evidence = groundedEvidence(entity.evidence, pagesByIndex);
    if (entity.status !== "measured" || evidence.length > 0) {
      return { ...entity, evidence };
    }
    const repaired = exactAnchorEvidence(entity.evidence, entity.name, pagesByIndex);
    if (!repaired) throw invalidEvidence();
    return { ...entity, evidence: [repaired] };
  });

  try {
    return companyProfileDraftSchema.parse(canonicalizeCompanyProfileFields({
      ...profile,
      claims,
      entities
    }));
  } catch (error) {
    throw processingError(
      "structured_evidence_invalid",
      "The captured company profile cited website evidence that was not supplied.",
      "evidence_validation",
      error
    );
  }
}

type EvidencePointer = ReturnType<typeof companyProfileDraftSchema.parse>["claims"][number]["evidence"][number];

function groundedEvidence(
  pointers: EvidencePointer[],
  pagesByIndex: Map<number, WebsiteEvidencePage>
) {
  const seen = new Set<string>();
  return pointers.filter((pointer) => {
    const page = pagesByIndex.get(pointer.pageIndex);
    if (!page || !evidenceTextMatches(page.markdown, pointer.excerpt)) return false;
    const key = `${pointer.pageIndex}:${normalizeEvidenceText(pointer.excerpt)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function exactAnchorEvidence(
  pointers: EvidencePointer[],
  anchor: string | null,
  pagesByIndex: Map<number, WebsiteEvidencePage>
): EvidencePointer | null {
  if (!anchor || anchor.length > 1_000) return null;
  for (const pointer of pointers) {
    const page = pagesByIndex.get(pointer.pageIndex);
    if (page?.markdown.includes(anchor)) {
      return { pageIndex: pointer.pageIndex, excerpt: anchor };
    }
  }
  return null;
}

function evidenceTextMatches(source: string, excerpt: string) {
  return source.includes(excerpt) || normalizeEvidenceText(source).includes(normalizeEvidenceText(excerpt));
}

function normalizeEvidenceText(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function invalidEvidence() {
  return processingError(
    "structured_evidence_invalid",
    "The captured company profile cited website evidence that was not supplied.",
    "evidence_validation"
  );
}

function hasMeasuredGeography(profile: CompanyProfileReadModel) {
  return profile.claims.some(
    (claim) =>
      (claim.fieldKey === "geographic_location" || claim.fieldKey === "geographic_service_area") &&
      claim.status === "measured" &&
      Boolean(claim.value)
  );
}

function structuredResult<T>(response: AnalysisResponseArtifactDraft, output: T) {
  return {
    provider: response.provider,
    model: response.model,
    providerRequestId: response.providerResponseId,
    providerCreatedAt: response.providerCreatedAt,
    promptTemplateVersion: response.promptTemplateVersion,
    usage: { ...response.usage },
    output
  };
}

function processingError(
  safeCode: string,
  safeSummary: string,
  processingPhase: AnalysisProcessingPhase,
  cause?: unknown
) {
  return new ProviderResearchError("permanent", safeCode, safeSummary, {
    providerResponseCaptured: true,
    processingPhase,
    cause
  });
}

function withCapturedResponse(error: ProviderResearchError, processingPhase: AnalysisProcessingPhase) {
  return new ProviderResearchError(error.classification, error.safeCode, error.safeSummary, {
    retryAfterSeconds: error.retryAfterSeconds ?? undefined,
    httpStatus: error.httpStatus,
    providerResponseCaptured: true,
    processingPhase,
    cause: error
  });
}

function mapOpenAiRequestFailure(error: unknown) {
  if (error instanceof ProviderResearchError) return error;
  const status = readNumericProperty(error, "status");
  if (status === 401 || status === 403) {
    return new ProviderResearchError(
      "configuration_error",
      "provider_authentication_failed",
      "The analysis provider requires administrator configuration.",
      { httpStatus: status, outcome: "definitively_rejected", cause: error }
    );
  }
  if (status === 402) {
    return new ProviderResearchError(
      "budget_blocked",
      "provider_credits_unavailable",
      "The analysis provider has no available credits.",
      { httpStatus: status, outcome: "definitively_rejected", cause: error }
    );
  }
  if (status === 429) {
    return new ProviderResearchError(
      "transient",
      "provider_rate_limited",
      "The analysis provider asked us to retry later.",
      { httpStatus: status, retryAfterSeconds: 15, outcome: "transient_retryable", cause: error }
    );
  }
  if (status === 408) {
    return new ProviderResearchError(
      "transient",
      "provider_temporarily_unavailable",
      "The analysis provider request timed out.",
      { httpStatus: status, retryAfterSeconds: 15, outcome: "outcome_uncertain", cause: error }
    );
  }
  if (status !== null && status >= 500) {
    return new ProviderResearchError(
      "transient",
      "provider_temporarily_unavailable",
      "The analysis provider was temporarily unavailable.",
      { httpStatus: status, retryAfterSeconds: 15, outcome: "outcome_uncertain", cause: error }
    );
  }
  if (status !== null && [400, 404, 422].includes(status)) {
    return new ProviderResearchError(
      "permanent",
      "provider_request_rejected",
      "The analysis provider could not accept this request.",
      { httpStatus: status, outcome: "definitively_rejected", cause: error }
    );
  }
  if (isConnectionFailure(error)) {
    return new ProviderResearchError(
      "transient",
      "provider_connection_failed",
      "The analysis provider connection was interrupted.",
      { retryAfterSeconds: 15, outcome: "outcome_uncertain", cause: error }
    );
  }
  return new ProviderResearchError(
    "permanent",
    "structured_analysis_failed",
    "The analysis provider could not return a durable response.",
    { httpStatus: status, outcome: "outcome_uncertain", cause: error }
  );
}

function mapOpenAiReadinessFailure(error: unknown) {
  if (error instanceof ProviderResearchError) return error;
  const status = readNumericProperty(error, "status");
  if (status === 401 || status === 403) {
    return new ProviderResearchError(
      "configuration_error",
      "provider_authentication_failed",
      "The analysis provider requires administrator configuration.",
      { httpStatus: status, outcome: "definitively_rejected", cause: error }
    );
  }
  if (status === 404) {
    return new ProviderResearchError(
      "configuration_error",
      "provider_model_unavailable",
      "The configured analysis model is unavailable.",
      { httpStatus: status, outcome: "definitively_rejected", cause: error }
    );
  }
  if (status === 429 || status === 408 || (status !== null && status >= 500) || isConnectionFailure(error)) {
    return new ProviderResearchError(
      "transient",
      "provider_readiness_temporarily_unavailable",
      "The analysis provider readiness check is temporarily unavailable.",
      { httpStatus: status, retryAfterSeconds: 15, outcome: "transient_retryable", cause: error }
    );
  }
  return new ProviderResearchError(
    "configuration_error",
    "provider_model_unavailable",
    "The configured analysis model is unavailable.",
    { httpStatus: status, outcome: "definitively_rejected", cause: error }
  );
}

function readNumericProperty(value: unknown, key: string) {
  if (!value || typeof value !== "object" || !(key in value)) return null;
  const number = Number(value[key as keyof typeof value]);
  return Number.isFinite(number) ? number : null;
}

function isConnectionFailure(error: unknown) {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  return ["APIConnectionError", "APIConnectionTimeoutError", "AbortError", "TypeError"].includes(String(error.name));
}
