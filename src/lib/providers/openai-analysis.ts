import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import {
  businessProfileSchema,
  opportunityReportSchema,
  type OpportunityReport
} from "@/lib/report/schema";
import {
  createMemeConcepts,
  getDefaultPricingTiers
} from "@/lib/report/commercial";
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
            "Create a visitor-safe Launch Club AI Search Opportunity Report. Be specific, avoid guarantees, and label simulated AI-search opportunities when real AI checks are not enabled."
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              publicId: input.publicId,
              submittedUrl: input.submittedUrl,
              normalizedUrl: input.normalizedUrl,
              domain: input.domain,
              business: input.analysis.business,
              keywords: input.keywordMetrics,
              searchResults: input.searchResults.slice(0, 25),
              ahrefs: input.ahrefs,
              reddit: input.reddit,
              enableRealAiChecks: input.enableRealAiChecks,
              fixedPricingTiers: getDefaultPricingTiers(),
              memeConceptExamples: createMemeConcepts({
                companyName: input.analysis.business.companyName,
                category: input.analysis.business.category,
                primaryKeyword: input.analysis.primaryKeyword
              }),
              requirements: {
                keywordOpportunities: "Use 8 to 12 keyword opportunities.",
                aiCitationOpportunities: "Return exactly 4. Set isSimulation to true unless enableRealAiChecks is true.",
                redditOpportunities: "Use 2 to 5 Reddit opportunities based on provided evidence.",
                redditTraffic:
                  "Include estimatedMonthlyViews, upvoteCount, commentCount, and engagementSummary for each Reddit opportunity. Treat score/comment data as directional engagement proxies, not official Reddit traffic.",
                visibilitySnapshot:
                  "Include current vs target AI visibility and Reddit presence scores that tell the before/after story.",
                memeConcepts:
                  "Return 2 to 4 memes.ai-ready meme concepts. Do not claim images were generated unless imageUrl is present.",
                pricingTiers:
                  "Use fixedPricingTiers exactly; do not invent prices. bookingUrl may be a placeholder and will be normalized by the app.",
                claims: "No guaranteed rankings, citations, traffic, or revenue."
              }
            },
            null,
            2
          )
        }
      ],
      text: {
        format: zodTextFormat(opportunityReportSchema, "ai_search_opportunity_report")
      }
    });

    if (!response.output_parsed) {
      throw new Error("OpenAI did not return a valid report.");
    }

    return response.output_parsed;
  }
}
