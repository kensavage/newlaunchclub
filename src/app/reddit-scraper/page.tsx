import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Download, Mail, MessageCircle, Phone } from "lucide-react";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = {
  title: "Free Reddit Scraper Tool | Launch Club",
  description: "Scrape Reddit posts and comments into Google Sheets with Launch Club's free tool."
};

const sheetUrl =
  "https://docs.google.com/spreadsheets/d/1Gx7mp1CvLLkCmBcnQJYxlI50XW2cHLuY3EmkbB3KUbU/copy";

function DownloadButton() {
  return (
    <a className="scraper-download" href={sheetUrl} target="_blank" rel="noreferrer">
      <Download size={19} aria-hidden="true" />
      DOWNLOAD HERE
    </a>
  );
}

export default function RedditScraperPage() {
  return (
    <main className="scraper-page">
      <header className="scraper-header">
        <Link href="/" aria-label="Launch Club home">
          <Image src="/launch-club-logo.svg" alt="Launch Club" width={207} height={32} />
        </Link>
        <nav aria-label="Scraper navigation">
          <Link href="/about">About</Link>
          <Link href="/contact">Contact</Link>
          <a href="https://launchclub.ai/client">Signin</a>
        </nav>
      </header>

      <div className="scraper-layout">
        <article className="scraper-content">
          <Image
            className="scraper-sheet-image"
            src="/internal/scraper/sheet.avif"
            alt="Reddit scraper results in Google Sheets"
            width={950}
            height={570}
            priority
          />
          <h1>Free Reddit Scraper Tool Powered by Google Sheets</h1>
          <p className="scraper-lead">
            The wealth of information on Reddit is essentially endless... but it&apos;s like trying
            to drink from a firehose. It&apos;s way too much information, all over the place,
            updating in realtime.
          </p>
          <hr />
          <div className="scraper-video">
            <iframe
              src="https://www.youtube.com/embed/aaaa?rel=0&enablejsapi=1"
              title="How to use the Google Sheets Reddit scraper"
              allowFullScreen
            />
          </div>
          <h2>How do you use this data?</h2>
          <p>
            Well, from an Agency Owner&apos;s perspective you should be mining it for competitive
            intelligence and product and service ideas.
          </p>
          <p>
            The process starts with you first identifying the SubReddits where 1) your
            competitors are hanging out and engaging in discussions, and 2) where your target
            audience (or potential clients) are hanging out.
          </p>
          <p>
            Then you want to grab all the posts and all the comments, and parse through them for
            nuggets of insight and direction.
          </p>
          <p>
            But copying and pasting all of that information sounds like a nightmare, why not just
            scrape it all into a neatly organized Google Sheet instead?
          </p>
          <p><strong><em>What a good idea.</em></strong></p>
          <DownloadButton />

          <Image
            className="scraper-detail-image"
            src="/internal/scraper/detail.avif"
            alt="Launch Club Reddit scraper controls"
            width={950}
            height={570}
          />
          <h2>Introducing The Google Sheets Reddit Scraper</h2>
          <p>
            This simple, yet powerful tool lets you scrape individual SubReddit&apos;s for Top Posts
            (up to 50 at a time) and all corresponding comments. It then pulls all of this text,
            time-stamped, into neatly organized columns in Google Sheets, complete with links to
            the source posts on Reddit.
          </p>
          <p>Here&apos;s how it works:</p>
          <ul>
            <li><strong>IMPORTANT</strong> Watch the video, it&apos;s about 3 minutes</li>
            <li>Use the native Reddit menu to set your SubReddit of choice</li>
            <li>Go click &quot;Scrape Now&quot;</li>
            <li>In about 10 seconds it will populate your sheet with results</li>
            <li>Copy and paste into new sheets, rinse and repeat</li>
          </ul>
          <h3>Important Note</h3>
          <p>You will need to authorize the custom script to run within your copy of the Google Sheet.</p>
          <p>
            You will know this when you go to run the script the first time and are greeted with a
            message asking you to &quot;Authorize the app.&quot;
          </p>
          <p>Click Advanced &gt; Proceed, then you will need to click Allow.</p>
          <p>
            This is just to authorize a custom script to be run within Google App Scripts, <strong>you
            are not giving me permission or access to ANYTHING.</strong>
          </p>
          <p>Happy Scraping.</p>
          <DownloadButton />
        </article>

        <aside className="scraper-sidebar">
          <DownloadButton />
          <a href="https://launchclub.ai" target="_blank" rel="noreferrer">
            <MessageCircle size={21} aria-hidden="true" />
            <span>Speak to our friendly team via live chat.</span>
          </a>
          <Link href="/contact">
            <Phone size={21} aria-hidden="true" />
            <span>Book a call with us</span>
          </Link>
          <a href="mailto:ken@launchclub.ai">
            <Mail size={21} aria-hidden="true" />
            <span>Email Support</span>
          </a>
        </aside>
      </div>
      <SiteFooter className="scraper-footer" />
    </main>
  );
}
