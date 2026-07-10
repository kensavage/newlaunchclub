import type { Metadata } from "next";
import Image from "next/image";
import { InternalHero } from "@/components/internal-hero";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = {
  title: "About | Launch Club",
  description: "Meet the Reddit marketers behind Launch Club."
};

const values = [
  {
    title: "Transparency",
    text: "You always see what’s happening, where, and why.",
    image: "/internal/about/transparency.avif"
  },
  {
    title: "Authenticity",
    text: "Join the brands using Launch Club to grow ethically and efficiently on Reddit.",
    image: "/internal/about/authenticity.avif"
  },
  {
    title: "Smart Targeting",
    text: "We use data to uncover the most relevant subreddits and threads.",
    image: "/internal/about/targeting.avif"
  },
  {
    title: "No Spam",
    text: "No fake upvotes, no bots, no shortcuts — ever.",
    image: "/internal/about/no-spam.avif"
  }
] as const;

export default function AboutPage() {
  return (
    <main className="internal-page about-page">
      <InternalHero title="Reddit Growth. Built By Redditors">
        <p className="about-hero-quote">
          “Launch Club helps authentic brands rise on Reddit — without spamming, without gaming,
          just smart community-led marketing.”
        </p>
        <div className="about-hero-art" aria-hidden="true">
          <Image className="about-frame-top" src="/internal/about/frame-top.svg" alt="" width={652} height={184} />
          <Image className="about-frame-bottom" src="/internal/about/frame-bottom.svg" alt="" width={602} height={231} />
          <Image className="about-megaphone" src="/internal/about/megaphone.avif" alt="" width={200} height={194} />
          <Image className="about-rocket" src="/internal/about/rocket.avif" alt="" width={277} height={294} />
        </div>
      </InternalHero>

      <div className="about-copy-sections">
        <section className="about-copy-block about-mission">
          <p className="internal-kicker">(About Us)</p>
          <h2>Our Mission</h2>
          <p>
            We are on a mission to make Reddit marketing accessible, strategic, and scalable.
            Most marketers ignore Reddit because it&apos;s hard to crack. But Reddit is where real
            conversations happen, and those conversations often show up at the top of Google
            search results. Launch Club is here to help you join those conversations in a smart
            and authentic way, so your business gets discovered by the right people.
          </p>
          <p>
            Whether you&apos;re launching a product, driving leads for a SaaS tool, or growing a
            brand from scratch, we help you turn Reddit into a high-value growth channel.
          </p>
        </section>

        <section className="about-copy-block about-founder">
          <h2>About the Founder: Ken Savage</h2>
          <p>
            Launch Club was created by Ken Savage, a Boston based marketer with over 20 years of
            experience helping startups grow using smart, cost-effective strategies and a lotta
            creation. Ken has been marketing on Reddit since the early 2000s and has built a
            career around helping businesses stand out in crowded markets.
          </p>
          <p>
            He has deep roots in the Boston startup scene and brings a hands-on, results-driven
            approach to everything we do.
          </p>
          <div className="about-founder-links">
            <a href="https://www.youtube.com/watch?v=C3rb-vevP04">Helping startups grow</a>
            <a href="https://www.youtube.com/watch?v=1qO9Nhoy38Y">Helping businesses stand out</a>
            <a href="https://www.linkedin.com/in/kensavage">Ken Savage on LinkedIn</a>
          </div>
        </section>

        <section className="about-copy-block about-ai">
          <h2>Making Brands Visible on AI Through Reddit</h2>
          <p>
            By leveraging Reddit discussions that already rank in search and influence AI
            systems, we help your brand show up where people are actively researching, comparing,
            and asking for recommendations.
          </p>
          <p>
            Whether you are launching a product, driving leads for a SaaS tool, or growing a
            brand from scratch, we help you turn Reddit into a high-value growth channel that
            builds trust, authority, and AI-level discoverability.
          </p>
        </section>

        <section className="about-split-copy">
          <div>
            <h2>Why Launch Club</h2>
            <ul>
              <li>More than two decades of Reddit marketing expertise</li>
              <li>Tools that surface Reddit posts already ranking in Google</li>
              <li>Done-for-you and self-serve options to fit your workflow</li>
              <li>Real strategies that avoid spam and actually build trust.</li>
            </ul>
          </div>
          <div>
            <h2>Looking Ahead</h2>
            <p>
              We are building Launch Club to become the goto platform for anyone serious about
              Reddit marketing. Our goal is to create the most trusted place for founders and
              agencies to grow their business through smart engagement and organic reach.
            </p>
            <p>
              If you&apos;re ready to unlock the traffic, visibility, and authority that comes from
              being part of the right conversations, Launch Club is here to help.
            </p>
          </div>
        </section>

        <section className="about-values">
          <header>
            <p className="internal-kicker">(Core Values)</p>
            <h2>What We Stand For</h2>
          </header>
          <div className="about-values-grid">
            {values.map((value) => (
              <article className="about-value-card" key={value.title}>
                <Image src={value.image} alt="" fill sizes="(max-width: 700px) 350px, 550px" />
                <div>
                  <h3>{value.title}</h3>
                  <p>{value.text}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="about-exists">
          <Image src="/internal/about/why.avif" alt="Launch Club working session" width={480} height={480} />
          <div>
            <p className="internal-kicker">(Why)</p>
            <h2>Why Launch Club Exists</h2>
            <p>
              Reddit isn&apos;t like other platforms. The audience is smarter. The communities are
              tighter. And the tolerance for bullshit is zero. Yet most marketing teams treat
              Reddit like just another ad channel. That&apos;s where we saw the opportunity.
            </p>
            <p>
              Launch Club was built to help brands navigate Reddit the right way — ethically,
              intelligently, and with a deep respect for the culture.
            </p>
          </div>
        </section>
      </div>
      <SiteFooter />
    </main>
  );
}
