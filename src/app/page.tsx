import Image from "next/image";
import { HomeSections } from "@/components/home-sections";
import { ReportGenerator } from "@/components/report-generator";
import { SiteHeader } from "@/components/site-header";

export default function HomePage() {
  return (
    <main className="legacy-home">
      <section className="legacy-hero">
        <div className="legacy-hero-backdrop" aria-hidden="true" />

        <SiteHeader />

        <div className="legacy-hero-inner">
          <h1 className="legacy-kicker">Launch Club - Reddit Marketing</h1>

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

          <h2 className="legacy-headline">
            See Where Reddit Is Talking To Your Prospects <strong>Without You</strong>
          </h2>

          <ReportGenerator />
        </div>
      </section>
      <HomeSections />
    </main>
  );
}
