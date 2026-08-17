import { z } from 'zod';

export const AIRTABLE_SYNC_REGISTERED_JOB = Object.freeze({
  key: 'airtable.sync.connection',
  version: 1
} as const);

export const AIRTABLE_SYNC_WAKE_REASONS = [
  'outbound_projection',
  'inbound_cursor',
  'reconciliation',
  'renewal',
  'repair',
  'scheduled_discovery'
] as const;

export const airtableSyncWakeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  connectionId: z.string().min(1).max(160),
  reason: z.enum(AIRTABLE_SYNC_WAKE_REASONS),
  wakeId: z.string().min(1).max(360)
});

export type AirtableSyncJobWake = z.infer<typeof airtableSyncWakeSchema>;

export interface AirtableSyncRegisteredJobInvoker {
  run(input: Readonly<{
    job: typeof AIRTABLE_SYNC_REGISTERED_JOB;
    wake: AirtableSyncJobWake;
  }>): Promise<
    | { readonly kind: 'completed' | 'idle' | 'contended' | 'attention' }
    | { readonly kind: 'retry'; readonly retryAfterMs: number }
  >;
}

export interface AirtableDueConnectionDiscovery {
  listDue(input: Readonly<{
    nowMs: number;
    limit: number;
  }>): Promise<readonly string[]>;
}

export interface CloudflareQueueSender<Body> {
  send(body: Body, options?: Readonly<{
    contentType?: 'json';
    delaySeconds?: number;
  }>): Promise<unknown>;
}

export class CloudflareAirtableWakePublisher {
  constructor(private readonly queue: CloudflareQueueSender<AirtableSyncJobWake>) {}

  async publish(wake: AirtableSyncJobWake): Promise<void> {
    const parsed = airtableSyncWakeSchema.parse(wake);
    await this.queue.send(parsed, { contentType: 'json' });
  }
}

export interface CloudflareQueueMessage<Body> {
  readonly id: string;
  readonly body: Body;
  readonly attempts: number;
  ack(): void;
  retry(options?: Readonly<{ readonly delaySeconds?: number }>): void;
}

export interface CloudflareQueueBatch<Body> {
  readonly messages: readonly CloudflareQueueMessage<Body>[];
}

function retrySeconds(retryAfterMs: number, attempts: number): number {
  const requested = Math.ceil(retryAfterMs / 1_000);
  const fallback = Math.min(30 * (2 ** Math.min(attempts, 10)), 86_400);
  return Math.max(1, Math.min(requested || fallback, 86_400));
}

/**
 * Cloudflare Queue is a latency adapter only. Every message is explicitly acked or
 * retried; durable SQL work remains discoverable if infrastructure delivery dies.
 */
export async function consumeCloudflareAirtableWakeBatch(input: Readonly<{
  batch: CloudflareQueueBatch<unknown>;
  invoker: AirtableSyncRegisteredJobInvoker;
  onInvalidWake?: (input: Readonly<{ messageId: string }>) => void;
  onFailure?: (input: Readonly<{ messageId: string; error: unknown }>) => void;
}>): Promise<void> {
  for (const message of input.batch.messages) {
    const parsed = airtableSyncWakeSchema.safeParse(message.body);
    if (!parsed.success) {
      try { input.onInvalidWake?.({ messageId: message.id }); } catch { /* diagnostic only */ }
      message.ack();
      continue;
    }
    try {
      const result = await input.invoker.run({
        job: AIRTABLE_SYNC_REGISTERED_JOB,
        wake: parsed.data
      });
      if (result.kind === 'retry') {
        message.retry({ delaySeconds: retrySeconds(result.retryAfterMs, message.attempts) });
      } else {
        message.ack();
      }
    } catch (error) {
      try { input.onFailure?.({ messageId: message.id, error }); } catch { /* diagnostic only */ }
      message.retry({ delaySeconds: retrySeconds(30_000, message.attempts) });
    }
  }
}

export async function publishScheduledAirtableDiscovery(input: Readonly<{
  scheduledTime: number;
  discovery: AirtableDueConnectionDiscovery;
  publisher: { publish(wake: AirtableSyncJobWake): Promise<void> };
  limit?: number;
}>): Promise<number> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('airtable_scheduled_discovery_limit_invalid');
  }
  const connections = await input.discovery.listDue({ nowMs: input.scheduledTime, limit });
  for (const connectionId of connections) {
    await input.publisher.publish({
      schemaVersion: 1,
      connectionId,
      reason: 'scheduled_discovery',
      wakeId: `scheduled:${input.scheduledTime}:${connectionId}`
    });
  }
  return connections.length;
}

/** Portable single-machine cadence; it invokes the exact same registered job. */
export async function runBunAirtableDueLoopOnce(input: Readonly<{
  nowMs: number;
  discovery: AirtableDueConnectionDiscovery;
  invoker: AirtableSyncRegisteredJobInvoker;
  limit?: number;
}>): Promise<number> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('airtable_bun_discovery_limit_invalid');
  }
  const connections = await input.discovery.listDue({ nowMs: input.nowMs, limit });
  for (const connectionId of connections) {
    await input.invoker.run({
      job: AIRTABLE_SYNC_REGISTERED_JOB,
      wake: {
        schemaVersion: 1,
        connectionId,
        reason: 'scheduled_discovery',
        wakeId: `bun:${input.nowMs}:${connectionId}`
      }
    });
  }
  return connections.length;
}
