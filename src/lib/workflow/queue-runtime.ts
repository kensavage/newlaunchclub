import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  WORKFLOW_MESSAGE_TYPE,
  workflowQueuePayloadSchema,
  type FailureClassification,
  type WorkflowQueuePayload
} from "@/lib/workflow/schema";

export const WORKFLOW_QUEUE_PAYLOAD_LIMIT_BYTES = 32_768;

export interface WorkflowQueueMessage {
  messageId: string;
  readCount: number;
  enqueuedAt: string;
  visibleAt: string;
  payload: unknown;
}

export interface WorkflowQueueDeadLetterInput {
  messageId: string;
  workflowId: string | null;
  classification: FailureClassification;
  readCount: number;
  attemptCount: number;
  lastSafeError: string;
  failedAt?: string;
}

export interface WorkflowQueue {
  enqueue(payload: WorkflowQueuePayload, idempotencyKey: string): Promise<{ messageId: string }>;
  read(input: { batchSize: number; visibilityTimeoutSeconds: number }): Promise<WorkflowQueueMessage[]>;
  archive(messageId: string): Promise<boolean>;
  release(messageId: string, delaySeconds: number): Promise<boolean>;
  deadLetter(input: WorkflowQueueDeadLetterInput): Promise<boolean>;
  consumeWakeupNonce(input: { nonceHash: string; expiresAt: string; now?: string }): Promise<boolean>;
}

export function parseWorkflowQueuePayload(payload: unknown): WorkflowQueuePayload {
  assertWorkflowQueuePayloadSize(payload);
  return workflowQueuePayloadSchema.parse(payload);
}

export function assertWorkflowQueuePayloadSize(
  payload: unknown,
  maximumBytes = WORKFLOW_QUEUE_PAYLOAD_LIMIT_BYTES
) {
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (bytes > maximumBytes) throw new Error("Workflow queue payload exceeds the identifier-only limit.");
  return bytes;
}

export class SupabaseWorkflowQueue implements WorkflowQueue {
  constructor(private readonly supabase: SupabaseClient) {}

  static fromEnv({ url, serviceRoleKey }: { url: string; serviceRoleKey: string }) {
    return new SupabaseWorkflowQueue(
      createClient(url, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false }
      })
    );
  }

  async enqueue(payload: WorkflowQueuePayload, idempotencyKey: string) {
    const validated = parseWorkflowQueuePayload(payload);
    const result = await this.rpc<{ messageId: string }>("enqueue_v3_workflow_message", {
      p_payload: validated,
      p_idempotency_key: idempotencyKey,
      p_now: validated.requestedAt
    });
    return result;
  }

  async read({ batchSize, visibilityTimeoutSeconds }: { batchSize: number; visibilityTimeoutSeconds: number }) {
    return this.rpc<WorkflowQueueMessage[]>("read_v3_workflow_messages", {
      p_batch_size: batchSize,
      p_visibility_timeout_seconds: visibilityTimeoutSeconds
    });
  }

  async archive(messageId: string) {
    return this.rpc<boolean>("archive_v3_workflow_message", { p_message_id: messageId });
  }

  async release(messageId: string, delaySeconds: number) {
    return this.rpc<boolean>("release_v3_workflow_message", {
      p_message_id: messageId,
      p_delay_seconds: Math.max(0, Math.ceil(delaySeconds))
    });
  }

  async deadLetter(input: WorkflowQueueDeadLetterInput) {
    return this.rpc<boolean>("dead_letter_v3_workflow_message", {
      p_message_id: input.messageId,
      p_workflow_id: input.workflowId,
      p_classification: input.classification,
      p_read_count: input.readCount,
      p_attempt_count: input.attemptCount,
      p_last_safe_error: input.lastSafeError,
      p_failed_at: input.failedAt ?? new Date().toISOString()
    });
  }

  async consumeWakeupNonce({ nonceHash, expiresAt, now = new Date().toISOString() }: {
    nonceHash: string;
    expiresAt: string;
    now?: string;
  }) {
    return this.rpc<boolean>("consume_v3_workflow_wakeup_nonce", {
      p_nonce_hash: nonceHash,
      p_expires_at: expiresAt,
      p_now: now
    });
  }

  private async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.supabase.rpc(name, args);
    if (error) throw new Error(`Workflow queue operation failed: ${name}.`);
    return data as T;
  }
}

interface MemoryQueueRecord extends WorkflowQueueMessage {
  idempotencyKey: string;
  archived: boolean;
}

export class MemoryWorkflowQueue implements WorkflowQueue {
  private readonly messages: MemoryQueueRecord[] = [];
  private readonly deadLetters: WorkflowQueueDeadLetterInput[] = [];
  private readonly nonces = new Map<string, string>();
  private nextMessageId = 1;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async enqueue(payload: WorkflowQueuePayload, idempotencyKey: string) {
    const validated = parseWorkflowQueuePayload(payload);
    const duplicate = this.messages.find((message) => message.idempotencyKey === idempotencyKey);
    if (duplicate) return { messageId: duplicate.messageId };
    const timestamp = this.now().toISOString();
    const message: MemoryQueueRecord = {
      messageId: String(this.nextMessageId++),
      readCount: 0,
      enqueuedAt: timestamp,
      visibleAt: timestamp,
      payload: validated,
      idempotencyKey,
      archived: false
    };
    this.messages.push(message);
    return { messageId: message.messageId };
  }

  async read({ batchSize, visibilityTimeoutSeconds }: { batchSize: number; visibilityTimeoutSeconds: number }) {
    const now = this.now();
    const visible = this.messages
      .filter((message) => !message.archived && Date.parse(message.visibleAt) <= now.getTime())
      .slice(0, batchSize);
    for (const message of visible) {
      message.readCount += 1;
      message.visibleAt = new Date(now.getTime() + visibilityTimeoutSeconds * 1_000).toISOString();
    }
    return visible.map((message) => ({
      messageId: message.messageId,
      readCount: message.readCount,
      enqueuedAt: message.enqueuedAt,
      visibleAt: message.visibleAt,
      payload: message.payload
    }));
  }

  async archive(messageId: string) {
    const message = this.messages.find((item) => item.messageId === messageId && !item.archived);
    if (!message) return false;
    message.archived = true;
    return true;
  }

  async release(messageId: string, delaySeconds: number) {
    const message = this.messages.find((item) => item.messageId === messageId && !item.archived);
    if (!message) return false;
    message.visibleAt = new Date(this.now().getTime() + Math.max(0, delaySeconds) * 1_000).toISOString();
    return true;
  }

  async deadLetter(input: WorkflowQueueDeadLetterInput) {
    if (!this.deadLetters.some((deadLetter) => deadLetter.messageId === input.messageId)) {
      this.deadLetters.push({ ...input, failedAt: input.failedAt ?? this.now().toISOString() });
    }
    return this.archive(input.messageId);
  }

  async consumeWakeupNonce({ nonceHash, expiresAt, now = this.now().toISOString() }: {
    nonceHash: string;
    expiresAt: string;
    now?: string;
  }) {
    for (const [hash, expiry] of this.nonces) {
      if (Date.parse(expiry) <= Date.parse(now)) this.nonces.delete(hash);
    }
    if (this.nonces.has(nonceHash)) return false;
    this.nonces.set(nonceHash, expiresAt);
    return true;
  }

  seedUnsafeMessageForTests(payload: unknown) {
    const timestamp = this.now().toISOString();
    const messageId = String(this.nextMessageId++);
    this.messages.push({
      messageId,
      readCount: 0,
      enqueuedAt: timestamp,
      visibleAt: timestamp,
      payload,
      idempotencyKey: `unsafe:${messageId}`,
      archived: false
    });
    return messageId;
  }

  snapshot() {
    return {
      messages: this.messages.map((message) => ({ ...message })),
      deadLetters: this.deadLetters.map((deadLetter) => ({ ...deadLetter }))
    };
  }
}

export function workflowQueueIdempotencyKey(payload: WorkflowQueuePayload, reason = "initial") {
  return `${WORKFLOW_MESSAGE_TYPE}:${payload.workflowId}:${payload.workflowVersion}:${reason}`;
}
