import type { Metadata } from "next";
import { CaseStudyLibrary } from "@/components/case-study-library";
import { InternalHero } from "@/components/internal-hero";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = {
  title: "Reddit Marketing Case Studies | Launch Club",
  description: "See how Launch Club creates Reddit visibility for companies and agencies."
};

export default function CaseStudiesPage() {
  return (
    <main className="internal-page cases-page">
      <InternalHero
        title="Case Studies"
        subtitle="It's worked for others before you. Read all about it!"
      />
      <CaseStudyLibrary />
      <SiteFooter />
    </main>
  );
}
