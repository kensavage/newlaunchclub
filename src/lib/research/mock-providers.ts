import {
  COMPANY_PROFILE_PROMPT_VERSION,
  SEARCH_QUERY_PROMPT_VERSION,
  type CompanyProfileDraft,
  type CompanyProfileReadModel,
  type SearchQueryDraft,
  type StructuredAnalysisProvider,
  type WebsiteResearchProvider
} from "@/lib/research/contracts";
import { canonicalizeSourceUrl, sha256 } from "@/lib/research/integrity";

const MOCK_TIME = "2026-01-15T12:00:00.000Z";

export class MockWebsiteResearchProvider implements WebsiteResearchProvider {
  readonly provider = "mock" as const;

  async submit(input: { url: string; maximumPages: number; maximumDepth: 1 }) {
    return {
      provider: this.provider,
      jobId: `mock-crawl-${sha256(canonicalizeSourceUrl(input.url)).slice(0, 24)}`,
      state: "submitted" as const,
      httpStatus: null,
      providerCreatedAt: MOCK_TIME,
      usage: {}
    };
  }

  async poll(input: { jobId: string; expectedUrl: string; maximumPages: number }) {
    const root = canonicalizeSourceUrl(input.expectedUrl);
    const parsed = new URL(root);
    const brand = titleCase(parsed.hostname.replace(/^www\./, "").split(".")[0] ?? "Company");
    const content = [
      `${brand} helps growth teams improve buyer visibility through useful website content and community research. The service is designed for B2B companies that want qualified discovery.`,
      `${brand} provides website research, buyer-language analysis, and practical content strategy. Clients receive documented recommendations and measurable source evidence.`
    ];
    const urls = [root, new URL("/services", root).toString()];
    const pages = content.slice(0, input.maximumPages).map((markdown, pageIndex) => ({
      pageIndex,
      sourceUrl: urls[pageIndex]!,
      canonicalUrl: canonicalizeSourceUrl(urls[pageIndex]!),
      title: pageIndex === 0 ? `${brand} | Buyer visibility` : `${brand} services`,
      description: pageIndex === 0 ? `${brand} helps B2B growth teams.` : "Documented visibility services.",
      markdown,
      contentHash: sha256(markdown),
      rawArtifact: {
        markdown,
        metadata: { sourceURL: urls[pageIndex]!, statusCode: 200 }
      },
      providerCreatedAt: MOCK_TIME,
      crawledAt: MOCK_TIME,
      freshUntil: "2026-01-17T12:00:00.000Z"
    }));
    return {
      state: "completed" as const,
      httpStatus: null,
      providerCompletedAt: MOCK_TIME,
      usage: {},
      pages
    };
  }
}

export class MockStructuredAnalysisProvider implements StructuredAnalysisProvider {
  readonly provider = "mock" as const;

  async extractCompanyProfile(input: {
    normalizedUrl: string;
    domain: string;
    pages: Parameters<StructuredAnalysisProvider["extractCompanyProfile"]>[0]["pages"];
  }) {
    const companyName = titleCase(input.domain.replace(/^www\./, "").split(".")[0] ?? "Company");
    const evidence = [{ pageIndex: input.pages[0]!.pageIndex, excerpt: input.pages[0]!.markdown.slice(0, 160) }];
    const measured = (fieldKey: CompanyProfileDraft["claims"][number]["fieldKey"], value: string) => ({
      fieldKey,
      status: "measured" as const,
      confidence: "high" as const,
      value,
      normalizedValue: value.toLocaleLowerCase("en-US"),
      evidence
    });
    const unavailable = (fieldKey: CompanyProfileDraft["claims"][number]["fieldKey"]) => ({
      fieldKey,
      status: "unavailable" as const,
      confidence: null,
      value: null,
      normalizedValue: null,
      evidence: []
    });
    const output: CompanyProfileDraft = {
      companyName,
      brandName: companyName,
      website: input.normalizedUrl,
      industry: "Buyer visibility services",
      subindustry: "Website and community research",
      businessModel: "B2B services",
      summary: `${companyName} helps B2B growth teams improve buyer visibility.`,
      claims: [
        measured("company_name", companyName),
        measured("brand_name", companyName),
        measured("website", input.normalizedUrl),
        measured("industry", "Buyer visibility services"),
        measured("subindustry", "Website and community research"),
        measured("business_model", "B2B services"),
        measured("target_customers", "B2B growth teams"),
        unavailable("geographic_location"),
        unavailable("geographic_service_area"),
        measured("profile_summary", `${companyName} helps B2B growth teams improve buyer visibility.`)
      ],
      entities: [
        {
          type: "service",
          name: "Buyer visibility research",
          role: null,
          url: new URL("/services", input.normalizedUrl).toString(),
          status: "measured",
          confidence: "high",
          evidence
        },
        {
          type: "value_proposition",
          name: "Documented source evidence",
          role: null,
          url: null,
          status: "measured",
          confidence: "high",
          evidence
        }
      ]
    };
    return {
      provider: this.provider,
      model: "mock-structured-analysis-v1",
      providerRequestId: `mock-profile-${sha256(input.normalizedUrl).slice(0, 24)}`,
      providerCreatedAt: MOCK_TIME,
      promptTemplateVersion: COMPANY_PROFILE_PROMPT_VERSION,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      output
    };
  }

  async discoverSearchQueries(input: { profile: CompanyProfileReadModel; queryCount: number }) {
    const brand = input.profile.brandName ?? input.profile.companyName ?? new URL(input.profile.website).hostname;
    const industry = input.profile.industry ?? "buyer visibility services";
    const templates: Array<[string, SearchQueryDraft["category"], SearchQueryDraft["intent"]]> = [
      [`best ${industry}`, "best_provider", "commercial"],
      [`${industry} reviews`, "review", "commercial"],
      [`${brand} reviews`, "brand", "commercial"],
      [`${brand} alternatives`, "alternative", "commercial"],
      [`how to improve buyer visibility`, "how_to", "informational"],
      [`recommended ${industry}`, "recommendation", "research"],
      [`what should I look for in ${industry}?`, "ai_assistant", "research"],
      [`${industry} for B2B growth teams`, "service", "commercial"],
      [`compare ${industry}`, "comparison", "commercial"],
      [`why buyers cannot find our company`, "problem_aware", "informational"]
    ];
    const queryCount = Math.min(input.queryCount, templates.length);
    const queries = templates.slice(0, queryCount).map(([query, category, intent], index) => ({
      query,
      category,
      intent,
      geographicRelevance: null,
      priority: Math.max(1, 5 - Math.floor(index / 3)),
      rationale: "This query maps to measured company positioning and buyer intent.",
      evidenceClaimKeys: ["industry", "target_customers"] as SearchQueryDraft["evidenceClaimKeys"]
    }));
    return {
      provider: this.provider,
      model: "mock-structured-analysis-v1",
      providerRequestId: `mock-queries-${sha256(input.profile.profileVersionId).slice(0, 24)}`,
      providerCreatedAt: MOCK_TIME,
      promptTemplateVersion: SEARCH_QUERY_PROMPT_VERSION,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      output: { queries }
    };
  }
}

function titleCase(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
