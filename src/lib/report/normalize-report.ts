import {
  createMemeConcepts,
  createVisibilitySnapshot,
  getDefaultPricingTiers
} from "@/lib/report/commercial";
import {
  createEvidenceReference,
  createInferredEvidence,
  createMeasuredEvidence,
  createNotMeasuredEvidence,
  createUnavailableEvidence,
  evidenceReferenceId,
  hasReportableValue
} from "@/lib/report/evidence";
import { calculateOpportunityScore } from "@/lib/report/scoring";
import {
  evidenceMetadataSchema,
  opportunityReportSchema,
  type CompetitorGap,
  type EvidenceMetadata,
  type EvidenceReference,
  type KeywordOpportunity,
  type OpportunityReport,
  type RedditOpportunity,
  type ReportClaim
} from "@/lib/report/schema";

type ReportLike = OpportunityReport & Record<string, unknown>;

export function normalizeOpportunityReportForResponse({
  report,
  bookingUrl
}: {
  report: OpportunityReport;
  bookingUrl: string;
}) {
  const reportLike = report as ReportLike;
  const observationDate = normalizeObservationDate(reportLike.generatedAt);
  const isMockReport =
    reportLike.evidenceSummary.researchMode === "mock" ||
    /mock provider data/i.test(reportLike.evidenceSummary.keywordSource);
  const keywordOpportunities = normalizeKeywordOpportunities(
    reportLike.keywordOpportunities,
    observationDate,
    isMockReport
  );
  const redditOpportunities = normalizeRedditOpportunities(
    reportLike.redditOpportunities,
    observationDate,
    isMockReport
  );
  const competitorGaps = isMockReport
    ? []
    : normalizeCompetitorGaps(reportLike.competitorGaps, observationDate);
  const opportunityScore = calculateOpportunityScore({
    keywordOpportunities,
    redditOpportunities,
    competitorGaps
  });
  const scoreReferences = dedupeReferences([
    ...keywordOpportunities.flatMap(
      (keyword) => keyword.evidence.monthlySearchVolume.evidenceReferences
    ),
    ...redditOpportunities.flatMap(
      (opportunity) => opportunity.evidence.discussion.evidenceReferences
    ),
    ...competitorGaps.flatMap((competitor) => competitor.evidence.evidenceReferences)
  ]);
  const existingScoreEvidence = parseEvidence(reportLike.opportunityScoreEvidence);
  const opportunityScoreEvidence =
    isMockReport
      ? createNotMeasuredEvidence(
          "The development score uses mock inputs and is not public research evidence."
        )
      : existingScoreEvidence?.evidenceStatus === "Not measured"
        ? existingScoreEvidence
        : createInferredEvidence({
            provider: "Launch Club deterministic scoring",
            observationDate,
            references: scoreReferences,
            confidence: scoreReferences.length ? 0.7 : 0.4,
            explanation:
              "The score is derived from available keyword, Reddit, and competitor evidence. It is not a measured platform score."
          });
  const businessReference = createEvidenceReference({
    referenceId: evidenceReferenceId("website", reportLike.business.website || reportLike.domain),
    provider: "Firecrawl and OpenAI",
    sourceUrl: safeSourceUrl(reportLike.business.website, reportLike.domain),
    observationDate,
    description: "Website content used to infer the business profile."
  });
  const existingBusinessEvidence = parseEvidence(reportLike.businessEvidence);
  const businessEvidence =
    isMockReport
      ? createNotMeasuredEvidence(
          "The development business profile uses mock inputs and is not public research evidence."
        )
      : existingBusinessEvidence?.evidenceStatus === "Not measured"
        ? existingBusinessEvidence
        : createInferredEvidence({
            provider: "OpenAI analysis of website content",
            observationDate,
            references: existingBusinessEvidence?.evidenceReferences.length
              ? existingBusinessEvidence.evidenceReferences
              : [businessReference],
            confidence: existingBusinessEvidence?.confidence ?? 0.7,
            explanation:
              "The business profile is an AI interpretation of the crawled website content."
          });
  const headline =
    businessEvidence.evidenceStatus === "Not measured"
      ? "Development preview: research values are simulated and not measured."
      : reportLike.headline;
  const keywordTraffic = keywordOpportunities.reduce(
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
  const aiCitationOpportunities = reportLike.aiCitationOpportunities.map((opportunity) => ({
    ...opportunity,
    isSimulation: true as const,
    evidence: createNotMeasuredEvidence(
      "This is a planning simulation. Live ChatGPT, Gemini, and Perplexity visibility was not checked."
    )
  }));
  const claims = buildClaims({
    report: reportLike,
    opportunityScore,
    opportunityScoreEvidence,
    businessEvidence,
    keywordOpportunities,
    redditOpportunities,
    observationDate
  });

  return opportunityReportSchema.parse({
    ...reportLike,
    headline,
    opportunityScore,
    opportunityScoreEvidence,
    businessEvidence,
    visibilitySnapshot: createVisibilitySnapshot({
      opportunityScore,
      redditOpportunities,
      keywordTraffic
    }),
    keywordOpportunities,
    redditOpportunities,
    competitorGaps,
    aiCitationOpportunities,
    memeConcepts,
    pricingTiers: getDefaultPricingTiers(),
    bookingUrl,
    evidenceSummary: {
      ...reportLike.evidenceSummary,
      researchMode: isMockReport ? "mock" : "live",
      generatedWithRealAiChecks: false,
      redditSource:
        "Reddit discussions come from public research. Verified traffic or view data was not available from the current provider.",
      aiSearchSource:
        "AI-search examples are planning simulations. Live ChatGPT, Gemini, and Perplexity visibility was not measured."
    },
    claims
  });
}

function normalizeKeywordOpportunities(
  keywords: KeywordOpportunity[],
  observationDate: string,
  isMockReport: boolean
) {
  return keywords.map((keyword) => {
    if (isMockReport) {
      const notMeasured = createNotMeasuredEvidence(
        "This development value comes from mock data and is not public research evidence."
      );

      return {
        ...keyword,
        monthlySearchVolume: null,
        difficulty: null,
        trafficPotential: null,
        evidence: {
          monthlySearchVolume: notMeasured,
          difficulty: notMeasured,
          trafficPotential: notMeasured,
          intent: notMeasured,
          analysis: notMeasured
        }
      };
    }

    const volume = normalizeNumericMetric({
      value: keyword.monthlySearchVolume,
      evidence: keyword.evidence?.monthlySearchVolume,
      provider: "Ahrefs",
      observationDate,
      label: "monthly search volume"
    });
    const difficulty = normalizeNumericMetric({
      value: keyword.difficulty,
      evidence: keyword.evidence?.difficulty,
      provider: "Ahrefs",
      observationDate,
      label: "keyword difficulty"
    });
    const trafficPotential = normalizeNumericMetric({
      value: keyword.trafficPotential,
      evidence: keyword.evidence?.trafficPotential,
      provider: "Ahrefs",
      observationDate,
      label: "traffic potential"
    });
    const metricReferences = dedupeReferences([
      ...volume.evidence.evidenceReferences,
      ...difficulty.evidence.evidenceReferences,
      ...trafficPotential.evidence.evidenceReferences
    ]);
    const intent = normalizeInference(
      keyword.evidence?.intent,
      "OpenAI keyword analysis",
      observationDate,
      metricReferences,
      "Search intent is inferred from the keyword and available provider data."
    );
    const analysis = normalizeInference(
      keyword.evidence?.analysis,
      "OpenAI research synthesis",
      observationDate,
      metricReferences,
      "Priority, Reddit fit, visibility observations, and recommended actions are inferred from the research."
    );

    return {
      ...keyword,
      monthlySearchVolume: volume.value,
      difficulty: difficulty.value,
      trafficPotential: trafficPotential.value,
      evidence: {
        monthlySearchVolume: volume.evidence,
        difficulty: difficulty.evidence,
        trafficPotential: trafficPotential.evidence,
        intent,
        analysis
      }
    };
  });
}

function normalizeRedditOpportunities(
  redditOpportunities: RedditOpportunity[],
  observationDate: string,
  isMockReport: boolean
) {
  return redditOpportunities.map((opportunity) => {
    const sourceReference = createEvidenceReference({
      referenceId: evidenceReferenceId("reddit-thread", opportunity.url),
      provider: "Firecrawl",
      sourceUrl: opportunity.url,
      observationDate,
      description: `Public Reddit result for ${opportunity.title}.`
    });
    const existingDiscussion = parseEvidence(opportunity.evidence?.discussion);
    const discussion = isMockReport
      ? createNotMeasuredEvidence(
          "This development discussion comes from mock data and is not public research evidence."
        )
      : existingDiscussion ??
        createMeasuredEvidence({
            provider: "Firecrawl",
            observationDate,
            references: [sourceReference],
            explanation: "The stored public Reddit URL supports that this discussion was found."
          });
    const upvotes = isMockReport
      ? {
          value: null,
          evidence: createNotMeasuredEvidence("Mock Reddit engagement was not measured.")
        }
      : normalizeNumericMetric({
          value: opportunity.upvoteCount,
          evidence: opportunity.evidence?.upvotes,
          provider: "Firecrawl",
          observationDate,
          label: "Reddit upvote count"
        });
    const comments = isMockReport
      ? {
          value: null,
          evidence: createNotMeasuredEvidence("Mock Reddit engagement was not measured.")
        }
      : normalizeNumericMetric({
          value: opportunity.commentCount,
          evidence: opportunity.evidence?.comments,
          provider: "Firecrawl",
          observationDate,
          label: "Reddit comment count"
        });
    const analysis = isMockReport
      ? createNotMeasuredEvidence("Mock Reddit analysis is not public research evidence.")
      : normalizeInference(
          opportunity.evidence?.analysis,
          "OpenAI analysis of Firecrawl evidence",
          observationDate,
          discussion.evidenceReferences,
          "The opportunity and suggested comment are inferred from the public discussion summary."
        );

    return {
      ...opportunity,
      estimatedMonthlyViews: null,
      upvoteCount: upvotes.value,
      commentCount: comments.value,
      engagementSummary:
        upvotes.value !== null || comments.value !== null
          ? "Verified public engagement counts are shown where the provider returned them. Monthly traffic was not measured."
          : "The provider did not return verified engagement or monthly traffic metrics for this discussion.",
      evidence: {
        discussion,
        monthlyViews: createNotMeasuredEvidence(
          "No provider returned verified monthly Reddit traffic or view data for this discussion."
        ),
        upvotes: upvotes.evidence,
        comments: comments.evidence,
        analysis
      }
    };
  });
}

function normalizeCompetitorGaps(competitors: CompetitorGap[], observationDate: string) {
  return competitors.map((competitor) => {
    const existingEvidence = parseEvidence(competitor.evidence);
    const reference = competitor.url
      ? createEvidenceReference({
          referenceId: evidenceReferenceId("competitor", competitor.url),
          provider: competitor.source || "Public search research",
          sourceUrl: competitor.url,
          observationDate,
          description: `Public source used for the comparison with ${competitor.competitor}.`
        })
      : null;

    return {
      ...competitor,
      evidence: createInferredEvidence({
        provider: "OpenAI competitor analysis",
        observationDate,
        references: existingEvidence?.evidenceReferences.length
          ? existingEvidence.evidenceReferences
          : reference
            ? [reference]
            : [],
        confidence: existingEvidence?.confidence ?? 0.65,
        explanation:
          "The competitor gap is inferred from available search evidence; no Reddit mention total was calculated."
      })
    };
  });
}

function normalizeNumericMetric({
  value,
  evidence,
  provider,
  observationDate,
  label
}: {
  value: number | null;
  evidence: unknown;
  provider: string;
  observationDate: string;
  label: string;
}) {
  const parsedEvidence = parseEvidence(evidence);

  if (value !== null && parsedEvidence && hasReportableValue(parsedEvidence)) {
    return { value, evidence: parsedEvidence };
  }

  if (value === null && parsedEvidence?.evidenceStatus === "Not measured") {
    return { value: null, evidence: parsedEvidence };
  }

  return {
    value: null,
    evidence: createUnavailableEvidence({
      provider,
      observationDate,
      explanation: `${provider} did not return sufficient verified ${label} data.`
    })
  };
}

function normalizeInference(
  evidence: unknown,
  provider: string,
  observationDate: string,
  fallbackReferences: EvidenceReference[],
  explanation: string
) {
  const parsedEvidence = parseEvidence(evidence);

  return createInferredEvidence({
    provider,
    observationDate,
    references: parsedEvidence?.evidenceReferences.length
      ? parsedEvidence.evidenceReferences
      : fallbackReferences,
    confidence: parsedEvidence?.confidence ?? 0.65,
    explanation
  });
}

function buildClaims({
  report,
  opportunityScore,
  opportunityScoreEvidence,
  businessEvidence,
  keywordOpportunities,
  redditOpportunities,
  observationDate
}: {
  report: ReportLike;
  opportunityScore: number;
  opportunityScoreEvidence: EvidenceMetadata;
  businessEvidence: EvidenceMetadata;
  keywordOpportunities: KeywordOpportunity[];
  redditOpportunities: RedditOpportunity[];
  observationDate: string;
}): ReportClaim[] {
  const keywordReferences = dedupeReferences(
    keywordOpportunities.flatMap((keyword) =>
      keyword.evidence.monthlySearchVolume.evidenceStatus === "Measured"
        ? keyword.evidence.monthlySearchVolume.evidenceReferences
        : []
    )
  );
  const redditReferences = dedupeReferences(
    redditOpportunities.flatMap((opportunity) =>
      opportunity.evidence.discussion.evidenceStatus === "Measured"
        ? opportunity.evidence.discussion.evidenceReferences
        : []
    )
  );
  const keywordNotMeasured = keywordOpportunities.every(
    (keyword) => keyword.evidence.monthlySearchVolume.evidenceStatus === "Not measured"
  );
  const redditNotMeasured =
    redditOpportunities.length > 0 &&
    redditOpportunities.every(
      (opportunity) => opportunity.evidence.discussion.evidenceStatus === "Not measured"
    );
  const keywordEvidence = keywordReferences.length
    ? createMeasuredEvidence({
        provider: "Ahrefs",
        observationDate,
        references: keywordReferences,
        explanation: "Only keyword volumes with stored Ahrefs evidence are included."
      })
    : keywordNotMeasured
      ? createNotMeasuredEvidence("Keyword metrics in this development report are mock data.")
    : createUnavailableEvidence({
        provider: "Ahrefs",
        observationDate,
        explanation: "Verified monthly keyword search volume was unavailable."
      });
  const redditEvidence = redditReferences.length
    ? createMeasuredEvidence({
        provider: "Firecrawl",
        observationDate,
        references: redditReferences,
        explanation: "The linked public Reddit discussions were returned by the research provider."
      })
    : redditNotMeasured
      ? createNotMeasuredEvidence("Reddit discussions in this development report are mock data.")
    : createUnavailableEvidence({
        provider: "Firecrawl",
        observationDate,
        explanation: "Relevant public Reddit discussion evidence was unavailable."
      });

  return [
    claim(
      "business-profile",
      businessEvidence.evidenceStatus === "Not measured"
        ? "The development business profile is simulated and not measured."
        : `${report.business.companyName} was categorized as ${report.business.category}.`,
      businessEvidence
    ),
    claim(
      "report-headline",
      businessEvidence.evidenceStatus === "Not measured"
        ? "The development report headline is simulated and not measured."
        : report.headline,
      businessEvidence
    ),
    claim(
      "opportunity-score",
      opportunityScoreEvidence.evidenceStatus === "Not measured"
        ? "The development opportunity score is simulated and not measured."
        : `The report's inferred opportunity score is ${opportunityScore} out of 100.`,
      opportunityScoreEvidence
    ),
    claim(
      "keyword-volume-availability",
      keywordReferences.length
        ? `Verified monthly search volume is available for ${keywordReferences.length} keyword${keywordReferences.length === 1 ? "" : "s"}.`
        : keywordNotMeasured
          ? "Keyword metrics were not measured in this development report."
          : "Verified monthly keyword search volume was unavailable.",
      keywordEvidence
    ),
    claim(
      "reddit-discussion-discovery",
      redditReferences.length
        ? `${redditReferences.length} relevant public Reddit discussion${redditReferences.length === 1 ? " was" : "s were"} found.`
        : redditNotMeasured
          ? "Reddit discussion research was not measured in this development report."
          : "Relevant public Reddit discussion evidence was unavailable.",
      redditEvidence
    ),
    claim(
      "ai-platform-visibility",
      "Live visibility in ChatGPT, Gemini, and Perplexity was not measured.",
      createNotMeasuredEvidence(
        "The current workflow creates planning simulations but does not run a supported live AI visibility provider."
      )
    )
  ];
}

function claim(claimId: string, claimText: string, evidence: EvidenceMetadata): ReportClaim {
  return { claimId, claimText, ...evidence };
}

function parseEvidence(value: unknown) {
  const result = evidenceMetadataSchema.safeParse(value);
  return result.success ? result.data : null;
}

function dedupeReferences(references: EvidenceReference[]) {
  return [...new Map(references.map((reference) => [reference.referenceId, reference])).values()];
}

function normalizeObservationDate(value: string) {
  return Number.isNaN(Date.parse(value)) ? new Date(0).toISOString() : new Date(value).toISOString();
}

function safeSourceUrl(value: string, domain: string) {
  try {
    return new URL(value).toString();
  } catch {
    return `https://${domain}`;
  }
}
