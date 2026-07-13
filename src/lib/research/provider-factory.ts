import type { ServerEnv } from "@/lib/env-schema";
import {
  ProviderResearchError,
  type ProviderUsage,
  type StructuredAnalysisProvider,
  type WebsiteResearchProvider
} from "@/lib/research/contracts";
import { FirecrawlWebsiteResearchProvider } from "@/lib/research/firecrawl-provider";
import {
  MockStructuredAnalysisProvider,
  MockWebsiteResearchProvider
} from "@/lib/research/mock-providers";
import { OpenAIStructuredAnalysisProvider } from "@/lib/research/openai-provider";

export interface ProviderResearchCostPolicy {
  websiteReservationCents: number;
  profileReservationCents: number;
  queryReservationCents: number;
  actualWebsiteCost(usage: ProviderUsage): number;
  actualModelCost(usage: ProviderUsage): number;
}

export interface ProviderResearchProviders {
  website: WebsiteResearchProvider;
  analysis: StructuredAnalysisProvider;
  costPolicy: ProviderResearchCostPolicy;
  maximumPages: number;
  queryCount: number;
  evidenceTtlHours: number;
  mockMode: boolean;
}

export function createProviderResearchProviders(
  env: ServerEnv,
  options: { fetchImplementation?: typeof fetch } = {}
): ProviderResearchProviders {
  if (!env.V3_PROVIDER_RESEARCH_ENABLED) {
    throw configurationError("PR4 provider research is disabled.");
  }
  const reservationPolicy = getProviderResearchReservationPolicy(env);

  if (env.REPORT_USE_MOCK_PROVIDERS) {
    return {
      website: new MockWebsiteResearchProvider(),
      analysis: new MockStructuredAnalysisProvider(),
      costPolicy: {
        websiteReservationCents: 0,
        profileReservationCents: 0,
        queryReservationCents: 0,
        actualWebsiteCost: () => 0,
        actualModelCost: () => 0
      },
      maximumPages: env.V3_PROVIDER_MAX_CRAWL_PAGES,
      queryCount: env.V3_PROVIDER_QUERY_COUNT,
      evidenceTtlHours: env.V3_PROVIDER_EVIDENCE_TTL_HOURS,
      mockMode: true
    };
  }

  if (!env.FIRECRAWL_API_KEY || !env.OPENAI_API_KEY) {
    throw configurationError("Live PR4 providers require Firecrawl and OpenAI credentials.");
  }
  if (
    env.V3_FIRECRAWL_CENTS_PER_CREDIT === undefined ||
    env.V3_OPENAI_INPUT_CENTS_PER_MILLION_TOKENS === undefined ||
    env.V3_OPENAI_OUTPUT_CENTS_PER_MILLION_TOKENS === undefined
  ) {
    throw configurationError("Live PR4 provider unit costs must be configured.");
  }

  const firecrawlRate = env.V3_FIRECRAWL_CENTS_PER_CREDIT;
  const inputRate = env.V3_OPENAI_INPUT_CENTS_PER_MILLION_TOKENS;
  const outputRate = env.V3_OPENAI_OUTPUT_CENTS_PER_MILLION_TOKENS;
  return {
    website: new FirecrawlWebsiteResearchProvider(env.FIRECRAWL_API_KEY, {
      fetchImplementation: options.fetchImplementation,
      pollIntervalSeconds: env.V3_PROVIDER_POLL_INTERVAL_SECONDS
    }),
    analysis: new OpenAIStructuredAnalysisProvider(
      env.OPENAI_API_KEY,
      env.OPENAI_MODEL_FAST,
      { fetchImplementation: options.fetchImplementation }
    ),
    costPolicy: {
      websiteReservationCents: reservationPolicy.websiteReservationCents,
      profileReservationCents: reservationPolicy.profileReservationCents,
      queryReservationCents: reservationPolicy.queryReservationCents,
      actualWebsiteCost: (usage) => roundedProviderCost((usage.creditsUsed ?? 0) * firecrawlRate),
      actualModelCost: (usage) => roundedProviderCost(
        ((usage.inputTokens ?? 0) * inputRate + (usage.outputTokens ?? 0) * outputRate) / 1_000_000
      )
    },
    maximumPages: env.V3_PROVIDER_MAX_CRAWL_PAGES,
    queryCount: env.V3_PROVIDER_QUERY_COUNT,
    evidenceTtlHours: env.V3_PROVIDER_EVIDENCE_TTL_HOURS,
    mockMode: false
  };
}

export function getProviderResearchReservationPolicy(env: ServerEnv) {
  const policy = {
    websiteReservationCents: env.REPORT_USE_MOCK_PROVIDERS ? 0 : env.V3_FIRECRAWL_RESERVATION_CENTS,
    profileReservationCents: env.REPORT_USE_MOCK_PROVIDERS ? 0 : env.V3_OPENAI_PROFILE_RESERVATION_CENTS,
    queryReservationCents: env.REPORT_USE_MOCK_PROVIDERS ? 0 : env.V3_OPENAI_QUERY_RESERVATION_CENTS
  };
  const totalReservation = policy.websiteReservationCents +
    policy.profileReservationCents + policy.queryReservationCents;
  if (totalReservation > 400) {
    throw configurationError("PR4 provider reservations exceed the report budget.");
  }
  if (totalReservation > env.V3_PROVIDER_MAX_RESERVATION_CENTS) {
    throw configurationError("PR4 provider reservations exceed the configured provider cap.");
  }
  return policy;
}

export function assertCostWithinReservation(actualCents: number, reservedCents: number) {
  if (actualCents > reservedCents) {
    throw new ProviderResearchError(
      "budget_blocked",
      "provider_cost_exceeded_reservation",
      "The provider cost exceeded its reserved report budget."
    );
  }
  return actualCents;
}

function roundedProviderCost(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    throw configurationError("Provider cost calculation is invalid.");
  }
  return value === 0 ? 0 : Math.ceil(value);
}

function configurationError(message: string) {
  return new ProviderResearchError(
    "configuration_error",
    "provider_research_configuration",
    message
  );
}
