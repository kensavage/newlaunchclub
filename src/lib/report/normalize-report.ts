import {
  createMemeConcepts,
  createVisibilitySnapshot,
  getDefaultPricingTiers
} from "@/lib/report/commercial";
import { calculateOpportunityScore } from "@/lib/report/scoring";
import {
  opportunityReportSchema,
  type OpportunityReport,
  type RedditOpportunity
} from "@/lib/report/schema";

type ReportLike = OpportunityReport & Record<string, unknown>;

export function normalizeOpportunityReportForResponse({
  report,
  bookingUrl,
  enableRealAiChecks
}: {
  report: OpportunityReport;
  bookingUrl: string;
  enableRealAiChecks: boolean;
}) {
  const reportLike = report as ReportLike;
  const redditOpportunities = normalizeRedditOpportunities(reportLike.redditOpportunities);
  const opportunityScore = calculateOpportunityScore({
    keywordOpportunities: reportLike.keywordOpportunities,
    redditOpportunities,
    competitorGaps: reportLike.competitorGaps
  });
  const keywordTraffic = reportLike.keywordOpportunities.reduce(
    (sum, keyword) => sum + (keyword.trafficPotential ?? keyword.monthlySearchVolume ?? 0),
    0
  );
  const memeConcepts =
    Array.isArray(reportLike.memeConcepts) && reportLike.memeConcepts.length > 0
      ? reportLike.memeConcepts.map((concept) => ({
          ...concept,
          provider: concept.provider || "memes.ai",
          imageUrl: concept.imageUrl ?? null
        }))
      : createMemeConcepts({
          companyName: reportLike.business.companyName,
          category: reportLike.business.category,
          primaryKeyword: reportLike.business.primaryKeyword
        });

  return opportunityReportSchema.parse({
    ...reportLike,
    opportunityScore,
    visibilitySnapshot: createVisibilitySnapshot({
      opportunityScore,
      redditOpportunities,
      keywordTraffic
    }),
    redditOpportunities,
    aiCitationOpportunities: reportLike.aiCitationOpportunities.map((opportunity) => ({
      ...opportunity,
      isSimulation: enableRealAiChecks ? opportunity.isSimulation : true
    })),
    memeConcepts,
    pricingTiers: getDefaultPricingTiers(),
    bookingUrl,
    evidenceSummary: {
      ...reportLike.evidenceSummary,
      generatedWithRealAiChecks: enableRealAiChecks,
      aiSearchSource: enableRealAiChecks
        ? reportLike.evidenceSummary.aiSearchSource
        : "AI-search examples are simulated opportunity examples, not verified live citations."
    }
  });
}

function normalizeRedditOpportunities(redditOpportunities: RedditOpportunity[]) {
  return redditOpportunities.map((opportunity) => {
    const estimatedMonthlyViews =
      opportunity.estimatedMonthlyViews ??
      Math.max(500, estimateViewsFromText(opportunity.discussionSummary));

    return {
      ...opportunity,
      estimatedMonthlyViews,
      upvoteCount: opportunity.upvoteCount ?? 0,
      commentCount: opportunity.commentCount ?? 0,
      engagementSummary:
        opportunity.engagementSummary ??
        "Estimated reach is a directional proxy based on available Reddit engagement signals, not official Reddit traffic."
    };
  });
}

function estimateViewsFromText(value: string) {
  return Math.max(500, Math.min(12_000, value.length * 18));
}
