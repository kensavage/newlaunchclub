import type { Metadata } from "next";
import { Check } from "lucide-react";
import { BookCallButton } from "@/components/book-call-button";
import { InternalHero } from "@/components/internal-hero";
import { LegacyCheckoutButton } from "@/components/legacy-checkout-button";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = {
  title: "Pricing | Launch Club",
  description: "Launch Club Reddit marketing plans for brands, startups, and agencies."
};

const plans = [
  {
    name: "1st month only trial",
    price: "$1,500",
    description: "A One Month Proof Run Built To Show Traction Fast, Not Theory.",
    features: [
      "40 Real Reddit Comments With Brand Mentions",
      "Placement In Threads Already Getting Search Traffic",
      "Built To Validate Reddit As A Channel"
    ],
    badge: "",
    action: "Get Started"
  },
  {
    name: "Growth",
    price: "$2,500",
    suffix: "/ month",
    description: "Consistent Visibility With Full Control And Clear Measurement.",
    features: [
      "10 Strategic Posts In Relevant Subreddits",
      "60 Comments Reviewed And Approved By You",
      "AI Visibility Score To Track Brand Momentum",
      "Weekly Activity And Performance Reports"
    ],
    badge: "Most Popular",
    action: "Get Started"
  },
  {
    name: "Full Boost",
    price: "$4,000",
    suffix: "/ month",
    description: "Aggressive Expansion For Brands Ready To Scale Attention And Trust.",
    features: [
      "20 Strategic Posts In Relevant Subreddits",
      "100 Comments Reviewed And Approved By You",
      "AI Visibility Score To Track Brand Momentum",
      "Weekly Activity And Performance Reports",
      "Monthly Strategy Call With Our Team"
    ],
    badge: "Highest Growth",
    action: "Get Started"
  },
  {
    name: "Enterprise",
    price: "Custom",
    description: "Built For Companies That Want Control, Presence, And Long Term Leverage.",
    features: [
      "30+ Strategic Posts In Relevant Subreddits",
      "150+ Comments Reviewed And Approved By You",
      "AI Visibility Score To Track Brand Momentum",
      "Weekly Activity And Performance Reports",
      "Monthly Strategy Call With Our Team",
      "Branded Subreddit Creation And Customization",
      "Branded Subreddit Content Management",
      "Designed For Serious Growth"
    ],
    badge: "",
    action: "Book A Call"
  },
  {
    name: "SEO Agency",
    price: "From $1,500",
    description: "Starting As Little As $1500/Client Or Pay As You Go Options.",
    features: [
      "Starting As Low As $1500 Per Client",
      "Fully White Label Fulfillment",
      "Pay As You Go Or Monthly Bundles",
      "Client Ready Reporting And Support",
      "Scale Without Hiring Or Risk"
    ],
    badge: "",
    action: "Demo it for me"
  }
] as const;

export default function PricingPage() {
  return (
    <main className="internal-page pricing-page">
      <InternalHero
        title="Pricing"
        subtitle="We ain't strictly a SaaS and we ain't just a service neither"
      />
      <section className="pricing-section" aria-label="Launch Club plans">
        <div className="pricing-grid">
          {plans.map((plan, index) => (
            <article className={`pricing-card pricing-card-${index + 1}`} key={plan.name}>
              {plan.badge ? <span className="pricing-badge">{plan.badge}</span> : null}
              <h2>{plan.name}</h2>
              <div className="pricing-price">
                <strong>{plan.price}</strong>
                {"suffix" in plan ? <span>{plan.suffix}</span> : null}
              </div>
              <p>{plan.description}</p>
              <ul>
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <Check size={17} aria-hidden="true" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <div className="pricing-action">
                {index < 3 ? (
                  <LegacyCheckoutButton
                    plan={plan.name}
                    price={plan.price}
                    features={plan.features}
                    href="https://launchclub.ai/pricing"
                    className={`pricing-button${index === 1 ? " pricing-button-featured" : ""}`}
                  >
                    {plan.action}
                  </LegacyCheckoutButton>
                ) : (
                  <BookCallButton className="pricing-button">{plan.action}</BookCallButton>
                )}
                {index < 3 ? <small>or pay later with Klarna.</small> : null}
              </div>
            </article>
          ))}
        </div>
      </section>
      <SiteFooter />
    </main>
  );
}
