import { describe, expect, it } from "vitest";
import {
  createEvidenceReference,
  createInferredEvidence,
  createMeasuredEvidence,
  createNotMeasuredEvidence,
  createUnavailableEvidence
} from "@/lib/report/evidence";
import {
  evidenceMetadataSchema,
  evidenceStatusSchema,
  opportunityReportSchema,
  reportResponseSchema,
  reportClaimSchema,
  type OpportunityReport
} from "@/lib/report/schema";
import { normalizeOpportunityReportForResponse } from "@/lib/report/normalize-report";
import {
  calculateOpportunityScore,
  getKeywordPriority,
  isAiOpportunitySimulationEnabled
} from "@/lib/report/scoring";
import {
  createMemeConcepts,
  createVisibilitySnapshot,
  getDefaultPricingTiers
} from "@/lib/report/commercial";

const observedAt = "2026-07-06T12:00:00.000Z";
const sourceReference = createEvidenceReference({
  referenceId: "ahrefs-keyword:ai-search-visibility",
  provider: "Ahrefs",
  sourceUrl: null,
  observationDate: observedAt,
  description: "Ahrefs keyword response."
});
const redditReference = createEvidenceReference({
  referenceId: "reddit-thread:example",
  provider: "Firecrawl",
  sourceUrl: "https://www.reddit.com/r/SEO/comments/example/",
  observationDate: observedAt,
  description: "Public Reddit result."
});
const measuredKeywordEvidence = createMeasuredEvidence({
  provider: "Ahrefs",
  observationDate: observedAt,
  references: [sourceReference],
  explanation: "Ahrefs returned this metric."
});
const inferredKeywordEvidence = createInferredEvidence({
  provider: "OpenAI analysis of Ahrefs data",
  observationDate: observedAt,
  references: [sourceReference],
  explanation: "This conclusion is inferred from the keyword research."
});
const measuredRedditEvidence = createMeasuredEvidence({
  provider: "Firecrawl",
  observationDate: observedAt,
  references: [redditReference],
  explanation: "Firecrawl returned this public Reddit result."
});

const validReport: OpportunityReport = {
  publicId: "report123",
  generatedAt: observedAt,
  submittedUrl: "launchclub.ai",
  domain: "launchclub.ai",
  opportunityScore: 82,
  opportunityScoreEvidence: createInferredEvidence({
    provider: "Launch Club deterministic scoring",
    observationDate: observedAt,
    references: [sourceReference, redditReference],
    explanation: "The score is inferred from available report evidence."
  }),
  headline: "Launch Club has a clear AI-search and Reddit opportunity.",
  business: {
    companyName: "Launch Club",
    website: "https://launchclub.ai/",
    category: "AI search visibility",
    primaryKeyword: "AI search visibility",
    summary: "Launch Club helps companies become visible where buyers research."
  },
  businessEvidence: createInferredEvidence({
    provider: "OpenAI analysis of Firecrawl content",
    observationDate: observedAt,
    references: [
      createEvidenceReference({
        referenceId: "website:launchclub",
        provider: "Firecrawl",
        sourceUrl: "https://launchclub.ai/",
        observationDate: observedAt,
        description: "Crawled website content."
      })
    ],
    explanation: "The business profile is inferred from crawled website content."
  }),
  visibilitySnapshot: createVisibilitySnapshot({
    opportunityScore: 82,
    redditOpportunities: [],
    keywordTraffic: 1200
  }),
  keywordOpportunities: [
    {
      keyword: "AI search visibility",
      intent: "Discovery",
      monthlySearchVolume: 900,
      difficulty: 24,
      trafficPotential: 1200,
      sourceVisibility: "Competitor and third-party sources are more visible.",
      redditFit: "High",
      priority: "High",
      recommendedAction: "Publish a practical source page and seed a helpful Reddit angle.",
      evidence: {
        monthlySearchVolume: measuredKeywordEvidence,
        difficulty: measuredKeywordEvidence,
        trafficPotential: measuredKeywordEvidence,
        intent: inferredKeywordEvidence,
        analysis: inferredKeywordEvidence
      }
    }
  ],
  redditOpportunities: [
    {
      title: "How are teams tracking AI mentions?",
      subreddit: "r/SEO",
      url: "https://www.reddit.com/r/SEO/comments/example/",
      estimatedMonthlyViews: null,
      upvoteCount: 21,
      commentCount: 8,
      engagementSummary: "Verified engagement counts are available; monthly traffic is not.",
      discussionSummary: "Buyers are asking for practical tools and examples.",
      whyLowHangingFruit: "The thread has active buyer language.",
      suggestedPostTitle: "How are teams measuring AI-search visibility?",
      suggestedPostBody: "A practical discussion prompt with no hard sell.",
      riskLevel: "Low",
      evidence: {
        discussion: measuredRedditEvidence,
        monthlyViews: createNotMeasuredEvidence("Monthly Reddit traffic was not measured."),
        upvotes: measuredRedditEvidence,
        comments: measuredRedditEvidence,
        analysis: createInferredEvidence({
          provider: "OpenAI analysis of Firecrawl evidence",
          observationDate: observedAt,
          references: [redditReference],
          explanation: "The opportunity is inferred from the public discussion."
        })
      }
    }
  ],
  competitorGaps: [
    {
      competitor: "Example Competitor",
      source: "example.com",
      url: "https://example.com",
      gap: "The competitor has clearer third-party source coverage.",
      recommendedAction: "Create comparison content backed by useful source mentions.",
      evidence: createInferredEvidence({
        provider: "OpenAI competitor analysis",
        observationDate: observedAt,
        references: [sourceReference],
        explanation: "The gap is inferred from available search evidence."
      })
    }
  ],
  aiCitationOpportunities: Array.from({ length: 4 }, (_, index) => ({
    prompt: `AI search opportunity ${index + 1}?`,
    sampleAnswer: "This is a simulated planning answer.",
    citationAngle: "Create stronger source coverage.",
    isSimulation: true as const,
    evidence: createNotMeasuredEvidence("Live AI-platform visibility was not measured.")
  })),
  memeConcepts: createMemeConcepts({
    companyName: "Launch Club",
    category: "AI search visibility",
    primaryKeyword: "AI search visibility"
  }),
  pricingTiers: getDefaultPricingTiers(),
  bookingUrl: "mailto:hello@launchclub.ai?subject=Buyer%20Visibility%20Sprint",
  nextSteps: ["Prioritize the top Reddit-fit keywords."],
  evidenceSummary: {
    researchMode: "live",
    crawlSummary: "Main page text was analyzed.",
    keywordSource: "Keyword metrics came from provider data.",
    redditSource: "Reddit links and summaries were stored.",
    aiSearchSource: "Live AI-platform visibility was not measured.",
    generatedWithRealAiChecks: false
  },
  claims: [
    {
      claimId: "keyword-volume",
      claimText: "Ahrefs returned monthly volume for one keyword.",
      ...measuredKeywordEvidence
    }
  ]
};

describe("report evidence, scoring, and truth labeling", () => {
  it("accepts the public search-intelligence handoff without claiming report completion", () => {
    const response = reportResponseSchema.parse({
      job: {
        publicId: "secure-report-access",
        status: "running",
        state: "research_ready",
        currentStep: "research_ready",
        progress: null,
        steps: [
          { id: "queued", label: "Request received", status: "complete" },
          { id: "crawl", label: "Reviewing your website", status: "complete" },
          { id: "analysis", label: "Building your company profile", status: "complete" },
          { id: "keywords", label: "Preparing your market research", status: "complete" }
        ],
        errorSummary: null
      },
      report: null
    });

    expect(response.job).toMatchObject({
      status: "running",
      state: "research_ready",
      currentStep: "research_ready",
      progress: null
    });
    expect(response.report).toBeNull();
  });

  it("accepts a visitor-safe report payload", () => {
    expect(opportunityReportSchema.parse(validReport).publicId).toBe("report123");
  });

  it("requires exactly four AI-search prompt examples", () => {
    const invalidReport = {
      ...validReport,
      aiCitationOpportunities: validReport.aiCitationOpportunities.slice(0, 3)
    };

    expect(() => opportunityReportSchema.parse(invalidReport)).toThrow();
  });

  it("validates evidence status values", () => {
    expect(evidenceStatusSchema.parse("Measured")).toBe("Measured");
    expect(() => evidenceStatusSchema.parse("Verified")).toThrow();
  });

  it("requires evidence references for measured values and claims", () => {
    const unsupportedMeasured = {
      evidenceStatus: "Measured",
      evidenceReferences: [],
      observationDate: observedAt,
      sourceProvider: "Ahrefs",
      confidence: null,
      publicExplanation: "Missing supporting evidence."
    };

    expect(() => evidenceMetadataSchema.parse(unsupportedMeasured)).toThrow(/requires evidence/i);
    expect(() =>
      reportClaimSchema.parse({
        claimId: "unsupported",
        claimText: "Unsupported measured claim.",
        ...unsupportedMeasured
      })
    ).toThrow(/requires evidence/i);
  });

  it("keeps missing keyword metrics unavailable instead of inventing fallback values", () => {
    const normalized = normalizeOpportunityReportForResponse({
      report: {
        ...validReport,
        keywordOpportunities: [
          {
            ...validReport.keywordOpportunities[0],
            monthlySearchVolume: null,
            evidence: {
              ...validReport.keywordOpportunities[0].evidence,
              monthlySearchVolume: createUnavailableEvidence({
                provider: "Ahrefs",
                observationDate: observedAt,
                explanation: "Ahrefs returned no volume."
              })
            }
          }
        ]
      },
      bookingUrl: validReport.bookingUrl
    });

    expect(normalized.keywordOpportunities[0].monthlySearchVolume).toBeNull();
    expect(normalized.keywordOpportunities[0].evidence.monthlySearchVolume.evidenceStatus).toBe(
      "Unavailable"
    );
  });

  it("does not trust legacy keyword values that lack stored evidence", () => {
    const legacyReport = structuredClone(validReport) as OpportunityReport;
    delete (legacyReport.keywordOpportunities[0] as Partial<(typeof legacyReport.keywordOpportunities)[number]>).evidence;

    const normalized = normalizeOpportunityReportForResponse({
      report: legacyReport,
      bookingUrl: validReport.bookingUrl
    });

    expect(normalized.keywordOpportunities[0].monthlySearchVolume).toBeNull();
    expect(normalized.keywordOpportunities[0].evidence.monthlySearchVolume.evidenceStatus).toBe(
      "Unavailable"
    );
  });

  it("keeps missing Reddit metrics unavailable and never estimates monthly views", () => {
    const report = structuredClone(validReport);
    report.redditOpportunities[0].estimatedMonthlyViews = 9_999;
    report.redditOpportunities[0].upvoteCount = null;
    report.redditOpportunities[0].evidence.upvotes = createUnavailableEvidence({
      provider: "Firecrawl",
      observationDate: observedAt,
      explanation: "Firecrawl returned no upvote count."
    });

    const normalized = normalizeOpportunityReportForResponse({
      report,
      bookingUrl: validReport.bookingUrl
    });

    expect(normalized.redditOpportunities[0].estimatedMonthlyViews).toBeNull();
    expect(normalized.redditOpportunities[0].evidence.monthlyViews.evidenceStatus).toBe(
      "Not measured"
    );
    expect(normalized.redditOpportunities[0].upvoteCount).toBeNull();
    expect(normalized.redditOpportunities[0].evidence.upvotes.evidenceStatus).toBe("Unavailable");
  });

  it("prevents a configuration flag or mock payload from appearing as a measured AI check", () => {
    const report = structuredClone(validReport) as OpportunityReport;
    (report.aiCitationOpportunities[0] as unknown as { isSimulation: boolean }).isSimulation = false;
    report.aiCitationOpportunities[0].evidence = measuredRedditEvidence;
    report.evidenceSummary.generatedWithRealAiChecks = true;

    const normalized = normalizeOpportunityReportForResponse({
      report,
      bookingUrl: validReport.bookingUrl
    });

    expect(isAiOpportunitySimulationEnabled(true)).toBe(true);
    expect(normalized.aiCitationOpportunities.every((item) => item.isSimulation)).toBe(true);
    expect(
      normalized.aiCitationOpportunities.every(
        (item) => item.evidence.evidenceStatus === "Not measured"
      )
    ).toBe(true);
    expect(normalized.evidenceSummary.generatedWithRealAiChecks).toBe(false);
  });

  it("downgrades cached mock research even when an older report stored stronger labels", () => {
    const report = structuredClone(validReport);
    report.evidenceSummary.researchMode = "mock";
    report.evidenceSummary.keywordSource = "Keyword metrics came from mock provider data in local mode.";

    const normalized = normalizeOpportunityReportForResponse({
      report,
      bookingUrl: validReport.bookingUrl
    });

    expect(normalized.opportunityScoreEvidence.evidenceStatus).toBe("Not measured");
    expect(normalized.businessEvidence.evidenceStatus).toBe("Not measured");
    expect(normalized.keywordOpportunities[0].monthlySearchVolume).toBeNull();
    expect(normalized.redditOpportunities[0].evidence.discussion.evidenceStatus).toBe(
      "Not measured"
    );
    expect(normalized.claims.every((claim) => claim.evidenceStatus !== "Measured")).toBe(true);
  });

  it("keeps deterministic opportunity scoring but classifies it as inferred", () => {
    const expectedScore = calculateOpportunityScore({
      keywordOpportunities: validReport.keywordOpportunities,
      redditOpportunities: validReport.redditOpportunities,
      competitorGaps: validReport.competitorGaps
    });
    const normalized = normalizeOpportunityReportForResponse({
      report: { ...validReport, opportunityScore: 1 },
      bookingUrl: validReport.bookingUrl
    });

    expect(normalized.opportunityScore).toBe(expectedScore);
    expect(normalized.opportunityScoreEvidence.evidenceStatus).toBe("Inferred");
    expect(normalized.visibilitySnapshot.currentAiVisibilityScore).toBeNull();
    expect(getKeywordPriority(800, "High")).toBe("High");
  });
});
