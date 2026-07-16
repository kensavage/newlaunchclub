import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProgressTimeline } from "@/components/progress-timeline";
import type { PublicReportJob } from "@/lib/report/schema";

describe("stage-based public progress", () => {
  it("announces the current stage without rendering an invented percentage", () => {
    const job: PublicReportJob = {
      publicId: "secure-report-access",
      status: "running",
      state: "preparing_research",
      currentStep: "crawl",
      progress: null,
      steps: [
        { id: "queued", label: "Request received", status: "complete" },
        { id: "crawl", label: "Preparing research", status: "running" }
      ],
      errorSummary: null
    };

    const { container } = render(<ProgressTimeline job={job} />);

    expect(screen.getByText("Current stage")).toBeInTheDocument();
    expect(screen.getAllByText("Preparing research")).toHaveLength(2);
    expect(container.textContent).not.toMatch(/\d+%|94/);
    expect(container.textContent).not.toMatch(/Researching visibility|Analyzing findings|Building report|Quality review|Report ready/i);
  });

  it("announces the search-intelligence handoff without claiming the report is ready", () => {
    const job: PublicReportJob = {
      publicId: "secure-report-access",
      status: "running",
      state: "research_ready",
      currentStep: "research_ready",
      progress: null,
      steps: [
        { id: "queued", label: "Request received", status: "complete" },
        { id: "crawl", label: "Reviewing your website", status: "complete" },
        { id: "analysis", label: "Building your company profile", status: "complete" },
        { id: "keywords", label: "Preparing your market research", status: "complete" }
      ],
      errorSummary: null
    };

    const { container } = render(<ProgressTimeline job={job} />);

    expect(screen.getByText("Research status")).toBeInTheDocument();
    expect(screen.getByText("Ready for broader search intelligence")).toBeInTheDocument();
    expect(
      screen.getByText("Initial company research is complete. Preparing broader search intelligence.")
    ).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Report ready|Report complete|\d+%/i);
  });
});
