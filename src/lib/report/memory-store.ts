import {
  createExpiryDate,
  createNow,
  type CreateReportJobInput,
  type ReportStore,
  type VendorEventInput
} from "@/lib/report/store";
import type { OpportunityReport, ReportJob } from "@/lib/report/schema";
import { createInitialSteps } from "@/lib/report/steps";

interface MemoryState {
  jobs: Map<string, ReportJob>;
  reports: Map<string, OpportunityReport>;
  vendorEvents: VendorEventInput[];
}

declare global {
  var __launchClubReportStore: MemoryState | undefined;
}

function getState(): MemoryState {
  globalThis.__launchClubReportStore ??= {
    jobs: new Map<string, ReportJob>(),
    reports: new Map<string, OpportunityReport>(),
    vendorEvents: []
  };

  return globalThis.__launchClubReportStore;
}

export class MemoryReportStore implements ReportStore {
  private readonly state = getState();

  async createJob(input: CreateReportJobInput): Promise<ReportJob> {
    const now = createNow();
    const job: ReportJob = {
      ...input,
      status: "queued",
      currentStep: "queued",
      progress: 5,
      steps: createInitialSteps(),
      errorSummary: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: createExpiryDate()
    };

    this.state.jobs.set(job.publicId, job);
    return job;
  }

  async getJob(publicId: string): Promise<ReportJob | null> {
    return this.state.jobs.get(publicId) ?? null;
  }

  async updateJob(publicId: string, patch: Partial<ReportJob>): Promise<ReportJob> {
    const job = this.state.jobs.get(publicId);

    if (!job) {
      throw new Error("Report job was not found.");
    }

    const updated = {
      ...job,
      ...patch,
      updatedAt: createNow()
    };

    this.state.jobs.set(publicId, updated);
    return updated;
  }

  async saveReport(publicId: string, report: OpportunityReport): Promise<void> {
    this.state.reports.set(publicId, report);
  }

  async getReport(publicId: string): Promise<OpportunityReport | null> {
    return this.state.reports.get(publicId) ?? null;
  }

  async findRecentCompletedReportByDomain(domain: string) {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

    for (const job of this.state.jobs.values()) {
      const report = this.state.reports.get(job.publicId);
      const createdAt = new Date(job.createdAt).valueOf();

      if (job.domain === domain && job.status === "complete" && report && createdAt >= oneDayAgo) {
        return { job, report };
      }
    }

    return null;
  }

  async recordVendorEvent(event: VendorEventInput): Promise<void> {
    this.state.vendorEvents.push(event);
  }
}
