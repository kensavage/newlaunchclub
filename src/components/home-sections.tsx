import Image from "next/image";
import { ChevronDown, Play } from "lucide-react";
import { ReportGenerator } from "@/components/report-generator";

type ProcessStep = {
  className: string;
  title: string;
  description: string;
  demo?: string;
  image?: string;
  imageClassName?: string;
};

const processSteps: readonly ProcessStep[] = [
  {
    className: "legacy-process-entry",
    title: "Enter Your Website or Keyword",
    description:
      "See which Reddit threads are already ranking for your top keywords so you can piggyback on traffic that already exists.",
    demo: "yourstartup.com"
  },
  {
    className: "legacy-process-discover",
    title: "Discover Target Threads & Keywords",
    description:
      "See which Reddit threads are already ranking for your top keywords so you can piggyback on traffic that already exists.",
    image: "/legacy/process-discover.avif",
    imageClassName: "legacy-process-discover-image"
  },
  {
    className: "legacy-process-post",
    title: "Posts + Comments",
    description:
      "See which Reddit threads are already ranking for your top keywords so you can piggyback on traffic that already exists.",
    image: "/legacy/process-comment.avif",
    imageClassName: "legacy-process-comment-image"
  },
  {
    className: "legacy-process-track",
    title: "Copy, Post & Track",
    description:
      "See which Reddit threads are already ranking for your top keywords so you can piggyback on traffic that already exists.",
    image: "/legacy/process-track.avif",
    imageClassName: "legacy-process-track-image",
    demo: "This is demo content"
  }
];

const benefitItems = [
  {
    title: "Reach Customers Where They’re Searching",
    description:
      "Drop your site link or niche keyword — we instantly analyze it to uncover Reddit opportunities already ranking on Google."
  },
  {
    title: "Save Hours on Research and Writing",
    description:
      "Get the target threads, keyword context, and natural comment direction without spending days researching Reddit by hand."
  },
  {
    title: "Promote Without Looking Like an Ad",
    description:
      "Join conversations with useful, context-aware comments that sound human and earn attention naturally."
  },
  {
    title: "Grow with Zero Ad Spend",
    description:
      "Build compounding visibility from conversations that can keep ranking in Google and appearing in AI-search answers."
  }
] as const;

const testimonialColumns = [
  [
    {
      name: "Chad Sakonchick",
      role: "Founder",
      image: "/legacy/chad.avif",
      quote:
        "Launch Club helped me hit the #2 spot on Product Hunt for my Legal AI Chrome Extension! Drove an enormous amount of traffic and got me over 1k downloads in a few days."
    },
    {
      name: "Marketing Max",
      role: "Founder",
      image: "/legacy/marketing-max.avif",
      quote:
        "Ken’s the real deal when it comes to highly effective & outside-the-box growth marketing. He’s been in the game forever, seen it all, and knows what works ACTUALLY what makes product launches go viral, and ongoing marketing campaigns after.\n\nIf you need someone who just gets it and delivers, Ken’s your guy. Hands down."
    }
  ],
  [
    {
      name: "Kieran Ball",
      role: "Founder",
      image: "/legacy/kieran.avif",
      quote:
        "Ken is the most knowledgeable person I know when it comes to launching products on social platforms. It was a pleasure to work with him and I look forward to doing it again soon."
    },
    {
      name: "Naomi N.",
      role: "CMO",
      image: "/legacy/naomi.avif",
      quote:
        "Ken and his launch club helped cloudHQ launch multiple apps, and they were always successfully deployed with impressive new signup numbers. We wouldn’t dream of launching again without Launch Club!"
    }
  ],
  [
    {
      name: "Andrej Ilisin",
      role: "Entrepreneur",
      image: "/legacy/andrej.avif",
      quote:
        "Working with Launch Club has been flawless. A couple of years ago, I was getting ready to launch a relatively unique app/marketplace and the team helped me do just that and get a lot of visibility/engagement from day one. I plan on working with them on a new project very soon."
    }
  ]
] as const;

const faqs = [
  {
    question: "What do you need to get started?",
    answer:
      "Once we know about your business using the onboarding info you provide (keywords, competitors and contact info) we get to work on researching. We find the posts that are already mentioned in AI search platforms and ranking in Google. They are ordered by authority and monthly search volume. We then start posting comments with brand mentions on the key Reddit threads that are getting noticed."
  },
  {
    question: "Do you use AI to write your posts and comments?",
    answer:
      "We may use AI for inspiration and research but all posts and comments are final edited by a human, as it should be."
  },
  {
    question: "Can I pause or cancel any time?",
    answer:
      "Of course. Most clients' traffic really explodes after 3 months. The posts and comments we publish for you compound month over month. It's a numbers game in your favor."
  },
  {
    question: "What does this cost?",
    answer:
      "Pricing starts at $2500. Depending on your needs and how fast you want to go the price fluctuates. Book a call using the button below to talk details."
  }
] as const;

const modelLogos = [
  "/legacy/model-chatgpt.avif",
  "/legacy/model-gemini.avif",
  "/legacy/model-perplexity.avif",
  "/legacy/model-claude.avif"
] as const;

const sourceLogos = [
  "/legacy/source-reddit.avif",
  "/legacy/source-google.avif",
  "/legacy/source-youtube.avif",
  "/legacy/source-quora.avif"
] as const;

function SectionHeading({
  eyebrow,
  children,
  centered = false
}: {
  eyebrow: string;
  children: React.ReactNode;
  centered?: boolean;
}) {
  return (
    <header className={`legacy-section-heading${centered ? " centered" : ""}`}>
      <p className="legacy-script-label">({eyebrow})</p>
      <h2>{children}</h2>
    </header>
  );
}

export function HomeSections() {
  return (
    <>
      <section className="legacy-content-section legacy-report-contents" id="report-details">
        <div className="legacy-content-inner">
          <SectionHeading eyebrow="what will you get">
            What’s Inside Your <strong>Reddit Opportunity Report?</strong>
          </SectionHeading>

          <div className="legacy-report-feature-grid">
            <article className="legacy-report-feature legacy-feature-ranking">
              <div className="legacy-feature-art">
                <span className="legacy-art-pill legacy-pill-trending">Trending Subreddits</span>
                <Image
                  className="legacy-report-post-wide"
                  src="/legacy/report-post-wide.avif"
                  alt="Example Reddit discussion discovered by Launch Club"
                  width={768}
                  height={207}
                />
                <Image
                  className="legacy-report-post-compact"
                  src="/legacy/report-post-compact.avif"
                  alt="Example Reddit post engagement"
                  width={512}
                  height={160}
                />
                <span className="legacy-art-pill legacy-pill-upvotes">Highest Upvotes</span>
              </div>
              <div className="legacy-feature-copy">
                <h3>Reddit Posts Already Ranking</h3>
                <p>
                  See which Reddit threads are already ranking for your top keywords, so you can
                  piggyback on traffic that already exists.
                </p>
              </div>
            </article>

            <article className="legacy-report-feature legacy-feature-comments">
              <div className="legacy-feature-art">
                <Image
                  className="legacy-traffic-opportunity"
                  src="/legacy/report-traffic-opportunity.avif"
                  alt="Launch Club traffic opportunity analysis"
                  width={512}
                  height={414}
                />
              </div>
              <div className="legacy-feature-copy">
                <h3>Tailored Comment Scripts</h3>
                <p>
                  You get context-aware, human-sounding comments written to naturally mention your
                  brand or link, no cringe, just clicks.
                </p>
              </div>
            </article>

            <article className="legacy-report-feature legacy-feature-keywords">
              <div className="legacy-feature-art">
                <span className="legacy-art-pill legacy-pill-organic">#OrganicTraffic</span>
                <span className="legacy-art-pill legacy-pill-growth">#RedditGrowth</span>
                <Image
                  className="legacy-report-metrics"
                  src="/legacy/report-metrics.avif"
                  alt="Reddit engagement and keyword traffic metrics"
                  width={384}
                  height={194}
                />
                <span className="legacy-art-pill legacy-pill-smart">#SmartMarketing</span>
              </div>
              <div className="legacy-feature-copy">
                <h3>Keyword Insights + Traffic Potential</h3>
                <p>
                  Understand which search terms Reddit users are actively discussing, and how much
                  monthly traffic each one gets.
                </p>
              </div>
            </article>

            <article className="legacy-report-feature legacy-feature-strategy">
              <div className="legacy-feature-art">
                <span className="legacy-art-pill legacy-pill-plan">Launch Plan</span>
                <Image
                  className="legacy-comment-composer"
                  src="/legacy/report-comment-composer.avif"
                  alt="Launch Club comment composer"
                  width={384}
                  height={328}
                />
                <span className="legacy-art-pill legacy-pill-post">Post Now</span>
              </div>
              <div className="legacy-feature-copy">
                <h3>Plug &amp; Play Posting Strategy</h3>
                <p>
                  Each report includes a ready-to-follow plan: where to comment, what to say, and
                  how to track results, just copy, paste, and post.
                </p>
              </div>
            </article>
          </div>

          <a className="legacy-section-cta" href="#report-generator">
            Get Your Report
          </a>
        </div>
      </section>

      <section className="legacy-content-section legacy-process-section" id="how-it-works">
        <div className="legacy-content-inner">
          <SectionHeading eyebrow="Our Process">
            How <strong>Launch Club AI</strong> Works
          </SectionHeading>

          <div className="legacy-process-list">
            {processSteps.map((step, index) => (
              <article className={`legacy-process-step ${step.className}`} key={step.title}>
                <div className="legacy-process-copy">
                  <span className="legacy-process-index">0{index + 1}</span>
                  <h3>{step.title}</h3>
                  <p>{step.description}</p>
                </div>
                <div className="legacy-process-art" aria-hidden="true">
                  {step.demo ? (
                    <div className={`legacy-demo-input${index === 3 ? " lower" : ""}`}>
                      {step.demo}
                    </div>
                  ) : null}
                  {step.image ? (
                    <Image
                      className={step.imageClassName}
                      src={step.image}
                      alt=""
                      width={768}
                      height={394}
                    />
                  ) : null}
                </div>
              </article>
            ))}
          </div>

          <a className="legacy-section-cta" href="#report-generator">
            See Your Reddit Opportunities
          </a>
        </div>
      </section>

      <section className="legacy-content-section legacy-benefits-section" id="benefits">
        <div className="legacy-content-inner">
          <SectionHeading eyebrow="Top Benefits" centered>
            <strong>Built Different for Reddit Growth</strong>
          </SectionHeading>

          <div className="legacy-benefits-layout">
            <Image
              className="legacy-benefits-dashboard"
              src="/legacy/benefits-dashboard.avif"
              alt="Launch Club Reddit ranking dashboard"
              width={768}
              height={690}
            />
            <div className="legacy-benefit-list">
              {benefitItems.map((item, index) => (
                <details className="legacy-benefit-item" key={item.title} open={index === 0}>
                  <summary>
                    <span>{index + 1}</span>
                    <strong>{item.title}</strong>
                  </summary>
                  <p>{item.description}</p>
                </details>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="legacy-content-section legacy-testimonials-section" id="testimonials">
        <div className="legacy-testimonial-inner">
          <h2>What our customers are saying</h2>
          <p className="legacy-testimonial-intro">
            Reddit isn&apos;t just another social platform: it&apos;s where your future customers are
            having real conversations about real problems.
          </p>

          <a
            className="legacy-video-testimonial"
            href="https://launchclub.ai/watch-demo"
            aria-label="Watch Ken Savage's Launch Club testimonial"
          >
            <div className="legacy-testimonial-person">
              <Image src="/legacy/ken.jpg" alt="Ken Savage" width={60} height={60} />
              <div>
                <strong>Ken Savage</strong>
                <span>Founder: AutoM8</span>
              </div>
            </div>
            <div className="legacy-video-thumbnail">
              <Image
                src="/legacy/testimonial-video.jpg"
                alt="Ken Savage video testimonial"
                fill
                sizes="330px"
              />
              <span className="legacy-play-button">
                <Play size={24} fill="currentColor" aria-hidden="true" />
              </span>
            </div>
          </a>

          <div className="legacy-testimonial-columns">
            {testimonialColumns.map((column, columnIndex) => (
              <div className="legacy-testimonial-column" key={columnIndex}>
                {column.map((testimonial) => (
                  <article className="legacy-testimonial-card" key={testimonial.name}>
                    <div className="legacy-testimonial-person">
                      <Image
                        src={testimonial.image}
                        alt={testimonial.name}
                        width={60}
                        height={60}
                      />
                      <div>
                        <strong>{testimonial.name}</strong>
                        <span>{testimonial.role}</span>
                      </div>
                    </div>
                    <p>{testimonial.quote}</p>
                  </article>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="legacy-content-section legacy-faq-section" id="faq">
        <div className="legacy-faq-inner">
          <SectionHeading eyebrow=" Frequently Asked Questions">
            <strong>Still Curious?</strong> Here’s What Most People Ask
          </SectionHeading>

          <div className="legacy-faq-list">
            {faqs.map((faq, index) => (
              <details className="legacy-faq-item" key={faq.question} open={index === 0}>
                <summary>
                  <strong>{faq.question}</strong>
                  <ChevronDown size={26} aria-hidden="true" />
                </summary>
                <p>{faq.answer}</p>
              </details>
            ))}
          </div>

          <a className="legacy-section-cta" href="#report-generator">
            See Your Reddit Opportunities
          </a>
        </div>
      </section>

      <section className="legacy-agency-section" id="agency">
        <div className="legacy-agency-inner">
          <div className="legacy-agency-copy">
            <h2>
              The <strong>Reddit Marketing Agency</strong>{" "}For Startups &amp; Brands
            </h2>
            <p>
              Reddit isn&apos;t just another social platform: it&apos;s where your future customers are
              having real conversations about real problems.
            </p>
            <p>
              And if you&apos;re not there with the right <strong>reddit marketing strategy</strong>,
              you&apos;re missing out on some of the most engaged audiences on the internet.
            </p>
            <a className="legacy-section-cta align-left" href="#report-generator">
              Get Started Now
            </a>
          </div>

          <div className="legacy-logo-streams" aria-hidden="true">
            <div className="legacy-logo-stream legacy-stream-up">
              {[...modelLogos, ...modelLogos].map((logo, index) => (
                <Image src={logo} alt="" width={119} height={119} key={`${logo}-${index}`} />
              ))}
            </div>
            <div className="legacy-logo-stream legacy-stream-down">
              {[...sourceLogos, ...sourceLogos].map((logo, index) => (
                <Image src={logo} alt="" width={119} height={119} key={`${logo}-${index}`} />
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="legacy-final-cta-section" id="get-report">
        <div className="legacy-final-cta-inner">
          <h2>
            Ready to Tap Into <strong>Reddit Traffic?</strong>
          </h2>
          <p>
            See which Reddit threads are already ranking for your top keywords — so you can
            piggyback on traffic that already exists.
          </p>
          <ReportGenerator variant="footer" />
        </div>
      </section>

      <footer className="legacy-home-footer">
        <Image src="/launch-club-logo.svg" alt="Launch Club" width={207} height={32} />
        <nav className="legacy-footer-nav" aria-label="Footer navigation">
          <a href="https://launchclub.ai/pricing">Pricing</a>
          <a href="https://launchclub.ai/about">About</a>
          <a href="https://launchclub.ai/contact">Contact</a>
          <a href="https://launchclub.ai/watch-demo">Watch a Demo</a>
          <a href="https://launchclub.ai/blog">Reddit Secrets</a>
          <a href="https://launchclub.ai/reddit-scraper">Reddit Scraper</a>
          <a href="https://launchclub.ai/intel">Reddit Intelligence Report</a>
          <a href="https://launchclub.ai/case-studies">Reddit Marketing Case Studies</a>
          <a href="https://launchclub.ai/terms_and_privacy">Terms of Use</a>
          <a href="https://launchclub.ai/terms_and_privacy">Privacy Policy</a>
        </nav>
        <div className="legacy-footer-socials">
          <a href="https://www.linkedin.com/company/launchclub/" aria-label="Launch Club on LinkedIn">
            <Image src="/legacy/social-linkedin.avif" alt="" width={32} height={32} />
          </a>
          <a href="https://x.com/launchclub" aria-label="Launch Club on X">
            <Image src="/legacy/social-x.avif" alt="" width={32} height={32} />
          </a>
        </div>
        <a className="legacy-footer-phone" href="tel:+19785176724">
          Call me +1 978-517-6724
        </a>
      </footer>
    </>
  );
}
