import { describe, expect, it } from "vitest";
import { opportunityReportSchema, type OpportunityReport } from "@/lib/report/schema";
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

const validReport: OpportunityReport = {
  publicId: "report123",
  generatedAt: new Date("2026-07-06T12:00:00.000Z").toISOString(),
  submittedUrl: "launchclub.ai",
  domain: "launchclub.ai",
  opportunityScore: 82,
  headline: "Launch Club has clear AI-search and Reddit opportunity.",
  business: {
    companyName: "Launch Club",
    website: "https://launchclub.ai/",
    category: "AI search visibility",
    primaryKeyword: "AI search visibility",
    summary: "Launch Club helps companies become visible where buyers research."
  },
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
      recommendedAction: "Publish a practical source page and seed a helpful Reddit angle."
    }
  ],
  redditOpportunities: [
    {
      title: "How are teams tracking AI mentions?",
      subreddit: "r/SEO",
      url: "https://www.reddit.com/r/SEO/comments/example/",
      estimatedMonthlyViews: 3400,
      upvoteCount: 21,
      commentCount: 8,
      engagementSummary: "21 upvotes and 8 comments, used as a directional engagement proxy.",
      discussionSummary: "Buyers are asking for practical tools and examples.",
      whyLowHangingFruit: "The thread has active buyer language.",
      suggestedPostTitle: "How are teams measuring AI-search visibility?",
      suggestedPostBody: "A practical discussion prompt with no hard sell.",
      riskLevel: "Low"
    }
  ],
  competitorGaps: [
    {
      competitor: "Example Competitor",
      source: "example.com",
      url: "https://example.com",
      gap: "The competitor has clearer third-party source coverage.",
      recommendedAction: "Create comparison content backed by useful source mentions."
    }
  ],
  aiCitationOpportunities: [
    {
      prompt: "What are the best AI search visibility services?",
      sampleAnswer: "Launch Club could be referenced alongside alternatives with stronger source coverage.",
      citationAngle: "Create credible comparison and proof pages.",
      isSimulation: true
    },
    {
      prompt: "What do Reddit users recommend for AI search visibility?",
      sampleAnswer: "Helpful Reddit discussions could make Launch Club easier to discover.",
      citationAngle: "Participate with educational comments.",
      isSimulation: true
    },
    {
      prompt: "Which AI search visibility company is best for startups?",
      sampleAnswer: "Launch Club could qualify with startup-specific proof.",
      citationAngle: "Publish startup-specific positioning.",
      isSimulation: true
    },
    {
      prompt: "What are alternatives to common AI visibility platforms?",
      sampleAnswer: "Launch Club needs structured alternatives content.",
      citationAngle: "Create factual alternatives content.",
      isSimulation: true
    }
  ],
  memeConcepts: createMemeConcepts({
    companyName: "Launch Club",
    category: "AI search visibility",
    primaryKeyword: "AI search visibility"
  }),
  pricingTiers: getDefaultPricingTiers(),
  bookingUrl: "mailto:hello@launchclub.ai?subject=Buyer%20Visibility%20Sprint",
  nextSteps: ["Prioritize the top Reddit-fit keywords."],
  evidenceSummary: {
    crawlSummary: "Main page text was analyzed.",
    keywordSource: "Keyword metrics came from provider data.",
    redditSource: "Reddit links and summaries were stored.",
    aiSearchSource: "AI-search examples are simulated opportunity examples, not verified live citations.",
    generatedWithRealAiChecks: false
  }
};

describe("report schema, scoring, and AI opportunity labeling", () => {
  it("accepts a visitor-safe report payload", () => {
    expect(opportunityReportSchema.parse(validReport).publicId).toBe("report123");
  });

  it("requires exactly four AI-search prompt examples", () => {
    const invalidReport = {
      ...validReport,
      aiCitationOpportunities: validReport.aiCitationOpportunities.slice(0, 3)
    } as unknown;

    expect(() => opportunityReportSchema.parse(invalidReport)).toThrow();
  });

  it("scores low-hanging opportunities from keywords, Reddit, and source gaps", () => {
    const score = calculateOpportunityScore({
      keywordOpportunities: validReport.keywordOpportunities,
      redditOpportunities: validReport.redditOpportunities,
      competitorGaps: validReport.competitorGaps
    });

    expect(score).toBeGreaterThanOrEqual(34);
    expect(score).toBeLessThanOrEqual(98);
    expect(getKeywordPriority(800, "High")).toBe("High");
    expect(isAiOpportunitySimulationEnabled(false)).toBe(true);
  });
});
