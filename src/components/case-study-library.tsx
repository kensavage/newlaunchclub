"use client";

import Image from "next/image";
import { Download } from "lucide-react";
import { useState } from "react";

const companyCases = [
  {
    title: "Fintech Case Study",
    image: "/internal/cases/fintech.avif",
    href: "https://docs.google.com/document/export?format=pdf&id=1AmwsA6bqQqc9uwOzWWNoJ13qxNSQoJWXJQWIhBL3ys8"
  },
  {
    title: "SaaS Case Study",
    image: "/internal/cases/saas.avif",
    href: "https://docs.google.com/document/export?format=pdf&id=1qnsoy7uw6pItqOIiEJVjEq3NroLgLhYkSi9aqE5WCX0"
  },
  {
    title: "SEO Agency Case Study",
    image: "/internal/cases/seo.avif",
    href: "https://docs.google.com/document/export?format=pdf&id=1G4JdQWpAv6aK5pMUSot06GSgmRIxkCMwqO5udVa2LNc"
  },
  {
    title: "Travel Industry Case Study",
    image: "/internal/cases/travel.avif",
    href: "https://docs.google.com/document/export?format=pdf&id=1S2i1Xb3q5PYa9hDkpEwKvVue3j6TsTx0UayQsbJKTDk"
  }
] as const;

const agencyCases = [
  ...companyCases,
  { title: "One Pager", image: "/internal/cases/one-pager.avif", href: "" }
] as const;

export function CaseStudyLibrary() {
  const [tab, setTab] = useState<"company" | "agency">("company");
  const cases = tab === "company" ? companyCases : agencyCases;

  return (
    <section className="case-library">
      <h2>Case Studies for Companies</h2>
      <div className="case-tabs" role="tablist" aria-label="Case study type">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "company"}
          onClick={() => setTab("company")}
        >
          Company
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "agency"}
          onClick={() => setTab("agency")}
        >
          Agency
        </button>
      </div>
      <div className="case-grid">
        {cases.map((item) => (
          <article className="case-card" key={item.title}>
            <h3>{item.title}</h3>
            <div className="case-cover">
              <Image
                src={item.image}
                alt={`${item.title} cover`}
                fill
                sizes="(max-width: 700px) 276px, 322px"
              />
            </div>
            {item.href ? (
              <a href={item.href} target="_blank" rel="noreferrer">
                <Download size={17} aria-hidden="true" />
                Download PDF
              </a>
            ) : (
              <span className="case-download-disabled" aria-label="One Pager download coming soon">
                Download coming soon
              </span>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
