"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { ProgressTimeline } from "@/components/progress-timeline";
import type { ReportJob, ReportResponse } from "@/lib/report/schema";

export function ReportGenerator({ variant = "hero" }: { variant?: "hero" | "footer" }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [publicId, setPublicId] = useState<string | null>(null);
  const [job, setJob] = useState<ReportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isFooter = variant === "footer";
  const inputId = isFooter ? "footer-website-url" : "website-url";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    setJob(null);

    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ url })
      });
      const data = (await response.json()) as { publicId?: string; reportUrl?: string; error?: string };

      if (!response.ok || !data.publicId) {
        throw new Error(data.error ?? "The report could not be started.");
      }

      setPublicId(data.publicId);

      if (response.status === 200 && data.reportUrl) {
        router.push(`/reports/${data.publicId}` as Route);
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The report could not be started.");
    } finally {
      setIsSubmitting(false);
    }
  }

  useEffect(() => {
    if (!publicId) return;

    let isActive = true;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/reports/${publicId}`, { cache: "no-store" });
      if (!response.ok) return;

      const data = (await response.json()) as ReportResponse;
      if (!isActive) return;

      setJob(data.job);

      if (data.job.status === "complete") {
        router.push(`/reports/${publicId}` as Route);
      }
    }, 800);

    return () => {
      isActive = false;
      clearInterval(timer);
    };
  }, [publicId, router]);

  return (
    <section
      className={`generator-panel generator-panel-${variant}${job ? " has-progress" : ""}`}
      id={isFooter ? "footer-report-generator" : "report-generator"}
      aria-label="Generate report"
    >
      <form className="url-form" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor={inputId}>
          {isFooter ? "Website address" : "Website URL"}
        </label>
        <div className="url-row">
          <input
            id={inputId}
            name="url"
            placeholder={isFooter ? "Enter your website" : "https://example.com"}
            type="text"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            required
          />
          <button
            aria-label={isFooter ? "Get report" : "Run report"}
            className="button primary"
            disabled={isSubmitting}
            type="submit"
          >
            <span>{isSubmitting ? "Starting..." : isFooter ? "Get Report" : "Show Me How"}</span>
          </button>
        </div>
      </form>

      {error ? <p className="error-text">{error}</p> : null}
      <ProgressTimeline job={job} />
    </section>
  );
}
