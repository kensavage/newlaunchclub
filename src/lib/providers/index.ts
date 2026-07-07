import "server-only";
import { getServerEnv, shouldUseMockProviders, type ServerEnv } from "@/lib/env";
import { AhrefsProvider } from "@/lib/providers/ahrefs";
import { FirecrawlProvider } from "@/lib/providers/firecrawl";
import { MemesProvider } from "@/lib/providers/memes";
import { MockProviderBundle } from "@/lib/providers/mock";
import { OpenAIAnalysisProvider } from "@/lib/providers/openai-analysis";
import type {
  AhrefsInsights,
  BusinessAnalysis,
  CrawlResult,
  KeywordMetric,
  ProviderBundle,
  RedditEvidence,
  ReportSynthesisInput,
  SearchResult
} from "@/lib/providers/types";
import type { MemeConcept } from "@/lib/report/schema";

export function createProviderBundle(env: ServerEnv = getServerEnv()): ProviderBundle {
  if (shouldUseMockProviders(env)) {
    return new MockProviderBundle();
  }

  return new RealProviderBundle(env);
}

class RealProviderBundle implements ProviderBundle {
  private readonly firecrawl: FirecrawlProvider;
  private readonly openai: OpenAIAnalysisProvider;
  private readonly ahrefs: AhrefsProvider;
  private readonly memes: MemesProvider | null;

  constructor(env: ServerEnv) {
    if (!env.OPENAI_API_KEY || !env.FIRECRAWL_API_KEY || !env.AHREFS_API_KEY) {
      throw new Error("Real report providers require OpenAI, Firecrawl, and Ahrefs credentials.");
    }

    this.firecrawl = new FirecrawlProvider(env.FIRECRAWL_API_KEY);
    this.openai = new OpenAIAnalysisProvider(
      env.OPENAI_API_KEY,
      env.OPENAI_MODEL_FAST,
      env.OPENAI_MODEL_SYNTHESIS
    );
    this.ahrefs = new AhrefsProvider(env.AHREFS_API_KEY);
    this.memes =
      env.ENABLE_MEME_IMAGE_GENERATION && env.MEMES_AI_API_URL && env.MEMES_AI_API_KEY
        ? new MemesProvider(env.MEMES_AI_API_URL, env.MEMES_AI_API_KEY)
        : null;
  }

  crawlWebsite(url: string): Promise<CrawlResult> {
    return this.firecrawl.crawlWebsite(url);
  }

  analyzeBusiness(input: { crawl: CrawlResult; url: string; domain: string }): Promise<BusinessAnalysis> {
    return this.openai.analyzeBusiness(input);
  }

  getKeywordMetrics(keywords: string[]): Promise<KeywordMetric[]> {
    return this.ahrefs.getKeywordMetrics(keywords);
  }

  getSearchResults(queries: string[]): Promise<SearchResult[]> {
    return this.firecrawl.getSearchResults(queries);
  }

  getAhrefsInsights(input: {
    domain: string;
    normalizedUrl: string;
    keywords: string[];
  }): Promise<AhrefsInsights> {
    return this.ahrefs.getAhrefsInsights({ ...input, includeKeywordMetrics: false });
  }

  getRedditEvidence(input: { queries: string[]; category: string }): Promise<RedditEvidence[]> {
    return this.firecrawl.getRedditEvidence(input);
  }

  generateMemeImages(input: {
    concepts: MemeConcept[];
    companyName: string;
    category: string;
  }) {
    return this.memes ? this.memes.generateMemeImages(input) : Promise.resolve(input.concepts);
  }

  synthesizeReport(input: ReportSynthesisInput) {
    return this.openai.synthesizeReport(input);
  }
}
