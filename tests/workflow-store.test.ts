import { beforeEach, describe, expect, it } from "vitest";
import { WorkflowAdministratorService } from "@/lib/workflow/admin-service";
import { MemoryWorkflowStore, resetMemoryWorkflowStoreForTests } from "@/lib/workflow/memory-store";
import { assertWorkflowQueuePayloadSize } from "@/lib/workflow/queue";
import { classifyWorkflowFailure, DurableWorkflowRunner, getRetryDelay } from "@/lib/workflow/runner";
import type { WorkflowQueuePayload } from "@/lib/workflow/schema";
import { WorkflowBudgetError, WorkflowConfigurationError, WorkflowStateError } from "@/lib/workflow/store";

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

  it("processes identifier-only queue messages and safely handles duplicate delivery", async () => {
    const store = new MemoryWorkflowStore();
    const workflow = await createWorkflow(store);
    const payload = store.snapshot().outbox[0]!.payload;
    const runner = new DurableWorkflowRunner(store);

    await runner.run(payload, "delivery-one");
    await runner.run(payload, "delivery-two");

    expect((await store.getWorkflow(workflow.id))?.status).toBe("ready_for_provider_research");
    expect(store.snapshot().steps.every((step) => step.attemptCount === 1)).toBe(true);
    expect(assertWorkflowQueuePayloadSize(payload)).toBeLessThan(1_000);
    expect(Object.keys(payload).sort()).toEqual(["correlationId", "reportId", "reportRequestId", "requestedAt", "workflowId", "workflowVersion"].sort());
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

  it("pauses configuration failures without scheduling an automatic retry", async () => {
    const store = new MemoryWorkflowStore();
    const workflow = await createWorkflow(store);
    const lease = await store.beginStep({ workflowId: workflow.id, stepKey: "initialize_workflow", owner: "owner", leaseSeconds: 60 });
    await store.failStep({ workflowId: workflow.id, stepKey: "initialize_workflow", owner: "owner", fencingToken: lease.lease!.fencingToken, classification: "configuration_error", safeCode: "configuration", safeSummary: "Administrator configuration required." });
    expect((await store.getWorkflow(workflow.id))?.status).toBe("paused");
    expect(store.snapshot().steps.find((step) => step.stepKey === "initialize_workflow")?.status)
      .toBe("failed_terminal");
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

  it("sanitizes public progress and rejects oversized queue data", async () => {
    const store = new MemoryWorkflowStore();
    const workflow = await createWorkflow(store);
    const progress = await store.getPublicProgress(workflow.reportRequestId);
    expect(JSON.stringify(progress)).not.toMatch(/lease|attempt|cost|safeCode|reportRequestId/i);
    expect(progress).toMatchObject({
      currentStep: "crawl",
      steps: [
        { label: "Request received", status: "complete" },
        { label: "Preparing research", status: "running" }
      ]
    });
    expect(JSON.stringify(progress)).not.toMatch(/94|ready_for_provider_research|Research workflow ready/);
    const oversized = { ...store.snapshot().outbox[0]!.payload, extra: "x".repeat(40_000) } as unknown as WorkflowQueuePayload;
    expect(() => assertWorkflowQueuePayloadSize(oversized)).toThrow(/payload/i);
  });
});

async function createWorkflow(store: MemoryWorkflowStore) {
  return store.createInitialWorkflow({ reportRequestId, reportId, inputHash: "a".repeat(64), correlationId, orchestratorBackend: "deterministic" }, "2026-01-01T00:00:00.000Z");
}
