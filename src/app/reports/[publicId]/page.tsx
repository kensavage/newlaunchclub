import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { ReportViewer } from "@/components/report-viewer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  robots: { index: false, follow: false, noarchive: true },
  referrer: "no-referrer"
};

export default async function ReportPage({
  params
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId: reportAccessKey } = await params;

  return (
    <main className="report-shell">
      <div className="report-page">
        <header className="site-header">
          <Link className="brand-lockup" href="/" aria-label="Launch Club home">
            <Image src="/favicon.png" alt="" width={32} height={32} priority />
            <span>LaunchClub.ai</span>
          </Link>
          <Link className="text-link" href="/">
            Run another report
          </Link>
        </header>
        <ReportViewer reportAccessKey={reportAccessKey} />
      </div>
    </main>
  );
}
