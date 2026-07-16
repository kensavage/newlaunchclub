import type {
  CompanyProfileDraft,
  CompanyProfileReadModel,
  SearchQueryDraft,
  WebsiteEvidencePage
} from "@/lib/research/contracts";
import { sha256 } from "@/lib/research/integrity";

export const SYNTHETIC_RESEARCH_TIME = "2026-01-15T12:00:00.000Z";

export function syntheticEvidencePages(website = "https://example.com/"): WebsiteEvidencePage[] {
  const markdown = "Example Labs provides buyer research for B2B growth teams. Its documented methodology and public case studies help customers make evidence-based decisions.";
  return [{
    snapshotId: "11111111-1111-4111-8111-111111111111",
    pageIndex: 0,
    sourceUrl: website,
    canonicalUrl: website,
    title: "Example Labs",
    description: "Buyer research for B2B teams.",
    markdown,
    contentHash: sha256(markdown),
    crawledAt: SYNTHETIC_RESEARCH_TIME,
    providerCreatedAt: SYNTHETIC_RESEARCH_TIME,
    freshUntil: "2026-01-17T12:00:00.000Z"
  }];
}

export function syntheticCompanyProfile(website = "https://example.com/"): CompanyProfileDraft {
  const evidence = [{
    pageIndex: 0,
    excerpt: "Example Labs provides buyer research for B2B growth teams."
  }];
  const measured = (
    fieldKey: CompanyProfileDraft["claims"][number]["fieldKey"],
    value: string
  ) => ({
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

  return {
    companyName: "Example Labs",
    brandName: "Example Labs",
    website,
    industry: "Buyer research",
    subindustry: "B2B visibility research",
    businessModel: "B2B services",
    summary: "Example Labs provides documented buyer research for B2B growth teams.",
    claims: [
      measured("company_name", "Example Labs"),
      measured("brand_name", "Example Labs"),
      measured("website", website),
      measured("industry", "Buyer research"),
      measured("subindustry", "B2B visibility research"),
      measured("business_model", "B2B services"),
      measured("target_customers", "B2B growth teams"),
      unavailable("geographic_location"),
      unavailable("geographic_service_area"),
      measured("profile_summary", "Example Labs provides documented buyer research for B2B growth teams.")
    ],
    entities: [
      {
        type: "service",
        name: "Buyer research",
        role: "Core service",
        url: new URL("/services", website).toString(),
        status: "measured",
        confidence: "high",
        evidence
      },
      {
        type: "trust_signal",
        name: "Public case studies",
        role: "Customer proof",
        url: new URL("/case-studies", website).toString(),
        status: "measured",
        confidence: "high",
        evidence
      }
    ]
  };
}

export function syntheticQueries(count = 3): SearchQueryDraft[] {
  const seeds: Array<[
    string,
    SearchQueryDraft["category"],
    SearchQueryDraft["intent"]
  ]> = [
    ["best buyer research services", "best_provider", "commercial"],
    ["buyer research services reviews", "review", "research"],
    ["how to improve B2B buyer visibility", "how_to", "informational"],
    ["Example Labs alternatives", "alternative", "commercial"],
    ["what buyer research service should a B2B team use?", "ai_assistant", "research"]
  ];
  return Array.from({ length: count }, (_, index) => {
    const [query, category, intent] = seeds[index % seeds.length]!;
    const suffix = index < seeds.length ? "" : ` ${index + 1}`;
    return {
      query: `${query}${suffix}`,
      category,
      intent,
      geographicRelevance: null,
      priority: Math.max(1, 5 - (index % 5)),
      rationale: "The query follows measured company positioning and buyer intent.",
      evidenceClaimKeys: ["industry", "target_customers"]
    };
  });
}

export function syntheticCompanyProfileReadModel(
  website = "https://example.com/"
): CompanyProfileReadModel {
  const profile = syntheticCompanyProfile(website);
  return {
    profileVersionId: "22222222-2222-4222-8222-222222222222",
    profileVersion: 1,
    companyName: profile.companyName,
    brandName: profile.brandName,
    website: profile.website,
    industry: profile.industry,
    subindustry: profile.subindustry,
    businessModel: profile.businessModel,
    summary: profile.summary,
    researchFreshAt: SYNTHETIC_RESEARCH_TIME,
    freshUntil: "2026-01-17T12:00:00.000Z",
    claims: profile.claims.map((claim, index) => ({
      id: `claim-${index}`,
      fieldKey: claim.fieldKey,
      status: claim.status,
      confidence: claim.confidence,
      value: claim.value,
      normalizedValue: claim.normalizedValue
    })),
    entities: profile.entities.map((entity, index) => ({
      id: `entity-${index}`,
      type: entity.type,
      name: entity.name,
      normalizedName: entity.name.toLocaleLowerCase("en-US"),
      role: entity.role,
      url: entity.url,
      status: entity.status,
      confidence: entity.confidence
    }))
  };
}
