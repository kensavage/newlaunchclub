import { beforeEach, describe, expect, it, vi } from "vitest";
import { AhrefsProvider } from "@/lib/providers/ahrefs";
import { DataForSeoProvider } from "@/lib/providers/dataforseo";
import { FirecrawlProvider } from "@/lib/providers/firecrawl";
import { OpenAIAnalysisProvider } from "@/lib/providers/openai-analysis";
import { RedditProvider } from "@/lib/providers/reddit";
import {
  createMemeConcepts,
  createVisibilitySnapshot,
  getDefaultPricingTiers
} from "@/lib/report/commercial";

const { openAiParseMock } = vi.hoisted(() => ({
  openAiParseMock: vi.fn()
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = {
      parse: openAiParseMock
    };
  }
}));

vi.mock("openai/helpers/zod", () => ({
  zodTextFormat: (_schema: unknown, name: string) => ({ name })
}));

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

describe("provider adapters with mocked HTTP", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    openAiParseMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("maps Firecrawl scrape responses into crawl text", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          markdown: "Main page text",
          metadata: {
            title: "Launch Club",
            description: "Buyer visibility",
            sourceURL: "https://launchclub.ai/"
          }
        }
      })
    );

    const result = await new FirecrawlProvider("fire-key").crawlWebsite("https://launchclub.ai/");

    expect(result.title).toBe("Launch Club");
    expect(result.text).toBe("Main page text");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.firecrawl.dev/v2/scrape",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer fire-key" })
      })
    );
  });

  it("maps Firecrawl v2 search responses into web and Reddit evidence", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            web: [
              {
                title: "Best AI visibility tools",
                url: "https://example.com/ai-visibility",
                description: "A comparison page."
              },
              {
                title: "Reddit thread",
                url: "https://www.reddit.com/r/SEO/comments/example/thread/",
                description: "People compare tools."
              }
            ]
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            web: [
              {
                title: "What tools track AI mentions?",
                url: "https://www.reddit.com/r/SEO/comments/example/tools/",
                description: "A discussion about AI visibility tools."
              }
            ]
          }
        })
      );

    const provider = new FirecrawlProvider("fire-key");
    const searchResults = await provider.getSearchResults(["ai visibility tools"]);
    const redditEvidence = await provider.getRedditEvidence({ queries: ["ai mentions"] });

    expect(searchResults).toHaveLength(2);
    expect(searchResults[1]).toMatchObject({
      domain: "www.reddit.com",
      isReddit: true
    });
    expect(redditEvidence[0]).toMatchObject({
      subreddit: "r/SEO",
      title: "What tools track AI mentions?"
    });
  });

  it("maps DataForSEO keyword and SERP responses", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          tasks: [
            {
              result: [
                {
                  keyword: "ai search visibility",
                  search_volume: 1200,
                  competition_index: 28
                }
              ]
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          tasks: [
            {
              result: [
                {
                  keyword: "best ai search visibility",
                  items: [
                    {
                      type: "organic",
                      rank_group: 1,
                      title: "Reddit discussion",
                      url: "https://www.reddit.com/r/SEO/comments/example/",
                      domain: "reddit.com",
                      description: "People compare options."
                    }
                  ]
                }
              ]
            }
          ]
        })
      );

    const provider = new DataForSeoProvider("login", "password");
    const metrics = await provider.getKeywordMetrics(["ai search visibility"]);
    const results = await provider.getSearchResults(["best ai search visibility"]);

    expect(metrics[0]).toMatchObject({
      keyword: "ai search visibility",
      monthlySearchVolume: 1200,
      difficulty: 28
    });
    expect(results[0]).toMatchObject({
      title: "Reddit discussion",
      isReddit: true
    });
  });

  it("combines Ahrefs domain, keyword, top-page, and competitor responses", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("keywords-explorer")) {
        return Promise.resolve(
          jsonResponse({
            keywords: [
              {
                keyword: "ai citations",
                volume: 700,
                difficulty: 21,
                traffic_potential: 1400,
                intents: { commercial: true }
              }
            ]
          })
        );
      }

      if (url.includes("site-explorer/metrics")) {
        return Promise.resolve(jsonResponse({ metrics: { org_traffic: 4200 } }));
      }

      if (url.includes("site-explorer/top-pages")) {
        return Promise.resolve(
          jsonResponse({ pages: [{ url: "https://launchclub.ai/guide", traffic: 900, title: "Guide" }] })
        );
      }

      return Promise.resolve(
        jsonResponse({ competitors: [{ domain: "competitor.example", traffic: 12000 }] })
      );
    });

    const insights = await new AhrefsProvider("ahrefs-key").getAhrefsInsights({
      domain: "launchclub.ai",
      normalizedUrl: "https://launchclub.ai/",
      keywords: ["ai citations"]
    });

    expect(insights.domainTraffic).toBe(4200);
    expect(insights.keywordMetrics[0]?.trafficPotential).toBe(1400);
    expect(insights.topPages[0]?.title).toBe("Guide");
    expect(insights.organicCompetitors[0]?.name).toBe("competitor.example");
  });

  it("uses Reddit OAuth and stores summaries instead of full raw content", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "token", expires_in: 3600 }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            children: [
              {
                data: {
                  title: "What tools track AI mentions?",
                  subreddit_name_prefixed: "r/SEO",
                  permalink: "/r/SEO/comments/example/tools/",
                  score: 21,
                  num_comments: 8,
                  selftext: "A ".repeat(400)
                }
              }
            ]
          }
        })
      );

    const evidence = await new RedditProvider("id", "secret", "web:test:v1").getRedditEvidence({
      queries: ["ai mentions"]
    });

    expect(evidence[0]).toMatchObject({
      title: "What tools track AI mentions?",
      subreddit: "r/SEO",
      url: "https://www.reddit.com/r/SEO/comments/example/tools/"
    });
    expect(evidence[0]?.summary.length).toBeLessThanOrEqual(240);
  });

  it("maps OpenAI structured outputs for analysis and synthesis", async () => {
    const analysis = {
      business: {
        companyName: "Launch Club",
        website: "https://launchclub.ai/",
        category: "AI visibility",
        primaryKeyword: "AI search visibility",
        summary: "Launch Club helps teams become visible."
      },
      keywords: Array.from({ length: 20 }, (_, index) => `keyword ${index}`),
      primaryKeyword: "AI search visibility",
      buyerQueries: Array.from({ length: 10 }, (_, index) => `query ${index}`),
      redditQueries: ["reddit query 1", "reddit query 2", "reddit query 3"],
      competitors: ["A", "B", "C"],
      summary: "Short summary"
    };
    const report = {
      publicId: "openai-report",
      generatedAt: new Date("2026-07-06T12:00:00.000Z").toISOString(),
      submittedUrl: "launchclub.ai",
      domain: "launchclub.ai",
      opportunityScore: 80,
      headline: "Launch Club has an opening.",
      business: analysis.business,
      visibilitySnapshot: createVisibilitySnapshot({
        opportunityScore: 80,
        redditOpportunities: [],
        keywordTraffic: 100
      }),
      keywordOpportunities: [
        {
          keyword: "keyword 1",
          intent: "Discovery",
          monthlySearchVolume: 100,
          difficulty: 10,
          trafficPotential: 200,
          sourceVisibility: "Competitors appear more visible.",
          redditFit: "High",
          priority: "High",
          recommendedAction: "Publish a source page."
        }
      ],
      redditOpportunities: [],
      competitorGaps: [],
      aiCitationOpportunities: Array.from({ length: 4 }, (_, index) => ({
        prompt: `Prompt ${index}`,
        sampleAnswer: "Sample answer.",
        citationAngle: "Citation angle.",
        isSimulation: true
      })),
      memeConcepts: createMemeConcepts({
        companyName: "Launch Club",
        category: "AI visibility",
        primaryKeyword: "AI search visibility"
      }),
      pricingTiers: getDefaultPricingTiers(),
      bookingUrl: "mailto:hello@launchclub.ai?subject=Buyer%20Visibility%20Sprint",
      nextSteps: ["Next step"],
      evidenceSummary: {
        crawlSummary: "Crawled.",
        keywordSource: "Provider data.",
        redditSource: "Reddit summaries.",
        aiSearchSource: "AI-search examples are simulated opportunity examples, not verified live citations.",
        generatedWithRealAiChecks: false
      }
    };

    openAiParseMock.mockResolvedValueOnce({ output_parsed: analysis }).mockResolvedValueOnce({
      output_parsed: report
    });

    const provider = new OpenAIAnalysisProvider("openai-key", "fast-model", "synthesis-model");
    await expect(
      provider.analyzeBusiness({
        crawl: { url: "https://launchclub.ai/", title: "Launch Club", text: "Main text" },
        url: "https://launchclub.ai/",
        domain: "launchclub.ai"
      })
    ).resolves.toMatchObject({ primaryKeyword: "AI search visibility" });

    await expect(
      provider.synthesizeReport({
        publicId: "openai-report",
        submittedUrl: "launchclub.ai",
        normalizedUrl: "https://launchclub.ai/",
        domain: "launchclub.ai",
        crawl: { url: "https://launchclub.ai/", title: "Launch Club", text: "Main text" },
        analysis,
        keywordMetrics: [],
        searchResults: [],
        ahrefs: {
          domainTraffic: null,
          topPages: [],
          organicCompetitors: [],
          keywordMetrics: []
        },
        reddit: [],
        enableRealAiChecks: false
      })
    ).resolves.toMatchObject({ publicId: "openai-report" });
  });
});
