import Image from "next/image";
import Link from "next/link";
import { Menu } from "lucide-react";
import { HomeSections } from "@/components/home-sections";
import { ReportGenerator } from "@/components/report-generator";

export default function HomePage() {
  return (
    <main className="legacy-home">
      <section className="legacy-hero">
        <div className="legacy-hero-backdrop" aria-hidden="true" />

        <header className="legacy-site-header">
          <Link className="legacy-logo" href="/" aria-label="Launch Club home">
            <Image
              src="/launch-club-logo.svg"
              alt="Launch Club"
              width={207}
              height={32}
              priority
            />
          </Link>

          <nav className="legacy-desktop-nav" aria-label="Primary navigation">
            <a href="https://launchclub.ai/watch-demo">Watch a demo</a>
            <a className="legacy-access-link" href="https://launchclub.ai/pricing">
              Access LaunchClub
            </a>
          </nav>

          <details className="legacy-mobile-nav">
            <summary aria-label="Open navigation">
              <Menu size={27} aria-hidden="true" />
            </summary>
            <nav aria-label="Mobile navigation">
              <a href="https://launchclub.ai/watch-demo">Watch a demo</a>
              <a href="https://launchclub.ai/pricing">Access LaunchClub</a>
            </nav>
          </details>
        </header>

        <div className="legacy-hero-inner">
          <p className="legacy-kicker">Launch Club - Reddit Marketing</p>

          <div className="legacy-hero-art" aria-hidden="true">
            <Image
              className="legacy-card legacy-card-search"
              src="/launchclub-card-search.avif"
              alt=""
              width={384}
              height={384}
              priority
            />
            <Image
              className="legacy-card legacy-card-reddit"
              src="/launchclub-card-reddit.avif"
              alt=""
              width={384}
              height={384}
              priority
            />
            <Image
              className="legacy-card legacy-card-launch"
              src="/launchclub-card-launch.avif"
              alt=""
              width={384}
              height={384}
              priority
            />
            <Image
              className="legacy-cards-mobile"
              src="/launchclub-cards-mobile.avif"
              alt=""
              width={512}
              height={278}
              priority
            />
          </div>

          <h1 className="legacy-headline">
            See Where Reddit Is Talking To Your Prospects <strong>Without You</strong>
          </h1>

          <ReportGenerator />
        </div>
      </section>
      <HomeSections />
    </main>
  );
}
