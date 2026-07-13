"use client";

import { ArrowUpRight, Bot, Calendar, Mail, Send, X } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import type {
  EvidenceMetadata,
  EvidenceStatus,
  PublicOpportunityReport,
  RedditOpportunity
} from "@/lib/report/schema";

const evidenceLegend: Array<{ status: EvidenceStatus; description: string }> = [
  { status: "Measured", description: "Returned by a named research provider with evidence." },
  { status: "Estimated", description: "Calculated with a stated, defensible method." },
  { status: "Inferred", description: "Analysis based on the available evidence." },
  { status: "Unavailable", description: "Requested, but the provider did not return enough data." },
  { status: "Not measured", description: "This report did not run a supported measurement." }
];

export function ReportDocument({ report }: { report: PublicOpportunityReport }) {
  const [selectedCommentIndex, setSelectedCommentIndex] = useState<number | null>(null);
  const topKeywords = useMemo(
    () =>
      [...report.keywordOpportunities]
        .sort((a, b) => {
          if (a.monthlySearchVolume === null) return 1;
          if (b.monthlySearchVolume === null) return -1;
          return b.monthlySearchVolume - a.monthlySearchVolume;
        })
        .slice(0, 25),
    [report.keywordOpportunities]
  );
  const topRedditPosts = report.redditOpportunities.slice(0, 3);
  const measuredKeywords = topKeywords.filter(
    (keyword) =>
      keyword.monthlySearchVolume !== null &&
      keyword.evidence.monthlySearchVolume.evidenceStatus === "Measured"
  );
  const measuredKeywordVolume = measuredKeywords.reduce(
    (sum, keyword) => sum + (keyword.monthlySearchVolume ?? 0),
    0
  );
  const selectedComment =
    selectedCommentIndex === null ? null : topRedditPosts[selectedCommentIndex];

  return (
    <article className="opportunity-report">
      <section className="opportunity-hero">
        <div>
          <p className="report-kicker">{report.business.companyName}</p>
          <h1>{report.domain} - Your AI Search & Reddit Opportunity Report</h1>
          <p>{report.headline}</p>
          <EvidenceBadge evidence={report.businessEvidence} />
        </div>
        <div className="hero-stat">
          <span>
            {report.opportunityScoreEvidence.evidenceStatus === "Not measured"
              ? "N/A"
              : report.opportunityScore}
          </span>
          <strong>Opportunity score</strong>
          <EvidenceBadge evidence={report.opportunityScoreEvidence} />
        </div>
      </section>

      <section className="evidence-contract" aria-labelledby="evidence-contract-title">
        <div>
          <p className="report-kicker">Evidence key</p>
          <h2 id="evidence-contract-title">How to read this report</h2>
        </div>
        <div className="evidence-legend">
          {evidenceLegend.map((item) => (
            <div key={item.status}>
              <EvidenceBadge evidence={legendEvidence(item.status, item.description)} />
              <p>{item.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="report-section" id="report-claims">
        <SectionHeader
          eyebrow="Evidence"
          title="What This Report Can Substantiate"
          copy="Each material conclusion carries its research classification and available source evidence."
        />
        <div className="report-claim-list">
          {report.claims.map((claim) => (
            <article className="report-claim" key={claim.claimId}>
              <div>
                <p>{claim.claimText}</p>
                <small>{claim.publicExplanation}</small>
              </div>
              <EvidenceBadge evidence={claim} />
              <EvidenceSourceLinks evidence={claim} />
            </article>
          ))}
        </div>
      </section>

      <section className="report-section" id="keyword-goldmine">
        <SectionHeader
          eyebrow="1"
          title="Your Hidden Keyword Goldmine"
          copy="Keywords extracted from the website. Search volume appears only when Ahrefs returned verified data."
        />
        <div className="keyword-table">
          <div className="keyword-table-head">
            <span>Keyword</span>
            <span>Monthly search volume</span>
            <span>Evidence</span>
          </div>
          {topKeywords.map((keyword) => (
            <div className="keyword-row" key={keyword.keyword}>
              <strong>{keyword.keyword}</strong>
              <span>
                {keyword.monthlySearchVolume === null
                  ? "Unavailable"
                  : keyword.monthlySearchVolume.toLocaleString()}
              </span>
              <EvidenceBadge evidence={keyword.evidence.monthlySearchVolume} />
            </div>
          ))}
        </div>
      </section>

      <section className="report-section" id="reddit-conversations">
        <SectionHeader
          eyebrow="2"
          title="The Reddit Conversations You're Missing"
          copy="Public discussions found during research. Engagement and traffic appear only when a provider returned them."
        />
        {topRedditPosts.length ? (
          <div className="reddit-card-grid">
            {topRedditPosts.map((post) => (
              <RedditPostCard key={`${post.subreddit}-${post.title}`} post={post} />
            ))}
          </div>
        ) : (
          <UnavailableState copy="No relevant public Reddit discussions were returned for this report." />
        )}
      </section>

      <section className="report-section traffic-section" id="measured-opportunity">
        <SectionHeader
          eyebrow="3"
          title="What the Research Measured"
          copy="Known values are separated from data the current providers could not verify."
        />
        <div className="traffic-grid">
          <TrafficStat
            label="Measured keyword demand"
            value={measuredKeywords.length ? measuredKeywordVolume.toLocaleString() : "Unavailable"}
            detail={
              measuredKeywords.length
                ? `Sum of ${measuredKeywords.length} keyword volume${measuredKeywords.length === 1 ? "" : "s"} returned by Ahrefs.`
                : "Ahrefs did not return sufficient verified monthly volume data."
            }
            evidence={
              measuredKeywords.length
                ? {
                    evidenceStatus: "Inferred" as const,
                    evidenceReferences: measuredKeywords.flatMap(
                      (keyword) => keyword.evidence.monthlySearchVolume.evidenceReferences
                    ),
                    observationDate: report.generatedAt,
                    sourceProvider: "Launch Club calculation",
                    confidence: null,
                    publicExplanation:
                      "This total is calculated from measured keyword volumes in the table."
                  }
                : keywordUnavailableEvidence()
            }
          />
          <TrafficStat
            label="Reddit monthly traffic"
            value="Not measured"
            detail="The current provider did not return verified post traffic or view data."
            evidence={notMeasuredEvidence("Verified Reddit traffic was not measured.")}
          />
          <TrafficStat
            label="Live AI visibility"
            value="Not measured"
            detail="No supported live ChatGPT, Gemini, or Perplexity visibility check ran."
            evidence={notMeasuredEvidence("Live AI-platform visibility was not measured.")}
          />
        </div>
      </section>

      <section className="report-section" id="competitors">
        <SectionHeader
          eyebrow="4"
          title="Where Competitors Have Source Coverage"
          copy="Evidence-backed competitor observations without invented mention totals, activity ratings, or ninety-day projections."
        />
        {report.competitorGaps.length ? (
          <div className="competitor-board">
            {report.competitorGaps.slice(0, 5).map((competitor) => (
              <article className="competitor-evidence-row" key={`${competitor.source}-${competitor.competitor}`}>
                <div>
                  <strong>{competitor.competitor}</strong>
                  <span>{competitor.source}</span>
                </div>
                <p>{competitor.gap}</p>
                <EvidenceBadge evidence={competitor.evidence} />
                {competitor.url ? (
                  <a href={competitor.url} rel="noreferrer" target="_blank">
                    Source
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </a>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <UnavailableState copy="The providers did not return sufficient competitor evidence for a public comparison." />
        )}
      </section>

      <section className="report-section ai-simulations" id="ai-simulations">
        <SectionHeader
          eyebrow="5"
          title="AI Search Opportunity Simulations"
          copy="These examples show questions the business could target. They are not live citations or platform checks."
        />
        <div className="ai-opportunity-grid">
          {report.aiCitationOpportunities.map((opportunity) => (
            <article className="ai-opportunity-card" key={opportunity.prompt}>
              <div>
                <Bot size={20} aria-hidden="true" />
                <EvidenceBadge evidence={opportunity.evidence} />
              </div>
              <h3>{opportunity.prompt}</h3>
              <p>{opportunity.sampleAnswer}</p>
              <small>{opportunity.citationAngle}</small>
            </article>
          ))}
        </div>
      </section>

      <section className="report-section" id="comment-scripts">
        <SectionHeader
          eyebrow="6"
          title="Your Ready-to-Review Comment Scripts"
          copy="Draft comments inferred from the public discussion summaries. A person should review every comment before posting."
        />
        {topRedditPosts.length ? (
          <div className="comment-grid">
            {topRedditPosts.map((post, index) => (
              <article className="comment-card" key={`${post.title}-comment`}>
                <span>{post.subreddit}</span>
                <EvidenceBadge evidence={post.evidence.analysis} />
                <h3>{post.title}</h3>
                <p>{post.suggestedPostBody}</p>
                <button
                  className="button primary"
                  onClick={() => setSelectedCommentIndex(index)}
                  type="button"
                >
                  Post This Comment
                  <Send size={18} aria-hidden="true" />
                </button>
              </article>
            ))}
          </div>
        ) : (
          <UnavailableState copy="A comment draft was not created because no supported Reddit discussion was found." />
        )}
      </section>

      <section className="final-proof-cta">
        <div>
          <p className="report-kicker">Next step</p>
          <h2>Review the Opportunity With Launch Club</h2>
          <p>
            Bring the evidence, unavailable data, and recommended actions into a strategy call to
            decide what is worth pursuing.
          </p>
        </div>
        <a className="button secondary" href={report.bookingUrl}>
          Book a Call to Discuss Full Service
          <Calendar size={18} aria-hidden="true" />
        </a>
      </section>

      <footer className="report-footer">
        <p>{report.evidenceSummary.aiSearchSource}</p>
        <p>
          Generated {new Date(report.generatedAt).toLocaleDateString()}. This report does not
          guarantee rankings, citations, traffic, placements, or revenue.
        </p>
      </footer>

      {selectedComment ? (
        <PostCommentModal
          domain={report.domain}
          post={selectedComment}
          submittedUrl={report.submittedUrl}
          onClose={() => setSelectedCommentIndex(null)}
        />
      ) : null}
    </article>
  );
}

function SectionHeader({
  eyebrow,
  title,
  copy
}: {
  eyebrow: string;
  title: string;
  copy: string;
}) {
  return (
    <div className="report-section-header">
      <span>{eyebrow}</span>
      <div>
        <h2>{title}</h2>
        <p>{copy}</p>
      </div>
    </div>
  );
}

function EvidenceBadge({ evidence }: { evidence: EvidenceMetadata }) {
  return (
    <span
      className={`evidence-badge evidence-${statusClass(evidence.evidenceStatus)}`}
      title={evidence.publicExplanation}
    >
      {evidence.evidenceStatus}
    </span>
  );
}

function EvidenceSourceLinks({ evidence }: { evidence: EvidenceMetadata }) {
  const links = evidence.evidenceReferences.filter((reference) => reference.sourceUrl).slice(0, 2);

  if (!links.length) return null;

  return (
    <div className="evidence-source-links">
      {links.map((reference) => (
        <a href={reference.sourceUrl ?? "#"} key={reference.referenceId} rel="noreferrer" target="_blank">
          Source
          <ArrowUpRight size={13} aria-hidden="true" />
        </a>
      ))}
    </div>
  );
}

function RedditPostCard({ post }: { post: RedditOpportunity }) {
  return (
    <article className="reddit-post-card">
      <div className="reddit-post-top">
        <span>{post.subreddit}</span>
        <a href={post.url} rel="noreferrer" target="_blank">
          View
          <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </div>
      <h3>{post.title}</h3>
      <EvidenceBadge evidence={post.evidence.discussion} />
      <div className="reddit-metrics">
        <MetricMini label="Monthly traffic" value={post.estimatedMonthlyViews} evidence={post.evidence.monthlyViews} />
        <MetricMini label="Upvotes" value={post.upvoteCount} evidence={post.evidence.upvotes} />
        <MetricMini label="Comments" value={post.commentCount} evidence={post.evidence.comments} />
      </div>
    </article>
  );
}

function TrafficStat({
  label,
  value,
  detail,
  evidence
}: {
  label: string;
  value: string;
  detail: string;
  evidence: EvidenceMetadata;
}) {
  return (
    <article className="traffic-stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <EvidenceBadge evidence={evidence} />
      <p>{detail}</p>
    </article>
  );
}

function MetricMini({
  label,
  value,
  evidence
}: {
  label: string;
  value: number | null;
  evidence: EvidenceMetadata;
}) {
  return (
    <div>
      <strong>{value === null ? evidence.evidenceStatus : value.toLocaleString()}</strong>
      <span>{label}</span>
    </div>
  );
}

function UnavailableState({ copy }: { copy: string }) {
  return (
    <div className="report-unavailable">
      <EvidenceBadge evidence={keywordUnavailableEvidence()} />
      <p>{copy}</p>
    </div>
  );
}

function PostCommentModal({
  domain,
  post,
  submittedUrl,
  onClose
}: {
  domain: string;
  post: RedditOpportunity;
  submittedUrl: string;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const subject = encodeURIComponent(`Comment review request for ${domain}`);
    const body = encodeURIComponent(
      [
        `Website: ${submittedUrl}`,
        `Email: ${email}`,
        `Reddit opportunity: ${post.title}`,
        `Source: ${post.url}`,
        "",
        "Draft comment:",
        post.suggestedPostBody
      ].join("\n")
    );
    window.location.href = `mailto:hello@launchclub.ai?subject=${subject}&body=${body}`;
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div aria-modal="true" className="report-modal" role="dialog">
        <button aria-label="Close modal" className="modal-close" onClick={onClose} type="button">
          <X size={18} aria-hidden="true" />
        </button>
        <div className="modal-heading">
          <Send size={24} aria-hidden="true" />
          <div>
            <h2>Review This Comment</h2>
            <p>One request per website</p>
          </div>
        </div>
        <form className="prove-it-form" onSubmit={onSubmit}>
          <label>
            Domain / URL
            <input readOnly value={submittedUrl || domain} />
          </label>
          <label>
            Email
            <input
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@company.com"
              required
              type="email"
              value={email}
            />
          </label>
          <p>
            We will review the discussion and draft, then email you with next steps. Nothing is
            posted automatically.
          </p>
          <button className="button primary" type="submit">
            Request comment review
            <Mail size={18} aria-hidden="true" />
          </button>
        </form>
      </div>
    </div>
  );
}

function legendEvidence(status: EvidenceStatus, explanation: string): EvidenceMetadata {
  return {
    evidenceStatus: status,
    evidenceReferences:
      status === "Measured"
        ? [
            {
              referenceId: "legend:measured",
              provider: "Example provider",
              sourceUrl: null,
              observationDate: new Date(0).toISOString(),
              description: "Legend example"
            }
          ]
        : [],
    observationDate: status === "Measured" ? new Date(0).toISOString() : null,
    sourceProvider: status === "Measured" ? "Example provider" : null,
    confidence: null,
    publicExplanation: explanation
  };
}

function keywordUnavailableEvidence(): EvidenceMetadata {
  return {
    evidenceStatus: "Unavailable",
    evidenceReferences: [],
    observationDate: null,
    sourceProvider: "Ahrefs",
    confidence: null,
    publicExplanation: "The provider did not return sufficient verified data."
  };
}

function notMeasuredEvidence(explanation: string): EvidenceMetadata {
  return {
    evidenceStatus: "Not measured",
    evidenceReferences: [],
    observationDate: null,
    sourceProvider: null,
    confidence: null,
    publicExplanation: explanation
  };
}

function statusClass(status: EvidenceStatus) {
  return status.toLowerCase().replace(" ", "-");
}
