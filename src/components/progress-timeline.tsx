"use client";

import { Check, Clock, Loader2, X } from "lucide-react";
import type { ReportJob } from "@/lib/report/schema";

export function ProgressTimeline({ job }: { job: ReportJob | null }) {
  if (!job) return null;

  return (
    <div className="progress-panel" aria-live="polite">
      <div className="progress-header">
        <span>{job.progress}%</span>
        <div className="progress-bar" aria-hidden="true">
          <div style={{ width: `${job.progress}%` }} />
        </div>
      </div>
      <ol className="timeline">
        {job.steps.map((step) => {
          const Icon =
            step.status === "complete"
              ? Check
              : step.status === "failed"
                ? X
                : step.status === "running"
                  ? Loader2
                  : Clock;

          return (
            <li className={`timeline-item ${step.status}`} key={step.id}>
              <Icon size={18} aria-hidden="true" />
              <div>
                <strong>{step.label}</strong>
                {step.detail ? <p>{step.detail}</p> : null}
              </div>
            </li>
          );
        })}
      </ol>
      {job.errorSummary ? <p className="error-text">{job.errorSummary}</p> : null}
    </div>
  );
}
