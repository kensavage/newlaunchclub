import { fetchJson } from "@/lib/providers/http";
import type { KeywordMetric, SearchResult } from "@/lib/providers/types";

interface DataForSeoTask<T> {
  result?: T[];
}

interface DataForSeoResponse<T> {
  tasks?: Array<DataForSeoTask<T>>;
}

interface SearchVolumeResult {
  keyword: string;
  search_volume?: number | null;
  competition_index?: number | null;
  cpc?: number | null;
}

interface SerpResult {
  keyword?: string;
  items?: Array<{
    type?: string;
    rank_group?: number;
    title?: string;
    url?: string;
    domain?: string;
    description?: string;
  }>;
}

export class DataForSeoProvider {
  private readonly authHeader: string;

  constructor(login: string, password: string) {
    this.authHeader = `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
  }

  async getKeywordMetrics(keywords: string[]): Promise<KeywordMetric[]> {
    if (!keywords.length) return [];

    const response = await fetchJson<DataForSeoResponse<SearchVolumeResult>>(
      "https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live",
      {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json"
        },
        body: JSON.stringify([
          {
            location_code: 2840,
            language_code: "en",
            keywords: keywords.slice(0, 20)
          }
        ]),
        timeoutMs: 30_000
      }
    );

    return (
      response.tasks?.flatMap((task) => task.result ?? []).map((item) => ({
        keyword: item.keyword,
        monthlySearchVolume: item.search_volume ?? null,
        difficulty: item.competition_index ?? null,
        trafficPotential: null,
        intent: null
      })) ?? []
    );
  }

  async getSearchResults(queries: string[]): Promise<SearchResult[]> {
    if (!queries.length) return [];

    const response = await fetchJson<DataForSeoResponse<SerpResult>>(
      "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
      {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(
          queries.slice(0, 10).map((keyword) => ({
            keyword,
            location_code: 2840,
            language_code: "en",
            depth: 10
          }))
        ),
        timeoutMs: 45_000
      }
    );

    return (
      response.tasks?.flatMap((task) =>
        (task.result ?? []).flatMap((result) =>
          (result.items ?? [])
            .filter((item) => item.type === "organic")
            .slice(0, 5)
            .map((item, index) => ({
              query: result.keyword ?? "",
              title: item.title ?? "Untitled result",
              url: item.url ?? "",
              domain: item.domain ?? safeDomain(item.url),
              snippet: item.description ?? "",
              position: item.rank_group ?? index + 1,
              isReddit: Boolean(item.domain?.includes("reddit.com") || item.url?.includes("reddit.com"))
            }))
        )
      ) ?? []
    );
  }
}

function safeDomain(url?: string) {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
