import Image from "next/image";
import Link from "next/link";

export function BlogHeader() {
  return (
    <header className="blog-header">
      <Link href="/" aria-label="Launch Club home">
        <Image src="/launch-club-logo.svg" alt="Launch Club" width={207} height={32} priority />
      </Link>
      <nav aria-label="Blog navigation">
        <Link href="/about">About</Link>
        <Link href="/pricing">Pricing</Link>
        <Link href="/contact">Contact</Link>
        <Link href="/blog">Blog</Link>
      </nav>
      <a className="blog-access" href="https://launchclub.ai/client">
        Access LaunchClub
      </a>
    </header>
  );
}
