// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ProviderResearchError } from "@/lib/research/contracts";
import { FirecrawlWebsiteResearchProvider } from "@/lib/research/firecrawl-provider";
import { sha256 } from "@/lib/research/integrity";
import { OpenAIStructuredAnalysisProvider } from "@/lib/research/openai-provider";
import { selectCompanyProfileContext } from "@/lib/research/context-selection";
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

    const evidencePages = syntheticEvidencePages();
    const profileResponse = await provider.createCompanyProfileResponse({
      normalizedUrl: "https://example.com/",
      domain: "example.com",
      pages: selectCompanyProfileContext(evidencePages).pages
    });
    const profileResult = provider.parseCompanyProfileResponse({
      response: profileResponse,
      evidencePages
    });
    expect(profileResult).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-nano",
      providerRequestId: "resp_profile",
      usage: { inputTokens: 120, outputTokens: 48, totalTokens: 168 }
    });
    expect(profileResult.output.entities).toContainEqual(expect.objectContaining({ type: "trust_signal" }));

    const queryResponse = await provider.createSearchQueryResponse({
      profile: syntheticCompanyProfileReadModel(),
      queryCount: 3
    });
    const queryResult = provider.parseSearchQueryResponse({
      response: queryResponse,
      profile: syntheticCompanyProfileReadModel(),
      queryCount: 3
    });
    expect(queryResult.output.queries).toEqual(queries);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const openAiBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(openAiBody).toMatchObject({
      model: "gpt-5.4-nano",
      store: true,
      text: { format: { type: "json_schema" } }
    });
    expect(JSON.stringify(openAiBody.text.format.schema)).not.toContain('"format":"uri"');
    expect(JSON.stringify(openAiBody)).not.toMatch(/chain.of.thought|hidden reasoning/i);
  });

  it("keeps strict URL validation after using an OpenAI-compatible response schema", async () => {
    const profile = syntheticCompanyProfile();
    profile.website = "not-a-url";
    const websiteClaim = profile.claims.find((claim) => claim.fieldKey === "website")!;
    websiteClaim.value = "not-a-url";
    websiteClaim.normalizedValue = "not-a-url";
    const provider = new OpenAIStructuredAnalysisProvider(
      "synthetic-openai-key",
      "gpt-5.4-nano",
      {
        fetchImplementation: vi.fn(async () => openAiResponse(
          profile,
          "resp_invalid_url",
          10,
          10
        ))
      }
    );

    const response = await provider.createCompanyProfileResponse({
      normalizedUrl: "https://example.com/",
      domain: "example.com",
      pages: selectCompanyProfileContext(syntheticEvidencePages()).pages
    });
    expect(() => provider.parseCompanyProfileResponse({
      response,
      evidencePages: syntheticEvidencePages()
    })).toThrow(expect.objectContaining({
      safeCode: "structured_output_schema_invalid",
      providerResponseCaptured: true
    }));
  });

  it("replays captured profiles by canonicalizing duplicate top-level fields from claims", async () => {
    const profile = syntheticCompanyProfile();
    profile.businessModel = "Conflicting top-level business model";
    profile.subindustry = "Conflicting top-level subindustry";
    profile.summary = "Conflicting top-level summary";
    const fetchMock = vi.fn(async () => openAiResponse(
      profile,
      "resp_profile_claim_canonicalization",
      120,
      48
    ));
    const provider = new OpenAIStructuredAnalysisProvider(
      "synthetic-openai-key",
      "gpt-5.4-nano",
      { fetchImplementation: fetchMock }
    );

    const response = await provider.createCompanyProfileResponse({
      normalizedUrl: "https://example.com/",
      domain: "example.com",
      pages: selectCompanyProfileContext(syntheticEvidencePages()).pages
    });
    const result = provider.parseCompanyProfileResponse({
      response,
      evidencePages: syntheticEvidencePages()
    });

    expect(result.output.businessModel).toBe(
      profile.claims.find((claim) => claim.fieldKey === "business_model")?.value
    );
    expect(result.output.subindustry).toBe(
      profile.claims.find((claim) => claim.fieldKey === "subindustry")?.value
    );
    expect(result.output.summary).toBe(
      profile.claims.find((claim) => claim.fieldKey === "profile_summary")?.value
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("checks OpenAI model readiness with the same credential and without inference", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({
      id: "gpt-5.4-nano",
      object: "model",
      created: 1_700_000_000,
      owned_by: "openai"
    }));
    const provider = new OpenAIStructuredAnalysisProvider(
      "synthetic-readiness-key",
      "gpt-5.4-nano",
      { fetchImplementation: fetchMock }
    );

    await expect(provider.checkReadiness()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/models/gpt-5.4-nano");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-readiness-key");
    expect(init?.body).toBeUndefined();
  });

  it.each([
    [401, "provider_authentication_failed"],
    [403, "provider_authentication_failed"],
    [404, "provider_model_unavailable"]
  ] as const)("treats OpenAI readiness HTTP %i as a nonretrying configuration failure", async (status, safeCode) => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({
      error: {
        message: "Synthetic readiness rejection.",
        type: "invalid_request_error",
        code: status === 404 ? "model_not_found" : "invalid_api_key"
      }
    }, status));
    const provider = new OpenAIStructuredAnalysisProvider(
      "synthetic-rejected-key",
      "gpt-5.4-nano",
      { fetchImplementation: fetchMock }
    );

    await expect(provider.checkReadiness()).rejects.toMatchObject({
      classification: "configuration_error",
      safeCode,
      httpStatus: status,
      outcome: "definitively_rejected"
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("rejects OpenAI evidence pointers that cannot be grounded on the cited page", async () => {
    const profile = syntheticCompanyProfile();
    profile.claims[0]!.evidence[0]!.pageIndex = 9;
    const provider = new OpenAIStructuredAnalysisProvider(
      "synthetic-openai-key",
      "gpt-5.4-nano",
      { fetchImplementation: vi.fn(async () => openAiResponse(profile, "resp_bad_evidence", 10, 10)) }
    );
    const response = await provider.createCompanyProfileResponse({
      normalizedUrl: "https://example.com/",
      domain: "example.com",
      pages: selectCompanyProfileContext(syntheticEvidencePages()).pages
    });
    expect(() => provider.parseCompanyProfileResponse({
      response,
      evidencePages: syntheticEvidencePages()
    })).toThrow(expect.objectContaining({
      classification: "permanent",
      safeCode: "structured_evidence_invalid",
      providerResponseCaptured: true
    }));

    const fabricatedClaim = syntheticCompanyProfile();
    fabricatedClaim.companyName = "Fabricated Company";
    fabricatedClaim.claims[0] = {
      ...fabricatedClaim.claims[0]!,
      value: "Fabricated Company",
      normalizedValue: "fabricated company",
      evidence: [{ pageIndex: 0, excerpt: "This sentence is not present in the stored page." }]
    };
    const fabricatedProvider = new OpenAIStructuredAnalysisProvider(
      "synthetic-openai-key",
      "gpt-5.4-nano",
      { fetchImplementation: vi.fn(async () => openAiResponse(
        fabricatedClaim,
        "resp_bad_excerpt",
        10,
        10
      )) }
    );
    const fabricatedResponse = await fabricatedProvider.createCompanyProfileResponse({
      normalizedUrl: "https://example.com/",
      domain: "example.com",
      pages: selectCompanyProfileContext(syntheticEvidencePages()).pages
    });
    expect(() => fabricatedProvider.parseCompanyProfileResponse({
      response: fabricatedResponse,
      evidencePages: syntheticEvidencePages()
    })).toThrow(expect.objectContaining({ safeCode: "structured_evidence_invalid" }));
  });

  it("grounds captured evidence without accepting paraphrases", async () => {
    const pages = syntheticEvidencePages();
    pages[0] = {
      ...pages[0]!,
      markdown: `${pages[0]!.markdown}\n\nBuyer research is the core service.`
    };
    const profile = syntheticCompanyProfile();
    profile.claims[0] = {
      ...profile.claims[0]!,
      evidence: [{ pageIndex: 0, excerpt: "A paraphrased company-name citation." }]
    };
    profile.claims[6] = {
      ...profile.claims[6]!,
      evidence: [
        ...profile.claims[6]!.evidence.map((pointer) => ({ ...pointer })),
        { pageIndex: 0, excerpt: "A second pointer that is not present in the page." }
      ]
    };
    profile.entities[0] = {
      ...profile.entities[0]!,
      evidence: [{ pageIndex: 0, excerpt: "A paraphrased service citation." }]
    };
    const provider = new OpenAIStructuredAnalysisProvider(
      "synthetic-openai-key",
      "gpt-5.4-nano",
      { fetchImplementation: vi.fn(async () => openAiResponse(
        profile,
        "resp_grounded_evidence",
        10,
        10
      )) }
    );
    const response = await provider.createCompanyProfileResponse({
      normalizedUrl: "https://example.com/",
      domain: "example.com",
      pages: selectCompanyProfileContext(pages).pages
    });
    const result = provider.parseCompanyProfileResponse({
      response,
      evidencePages: pages
    });

    expect(result.output.claims[0]?.evidence).toEqual([
      { pageIndex: 0, excerpt: "Example Labs" }
    ]);
    expect(result.output.claims[6]?.evidence).toHaveLength(1);
    expect(result.output.entities[0]?.evidence).toEqual([
      { pageIndex: 0, excerpt: "Buyer research" }
    ]);
  });

  it("accepts evidence that differs only by Unicode and whitespace normalization", async () => {
    const pages = syntheticEvidencePages();
    pages[0] = {
      ...pages[0]!,
      markdown: pages[0]!.markdown.replace("research for", "research\nfor")
    };
    const profile = syntheticCompanyProfile();
    const provider = new OpenAIStructuredAnalysisProvider(
      "synthetic-openai-key",
      "gpt-5.4-nano",
      { fetchImplementation: vi.fn(async () => openAiResponse(
        profile,
        "resp_normalized_evidence",
        10,
        10
      )) }
    );
    const response = await provider.createCompanyProfileResponse({
      normalizedUrl: "https://example.com/",
      domain: "example.com",
      pages: selectCompanyProfileContext(pages).pages
    });

    const result = provider.parseCompanyProfileResponse({
      response,
      evidencePages: pages
    });

    expect(result.output.claims[0]?.evidence).toEqual([{
      pageIndex: 0,
      excerpt: "Example Labs provides buyer research\nfor B2B growth teams."
    }]);
  });

  it("persists the exact source substring after NFKC evidence normalization", async () => {
    const pages = syntheticEvidencePages();
    const fullwidthName = "\uFF25\uFF58\uFF41\uFF4D\uFF50\uFF4C\uFF45 \uFF2C\uFF41\uFF42\uFF53";
    pages[0] = {
      ...pages[0]!,
      markdown: pages[0]!.markdown.replace("Example Labs", fullwidthName)
    };
    const profile = syntheticCompanyProfile();
    const provider = new OpenAIStructuredAnalysisProvider(
      "synthetic-openai-key",
      "gpt-5.4-nano",
      { fetchImplementation: vi.fn(async () => openAiResponse(
        profile,
        "resp_nfkc_evidence",
        10,
        10
      )) }
    );
    const response = await provider.createCompanyProfileResponse({
      normalizedUrl: "https://example.com/",
      domain: "example.com",
      pages: selectCompanyProfileContext(pages).pages
    });
    const result = provider.parseCompanyProfileResponse({
      response,
      evidencePages: pages
    });

    expect(result.output.claims[0]?.evidence).toEqual([{
      pageIndex: 0,
      excerpt: `${fullwidthName} provides buyer research for B2B growth teams.`
    }]);
  });

  it.each([
    {
      name: "completed response with no output",
      response: openAiEnvelope({ id: "resp_missing_output", output: [] }),
      safeCode: "structured_output_missing",
      phase: "response_validation"
    },
    {
      name: "incomplete response at the output-token limit",
      response: openAiEnvelope({
        id: "resp_token_limit",
        status: "incomplete",
        incompleteReason: "max_output_tokens",
        content: [{ type: "output_text", annotations: [], logprobs: [], text: "{}" }]
      }),
      safeCode: "provider_output_incomplete",
      phase: "response_validation"
    },
    {
      name: "content-filtered response",
      response: openAiEnvelope({
        id: "resp_content_filter",
        status: "incomplete",
        incompleteReason: "content_filter",
        content: []
      }),
      safeCode: "provider_content_filtered",
      phase: "response_validation"
    },
    {
      name: "provider refusal",
      response: openAiEnvelope({
        id: "resp_refusal",
        content: [{ type: "refusal", refusal: "Synthetic refusal." }]
      }),
      safeCode: "provider_response_refused",
      phase: "response_validation"
    },
    {
      name: "invalid structured JSON",
      response: openAiEnvelope({
        id: "resp_invalid_json",
        content: [{ type: "output_text", annotations: [], logprobs: [], text: "{" }]
      }),
      safeCode: "structured_output_invalid_json",
      phase: "parse"
    }
  ])("captures then classifies $name without losing provider success", async ({ response, safeCode, phase }) => {
    const provider = new OpenAIStructuredAnalysisProvider(
      "synthetic-openai-key",
      "gpt-5.4-nano",
      { fetchImplementation: vi.fn(async () => response) }
    );

    const artifact = await provider.createCompanyProfileResponse({
      normalizedUrl: "https://example.com/",
      domain: "example.com",
      pages: selectCompanyProfileContext(syntheticEvidencePages()).pages
    });
    expect(artifact.providerResponseId).toMatch(/^resp_/);
    expect(() => provider.parseCompanyProfileResponse({
      response: artifact,
      evidencePages: syntheticEvidencePages()
    })).toThrow(expect.objectContaining({
      safeCode,
      providerResponseCaptured: true,
      processingPhase: phase
    }));
  });

  it("retrieves an exact stored OpenAI Response and classifies retrieval failure without reinference", async () => {
    const profile = syntheticCompanyProfile();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/responses/resp_recoverable")) {
        return openAiResponse(profile, "resp_recoverable", 90, 30);
      }
      return jsonResponse({
        error: { message: "Synthetic missing response.", type: "invalid_request_error" }
      }, 404);
    });
    const provider = new OpenAIStructuredAnalysisProvider(
      "synthetic-openai-key",
      "gpt-5.4-nano",
      { fetchImplementation: fetchMock }
    );

    const recovered = await provider.retrieveResponse({
      providerResponseId: "resp_recoverable",
      promptTemplateVersion: "company-profile-v2",
      schemaVersion: "company-profile-schema-v2"
    });
    expect(recovered).toMatchObject({
      providerResponseId: "resp_recoverable",
      responseStatus: "completed",
      artifactComplete: true,
      usage: { inputTokens: 90, outputTokens: 30, totalTokens: 120 }
    });
    expect(provider.parseCompanyProfileResponse({
      response: recovered,
      evidencePages: syntheticEvidencePages()
    }).output.companyName).toBe("Example Labs");

    await expect(provider.retrieveResponse({
      providerResponseId: "resp_missing",
      promptTemplateVersion: "company-profile-v2",
      schemaVersion: "company-profile-schema-v2"
    })).rejects.toMatchObject({
      safeCode: "provider_response_retrieval_failed",
      providerResponseCaptured: true,
      processingPhase: "retrieval"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([input]) => String(input).includes("/v1/responses/"))).toBe(true);
  });

  it("treats a malformed successful OpenAI response as an uncertain paid outcome", async () => {
    const provider = new OpenAIStructuredAnalysisProvider(
      "synthetic-openai-key",
      "gpt-5.4-nano",
      {
        fetchImplementation: vi.fn<typeof fetch>(async () => new Response("not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }))
      }
    );

    await expect(provider.createCompanyProfileResponse({
      normalizedUrl: "https://example.com/",
      domain: "example.com",
      pages: selectCompanyProfileContext(syntheticEvidencePages()).pages
    })).rejects.toMatchObject({
      safeCode: "structured_analysis_failed",
      outcome: "outcome_uncertain",
      outcomeUncertain: true
    });
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

  it("distinguishes a rejected submission from an uncertain post-acceptance poll", async () => {
    for (const phase of ["submit", "poll"] as const) {
      const error = await requestProviderJson({
        url: "https://provider.example/test",
        method: phase === "submit" ? "POST" : "GET",
        headers: {},
        timeoutMilliseconds: 50,
        phase,
        fetchImplementation: vi.fn<typeof fetch>(async () => jsonResponse({
          error: "Synthetic authentication rejection."
        }, 401))
      }).catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        classification: "configuration_error",
        safeCode: "provider_authentication_failed",
        outcome: phase === "submit" ? "definitively_rejected" : "outcome_uncertain"
      });
    }
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
  return openAiEnvelope({
    id,
    content: [{
      type: "output_text",
      annotations: [],
      logprobs: [],
      text: JSON.stringify(output)
    }],
    inputTokens,
    outputTokens
  });
}

function openAiEnvelope(options: {
  id: string;
  status?: "completed" | "incomplete";
  incompleteReason?: "max_output_tokens" | "content_filter";
  output?: unknown[];
  content?: unknown[];
  inputTokens?: number;
  outputTokens?: number;
}) {
  const inputTokens = options.inputTokens ?? 10;
  const outputTokens = options.outputTokens ?? 10;
  return jsonResponse({
    id: options.id,
    object: "response",
    created_at: Date.parse(SYNTHETIC_RESEARCH_TIME) / 1_000,
    status: options.status ?? "completed",
    error: null,
    incomplete_details: options.incompleteReason ? { reason: options.incompleteReason } : null,
    model: "gpt-5.4-nano",
    output: options.output ?? [{
      id: `${options.id}_message`,
      type: "message",
      status: options.status ?? "completed",
      role: "assistant",
      content: options.content ?? []
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
