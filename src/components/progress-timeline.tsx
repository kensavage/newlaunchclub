"use client";

import { Check, Clock, Loader2, X } from "lucide-react";
import type { PublicReportJob } from "@/lib/report/schema";
import {
  RESEARCH_READY_CURRENT_STEP,
  RESEARCH_READY_PROGRESS_DETAIL
} from "@/lib/workflow/schema";

export function ProgressTimeline({ job }: { job: PublicReportJob | null }) {
  if (!job) return null;
  const researchReady =
    job.state === "research_ready" && job.currentStep === RESEARCH_READY_CURRENT_STEP;
  const currentStage =
    job.steps.find((step) => step.status === "running" || step.status === "failed") ??
    [...job.steps].reverse().find((step) => step.status === "complete");

  return (
    <div className="progress-panel" aria-live="polite">
      <div className="progress-header">
        <span>{researchReady ? "Research status" : "Current stage"}</span>
        <strong>
          {researchReady ? "Ready for broader search intelligence" : currentStage?.label ?? "Request received"}
        </strong>
      </div>
      {researchReady ? <p className="progress-handoff">{RESEARCH_READY_PROGRESS_DETAIL}</p> : null}
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
