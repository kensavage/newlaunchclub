import Image from "next/image";
import Link from "next/link";
import { ReportViewer } from "@/components/report-viewer";

export const dynamic = "force-dynamic";

export default async function ReportPage({
  params
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;

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
        <ReportViewer publicId={publicId} />
      </div>
    </main>
  );
}
