import { z } from "zod";
import {
  ProviderResearchError,
  WEBSITE_RESEARCH_MAX_PAGES,
  type WebsiteResearchProvider
} from "@/lib/research/contracts";
import { canonicalizeSourceUrl, sha256 } from "@/lib/research/integrity";
import { requestProviderJson } from "@/lib/research/provider-http";
import { isPrivateIp } from "@/lib/report/url";

const FIRECRAWL_API_URL = "https://api.firecrawl.dev/v2";
const FIRECRAWL_CACHE_MILLISECONDS = 172_800_000;
const MAX_MARKDOWN_BYTES = 240_000;

const submissionSchema = z.object({
  success: z.boolean().optional(),
  id: z.string().min(1).max(250),
  url: z.string().url().optional()
}).passthrough();

const pageSchema = z.object({
  markdown: z.string().optional(),
  metadata: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    sourceURL: z.string().optional(),
    url: z.string().optional(),
    statusCode: z.number().int().optional(),
    error: z.string().optional()
  }).passthrough().optional()
}).passthrough();

const statusSchema = z.object({
  status: z.enum(["scraping", "completed", "failed", "cancelled"]),
  total: z.number().int().nonnegative().optional(),
  completed: z.number().int().nonnegative().optional(),
  creditsUsed: z.number().nonnegative().optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
  completedAt: z.string().datetime({ offset: true }).optional(),
  next: z.string().url().nullable().optional(),
  data: z.array(pageSchema).optional()
}).passthrough();

export class FirecrawlWebsiteResearchProvider implements WebsiteResearchProvider {
  readonly provider = "firecrawl" as const;

  constructor(
    private readonly apiKey: string,
    private readonly options: {
      fetchImplementation?: typeof fetch;
      now?: () => Date;
      pollIntervalSeconds?: number;
    } = {}
  ) {}

  async submit(input: { url: string; maximumPages: number; maximumDepth: 1 }) {
    const url = assertPublicHttpUrl(input.url);
    const maximumPages = Math.min(WEBSITE_RESEARCH_MAX_PAGES, Math.max(1, input.maximumPages));
    const { value, response } = await requestProviderJson({
      url: `${FIRECRAWL_API_URL}/crawl`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url,
        maxDiscoveryDepth: input.maximumDepth,
        sitemap: "skip",
        ignoreQueryParameters: true,
        limit: maximumPages,
        crawlEntireDomain: true,
        allowExternalLinks: false,
        allowSubdomains: false,
        ignoreRobotsTxt: false,
        scrapeOptions: {
          formats: ["markdown"],
          onlyMainContent: true,
          maxAge: FIRECRAWL_CACHE_MILLISECONDS,
          timeout: 60_000,
          removeBase64Images: true,
          blockAds: true,
          proxy: "basic",
          storeInCache: true
        }
      }),
      timeoutMilliseconds: 30_000,
      phase: "submit",
      fetchImplementation: this.options.fetchImplementation
    });

    const parsed = parseProviderValue(submissionSchema, value, "outcome_uncertain");
    return {
      provider: this.provider,
      jobId: parsed.id,
      state: "submitted" as const,
      httpStatus: response.status,
      providerCreatedAt: null,
      usage: {}
    };
  }

  async poll(input: { jobId: string; expectedUrl: string; maximumPages: number }) {
    if (!/^[A-Za-z0-9_-]{1,250}$/.test(input.jobId)) {
      throw new ProviderResearchError(
        "permanent",
        "provider_job_id_invalid",
        "The stored provider job identifier is invalid.",
        { outcome: "outcome_uncertain" }
      );
    }
    const expectedUrl = assertPublicHttpUrl(input.expectedUrl);
    const { value, response } = await requestProviderJson({
      url: `${FIRECRAWL_API_URL}/crawl/${encodeURIComponent(input.jobId)}`,
      method: "GET",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      timeoutMilliseconds: 30_000,
      phase: "poll",
      fetchImplementation: this.options.fetchImplementation
    });
    let parsed = parseProviderValue(statusSchema, value, "transient_retryable");
    let creditsUsed = parsed.creditsUsed;
    const providerCreatedAt = parsed.createdAt ?? null;
    let providerCompletedAt = parsed.completedAt ?? null;

    if (parsed.status === "scraping") {
      return {
        state: "running" as const,
        httpStatus: response.status,
        retryAfterSeconds: this.options.pollIntervalSeconds ?? 10,
        usage: creditsUsed === undefined ? {} : { creditsUsed }
      };
    }
    if (parsed.status === "cancelled") {
      throw new ProviderResearchError(
        "cancelled",
        "provider_job_cancelled",
        "The website research job was cancelled.",
        { httpStatus: response.status, outcome: "outcome_uncertain" }
      );
    }
    if (parsed.status === "failed") {
      throw new ProviderResearchError(
        "permanent",
        "provider_job_failed",
        "The website research provider could not complete this site.",
        { httpStatus: response.status, outcome: "outcome_uncertain" }
      );
    }

    const maximumPages = Math.min(WEBSITE_RESEARCH_MAX_PAGES, Math.max(1, input.maximumPages));
    const providerPages = [...(parsed.data ?? [])];
    const seenPaginationUrls = new Set<string>();
    for (let page = 0; parsed.next && providerPages.length < maximumPages && page < 20; page += 1) {
      const paginationUrl = assertFirecrawlPaginationUrl(parsed.next, input.jobId);
      if (seenPaginationUrls.has(paginationUrl)) {
        throw new ProviderResearchError(
          "permanent",
          "provider_response_invalid",
          "The website research provider returned an invalid pagination response.",
          { outcome: "outcome_uncertain" }
        );
      }
      seenPaginationUrls.add(paginationUrl);
      const next = await requestProviderJson({
        url: paginationUrl,
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        timeoutMilliseconds: 30_000,
        phase: "poll",
        fetchImplementation: this.options.fetchImplementation
      });
      parsed = parseProviderValue(statusSchema, next.value, "transient_retryable");
      if (parsed.status !== "completed") {
        throw new ProviderResearchError(
          "transient",
          "provider_pagination_pending",
          "Website research pagination is still running.",
          { retryAfterSeconds: this.options.pollIntervalSeconds ?? 10, httpStatus: next.response.status }
        );
      }
      providerPages.push(...(parsed.data ?? []));
      providerCompletedAt = parsed.completedAt ?? providerCompletedAt;
      if (parsed.creditsUsed !== undefined) {
        creditsUsed = Math.max(creditsUsed ?? 0, parsed.creditsUsed);
      }
    }
    if (parsed.next && providerPages.length < maximumPages) {
      throw new ProviderResearchError(
        "transient",
        "provider_pagination_incomplete",
        "Website research pagination will resume on retry.",
        { retryAfterSeconds: this.options.pollIntervalSeconds ?? 10 }
      );
    }

    const usage = creditsUsed === undefined ? {} : { creditsUsed };
    const pages = providerPages
      .slice(0, maximumPages)
      .flatMap((page, pageIndex) => {
        const markdown = truncateUtf8(page.markdown?.trim() ?? "", MAX_MARKDOWN_BYTES);
        const sourceUrl = page.metadata?.sourceURL ?? page.metadata?.url;
        if (!markdown || !sourceUrl || !isSameSite(sourceUrl, expectedUrl)) return [];
        const canonicalUrl = canonicalizeSourceUrl(sourceUrl);
        const crawledAt = this.options.now?.().toISOString() ?? new Date().toISOString();
        return [{
          pageIndex,
          sourceUrl,
          canonicalUrl,
          title: page.metadata?.title?.slice(0, 500) ?? null,
          description: page.metadata?.description?.slice(0, 2_000) ?? null,
          markdown,
          contentHash: sha256(markdown),
          rawArtifact: {
            markdown,
            metadata: {
              title: page.metadata?.title?.slice(0, 500) ?? null,
              description: page.metadata?.description?.slice(0, 2_000) ?? null,
              sourceURL: sourceUrl,
              statusCode: page.metadata?.statusCode ?? null
            }
          },
          providerCreatedAt,
          crawledAt,
          freshUntil: new Date(Date.parse(crawledAt) + FIRECRAWL_CACHE_MILLISECONDS).toISOString()
        }];
      });

    if (!pages.length) {
      throw new ProviderResearchError(
        "permanent",
        "website_content_unavailable",
        "The website research provider did not return readable public pages.",
        { outcome: "outcome_uncertain" }
      );
    }

    return {
      state: "completed" as const,
      httpStatus: response.status,
      providerCompletedAt,
      usage,
      pages
    };
  }
}

function assertFirecrawlPaginationUrl(value: string, jobId: string) {
  const url = new URL(value);
  const api = new URL(FIRECRAWL_API_URL);
  const expectedPath = `${api.pathname}/crawl/${encodeURIComponent(jobId)}`;
  if (url.origin !== api.origin || url.pathname !== expectedPath || url.username || url.password) {
    throw new ProviderResearchError(
      "permanent",
      "provider_response_invalid",
      "The website research provider returned an invalid pagination URL.",
      { outcome: "outcome_uncertain" }
    );
  }
  return url.toString();
}

function parseProviderValue<T>(
  schema: z.ZodType<T>,
  value: unknown,
  outcome: "transient_retryable" | "outcome_uncertain"
) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ProviderResearchError(
      outcome === "transient_retryable" ? "transient" : "configuration_error",
      "provider_response_invalid",
      "The website research provider returned an invalid response.",
      { outcome, retryAfterSeconds: outcome === "transient_retryable" ? 10 : undefined }
    );
  }
  return result.data;
}

function assertPublicHttpUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || isPrivateHostname(url.hostname)) {
    throw new ProviderResearchError(
      "permanent",
      "website_url_not_public",
      "Website research requires a public HTTP or HTTPS URL."
    );
  }
  return url.toString();
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized.endsWith(".local") || normalized.endsWith(".internal") ||
    (!normalized.includes(".") && !normalized.includes(":")) || isPrivateIp(normalized);
}

function isSameSite(candidate: string, expected: string) {
  try {
    return normalizeHost(new URL(candidate).hostname) === normalizeHost(new URL(expected).hostname);
  } catch {
    return false;
  }
}

function normalizeHost(value: string) {
  return value.toLowerCase().replace(/^www\./, "");
}

function truncateUtf8(value: string, maximumBytes: number) {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maximumBytes) return value;
  return bytes.subarray(0, maximumBytes).toString("utf8").replace(/\uFFFD+$/, "");
}
