import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  applyEngagementSeedFrom,
  deterministicEngagementId,
  planEngagementSeedFrom
} from '@jooevents/engagement';
import {
  DEFAULT_FILE_UPLOAD_LIMITS,
  NONE_SCAN_PROVIDER,
  applyFileScanVerdict,
  attachFileAsset,
  attachFileLink,
  confirmFileUpload,
  createFileRequest,
  createResourceShare,
  detachFileAttachment,
  fulfillFileRequest,
  registerFileUploadIntent,
  revokeResourceShare,
  sweepOrphanFileBlobs,
  type FileBlobStreamingStore
} from '@jooevents/files';
import { parseEventId, parseInstant, parseUserId, parseWorkspaceId } from '@jooevents/kernel';
import {
  createProgramReferenceContributorRegistry,
  planProgramVocabularyMutation
} from '@jooevents/program';
import { planSessionMutation } from '@jooevents/session';
import { installDeadlineSchema } from './deadline';
import { installEventSpineSchema } from './event-spine';
import { installFilesSchema, SQLiteFilesError, SQLiteFilesRepository } from './files';
import {
  createSQLiteProgramVocabularyContributorAdapterRegistry,
  installProgramVocabularySchema,
  SQLiteProgramVocabularyRepository
} from './program-vocabulary';
import { installSessionSchema, SQLiteSessionRepository } from './session';
import { installEngagementSchema, SQLiteEngagementRepository } from './engagement';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfb101');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfb201');
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfb301';
const formatId = '019c1df7-86b5-769b-bba4-5f7097bfb401';
const personA = '019c1df7-86b5-769b-bba4-5f7097bfb501';
const submissionA = '019c1df7-86b5-769b-bba4-5f7097bfb601';
const now = parseInstant('2026-08-14T08:00:00.000Z');
const later = parseInstant('2026-08-14T09:00:00.000Z');
const scope = { workspaceId, eventId };
const speaker = Object.freeze({
  kind: 'participant' as const,
  participantIdentityId: '019c1df7-86b5-769b-bba4-5f7097bfb701'
});

let uuidTail = 0;
function newId(): string {
  uuidTail += 1;
  return `019c1df7-86b5-769b-bba4-${uuidTail.toString(16).padStart(12, '0')}`;
}

class MemoryBlobs implements FileBlobStreamingStore {
  readonly provider = 'filesystem';
  readonly objects = new Map<string, Uint8Array>();
  async writeStream(input: {
    readonly key: string;
    readonly bytes: AsyncIterable<Uint8Array>;
    readonly maximumByteSize: number;
  }) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of input.bytes) {
      total += chunk.byteLength;
      if (total > input.maximumByteSize) {
        return { kind: 'refused' as const, code: 'byte_cap_exceeded' as const };
      }
      chunks.push(chunk);
    }
    if (total === 0) return { kind: 'refused' as const, code: 'empty_stream' as const };
    const merged = Buffer.concat(chunks);
    this.objects.set(input.key, Uint8Array.from(merged));
    const hash = new Bun.CryptoHasher('sha256');
    hash.update(merged);
    return {
      kind: 'stored' as const,
      byteSize: total,
      sha256: hash.digest('hex')
    };
  }
  async openReadStream(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return { kind: 'missing' as const };
    async function* one() { yield bytes!; }
    return { kind: 'found' as const, byteSize: bytes.byteLength, bytes: one() };
  }
  async deleteObject(key: string) {
    return { deleted: this.objects.delete(key) };
  }
}

function fixture() {
  const sqlite = new Database(':memory:', { strict: true });
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
  `);
  installEventSpineSchema(sqlite);
  installDeadlineSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installSessionSchema(sqlite);
  installEngagementSchema(sqlite);
  sqlite.exec(`
    CREATE TABLE intake_submission_heads (
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, event_id, submission_id)
    ) STRICT, WITHOUT ROWID;
  `);
  installFilesSchema(sqlite);
  sqlite.query(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, 'Workspace', 'active', 1, 1, 1)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', 'Operator', 1, 1, 1)
  `).run(userId);
  sqlite.query(`
    INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
    VALUES (?, 1, null)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Event', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)
  `).run(workspaceId, eventId, userId, Date.parse(now), 'a'.repeat(64));
  sqlite.query(`INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)`)
    .run(workspaceId, eventId);

  const referenceRegistry = createProgramReferenceContributorRegistry({
    expected: [], contributors: []
  });
  const adapterRegistry = createSQLiteProgramVocabularyContributorAdapterRegistry({
    sqlite, expected: [], adapters: []
  });
  const program = new SQLiteProgramVocabularyRepository(
    sqlite, referenceRegistry, adapterRegistry,
    () => ({ actorUserId: userId, occurredAt: now })
  );
  const state = program.readVocabulary(scope)!;
  const vocabularyPlan = planProgramVocabularyMutation({
    state,
    referenceRegistry,
    referenceSource: program,
    authorInput: {
      action: 'create', scope, expectedSetVersion: state.setVersion,
      item: { kind: 'format', id: formatId, name: 'Talk' }
    }
  });
  sqlite.exec('BEGIN IMMEDIATE;');
  program.applyVocabularyPlan(vocabularyPlan);
  sqlite.exec('COMMIT;');
  const sessions = new SQLiteSessionRepository(sqlite, program);
  const catalog = sessions.readSessionCatalog(scope)!;
  const sessionPlan = planSessionMutation({
    catalog,
    vocabulary: sessions.readSessionVocabulary(scope)!,
    planningInput: {
      action: 'create', scope, sessionId, actorUserId: userId, occurredAt: now,
      expectedCatalogVersion: catalog.version,
      expectedCatalogDigestSha256: catalog.digestSha256,
      title: 'Seeded Panel', plannedDurationMinutes: 60,
      lifecycle: 'collecting', formatId, trackId: null
    }
  });
  sqlite.exec('BEGIN IMMEDIATE;');
  sessions.applySessionPlan(sessionPlan);
  sqlite.exec('COMMIT;');

  const engagements = new SQLiteEngagementRepository(sqlite);
  const seed = planEngagementSeedFrom(engagements, {
    scope,
    sessionId,
    submissionId: submissionA,
    seededByDecision: { version: 1, digestSha256: 'e'.repeat(64) },
    source: { kind: 'submission', id: submissionA, version: 7 },
    personIds: [personA],
    invitedAt: now,
    respondBy: null
  } as Parameters<typeof planEngagementSeedFrom>[1]);
  sqlite.exec('BEGIN IMMEDIATE;');
  applyEngagementSeedFrom(engagements, seed);
  sqlite.exec('COMMIT;');
  const engagementId = deterministicEngagementId(scope, sessionId, personA);
  sqlite.query(`
    INSERT INTO intake_submission_heads (workspace_id, event_id, submission_id)
    VALUES (?, ?, ?)
  `).run(workspaceId, eventId, submissionA);

  const files = new SQLiteFilesRepository(sqlite);
  return { sqlite, files, engagementId };
}

function transacted<Value>(sqlite: Database, work: () => Value): Value {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    const value = work();
    sqlite.exec('COMMIT;');
    return value;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}

async function uploadedAsset(fx: ReturnType<typeof fixture>, blobs: MemoryBlobs) {
  const { streamFileUploadBytes } = await import('@jooevents/files');
  const intentId = newId();
  const registered = transacted(fx.sqlite, () => registerFileUploadIntent({
    scope, uploader: speaker,
    registration: {
      intentId, purpose: 'engagement_material', displayFilename: 'deck.pdf',
      contentType: 'application/pdf', declaredByteSize: 9
    },
    limits: DEFAULT_FILE_UPLOAD_LIMITS,
    usage: fx.files,
    intents: fx.files,
    storageProvider: 'filesystem',
    now
  }));
  if (registered.kind !== 'registered') throw new Error('expected registration');
  fx.sqlite.exec('BEGIN IMMEDIATE;');
  const streamed = await streamFileUploadBytes({
    intents: fx.files, intent: registered.intent,
    bytes: (async function* () { yield new TextEncoder().encode('deck data'); })(),
    blobs, now
  });
  fx.sqlite.exec('COMMIT;');
  if (streamed.kind !== 'stored') throw new Error('expected stored');
  const assetId = newId();
  const confirmed = transacted(fx.sqlite, () => confirmFileUpload({
    intents: fx.files, assets: fx.files, scanProvider: NONE_SCAN_PROVIDER,
    intent: streamed.intent,
    confirmation: { intentId, assetId, sha256: streamed.intent.storedSha256! },
    now
  }));
  if (confirmed.kind !== 'confirmed') throw new Error('expected confirmation');
  return confirmed.asset;
}

describe('SQLite files persistence', () => {
  test('the full upload → attach → request → fulfil loop persists through the repository ports', async () => {
    const fx = fixture();
    const blobs = new MemoryBlobs();
    const asset = await uploadedAsset(fx, blobs);
    expect(fx.files.readAsset(scope, asset.id)).toEqual(asset);
    expect(fx.files.readUploaderStoredBytes(scope, speaker, asset.createdAt)).toBe(asset.byteSize);

    const attachmentId = newId();
    const attached = transacted(fx.sqlite, () => attachFileAsset({
      scope,
      attach: {
        attachmentId,
        subject: { kind: 'engagement', engagementId: fx.engagementId },
        assetId: asset.id
      },
      actor: speaker,
      attachments: fx.files,
      assets: fx.files,
      subjects: fx.files,
      now
    }));
    if (attached.kind !== 'attached') throw new Error('expected attach');
    expect(fx.files.countLiveAssetReferences(scope, asset.id)).toBe(1);
    expect(fx.files.listAttachmentsForSubject(
      scope, { kind: 'engagement', engagementId: fx.engagementId }
    )).toEqual([attached.attachment]);

    const requestId = newId();
    const request = transacted(fx.sqlite, () => createFileRequest({
      scope,
      create: {
        requestId, engagementId: fx.engagementId,
        what: 'Final deck', instructions: null, deadlineId: null
      },
      createdByUserId: userId,
      requests: fx.files,
      engagements: fx.files,
      deadlines: { resolveCurrentDeadline: () => undefined },
      now
    }));
    if (request.kind !== 'created') throw new Error('expected request');

    const fulfilled = transacted(fx.sqlite, () => fulfillFileRequest({
      scope,
      fulfill: { requestId, attachmentId, expectedVersion: 1 },
      requests: fx.files,
      attachments: fx.files,
      now: later
    }));
    if (fulfilled.kind !== 'fulfilled') throw new Error('expected fulfilment');
    expect(fx.files.readFileRequest(scope, requestId)).toEqual(fulfilled.request);
    expect(fx.files.listFileRequestsForEngagement(scope, fx.engagementId))
      .toEqual([fulfilled.request]);
  });

  test('subject existence resolves against the owning aggregates', () => {
    const fx = fixture();
    expect(fx.files.subjectExists(
      scope, { kind: 'engagement', engagementId: fx.engagementId }
    )).toBe(true);
    expect(fx.files.subjectExists(
      scope, { kind: 'engagement', engagementId: newId() }
    )).toBe(false);
    expect(fx.files.subjectExists(
      scope, { kind: 'submission', submissionId: submissionA }
    )).toBe(true);
    expect(fx.files.subjectExists(
      scope, { kind: 'submission', submissionId: newId() }
    )).toBe(false);
    expect(fx.files.subjectExists(scope, { kind: 'session', sessionId })).toBe(true);
    expect(fx.files.subjectExists(scope, { kind: 'session', sessionId: newId() })).toBe(false);
    expect(fx.files.readEngagementState(scope, fx.engagementId)).toBe('invited');
    expect(fx.files.readEngagementState(scope, newId())).toBeUndefined();
  });

  test('link attachments persist verbatim and resource shares transition under version guards', () => {
    const fx = fixture();
    const attachmentId = newId();
    const link = {
      provider: 'drive' as const,
      label: 'Live doc',
      url: 'https://drive.google.com/x'
    };
    const attached = transacted(fx.sqlite, () => attachFileLink({
      scope,
      attach: {
        attachmentId,
        subject: { kind: 'engagement', engagementId: fx.engagementId },
        link
      },
      actor: speaker,
      attachments: fx.files,
      subjects: fx.files,
      now
    }));
    if (attached.kind !== 'attached') throw new Error('expected link attach');
    expect(fx.files.readAttachment(scope, attachmentId)?.content)
      .toEqual({ kind: 'link', link });

    const resourceShareId = newId();
    const created = transacted(fx.sqlite, () => createResourceShare({
      scope,
      create: { resourceShareId, title: 'AV guide', audience: { kind: 'all_confirmed' } },
      createdByUserId: userId,
      shares: fx.files,
      audiences: { trackExists: () => true, engagementExists: () => true },
      now
    }));
    if (created.kind !== 'created') throw new Error('expected share');
    expect(fx.files.subjectExists(scope, { kind: 'resource_share', resourceShareId })).toBe(true);
    const revoked = transacted(fx.sqlite, () => revokeResourceShare({
      scope,
      revoke: { resourceShareId, expectedVersion: 1 },
      shares: fx.files,
      now: later
    }));
    if (revoked.kind !== 'revoked') throw new Error('expected revocation');
    expect(fx.files.readResourceShare(scope, resourceShareId)?.state).toBe('revoked');
  });

  test('scan verdict transitions are version-guarded and drift refuses', async () => {
    const fx = fixture();
    const blobs = new MemoryBlobs();
    const asset = await uploadedAsset(fx, blobs);
    // Simulate a pending asset: rewrite through the guarded transition first.
    const pending = {
      ...asset,
      lifecycle: 'pending_scan' as const,
      scan: { provider: 'clamav', verdict: 'pending' as const, checkedAt: null },
      version: asset.version + 1,
      updatedAt: later
    };
    transacted(fx.sqlite, () => fx.files.transitionAsset({ expected: asset, next: pending }));
    const released = applyFileScanVerdict({ asset: pending, verdict: 'released', at: later });
    transacted(fx.sqlite, () => fx.files.transitionAsset({ expected: pending, next: released }));
    expect(fx.files.readAsset(scope, asset.id)?.lifecycle).toBe('available');
    expect(() => transacted(fx.sqlite, () => fx.files.transitionAsset({
      expected: pending, next: released
    }))).toThrow(SQLiteFilesError);
  });

  test('writes outside a transaction refuse and duplicate ids refuse', async () => {
    const fx = fixture();
    const blobs = new MemoryBlobs();
    const asset = await uploadedAsset(fx, blobs);
    expect(() => fx.files.createAsset(asset)).toThrow('transaction_required');
    expect(() => transacted(fx.sqlite, () => fx.files.createAsset(asset)))
      .toThrow('duplicate_row');
  });

  test('the physical schema pins immutability and coherence', async () => {
    const fx = fixture();
    const blobs = new MemoryBlobs();
    const asset = await uploadedAsset(fx, blobs);
    // Identity columns are trigger-frozen.
    expect(() => fx.sqlite.query(`
      UPDATE file_assets SET sha256 = ? WHERE id = ?
    `).run('b'.repeat(64), asset.id)).toThrow('file asset identity is immutable');
    // A blocked lifecycle without a blocked verdict violates the CHECK.
    expect(() => fx.sqlite.query(`
      UPDATE file_assets SET lifecycle = 'blocked' WHERE id = ?
    `).run(asset.id)).toThrow();
    // An attachment to a nonexistent asset violates the FK.
    expect(() => transacted(fx.sqlite, () => fx.files.createAttachment({
      schemaVersion: 1,
      id: newId(),
      scope,
      subject: { kind: 'engagement', engagementId: fx.engagementId },
      content: { kind: 'asset', assetId: newId() },
      attachedBy: speaker,
      state: 'attached',
      version: 1,
      attachedAt: now,
      detachedAt: null
    }))).toThrow('scope_corrupt');
  });

  test('orphan sweep collects only unreferenced, aged assets and preserves referenced bytes (D7)', async () => {
    const fx = fixture();
    const blobs = new MemoryBlobs();
    const orphan = await uploadedAsset(fx, blobs);
    const kept = await uploadedAsset(fx, blobs);
    const attachmentId = newId();
    transacted(fx.sqlite, () => attachFileAsset({
      scope,
      attach: {
        attachmentId,
        subject: { kind: 'engagement', engagementId: fx.engagementId },
        assetId: kept.id
      },
      actor: speaker,
      attachments: fx.files,
      assets: fx.files,
      subjects: fx.files,
      now
    }));

    const eightDaysLater = new Date(Date.parse(now) + 8 * 24 * 60 * 60 * 1000).toISOString();
    fx.sqlite.exec('BEGIN IMMEDIATE;');
    const report = await sweepOrphanFileBlobs({
      port: fx.files, blobs, now: eightDaysLater
    });
    fx.sqlite.exec('COMMIT;');
    expect(report.collected).toEqual([{
      assetId: orphan.id,
      storageKey: orphan.storageKey,
      blobDeleted: true
    }]);
    expect(fx.files.readAsset(scope, orphan.id)).toBeUndefined();
    expect(fx.files.readAsset(scope, kept.id)).toEqual(kept);
    expect(blobs.objects.has(kept.storageKey)).toBe(true);

    // A detached attachment still pins record and bytes until the retention wave.
    transacted(fx.sqlite, () => detachFileAttachment({
      scope,
      detach: { attachmentId, expectedVersion: 1 },
      attachments: fx.files,
      now: later
    }));
    fx.sqlite.exec('BEGIN IMMEDIATE;');
    const second = await sweepOrphanFileBlobs({ port: fx.files, blobs, now: eightDaysLater });
    fx.sqlite.exec('COMMIT;');
    expect(second.collected).toEqual([]);
    expect(fx.files.readAsset(scope, kept.id)).toEqual(kept);
    expect(blobs.objects.has(kept.storageKey)).toBe(true);
  });

  test('a sweep inside its transaction never collects a freshly re-referenced asset', async () => {
    const fx = fixture();
    const blobs = new MemoryBlobs();
    const asset = await uploadedAsset(fx, blobs);
    const eightDaysLater = new Date(Date.parse(now) + 8 * 24 * 60 * 60 * 1000).toISOString();
    fx.sqlite.exec('BEGIN IMMEDIATE;');
    // The asset regains a reference between listing and deletion.
    const listed = fx.files.listCollectableAssets({
      asOf: eightDaysLater, graceMs: 7 * 24 * 60 * 60 * 1000, limit: 10
    });
    expect(listed.map((row) => row.id)).toEqual([asset.id]);
    attachFileAsset({
      scope,
      attach: {
        attachmentId: newId(),
        subject: { kind: 'engagement', engagementId: fx.engagementId },
        assetId: asset.id
      },
      actor: speaker,
      attachments: fx.files,
      assets: fx.files,
      subjects: fx.files,
      now
    });
    expect(fx.files.deleteAssetRecord({ assetId: asset.id, expectedVersion: asset.version }))
      .toBe(false);
    fx.sqlite.exec('COMMIT;');
    expect(fx.files.readAsset(scope, asset.id)).toEqual(asset);
  });
});
