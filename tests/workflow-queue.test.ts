// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryWorkflowStore, resetMemoryWorkflowStoreForTests } from "@/lib/workflow/memory-store";
import {
  assertWorkflowQueuePayloadSize,
  MemoryWorkflowQueue,
  parseWorkflowQueuePayload,
  workflowQueueIdempotencyKey
} from "@/lib/workflow/queue";
import { WorkflowQueueConsumer } from "@/lib/workflow/queue-consumer";
import { DurableWorkflowRunner } from "@/lib/workflow/runner";
import {
  ALL_WORKFLOW_STEPS,
  type FailureClassification,
  type WorkflowStatus,
  type WorkflowStepKey
} from "@/lib/workflow/schema";
import {
  createWorkflowWakeupHeaders,
  verifyWorkflowWakeupRequest,
  WORKFLOW_WAKEUP_PATH,
  WORKFLOW_WAKEUP_SIGNATURE_HEADER
} from "@/lib/workflow/wakeup-auth";

const reportRequestId = "11111111-1111-4111-8111-111111111111";
const reportId = "22222222-2222-4222-8222-222222222222";
const correlationId = "33333333-3333-4333-8333-333333333333";
const start = new Date("2026-01-01T00:00:00.000Z");

describe("Supabase Queue workflow transport", () => {
  beforeEach(() => resetMemoryWorkflowStoreForTests());

  it("accepts only the six identifier fields, enforces 32 KB, and deduplicates enqueue", async () => {
    const { payload } = await setup();
    const queue = new MemoryWorkflowQueue(() => start);
    const first = await queue.enqueue(payload, workflowQueueIdempotencyKey(payload));
    const duplicate = await queue.enqueue(payload, workflowQueueIdempotencyKey(payload));

    expect(duplicate).toEqual(first);
    expect(queue.snapshot().messages).toHaveLength(1);
    expect(Object.keys(parseWorkflowQueuePayload(payload)).sort()).toEqual([
      "correlationId", "reportId", "reportRequestId", "requestedAt", "workflowId", "workflowVersion"
    ].sort());
    expect(() => parseWorkflowQueuePayload({ ...payload, email: "private@example.com" })).toThrow();
    expect(() => assertWorkflowQueuePayloadSize({ ...payload, extra: "x".repeat(40_000) })).toThrow(/payload/i);
  });

  it("redelivers after visibility expiry and tracks queue reads independently from step attempts", async () => {
    let now = start;
    const { payload } = await setup();
    const queue = new MemoryWorkflowQueue(() => now);
    await queue.enqueue(payload, "visibility");

    expect((await queue.read({ batchSize: 1, visibilityTimeoutSeconds: 30 }))[0]?.readCount).toBe(1);
    expect(await queue.read({ batchSize: 1, visibilityTimeoutSeconds: 30 })).toHaveLength(0);
    now = new Date(start.getTime() + 30_001);
    expect((await queue.read({ batchSize: 1, visibilityTimeoutSeconds: 30 }))[0]?.readCount).toBe(2);
  });

  it("runs one eligible step per delivery and survives a crash after durable step success", async () => {
    let now = start;
    const { store, workflow, payload } = await setup();
    const queue = new MemoryWorkflowQueue(() => now);
    const runner = new DurableWorkflowRunner(store, { now: () => now });
    await queue.enqueue(payload, "crash-safe");

    await runner.runStep(workflow.id, "initialize_workflow", "crashed-after-success");
    now = new Date(now.getTime() + 1);
    const consumer = new WorkflowQueueConsumer(store, queue, { now: () => now, runner });
    await consumer.consume();

    const steps = (await store.getWorkflowDetail(workflow.id))!.steps;
    expect(steps.find((step) => step.stepKey === "initialize_workflow")?.attemptCount).toBe(1);
    expect(steps.find((step) => step.stepKey === "validate_intake_references")?.attemptCount).toBe(1);
    expect(steps.find((step) => step.stepKey === "establish_cost_budget")?.attemptCount).toBe(0);
  });

  it("makes duplicate delivery harmless and archives after terminal PR3 preparation", async () => {
    let now = start;
    const { store, workflow, payload } = await setup();
    const queue = new MemoryWorkflowQueue(() => now);
    await queue.enqueue(payload, "primary");
    queue.seedUnsafeMessageForTests(payload);
    const consumer = new WorkflowQueueConsumer(store, queue, { now: () => now, batchSize: 2 });

    await consumer.consume();
    expect((await store.getWorkflowDetail(workflow.id))!.steps.filter((step) => step.attemptCount > 0)).toHaveLength(1);
    for (let index = 0; index < 6; index += 1) {
      now = new Date(now.getTime() + 2_000);
      await consumer.consume();
    }

    expect((await store.getWorkflow(workflow.id))?.status).toBe("ready_for_provider_research");
    expect((await store.getWorkflowDetail(workflow.id))!.steps.every((step) => step.attemptCount === 1)).toBe(true);
    expect(queue.snapshot().messages.every((message) => message.archived)).toBe(true);
  });

  it("repairs stale queue state and archives repeated no-work deliveries without duplicate work", async () => {
    let now = start;
    const { store, workflow, payload } = await setup();
    await advanceToSearchIntelligence(store, workflow.id, () => now);
    const progressBefore = await store.getPublicProgress(reportRequestId);
    const detailBefore = (await store.getWorkflowDetail(workflow.id))!;
    const queue = new MemoryWorkflowQueue(() => now);
    await queue.enqueue(payload, "ready-duplicate");
    queue.seedUnsafeMessageForTests(payload);

    const staleWorkflow = (await store.getWorkflow(workflow.id))!;
    staleWorkflow.status = "dispatch_pending";
    staleWorkflow.currentPhase = "website_research";
    const consumer = new WorkflowQueueConsumer(store, queue, { now: () => now, batchSize: 2 });
    await consumer.consume();
    now = new Date(now.getTime() + 2_000);
    await consumer.consume();

    const detailAfter = (await store.getWorkflowDetail(workflow.id))!;
    expect(detailAfter.workflow).toMatchObject({
      status: "ready_for_search_intelligence",
      currentPhase: "search_intelligence"
    });
    expect(await store.getPublicProgress(reportRequestId)).toEqual(progressBefore);
    expect(detailAfter.attempts).toEqual(detailBefore.attempts);
    expect(detailAfter.costEntries).toEqual(detailBefore.costEntries);
    expect(detailAfter.events.filter((event) => event.eventType === "step_succeeded")).toHaveLength(8);
    expect(detailAfter.events.filter((event) => event.eventType === "workflow_queue_state_reconciled")).toHaveLength(1);
    expect(queue.snapshot().messages.every((message) => message.archived)).toBe(true);
    expect(queue.snapshot().deadLetters).toHaveLength(0);
  });

  it("reconciles pending and retry-eligible work while preserving administrator and terminal states", async () => {
    const { store, workflow } = await setup();
    const detail = (await store.getWorkflowDetail(workflow.id))!;
    const firstStep = detail.steps[0]!;

    workflow.status = "ready_for_search_intelligence";
    workflow.currentPhase = "search_intelligence";
    expect(await store.reconcileQueueState(workflow.id, start.toISOString())).toMatchObject({
      status: "dispatch_pending",
      currentPhase: "initialize_workflow"
    });

    firstStep.status = "retry_scheduled";
    firstStep.scheduledAt = new Date(start.getTime() + 60_000).toISOString();
    expect((await store.reconcileQueueState(workflow.id, start.toISOString())).status).toBe("waiting_retry");
    expect((await store.reconcileQueueState(
      workflow.id,
      new Date(start.getTime() + 60_001).toISOString()
    )).status).toBe("dispatch_pending");

    for (const status of ["paused", "cancelled", "failed", "completed", "partially_complete"] as WorkflowStatus[]) {
      workflow.status = status;
      expect((await store.reconcileQueueState(workflow.id, start.toISOString())).status).toBe(status);
    }

    firstStep.status = "failed_terminal";
    workflow.status = "running";
    expect((await store.reconcileQueueState(workflow.id, start.toISOString())).status).toBe("failed");
  });

  it("archives completed and partially complete duplicate deliveries without executing steps", async () => {
    for (const status of ["completed", "partially_complete"] as WorkflowStatus[]) {
      resetMemoryWorkflowStoreForTests();
      const { store, workflow, payload } = await setup();
      workflow.status = status;
      const queue = new MemoryWorkflowQueue(() => start);
      await queue.enqueue(payload, `protected-${status}`);
      const result = await new WorkflowQueueConsumer(store, queue, { now: () => start }).consume();

      expect(result.archived).toBe(1);
      expect((await store.getWorkflow(workflow.id))?.status).toBe(status);
      expect((await store.getWorkflowDetail(workflow.id))!.attempts).toHaveLength(0);
      expect(queue.snapshot().messages[0]?.archived).toBe(true);
    }
  });

  it("defers transient failures, exhausts retries, and records one safe dead letter", async () => {
    let now = start;
    const { store, workflow, payload } = await setup();
    const queue = new MemoryWorkflowQueue(() => now);
    await queue.enqueue(payload, "transient");
    const runner = failingRunner(store, () => now, "transient");
    const consumer = new WorkflowQueueConsumer(store, queue, { now: () => now, runner });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await consumer.consume();
      now = new Date(now.getTime() + 2_000);
    }

    expect((await store.getWorkflow(workflow.id))?.status).toBe("failed");
    expect(queue.snapshot().deadLetters).toHaveLength(1);
    expect(queue.snapshot().deadLetters[0]).toMatchObject({
      workflowId: workflow.id,
      classification: "transient",
      attemptCount: 4
    });
    expect(JSON.stringify(queue.snapshot().deadLetters)).not.toContain("provider raw error");
  });

  it("dead-letters permanent failure without retrying", async () => {
    const { store, workflow, payload } = await setup();
    const queue = new MemoryWorkflowQueue(() => start);
    await queue.enqueue(payload, "permanent");
    const consumer = new WorkflowQueueConsumer(store, queue, {
      now: () => start,
      runner: failingRunner(store, () => start, "permanent")
    });

    const result = await consumer.consume();
    expect(result.deadLettered).toBe(1);
    expect((await store.getWorkflow(workflow.id))?.status).toBe("failed");
    expect(queue.snapshot().messages[0]?.archived).toBe(true);
  });

  it("does no paid work for paused or cancelled workflows", async () => {
    const actor = { actorId: "queue-test-admin", authenticated: true as const };
    const paused = await setup();
    const pausedQueue = new MemoryWorkflowQueue(() => start);
    await pausedQueue.enqueue(paused.payload, "paused");
    await paused.store.pauseWorkflow(paused.workflow.id, actor, start.toISOString());
    await new WorkflowQueueConsumer(paused.store, pausedQueue, { now: () => start }).consume();
    expect((await paused.store.getWorkflowDetail(paused.workflow.id))!.steps.every((step) => step.attemptCount === 0)).toBe(true);
    expect(pausedQueue.snapshot().messages[0]?.archived).toBe(true);

    resetMemoryWorkflowStoreForTests();
    const cancelled = await setup();
    const cancelledQueue = new MemoryWorkflowQueue(() => start);
    await cancelledQueue.enqueue(cancelled.payload, "cancelled");
    await cancelled.store.cancelWorkflow(cancelled.workflow.id, actor, start.toISOString());
    await new WorkflowQueueConsumer(cancelled.store, cancelledQueue, { now: () => start }).consume();
    expect((await cancelled.store.getWorkflowDetail(cancelled.workflow.id))!.steps.every((step) => step.attemptCount === 0)).toBe(true);
  });

  it("handles immediate and scheduled wakeup collisions with one lease owner", async () => {
    const { store, workflow, payload } = await setup();
    const queue = new MemoryWorkflowQueue(() => start);
    await queue.enqueue(payload, "collision");
    const first = new WorkflowQueueConsumer(store, queue, { now: () => start });
    const second = new WorkflowQueueConsumer(store, queue, { now: () => start });

    const results = await Promise.all([first.consume(), second.consume()]);
    expect(results.reduce((sum, result) => sum + result.received, 0)).toBe(1);
    expect((await store.getWorkflowDetail(workflow.id))!.steps[0]?.attemptCount).toBe(1);
  });

  it("authenticates wakeups with a separate HMAC and rejects replay", async () => {
    const secret = "queue-wakeup-secret-that-is-longer-than-thirty-two-characters";
    const queue = new MemoryWorkflowQueue(() => start);
    const headers = createWorkflowWakeupHeaders(secret, { now: start, nonce: "nonce_123456789012345678901234" });
    const request = () => new Request(`https://preview.example${WORKFLOW_WAKEUP_PATH}`, { method: "POST", headers });

    expect(await verifyWorkflowWakeupRequest(request(), queue, { secret, ttlSeconds: 300, now: start })).toBe(true);
    expect(await verifyWorkflowWakeupRequest(request(), queue, { secret, ttlSeconds: 300, now: start })).toBe(false);
    expect(await verifyWorkflowWakeupRequest(new Request(`https://preview.example${WORKFLOW_WAKEUP_PATH}`, { method: "POST" }), queue, { secret, ttlSeconds: 300, now: start })).toBe(false);

    const expiredHeaders = createWorkflowWakeupHeaders(secret, {
      now: new Date(start.getTime() - 301_000),
      nonce: "expired_123456789012345678901234"
    });
    expect(await verifyWorkflowWakeupRequest(new Request(`https://preview.example${WORKFLOW_WAKEUP_PATH}`, {
      method: "POST",
      headers: expiredHeaders
    }), queue, { secret, ttlSeconds: 300, now: start })).toBe(false);

    const malformedHeaders = new Headers(createWorkflowWakeupHeaders(secret, {
      now: start,
      nonce: "malformed_123456789012345678901"
    }));
    malformedHeaders.set(WORKFLOW_WAKEUP_SIGNATURE_HEADER, "not-a-signature");
    expect(await verifyWorkflowWakeupRequest(new Request(`https://preview.example${WORKFLOW_WAKEUP_PATH}`, {
      method: "POST",
      headers: malformedHeaders
    }), queue, { secret, ttlSeconds: 300, now: start })).toBe(false);

    expect(await verifyWorkflowWakeupRequest(new Request(`https://preview.example${WORKFLOW_WAKEUP_PATH}`, {
      method: "GET",
      headers: createWorkflowWakeupHeaders(secret, {
        now: start,
        nonce: "wrong_method_123456789012345678"
      })
    }), queue, { secret, ttlSeconds: 300, now: start })).toBe(false);
  });

});

async function setup() {
  const store = new MemoryWorkflowStore();
  const workflow = await store.createInitialWorkflow({
    reportRequestId,
    reportId,
    inputHash: "a".repeat(64),
    correlationId,
    orchestratorBackend: "deterministic"
  }, start.toISOString());
  const payload = store.snapshot().outbox[0]!.payload;
  return { store, workflow, payload };
}

async function advanceToSearchIntelligence(
  store: MemoryWorkflowStore,
  workflowId: string,
  now: () => Date
) {
  for (const stepKey of ALL_WORKFLOW_STEPS.slice(0, 5)) {
    await completeMemoryStep(store, workflowId, stepKey, now);
  }
  await store.prepareProviderResearchContinuation({
    workflowId,
    websiteEstimatedCostCents: 0,
    profileEstimatedCostCents: 0,
    queryEstimatedCostCents: 0,
    maximumAttempts: 4,
    now: now().toISOString()
  });
  for (const stepKey of ALL_WORKFLOW_STEPS.slice(5)) {
    await completeMemoryStep(store, workflowId, stepKey, now);
  }
}

async function completeMemoryStep(
  store: MemoryWorkflowStore,
  workflowId: string,
  stepKey: WorkflowStepKey,
  now: () => Date
) {
  const owner = `queue-test:${stepKey}`;
  const lease = await store.beginStep({
    workflowId,
    stepKey,
    owner,
    leaseSeconds: 120,
    now: now().toISOString()
  });
  expect(lease.disposition).toBe("acquired");
  expect(lease.lease).not.toBeNull();
  expect(await store.completeStep({
    workflowId,
    stepKey,
    owner,
    fencingToken: lease.lease!.fencingToken,
    outputReference: `queue-test:${stepKey}`,
    now: now().toISOString()
  })).toBe(true);
}

function failingRunner(
  store: MemoryWorkflowStore,
  now: () => Date,
  classification: FailureClassification
) {
  return {
    async runStep(workflowId: string, stepKey: WorkflowStepKey, owner: string) {
      const lease = await store.beginStep({
        workflowId,
        stepKey,
        owner,
        leaseSeconds: 60,
        now: now().toISOString()
      });
      if (lease.disposition !== "acquired" || !lease.lease) return "unavailable" as const;
      await store.failStep({
        workflowId,
        stepKey,
        owner,
        fencingToken: lease.lease.fencingToken,
        classification,
        safeCode: "safe_failure",
        safeSummary: "Safe failure.",
        retryAt: now().toISOString(),
        now: now().toISOString()
      });
      throw classification === "transient" ? new TypeError("provider raw error") : new Error("provider raw error");
    }
  };
}
