import { transitionConnection, type ConnectionState } from './state';
import type { AirtableSyncJobWake } from './wake-adapters';

export interface AirtableConnectionControlRepository {
  read(connectionId: string): Promise<Readonly<{ state: ConnectionState; version: number }> | undefined>;
  transition(input: Readonly<{
    connectionId: string; expectedVersion: number; from: ConnectionState; to: ConnectionState; nowMs: number;
  }>): Promise<boolean>;
  scheduleReconciliation(input: Readonly<{
    connectionId: string; reason: 'manual' | 'reconnect' | 'disconnect'; nowMs: number;
  }>): Promise<void>;
}

export interface AirtableConnectionWakePublisher {
  publish(wake: AirtableSyncJobWake): Promise<void>;
}

export type AirtableConnectionControlResult =
  | { readonly kind: 'accepted'; readonly state: ConnectionState }
  | { readonly kind: 'refused'; readonly code: 'connection_missing' | 'stale_connection' | 'transition_not_allowed' };

export async function syncAirtableNow(input: Readonly<{
  connectionId: string; nowMs: number; wakeId: string;
  repository: AirtableConnectionControlRepository; publisher: AirtableConnectionWakePublisher;
}>): Promise<AirtableConnectionControlResult> {
  const current = await input.repository.read(input.connectionId);
  if (!current) return { kind: 'refused', code: 'connection_missing' };
  if (current.state !== 'active' && current.state !== 'paused') {
    return { kind: 'refused', code: 'transition_not_allowed' };
  }
  await input.repository.scheduleReconciliation({
    connectionId: input.connectionId, reason: 'manual', nowMs: input.nowMs
  });
  await input.publisher.publish({
    schemaVersion: 1, connectionId: input.connectionId, reason: 'reconciliation', wakeId: input.wakeId
  });
  return { kind: 'accepted', state: current.state };
}

export async function changeAirtableConnectionState(input: Readonly<{
  connectionId: string; expectedVersion: number; next: 'active' | 'paused' | 'disconnecting'; nowMs: number;
  repository: AirtableConnectionControlRepository;
}>): Promise<AirtableConnectionControlResult> {
  const current = await input.repository.read(input.connectionId);
  if (!current) return { kind: 'refused', code: 'connection_missing' };
  if (current.version !== input.expectedVersion) return { kind: 'refused', code: 'stale_connection' };
  const allowed = transitionConnection(current.state, input.next);
  if (allowed.kind === 'refused') return allowed;
  const committed = await input.repository.transition({
    connectionId: input.connectionId, expectedVersion: input.expectedVersion,
    from: current.state, to: input.next, nowMs: input.nowMs
  });
  if (!committed) return { kind: 'refused', code: 'stale_connection' };
  if (input.next === 'active' || input.next === 'disconnecting') {
    await input.repository.scheduleReconciliation({
      connectionId: input.connectionId,
      reason: input.next === 'active' ? 'reconnect' : 'disconnect', nowMs: input.nowMs
    });
  }
  return { kind: 'accepted', state: input.next };
}
