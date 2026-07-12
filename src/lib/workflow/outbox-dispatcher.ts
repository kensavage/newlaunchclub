import crypto from "node:crypto";
import type { WorkflowDispatcher, WorkflowStore } from "@/lib/workflow/store";

export interface OutboxDispatchResult {
  claimed: number;
  sent: number;
  deferred: number;
}

export async function dispatchWorkflowOutbox(store: WorkflowStore, dispatcher: WorkflowDispatcher, options: {
  owner?: string;
  limit?: number;
  leaseSeconds?: number;
  now?: () => Date;
} = {}): Promise<OutboxDispatchResult> {
  const owner = options.owner ?? `outbox:${crypto.randomUUID()}`;
  const now = options.now ?? (() => new Date());
  const events = await store.claimOutbox({ owner, limit: options.limit ?? 10, leaseSeconds: options.leaseSeconds ?? 60, now: now().toISOString() });
  let sent = 0;

  for (const event of events) {
    try {
      const result = await dispatcher.dispatchWorkflow(event.payload);
      if (await store.markOutboxSent({ outboxId: event.id, owner, externalEventId: result.eventId, now: now().toISOString() })) sent += 1;
    } catch {
      const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(event.attemptCount, 6));
      await store.markOutboxFailed({ outboxId: event.id, owner, safeError: "Workflow dispatch was temporarily unavailable.", retryAt: new Date(now().getTime() + delayMs).toISOString(), now: now().toISOString() });
    }
  }

  return { claimed: events.length, sent, deferred: events.length - sent };
}
