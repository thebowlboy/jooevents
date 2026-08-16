import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  createClassifiedPayloadProfileRef,
  type ClassifiedPayloadProfiles
} from '@jooevents/application';
import {
  adoptSynchronousClassifiedPayload,
  openSynchronousClassifiedPayloadAdoptionReceipt,
  type SynchronousClassifiedPayloadBinding,
  type SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  CommunicationMessageReleaseError,
  createReleaseStoreOutboundEmailEnvelopeResolver,
  parseCommunicationMessageRelease,
  type CommunicationMessageRelease,
  type CommunicationMessageReleaseStore,
  type OutboundEmailEnvelopeResolver
} from '@jooevents/communications';
import {
  canonicalJsonText,
  createPayloadRef,
  parseInstant,
  parsePayloadRefId
} from '@jooevents/kernel';

/**
 * Immutable per-recipient message releases. Ordinary rows carry only opaque
 * references and digests; the reviewed envelope — the only place a recipient
 * address exists — lives as an encrypted classified payload. Releases are
 * written once inside the send commit transaction and never updated.
 */
export const SQLITE_COMMUNICATION_MESSAGE_RELEASES_SQL = `
CREATE TABLE communication_message_releases (
  release_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  recipient_ref_id TEXT NOT NULL,
  person_ref_id TEXT NOT NULL,
  contact_ref_id TEXT NOT NULL,
  template_revision_ref_id TEXT NOT NULL,
  content_ref_id TEXT NOT NULL,
  purpose_key TEXT NOT NULL,
  reviewed_message_digest_sha256 TEXT NOT NULL CHECK(length(reviewed_message_digest_sha256) = 64),
  reviewed_envelope_digest_sha256 TEXT NOT NULL CHECK(length(reviewed_envelope_digest_sha256) = 64),
  envelope_payload_ref_id TEXT NOT NULL REFERENCES classified_payload_records(payload_ref_id),
  envelope_byte_size INTEGER NOT NULL CHECK(envelope_byte_size > 0),
  envelope_digest_sha256 TEXT NOT NULL CHECK(length(envelope_digest_sha256) = 64),
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, event_id, batch_id, recipient_ref_id),
  UNIQUE(envelope_payload_ref_id)
) STRICT;

CREATE INDEX communication_message_releases_batch
  ON communication_message_releases(workspace_id, event_id, batch_id, release_id);

CREATE TRIGGER communication_message_releases_no_update
BEFORE UPDATE ON communication_message_releases
BEGIN SELECT RAISE(ABORT, 'communication message releases are immutable'); END;
CREATE TRIGGER communication_message_releases_no_delete
BEFORE DELETE ON communication_message_releases
BEGIN SELECT RAISE(ABORT, 'communication message releases are immutable'); END;
`;

export type SQLiteCommunicationMessageReleaseErrorCode =
  | 'transaction_required'
  | 'invalid_input'
  | 'data_corrupt';

export class SQLiteCommunicationMessageReleaseError extends Error {
  constructor(readonly code: SQLiteCommunicationMessageReleaseErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteCommunicationMessageReleaseError';
  }
}

export function installSQLiteCommunicationMessageReleaseSchema(sqlite: Database): void {
  if (sqlite.inTransaction) {
    throw new SQLiteCommunicationMessageReleaseError('transaction_required');
  }
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(SQLITE_COMMUNICATION_MESSAGE_RELEASES_SQL)).immediate();
}

function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function profiles(): ClassifiedPayloadProfiles {
  return Object.freeze({
    classification: createClassifiedPayloadProfileRef(
      'classification', 'classification.communication.message-release.envelope', 1
    ),
    schema: createClassifiedPayloadProfileRef(
      'schema', 'schema.communication.message-release.envelope', 1
    ),
    content: createClassifiedPayloadProfileRef(
      'content', 'content.communication.message-release.envelope', 1
    ),
    integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
    descriptorAuth: createClassifiedPayloadProfileRef(
      'descriptor_auth', 'descriptor_auth.communication.message-release', 1
    )
  });
}

function envelopeBinding(release: Pick<
  CommunicationMessageRelease,
  'workspaceId' | 'eventId' | 'batchId' | 'releaseId'
>): SynchronousClassifiedPayloadBinding {
  return Object.freeze({
    profiles: profiles(),
    scopeBinding: canonicalJsonText({
      workspaceId: release.workspaceId,
      eventId: release.eventId,
      batchId: release.batchId,
      releaseId: release.releaseId
    }),
    contentType: 'application/json'
  });
}

const ENVELOPE_PURPOSE = 'communication.message-release.envelope';

interface ReleaseRow {
  readonly release_id: string;
  readonly workspace_id: string;
  readonly event_id: string;
  readonly batch_id: string;
  readonly recipient_ref_id: string;
  readonly person_ref_id: string;
  readonly contact_ref_id: string;
  readonly template_revision_ref_id: string;
  readonly content_ref_id: string;
  readonly purpose_key: string;
  readonly reviewed_message_digest_sha256: string;
  readonly reviewed_envelope_digest_sha256: string;
  readonly envelope_payload_ref_id: string;
  readonly envelope_byte_size: number;
  readonly envelope_digest_sha256: string;
  readonly created_at: string;
}

const RELEASE_SELECT = `
SELECT release_id, workspace_id, event_id, batch_id, recipient_ref_id, person_ref_id,
       contact_ref_id, template_revision_ref_id, content_ref_id, purpose_key,
       reviewed_message_digest_sha256, reviewed_envelope_digest_sha256,
       envelope_payload_ref_id, envelope_byte_size, envelope_digest_sha256, created_at
  FROM communication_message_releases`;

export class SQLiteCommunicationMessageReleaseStore implements CommunicationMessageReleaseStore {
  constructor(
    private readonly sqlite: Database,
    private readonly classifiedStore: SynchronousClassifiedPayloadStore,
    private readonly ids: { newEnvelopePayloadRefId(): string }
  ) {}

  /** Caller owns the transaction: releases commit with the reviewed send batch or not at all. */
  put(candidate: CommunicationMessageRelease): void {
    if (!this.sqlite.inTransaction) {
      throw new SQLiteCommunicationMessageReleaseError('transaction_required');
    }
    const release = parseCommunicationMessageRelease(candidate);
    const existing = this.#row(release.releaseId);
    if (existing !== undefined) {
      const opened = this.#open(existing);
      if (canonicalJsonText(opened) !== canonicalJsonText(release)) {
        throw new CommunicationMessageReleaseError('release_conflict');
      }
      return;
    }
    const payloadRefId = parsePayloadRefId(this.ids.newEnvelopePayloadRefId());
    const bytes = new TextEncoder().encode(canonicalJsonText(release.envelope));
    try {
      const receipt = adoptSynchronousClassifiedPayload({
        store: this.classifiedStore,
        put: {
          payloadRefId,
          binding: envelopeBinding(release),
          purpose: ENVELOPE_PURPOSE,
          bytes,
          createdAt: parseInstant(release.createdAt)
        }
      });
      const adopted = openSynchronousClassifiedPayloadAdoptionReceipt({
        receipt,
        expectedStore: this.classifiedStore
      });
      if (adopted.payloadRef.id !== payloadRefId) {
        throw new SQLiteCommunicationMessageReleaseError('data_corrupt');
      }
      this.sqlite.query(`
        INSERT INTO communication_message_releases (
          release_id, workspace_id, event_id, batch_id, recipient_ref_id, person_ref_id,
          contact_ref_id, template_revision_ref_id, content_ref_id, purpose_key,
          reviewed_message_digest_sha256, reviewed_envelope_digest_sha256,
          envelope_payload_ref_id, envelope_byte_size, envelope_digest_sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        release.releaseId, release.workspaceId, release.eventId, release.batchId,
        release.recipientRefId, release.personRefId, release.contactRefId,
        release.templateRevisionRefId, release.contentRefId, release.purposeKey,
        release.reviewedMessageDigestSha256, release.reviewedEnvelopeDigestSha256,
        payloadRefId, bytes.byteLength, digestBytes(bytes), release.createdAt
      );
    } catch (error) {
      if (error instanceof SQLiteCommunicationMessageReleaseError
          || error instanceof CommunicationMessageReleaseError) throw error;
      throw new SQLiteCommunicationMessageReleaseError('data_corrupt', error);
    } finally {
      bytes.fill(0);
    }
  }

  read(releaseId: string): CommunicationMessageRelease | undefined {
    const row = this.#row(releaseId);
    return row === undefined ? undefined : this.#open(row);
  }

  listBatch(input: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly batchId: string;
  }): readonly Omit<CommunicationMessageRelease, 'envelope'>[] {
    const rows = this.sqlite.query<ReleaseRow, [string, string, string]>(`${RELEASE_SELECT}
      WHERE workspace_id = ? AND event_id = ? AND batch_id = ?
      ORDER BY release_id`).all(input.workspaceId, input.eventId, input.batchId);
    return Object.freeze(rows.map((row) => Object.freeze({
      contractVersion: 1 as const,
      workspaceId: row.workspace_id,
      eventId: row.event_id,
      releaseId: row.release_id,
      batchId: row.batch_id,
      recipientRefId: row.recipient_ref_id,
      personRefId: row.person_ref_id,
      contactRefId: row.contact_ref_id,
      templateRevisionRefId: row.template_revision_ref_id,
      contentRefId: row.content_ref_id,
      purposeKey: row.purpose_key,
      reviewedMessageDigestSha256: row.reviewed_message_digest_sha256,
      reviewedEnvelopeDigestSha256: row.reviewed_envelope_digest_sha256,
      createdAt: row.created_at
    })));
  }

  #row(releaseId: string): ReleaseRow | undefined {
    const rows = this.sqlite.query<ReleaseRow, [string]>(
      `${RELEASE_SELECT} WHERE release_id = ? LIMIT 2`
    ).all(releaseId);
    if (rows.length > 1) throw new SQLiteCommunicationMessageReleaseError('data_corrupt');
    return rows[0];
  }

  #open(row: ReleaseRow): CommunicationMessageRelease {
    let bytes: Uint8Array | undefined;
    try {
      bytes = this.classifiedStore.read({
        payloadRef: createPayloadRef(parsePayloadRefId(row.envelope_payload_ref_id)),
        expectedBinding: envelopeBinding({
          workspaceId: row.workspace_id,
          eventId: row.event_id,
          batchId: row.batch_id,
          releaseId: row.release_id
        }),
        purpose: ENVELOPE_PURPOSE
      });
      if (bytes.byteLength !== row.envelope_byte_size
          || digestBytes(bytes) !== row.envelope_digest_sha256) {
        throw new SQLiteCommunicationMessageReleaseError('data_corrupt');
      }
      const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      return parseCommunicationMessageRelease({
        contractVersion: 1,
        workspaceId: row.workspace_id,
        eventId: row.event_id,
        releaseId: row.release_id,
        batchId: row.batch_id,
        recipientRefId: row.recipient_ref_id,
        personRefId: row.person_ref_id,
        contactRefId: row.contact_ref_id,
        templateRevisionRefId: row.template_revision_ref_id,
        contentRefId: row.content_ref_id,
        purposeKey: row.purpose_key,
        reviewedMessageDigestSha256: row.reviewed_message_digest_sha256,
        reviewedEnvelopeDigestSha256: row.reviewed_envelope_digest_sha256,
        envelope,
        createdAt: row.created_at
      });
    } catch (error) {
      if (error instanceof SQLiteCommunicationMessageReleaseError
          || error instanceof CommunicationMessageReleaseError) throw error;
      throw new SQLiteCommunicationMessageReleaseError('data_corrupt', error);
    } finally {
      bytes?.fill(0);
    }
  }
}

/** The worker's envelope resolver over the durable release store. */
export function createSQLiteOutboundEmailEnvelopeResolver(
  store: SQLiteCommunicationMessageReleaseStore
): OutboundEmailEnvelopeResolver {
  return createReleaseStoreOutboundEmailEnvelopeResolver({ releases: store });
}
