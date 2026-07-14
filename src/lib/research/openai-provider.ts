import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
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
  type CompanyProfileReadModel,
  type StructuredAnalysisProvider,
  type WebsiteEvidencePage
} from "@/lib/research/contracts";

const MAX_EVIDENCE_CHARACTERS = 90_000;
const MAX_OUTPUT_URL_CHARACTERS = 2_048;

// OpenAI Structured Outputs does not support JSON Schema's "uri" format.
// Keep the wire schema compatible, then apply the stricter domain schema below.
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

  async extractCompanyProfile(input: {
    normalizedUrl: string;
    domain: string;
    pages: WebsiteEvidencePage[];
  }) {
    let providerAccepted = false;
    try {
      const response = await this.client.responses.parse({
        model: this.model,
        store: false,
        reasoning: { effort: "none" },
        max_output_tokens: 8_000,
        input: [
          {
            role: "system",
            content: [
              "Build a factual company profile using only the supplied website pages.",
              "Return every required claim field exactly once.",
              "Use measured only when a page excerpt directly supports the value.",
              "Use inferred for a cautious interpretation, unavailable when the site does not say, and unmeasured when the requested concept cannot be evaluated.",
              "Measured claims and entities must cite pageIndex and a short verbatim excerpt. Never invent people, locations, reviews, proof, competitors, products, or services.",
              "A likely competitor may be included only if the website explicitly names or compares it.",
              "Do not include reasoning, private data, or facts from outside the supplied pages."
            ].join(" ")
          },
          {
            role: "user",
            content: JSON.stringify({
              website: input.normalizedUrl,
              domain: input.domain,
              pages: compactPages(input.pages)
            })
          }
        ],
        text: {
          format: zodTextFormat(openAiCompanyProfileDraftSchema, "company_profile")
        }
      });
      providerAccepted = true;
      if (!response.output_parsed) {
        throw new ProviderResearchError(
          "permanent",
          "structured_output_missing",
          "The analysis provider did not return a valid company profile."
        );
      }
      const output = companyProfileDraftSchema.parse(response.output_parsed);
      assertEvidencePointers(output, input.pages);
      return structuredResult(response, this.model, COMPANY_PROFILE_PROMPT_VERSION, output);
    } catch (error) {
      throw mapOpenAiFailure(error, providerAccepted);
    }
  }

  async discoverSearchQueries(input: {
    profile: CompanyProfileReadModel;
    queryCount: number;
  }) {
    let providerAccepted = false;
    try {
      const hasVerifiedGeography = input.profile.claims.some(
        (claim) =>
          (claim.fieldKey === "geographic_location" || claim.fieldKey === "geographic_service_area") &&
          claim.status === "measured" &&
          Boolean(claim.value)
      );
      const response = await this.client.responses.parse({
        model: this.model,
        store: false,
        reasoning: { effort: "none" },
        max_output_tokens: 6_000,
        input: [
          {
            role: "system",
            content: [
              `Generate ${input.queryCount} useful search queries from the supplied company profile.`,
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
      providerAccepted = true;
      if (!response.output_parsed) {
        throw new ProviderResearchError(
          "permanent",
          "structured_output_missing",
          "The analysis provider did not return valid search queries."
        );
      }
      const queries = normalizeDiscoveredQueries(response.output_parsed, {
        maximum: input.queryCount,
        hasVerifiedGeography
      });
      assertQueriesSupportedByProfile(queries, input.profile);
      if (!queries.length) {
        throw new ProviderResearchError(
          "permanent",
          "search_queries_empty",
          "The analysis provider did not return usable search queries."
        );
      }
      return structuredResult(response, this.model, SEARCH_QUERY_PROMPT_VERSION, { queries });
    } catch (error) {
      throw mapOpenAiFailure(error, providerAccepted);
    }
  }
}

function compactPages(pages: WebsiteEvidencePage[]) {
  let remaining = MAX_EVIDENCE_CHARACTERS;
  return pages.flatMap((page) => {
    if (remaining <= 0) return [];
    const markdown = page.markdown.slice(0, Math.min(remaining, 18_000));
    remaining -= markdown.length;
    return [{
      pageIndex: page.pageIndex,
      url: page.canonicalUrl,
      title: page.title,
      description: page.description,
      markdown
    }];
  });
}

function assertEvidencePointers(
  profile: ReturnType<typeof companyProfileDraftSchema.parse>,
  pages: WebsiteEvidencePage[]
) {
  const pagesByIndex = new Map(pages.map((page) => [page.pageIndex, page]));
  const pointers = [
    ...profile.claims.flatMap((claim) => claim.evidence),
    ...profile.entities.flatMap((entity) => entity.evidence)
  ];
  if (pointers.some((pointer) => {
    const page = pagesByIndex.get(pointer.pageIndex);
    return !page || !page.markdown.includes(pointer.excerpt);
  })) {
    throw new ProviderResearchError(
      "permanent",
      "structured_evidence_invalid",
      "The analysis provider cited website evidence that was not supplied."
    );
  }
}

function structuredResult<T>(
  response: {
    id: string;
    created_at: number;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      input_tokens_details?: { cached_tokens?: number };
    } | null;
  },
  model: string,
  promptTemplateVersion: string,
  output: T
) {
  const usage = response.usage;
  return {
    provider: "openai" as const,
    model,
    providerRequestId: response.id,
    providerCreatedAt: new Date(response.created_at * 1_000).toISOString(),
    promptTemplateVersion,
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
      cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? 0
    },
    output
  };
}

function mapOpenAiFailure(error: unknown, providerAccepted = false) {
  if (error instanceof ProviderResearchError) {
    if (!providerAccepted || error.outcome === "outcome_uncertain") return error;
    return new ProviderResearchError(
      error.classification,
      error.safeCode,
      error.safeSummary,
      {
        httpStatus: error.httpStatus,
        retryAfterSeconds: error.retryAfterSeconds ?? undefined,
        outcome: "outcome_uncertain",
        cause: error
      }
    );
  }
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
    "The analysis provider could not produce a valid structured result.",
    {
      httpStatus: status,
      outcome: "outcome_uncertain",
      cause: error
    }
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
