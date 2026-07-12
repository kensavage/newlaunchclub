import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowAdministratorService } from "@/lib/workflow/admin-service";
import { DeterministicWorkflowAdapter } from "@/lib/workflow/deterministic-adapter";
import { MemoryWorkflowStore, resetMemoryWorkflowStoreForTests } from "@/lib/workflow/memory-store";
import { assertWorkflowEventPayloadSize } from "@/lib/workflow/netlify-adapter";
import { dispatchWorkflowOutbox } from "@/lib/workflow/outbox-dispatcher";
import { classifyWorkflowFailure, DurableWorkflowRunner, getRetryDelay } from "@/lib/workflow/runner";
import type { WorkflowEventPayload } from "@/lib/workflow/schema";
import { WorkflowBudgetError, WorkflowConfigurationError, WorkflowStateError, type WorkflowDispatcher } from "@/lib/workflow/store";

const reportRequestId = "11111111-1111-4111-8111-111111111111";
const reportId = "22222222-2222-4222-8222-222222222222";
const correlationId = "33333333-3333-4333-8333-333333333333";
const actor = { actorId: "test-admin", authenticated: true as const };

describe("durable workflow store", () => {
  beforeEach(() => resetMemoryWorkflowStoreForTests());

  it("creates exactly one workflow, stable steps, budget, and dispatch outbox for duplicate intake", async () => {
    const store = new MemoryWorkflowStore();
    const first = await createWorkflow(store);
    const duplicate = await createWorkflow(store);
    const snapshot = store.snapshot();

    expect(duplicate.id).toBe(first.id);
    expect(snapshot.workflows).toHaveLength(1);
    expect(snapshot.steps).toHaveLength(5);
    expect(new Set(snapshot.steps.map((step) => step.inputHash))).toHaveLength(5);
    expect(snapshot.outbox).toHaveLength(1);
    expect(snapshot.budgets[0]).toMatchObject({ limitCents: 400, reservedCents: 0, spentCents: 0 });
  });

  it("leases, retries, and reclaims outbox events after a crash before acknowledgement", async () => {
    const store = new MemoryWorkflowStore();
    await createWorkflow(store);
    const first = await store.claimOutbox({ owner: "one", limit: 1, leaseSeconds: 60, now: "2026-01-01T00:00:00.000Z" });
    expect(first).toHaveLength(1);
    expect(await store.claimOutbox({ owner: "two", limit: 1, leaseSeconds: 60, now: "2026-01-01T00:00:30.000Z" })).toHaveLength(0);
    const reclaimed = await store.claimOutbox({ owner: "two", limit: 1, leaseSeconds: 60, now: "2026-01-01T00:01:01.000Z" });
    expect(reclaimed).toHaveLength(1);
    expect(await store.markOutboxSent({ outboxId: first[0]!.id, owner: "one", externalEventId: "late" })).toBe(false);
    expect(await store.markOutboxFailed({ outboxId: first[0]!.id, owner: "two", safeError: "safe", retryAt: "2026-01-01T00:02:00.000Z" })).toBe(true);
  });

  it("dispatches identifier-only events and safely handles duplicate delivery", async () => {
    const store = new MemoryWorkflowStore();
    const workflow = await createWorkflow(store);
    const payload = store.snapshot().outbox[0]!.payload;
    const runner = new DurableWorkflowRunner(store);

    await runner.run(payload, "delivery-one");
    await runner.run(payload, "delivery-two");

    expect((await store.getWorkflow(workflow.id))?.status).toBe("ready_for_provider_research");
    expect(store.snapshot().steps.every((step) => step.attemptCount === 1)).toBe(true);
    expect(assertWorkflowEventPayloadSize(payload)).toBeLessThan(1_000);
    expect(Object.keys(payload).sort()).toEqual(["correlationId", "reportId", "reportRequestId", "workflowId", "workflowVersion"].sort());
  });

  it("acquires one lease, renews heartbeat, recovers expiry, and fences the old owner", async () => {
    const store = new MemoryWorkflowStore();
    const workflow = await createWorkflow(store);
    const first = await store.beginStep({ workflowId: workflow.id, stepKey: "initialize_workflow", owner: "one", leaseSeconds: 30, now: "2026-01-01T00:00:00.000Z" });
    expect(first.disposition).toBe("acquired");
    expect((await store.beginStep({ workflowId: workflow.id, stepKey: "initialize_workflow", owner: "two", leaseSeconds: 30, now: "2026-01-01T00:00:10.000Z" })).disposition).toBe("unavailable");
    expect((await store.beginStep({ workflowId: workflow.id, stepKey: "validate_intake_references", owner: "out-of-order", leaseSeconds: 30, now: "2026-01-01T00:00:10.000Z" })).disposition).toBe("unavailable");
    expect(await store.heartbeatLease({ workflowId: workflow.id, stepKey: "initialize_workflow", owner: "one", fencingToken: first.lease!.fencingToken, leaseSeconds: 30, now: "2026-01-01T00:00:20.000Z" })).toBe(true);
    const second = await store.beginStep({ workflowId: workflow.id, stepKey: "initialize_workflow", owner: "two", leaseSeconds: 30, now: "2026-01-01T00:00:51.000Z" });
    expect(second.lease!.fencingToken).toBeGreaterThan(first.lease!.fencingToken);
    expect(await store.completeStep({ workflowId: workflow.id, stepKey: "initialize_workflow", owner: "one", fencingToken: first.lease!.fencingToken, now: "2026-01-01T00:00:52.000Z" })).toBe(false);
    expect(await store.completeStep({ workflowId: workflow.id, stepKey: "initialize_workflow", owner: "two", fencingToken: second.lease!.fencingToken, now: "2026-01-01T00:00:52.000Z" })).toBe(true);
  });

  it("persists transient retry without rerunning successful steps and exhausts attempts", async () => {
    const store = new MemoryWorkflowStore();
    const workflow = await createWorkflow(store);
    const runner = new DurableWorkflowRunner(store);
    await runner.runStep(workflow.id, "initialize_workflow", "success");
    const successfulAttempts = store.snapshot().steps.find((step) => step.stepKey === "initialize_workflow")!.attemptCount;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const lease = await store.beginStep({ workflowId: workflow.id, stepKey: "validate_intake_references", owner: `failure-${attempt}`, leaseSeconds: 60, now: `2026-01-01T00:00:0${attempt}.000Z` });
      expect(lease.disposition).toBe("acquired");
      await store.failStep({ workflowId: workflow.id, stepKey: "validate_intake_references", owner: `failure-${attempt}`, fencingToken: lease.lease!.fencingToken, classification: "transient", safeCode: "temporary", safeSummary: "Temporary.", retryAt: `2026-01-01T00:00:0${attempt}.000Z`, now: `2026-01-01T00:00:0${attempt}.000Z` });
    }

    expect((await store.getWorkflow(workflow.id))?.status).toBe("failed");
    expect(store.snapshot().steps.find((step) => step.stepKey === "validate_intake_references")?.status).toBe("failed_terminal");
    await runner.runStep(workflow.id, "initialize_workflow", "duplicate");
    expect(store.snapshot().steps.find((step) => step.stepKey === "initialize_workflow")?.attemptCount).toBe(successfulAttempts);
  });

  it("records permanent and configuration failure behavior without automatic retry", async () => {
    const store = new MemoryWorkflowStore();
    const workflow = await createWorkflow(store);
    const lease = await store.beginStep({ workflowId: workflow.id, stepKey: "initialize_workflow", owner: "owner", leaseSeconds: 60 });
    await store.failStep({ workflowId: workflow.id, stepKey: "initialize_workflow", owner: "owner", fencingToken: lease.lease!.fencingToken, classification: "configuration_error", safeCode: "configuration", safeSummary: "Administrator configuration required." });
    expect((await store.getWorkflow(workflow.id))?.status).toBe("failed");
    expect(store.snapshot().errors[0]?.classification).toBe("configuration_error");
    expect(classifyWorkflowFailure(new WorkflowConfigurationError())).toBe("configuration_error");
    expect(classifyWorkflowFailure(new Error("permanent"))).toBe("permanent");
    expect(getRetryDelay(3, 1_000, 10_000, () => 0.5)).toBe(4_000);
  });

  it("pauses, resumes, retries only failed work, cancels, rejects invalid transitions, and audits administrators", async () => {
    const store = new MemoryWorkflowStore();
    const workflow = await createWorkflow(store);
    const admin = new WorkflowAdministratorService(store, actor);
    await admin.pause(workflow.id);
    expect((await store.beginStep({ workflowId: workflow.id, stepKey: "initialize_workflow", owner: "blocked", leaseSeconds: 60 })).disposition).toBe("unavailable");
    await admin.resume(workflow.id);
    expect(store.snapshot().outbox).toHaveLength(2);
    const lease = await store.beginStep({ workflowId: workflow.id, stepKey: "initialize_workflow", owner: "failure", leaseSeconds: 60 });
    await store.failStep({ workflowId: workflow.id, stepKey: "initialize_workflow", owner: "failure", fencingToken: lease.lease!.fencingToken, classification: "permanent", safeCode: "failed", safeSummary: "Failed." });
    await admin.retryStep(workflow.id, "initialize_workflow");
    expect(store.snapshot().steps.find((step) => step.stepKey === "initialize_workflow")?.status).toBe("pending");
    await admin.cancel(workflow.id);
    await expect(admin.resume(workflow.id)).rejects.toBeInstanceOf(WorkflowStateError);
    expect(store.snapshot().events.some((event) => event.actorType === "administrator" && event.safeMetadata.actorId === actor.actorId)).toBe(true);
  });

  it("reserves exact cents, protects retries, rejects over-budget work, records actuals, and releases unused reservations", async () => {
    const store = new MemoryWorkflowStore();
    const workflow = await createWorkflow(store);
    const first = await store.reserveCost({ workflowId: workflow.id, stepId: null, amountCents: 175, idempotencyKey: "reserve:one" });
    const duplicate = await store.reserveCost({ workflowId: workflow.id, stepId: null, amountCents: 175, idempotencyKey: "reserve:one" });
    expect(duplicate.id).toBe(first.id);
    await expect(store.reserveCost({ workflowId: workflow.id, stepId: null, amountCents: 226, idempotencyKey: "too-much" })).rejects.toBeInstanceOf(WorkflowBudgetError);
    await store.recordActualCost({ workflowId: workflow.id, stepId: null, attemptId: null, reservedCents: 175, actualCents: 123, idempotencyKey: "actual:one" });
    await store.reserveCost({ workflowId: workflow.id, stepId: null, amountCents: 50, idempotencyKey: "reserve:two" });
    await store.releaseCost({ workflowId: workflow.id, stepId: null, amountCents: 50, idempotencyKey: "release:two" });
    expect((await store.getWorkflowDetail(workflow.id))?.budget).toMatchObject({ spentCents: 123, reservedCents: 0, limitCents: 400 });
    expect(store.snapshot().costs.some((entry) => entry.entryType === "release" && entry.amountCents === 52)).toBe(true);
  });

  it("sanitizes public progress and rejects oversized Netlify event data", async () => {
    const store = new MemoryWorkflowStore();
    const workflow = await createWorkflow(store);
    const progress = await store.getPublicProgress(workflow.reportRequestId);
    expect(JSON.stringify(progress)).not.toMatch(/lease|attempt|cost|safeCode|reportRequestId/i);
    const oversized = { ...store.snapshot().outbox[0]!.payload, extra: "x".repeat(40_000) } as unknown as WorkflowEventPayload;
    expect(() => assertWorkflowEventPayloadSize(oversized)).toThrow(/payload/i);
  });

  it("marks dispatch sent only after adapter acknowledgement", async () => {
    const store = new MemoryWorkflowStore();
    await createWorkflow(store);
    const adapter = new DeterministicWorkflowAdapter(store);
    const result = await dispatchWorkflowOutbox(store, adapter, { owner: "dispatcher", now: () => new Date("2026-01-01T00:00:00.000Z") });
    expect(result).toEqual({ claimed: 1, sent: 1, deferred: 0 });
    expect(store.snapshot().outbox[0]?.status).toBe("sent");
  });

  it("defers a failed adapter send without losing the outbox event", async () => {
    const store = new MemoryWorkflowStore();
    await createWorkflow(store);
    const dispatcher = { dispatchWorkflow: vi.fn().mockRejectedValue(new Error("network")) } as unknown as WorkflowDispatcher;
    const result = await dispatchWorkflowOutbox(store, dispatcher, { owner: "dispatcher", now: () => new Date("2026-01-01T00:00:00.000Z") });
    expect(result.deferred).toBe(1);
    expect(store.snapshot().outbox[0]?.status).toBe("retry_scheduled");
    expect(store.snapshot().outbox[0]?.lastSafeError).not.toContain("network");
  });
});

async function createWorkflow(store: MemoryWorkflowStore) {
  return store.createInitialWorkflow({ reportRequestId, reportId, inputHash: "a".repeat(64), correlationId, orchestratorBackend: "deterministic" }, "2026-01-01T00:00:00.000Z");
}
