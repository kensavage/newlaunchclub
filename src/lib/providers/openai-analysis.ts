import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import {
  businessProfileSchema,
  aiCitationOpportunitySchema,
  keywordOpportunitySchema,
  opportunityReportSchema,
  redditOpportunitySchema,
  type AiCitationOpportunity,
  type CompetitorGap,
  type EvidenceMetadata,
  type KeywordOpportunity,
  type OpportunityReport,
  type ReportClaim,
  type RedditOpportunity
} from "@/lib/report/schema";
import {
  createMemeConcepts,
  createVisibilitySnapshot,
  getDefaultPricingTiers
} from "@/lib/report/commercial";
import { calculateOpportunityScore, getKeywordPriority } from "@/lib/report/scoring";
import {
  createEvidenceReference,
  createInferredEvidence,
  createMeasuredEvidence,
  createNotMeasuredEvidence,
  createUnavailableEvidence,
  evidenceReferenceId
} from "@/lib/report/evidence";
import type { BusinessAnalysis, CrawlResult, ReportSynthesisInput } from "@/lib/providers/types";

const businessAnalysisSchema = z.object({
  business: businessProfileSchema,
  keywords: z.array(z.string()).min(20).max(20),
  primaryKeyword: z.string(),
  buyerQueries: z.array(z.string()).min(10).max(10),
  redditQueries: z.array(z.string()).min(3).max(5),
  competitors: z.array(z.string()).min(3).max(6),
  summary: z.string()
});

const searchSynthesisSectionsSchema = z.object({
  keywordOpportunities: z
    .array(
      z.object({
        keywordIndex: z.number().int().min(0).max(15),
        intent: z.string(),
        sourceVisibility: z.string(),
        redditFit: keywordOpportunitySchema.shape.redditFit,
        recommendedAction: z.string()
      })
    )
    .min(8)
    .max(12),
  competitorGaps: z
    .array(
      z.object({
        sourceIndex: z.number().int().min(0).max(7),
        gap: z.string(),
        recommendedAction: z.string()
      })
    )
    .max(5)
});

const redditSynthesisSectionsSchema = z.object({
  redditOpportunities: z
    .array(
      z.object({
        evidenceIndex: z.number().int().min(0).max(4),
        whyLowHangingFruit: z.string(),
        suggestedPostTitle: z.string(),
        suggestedPostBody: z.string(),
        riskLevel: redditOpportunitySchema.shape.riskLevel
      })
    )
    .max(5)
});

const narrativeSynthesisSectionsSchema = z.object({
  headline: z.string(),
  aiCitationOpportunities: z
    .array(
      aiCitationOpportunitySchema.omit({ isSimulation: true })
    )
    .length(4),
  nextSteps: z.array(z.string()).min(1).max(6)
});

type SearchSynthesisSections = z.infer<typeof searchSynthesisSectionsSchema>;
type RedditSynthesisSections = z.infer<typeof redditSynthesisSectionsSchema>;
type NarrativeSynthesisSections = z.infer<typeof narrativeSynthesisSectionsSchema>;

interface CompetitorSource {
  name: string;
  domain: string;
  url: string | null;
  traffic: number | null;
  provider: "Ahrefs" | "Firecrawl";
}

export class OpenAIAnalysisProvider {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly fastModel: string,
    private readonly synthesisModel: string
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async analyzeBusiness({
    crawl,
    url,
    domain
  }: {
    crawl: CrawlResult;
    url: string;
    domain: string;
  }): Promise<BusinessAnalysis> {
    const response = await this.client.responses.parse({
      model: this.fastModel,
      input: [
        {
          role: "system",
          content:
            "Extract a concise business and buyer-research profile for a Launch Club AI Search Opportunity Report. Return only facts supported by the page text when possible."
        },
        {
          role: "user",
          content: [
            `URL: ${url}`,
            `Domain: ${domain}`,
            `Title: ${crawl.title}`,
            `Description: ${crawl.description ?? ""}`,
            `Pages crawled: ${crawl.pages.map((page) => page.url).join(", ")}`,
            "Combined site text from homepage and linked internal pages:",
            crawl.text.slice(0, 24000)
          ].join("\n")
        }
      ],
      text: {
        format: zodTextFormat(businessAnalysisSchema, "business_analysis")
      }
    });

    if (!response.output_parsed) {
      throw new Error("OpenAI did not return a valid business analysis.");
    }

    return response.output_parsed;
  }

  async synthesizeReport(input: ReportSynthesisInput): Promise<OpportunityReport> {
    const generatedAt = new Date().toISOString();
    const keywordMetrics = input.keywordMetrics.slice(0, 16);
    const competitorSources = buildCompetitorSources(input);
    const redditEvidence = input.reddit.slice(0, 5);
    const [searchSections, redditSections, narrativeSections] = await Promise.all([
      this.synthesizeSearchSections(input, keywordMetrics, competitorSources),
      this.synthesizeRedditSections(input, redditEvidence),
      this.synthesizeNarrativeSections(input, competitorSources, redditEvidence)
    ]);
    const keywordOpportunities = mergeKeywordOpportunities(
      keywordMetrics,
      searchSections.keywordOpportunities,
      generatedAt
    );
    const competitorGaps = mergeCompetitorGaps(
      competitorSources,
      searchSections.competitorGaps,
      generatedAt
    );
    const redditOpportunities = mergeRedditOpportunities(
      redditEvidence,
      redditSections.redditOpportunities,
      generatedAt
    );
    const aiCitationOpportunities = mergeAiCitationOpportunities(
      narrativeSections.aiCitationOpportunities
    );
    const opportunityScore = calculateOpportunityScore({
      keywordOpportunities,
      redditOpportunities,
      competitorGaps
    });
    const keywordTraffic = keywordOpportunities.reduce(
      (sum, keyword) => sum + (keyword.trafficPotential ?? keyword.monthlySearchVolume ?? 0),
      0
    );
    const crawlReferences = input.crawl.pages.map((page, index) =>
      createEvidenceReference({
        referenceId: `firecrawl-page:${index + 1}`,
        provider: "Firecrawl",
        sourceUrl: page.url,
        observationDate: generatedAt,
        description: `Crawled page used to analyze ${input.domain}.`
      })
    );
    const businessEvidence = createInferredEvidence({
      provider: "OpenAI analysis of Firecrawl content",
      observationDate: generatedAt,
      references: crawlReferences,
      confidence: 0.75,
      explanation:
        "The business profile is an AI interpretation of the website pages listed in the report evidence."
    });
    const scoreReferences = [
      ...keywordOpportunities.flatMap(
        (keyword) => keyword.evidence.monthlySearchVolume.evidenceReferences
      ),
      ...redditOpportunities.flatMap(
        (opportunity) => opportunity.evidence.discussion.evidenceReferences
      ),
      ...competitorGaps.flatMap((competitor) => competitor.evidence.evidenceReferences)
    ];
    const opportunityScoreEvidence = createInferredEvidence({
      provider: "Launch Club deterministic scoring",
      observationDate: generatedAt,
      references: scoreReferences,
      confidence: scoreReferences.length ? 0.7 : 0.4,
      explanation:
        "The score is a deterministic prioritization derived from available keyword, Reddit, and competitor evidence; it is not a measured platform score."
    });
    const claims = buildReportClaims({
      input,
      generatedAt,
      headline: narrativeSections.headline,
      businessEvidence,
      opportunityScore,
      opportunityScoreEvidence,
      keywordOpportunities,
      redditOpportunities
    });

    return opportunityReportSchema.parse({
      publicId: input.publicId,
      generatedAt,
      submittedUrl: input.submittedUrl,
      domain: input.domain,
      opportunityScore,
      opportunityScoreEvidence,
      headline: narrativeSections.headline,
      business: input.analysis.business,
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
      memeConcepts: createMemeConcepts({
        companyName: input.analysis.business.companyName,
        category: input.analysis.business.category,
        primaryKeyword: input.analysis.primaryKeyword
      }),
      pricingTiers: getDefaultPricingTiers(),
      bookingUrl: "mailto:hello@launchclub.ai?subject=Buyer%20Visibility%20Sprint",
      nextSteps: narrativeSections.nextSteps,
      evidenceSummary: {
        researchMode: "live",
        crawlSummary: `Analyzed homepage and linked internal pages from ${input.normalizedUrl}.`,
        keywordSource:
          "Keyword volume, difficulty, traffic potential, domain traffic, top pages, and organic competitors come from Ahrefs; search-result evidence comes from Firecrawl.",
        redditSource:
          "Reddit opportunities come from Firecrawl public search results and stored summaries. Firecrawl did not provide official Reddit traffic analytics.",
        aiSearchSource:
          "AI-search examples are simulations for planning only. Live ChatGPT, Gemini, and Perplexity visibility was not measured.",
        generatedWithRealAiChecks: false
      },
      claims
    });
  }

  private async synthesizeSearchSections(
    input: ReportSynthesisInput,
    keywordMetrics: ReportSynthesisInput["keywordMetrics"],
    competitorSources: CompetitorSource[]
  ): Promise<SearchSynthesisSections> {
    const response = await this.client.responses.parse({
      model: this.synthesisModel,
      reasoning: { effort: "none" },
      max_output_tokens: 5_000,
      input: [
        {
          role: "system",
          content:
            "Create evidence-based keyword and competitor opportunity copy for a Launch Club report. Use only the provided indexed records, use every index at most once, stay specific, and never invent or repeat metrics, URLs, or source names. Avoid guarantees."
        },
        {
          role: "user",
          content: JSON.stringify({
            domain: input.domain,
            business: input.analysis.business,
            keywords: keywordMetrics.map((metric, keywordIndex) => ({
              keywordIndex,
              ...metric
            })),
            searchResults: input.searchResults.slice(0, 12),
            ahrefs: {
              domainTraffic: input.ahrefs.domainTraffic,
              topPages: input.ahrefs.topPages.slice(0, 5)
            },
            competitorSources: competitorSources.map((source, sourceIndex) => ({
              sourceIndex,
              ...source
            })),
            requirements: {
              keywordOpportunities:
                "Choose 8 to 12 unique keywordIndex values. Write one concise, evidence-grounded visibility observation and one concrete action for each.",
              competitorGaps:
                "Use up to 5 unique sourceIndex values from competitorSources. Do not introduce a company that is not listed.",
              claims: "No guaranteed rankings, citations, traffic, or revenue."
            }
          })
        }
      ],
      text: {
        format: zodTextFormat(searchSynthesisSectionsSchema, "search_opportunity_sections")
      }
    });

    if (!response.output_parsed) {
      throw new Error("OpenAI did not return valid keyword opportunity sections.");
    }

    return response.output_parsed;
  }

  private async synthesizeRedditSections(
    input: ReportSynthesisInput,
    redditEvidence: ReportSynthesisInput["reddit"]
  ): Promise<RedditSynthesisSections> {
    if (!redditEvidence.length) {
      return { redditOpportunities: [] };
    }

    const response = await this.client.responses.parse({
      model: this.synthesisModel,
      reasoning: { effort: "none" },
      max_output_tokens: 5_000,
      input: [
        {
          role: "system",
          content:
            "Turn provided Reddit evidence into helpful, non-promotional opportunities for a Launch Club report. Use only the indexed threads, use each index at most once, and do not invent engagement numbers or links. Avoid guarantees."
        },
        {
          role: "user",
          content: JSON.stringify({
            business: input.analysis.business,
            redditEvidence: redditEvidence.map((evidence, evidenceIndex) => ({
              evidenceIndex,
              ...evidence
            })),
            requirements: {
              selection: "Return one opportunity for each useful evidence item, up to 5.",
              comment:
                "suggestedPostBody must be a natural 115-145 word comment so the final text remains within 100-150 words. It must directly address the thread, add useful information and a genuine opinion, invite replies, and never sound promotional.",
              title: "suggestedPostTitle should be a concise internal label for the comment angle.",
              risk: "Use Low, Medium, or High based on how naturally the business fits the discussion."
            }
          })
        }
      ],
      text: {
        format: zodTextFormat(redditSynthesisSectionsSchema, "reddit_opportunity_sections")
      }
    });

    if (!response.output_parsed) {
      throw new Error("OpenAI did not return valid Reddit opportunity sections.");
    }

    return response.output_parsed;
  }

  private async synthesizeNarrativeSections(
    input: ReportSynthesisInput,
    competitorSources: CompetitorSource[],
    redditEvidence: ReportSynthesisInput["reddit"]
  ): Promise<NarrativeSynthesisSections> {
    const response = await this.client.responses.parse({
      model: this.synthesisModel,
      reasoning: { effort: "none" },
      max_output_tokens: 4_000,
      input: [
        {
          role: "system",
          content:
            "Create the concise headline, next actions, and four AI-search opportunity simulations for a Launch Club report. Be specific to the business, mention credible alternatives only when provided, and never promise rankings, citations, traffic, or revenue."
        },
        {
          role: "user",
          content: JSON.stringify({
            domain: input.domain,
            business: input.analysis.business,
            primaryKeyword: input.analysis.primaryKeyword,
            analyzedCompetitors: input.analysis.competitors,
            evidenceBackedCompetitors: competitorSources.slice(0, 5).map((source) => source.name),
            topKeywords: input.keywordMetrics.slice(0, 8),
            redditDiscussions: redditEvidence.slice(0, 5).map((evidence) => ({
              title: evidence.title,
              subreddit: evidence.subreddit,
              summary: evidence.summary
            })),
            enableRealAiChecks: false,
            requirements: {
              aiCitationOpportunities:
                "Return exactly 4 realistic buyer questions, simulated answers that naturally reference the company alongside relevant options, and a concrete citation angle.",
              labeling:
                "Do not return an isSimulation field; the application labels simulation status deterministically.",
              nextSteps: "Return 3 to 5 prioritized, concrete actions."
            }
          })
        }
      ],
      text: {
        format: zodTextFormat(narrativeSynthesisSectionsSchema, "ai_search_narrative_sections")
      }
    });

    if (!response.output_parsed) {
      throw new Error("OpenAI did not return valid AI-search narrative sections.");
    }

    return response.output_parsed;
  }
}

function buildCompetitorSources(input: ReportSynthesisInput): CompetitorSource[] {
  const sources: CompetitorSource[] = [];
  const seen = new Set<string>();
  const inputDomain = normalizeDomain(input.domain);

  function add(source: CompetitorSource) {
    const domain = normalizeDomain(source.domain);
    if (!domain || domain === inputDomain || seen.has(domain)) return;
    seen.add(domain);
    sources.push({ ...source, domain });
  }

  for (const competitor of input.ahrefs.organicCompetitors) {
    add({
      name: competitor.name,
      domain: competitor.domain,
      url: `https://${competitor.domain}`,
      traffic: competitor.traffic,
      provider: "Ahrefs"
    });
  }

  for (const result of input.searchResults) {
    if (result.isReddit) continue;
    add({
      name: normalizeDomain(result.domain),
      domain: result.domain,
      url: result.url || null,
      traffic: null,
      provider: "Firecrawl"
    });
  }

  return sources.slice(0, 8);
}

function mergeKeywordOpportunities(
  metrics: ReportSynthesisInput["keywordMetrics"],
  sections: SearchSynthesisSections["keywordOpportunities"],
  observationDate: string
): KeywordOpportunity[] {
  const opportunities: KeywordOpportunity[] = [];
  const seen = new Set<number>();

  for (const section of sections) {
    const metric = metrics[section.keywordIndex];
    if (!metric || seen.has(section.keywordIndex)) continue;
    seen.add(section.keywordIndex);
    opportunities.push({
      keyword: metric.keyword,
      intent: section.intent || metric.intent || "Discovery",
      monthlySearchVolume: metric.monthlySearchVolume,
      difficulty: metric.difficulty,
      trafficPotential: metric.trafficPotential,
      sourceVisibility: section.sourceVisibility,
      redditFit: section.redditFit,
      priority: getKeywordPriority(metric.monthlySearchVolume, section.redditFit),
      recommendedAction: section.recommendedAction,
      evidence: createKeywordEvidence(metric, observationDate)
    });
  }

  const minimumCount = Math.min(8, metrics.length);
  for (let index = 0; opportunities.length < minimumCount && index < metrics.length; index += 1) {
    const metric = metrics[index];
    if (!metric || seen.has(index)) continue;
    opportunities.push({
      keyword: metric.keyword,
      intent: metric.intent ?? "Discovery",
      monthlySearchVolume: metric.monthlySearchVolume,
      difficulty: metric.difficulty,
      trafficPotential: metric.trafficPotential,
      sourceVisibility:
        "The current search results leave room for a clearer first-party answer and trusted third-party discussion.",
      redditFit: "Medium",
      priority: getKeywordPriority(metric.monthlySearchVolume, "Medium"),
      recommendedAction:
        "Publish a focused answer page and support it with a useful, context-specific Reddit contribution.",
      evidence: createKeywordEvidence(metric, observationDate)
    });
  }

  return opportunities.slice(0, 12);
}

function mergeCompetitorGaps(
  sources: CompetitorSource[],
  sections: SearchSynthesisSections["competitorGaps"],
  observationDate: string
): CompetitorGap[] {
  const seen = new Set<number>();

  return sections.flatMap((section) => {
    const source = sources[section.sourceIndex];
    if (!source || seen.has(section.sourceIndex)) return [];
    seen.add(section.sourceIndex);
    const reference = createEvidenceReference({
      referenceId: evidenceReferenceId("competitor", source.domain),
      provider: source.provider,
      sourceUrl: source.url,
      observationDate,
      description: `Search evidence used for the competitor comparison with ${source.name}.`
    });

    return [
      {
        competitor: source.name,
        source: source.domain,
        url: source.url,
        gap: section.gap,
        recommendedAction: section.recommendedAction,
        evidence: createInferredEvidence({
          provider: `OpenAI analysis of ${source.provider} evidence`,
          observationDate,
          references: [reference],
          confidence: 0.7,
          explanation:
            "The competitor gap is an analysis of the linked search evidence, not a measured mention total."
        })
      }
    ];
  });
}

function mergeRedditOpportunities(
  evidence: ReportSynthesisInput["reddit"],
  sections: RedditSynthesisSections["redditOpportunities"],
  observationDate: string
): RedditOpportunity[] {
  const seen = new Set<number>();

  return sections.flatMap((section) => {
    const source = evidence[section.evidenceIndex];
    if (!source || seen.has(section.evidenceIndex)) return [];
    seen.add(section.evidenceIndex);
    const reference = createEvidenceReference({
      referenceId: evidenceReferenceId("reddit-thread", source.url),
      provider: "Firecrawl",
      sourceUrl: source.url,
      observationDate,
      description: `Public Reddit result for ${source.title}.`
    });
    const upvoteCount = source.score;
    const commentCount = source.comments;
    const hasEngagement = source.score !== null || source.comments !== null;

    return [
      {
        title: source.title,
        subreddit: source.subreddit,
        url: source.url,
        estimatedMonthlyViews: null,
        upvoteCount,
        commentCount,
        engagementSummary: hasEngagement
          ? "The provider returned public engagement counts for this discussion. It did not return verified traffic or view data."
          : "Firecrawl found this public discussion but did not return verified upvote, comment, traffic, or view metrics.",
        discussionSummary: source.summary,
        whyLowHangingFruit: section.whyLowHangingFruit,
        suggestedPostTitle: section.suggestedPostTitle,
        suggestedPostBody: section.suggestedPostBody,
        riskLevel: section.riskLevel,
        evidence: {
          discussion: createMeasuredEvidence({
            provider: "Firecrawl",
            observationDate,
            references: [reference],
            explanation: "Firecrawl returned this public Reddit discussion and source URL."
          }),
          monthlyViews: createNotMeasuredEvidence(
            "No provider returned verified monthly Reddit traffic or view data for this discussion."
          ),
          upvotes: createRedditMetricEvidence({
            value: source.score,
            metric: "upvote count",
            observationDate,
            reference
          }),
          comments: createRedditMetricEvidence({
            value: source.comments,
            metric: "comment count",
            observationDate,
            reference
          }),
          analysis: createInferredEvidence({
            provider: "OpenAI analysis of Firecrawl evidence",
            observationDate,
            references: [reference],
            confidence: 0.7,
            explanation:
              "The opportunity and suggested comment are inferred from the public discussion summary."
          })
        }
      }
    ];
  });
}

function mergeAiCitationOpportunities(
  sections: NarrativeSynthesisSections["aiCitationOpportunities"]
): AiCitationOpportunity[] {
  return sections.map((section) => ({
    ...section,
    isSimulation: true,
    evidence: createNotMeasuredEvidence(
      "This is a planning simulation. Live ChatGPT, Gemini, and Perplexity visibility was not checked."
    )
  }));
}

function createKeywordEvidence(
  metric: ReportSynthesisInput["keywordMetrics"][number],
  observationDate: string
) {
  const reference = createEvidenceReference({
    referenceId: evidenceReferenceId("ahrefs-keyword", metric.keyword),
    provider: "Ahrefs",
    sourceUrl: null,
    observationDate,
    description: `Ahrefs keyword response for ${metric.keyword}.`
  });
  const metricEvidence = (value: number | null, label: string) =>
    value === null
      ? createUnavailableEvidence({
          provider: "Ahrefs",
          observationDate,
          explanation: `Ahrefs did not return a verified ${label} for this keyword.`
        })
      : createMeasuredEvidence({
          provider: "Ahrefs",
          observationDate,
          references: [reference],
          explanation: `Ahrefs returned this ${label} in the keyword response.`
        });

  return {
    monthlySearchVolume: metricEvidence(metric.monthlySearchVolume, "monthly search volume"),
    difficulty: metricEvidence(metric.difficulty, "keyword difficulty"),
    trafficPotential: metricEvidence(metric.trafficPotential, "traffic potential"),
    intent: createInferredEvidence({
      provider: "OpenAI analysis of Ahrefs keyword data",
      observationDate,
      references: [reference],
      confidence: 0.7,
      explanation: "Search intent is an analysis of the keyword and available provider data."
    }),
    analysis: createInferredEvidence({
      provider: "OpenAI analysis of Ahrefs and search evidence",
      observationDate,
      references: [reference],
      confidence: 0.65,
      explanation:
        "The visibility observation, Reddit fit, priority, and recommended action are inferred from the research."
    })
  };
}

function createRedditMetricEvidence({
  value,
  metric,
  observationDate,
  reference
}: {
  value: number | null;
  metric: string;
  observationDate: string;
  reference: ReturnType<typeof createEvidenceReference>;
}) {
  return value === null
    ? createUnavailableEvidence({
        provider: "Firecrawl",
        observationDate,
        explanation: `Firecrawl did not return a verified ${metric} for this discussion.`
      })
    : createMeasuredEvidence({
        provider: "Firecrawl",
        observationDate,
        references: [reference],
        explanation: `Firecrawl returned this ${metric} with the public discussion.`
      });
}

function buildReportClaims({
  input,
  generatedAt,
  headline,
  businessEvidence,
  opportunityScore,
  opportunityScoreEvidence,
  keywordOpportunities,
  redditOpportunities
}: {
  input: ReportSynthesisInput;
  generatedAt: string;
  headline: string;
  businessEvidence: EvidenceMetadata;
  opportunityScore: number;
  opportunityScoreEvidence: EvidenceMetadata;
  keywordOpportunities: KeywordOpportunity[];
  redditOpportunities: RedditOpportunity[];
}): ReportClaim[] {
  const keywordReferences = keywordOpportunities.flatMap(
    (keyword) => keyword.evidence.monthlySearchVolume.evidenceReferences
  );
  const redditReferences = redditOpportunities.flatMap(
    (opportunity) => opportunity.evidence.discussion.evidenceReferences
  );
  const keywordEvidence = keywordReferences.length
    ? createMeasuredEvidence({
        provider: "Ahrefs",
        observationDate: generatedAt,
        references: keywordReferences,
        explanation: "The report includes only keyword volumes returned by Ahrefs."
      })
    : createUnavailableEvidence({
        provider: "Ahrefs",
        observationDate: generatedAt,
        explanation: "Ahrefs did not return sufficient keyword volume data for this report."
      });
  const redditDiscussionEvidence = redditReferences.length
    ? createMeasuredEvidence({
        provider: "Firecrawl",
        observationDate: generatedAt,
        references: redditReferences,
        explanation: "Firecrawl returned the linked public Reddit discussions."
      })
    : createUnavailableEvidence({
        provider: "Firecrawl",
        observationDate: generatedAt,
        explanation: "No relevant public Reddit discussions were returned for this report."
      });

  return [
    claim("business-profile", `${input.analysis.business.companyName} was categorized as ${input.analysis.business.category}.`, businessEvidence),
    claim("report-headline", headline, businessEvidence),
    claim(
      "opportunity-score",
      `The report's inferred opportunity score is ${opportunityScore} out of 100.`,
      opportunityScoreEvidence
    ),
    claim(
      "keyword-volume-availability",
      keywordReferences.length
        ? `Ahrefs returned monthly search volume for ${keywordReferences.length} report keyword${keywordReferences.length === 1 ? "" : "s"}.`
        : "Verified monthly keyword search volume was unavailable.",
      keywordEvidence
    ),
    claim(
      "reddit-discussion-discovery",
      redditReferences.length
        ? `Firecrawl found ${redditReferences.length} relevant public Reddit discussion${redditReferences.length === 1 ? "" : "s"}.`
        : "Relevant public Reddit discussion evidence was unavailable.",
      redditDiscussionEvidence
    ),
    claim(
      "ai-platform-visibility",
      "Live visibility in ChatGPT, Gemini, and Perplexity was not measured.",
      createNotMeasuredEvidence(
        "The current workflow generates planning simulations but does not run a supported live AI visibility provider."
      )
    )
  ];
}

function claim(claimId: string, claimText: string, evidence: EvidenceMetadata): ReportClaim {
  return {
    claimId,
    claimText,
    ...evidence
  };
}

function normalizeDomain(value: string) {
  return value.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0]?.toLowerCase() ?? "";
}
