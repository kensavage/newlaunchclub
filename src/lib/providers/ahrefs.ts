import { fetchJson } from "@/lib/providers/http";
import type { AhrefsInsights, KeywordMetric } from "@/lib/providers/types";

interface AhrefsKeywordOverview {
  keywords?: Array<{
    keyword: string;
    volume?: number | null;
    difficulty?: number | null;
    traffic_potential?: number | null;
    intents?: Record<string, boolean> | null;
  }>;
}

interface AhrefsMetrics {
  metrics?: {
    org_traffic?: number | null;
  };
}

interface AhrefsTopPages {
  pages?: Array<{
    url: string;
    traffic?: number | null;
    title?: string;
  }>;
}

interface AhrefsCompetitors {
  competitors?: Array<{
    domain: string;
    traffic?: number | null;
  }>;
}

export class AhrefsProvider {
  constructor(private readonly apiKey: string) {}

  async getAhrefsInsights({
    domain,
    normalizedUrl,
    keywords,
    includeKeywordMetrics = true
  }: {
    domain: string;
    normalizedUrl: string;
    keywords: string[];
    includeKeywordMetrics?: boolean;
  }): Promise<AhrefsInsights> {
    const [keywordMetrics, metrics, topPages, competitors] = await Promise.allSettled([
      includeKeywordMetrics ? this.getKeywordMetrics(keywords) : Promise.resolve([]),
      this.getDomainTraffic(normalizedUrl),
      this.getTopPages(domain),
      this.getCompetitors(domain)
    ]);

    return {
      keywordMetrics: keywordMetrics.status === "fulfilled" ? keywordMetrics.value : [],
      domainTraffic: metrics.status === "fulfilled" ? metrics.value : null,
      topPages: topPages.status === "fulfilled" ? topPages.value : [],
      organicCompetitors: competitors.status === "fulfilled" ? competitors.value : []
    };
  }

  async getKeywordMetrics(keywords: string[]): Promise<KeywordMetric[]> {
    if (!keywords.length) return [];

    const url = new URL("https://api.ahrefs.com/v3/keywords-explorer/overview");
    url.searchParams.set("country", "us");
    url.searchParams.set("keywords", keywords.slice(0, 20).join(","));
    url.searchParams.set("select", "keyword,volume,difficulty,traffic_potential,intents");

    const response = await this.get<AhrefsKeywordOverview>(url);
    return (
      response.keywords?.map((keyword) => ({
        keyword: keyword.keyword,
        monthlySearchVolume: keyword.volume ?? null,
        difficulty: keyword.difficulty ?? null,
        trafficPotential: keyword.traffic_potential ?? null,
        intent: keyword.intents ? Object.entries(keyword.intents).find(([, value]) => value)?.[0] ?? null : null
      })) ?? []
    );
  }

  private async getDomainTraffic(target: string): Promise<number | null> {
    const url = new URL("https://api.ahrefs.com/v3/site-explorer/metrics");
    url.searchParams.set("target", target);
    url.searchParams.set("mode", "domain");
    url.searchParams.set("select", "org_traffic");

    const response = await this.get<AhrefsMetrics>(url);
    return response.metrics?.org_traffic ?? null;
  }

  private async getTopPages(domain: string) {
    const url = new URL("https://api.ahrefs.com/v3/site-explorer/top-pages");
    url.searchParams.set("target", domain);
    url.searchParams.set("mode", "domain");
    url.searchParams.set("limit", "5");
    url.searchParams.set("select", "url,traffic,title");

    const response = await this.get<AhrefsTopPages>(url);
    return (
      response.pages?.map((page) => ({
        url: page.url,
        traffic: page.traffic ?? null,
        title: page.title
      })) ?? []
    );
  }

  private async getCompetitors(domain: string) {
    const url = new URL("https://api.ahrefs.com/v3/site-explorer/organic-competitors");
    url.searchParams.set("target", domain);
    url.searchParams.set("mode", "domain");
    url.searchParams.set("limit", "5");
    url.searchParams.set("select", "domain,traffic");

    const response = await this.get<AhrefsCompetitors>(url);
    return (
      response.competitors?.map((competitor) => ({
        name: competitor.domain.replace(/^www\./, ""),
        domain: competitor.domain,
        traffic: competitor.traffic ?? null
      })) ?? []
    );
  }

  private async get<T>(url: URL): Promise<T> {
    return fetchJson<T>(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json"
      },
      timeoutMs: 30_000
    });
  }
}
