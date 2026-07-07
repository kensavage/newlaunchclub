import type {
  MemeConcept,
  PricingTier,
  RedditOpportunity,
  VisibilitySnapshot
} from "@/lib/report/schema";

export function getDefaultPricingTiers(): PricingTier[] {
  return [
    {
      name: "Buyer Visibility Sprint",
      price: "$3,500",
      cadence: "one-time",
      bestFor: "Teams that want a clear 30-day plan before committing to execution.",
      highlighted: false,
      ctaLabel: "Book sprint call",
      features: [
        "40-75 buyer query and AI-search opportunity map",
        "Reddit-safe post and comment angles",
        "Competitor/source gap review",
        "30-day execution roadmap"
      ]
    },
    {
      name: "Reddit + AI Search Engine",
      price: "$7,500",
      cadence: "per month",
      bestFor: "Teams ready to publish, participate, and build citation-worthy source coverage.",
      highlighted: true,
      ctaLabel: "Book growth call",
      features: [
        "Monthly keyword, Reddit, and AI-search monitoring",
        "Reddit-safe content drafts and approval workflow",
        "Comparison, alternatives, and source pages",
        "AI-search citation opportunity reporting"
      ]
    },
    {
      name: "Category Dominance",
      price: "Custom",
      cadence: "quarterly",
      bestFor: "Companies competing in crowded categories that need broader source-building.",
      highlighted: false,
      ctaLabel: "Discuss custom plan",
      features: [
        "Full buyer visibility strategy",
        "Multi-channel source and community execution",
        "Executive reporting and pipeline alignment",
        "Custom creative, meme, and video campaigns"
      ]
    }
  ];
}

export function createVisibilitySnapshot({
  opportunityScore,
  redditOpportunities,
  keywordTraffic
}: {
  opportunityScore: number;
  redditOpportunities: RedditOpportunity[];
  keywordTraffic: number;
}): VisibilitySnapshot {
  const redditSignals = redditOpportunities.filter((opportunity) => opportunity.riskLevel !== "High").length;
  const estimatedMonthlyOpportunityTraffic =
    keywordTraffic > 0
      ? keywordTraffic
      : redditOpportunities.reduce((sum, opportunity) => sum + (opportunity.estimatedMonthlyViews ?? 0), 0);

  return {
    currentAiVisibilityScore: Math.max(8, Math.min(42, Math.round(opportunityScore * 0.36))),
    targetAiVisibilityScore: Math.max(72, Math.min(96, opportunityScore + 10)),
    currentRedditPresenceScore: Math.max(6, Math.min(38, redditSignals * 9 + 8)),
    targetRedditPresenceScore: Math.max(70, Math.min(94, redditSignals * 12 + 58)),
    estimatedMonthlyOpportunityTraffic,
    summary:
      "The current picture is a visibility gap: buyers can find competitor and community sources more easily than the submitted site. Launch Club closes that gap by publishing citable assets and participating where buyers already research."
  };
}

export function createMemeConcepts({
  companyName,
  category,
  primaryKeyword
}: {
  companyName: string;
  category: string;
  primaryKeyword: string;
}): MemeConcept[] {
  return [
    {
      title: "The Buyer Research Loop",
      prompt: `Create a smart B2B meme about a buyer asking ChatGPT, Gemini, Reddit, and Perplexity for ${category} recommendations while ${companyName} is not mentioned yet.`,
      format: "Four-panel research journey",
      whyItWorks:
        "It makes the invisible AI-search problem visual: buyers are asking everywhere, but the brand needs source coverage to show up.",
      provider: "memes.ai"
    },
    {
      title: "Reddit Before Sales Calls",
      prompt: `Create a meme about a founder realizing prospects already searched Reddit for ${primaryKeyword} before booking a demo with ${companyName}.`,
      format: "Reaction meme",
      whyItWorks:
        "It turns a serious buyer-behavior insight into shareable creative that can open a sales conversation.",
      provider: "memes.ai"
    },
    {
      title: "AI Citation Glow-Up",
      prompt: `Create a before-and-after meme showing ${companyName} going from missing in AI answers to being cited after publishing useful comparison and Reddit-friendly content.`,
      format: "Before/after transformation",
      whyItWorks:
        "It previews the transformation the report is selling without promising guaranteed rankings or citations.",
      provider: "memes.ai"
    }
  ];
}
