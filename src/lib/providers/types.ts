import type {
  BusinessProfile,
  MemeConcept,
  OpportunityReport
} from "@/lib/report/schema";

export interface CrawlResult {
  url: string;
  title: string;
  text: string;
  description?: string;
  pages: CrawledPage[];
}

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
  description?: string;
}

export interface BusinessAnalysis {
  business: BusinessProfile;
  keywords: string[];
  primaryKeyword: string;
  buyerQueries: string[];
  redditQueries: string[];
  competitors: string[];
  summary: string;
}

export interface KeywordMetric {
  keyword: string;
  monthlySearchVolume: number | null;
  difficulty: number | null;
  trafficPotential: number | null;
  intent: string | null;
}

export interface SearchResult {
  query: string;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  position: number;
  isReddit: boolean;
}

export interface AhrefsInsights {
  domainTraffic: number | null;
  topPages: Array<{ url: string; traffic: number | null; title?: string }>;
  organicCompetitors: Array<{ name: string; domain: string; traffic: number | null }>;
  keywordMetrics: KeywordMetric[];
}

export interface RedditEvidence {
  title: string;
  subreddit: string;
  url: string;
  score: number | null;
  comments: number | null;
  summary: string;
}

export interface ReportSynthesisInput {
  publicId: string;
  submittedUrl: string;
  normalizedUrl: string;
  domain: string;
  crawl: CrawlResult;
  analysis: BusinessAnalysis;
  keywordMetrics: KeywordMetric[];
  searchResults: SearchResult[];
  ahrefs: AhrefsInsights;
  reddit: RedditEvidence[];
  enableRealAiChecks: boolean;
}

export interface ProviderBundle {
  crawlWebsite(url: string): Promise<CrawlResult>;
  analyzeBusiness(input: { crawl: CrawlResult; url: string; domain: string }): Promise<BusinessAnalysis>;
  getKeywordMetrics(keywords: string[]): Promise<KeywordMetric[]>;
  getSearchResults(queries: string[]): Promise<SearchResult[]>;
  getAhrefsInsights(input: {
    domain: string;
    normalizedUrl: string;
    keywords: string[];
  }): Promise<AhrefsInsights>;
  getRedditEvidence(input: {
    queries: string[];
    category: string;
  }): Promise<RedditEvidence[]>;
  generateMemeImages?(input: {
    concepts: MemeConcept[];
    companyName: string;
    category: string;
  }): Promise<MemeConcept[]>;
  synthesizeReport(input: ReportSynthesisInput): Promise<OpportunityReport>;
}
