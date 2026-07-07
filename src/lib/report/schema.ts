import { z } from "zod";

export const reportStatusSchema = z.enum(["queued", "running", "complete", "failed"]);
export const reportStepIdSchema = z.enum([
  "queued",
  "crawl",
  "analysis",
  "keywords",
  "reddit",
  "ai-search",
  "synthesis",
  "complete",
  "failed"
]);

export const stepStatusSchema = z.enum(["pending", "running", "complete", "failed"]);

export const reportStepSchema = z.object({
  id: reportStepIdSchema,
  label: z.string(),
  status: stepStatusSchema,
  detail: z.string().optional()
});

export const businessProfileSchema = z.object({
  companyName: z.string(),
  website: z.string(),
  category: z.string(),
  primaryKeyword: z.string(),
  summary: z.string()
});

export const keywordOpportunitySchema = z.object({
  keyword: z.string(),
  intent: z.string(),
  monthlySearchVolume: z.number().nullable(),
  difficulty: z.number().nullable(),
  trafficPotential: z.number().nullable(),
  sourceVisibility: z.string(),
  redditFit: z.enum(["High", "Medium", "Low"]),
  priority: z.enum(["High", "Medium", "Low"]),
  recommendedAction: z.string()
});

export const redditOpportunitySchema = z.object({
  title: z.string(),
  subreddit: z.string(),
  url: z.string(),
  estimatedMonthlyViews: z.number().nullable(),
  upvoteCount: z.number(),
  commentCount: z.number(),
  engagementSummary: z.string(),
  discussionSummary: z.string(),
  whyLowHangingFruit: z.string(),
  suggestedPostTitle: z.string(),
  suggestedPostBody: z.string(),
  riskLevel: z.enum(["Low", "Medium", "High"])
});

export const competitorGapSchema = z.object({
  competitor: z.string(),
  source: z.string(),
  url: z.string().optional(),
  gap: z.string(),
  recommendedAction: z.string()
});

export const aiCitationOpportunitySchema = z.object({
  prompt: z.string(),
  sampleAnswer: z.string(),
  citationAngle: z.string(),
  isSimulation: z.boolean()
});

export const visibilitySnapshotSchema = z.object({
  currentAiVisibilityScore: z.number().min(0).max(100),
  targetAiVisibilityScore: z.number().min(0).max(100),
  currentRedditPresenceScore: z.number().min(0).max(100),
  targetRedditPresenceScore: z.number().min(0).max(100),
  estimatedMonthlyOpportunityTraffic: z.number().nullable(),
  summary: z.string()
});

export const memeConceptSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  format: z.string(),
  whyItWorks: z.string(),
  provider: z.string(),
  imageUrl: z.string().url().optional()
});

export const pricingTierSchema = z.object({
  name: z.string(),
  price: z.string(),
  cadence: z.string(),
  bestFor: z.string(),
  features: z.array(z.string()).min(3),
  highlighted: z.boolean(),
  ctaLabel: z.string()
});

export const reportEvidenceSchema = z.object({
  crawlSummary: z.string(),
  keywordSource: z.string(),
  redditSource: z.string(),
  aiSearchSource: z.string(),
  generatedWithRealAiChecks: z.boolean()
});

export const opportunityReportSchema = z.object({
  publicId: z.string(),
  generatedAt: z.string(),
  submittedUrl: z.string(),
  domain: z.string(),
  opportunityScore: z.number().min(0).max(100),
  headline: z.string(),
  business: businessProfileSchema,
  visibilitySnapshot: visibilitySnapshotSchema,
  keywordOpportunities: z.array(keywordOpportunitySchema).min(1),
  redditOpportunities: z.array(redditOpportunitySchema),
  competitorGaps: z.array(competitorGapSchema),
  aiCitationOpportunities: z.array(aiCitationOpportunitySchema).length(4),
  memeConcepts: z.array(memeConceptSchema).min(2).max(4),
  pricingTiers: z.array(pricingTierSchema).length(3),
  bookingUrl: z.string().min(1),
  nextSteps: z.array(z.string()).min(1),
  evidenceSummary: reportEvidenceSchema
});

export const reportJobSchema = z.object({
  publicId: z.string(),
  submittedUrl: z.string(),
  normalizedUrl: z.string(),
  domain: z.string(),
  status: reportStatusSchema,
  currentStep: reportStepIdSchema,
  progress: z.number().min(0).max(100),
  steps: z.array(reportStepSchema),
  errorSummary: z.string().nullable(),
  visitorHash: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string()
});

export const reportResponseSchema = z.object({
  job: reportJobSchema,
  report: opportunityReportSchema.nullable()
});

export type ReportStatus = z.infer<typeof reportStatusSchema>;
export type ReportStepId = z.infer<typeof reportStepIdSchema>;
export type StepStatus = z.infer<typeof stepStatusSchema>;
export type ReportStep = z.infer<typeof reportStepSchema>;
export type BusinessProfile = z.infer<typeof businessProfileSchema>;
export type KeywordOpportunity = z.infer<typeof keywordOpportunitySchema>;
export type RedditOpportunity = z.infer<typeof redditOpportunitySchema>;
export type CompetitorGap = z.infer<typeof competitorGapSchema>;
export type AiCitationOpportunity = z.infer<typeof aiCitationOpportunitySchema>;
export type VisibilitySnapshot = z.infer<typeof visibilitySnapshotSchema>;
export type MemeConcept = z.infer<typeof memeConceptSchema>;
export type PricingTier = z.infer<typeof pricingTierSchema>;
export type OpportunityReport = z.infer<typeof opportunityReportSchema>;
export type ReportJob = z.infer<typeof reportJobSchema>;
export type ReportResponse = z.infer<typeof reportResponseSchema>;
