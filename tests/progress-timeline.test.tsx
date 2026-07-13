import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProgressTimeline } from "@/components/progress-timeline";
import type { PublicReportJob } from "@/lib/report/schema";

describe("stage-based public progress", () => {
  it("announces the current stage without rendering an invented percentage", () => {
    const job: PublicReportJob = {
      publicId: "secure-report-access",
      status: "running",
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
});
