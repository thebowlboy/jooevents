import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { computeSafeEvidenceDigestSha256, safeEvidenceSchema } from '@jooevents/contracts';
import { canonicalJsonText } from '@jooevents/kernel';
import {
  SQLiteCommunicationDeliveryObservationError,
  SQLiteCommunicationDeliveryObservationRepository
} from './delivery-observations';

const ids = Object.freeze({
  workspace: '019c3500-0000-7000-8000-000000000001',
  eventA: '019c3500-0000-7000-8000-000000000002',
  eventB: '019c3500-0000-7000-8000-000000000003',
  observation: '019c3500-0000-7000-8000-000000000004',
  otherWorkspace: '019c3500-0000-7000-8000-000000000005'
});
const digest = (value: string) => value.repeat(64);
const databases: Database[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close(false);
});

function evidence(observation: string) {
  const body = {
    contractVersion: 1 as const,
    schemaKey: 'je.communication.provider-safe-evidence' as const,
    schemaVersion: 1 as const,
    registeredCode: 'cloudflare.email.accepted' as never,
    correlationId: 'corr1_abcdefghijklmnopqrstuvwx',
    registeredFacts: [{
      factKey: 'cloudflare.observation' as never,
      factSchemaVersion: 1,
      valueKind: 'enum' as const,
      enumValue: observation as never
    }]
  };
  return safeEvidenceSchema.parse({
    ...body,
    canonicalDigestSha256: computeSafeEvidenceDigestSha256(body)
  });
}

function fixture() {
  const sqlite = new Database(':memory:', { strict: true });
  databases.push(sqlite);
  sqlite.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE workspaces (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE classified_payload_records (payload_ref_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE communication_channel_address_versions (
      workspace_id TEXT NOT NULL,event_id TEXT NOT NULL,address_ref_id TEXT NOT NULL,
      address_version INTEGER NOT NULL,PRIMARY KEY(workspace_id,event_id,address_ref_id,address_version)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE communication_outbound_delivery_heads (
      delivery_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,event_id TEXT NOT NULL,
      provider_connection_revision_id TEXT NOT NULL,
      address_lookup_fingerprint_profile TEXT NOT NULL,
      address_lookup_fingerprint_version INTEGER NOT NULL,
      address_lookup_fingerprint_sha256 TEXT NOT NULL,
      channel_address_id TEXT NOT NULL,channel_address_version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE communication_outbound_delivery_attempts (
      attempt_id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL,attempt_number INTEGER NOT NULL,
      attempt_kind TEXT NOT NULL,state TEXT NOT NULL,provider_message_id TEXT,
      safe_evidence_json TEXT,completed_at_ms INTEGER,
      FOREIGN KEY(delivery_id) REFERENCES communication_outbound_delivery_heads(delivery_id)
    ) STRICT;
  `);
  const migration = readFileSync(new URL(
    '../../../migrations/sqlite/e2_0014_communication_delivery_observations.sql',
    import.meta.url
  ), 'utf8');
  sqlite.exec(migration.slice(migration.indexOf('CREATE TABLE communication_delivery_observations')));
  sqlite.query('INSERT INTO workspaces(id) VALUES (?)').run(ids.workspace);
  sqlite.query(`
    INSERT INTO communication_channel_address_versions
      (workspace_id,event_id,address_ref_id,address_version) VALUES (?,?,?,1)
  `).run(ids.workspace, ids.eventA, 'address-old');
  sqlite.query(`
    INSERT INTO communication_outbound_delivery_heads (
      delivery_id,workspace_id,event_id,provider_connection_revision_id,
      address_lookup_fingerprint_profile,address_lookup_fingerprint_version,
      address_lookup_fingerprint_sha256,channel_address_id,channel_address_version
    ) VALUES ('delivery-1',?,?, 'connection-1','lookup.email',1,?,'address-old',1)
  `).run(ids.workspace, ids.eventA, digest('a'));
  return { sqlite, repository: new SQLiteCommunicationDeliveryObservationRepository(sqlite) };
}

function insertAttempt(sqlite: Database, input: {
  id: string; number: number; kind: 'original' | 'marked_resend'; observation: string;
  messageId: string; completedAt: number;
}) {
  sqlite.query(`
    INSERT INTO communication_outbound_delivery_attempts (
      attempt_id,delivery_id,attempt_number,attempt_kind,state,provider_message_id,
      safe_evidence_json,completed_at_ms
    ) VALUES (?,'delivery-1',?,?, 'accepted',?,?,?)
  `).run(
    input.id, input.number, input.kind, input.messageId,
    canonicalJsonText(evidence(input.observation)), input.completedAt
  );
}

describe('SQLite communication delivery observations', () => {
  test('pins an observation workspace and event to the delivery head scope', () => {
    const { sqlite, repository } = fixture();
    const append = (workspaceId: string, eventId: string) => sqlite.transaction(() =>
      repository.append({
        workspaceId,
        eventId,
        deliveryId: 'delivery-1',
        providerConnectionRevisionId: 'connection-1',
        adapterKey: 'cloudflare.email-service',
        providerEventKey: `scope-${workspaceId}-${eventId}`,
        kind: 'delivered',
        source: 'provider_lookup',
        quality: 'provider_conclusive',
        ingestedAt: '2026-08-18T12:00:00.000Z',
        safeEvidence: evidence('accepted_delivered')
      })
    )();

    expect(() => append(ids.workspace, ids.eventB)).toThrow(
      new SQLiteCommunicationDeliveryObservationError('delivery_not_found')
    );
    expect(() => append(ids.otherWorkspace, ids.eventA)).toThrow(
      new SQLiteCommunicationDeliveryObservationError('delivery_not_found')
    );
    expect(sqlite.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM communication_delivery_observations'
    ).get()).toEqual({ count: 0 });
  });

  test('proves a synchronous permanent bounce from the attempt with no observation row', () => {
    const { sqlite, repository } = fixture();
    insertAttempt(sqlite, {
      id: 'attempt-1', number: 1, kind: 'original',
      observation: 'accepted_permanent_bounce', messageId: 'provider-1', completedAt: 10
    });
    expect(sqlite.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM communication_delivery_observations'
    ).get()).toEqual({ count: 0 });
    expect(repository.currentDisposition('delivery-1')).toMatchObject({
      kind: 'permanent_bounce',
      attemptId: 'attempt-1',
      attemptNumber: 1,
      evidenceClass: 'submission_attempt'
    });
  });

  test('deduplicates poll and ingress identity, rejects changed reuse, and folds out of order', () => {
    const { sqlite, repository } = fixture();
    insertAttempt(sqlite, {
      id: 'attempt-1', number: 1, kind: 'original',
      observation: 'accepted_no_disposition', messageId: 'provider-1', completedAt: 10
    });
    const append = (kind: 'delivered' | 'permanent_bounce', key: string, observedAt: string) =>
      sqlite.transaction(() => repository.append({
        workspaceId: ids.workspace,
        eventId: ids.eventA,
        deliveryId: 'delivery-1',
        providerConnectionRevisionId: 'connection-1',
        adapterKey: 'cloudflare.email-service',
        providerMessageId: 'provider-1',
        providerEventKey: key,
        kind,
        source: 'provider_lookup',
        quality: 'provider_conclusive',
        providerObservedAt: observedAt,
        ingestedAt: '2026-08-18T12:00:00.000Z',
        safeEvidence: evidence(kind === 'delivered' ? 'accepted_delivered' : 'accepted_permanent_bounce')
      }))();
    expect(append('delivered', 'event-1', '2026-08-18T11:00:00.000Z').replayed).toBe(false);
    expect(append('delivered', 'event-1', '2026-08-18T11:00:00.000Z').replayed).toBe(true);
    expect(() => append('permanent_bounce', 'event-1', '2026-08-18T11:00:00.000Z'))
      .toThrow(SQLiteCommunicationDeliveryObservationError);
    append('permanent_bounce', 'event-2', '2026-08-18T10:00:00.000Z');
    expect(repository.currentDisposition('delivery-1')?.kind).toBe('permanent_bounce');
  });

  test('keeps the old address suppressed workspace-wide after correction and lets a later resend win', () => {
    const { sqlite, repository } = fixture();
    insertAttempt(sqlite, {
      id: 'attempt-1', number: 1, kind: 'original',
      observation: 'accepted_no_disposition', messageId: 'provider-1', completedAt: 10
    });
    sqlite.transaction(() => repository.append({
      workspaceId: ids.workspace,
      eventId: ids.eventA,
      deliveryId: 'delivery-1',
      providerConnectionRevisionId: 'connection-1',
      adapterKey: 'cloudflare.email-service',
      providerMessageId: 'provider-1',
      providerEventKey: 'bounce-1',
      kind: 'permanent_bounce',
      source: 'provider_lookup',
      quality: 'provider_conclusive',
      ingestedAt: '2026-08-18T12:00:00.000Z',
      safeEvidence: evidence('accepted_permanent_bounce')
    }))();
    expect(repository.isAddressSuppressed({
      workspaceId: ids.workspace,
      lookupProfile: 'lookup.email',
      lookupVersion: 1,
      lookupKeyedValue: digest('a')
    })).toBe(true);
    sqlite.query(`
      INSERT INTO communication_channel_address_versions
        (workspace_id,event_id,address_ref_id,address_version) VALUES (?,?,?,2)
    `).run(ids.workspace, ids.eventA, 'address-new');
    expect(repository.isAddressSuppressed({
      workspaceId: ids.workspace,
      lookupProfile: 'lookup.email',
      lookupVersion: 1,
      lookupKeyedValue: digest('b')
    })).toBe(false);
    insertAttempt(sqlite, {
      id: 'attempt-2', number: 2, kind: 'marked_resend',
      observation: 'accepted_delivered', messageId: 'provider-2', completedAt: 20
    });
    expect(repository.currentDisposition('delivery-1')).toMatchObject({
      kind: 'delivered', attemptNumber: 2, attemptKind: 'marked_resend'
    });
  });
});
