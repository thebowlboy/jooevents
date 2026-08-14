import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';
import { issueSynchronousClassifiedPayloadEncryptionProfile } from '@jooevents/application/synchronous-classified-payload-store';
import type { ChangesetCommitTerminalReceipt } from '@jooevents/changeset-operations';
import {
  FAKE_PROVIDER_SCENARIO_KEYS,
  OutboundEmailDeliveryWorkerError,
  buildCommunicationMessageRelease,
  createDeterministicFakeEmailProvider,
  createOutboundEmailDeliveryWorker,
  type CommunicationMessageRelease
} from '@jooevents/communications';
import {
  sendMessagesAuthorInputSchema,
  type SendMessagesAuthorInput,
  type SendMessagesReleaseSpec
} from '@jooevents/communication-operations';
import { canonicalJsonText, parseEventId, parseInstant, parseWorkspaceId } from '@jooevents/kernel';
import {
  installSQLiteClassifiedPayloadStoreSchema,
  SQLiteClassifiedPayloadStore
} from '../sqlite-classified-payload-store';
import { installSQLiteChangesetLifecycleSchema } from '../changeset-lifecycle';
import { installFoundationTrialUnitOfWorkSchema } from '../foundation-trial-uow';
import {
  installSQLiteOutboundEmailDeliverySchema,
  insertOutboundEmailDeliveryRegistration,
  SQLiteOutboundEmailDeliveryLedger
} from '../outbound-email-delivery';
import { installSQLiteOrganizerAudiencePreviewSchema } from './audience-preview';
import {
  createSQLiteOutboundEmailEnvelopeResolver,
  installSQLiteCommunicationMessageReleaseSchema,
  SQLiteCommunicationMessageReleaseStore
} from './message-releases';
import {
  CommunicationReleasePlanningError,
  commitSendMessagesChangeset,
  createSQLiteCommunicationReleaseChangesetOwnerRegistration,
  installCommunicationReleaseChangesetSchema
} from './message-release-effect-domain';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa141');
const now = parseInstant('2026-08-14T10:00:00.000Z');
const batchId = 'batch.decision-notification.2026-08-14';
const audienceSpecId = `aud1_${'a'.repeat(40)}`;
const previewDigestSha256 = 'e'.repeat(64);
const draftId = '019c1df7-86b5-769b-bba4-5f7097bfaa43';

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonText(value), 'utf8').digest('hex');
}

const sender = Object.freeze({
  fromAddress: 'organizer@jooevents.example',
  fromDisplayName: 'JooEvents Organizers',
  senderProfileRevisionId: 'sender.profile.rev-1',
  senderPresentationContractKey: 'sender.presentation.email-v1',
  senderPresentationContractVersion: 1,
  senderPresentationDigestSha256: digest({ sender: 'presentation-v1' })
});

const RECIPIENTS = Object.freeze([
  { name: 'ada', email: 'ada@example.org' },
  { name: 'grace', email: 'grace@example.org' },
  { name: 'nova', email: 'nova@example.org' }
]);

const databases: Database[] = [];
afterEach(() => {
  for (const sqlite of databases.splice(0)) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    sqlite.close(false);
  }
});

function uuid(suffix: number): string {
  return `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
}

const purposeRevision = Object.freeze({
  purposeId: uuid(0x600),
  purposeKey: 'decision_notification',
  revisionId: uuid(0x601),
  revisionNumber: 1,
  digestSha256: digest({ purpose: 'decision_notification' })
});

/** Review evidence the adopted snapshot's stored summary attests. */
const storedPreviewEvidence = Object.freeze({
  membershipDigestSha256: digest({ membership: 1 }),
  evidenceDigestSha256: digest({ evidence: 1 }),
  sourceVersions: Object.freeze([Object.freeze({
    sourceKey: 'decision-set.accepted',
    sourceVersion: 3,
    digestSha256: digest({ heads: 1 })
  })])
});

const storedSummary = Object.freeze({
  schemaVersion: 1,
  identity: {
    audienceSpecId,
    draftId,
    draftVersion: 1,
    previewGeneration: 1,
    previewDigestProfile: 'communication.preview.sha256',
    previewDigestVersion: 1,
    previewDigestSha256
  },
  purposeRevision,
  counts: { visibleCandidateCount: 3, includedCount: 3, excludedCount: 0, blockedCount: 0 },
  membershipDigestSha256: storedPreviewEvidence.membershipDigestSha256,
  evidenceDigestSha256: storedPreviewEvidence.evidenceDigestSha256,
  reasonCodes: [],
  sourceVersions: storedPreviewEvidence.sourceVersions,
  renderer: {
    reference: { key: 'renderer.communication.plain-text', version: 1 },
    definitionDigestSha256: digest({ kind: 'plain_text', version: 1 })
  },
  mergeRegistry: {
    reference: { key: 'merge-registry.communication.plain-text', version: 1 },
    definitionDigestSha256: digest({ registry: 'plain-text' })
  }
});

function count(sqlite: Database, table: string): number {
  return sqlite.query<{ readonly count: number }, []>(
    `SELECT count(*) AS count FROM ${table}`
  ).get()?.count ?? -1;
}

function transaction<Result>(sqlite: Database, work: () => Result): Result {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    const result = work();
    sqlite.exec('COMMIT;');
    return result;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}

function fixture() {
  const sqlite = new Database(':memory:', { strict: true });
  databases.push(sqlite);
  installSQLiteClassifiedPayloadStoreSchema(sqlite);
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installSQLiteOrganizerAudiencePreviewSchema(sqlite);
  installSQLiteCommunicationMessageReleaseSchema(sqlite);
  installSQLiteOutboundEmailDeliverySchema(sqlite);
  installCommunicationReleaseChangesetSchema(sqlite);
  sqlite.exec('PRAGMA foreign_keys = OFF');
  sqlite.query(`
    INSERT INTO communication_message_preview_snapshots (
      workspace_id, event_id, owner_key, audience_spec_id, draft_id, draft_version,
      preview_generation, preview_digest_profile, preview_digest_version,
      preview_digest_sha256, guard_digest_sha256, summary_json, snapshot_payload_ref_id,
      snapshot_byte_size, snapshot_digest_sha256, created_at
    ) VALUES (?, ?, ?, ?, ?, 1, 1, 'communication.preview.sha256', 1, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    workspaceId, eventId, 'workspace_user:sender', audienceSpecId, draftId,
    previewDigestSha256, 'f'.repeat(64), canonicalJsonText(storedSummary), uuid(0xf0),
    'a'.repeat(64), now
  );
  sqlite.exec('PRAGMA foreign_keys = ON');
  let nonceSeed = 1;
  const classifiedStore = new SQLiteClassifiedPayloadStore(sqlite, {
    encryptionProfile: issueSynchronousClassifiedPayloadEncryptionProfile({
      reference: { key: 'encryption.message-release-test', version: 1 },
      keyBytes: new Uint8Array(32).fill(0x51)
    }),
    nonceSource(size) {
      const nonce = Uint8Array.from({ length: size }, (_, index) => (nonceSeed + index * 19) % 256);
      nonceSeed += 1;
      return nonce;
    }
  });
  let payloadSeq = 0x100;
  const releases = new SQLiteCommunicationMessageReleaseStore(sqlite, classifiedStore, {
    newEnvelopePayloadRefId: () => uuid((payloadSeq += 1))
  });
  return { sqlite, classifiedStore, releases };
}

function materialized(index: number): CommunicationMessageRelease {
  const recipient = RECIPIENTS[index]!;
  return buildCommunicationMessageRelease({
    workspaceId,
    eventId,
    releaseId: `mrel1.${recipient.name}`,
    batchId,
    recipientRefId: `rr1_${digest({ recipient: recipient.name }).slice(0, 30)}`,
    personRefId: uuid(0x200 + index),
    contactRefId: `submission-contact:${uuid(0x300 + index)}`,
    templateRevisionRefId: uuid(0x400),
    contentRefId: uuid(0x401),
    purposeKey: 'decision_notification',
    reviewedMessageDigestSha256: digest({ message: recipient.name }),
    sender,
    toAddress: recipient.email,
    subject: 'Your submission decision',
    textBody: `Hello ${recipient.name}, your submission was accepted.`,
    createdAt: now
  });
}

function specFor(
  release: CommunicationMessageRelease,
  index: number,
  overrides: Partial<SendMessagesReleaseSpec> = {}
): SendMessagesReleaseSpec {
  return {
    releaseId: release.releaseId,
    deliveryId: uuid(0x500 + index),
    recipientRefId: release.recipientRefId,
    personRefId: release.personRefId,
    contactRefId: release.contactRefId,
    templateRevisionRefId: release.templateRevisionRefId,
    contentRefId: release.contentRefId,
    reviewedMessageDigestSha256: release.reviewedMessageDigestSha256,
    reviewedEnvelopeDigestSha256: release.reviewedEnvelopeDigestSha256,
    providerConnectionRevisionId: 'provider.connection.rev-1',
    externalDeliveryKey: FAKE_PROVIDER_SCENARIO_KEYS.ordinary.rejectedTerminal,
    senderProfileRevisionId: sender.senderProfileRevisionId,
    senderPresentationContractKey: sender.senderPresentationContractKey,
    senderPresentationContractVersion: sender.senderPresentationContractVersion,
    senderPresentationDigestSha256: sender.senderPresentationDigestSha256,
    channelAddressId: `addr1_${digest({ address: release.releaseId }).slice(0, 30)}`,
    channelAddressVersion: 1,
    addressLookupFingerprintProfile: 'communication.address-fingerprint.hmac-sha256',
    addressLookupFingerprintVersion: 1,
    addressLookupFingerprintSha256: digest({ fingerprint: release.releaseId }),
    ...overrides
  };
}

interface PreviewEvidenceOverrides {
  readonly membershipDigestSha256?: string;
  readonly evidenceDigestSha256?: string;
  readonly sourceVersions?: readonly {
    readonly sourceKey: string;
    readonly sourceVersion: number;
    readonly digestSha256: string;
  }[];
}

function authorInput(
  specs: readonly SendMessagesReleaseSpec[],
  previewGeneration = 1,
  evidence: PreviewEvidenceOverrides = {}
): SendMessagesAuthorInput {
  return sendMessagesAuthorInputSchema.parse({
    schemaVersion: 1,
    action: 'send',
    scope: { workspaceId, eventId },
    batchId,
    purposeRevision,
    subject: 'Your submission decision',
    audienceLabel: 'Accepted submissions',
    preview: {
      identity: {
        audienceSpecId,
        draftId,
        draftVersion: 1,
        previewGeneration,
        previewDigestProfile: 'communication.preview.sha256',
        previewDigestVersion: 1,
        previewDigestSha256
      },
      membershipDigestSha256:
        evidence.membershipDigestSha256 ?? storedPreviewEvidence.membershipDigestSha256,
      evidenceDigestSha256:
        evidence.evidenceDigestSha256 ?? storedPreviewEvidence.evidenceDigestSha256,
      sourceVersions: evidence.sourceVersions ?? storedPreviewEvidence.sourceVersions
    },
    releases: [...specs].sort((left, right) => left.releaseId < right.releaseId ? -1 : 1),
    requestedAt: now
  });
}

const receiptExpectation = Object.freeze({
  surface: 'operator_http' as const,
  scopePartitionKey: '6'.repeat(64),
  requestHashSha256: '7'.repeat(64)
});
const authorityPrincipalKey = '5'.repeat(64);

function terminalReceiptFactory(sqlite: Database, receiptId: string) {
  return (binding: {
    readonly changesetId: string;
    readonly expectedHeadVersion: number;
    readonly committedHeadVersion: number;
    readonly revisionId: string;
    readonly revisionDigest: string;
  }): ChangesetCommitTerminalReceipt => {
    const receipt = {
      id: receiptId,
      operationName: 'changeset.commit',
      operationVersion: 1
    } as const;
    const value: ChangesetCommitTerminalReceipt = {
      ref: receipt,
      identity: {
        scopePartitionKey: receiptExpectation.scopePartitionKey,
        authorityPrincipalKey,
        operationName: 'changeset.commit',
        operationVersion: 1,
        surface: receiptExpectation.surface,
        idempotencyVerifierProfile: { key: 'changeset.commit.idempotency', version: 1 },
        idempotencyKeyVerifier: digest({ receiptId })
      },
      requestHash: receiptExpectation.requestHashSha256,
      result: {
        kind: 'success',
        data: {
          schemaVersion: 1,
          action: 'commit',
          changesetId: binding.changesetId,
          expectedHeadVersion: binding.expectedHeadVersion,
          committedHeadVersion: binding.committedHeadVersion,
          revisionId: binding.revisionId,
          revisionDigest: binding.revisionDigest
        },
        receipt,
        correlationId: uuid(0x700)
      }
    };
    // Mirror the foundation unit of work: the durable operation receipt row
    // exists in the same transaction before the lifecycle store verifies it.
    sqlite.query(`
      INSERT INTO foundation_trial_operation_receipts (
        id, scope_partition_key, authority_principal_key, operation_name, operation_version,
        surface, idempotency_verifier_profile_key, idempotency_verifier_profile_version,
        idempotency_key_verifier, request_hash, result_json
      ) VALUES (?, ?, ?, 'changeset.commit', 1, ?, 'changeset.commit.idempotency', 1, ?, ?, ?)
    `).run(
      receiptId, receiptExpectation.scopePartitionKey, authorityPrincipalKey,
      receiptExpectation.surface, digest({ receiptId }), receiptExpectation.requestHashSha256,
      canonicalJsonText(value.result)
    );
    return value;
  };
}

function commitIds(prefix: number) {
  let sequence = 0;
  return {
    newChangesetId: () => uuid(prefix + (sequence += 1)),
    newRevisionId: () => uuid(prefix + (sequence += 1)),
    newApprovalId: () => uuid(prefix + (sequence += 1)),
    newCorrectionAttemptId: () => uuid(prefix + (sequence += 1)),
    newEvidenceId: () => uuid(prefix + (sequence += 1))
  };
}

/** Unit-test currency stub; the full-stack probe is proven in decision-audience.test.ts. */
function currencyStub(verdict: 'current' | 'stale') {
  return Object.freeze({
    checkAdoptedPreviewCurrency: () => verdict
  });
}

function commit(input: ReturnType<typeof fixture>, options: {
  readonly specs: readonly SendMessagesReleaseSpec[];
  readonly materializedReleases: readonly CommunicationMessageRelease[];
  readonly receiptId?: string;
  readonly idPrefix?: number;
  readonly previewGeneration?: number;
  readonly evidence?: PreviewEvidenceOverrides;
  readonly currency?: 'current' | 'stale';
}) {
  return transaction(input.sqlite, () => commitSendMessagesChangeset({
    sqlite: input.sqlite,
    releases: input.releases,
    previewCurrency: currencyStub(options.currency ?? 'current'),
    ids: commitIds(options.idPrefix ?? 0x800),
    context: {
      workspaceId,
      eventId,
      principalKey: 'workspace_user:sender',
      authorityPrincipalKey,
      evaluatedAt: now
    },
    authorInput: authorInput(options.specs, options.previewGeneration ?? 1, options.evidence ?? {}),
    materializedReleases: options.materializedReleases,
    receiptExpectation,
    terminalReceipt: terminalReceiptFactory(input.sqlite, options.receiptId ?? uuid(0x900))
  }));
}

describe('send_messages atomic commit and the immutable release store', () => {
  test('one commit writes releases, effect specs, ledger registrations, and evidence atomically', async () => {
    const input = fixture();
    const releases = [materialized(0), materialized(1), materialized(2)];
    const specs = releases.map((release, index) => specFor(release, index));
    const outcome = commit(input, { specs, materializedReleases: releases });
    expect(outcome).toMatchObject({
      kind: 'committed',
      result: { batchId, dispatchGeneration: 1, releaseCount: 3 }
    });
    expect(count(input.sqlite, 'communication_message_releases')).toBe(3);
    expect(count(input.sqlite, 'communication_release_effect_specs')).toBe(3);
    expect(count(input.sqlite, 'communication_release_receipt_links')).toBe(1);
    expect(count(input.sqlite, 'communication_outbound_delivery_heads')).toBe(3);
    expect(count(input.sqlite, 'communication_outbound_delivery_facts')).toBe(3);
    expect(count(input.sqlite, 'communication_outbound_delivery_outbox')).toBe(3);
    expect(count(input.sqlite, 'communication_outbound_delivery_history')).toBe(3);
    const heads = input.sqlite.query<{
      readonly state: string; readonly dispatch_generation: number; readonly receipt_id: string | null;
    }, []>(
      'SELECT state, dispatch_generation, receipt_id FROM communication_outbound_delivery_heads'
    ).all();
    expect(heads).toHaveLength(3);
    for (const head of heads) {
      expect(head.state).toBe('pending');
      expect(head.dispatch_generation).toBe(1);
      expect(head.receipt_id).not.toBeNull();
    }
    // The committed changeset record is readable through the lifecycle owner registration.
    const registration = createSQLiteCommunicationReleaseChangesetOwnerRegistration({
      sqlite: input.sqlite,
      workspaceId
    });
    const committed = outcome as Extract<typeof outcome, { kind: 'committed' }>;
    expect(committed.record.head.status).toBe('committed');
    expect(registration.ownerId).toBe('communication_release');
    expect(await registration.ownerResolution.resolveOwner(committed.record)).toMatchObject({
      id: 'communication_release'
    });
  });

  test('a mid-transaction failure rolls the whole send commit back', () => {
    const input = fixture();
    const releases = [materialized(0), materialized(1)];
    const specs = releases.map((release, index) => specFor(release, index));
    expect(() => transaction(input.sqlite, () => {
      const outcome = commitSendMessagesChangeset({
        sqlite: input.sqlite,
        releases: input.releases,
        previewCurrency: currencyStub('current'),
        ids: commitIds(0x810),
        context: {
          workspaceId,
          eventId,
          principalKey: 'workspace_user:sender',
          authorityPrincipalKey,
          evaluatedAt: now
        },
        authorInput: authorInput(specs),
        materializedReleases: releases,
        receiptExpectation,
        terminalReceipt: terminalReceiptFactory(input.sqlite, uuid(0x901))
      });
      expect(outcome.kind).toBe('committed');
      throw new Error('late failure');
    })).toThrow('late failure');
    expect(count(input.sqlite, 'communication_message_releases')).toBe(0);
    expect(count(input.sqlite, 'communication_release_effect_specs')).toBe(0);
    expect(count(input.sqlite, 'communication_outbound_delivery_heads')).toBe(0);
    expect(count(input.sqlite, 'changeset_heads')).toBe(0);
    expect(count(input.sqlite, 'classified_payload_records')).toBe(0);
  });

  test('a changed preview refuses the send before any write', () => {
    const input = fixture();
    const releases = [materialized(0)];
    const specs = releases.map((release, index) => specFor(release, index));
    // The plan pins generation 2, while the adopted snapshot pin is generation 1.
    expect(() => commit(input, { specs, materializedReleases: releases, previewGeneration: 2 }))
      .toThrow(new CommunicationReleasePlanningError('preview_changed'));
    expect(count(input.sqlite, 'communication_message_releases')).toBe(0);
    expect(count(input.sqlite, 'communication_outbound_delivery_heads')).toBe(0);
  });

  test('a stale live preview refuses the commit with the declared typed outcome', () => {
    const input = fixture();
    const releases = [materialized(0)];
    const specs = releases.map((release, index) => specFor(release, index));
    // The plan matches the adopted row exactly; only the live domain drifted.
    // The refusal must be the declared outcome — the engine parses its detail
    // against the declared safe-diff schema, so this also proves the outcome
    // declaration is producible rather than a TypeError at emission.
    const outcome = commit(input, { specs, materializedReleases: releases, currency: 'stale' });
    expect(outcome).toMatchObject({
      kind: 'refused',
      refusal: {
        class: 'stale_revision',
        kind: 'communication.preview_changed',
        retryable: false,
        subjects: [{ type: 'communication_preview', id: audienceSpecId }],
        detailSchemaVersion: 1,
        detail: {
          schemaVersion: 1,
          action: 'send',
          batchId,
          includedCount: 1,
          irreversibleExternalEffectCount: 1,
          previewIdentity: { audienceSpecId, previewGeneration: 1 }
        }
      }
    });
    expect(count(input.sqlite, 'communication_message_releases')).toBe(0);
    expect(count(input.sqlite, 'communication_release_effect_specs')).toBe(0);
    expect(count(input.sqlite, 'communication_release_receipt_links')).toBe(0);
    expect(count(input.sqlite, 'communication_outbound_delivery_heads')).toBe(0);
  });

  test('forged review evidence that never belonged to the adopted preview refuses the send', () => {
    const input = fixture();
    const releases = [materialized(0)];
    const specs = releases.map((release, index) => specFor(release, index));
    expect(() => commit(input, {
      specs,
      materializedReleases: releases,
      evidence: { membershipDigestSha256: digest({ membership: 'forged' }) }
    })).toThrow(new CommunicationReleasePlanningError('preview_changed'));
    expect(() => commit(input, {
      specs,
      materializedReleases: releases,
      evidence: {
        sourceVersions: [{
          sourceKey: 'decision-set.accepted',
          sourceVersion: 99,
          digestSha256: digest({ heads: 99 })
        }]
      }
    })).toThrow(new CommunicationReleasePlanningError('preview_changed'));
    expect(count(input.sqlite, 'communication_message_releases')).toBe(0);
    expect(count(input.sqlite, 'communication_outbound_delivery_heads')).toBe(0);
    expect(count(input.sqlite, 'changeset_heads')).toBe(0);
  });

  test('a reused delivery identity with different work refuses and rolls back', () => {
    const input = fixture();
    const releases = [materialized(0)];
    const specs = releases.map((release, index) => specFor(release, index));
    commit(input, { specs, materializedReleases: releases });
    const second = materialized(1);
    const conflicting = specFor(second, 9, { deliveryId: specs[0]!.deliveryId });
    expect(() => commit(input, {
      specs: [conflicting],
      materializedReleases: [second],
      idPrefix: 0x820,
      receiptId: uuid(0x902)
    })).toThrow(new CommunicationReleasePlanningError('delivery_identity_changed'));
    expect(count(input.sqlite, 'communication_message_releases')).toBe(1);
    expect(count(input.sqlite, 'communication_outbound_delivery_heads')).toBe(1);
  });

  test('dispatch resolves one release to its generation-1 delivery and stays honestly not-delivered', async () => {
    const input = fixture();
    const releases = [materialized(0), materialized(1), materialized(2)];
    const specs = releases.map((release, index) => specFor(release, index));
    commit(input, { specs, materializedReleases: releases });
    let attemptSeq = 0xa00;
    const worker = createOutboundEmailDeliveryWorker({
      ledger: new SQLiteOutboundEmailDeliveryLedger(input.sqlite, {
        newFactId: () => uuid((attemptSeq += 1)),
        newPointerId: () => uuid((attemptSeq += 1)),
        newHistoryId: () => uuid((attemptSeq += 1))
      }),
      provider: createDeterministicFakeEmailProvider().delivery,
      envelopes: createSQLiteOutboundEmailEnvelopeResolver(input.releases),
      ids: { newAttemptId: () => uuid((attemptSeq += 1)) },
      clock: { now: () => now }
    });
    const result = await worker.dispatch({ deliveryId: specs[0]!.deliveryId });
    // The deterministic fake refuses terminally, so nothing was delivered and
    // the ledger records exactly that — the un-notified indicator stays honest.
    expect(result).toMatchObject({
      state: 'known_rejected_terminal',
      followUp: 'complete'
    });
    const head = input.sqlite.query<{ readonly state: string }, [string]>(
      'SELECT state FROM communication_outbound_delivery_heads WHERE delivery_id = ?'
    ).get(specs[0]!.deliveryId);
    expect(head?.state).toBe('known_rejected_terminal');
  });

  test('reviewed_envelope_changed revalidation compares against the stored release', async () => {
    const input = fixture();
    const releases = [materialized(0)];
    const specs = releases.map((release, index) => specFor(release, index));
    commit(input, { specs, materializedReleases: releases });
    transaction(input.sqlite, () => insertOutboundEmailDeliveryRegistration({
      sqlite: input.sqlite,
      workspaceId,
      eventId,
      work: (() => {
        const spec = specFor(releases[0]!, 3, {
          deliveryId: uuid(0x510),
          reviewedEnvelopeDigestSha256: digest({ tampered: true })
        });
        return {
          contractVersion: 1,
          deliveryId: spec.deliveryId,
          releaseId: spec.releaseId,
          dispatchGeneration: 2,
          reviewedMessageDigestSha256: spec.reviewedMessageDigestSha256,
          reviewedEnvelopeDigestSha256: spec.reviewedEnvelopeDigestSha256,
          recipientRefId: spec.recipientRefId,
          templateRevisionRefId: spec.templateRevisionRefId,
          contentRefId: spec.contentRefId,
          providerConnectionRevisionId: spec.providerConnectionRevisionId,
          externalDeliveryKey: spec.externalDeliveryKey,
          senderProfileRevisionId: spec.senderProfileRevisionId,
          senderPresentationContractKey: spec.senderPresentationContractKey,
          senderPresentationContractVersion: spec.senderPresentationContractVersion,
          senderPresentationDigestSha256: spec.senderPresentationDigestSha256,
          channelAddressId: spec.channelAddressId,
          channelAddressVersion: spec.channelAddressVersion,
          addressLookupFingerprintProfile: spec.addressLookupFingerprintProfile,
          addressLookupFingerprintVersion: spec.addressLookupFingerprintVersion,
          addressLookupFingerprintSha256: spec.addressLookupFingerprintSha256
        };
      })(),
      evidence: {
        rootFactId: uuid(0x511),
        rootPointerId: uuid(0x512),
        historyThreadId: uuid(0x513),
        rootHistoryId: uuid(0x514)
      },
      createdAt: now
    }));
    let attemptSeq = 0xb00;
    const worker = createOutboundEmailDeliveryWorker({
      ledger: new SQLiteOutboundEmailDeliveryLedger(input.sqlite, {
        newFactId: () => uuid((attemptSeq += 1)),
        newPointerId: () => uuid((attemptSeq += 1)),
        newHistoryId: () => uuid((attemptSeq += 1))
      }),
      provider: createDeterministicFakeEmailProvider().delivery,
      envelopes: createSQLiteOutboundEmailEnvelopeResolver(input.releases),
      ids: { newAttemptId: () => uuid((attemptSeq += 1)) },
      clock: { now: () => now }
    });
    await expect(worker.dispatch({ deliveryId: uuid(0x510) }))
      .rejects.toThrow(new OutboundEmailDeliveryWorkerError('reviewed_envelope_changed'));
  });

  test('the 10k audience cap holds at the plan boundary', () => {
    const base = specFor(materialized(0), 0);
    const releases = Array.from({ length: 10_001 }, (_, index) => ({
      ...base,
      releaseId: `mrel1.cap.${index.toString().padStart(5, '0')}`,
      deliveryId: uuid(0x10000 + index),
      recipientRefId: `rr1_${digest({ cap: index }).slice(0, 30)}`
    }));
    expect(() => authorInput(releases)).toThrow();
  });

  test('classified recipient addresses never land in ordinary rows', () => {
    const input = fixture();
    const releases = [materialized(0), materialized(1), materialized(2)];
    const specs = releases.map((release, index) => specFor(release, index));
    commit(input, { specs, materializedReleases: releases });
    const bytes = Buffer.from(input.sqlite.serialize());
    for (const recipient of RECIPIENTS) {
      expect(bytes.includes(Buffer.from(recipient.email))).toBe(false);
    }
  });
});
