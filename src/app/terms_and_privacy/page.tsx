import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import legal from "@/content/legal.json";

export const metadata: Metadata = {
  title: "Terms of Use and Privacy Policy | Launch Club",
  description: "Launch Club terms of use and privacy policy."
};

export default function TermsAndPrivacyPage() {
  return (
    <main className="legal-page">
      <Link href="/" className="legal-logo" aria-label="Launch Club home">
        <Image src="/internal/legal-logo.svg" alt="Launch Club" width={84} height={84} />
      </Link>
      <nav aria-label="Legal documents">
        <a href="#terms">Terms of Use</a>
        <a href="#privacy">Privacy Policy</a>
      </nav>
      <section id="terms">
        <pre>{legal.terms}</pre>
      </section>
      <section id="privacy">
        <pre>{legal.privacy}</pre>
      </section>
    </main>
  );
}
