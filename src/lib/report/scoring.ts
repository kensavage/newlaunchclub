import type {
  CompetitorGap,
  KeywordOpportunity,
  RedditOpportunity
} from "@/lib/report/schema";

export function calculateOpportunityScore({
  keywordOpportunities,
  redditOpportunities,
  competitorGaps
}: {
  keywordOpportunities: KeywordOpportunity[];
  redditOpportunities: RedditOpportunity[];
  competitorGaps: CompetitorGap[];
}) {
  const highPriorityKeywords = keywordOpportunities.filter((keyword) => keyword.priority === "High").length;
  const totalVolume = keywordOpportunities.reduce(
    (sum, keyword) => sum + (keyword.monthlySearchVolume ?? 0),
    0
  );
  const highRedditFit = redditOpportunities.filter(
    (opportunity) => opportunity.riskLevel !== "High"
  ).length;
  const competitorPressure = Math.min(competitorGaps.length * 7, 21);
  const volumeScore = Math.min(Math.round(totalVolume / 400), 24);
  const keywordScore = Math.min(highPriorityKeywords * 8, 24);
  const redditScore = Math.min(highRedditFit * 9, 27);

  return Math.max(34, Math.min(98, 26 + volumeScore + keywordScore + redditScore + competitorPressure));
}

export function getKeywordPriority(volume: number | null, redditFit: "High" | "Medium" | "Low") {
  if ((volume ?? 0) >= 500 && redditFit !== "Low") {
    return "High" as const;
  }

  if ((volume ?? 0) >= 100 || redditFit === "High") {
    return "Medium" as const;
  }

  return "Low" as const;
}

export function isAiOpportunitySimulationEnabled(enableRealAiChecks: boolean) {
  void enableRealAiChecks;
  return true;
}
