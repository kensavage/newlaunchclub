import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import {
  businessProfileSchema,
  aiCitationOpportunitySchema,
  competitorGapSchema,
  keywordOpportunitySchema,
  opportunityReportSchema,
  redditOpportunitySchema,
  type OpportunityReport
} from "@/lib/report/schema";
import {
  createMemeConcepts,
  createVisibilitySnapshot,
  getDefaultPricingTiers
} from "@/lib/report/commercial";
import { calculateOpportunityScore } from "@/lib/report/scoring";
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

const reportSynthesisSectionsSchema = z.object({
  headline: z.string(),
  keywordOpportunities: z.array(keywordOpportunitySchema).min(1).max(12),
  redditOpportunities: z.array(redditOpportunitySchema).max(5),
  competitorGaps: z.array(competitorGapSchema).max(5),
  aiCitationOpportunities: z.array(aiCitationOpportunitySchema).length(4),
  nextSteps: z.array(z.string()).min(1).max(6),
  evidenceSummary: z.object({
    keywordSource: z.string(),
    redditSource: z.string(),
    aiSearchSource: z.string()
  })
});

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
    const response = await this.client.responses.parse({
      model: this.synthesisModel,
      input: [
        {
          role: "system",
          content:
            "Create the visitor-facing opportunity sections for a Launch Club AI Search Opportunity Report. Be specific, avoid guarantees, and label simulated AI-search opportunities when real AI checks are not enabled. Do not create pricing, meme images, visibility scores, or an overall opportunity score; the app calculates those deterministically."
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              domain: input.domain,
              business: input.analysis.business,
              keywords: input.keywordMetrics.slice(0, 16),
              searchResults: input.searchResults.slice(0, 12),
              ahrefs: {
                domainTraffic: input.ahrefs.domainTraffic,
                topPages: input.ahrefs.topPages.slice(0, 5),
                organicCompetitors: input.ahrefs.organicCompetitors.slice(0, 5),
                keywordMetrics: input.ahrefs.keywordMetrics.slice(0, 16)
              },
              reddit: input.reddit.slice(0, 5),
              enableRealAiChecks: input.enableRealAiChecks,
              requirements: {
                keywordOpportunities: "Use 8 to 12 keyword opportunities.",
                aiCitationOpportunities: "Return exactly 4. Set isSimulation to true unless enableRealAiChecks is true.",
                redditOpportunities: "Use 2 to 5 Reddit opportunities based on provided evidence.",
                redditTraffic:
                  "Include estimatedMonthlyViews, upvoteCount, commentCount, and engagementSummary for each Reddit opportunity. Treat score/comment data as directional engagement proxies, not official Reddit traffic.",
                deterministicFields:
                  "Do not return opportunityScore, visibilitySnapshot, pricingTiers, memeConcepts, bookingUrl, publicId, submittedUrl, generatedAt, or domain.",
                claims: "No guaranteed rankings, citations, traffic, or revenue."
              }
            }
          )
        }
      ],
      text: {
        format: zodTextFormat(reportSynthesisSectionsSchema, "ai_search_opportunity_sections")
      }
    });

    if (!response.output_parsed) {
      throw new Error("OpenAI did not return a valid report.");
    }

    const sections = response.output_parsed;
    const opportunityScore = calculateOpportunityScore({
      keywordOpportunities: sections.keywordOpportunities,
      redditOpportunities: sections.redditOpportunities,
      competitorGaps: sections.competitorGaps
    });
    const keywordTraffic = sections.keywordOpportunities.reduce(
      (sum, keyword) => sum + (keyword.trafficPotential ?? keyword.monthlySearchVolume ?? 0),
      0
    );

    return opportunityReportSchema.parse({
      publicId: input.publicId,
      generatedAt: new Date().toISOString(),
      submittedUrl: input.submittedUrl,
      domain: input.domain,
      opportunityScore,
      headline: sections.headline,
      business: input.analysis.business,
      visibilitySnapshot: createVisibilitySnapshot({
        opportunityScore,
        redditOpportunities: sections.redditOpportunities,
        keywordTraffic
      }),
      keywordOpportunities: sections.keywordOpportunities,
      redditOpportunities: sections.redditOpportunities,
      competitorGaps: sections.competitorGaps,
      aiCitationOpportunities: sections.aiCitationOpportunities,
      memeConcepts: createMemeConcepts({
        companyName: input.analysis.business.companyName,
        category: input.analysis.business.category,
        primaryKeyword: input.analysis.primaryKeyword
      }),
      pricingTiers: getDefaultPricingTiers(),
      bookingUrl: "mailto:hello@launchclub.ai?subject=Buyer%20Visibility%20Sprint",
      nextSteps: sections.nextSteps,
      evidenceSummary: {
        crawlSummary: `Analyzed homepage and linked internal pages from ${input.normalizedUrl}.`,
        keywordSource: sections.evidenceSummary.keywordSource,
        redditSource: sections.evidenceSummary.redditSource,
        aiSearchSource: sections.evidenceSummary.aiSearchSource,
        generatedWithRealAiChecks: input.enableRealAiChecks
      }
    });
  }
}
