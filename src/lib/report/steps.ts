import type { ReportStep, ReportStepId, StepStatus } from "@/lib/report/schema";

export const reportStepDefinitions: Array<{ id: ReportStepId; label: string }> = [
  { id: "queued", label: "Queued report" },
  { id: "crawl", label: "Crawling website" },
  { id: "analysis", label: "Analyzing business" },
  { id: "keywords", label: "Finding keywords and Google/Reddit opportunities" },
  { id: "reddit", label: "Researching Reddit discussions" },
  { id: "ai-search", label: "Mapping AI-search citation opportunities" },
  { id: "synthesis", label: "Building browser report" }
];

const progressByStep: Record<ReportStepId, number> = {
  queued: 5,
  crawl: 15,
  analysis: 30,
  keywords: 52,
  reddit: 70,
  "ai-search": 82,
  synthesis: 94,
  complete: 100,
  failed: 100
};

export function createInitialSteps(): ReportStep[] {
  return reportStepDefinitions.map((step, index) => ({
    ...step,
    status: index === 0 ? "running" : "pending"
  }));
}

export function stepsForCurrentStep(
  currentStep: ReportStepId,
  status: "running" | "failed" | "complete",
  detail?: string
): ReportStep[] {
  const currentIndex = reportStepDefinitions.findIndex((step) => step.id === currentStep);
  const visibleIndex = currentIndex >= 0 ? currentIndex : reportStepDefinitions.length - 1;

  return reportStepDefinitions.map((step, index) => {
    let stepStatus: StepStatus = "pending";

    if (status === "failed" && index === visibleIndex) {
      stepStatus = "failed";
    } else if (status === "complete" || index < visibleIndex) {
      stepStatus = "complete";
    } else if (index === visibleIndex) {
      stepStatus = "running";
    }

    return {
      ...step,
      status: stepStatus,
      detail: index === visibleIndex ? detail : undefined
    };
  });
}

export function progressForStep(step: ReportStepId) {
  return progressByStep[step];
}
