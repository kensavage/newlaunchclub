import { fetchJson } from "@/lib/providers/http";
import type { RedditEvidence } from "@/lib/providers/types";

interface RedditTokenResponse {
  access_token: string;
  expires_in: number;
}

interface RedditSearchResponse {
  data?: {
    children?: Array<{
      data?: {
        title?: string;
        subreddit_name_prefixed?: string;
        permalink?: string;
        score?: number;
        num_comments?: number;
        selftext?: string;
      };
    }>;
  };
}

export class RedditProvider {
  private token: { accessToken: string; expiresAt: number } | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly userAgent: string
  ) {}

  async getRedditEvidence({ queries }: { queries: string[] }): Promise<RedditEvidence[]> {
    const token = await this.getAccessToken();
    const results: RedditEvidence[] = [];

    for (const query of queries.slice(0, 5)) {
      const url = new URL("https://oauth.reddit.com/search");
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "5");
      url.searchParams.set("sort", "relevance");
      url.searchParams.set("type", "link");
      url.searchParams.set("sr_detail", "true");

      const response = await fetchJson<RedditSearchResponse>(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": this.userAgent
        },
        timeoutMs: 20_000
      });

      for (const child of response.data?.children ?? []) {
        const data = child.data;
        if (!data?.title || !data.permalink) continue;

        results.push({
          title: data.title,
          subreddit: data.subreddit_name_prefixed ?? "r/unknown",
          url: `https://www.reddit.com${data.permalink}`,
          score: data.score ?? null,
          comments: data.num_comments ?? null,
          summary: summarizeRedditText(data.selftext)
        });
      }
    }

    return dedupeByUrl(results).slice(0, 8);
  }

  private async getAccessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.accessToken;
    }

    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const response = await fetchJson<RedditTokenResponse>("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.userAgent
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
      timeoutMs: 20_000
    });

    this.token = {
      accessToken: response.access_token,
      expiresAt: Date.now() + response.expires_in * 1000
    };

    return this.token.accessToken;
  }
}

function summarizeRedditText(text?: string) {
  const cleaned = (text ?? "").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 240) : "Reddit thread matched the generated buyer-intent query.";
}

function dedupeByUrl(items: RedditEvidence[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}
