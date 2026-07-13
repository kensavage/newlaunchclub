// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ProviderResearchError } from "@/lib/research/contracts";
import { FirecrawlWebsiteResearchProvider } from "@/lib/research/firecrawl-provider";
import { sha256 } from "@/lib/research/integrity";
import { OpenAIStructuredAnalysisProvider } from "@/lib/research/openai-provider";
import { requestProviderJson } from "@/lib/research/provider-http";
import {
  SYNTHETIC_RESEARCH_TIME,
  syntheticCompanyProfile,
  syntheticCompanyProfileReadModel,
  syntheticEvidencePages,
  syntheticQueries
} from "./fixtures/provider-research";

describe("PR4 provider adapters with mocked HTTP", () => {
  it("submits a bounded one-level Firecrawl job and maps same-site page evidence", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, id: "crawl_job_123" }, 200))
      .mockResolvedValueOnce(jsonResponse({
        status: "completed",
        creditsUsed: 3,
        createdAt: SYNTHETIC_RESEARCH_TIME,
        completedAt: "2026-01-15T12:00:12.000Z",
        data: [
          {
            markdown: "Home page evidence",
            metadata: {
              title: "Example Labs",
              description: "Buyer research",
              sourceURL: "https://example.com/",
              statusCode: 200
            }
          },
          {
            markdown: "Service page evidence",
            metadata: { sourceURL: "https://example.com/services", statusCode: 200 }
          },
          {
            markdown: "External evidence must not be stored",
            metadata: { sourceURL: "https://other.example/services", statusCode: 200 }
          }
        ]
      }, 200));
    const provider = new FirecrawlWebsiteResearchProvider("synthetic-firecrawl-key", {
      fetchImplementation: fetchMock,
      now: () => new Date(SYNTHETIC_RESEARCH_TIME)
    });

    const submission = await provider.submit({
      url: "https://example.com/",
      maximumPages: 7,
      maximumDepth: 1
    });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody).toMatchObject({
      url: "https://example.com/",
      maxDiscoveryDepth: 1,
      sitemap: "skip",
      limit: 7,
      allowExternalLinks: false,
      allowSubdomains: false,
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true }
    });
    expect(submission.jobId).toBe("crawl_job_123");

    const result = await provider.poll({
      jobId: submission.jobId,
      expectedUrl: "https://example.com/",
      maximumPages: 7
    });
    expect(result.state).toBe("completed");
    if (result.state !== "completed") throw new Error("Expected completed Firecrawl fixture.");
    expect(result.usage).toEqual({ creditsUsed: 3 });
    expect(result.pages.map((page) => page.canonicalUrl)).toEqual([
      "https://example.com/",
      "https://example.com/services"
    ]);
    expect(result.pages[0]).toMatchObject({
      contentHash: sha256("Home page evidence"),
      crawledAt: SYNTHETIC_RESEARCH_TIME
    });
    expect(JSON.stringify(result.pages)).not.toContain("External evidence");
  });

  it("respects Firecrawl polling and Retry-After without treating either as completion", async () => {
    const pollingFetch = vi.fn(async () => jsonResponse({ status: "scraping", creditsUsed: 1 }, 200));
    const pollingProvider = new FirecrawlWebsiteResearchProvider("synthetic-key", {
      fetchImplementation: pollingFetch,
      pollIntervalSeconds: 23
    });
    await expect(pollingProvider.poll({
      jobId: "crawl_job_123",
      expectedUrl: "https://example.com/",
      maximumPages: 7
    })).resolves.toEqual({
      state: "running",
      httpStatus: 200,
      retryAfterSeconds: 23,
      usage: { creditsUsed: 1 }
    });

    const limitedProvider = new FirecrawlWebsiteResearchProvider("synthetic-key", {
      fetchImplementation: vi.fn(async () => jsonResponse(
        { error: "rate limited" },
        429,
        { "Retry-After": "17" }
      ))
    });
    const error = await limitedProvider.submit({
      url: "https://example.com/",
      maximumPages: 7,
      maximumDepth: 1
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ProviderResearchError);
    expect(error).toMatchObject({
      classification: "transient",
      safeCode: "provider_rate_limited",
      retryAfterSeconds: 17,
      outcomeUncertain: false
    });
  });

  it("follows bounded Firecrawl result pagination without forwarding credentials off-origin", async () => {
    const nextUrl = "https://api.firecrawl.dev/v2/crawl/crawl_job_123?skip=1";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        status: "completed",
        creditsUsed: 2,
        createdAt: SYNTHETIC_RESEARCH_TIME,
        next: nextUrl,
        data: [{ markdown: "First page", metadata: { sourceURL: "https://example.com/" } }]
      }))
      .mockResolvedValueOnce(jsonResponse({
        status: "completed",
        creditsUsed: 2,
        completedAt: "2026-01-15T12:00:10.000Z",
        next: null,
        data: [{ markdown: "Second page", metadata: { sourceURL: "https://example.com/about" } }]
      }));
    const provider = new FirecrawlWebsiteResearchProvider("synthetic-key", {
      fetchImplementation: fetchMock,
      now: () => new Date(SYNTHETIC_RESEARCH_TIME)
    });
    const result = await provider.poll({
      jobId: "crawl_job_123",
      expectedUrl: "https://example.com/",
      maximumPages: 2
    });
    expect(result.state).toBe("completed");
    if (result.state !== "completed") throw new Error("Expected completed paginated fixture.");
    expect(result.pages.map((page) => page.markdown)).toEqual(["First page", "Second page"]);
    expect(result.providerCompletedAt).toBe("2026-01-15T12:00:10.000Z");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(nextUrl);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ Authorization: "Bearer synthetic-key" });

    const maliciousFetch = vi.fn(async () => jsonResponse({
      status: "completed",
      next: "https://attacker.example/steal-token",
      data: [{ markdown: "First page", metadata: { sourceURL: "https://example.com/" } }]
    }));
    const malicious = new FirecrawlWebsiteResearchProvider("must-not-leak", {
      fetchImplementation: maliciousFetch
    });
    await expect(malicious.poll({
      jobId: "crawl_job_123",
      expectedUrl: "https://example.com/",
      maximumPages: 2
    })).rejects.toMatchObject({ safeCode: "provider_response_invalid" });
    expect(maliciousFetch).toHaveBeenCalledOnce();
  });

  it("rejects private targets and malformed Firecrawl responses before evidence storage", async () => {
    const fetchMock = vi.fn();
    const provider = new FirecrawlWebsiteResearchProvider("synthetic-key", {
      fetchImplementation: fetchMock
    });
    for (const url of [
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "https://intranet/"
    ]) {
      await expect(provider.submit({ url, maximumPages: 7, maximumDepth: 1 })).rejects.toMatchObject({
        safeCode: "website_url_not_public"
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();

    const malformed = new FirecrawlWebsiteResearchProvider("synthetic-key", {
      fetchImplementation: vi.fn(async () => jsonResponse({ success: true }, 200))
    });
    await expect(malformed.submit({
      url: "https://example.com/",
      maximumPages: 7,
      maximumDepth: 1
    })).rejects.toMatchObject({ safeCode: "provider_response_invalid" });
  });

  it("validates OpenAI Responses structured output and records model usage", async () => {
    const profile = syntheticCompanyProfile();
    const queries = syntheticQueries();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(openAiResponse(profile, "resp_profile", 120, 48))
      .mockResolvedValueOnce(openAiResponse({ queries }, "resp_queries", 80, 32));
    const provider = new OpenAIStructuredAnalysisProvider(
      "synthetic-openai-key",
      "gpt-5.4-nano",
      { fetchImplementation: fetchMock }
    );

    const profileResult = await provider.extractCompanyProfile({
      normalizedUrl: "https://example.com/",
      domain: "example.com",
      pages: syntheticEvidencePages()
    });
    expect(profileResult).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-nano",
      providerRequestId: "resp_profile",
      usage: { inputTokens: 120, outputTokens: 48, totalTokens: 168 }
    });
    expect(profileResult.output.entities).toContainEqual(expect.objectContaining({ type: "trust_signal" }));

    const queryResult = await provider.discoverSearchQueries({
      profile: syntheticCompanyProfileReadModel(),
      queryCount: 3
    });
    expect(queryResult.output.queries).toEqual(queries);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const openAiBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(openAiBody).toMatchObject({
      model: "gpt-5.4-nano",
      store: false,
      text: { format: { type: "json_schema" } }
    });
    expect(JSON.stringify(openAiBody)).not.toMatch(/chain.of.thought|hidden reasoning/i);
  });

  it("rejects OpenAI evidence pointers that do not identify stored pages", async () => {
    const profile = syntheticCompanyProfile();
    profile.claims[0]!.evidence[0]!.pageIndex = 9;
    const provider = new OpenAIStructuredAnalysisProvider(
      "synthetic-openai-key",
      "gpt-5.4-nano",
      { fetchImplementation: vi.fn(async () => openAiResponse(profile, "resp_bad_evidence", 10, 10)) }
    );
    await expect(provider.extractCompanyProfile({
      normalizedUrl: "https://example.com/",
      domain: "example.com",
      pages: syntheticEvidencePages()
    })).rejects.toMatchObject({
      classification: "permanent",
      safeCode: "structured_evidence_invalid"
    });

    const fabricatedExcerpt = syntheticCompanyProfile();
    fabricatedExcerpt.claims[0]!.evidence[0]!.excerpt = "This sentence is not present in the stored page.";
    const fabricatedProvider = new OpenAIStructuredAnalysisProvider(
      "synthetic-openai-key",
      "gpt-5.4-nano",
      { fetchImplementation: vi.fn(async () => openAiResponse(
        fabricatedExcerpt,
        "resp_bad_excerpt",
        10,
        10
      )) }
    );
    await expect(fabricatedProvider.extractCompanyProfile({
      normalizedUrl: "https://example.com/",
      domain: "example.com",
      pages: syntheticEvidencePages()
    })).rejects.toMatchObject({ safeCode: "structured_evidence_invalid" });
  });

  it("marks submit timeouts as uncertain and poll timeouts as safely retryable", async () => {
    const hangingFetch = vi.fn((_input: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      })) as typeof fetch;

    for (const phase of ["submit", "poll"] as const) {
      const error = await requestProviderJson({
        url: "https://provider.example/test",
        method: phase === "submit" ? "POST" : "GET",
        headers: {},
        timeoutMilliseconds: 5,
        phase,
        fetchImplementation: hangingFetch
      }).catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        classification: "transient",
        safeCode: "provider_timeout",
        outcomeUncertain: phase === "submit"
      });
    }

    const unavailable = await requestProviderJson({
      url: "https://provider.example/test",
      method: "GET",
      headers: {},
      timeoutMilliseconds: 50,
      phase: "poll",
      fetchImplementation: vi.fn(async () => new Response("temporary upstream failure", {
        status: 503,
        headers: { "Content-Type": "text/plain" }
      }))
    }).catch((failure: unknown) => failure);
    expect(unavailable).toMatchObject({
      classification: "transient",
      safeCode: "provider_temporarily_unavailable",
      httpStatus: 503
    });
  });
});

function jsonResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {}
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

function openAiResponse(output: unknown, id: string, inputTokens: number, outputTokens: number) {
  return jsonResponse({
    id,
    object: "response",
    created_at: Date.parse(SYNTHETIC_RESEARCH_TIME) / 1_000,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: "gpt-5.4-nano",
    output: [{
      id: `${id}_message`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        annotations: [],
        logprobs: [],
        text: JSON.stringify(output)
      }]
    }],
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: inputTokens + outputTokens
    }
  });
}
