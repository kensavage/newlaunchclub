import { SiteHeader } from "@/components/site-header";

export function InternalHero({
  title,
  subtitle,
  children,
  compact = false
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <section className={`internal-hero${compact ? " internal-hero-compact" : ""}`}>
      <div className="internal-hero-backdrop" aria-hidden="true" />
      <SiteHeader />
      <div className="internal-hero-copy">
        <p className="internal-kicker">(Launch Club - Reddit Marketing)</p>
        <h1>{title}</h1>
        {subtitle ? <p className="internal-subtitle">{subtitle}</p> : null}
        {children}
      </div>
    </section>
  );
}
