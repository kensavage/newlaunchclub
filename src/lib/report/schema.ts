import { z } from "zod";

export const evidenceStatusSchema = z.enum([
  "Measured",
  "Estimated",
  "Inferred",
  "Unavailable",
  "Not measured"
]);

export const evidenceReferenceSchema = z.object({
  referenceId: z.string().min(1),
  provider: z.string().min(1),
  sourceUrl: z.string().url().nullable(),
  observationDate: z.string().datetime(),
  description: z.string().min(1)
});

const evidenceMetadataShape = {
  evidenceStatus: evidenceStatusSchema,
  evidenceReferences: z.array(evidenceReferenceSchema),
  observationDate: z.string().datetime().nullable(),
  sourceProvider: z.string().min(1).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  publicExplanation: z.string().min(1)
};

function requireMeasuredEvidence(
  value: {
    evidenceStatus: z.infer<typeof evidenceStatusSchema>;
    evidenceReferences: z.infer<typeof evidenceReferenceSchema>[];
    observationDate: string | null;
    sourceProvider: string | null;
  },
  context: z.RefinementCtx
) {
  if (
    value.evidenceStatus === "Measured" &&
    (!value.evidenceReferences.length || !value.observationDate || !value.sourceProvider)
  ) {
    context.addIssue({
      code: "custom",
      message: "Measured data requires evidence references, an observation date, and a source provider."
    });
  }
}

export const evidenceMetadataSchema = z
  .object(evidenceMetadataShape)
  .superRefine(requireMeasuredEvidence);

export const reportClaimSchema = z
  .object({
    claimId: z.string().min(1),
    claimText: z.string().min(1),
    ...evidenceMetadataShape
  })
  .superRefine(requireMeasuredEvidence);

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
  recommendedAction: z.string(),
  evidence: z.object({
    monthlySearchVolume: evidenceMetadataSchema,
    difficulty: evidenceMetadataSchema,
    trafficPotential: evidenceMetadataSchema,
    intent: evidenceMetadataSchema,
    analysis: evidenceMetadataSchema
  })
});

export const redditOpportunitySchema = z.object({
  title: z.string(),
  subreddit: z.string(),
  url: z.string(),
  estimatedMonthlyViews: z.number().nullable(),
  upvoteCount: z.number().nullable(),
  commentCount: z.number().nullable(),
  engagementSummary: z.string(),
  discussionSummary: z.string(),
  whyLowHangingFruit: z.string(),
  suggestedPostTitle: z.string(),
  suggestedPostBody: z.string(),
  riskLevel: z.enum(["Low", "Medium", "High"]),
  evidence: z.object({
    discussion: evidenceMetadataSchema,
    monthlyViews: evidenceMetadataSchema,
    upvotes: evidenceMetadataSchema,
    comments: evidenceMetadataSchema,
    analysis: evidenceMetadataSchema
  })
});

export const competitorGapSchema = z.object({
  competitor: z.string(),
  source: z.string(),
  url: z.string().nullable(),
  gap: z.string(),
  recommendedAction: z.string(),
  evidence: evidenceMetadataSchema
});

export const aiCitationOpportunitySchema = z.object({
  prompt: z.string(),
  sampleAnswer: z.string(),
  citationAngle: z.string(),
  isSimulation: z.literal(true),
  evidence: evidenceMetadataSchema
});

export const visibilitySnapshotSchema = z.object({
  currentAiVisibilityScore: z.number().min(0).max(100).nullable(),
  targetAiVisibilityScore: z.number().min(0).max(100).nullable(),
  currentRedditPresenceScore: z.number().min(0).max(100).nullable(),
  targetRedditPresenceScore: z.number().min(0).max(100).nullable(),
  estimatedMonthlyOpportunityTraffic: z.number().nullable(),
  summary: z.string(),
  evidence: evidenceMetadataSchema
});

export const memeConceptSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  format: z.string(),
  whyItWorks: z.string(),
  provider: z.string(),
  imageUrl: z.string().nullable()
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
  researchMode: z.enum(["live", "mock"]),
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
  opportunityScoreEvidence: evidenceMetadataSchema,
  headline: z.string(),
  business: businessProfileSchema,
  businessEvidence: evidenceMetadataSchema,
  visibilitySnapshot: visibilitySnapshotSchema,
  keywordOpportunities: z.array(keywordOpportunitySchema).min(1),
  redditOpportunities: z.array(redditOpportunitySchema),
  competitorGaps: z.array(competitorGapSchema),
  aiCitationOpportunities: z.array(aiCitationOpportunitySchema).length(4),
  memeConcepts: z.array(memeConceptSchema).min(2).max(4),
  pricingTiers: z.array(pricingTierSchema).length(3),
  bookingUrl: z.string().min(1),
  nextSteps: z.array(z.string()).min(1),
  evidenceSummary: reportEvidenceSchema,
  claims: z.array(reportClaimSchema).min(1)
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

export const publicReportJobSchema = z.object({
  publicId: z.string(),
  status: reportStatusSchema,
  currentStep: reportStepIdSchema,
  progress: z.number().min(0).max(100),
  steps: z.array(reportStepSchema),
  errorSummary: z.string().nullable()
});

export const publicOpportunityReportSchema = opportunityReportSchema.omit({
  visibilitySnapshot: true,
  memeConcepts: true,
  pricingTiers: true,
  nextSteps: true
});

export const reportResponseSchema = z.object({
  job: publicReportJobSchema,
  report: publicOpportunityReportSchema.nullable()
});

export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export type EvidenceMetadata = z.infer<typeof evidenceMetadataSchema>;
export type ReportClaim = z.infer<typeof reportClaimSchema>;
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
export type PublicReportJob = z.infer<typeof publicReportJobSchema>;
export type PublicOpportunityReport = z.infer<typeof publicOpportunityReportSchema>;
export type ReportResponse = z.infer<typeof reportResponseSchema>;
