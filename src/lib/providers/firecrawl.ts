import { fetchJson } from "@/lib/providers/http";
import type { CrawlResult, RedditEvidence, SearchResult } from "@/lib/providers/types";

interface FirecrawlResponse {
  success?: boolean;
  data?: {
    markdown?: string;
    metadata?: {
      title?: string;
      description?: string;
      sourceURL?: string;
    };
  };
}

interface FirecrawlSearchResponse {
  success?: boolean;
  data?: FirecrawlSearchItem[] | {
    web?: FirecrawlSearchItem[];
    images?: unknown[];
    news?: FirecrawlSearchItem[];
  };
}

interface FirecrawlSearchItem {
    title?: string;
    url?: string;
    description?: string;
    markdown?: string;
    metadata?: {
      title?: string;
      description?: string;
      sourceURL?: string;
    };
}

export class FirecrawlProvider {
  constructor(private readonly apiKey: string) {}

  async crawlWebsite(url: string): Promise<CrawlResult> {
    const response = await fetchJson<FirecrawlResponse>("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        maxAge: 172800000
      }),
      timeoutMs: 30_000
    });

    const text = response.data?.markdown?.trim();

    if (!text) {
      throw new Error("Firecrawl did not return readable main content.");
    }

    return {
      url: response.data?.metadata?.sourceURL ?? url,
      title: response.data?.metadata?.title ?? new URL(url).hostname,
      description: response.data?.metadata?.description,
      text: text.slice(0, 18_000)
    };
  }

  async getSearchResults(queries: string[]): Promise<SearchResult[]> {
    const batches = await this.searchMany(queries.slice(0, 6), 3);

    return batches
      .flatMap(({ query, response }) =>
        getSearchItems(response).map((item, index) => {
          const url = item.url ?? item.metadata?.sourceURL ?? "";
          const domain = safeDomain(url);

          return {
            query,
            title: item.title ?? item.metadata?.title ?? "Untitled result",
            url,
            domain,
            snippet: item.description ?? item.metadata?.description ?? "",
            position: index + 1,
            isReddit: domain.includes("reddit.com")
          };
        })
      )
      .filter((result) => result.url);
  }

  async getRedditEvidence({ queries }: { queries: string[] }): Promise<RedditEvidence[]> {
    const seen = new Set<string>();
    const batches = await this.searchMany(
      queries.slice(0, 6).map((query) => `site:reddit.com/r ${query}`),
      3
    );

    return batches
      .flatMap(({ response }) =>
        getSearchItems(response).flatMap((item): RedditEvidence[] => {
          const url = item.url ?? item.metadata?.sourceURL ?? "";
          if (!url || !safeDomain(url).includes("reddit.com") || seen.has(url)) {
            return [];
          }

          seen.add(url);
          const title = item.title ?? item.metadata?.title ?? "Relevant Reddit discussion";
          const summary =
            item.description ??
            item.metadata?.description ??
            item.markdown?.replace(/\s+/g, " ").slice(0, 240) ??
            "Public Reddit result found by Firecrawl search.";

          return [
            {
              title,
              subreddit: extractSubreddit(url) ?? "r/reddit",
              url,
              score: null,
              comments: null,
              summary: summary.slice(0, 240)
            }
          ];
        })
      )
      .slice(0, 10);
  }

  private async searchMany(queries: string[], limit: number) {
    const settled = await Promise.allSettled(
      queries.map(async (query) => ({
        query,
        response: await this.search(query, limit)
      }))
    );

    return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  }

  private search(query: string, limit: number) {
    return fetchJson<FirecrawlSearchResponse>("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query,
        limit,
        sources: ["web"]
      }),
      timeoutMs: 45_000
    });
  }
}

function safeDomain(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function extractSubreddit(url: string) {
  const match = url.match(/\/r\/([^/]+)/i);
  return match?.[1] ? `r/${match[1]}` : null;
}

function getSearchItems(response: FirecrawlSearchResponse) {
  if (Array.isArray(response.data)) {
    return response.data;
  }

  return response.data?.web ?? [];
}
