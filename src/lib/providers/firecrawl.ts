import { fetchJson } from "@/lib/providers/http";
import type { CrawledPage, CrawlResult, RedditEvidence, SearchResult } from "@/lib/providers/types";

const MAX_LINKED_PAGES = 6;
const MAX_PAGE_TEXT_LENGTH = 5_000;
const MAX_COMBINED_TEXT_LENGTH = 28_000;

interface FirecrawlResponse {
  success?: boolean;
  data?: {
    markdown?: string;
    links?: string[];
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
    const homepage = await this.scrapePage(url, { includeLinks: true });

    if (!homepage.text) {
      throw new Error("Firecrawl did not return readable main content.");
    }

    const linkedUrls = selectOneLevelUrls(homepage.links, url, MAX_LINKED_PAGES);
    const linkedPages = await this.scrapeLinkedPages(linkedUrls);
    const pages = [toCrawledPage(homepage), ...linkedPages];

    return {
      url: homepage.url,
      title: homepage.title,
      description: homepage.description,
      text: buildCombinedCrawlText(pages),
      pages
    };
  }

  private async scrapeLinkedPages(urls: string[]) {
    const settled = await Promise.allSettled(urls.map((url) => this.scrapePage(url)));

    return settled.flatMap((result) => {
      if (result.status !== "fulfilled" || !result.value.text) {
        return [];
      }

      return [toCrawledPage(result.value)];
    });
  }

  private async scrapePage(url: string, { includeLinks = false }: { includeLinks?: boolean } = {}) {
    const response = await fetchJson<FirecrawlResponse>("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url,
        formats: includeLinks ? ["markdown", "links"] : ["markdown"],
        onlyMainContent: !includeLinks,
        maxAge: 172800000
      }),
      timeoutMs: 30_000
    });

    const text = response.data?.markdown?.trim();

    return {
      url: response.data?.metadata?.sourceURL ?? url,
      title: response.data?.metadata?.title ?? new URL(url).hostname,
      description: response.data?.metadata?.description,
      links: response.data?.links ?? [],
      text: text?.slice(0, MAX_PAGE_TEXT_LENGTH) ?? ""
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

function selectOneLevelUrls(links: string[], rootUrl: string, limit: number) {
  const root = new URL(rootUrl);
  const rootHost = normalizeHost(root.hostname);
  const rootNormalized = normalizeUrlForCrawl(root);
  const candidates = new Map<string, { url: string; score: number }>();

  for (const link of links) {
    const parsed = parseCandidateUrl(link, root);
    if (!parsed) continue;
    if (!["http:", "https:"].includes(parsed.protocol)) continue;
    if (normalizeHost(parsed.hostname) !== rootHost) continue;

    const normalized = normalizeUrlForCrawl(parsed);
    if (normalized === rootNormalized || shouldSkipCrawlPath(parsed.pathname)) continue;

    if (!candidates.has(normalized)) {
      candidates.set(normalized, {
        url: normalized,
        score: scoreCrawlUrl(parsed)
      });
    }
  }

  return [...candidates.values()]
    .sort((a, b) => b.score - a.score || a.url.length - b.url.length)
    .slice(0, limit)
    .map((candidate) => candidate.url);
}

function parseCandidateUrl(link: string, root: URL) {
  try {
    return new URL(link, root);
  } catch {
    return null;
  }
}

function normalizeUrlForCrawl(url: URL) {
  const normalized = new URL(url.toString());
  normalized.hash = "";
  normalized.search = "";
  normalized.pathname = normalized.pathname.replace(/\/+$/, "") || "/";

  return normalized.toString();
}

function normalizeHost(hostname: string) {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

function shouldSkipCrawlPath(pathname: string) {
  const normalized = pathname.toLowerCase();

  return (
    /\.(avif|css|csv|docx?|gif|ico|jpe?g|js|json|mov|mp3|mp4|pdf|png|pptx?|svg|webp|xlsx?|zip)$/i.test(
      normalized
    ) ||
    normalized.includes("/privacy") ||
    normalized.includes("/terms") ||
    normalized.includes("/login") ||
    normalized.includes("/sign-in") ||
    normalized.includes("/cart") ||
    normalized.includes("/account")
  );
}

function scoreCrawlUrl(url: URL) {
  const path = url.pathname.toLowerCase();
  const priorityTokens = [
    "service",
    "solution",
    "product",
    "feature",
    "platform",
    "about",
    "pricing",
    "case",
    "customer",
    "use-case",
    "industry",
    "work",
    "how-it-works"
  ];
  const deprioritizedTokens = ["blog", "news", "press", "careers", "jobs", "contact"];
  const priorityScore = priorityTokens.reduce(
    (score, token) => score + (path.includes(token) ? 10 : 0),
    0
  );
  const penalty = deprioritizedTokens.reduce(
    (score, token) => score + (path.includes(token) ? 6 : 0),
    0
  );

  return priorityScore - penalty - path.split("/").filter(Boolean).length;
}

function toCrawledPage(page: {
  url: string;
  title: string;
  text: string;
  description?: string;
}): CrawledPage {
  return {
    url: page.url,
    title: page.title,
    description: page.description,
    text: page.text
  };
}

function buildCombinedCrawlText(pages: CrawledPage[]) {
  const combined = pages
    .map((page, index) =>
      [
        `Page ${index + 1}: ${page.title}`,
        `URL: ${page.url}`,
        page.description ? `Description: ${page.description}` : "",
        page.text
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n---\n\n");

  return combined.slice(0, MAX_COMBINED_TEXT_LENGTH);
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
