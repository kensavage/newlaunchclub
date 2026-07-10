import Image from "next/image";
import Link from "next/link";

const footerLinks = [
  { label: "Pricing", href: "/pricing" },
  { label: "About", href: "/about" },
  { label: "Contact", href: "/contact" },
  { label: "Watch a Demo", href: "/watch-demo" },
  { label: "Reddit Secrets", href: "/blog" },
  { label: "Reddit Scraper", href: "/reddit-scraper" },
  { label: "Reddit Intelligence Report", href: "/intel" },
  { label: "Reddit Marketing Case Studies", href: "/case-studies" },
  { label: "Terms of Use", href: "/terms_and_privacy#terms" },
  { label: "Privacy Policy", href: "/terms_and_privacy#privacy" }
] as const;

export function SiteFooter({ className = "" }: { className?: string }) {
  return (
    <footer className={`legacy-home-footer ${className}`.trim()}>
      <Link href="/" aria-label="Launch Club home">
        <Image src="/launch-club-logo.svg" alt="Launch Club" width={207} height={32} />
      </Link>
      <nav className="legacy-footer-nav" aria-label="Footer navigation">
        {footerLinks.map((link) => (
          <Link href={link.href} key={link.label}>
            {link.label}
          </Link>
        ))}
      </nav>
      <div className="legacy-footer-socials">
        <a
          href="https://www.linkedin.com/company/launchclub/"
          aria-label="Launch Club on LinkedIn"
          target="_blank"
          rel="noreferrer"
        >
          <Image src="/legacy/social-linkedin.avif" alt="" width={32} height={32} />
        </a>
        <a
          href="https://x.com/launchclub"
          aria-label="Launch Club on X"
          target="_blank"
          rel="noreferrer"
        >
          <Image src="/legacy/social-x.avif" alt="" width={32} height={32} />
        </a>
      </div>
      <a className="legacy-footer-phone" href="tel:+19785176724">
        Call me +1 978-517-6724
      </a>
    </footer>
  );
}
