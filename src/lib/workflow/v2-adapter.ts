import "server-only";
import { triggerReportWorker } from "@/lib/report/worker-client";

/** Preserved only for grandfathered V2 report behavior. V3 intake never calls this adapter. */
export class LegacyV2WorkerAdapter {
  dispatchLegacyReport(legacyPublicId: string) {
    return triggerReportWorker(legacyPublicId);
  }
}
