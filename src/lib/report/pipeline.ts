import "server-only";
import { getServerEnv } from "@/lib/env";
import { createProviderBundle } from "@/lib/providers";
import type {
  AhrefsInsights,
  CrawlResult,
  KeywordMetric,
  ProviderBundle,
  RedditEvidence,
  SearchResult
} from "@/lib/providers/types";
import type { OpportunityReport, ReportJob, ReportStepId } from "@/lib/report/schema";
import { normalizeOpportunityReportForResponse } from "@/lib/report/normalize-report";
import { stepsForCurrentStep, progressForStep } from "@/lib/report/steps";
import { getReportStore } from "@/lib/report/store-factory";
import {
  getStepDetail,
  sanitizeError,
  type ReportStore,
  type VendorEventInput
} from "@/lib/report/store";

export interface RunReportJobOptions {
  store?: ReportStore;
  providers?: ProviderBundle;
}

export async function runReportJob(publicId: string, options: RunReportJobOptions = {}) {
  const env = getServerEnv();
  const store = options.store ?? getReportStore();
  const providers = options.providers ?? createProviderBundle(env);
  const job = await store.getJob(publicId);

  if (!job) {
    throw new Error("Report job was not found.");
  }

  if (job.status === "complete") {
    return job;
  }

  try {
    await setStep(store, job.publicId, "crawl");
    const crawl = await track(store, job, {
      provider: "Firecrawl",
      endpoint: "scrape homepage + linked pages",
      purpose: "Scrape submitted homepage and one level of same-domain linked pages",
      run: () => providers.crawlWebsite(job.normalizedUrl)
    });

    await setStep(store, job.publicId, "analysis");
    const analysis = await track(store, job, {
      provider: "OpenAI",
      endpoint: "responses.parse",
      purpose: "Extract business profile, keywords, and buyer queries",
      run: () => providers.analyzeBusiness({ crawl, url: job.normalizedUrl, domain: job.domain })
    });

    await setStep(store, job.publicId, "keywords");
    const redditPromise = track(store, job, {
      provider: "Firecrawl",
      endpoint: "search site:reddit.com",
      purpose: "Find relevant public Reddit post and subreddit evidence",
      run: () =>
        providers.getRedditEvidence({
          queries: analysis.redditQueries,
          category: analysis.business.category
        })
    });
    const marketResearchPromise = Promise.all([
      track(store, job, {
        provider: "Ahrefs",
        endpoint: "keywords-explorer/overview",
        purpose: "Retrieve keyword search volumes and traffic potential",
        run: () => providers.getKeywordMetrics(analysis.keywords)
      }),
      track(store, job, {
        provider: "Firecrawl",
        endpoint: "search",
        purpose: "Retrieve web and Reddit SERP surfaces for buyer queries",
        run: () => providers.getSearchResults(analysis.buyerQueries)
      }),
      track(store, job, {
        provider: "Ahrefs",
        endpoint: "site-explorer + keywords-explorer",
        purpose: "Retrieve domain, keyword, top page, and competitor estimates",
        run: () =>
          providers.getAhrefsInsights({
            domain: job.domain,
            normalizedUrl: job.normalizedUrl,
            keywords: analysis.keywords
          })
      })
    ]);
    const [[ahrefsKeywordMetrics, searchResults, ahrefs], reddit] = await Promise.all([
      marketResearchPromise,
      redditPromise
    ]);
    const keywordMetrics = mergeKeywordMetrics(analysis.keywords, ahrefsKeywordMetrics, ahrefs);

    await setStep(store, job.publicId, "reddit");
    await setStep(store, job.publicId, "ai-search");
    await store.recordVendorEvent({
      publicId: job.publicId,
      provider: "OpenAI",
      endpoint: "simulation",
      purpose:
        "Generate planning simulations while live AI-platform visibility remains not measured",
      status: "skipped",
      durationMs: 0
    });

    await setStep(store, job.publicId, "synthesis");
    const report = await track(store, job, {
      provider: "OpenAI",
      endpoint: "responses.parse",
      purpose: "Synthesize visitor-safe opportunity report",
      run: () =>
        providers.synthesizeReport({
          publicId: job.publicId,
          submittedUrl: job.submittedUrl,
          normalizedUrl: job.normalizedUrl,
          domain: job.domain,
          crawl,
          analysis,
          keywordMetrics,
          searchResults,
          ahrefs,
          reddit,
          enableRealAiChecks: false
        })
    });

    const reportWithMemes =
      env.ENABLE_MEME_IMAGE_GENERATION && providers.generateMemeImages
        ? {
            ...report,
            memeConcepts: await track(store, job, {
              provider: "Memes.ai",
              endpoint: "configured meme generation endpoint",
              purpose: "Generate meme image URLs for report creative concepts",
              run: () =>
                providers.generateMemeImages?.({
                  concepts: report.memeConcepts,
                  companyName: report.business.companyName,
                  category: report.business.category
                }) ?? Promise.resolve(report.memeConcepts)
            })
          }
        : report;

    const safeReport = normalizeReport(reportWithMemes, job, {
      crawl,
      bookingUrl: env.NEXT_PUBLIC_BOOK_CALL_URL
    });
    await store.saveReport(job.publicId, safeReport);
    return setComplete(store, job.publicId);
  } catch (error) {
    await setFailed(store, job.publicId, sanitizeError(error));
    throw error;
  }
}

async function setStep(store: ReportStore, publicId: string, step: ReportStepId) {
  return store.updateJob(publicId, {
    status: "running",
    currentStep: step,
    progress: progressForStep(step),
    errorSummary: null,
    steps: stepsForCurrentStep(step, "running", getStepDetail(step))
  });
}

async function setComplete(store: ReportStore, publicId: string) {
  return store.updateJob(publicId, {
    status: "complete",
    currentStep: "complete",
    progress: 100,
    errorSummary: null,
    steps: stepsForCurrentStep("synthesis", "complete")
  });
}

async function setFailed(store: ReportStore, publicId: string, errorSummary: string) {
  return store.updateJob(publicId, {
    status: "failed",
    currentStep: "failed",
    progress: 100,
    errorSummary,
    steps: stepsForCurrentStep("failed", "failed", errorSummary)
  });
}

async function track<T>(
  store: ReportStore,
  job: ReportJob,
  {
    provider,
    endpoint,
    purpose,
    run
  }: {
    provider: string;
    endpoint: string;
    purpose: string;
    run: () => Promise<T>;
  }
): Promise<T> {
  const startedAt = Date.now();
  const eventBase: Omit<VendorEventInput, "status" | "durationMs"> = {
    publicId: job.publicId,
    provider,
    endpoint,
    purpose
  };

  try {
    const value = await run();
    await store.recordVendorEvent({
      ...eventBase,
      status: "success",
      durationMs: Date.now() - startedAt
    });
    return value;
  } catch (error) {
    await store.recordVendorEvent({
      ...eventBase,
      status: "error",
      durationMs: Date.now() - startedAt,
      errorSummary: sanitizeError(error)
    });
    throw error;
  }
}

function mergeKeywordMetrics(
  keywords: string[],
  primaryKeywordMetrics: KeywordMetric[],
  ahrefs: AhrefsInsights
) {
  const byKeyword = new Map<string, KeywordMetric>();

  for (const keyword of keywords.slice(0, 20)) {
    byKeyword.set(keyword.toLowerCase(), {
      keyword,
      monthlySearchVolume: null,
      difficulty: null,
      trafficPotential: null,
      intent: null
    });
  }

  for (const metric of [...primaryKeywordMetrics, ...ahrefs.keywordMetrics]) {
    const existing = byKeyword.get(metric.keyword.toLowerCase());

    byKeyword.set(metric.keyword.toLowerCase(), {
      keyword: existing?.keyword ?? metric.keyword,
      monthlySearchVolume: existing?.monthlySearchVolume ?? metric.monthlySearchVolume,
      difficulty: metric.difficulty ?? existing?.difficulty ?? null,
      trafficPotential: metric.trafficPotential ?? existing?.trafficPotential ?? null,
      intent: metric.intent ?? existing?.intent ?? null
    });
  }

  return Array.from(byKeyword.values());
}

function normalizeReport(
  report: OpportunityReport,
  job: ReportJob,
  {
    crawl,
    bookingUrl
  }: {
    crawl: CrawlResult;
    bookingUrl: string;
  }
) {
  return normalizeOpportunityReportForResponse({
    report: {
      ...report,
      publicId: job.publicId,
      submittedUrl: job.submittedUrl,
      domain: job.domain,
      generatedAt: report.generatedAt || new Date().toISOString(),
      evidenceSummary: {
        ...report.evidenceSummary,
        crawlSummary: createCrawlSummary(crawl)
      }
    },
    bookingUrl
  });
}

function createCrawlSummary(crawl: CrawlResult) {
  const linkedCount = Math.max(0, crawl.pages.length - 1);
  const pageList = crawl.pages
    .slice(0, 7)
    .map((page) => page.url)
    .join(", ");

  return `Crawled homepage + ${linkedCount} linked internal page${linkedCount === 1 ? "" : "s"}: ${pageList}.`;
}

export function summarizeSearchResults(searchResults: SearchResult[]) {
  return searchResults
    .slice(0, 10)
    .map((result) => `${result.query}: ${result.title}`)
    .join("\n");
}

export function summarizeRedditEvidence(reddit: RedditEvidence[]) {
  return reddit
    .slice(0, 5)
    .map((evidence) => `${evidence.subreddit}: ${evidence.title}`)
    .join("\n");
}
