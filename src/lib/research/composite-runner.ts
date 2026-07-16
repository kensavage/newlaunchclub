import { PROVIDER_RESEARCH_WORKFLOW_STEPS, type ProviderResearchWorkflowStepKey, type WorkflowStepKey } from "@/lib/workflow/schema";

export interface ResearchStepRunner {
  runStep(workflowId: string, stepKey: WorkflowStepKey, owner: string): Promise<
    "already_succeeded" | "unavailable" | "succeeded" | "lease_conflict"
  >;
}

export class CompositeResearchWorkflowRunner {
  constructor(
    private readonly foundation: ResearchStepRunner,
    private readonly providerResearch: ResearchStepRunner
  ) {}

  runStep(workflowId: string, stepKey: WorkflowStepKey, owner: string) {
    return PROVIDER_RESEARCH_WORKFLOW_STEPS.includes(stepKey as ProviderResearchWorkflowStepKey)
      ? this.providerResearch.runStep(workflowId, stepKey, owner)
      : this.foundation.runStep(workflowId, stepKey, owner);
  }
}
