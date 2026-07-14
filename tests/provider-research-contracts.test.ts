// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { parseServerEnv } from "@/lib/env-schema";
import {
  ProviderResearchError,
  SEARCH_QUERY_HARD_MAX,
  assertQueriesSupportedByProfile,
  companyProfileDraftSchema,
  normalizeDiscoveredQueries,
  searchQuerySetDraftSchema
} from "@/lib/research/contracts";
import {
  createProviderResearchProviders,
  getProviderResearchReservationPolicy
} from "@/lib/research/provider-factory";
import { selectCompanyProfileContext } from "@/lib/research/context-selection";
import {
  syntheticCompanyProfile,
  syntheticCompanyProfileReadModel,
  syntheticEvidencePages,
  syntheticQueries
} from "./fixtures/provider-research";

describe("PR4 provider contracts and selection", () => {
  it("rejects unsupported profile claims instead of turning missing facts into measurements", () => {
    const missingEvidence = syntheticCompanyProfile();
    missingEvidence.claims[0]!.evidence = [];
    expect(() => companyProfileDraftSchema.parse(missingEvidence)).toThrow(/evidence/i);

    const unavailableWithValue = syntheticCompanyProfile();
    unavailableWithValue.claims[7] = {
      fieldKey: "geographic_location",
      status: "unavailable",
      confidence: null,
      value: "New York",
      normalizedValue: "new york",
      evidence: []
    };
    expect(() => companyProfileDraftSchema.parse(unavailableWithValue)).toThrow(/empty/i);

    const duplicateClaim = syntheticCompanyProfile();
    duplicateClaim.claims[9] = { ...duplicateClaim.claims[0]! };
    expect(() => companyProfileDraftSchema.parse(duplicateClaim)).toThrow(/exactly once|Missing/i);
  });

  it("normalizes and deduplicates queries, enforces the hard cap, and rejects invented geography", () => {
    const [first, second] = syntheticQueries(2);
    const deduped = normalizeDiscoveredQueries({
      queries: [first!, { ...first!, query: `  ${first!.query.toUpperCase()}  ` }, second!]
    }, { maximum: 30, hasVerifiedGeography: false });
    expect(deduped.map((query) => query.query)).toEqual([first!.query, second!.query]);

    expect(() => normalizeDiscoveredQueries({
      queries: [{ ...first!, geographicRelevance: "New York" }]
    }, { maximum: 30, hasVerifiedGeography: false })).toThrow(ProviderResearchError);

    expect(() => searchQuerySetDraftSchema.parse({
      queries: syntheticQueries(SEARCH_QUERY_HARD_MAX + 1)
    })).toThrow();
    expect(normalizeDiscoveredQueries({
      queries: syntheticQueries(10)
    }, { maximum: 5, hasVerifiedGeography: false })).toHaveLength(5);

    expect(() => assertQueriesSupportedByProfile([{
      ...first!,
      evidenceClaimKeys: ["geographic_location"]
    }], syntheticCompanyProfileReadModel())).toThrow(/unsupported company-profile claim/i);
  });

  it("keeps mock providers deterministic, cost-free, and completely offline", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error("Network access is forbidden in mock mode.");
    });
    const providers = createProviderResearchProviders(parseServerEnv({
      V3_PROVIDER_RESEARCH_ENABLED: "true",
      REPORT_USE_MOCK_PROVIDERS: "true",
      V3_PROVIDER_QUERY_COUNT: "8"
    }), { fetchImplementation: fetchMock as typeof fetch });

    const firstSubmission = await providers.website.submit({
      url: "https://example.com/",
      maximumPages: 7,
      maximumDepth: 1
    });
    const secondSubmission = await providers.website.submit({
      url: "https://example.com/",
      maximumPages: 7,
      maximumDepth: 1
    });
    expect(firstSubmission).toEqual(secondSubmission);
    const firstPoll = await providers.website.poll({
      jobId: firstSubmission.jobId,
      expectedUrl: "https://example.com/",
      maximumPages: 7
    });
    const secondPoll = await providers.website.poll({
      jobId: secondSubmission.jobId,
      expectedUrl: "https://example.com/",
      maximumPages: 7
    });
    expect(firstPoll).toEqual(secondPoll);

    const selectedPages = selectCompanyProfileContext(syntheticEvidencePages()).pages;
    const firstProfile = await providers.analysis.createCompanyProfileResponse({
      normalizedUrl: "https://example.com/",
      domain: "example.com",
      pages: selectedPages
    });
    const secondProfile = await providers.analysis.createCompanyProfileResponse({
      normalizedUrl: "https://example.com/",
      domain: "example.com",
      pages: selectedPages
    });
    await providers.analysis.checkReadiness();
    expect(firstProfile).toEqual(secondProfile);
    expect(providers.mockMode).toBe(true);
    expect(providers.costPolicy.websiteReservationCents).toBe(0);
    expect(providers.costPolicy.actualModelCost({ inputTokens: 1_000 })).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when PR4 or required live-provider configuration is missing", () => {
    expect(() => createProviderResearchProviders(parseServerEnv({
      REPORT_USE_MOCK_PROVIDERS: "true"
    }))).toThrow(/disabled/i);

    expect(() => createProviderResearchProviders(parseServerEnv({
      V3_PROVIDER_RESEARCH_ENABLED: "true",
      REPORT_USE_MOCK_PROVIDERS: "false"
    }))).toThrow(/credentials/i);

    expect(() => createProviderResearchProviders(parseServerEnv({
      V3_PROVIDER_RESEARCH_ENABLED: "true",
      REPORT_USE_MOCK_PROVIDERS: "false",
      FIRECRAWL_API_KEY: "synthetic",
      OPENAI_API_KEY: "synthetic"
    }))).toThrow(/unit costs/i);
  });

  it("rejects reservation policy that exceeds the existing 400-cent report budget", () => {
    expect(getProviderResearchReservationPolicy(parseServerEnv({
      V3_FIRECRAWL_RESERVATION_CENTS: "160",
      V3_OPENAI_PROFILE_RESERVATION_CENTS: "120",
      V3_OPENAI_QUERY_RESERVATION_CENTS: "120"
    }))).toEqual({
      websiteReservationCents: 160,
      profileReservationCents: 120,
      queryReservationCents: 120
    });

    expect(() => getProviderResearchReservationPolicy(parseServerEnv({
      V3_FIRECRAWL_RESERVATION_CENTS: "200",
      V3_OPENAI_PROFILE_RESERVATION_CENTS: "150",
      V3_OPENAI_QUERY_RESERVATION_CENTS: "100"
    }))).toThrow(/budget/i);
  });

  it("enforces a stricter server-configured provider reservation cap", () => {
    expect(getProviderResearchReservationPolicy(parseServerEnv({
      V3_PROVIDER_MAX_RESERVATION_CENTS: "100",
      V3_FIRECRAWL_RESERVATION_CENTS: "50",
      V3_OPENAI_PROFILE_RESERVATION_CENTS: "25",
      V3_OPENAI_QUERY_RESERVATION_CENTS: "25"
    }))).toEqual({
      websiteReservationCents: 50,
      profileReservationCents: 25,
      queryReservationCents: 25
    });

    expect(() => getProviderResearchReservationPolicy(parseServerEnv({
      V3_PROVIDER_MAX_RESERVATION_CENTS: "100",
      V3_FIRECRAWL_RESERVATION_CENTS: "50",
      V3_OPENAI_PROFILE_RESERVATION_CENTS: "26",
      V3_OPENAI_QUERY_RESERVATION_CENTS: "25"
    }))).toThrow(/configured provider cap/i);
  });
});
