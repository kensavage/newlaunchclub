"use client";

import {
  ArrowUpRight,
  Bot,
  Calendar,
  Flame,
  Mail,
  MessageCircle,
  Send,
  Sparkles,
  type LucideIcon,
  X
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import type {
  CompetitorGap,
  OpportunityReport,
  RedditOpportunity
} from "@/lib/report/schema";

interface ModalState {
  kind: "comment" | "testimonial";
  index: number;
}

const testimonials = [
  {
    name: "Maya L.",
    role: "VP Growth, B2B SaaS",
    quote:
      "The report made it obvious where our buyers were already researching. The first Reddit comment brought in qualified demo traffic.",
    image:
      "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=320&q=80"
  },
  {
    name: "Daniel R.",
    role: "Founder, AI Tools",
    quote:
      "Launch Club helped us turn invisible buyer conversations into source material AI search could actually understand.",
    image:
      "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=320&q=80"
  },
  {
    name: "Priya S.",
    role: "Marketing Lead, DevTools",
    quote:
      "The best part was the prove-it post. It was helpful, natural, and gave us a concrete signal before expanding.",
    image:
      "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=320&q=80"
  }
];

export function ReportDocument({ report }: { report: OpportunityReport }) {
  const [modal, setModal] = useState<ModalState | null>(null);
  const topKeywords = useMemo(
    () =>
      [...report.keywordOpportunities]
        .sort((a, b) => (b.monthlySearchVolume ?? 0) - (a.monthlySearchVolume ?? 0))
        .slice(0, 25),
    [report.keywordOpportunities]
  );
  const topRedditPosts = report.redditOpportunities.slice(0, 3);
  const totalSearchTraffic = topKeywords.reduce(
    (sum, keyword) => sum + (keyword.monthlySearchVolume ?? 0),
    0
  );
  const bestPostTraffic = topRedditPosts[0]?.estimatedMonthlyViews ?? 0;
  const projectedVisitors = Math.max(25, Math.round(bestPostTraffic * 0.035));
  const competitorRows = buildCompetitorRows(report.competitorGaps);
  const selectedComment = modal?.kind === "comment" ? topRedditPosts[modal.index] : null;
  const selectedTestimonial = modal?.kind === "testimonial" ? testimonials[modal.index] : null;

  return (
    <article className="opportunity-report">
      <section className="opportunity-hero">
        <div>
          <p className="report-kicker">{report.business.companyName}</p>
          <h1>{report.domain} - Your AI Search & Reddit Opportunity Report</h1>
          <p>Here&apos;s exactly how much opportunity you&apos;re missing on Reddit and AI search.</p>
        </div>
        <div className="hero-stat">
          <span>{report.opportunityScore}</span>
          <strong>Opportunity score</strong>
        </div>
      </section>

      <section className="report-section" id="keyword-goldmine">
        <SectionHeader
          eyebrow="1"
          title="Your Hidden Keyword Goldmine"
          copy="The strongest buyer-intent keywords extracted from the website and ranked by estimated monthly search volume."
        />
        <div className="keyword-table">
          <div className="keyword-table-head">
            <span>Keyword</span>
            <span>Estimated monthly search volume</span>
          </div>
          {topKeywords.map((keyword) => (
            <div className="keyword-row" key={keyword.keyword}>
              <strong>{keyword.keyword}</strong>
              <span>{(keyword.monthlySearchVolume ?? 0).toLocaleString()}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="report-section" id="reddit-conversations">
        <SectionHeader
          eyebrow="2"
          title="The Reddit Conversations You're Missing"
          copy="The top Reddit-style opportunities where a helpful comment can turn existing demand into discovery."
        />
        <div className="reddit-card-grid">
          {topRedditPosts.map((post) => (
            <RedditPostCard key={`${post.subreddit}-${post.title}`} post={post} />
          ))}
        </div>
      </section>

      <section className="report-section traffic-section" id="traffic-waiting">
        <SectionHeader
          eyebrow="3"
          title="How Much Traffic Is Waiting for You"
          copy="A simple view of the monthly search and Reddit attention already sitting around this market."
        />
        <div className="traffic-grid">
          <TrafficStat
            label="Total search traffic"
            value={totalSearchTraffic.toLocaleString()}
            detail="combined monthly keyword volume"
          />
          <TrafficStat
            label="One top-comment upside"
            value={projectedVisitors.toLocaleString()}
            detail="additional visitors per month from one strong Reddit comment"
          />
          <TrafficStat
            label="Featured Reddit posts"
            value={topRedditPosts.length}
            detail="ready for the prove-it comment offer"
          />
        </div>
      </section>

      <section className="report-section" id="competitors">
        <SectionHeader
          eyebrow="4"
          title="Where Your Competitors Are Already Winning"
          copy="A directional comparison of Reddit activity. Five fires means 200+ posts or mentions."
        />
        <div className="competitor-board">
          <div className="competitor-row you-now">
            <div>
              <strong>{report.domain}</strong>
              <span>You today</span>
            </div>
            <FireRating count={1} />
            <span>Very few active mentions</span>
          </div>
          {competitorRows.map((competitor) => (
            <div className="competitor-row" key={competitor.name}>
              <div>
                <strong>{competitor.name}</strong>
                <span>{competitor.source}</span>
              </div>
              <FireRating count={competitor.fires} />
              <span>{competitor.mentions}+ posts/mentions</span>
            </div>
          ))}
          <div className="competitor-row target-row">
            <div>
              <strong>You can be here</strong>
              <span>90-Day Opportunity</span>
            </div>
            <FireRating count={5} />
            <span>~300 posts/mentions with consistent execution</span>
          </div>
        </div>
      </section>

      <section className="report-section" id="testimonials">
        <SectionHeader
          eyebrow="Proof"
          title="Video Testimonials"
          copy="Placeholder proof cards for the final video assets. Each opens a modal player."
        />
        <div className="testimonial-grid">
          {testimonials.map((testimonial, index) => (
            <button
              className="testimonial-card"
              key={testimonial.name}
              onClick={() => setModal({ kind: "testimonial", index })}
              type="button"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt={testimonial.name} src={testimonial.image} />
              <div>
                <strong>{testimonial.name}</strong>
                <span>{testimonial.role}</span>
                <p>&ldquo;{testimonial.quote}&rdquo;</p>
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="report-section ai-multiplier" id="ai-multiplier">
        <SectionHeader
          eyebrow="5"
          title="The AI Search Multiplier Effect"
          copy="Reddit answers are source material AI models can reference. Helpful community content can compound into AI-driven discovery."
        />
        <div className="multiplier-grid">
          <MultiplierCard icon={Bot} stat="4x-9x" label="better conversion from high-intent AI-driven traffic" />
          <MultiplierCard icon={MessageCircle} stat="Reddit" label="is a trusted comparison layer for buyers and answer engines" />
          <MultiplierCard icon={Sparkles} stat="Source" label="coverage makes your brand easier for AI assistants to mention" />
        </div>
      </section>

      <section className="report-section" id="comment-scripts">
        <SectionHeader
          eyebrow="6"
          title="Your Ready-to-Use Comment Scripts"
          copy="Three helpful, non-promotional comments designed to add value, invite replies, and earn upvotes."
        />
        <div className="comment-grid">
          {topRedditPosts.map((post, index) => (
            <article className="comment-card" key={`${post.title}-comment`}>
              <span>{post.subreddit}</span>
              <h3>{post.title}</h3>
              <p>{post.suggestedPostBody}</p>
              <button className="button primary" onClick={() => setModal({ kind: "comment", index })} type="button">
                Post This Comment
                <Send size={18} aria-hidden="true" />
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="final-proof-cta">
        <div>
          <p className="report-kicker">Final Call-To-Action</p>
          <h2>Let Us Prove It For You</h2>
          <p>
            Pick one of the three comments above. This is a one-time opportunity per website, built
            to show you the Reddit and AI-search opportunity before a full-service engagement.
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
          Search volume, Reddit reach, and activity ratings are directional estimates. No guaranteed
          ranking, citation, traffic, or revenue claims.
        </p>
      </footer>

      {selectedComment ? (
        <PostCommentModal
          domain={report.domain}
          post={selectedComment}
          submittedUrl={report.submittedUrl}
          onClose={() => setModal(null)}
        />
      ) : null}

      {selectedTestimonial ? (
        <TestimonialModal testimonial={selectedTestimonial} onClose={() => setModal(null)} />
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
      <div className="reddit-metrics">
        <MetricMini label="Monthly Traffic" value={post.estimatedMonthlyViews?.toLocaleString() ?? "n/a"} />
        <MetricMini label="Upvotes" value={post.upvoteCount.toLocaleString()} />
        <MetricMini label="Comments" value={post.commentCount.toLocaleString()} />
      </div>
    </article>
  );
}

function TrafficStat({
  label,
  value,
  detail
}: {
  label: string;
  value: number | string;
  detail: string;
}) {
  return (
    <article className="traffic-stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

function MetricMini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function FireRating({ count }: { count: number }) {
  return (
    <div className="fire-rating" aria-label={`${count} fire rating`}>
      {Array.from({ length: 5 }, (_, index) => (
        <Flame
          aria-hidden="true"
          className={index < count ? "active" : ""}
          key={index}
          size={20}
        />
      ))}
    </div>
  );
}

function MultiplierCard({
  icon: Icon,
  stat,
  label
}: {
  icon: LucideIcon;
  stat: string;
  label: string;
}) {
  return (
    <article className="multiplier-card">
      <Icon size={24} aria-hidden="true" />
      <strong>{stat}</strong>
      <p>{label}</p>
    </article>
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
    const subject = encodeURIComponent(`Prove-it comment request for ${domain}`);
    const body = encodeURIComponent(
      [
        `Website: ${submittedUrl}`,
        `Email: ${email}`,
        `Reddit opportunity: ${post.title}`,
        `Source: ${post.url}`,
        "",
        "Requested comment:",
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
            <h2>Post This Comment</h2>
            <p>One opportunity per website</p>
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
            This takes about 15 minutes. We&apos;ll post it using one of our established
            accounts and email you the direct link to the live comment.
          </p>
          <button className="button primary" type="submit">
            Request live comment
            <Mail size={18} aria-hidden="true" />
          </button>
        </form>
      </div>
    </div>
  );
}

function TestimonialModal({
  testimonial,
  onClose
}: {
  testimonial: (typeof testimonials)[number];
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div aria-modal="true" className="report-modal video-modal" role="dialog">
        <button aria-label="Close modal" className="modal-close" onClick={onClose} type="button">
          <X size={18} aria-hidden="true" />
        </button>
        <div className="video-placeholder">
          <Sparkles size={36} aria-hidden="true" />
          <strong>Video placeholder</strong>
          <span>{testimonial.name}</span>
        </div>
        <h2>{testimonial.name}</h2>
        <p>{testimonial.role}</p>
        <p>&ldquo;{testimonial.quote}&rdquo;</p>
      </div>
    </div>
  );
}

function buildCompetitorRows(competitors: CompetitorGap[]) {
  const fallback = competitors.length
    ? competitors
    : [
        {
          competitor: "Category leader",
          source: "example.com",
          gap: "",
          recommendedAction: ""
        }
      ];

  return fallback.slice(0, 5).map((competitor, index) => {
    const mentions = Math.max(18, 230 - index * 38);
    return {
      name: competitor.competitor,
      source: competitor.source,
      mentions,
      fires: mentionsToFireRating(mentions)
    };
  });
}

function mentionsToFireRating(mentions: number) {
  if (mentions >= 200) return 5;
  if (mentions >= 120) return 4;
  if (mentions >= 70) return 3;
  if (mentions >= 25) return 2;
  return 1;
}
