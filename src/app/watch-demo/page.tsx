import type { Metadata } from "next";
import { InternalHero } from "@/components/internal-hero";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = {
  title: "Watch a Demo | Launch Club",
  description: "See how Launch Club turns Reddit conversations into search visibility."
};

export default function WatchDemoPage() {
  return (
    <main className="internal-page demo-page">
      <InternalHero title="Watch a demo" subtitle="See how it works in under 8 minutes" />
      <section className="demo-video-wrap">
        <iframe
          src="https://www.loom.com/embed/e8653cae40054a40b7b6767f9546a644"
          title="Launch Club product demo"
          allowFullScreen
          allow="autoplay; fullscreen"
        />
      </section>
      <SiteFooter />
    </main>
  );
}
