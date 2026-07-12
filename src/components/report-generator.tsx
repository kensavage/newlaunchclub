"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ProgressTimeline } from "@/components/progress-timeline";
import type {
  IntakeSubmissionSource,
  ReportIntakeResponse
} from "@/lib/report/intake-schema";
import type { PublicReportJob, ReportResponse } from "@/lib/report/schema";

export function ReportGenerator({
  variant = "hero",
  source = "website_report_form"
}: {
  variant?: "hero" | "footer";
  source?: IntakeSubmissionSource;
}) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [email, setEmail] = useState("");
  const [reportAccessToken, setReportAccessToken] = useState<string | null>(null);
  const [job, setJob] = useState<PublicReportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const idempotencyKey = useRef<string | null>(null);
  const isFooter = variant === "footer";
  const inputId = isFooter ? "footer-website-url" : "website-url";
  const emailInputId = isFooter ? "footer-work-email" : "work-email";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    setJob(null);

    try {
      idempotencyKey.current ??= crypto.randomUUID();
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current
        },
        body: JSON.stringify({ url, email, idempotencyKey: idempotencyKey.current, source })
      });
      const data = (await response.json()) as Partial<ReportIntakeResponse> & { error?: string };

      if (!response.ok || !data.reportAccessToken) {
        throw new Error(data.error ?? "The report could not be started.");
      }

      setReportAccessToken(data.reportAccessToken);

      if (data.requestStatus === "complete") {
        router.push(`/reports/${data.reportAccessToken}` as Route);
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The report could not be started.");
    } finally {
      setIsSubmitting(false);
    }
  }

  useEffect(() => {
    if (!reportAccessToken) return;

    let isActive = true;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/reports/${encodeURIComponent(reportAccessToken)}`, {
        cache: "no-store"
      });
      if (!response.ok) {
        if (isActive) {
          setError(
            response.status === 404
              ? "This secure report link is unavailable or has expired."
              : "The report status could not be loaded. Please try again."
          );
          setReportAccessToken(null);
        }
        return;
      }

      const data = (await response.json()) as ReportResponse;
      if (!isActive) return;

      setJob(data.job);

      if (data.job.status === "complete") {
        router.push(`/reports/${reportAccessToken}` as Route);
      }
    }, 800);

    return () => {
      isActive = false;
      clearInterval(timer);
    };
  }, [reportAccessToken, router]);

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
        <div className="url-row report-intake-row">
          <input
            autoComplete="url"
            id={inputId}
            inputMode="url"
            name="url"
            placeholder={isFooter ? "Enter your website" : "https://example.com"}
            type="text"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            required
          />
          <label className="sr-only" htmlFor={emailInputId}>
            Work email
          </label>
          <input
            autoComplete="email"
            id={emailInputId}
            inputMode="email"
            name="email"
            placeholder="you@company.com"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
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
