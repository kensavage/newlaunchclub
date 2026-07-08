import {
  calculateOpportunityScore,
  getKeywordPriority
} from "@/lib/report/scoring";
import type { OpportunityReport } from "@/lib/report/schema";
import {
  createMemeConcepts,
  createVisibilitySnapshot,
  getDefaultPricingTiers
} from "@/lib/report/commercial";
import type {
  AhrefsInsights,
  BusinessAnalysis,
  CrawlResult,
  KeywordMetric,
  ProviderBundle,
  RedditEvidence,
  ReportSynthesisInput,
  SearchResult
} from "@/lib/providers/types";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MockProviderBundle implements ProviderBundle {
  async crawlWebsite(url: string): Promise<CrawlResult> {
    await wait(20);
    const parsed = new URL(url);
    const companyName = titleCase(parsed.hostname.replace(/^www\./, "").split(".")[0] ?? "Company");

    const pages = [
      {
        url,
        title: `${companyName} - AI-powered growth platform`,
        description: `${companyName} helps teams improve buyer visibility.`,
        text: `${companyName} helps companies get discovered by buyers through AI search, Reddit conversations, comparison content, and category pages. The company works with growth teams that want more qualified pipeline and clearer proof.`
      },
      {
        url: new URL("/services", url).toString(),
        title: `${companyName} services`,
        description: "Services for Reddit and AI-search visibility.",
        text: `${companyName} offers Reddit opportunity research, comment strategy, comparison content, and AI-search visibility reporting.`
      }
    ];

    return {
      url,
      title: pages[0].title,
      description: pages[0].description,
      text: pages.map((page) => page.text).join("\n\n"),
      pages
    };
  }

  async analyzeBusiness({ crawl, url }: { crawl: CrawlResult; url: string }): Promise<BusinessAnalysis> {
    await wait(20);
    const parsed = new URL(url);
    const companyName = titleCase(parsed.hostname.replace(/^www\./, "").split(".")[0] ?? "Company");
    const category = "AI search visibility and Reddit growth";
    const keywords = [
      `${companyName} reviews`,
      `${companyName} alternatives`,
      `${companyName} pricing`,
      `${companyName} reddit`,
      "AI search visibility",
      "Reddit marketing agency",
      "get cited by ChatGPT",
      "AI search optimization",
      "Reddit SEO strategy",
      "best Reddit marketing service",
      "AI citation tracking",
      "buyer visibility sprint",
      "Reddit posts for SEO",
      "Perplexity brand citations",
      "Gemini search optimization",
      "ChatGPT referral traffic",
      "community-led SEO",
      "brand mention monitoring",
      "B2B Reddit marketing",
      "AI answer engine optimization"
    ];

    return {
      business: {
        companyName,
        website: url,
        category,
        primaryKeyword: "AI search visibility",
        summary: `${companyName} appears positioned around helping teams become easier to find where buyers research: Reddit, Google, and AI search.`
      },
      keywords,
      primaryKeyword: "AI search visibility",
      buyerQueries: [
        `${companyName} reviews`,
        `${companyName} alternatives`,
        `${companyName} pricing`,
        `best ${category}`,
        `${companyName} vs competitors`,
        `${category} reddit`,
        `how to get cited by ChatGPT`,
        `AI search visibility services`,
        `Reddit marketing agency reviews`,
        `best AI search optimization agency`
      ],
      redditQueries: [
        `${companyName} reddit`,
        `${category} reddit`,
        "best Reddit marketing agency reddit",
        "how to get mentioned in ChatGPT reddit"
      ],
      competitors: ["Peec AI", "Profound", "AirOps", "Writesonic"],
      summary: crawl.text.slice(0, 240)
    };
  }

  async getKeywordMetrics(keywords: string[]): Promise<KeywordMetric[]> {
    await wait(20);
    return keywords.slice(0, 20).map((keyword, index) => ({
      keyword,
      monthlySearchVolume: Math.max(40, 1200 - index * 47),
      difficulty: Math.min(82, 18 + index * 3),
      trafficPotential: Math.max(25, 1800 - index * 52),
      intent: keyword.includes("reviews") || keyword.includes("alternatives") ? "Decision" : "Discovery"
    }));
  }

  async getSearchResults(queries: string[]): Promise<SearchResult[]> {
    await wait(20);
    return queries.flatMap((query, index) => [
      {
        query,
        title: `${query} - Reddit discussion`,
        url: `https://www.reddit.com/r/marketing/comments/mock${index}/discussion/`,
        domain: "reddit.com",
        snippet: "A buyer-style discussion where people compare options and ask for firsthand examples.",
        position: 1,
        isReddit: true
      },
      {
        query,
        title: `${query} comparison guide`,
        url: `https://example.com/${encodeURIComponent(query)}`,
        domain: "example.com",
        snippet: "A competitor or publisher page occupying a decision-stage search result.",
        position: 2,
        isReddit: false
      }
    ]);
  }

  async getAhrefsInsights(): Promise<AhrefsInsights> {
    await wait(20);
    return {
      domainTraffic: 4200,
      topPages: [
        { url: "https://example.com/blog/ai-search", traffic: 1200, title: "AI search guide" },
        { url: "https://example.com/reddit-marketing", traffic: 940, title: "Reddit marketing" }
      ],
      organicCompetitors: [
        { name: "Peec AI", domain: "peec.ai", traffic: 21000 },
        { name: "Profound", domain: "tryprofound.com", traffic: 18000 },
        { name: "AirOps", domain: "airops.com", traffic: 14500 }
      ],
      keywordMetrics: []
    };
  }

  async getRedditEvidence(): Promise<RedditEvidence[]> {
    await wait(20);
    return [
      {
        title: "What are people using to track ChatGPT and Perplexity mentions?",
        subreddit: "r/SEO",
        url: "https://www.reddit.com/r/SEO/comments/mock_ai_search_mentions/",
        score: 42,
        comments: 19,
        summary: "People are asking for practical ways to track whether AI tools mention a brand or competitor."
      },
      {
        title: "Is Reddit still worth it for B2B SaaS marketing?",
        subreddit: "r/marketing",
        url: "https://www.reddit.com/r/marketing/comments/mock_b2b_reddit/",
        score: 68,
        comments: 31,
        summary: "The discussion centers on authentic participation, useful answers, and avoiding obvious promotion."
      },
      {
        title: "How do companies get included in AI answers?",
        subreddit: "r/startups",
        url: "https://www.reddit.com/r/startups/comments/mock_ai_answers/",
        score: 29,
        comments: 14,
        summary: "Founders are trying to understand which third-party sources influence AI-generated answers."
      }
    ];
  }

  async generateMemeImages({ concepts }: { concepts: OpportunityReport["memeConcepts"] }) {
    await wait(20);
    return concepts;
  }

  async synthesizeReport(input: ReportSynthesisInput) {
    await wait(20);
    const keywordOpportunities: OpportunityReport["keywordOpportunities"] = input.keywordMetrics.slice(0, 12).map((metric, index) => {
      const redditFit = index % 3 === 0 ? "High" : index % 3 === 1 ? "Medium" : "Low";
      return {
        keyword: metric.keyword,
        intent: metric.intent ?? "Discovery",
        monthlySearchVolume: metric.monthlySearchVolume,
        difficulty: metric.difficulty,
        trafficPotential: metric.trafficPotential,
        sourceVisibility:
          index < 4
            ? "Competitors and third-party sources are easier to find than the submitted site."
            : "The submitted site can win more visibility with a focused answer page or proof asset.",
        redditFit,
        priority: getKeywordPriority(metric.monthlySearchVolume, redditFit),
        recommendedAction:
          index < 4
            ? "Create or improve a decision-stage page and seed a Reddit-safe discussion angle."
            : "Monitor the query and add a concise answer to the site."
      };
    });
    const redditOpportunities: OpportunityReport["redditOpportunities"] = input.reddit.map((evidence, index) => ({
      title: evidence.title,
      subreddit: evidence.subreddit,
      url: evidence.url,
      estimatedMonthlyViews: Math.max(650, (evidence.score ?? 10) * 95 + (evidence.comments ?? 5) * 140),
      upvoteCount: evidence.score ?? 0,
      commentCount: evidence.comments ?? 0,
      engagementSummary: `${evidence.score ?? 0} upvotes and ${evidence.comments ?? 0} comments, used as a directional engagement proxy rather than official Reddit traffic.`,
      discussionSummary: evidence.summary,
      whyLowHangingFruit:
        "The thread already contains buyer-language questions. A useful answer or related educational post can create discovery without forcing a sales pitch.",
      suggestedPostTitle:
        index === 0
          ? "How are teams actually measuring AI-search visibility?"
          : "What should a useful Reddit and AI-search visibility plan include?",
      suggestedPostBody:
        "I am comparing practical ways teams show up where buyers research before a sales call. The useful patterns seem to be clear comparison pages, helpful Reddit participation, and third-party source mentions that AI tools can cite. What has worked without feeling spammy?",
      riskLevel: index === 0 ? "Low" : "Medium"
    }));
    const competitorGaps: OpportunityReport["competitorGaps"] = input.ahrefs.organicCompetitors.slice(0, 5).map((competitor) => ({
      competitor: competitor.name,
      source: competitor.domain,
      url: `https://${competitor.domain}`,
      gap: `${competitor.name} appears to have more established search visibility and likely more third-party source coverage.`,
      recommendedAction: "Build a comparison or alternatives page and support it with useful Reddit/source participation."
    }));
    const opportunityScore = calculateOpportunityScore({
      keywordOpportunities,
      redditOpportunities,
      competitorGaps
    });
    const isSimulation = !input.enableRealAiChecks;
    const keywordTraffic = keywordOpportunities.reduce(
      (sum, keyword) => sum + (keyword.trafficPotential ?? keyword.monthlySearchVolume ?? 0),
      0
    );

    return {
      publicId: input.publicId,
      generatedAt: new Date().toISOString(),
      submittedUrl: input.submittedUrl,
      domain: input.domain,
      opportunityScore,
      headline: `${input.analysis.business.companyName} has a clear opening to be easier to find on Reddit and in AI search answers.`,
      business: input.analysis.business,
      visibilitySnapshot: createVisibilitySnapshot({
        opportunityScore,
        redditOpportunities,
        keywordTraffic
      }),
      keywordOpportunities,
      redditOpportunities,
      competitorGaps,
      aiCitationOpportunities: [
        {
          prompt: `What are the best ${input.analysis.business.category} companies?`,
          sampleAnswer: `${input.analysis.business.companyName} could be mentioned alongside established alternatives if useful comparison and proof sources are published.`,
          citationAngle: "Create a credible category comparison page and earn discussion in relevant Reddit threads.",
          isSimulation
        },
        {
          prompt: `Which ${input.analysis.business.category} option is best for startups?`,
          sampleAnswer: `A strong answer would cite clear pricing, use cases, and third-party discussion that explains where ${input.analysis.business.companyName} fits.`,
          citationAngle: "Publish startup-specific positioning and proof.",
          isSimulation
        },
        {
          prompt: `What do Reddit users recommend for ${input.analysis.primaryKeyword}?`,
          sampleAnswer: `${input.analysis.business.companyName} can become discoverable when authentic discussions answer real questions and link back to useful resources.`,
          citationAngle: "Use Reddit-safe educational posts and helpful comments.",
          isSimulation
        },
        {
          prompt: `What are alternatives to ${input.analysis.competitors[0] ?? "popular competitors"}?`,
          sampleAnswer: `AI search systems need source material that explains credible alternatives. ${input.analysis.business.companyName} needs clearer comparison content to qualify.`,
          citationAngle: "Create alternatives content that is factual, narrow, and easy to cite.",
          isSimulation
        }
      ],
      memeConcepts: createMemeConcepts({
        companyName: input.analysis.business.companyName,
        category: input.analysis.business.category,
        primaryKeyword: input.analysis.primaryKeyword
      }),
      pricingTiers: getDefaultPricingTiers(),
      bookingUrl: "mailto:hello@launchclub.ai?subject=Buyer%20Visibility%20Sprint",
      nextSteps: [
        "Prioritize the top 5 keywords with Reddit fit and decision-stage intent.",
        "Create one comparison or alternatives page that AI tools can easily parse.",
        "Draft one helpful Reddit post angle and one comment angle for human review.",
        "Run a Buyer Visibility Sprint to expand from this sample to a full 40-75 query map."
      ],
      evidenceSummary: {
        crawlSummary: `Analyzed main page text from ${input.normalizedUrl}.`,
        keywordSource: "Keyword and search visibility metrics are from mock provider data in local mode.",
        redditSource: "Reddit opportunities are represented by mock evidence in local mode.",
        aiSearchSource: isSimulation
          ? "AI-search examples are simulated opportunity examples, not verified live citations."
          : "AI-search examples include provider checks where enabled.",
        generatedWithRealAiChecks: input.enableRealAiChecks
      }
    };
  }
}

function titleCase(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}
