"use client";

import { useEffect, useState } from "react";
import { ProgressTimeline } from "@/components/progress-timeline";
import { ReportDocument } from "@/components/report-document";
import type { ReportResponse } from "@/lib/report/schema";

export function ReportViewer({ publicId }: { publicId: string }) {
  const [response, setResponse] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;

    async function poll() {
      try {
        const fetchResponse = await fetch(`/api/reports/${publicId}`, { cache: "no-store" });

        if (!fetchResponse.ok) {
          throw new Error("Report not found.");
        }

        const data = (await fetchResponse.json()) as ReportResponse;
        if (!isActive) return;
        setResponse(data);
      } catch (pollError) {
        if (!isActive) return;
        setError(pollError instanceof Error ? pollError.message : "Report could not be loaded.");
      }
    }

    void poll();
    const timer = setInterval(poll, 1200);

    return () => {
      isActive = false;
      clearInterval(timer);
    };
  }, [publicId]);

  if (error) {
    return <p className="error-text">{error}</p>;
  }

  if (!response || response.job.status !== "complete" || !response.report) {
    return (
      <section className="report-loading">
        <h1>Building your AI Search Opportunity Report</h1>
        <ProgressTimeline job={response?.job ?? null} />
        <ReportSkeleton />
      </section>
    );
  }

  return <ReportDocument report={response.report} />;
}

function ReportSkeleton() {
  return (
    <div className="report-skeleton" aria-label="Report sections loading">
      <SkeletonSection title="Your Hidden Keyword Goldmine" rows={8} />
      <div className="skeleton-card-grid">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
      <div className="skeleton-metric-grid">
        <SkeletonMetric />
        <SkeletonMetric />
        <SkeletonMetric />
      </div>
      <SkeletonSection title="Where Your Competitors Are Already Winning" rows={5} />
      <div className="skeleton-card-grid">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    </div>
  );
}

function SkeletonSection({ title, rows }: { title: string; rows: number }) {
  return (
    <section className="skeleton-section">
      <span className="skeleton-label">{title}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-line" key={index} />
      ))}
    </section>
  );
}

function SkeletonCard() {
  return (
    <article className="skeleton-card">
      <div className="skeleton-line short" />
      <div className="skeleton-line" />
      <div className="skeleton-line" />
      <div className="skeleton-line short" />
    </article>
  );
}

function SkeletonMetric() {
  return (
    <article className="skeleton-metric">
      <div className="skeleton-line short" />
      <div className="skeleton-number" />
      <div className="skeleton-line" />
    </article>
  );
}
