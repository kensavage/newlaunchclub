import type { Metadata } from "next";
import Image from "next/image";
import { Check, Star } from "lucide-react";
import { LegacyCheckoutButton } from "@/components/legacy-checkout-button";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Reddit Full Intelligence Report | Launch Club",
  description: "A complete Reddit intelligence playbook for your business."
};

const playbook = [
  "Every high authority Reddit post your industry ranks on a silver platter",
  "Exact posts that will get you cited in ChatGPT, Claude, Gemini and Perplexity",
  "Golden threads where one smart comment can send a lifetime of traffic",
  "All the subreddits where your buyers actually hang out and where a few comments can beat a 5 figure ad spend"
] as const;

export default function IntelPage() {
  return (
    <main className="internal-page intel-page">
      <SiteHeader />
      <section className="intel-product">
        <h1>Reddit Full Intelligence Report For Your Business</h1>
        <div className="intel-grid">
          <div className="intel-visual">
            <Image
              src="/internal/intel/report.avif"
              alt="Launch Club Reddit intelligence report"
              width={620}
              height={760}
              priority
            />
          </div>
          <div className="intel-offer">
            <p className="intel-rank-label">Results to help you rank in...</p>
            <div className="intel-platforms">
              {[
                "ChatGPT",
                "Gemini",
                "Claude",
                "Google",
                "Perplexity"
              ].map((platform) => (
                <strong key={platform}>{platform}</strong>
              ))}
            </div>
            <div className="intel-price">
              <del>$3,000</del>
              <strong>$249</strong>
            </div>
            <div className="intel-rating" aria-label="Five stars from 122 buyers">
              {[0, 1, 2, 3, 4].map((star) => (
                <Star key={star} size={21} fill="currentColor" aria-hidden="true" />
              ))}
              <span>(122)</span>
            </div>
            <h2>
              If you hired us for $10,000/month, this is the playbook we would have put together
              for Your Business.
            </h2>
            <ul>
              {playbook.map((item) => (
                <li key={item}>
                  <Check size={20} aria-hidden="true" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <LegacyCheckoutButton
              plan="Reddit Full Intelligence Report"
              price="$249"
              features={playbook}
              href="https://launchclub.ai/intel"
              className="internal-green-button intel-download"
            >
              Download Your Full Intelligence Report
            </LegacyCheckoutButton>
          </div>
        </div>
        <div className="intel-statements">
          <h3>
            This is the same playbook clients pay <strong>$3,000 - $10,000 a month</strong> for us
            to execute for them.
          </h3>
          <h3>
            You get the full intelligence package for just <strong>$249 dollars</strong> and run
            the moves yourself.
          </h3>
        </div>
        <div className="intel-explainers">
          <article>
            <h2>What To Do With The Report</h2>
            <p>
              The Reddit Full Strategy Report offers a comprehensive roadmap to leverage the
              power of Reddit for your brand. Dive into data-driven insights, uncover audience
              trends, and discover step-by-step strategies to amplify your reach and engagement.
              This report is tailored for marketers seeking to elevate their game with actionable
              intelligence and proven methodologies directly from the vast expanses of Reddit.
            </p>
          </article>
          <article>
            <h2>What You Are Buying</h2>
            <p>
              Unlock the secrets of Reddit marketing with our Full Strategy Report. This
              invaluable resource includes analysis, success stories, and practical steps to
              engage with communities on Reddit. Perfect for brands ready to make a bold move,
              the report is your gateway to authenticity and meaningful interaction. Position
              your brand at the forefront of digital conversations and watch your influence grow.
            </p>
          </article>
        </div>
      </section>
      <SiteFooter />
    </main>
  );
}
