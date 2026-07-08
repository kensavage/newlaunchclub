import Image from "next/image";
import { ReportGenerator } from "@/components/report-generator";

export default function HomePage() {
  return (
    <main>
      <section className="home-hero">
        <div className="hero-copy">
          <Image
            className="hero-logo"
            src="/launch-club-logo.svg"
            alt="Launch Club"
            width={207}
            height={32}
            priority
          />
          <div className="eyebrow">AI Search Opportunity Report</div>
          <h1>Find the Reddit and AI-search opportunities hiding around your website.</h1>
          <p className="hero-lede">
            Get a browser report that maps buyer keywords, Reddit discussion openings,
            competitor visibility gaps, and the prompts where your brand could become easier for
            ChatGPT, Gemini, and Perplexity-style answers to cite.
          </p>
        </div>
        <ReportGenerator />
      </section>
    </main>
  );
}
