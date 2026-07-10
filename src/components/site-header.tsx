"use client";

import Image from "next/image";
import Link from "next/link";
import { ChevronDown, Menu, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const accessLinks = [
  { label: "Launch Club (DIY)", href: "https://launchclub.ai" },
  { label: "Launch Club Client", href: "https://launchclub.ai/client" },
  { label: "Launch Club Agency", href: "https://launchclub.ai/agency" }
] as const;

export function SiteHeader() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const accessRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (!accessRef.current?.contains(event.target as Node)) {
        setAccessOpen(false);
      }
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, []);

  return (
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
        <Link href="/watch-demo">Watch a demo</Link>
        <div className="site-access" ref={accessRef}>
          <button
            className="legacy-access-link"
            type="button"
            aria-expanded={accessOpen}
            aria-controls="desktop-access-menu"
            onClick={() => setAccessOpen((open) => !open)}
          >
            Access LaunchClub
            <ChevronDown size={18} aria-hidden="true" />
          </button>
          {accessOpen ? (
            <div className="site-access-popover" id="desktop-access-menu">
              {accessLinks.map((link) => (
                <a href={link.href} key={link.label}>
                  {link.label}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </nav>

      <div className="legacy-mobile-nav">
        <button
          className="site-mobile-toggle"
          type="button"
          aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((open) => !open)}
        >
          {mobileOpen ? <X size={27} aria-hidden="true" /> : <Menu size={27} aria-hidden="true" />}
        </button>
        {mobileOpen ? (
          <nav aria-label="Mobile navigation">
            <Link href="/watch-demo" onClick={() => setMobileOpen(false)}>
              Watch a demo
            </Link>
            {accessLinks.map((link) => (
              <a href={link.href} key={link.label}>
                {link.label}
              </a>
            ))}
          </nav>
        ) : null}
      </div>
    </header>
  );
}
