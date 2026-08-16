import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';
import { issueSynchronousClassifiedPayloadEncryptionProfile } from '@jooevents/application/synchronous-classified-payload-store';
import {
  buildCommunicationMessageRelease,
  createDecisionNotificationMergeRegistryRelease,
  createHmacOrganizerPreviewOpaqueTokenCodec,
  createOrganizerPlainTextRenderStrategyPort
} from '@jooevents/communications';
import { sendMessagesAuthorInputSchema } from '@jooevents/communication-operations';
import type { OrganizerMessagePreviewSummary } from '@jooevents/contracts/communications/organizer';
import { submissionTriageSourceRowSchema } from '@jooevents/contracts/submission-triage';
import type { OrganizerSubmissionContactDto } from '@jooevents/contracts';
import { canonicalJsonText, parseEventId, parseInstant, parseWorkspaceId } from '@jooevents/kernel';
import { installSQLiteClassifiedPayloadStoreSchema, SQLiteClassifiedPayloadStore } from '../sqlite-classified-payload-store';
import { installDecisionSchema } from '../decision';
import { installFoundationTrialUnitOfWorkSchema } from '../foundation-trial-uow';
import { installSQLiteOutboundEmailDeliverySchema } from '../outbound-email-delivery';
import {
  createOrganizerPreviewDraftBindingSource,
  installSQLiteOrganizerAudiencePreviewSchema,
  SQLiteOrganizerAudiencePreviewRepository
} from './audience-preview';
import {
  installSQLiteOrganizerCommunicationAuthoringSchema,
  SQLiteOrganizerCommunicationAuthoringRepository
} from './organizer-authoring';
import {
  installSQLiteCommunicationMessageReleaseSchema,
  SQLiteCommunicationMessageReleaseStore
} from './message-releases';
import {
  commitSendMessagesRelease,
  installCommunicationReleaseSchema
} from './message-release-effect-domain';
import {
  createSQLiteDecisionAudienceSource,
  createSQLiteDraftRenderContentSource,
  decisionAudienceDelegates,
  decisionAudienceOption,
  mintDecisionAudienceRecipes,
  seedDecisionNotificationCommunications
} from './decision-audience';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa141');
const userId = '019c1df7-86b5-769b-bba4-5f7097bfa241';
const scope = { workspaceId, eventId } as const;
const now = parseInstant('2026-08-14T09:00:00.000Z');
const ownerKey = 'workspace_user:decision-sender';

const submissionAccepted = '019c1df7-86b5-769b-bba4-5f7097bfa541';
const submissionNoEmail = '019c1df7-86b5-769b-bba4-5f7097bfa542';
const submissionDeclined = '019c1df7-86b5-769b-bba4-5f7097bfa543';
const formId = '019c1df7-86b5-769b-bba4-5f7097bfa641';
const formVersionId = '019c1df7-86b5-769b-bba4-5f7097bfa642';
const personA = '019c1df7-86b5-769b-bba4-5f7097bfa741';
const personB = '019c1df7-86b5-769b-bba4-5f7097bfa742';
const personC = '019c1df7-86b5-769b-bba4-5f7097bfa743';
const identityA = '019c1df7-86b5-769b-bba4-5f7097bfa841';
const identityB = '019c1df7-86b5-769b-bba4-5f7097bfa842';
const identityC = '019c1df7-86b5-769b-bba4-5f7097bfa843';
const fieldEmail = '019c1df7-86b5-769b-bba4-5f7097bfa941';
const contentPayloadId = '019c1df7-86b5-769b-bba4-5f7097bfaa41';
const audiencePayloadId = '019c1df7-86b5-769b-bba4-5f7097bfaa42';
const draftId = '019c1df7-86b5-769b-bba4-5f7097bfaa43';

const EXACT_EMAIL = 'ada.lovelace@example.org';

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonText(value), 'utf8').digest('hex');
}

const renderer = Object.freeze({
  reference: Object.freeze({ key: 'renderer.communication.plain-text', version: 1 }),
  definitionDigestSha256: digest({ kind: 'plain_text', version: 1 })
});

interface HeadSeed {
  readonly submissionId: string;
  readonly state: 'accepted' | 'declined' | 'waitlisted';
  readonly version: number;
  readonly personId: string;
  readonly participantIdentityId: string;
  readonly evidenceId: string;
}

const databases: Database[] = [];
afterEach(() => {
  for (const sqlite of databases.splice(0)) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    sqlite.close(false);
  }
});

function seedHead(sqlite: Database, seed: HeadSeed): void {
  const head = {
    submissionId: seed.submissionId,
    state: seed.state,
    version: seed.version,
    digestSha256: digest({ head: seed.submissionId, version: seed.version, state: seed.state }),
    decidedByUserId: userId,
    decidedAt: now
  };
  sqlite.query(`
    INSERT INTO decision_heads (
      workspace_id, event_id, submission_id, state, version, digest_sha256, head_json,
      decided_by_user_id, decided_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workspaceId, eventId, seed.submissionId, seed.state, seed.version, head.digestSha256,
    canonicalJsonText(head), userId, Date.parse(now)
  );
  sqlite.query(`
    INSERT INTO intake_submission_participant_evidence (
      workspace_id, event_id, submission_id, evidence_id, person_id,
      participant_identity_id, evidence_json, evidence_digest_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workspaceId, eventId, seed.submissionId, seed.evidenceId, seed.personId,
    seed.participantIdentityId, canonicalJsonText({ schemaVersion: 1 }),
    digest({ evidence: seed.evidenceId })
  );
}

function reDecide(sqlite: Database, submissionId: string, state: string, version: number): void {
  const head = {
    submissionId,
    state,
    version,
    digestSha256: digest({ head: submissionId, version, state }),
    decidedByUserId: userId,
    decidedAt: now
  };
  sqlite.query(`
    UPDATE decision_heads
       SET state = ?, version = ?, digest_sha256 = ?, head_json = ?
     WHERE workspace_id = ? AND event_id = ? AND submission_id = ?
  `).run(
    state, version, head.digestSha256, canonicalJsonText(head),
    workspaceId, eventId, submissionId
  );
}

function triageRow(submissionId: string, title: string | null, name: string | null) {
  return submissionTriageSourceRowSchema.parse({
    schemaVersion: 1,
    scope: { workspaceId, eventId },
    source: 'public_form',
    summary: {
      schemaVersion: 1,
      id: submissionId,
      formId,
      formVersionId,
      target: { kind: 'general_pool' },
      title,
      primaryParticipantName: name,
      submittedAt: now
    },
    detail: {
      schemaVersion: 1,
      submissionId,
      formId,
      formVersionId,
      submittedAt: now,
      participantCount: 1,
      answers: [],
      affirmedConsentFieldIds: []
    },
    abstract: null,
    track: null,
    format: null
  });
}

function contact(submissionId: string, personId: string, identityId: string, email: string):
  OrganizerSubmissionContactDto {
  return Object.freeze({
    schemaVersion: 1,
    submissionId,
    personId,
    participantIdentityId: identityId,
    sourceFieldId: fieldEmail,
    email
  }) as OrganizerSubmissionContactDto;
}

function fixture() {
  const sqlite = new Database(':memory:', { strict: true });
  databases.push(sqlite);
  installSQLiteClassifiedPayloadStoreSchema(sqlite);
  installDecisionSchema(sqlite);
  sqlite.exec(`
    CREATE TABLE intake_submission_participant_evidence (
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      participant_identity_id TEXT NOT NULL,
      evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
      evidence_digest_sha256 TEXT NOT NULL,
      PRIMARY KEY (workspace_id, event_id, evidence_id),
      UNIQUE (workspace_id, event_id, submission_id)
    );
  `);
  installSQLiteOrganizerAudiencePreviewSchema(sqlite);
  installSQLiteOrganizerCommunicationAuthoringSchema(sqlite);
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installSQLiteCommunicationMessageReleaseSchema(sqlite);
  installSQLiteOutboundEmailDeliverySchema(sqlite);
  installCommunicationReleaseSchema(sqlite);
  sqlite.exec('PRAGMA foreign_keys = OFF');
  seedHead(sqlite, {
    submissionId: submissionAccepted, state: 'accepted', version: 1,
    personId: personA, participantIdentityId: identityA,
    evidenceId: '019c1df7-86b5-769b-bba4-5f7097bfab41'
  });
  seedHead(sqlite, {
    submissionId: submissionNoEmail, state: 'accepted', version: 1,
    personId: personB, participantIdentityId: identityB,
    evidenceId: '019c1df7-86b5-769b-bba4-5f7097bfab42'
  });
  seedHead(sqlite, {
    submissionId: submissionDeclined, state: 'declined', version: 1,
    personId: personC, participantIdentityId: identityC,
    evidenceId: '019c1df7-86b5-769b-bba4-5f7097bfab43'
  });
  sqlite.exec('PRAGMA foreign_keys = ON');

  let nonceSeed = 1;
  const classifiedStore = new SQLiteClassifiedPayloadStore(sqlite, {
    encryptionProfile: issueSynchronousClassifiedPayloadEncryptionProfile({
      reference: { key: 'encryption.decision-audience-test', version: 1 },
      keyBytes: new Uint8Array(32).fill(0x41)
    }),
    nonceSource(size) {
      const nonce = Uint8Array.from({ length: size }, (_, index) => (nonceSeed + index * 13) % 256);
      nonceSeed += 1;
      return nonce;
    }
  });
  const authoring = new SQLiteOrganizerCommunicationAuthoringRepository(sqlite, classifiedStore);
  const mergeRegistry = createDecisionNotificationMergeRegistryRelease();
  const seeded = sqlite.transaction(() => seedDecisionNotificationCommunications({
    sqlite,
    authoring,
    scope,
    mergeRegistry: mergeRegistry.identity,
    renderer,
    now
  })).immediate();

  const contacts = new Map<string, OrganizerSubmissionContactDto>([
    [submissionAccepted, contact(submissionAccepted, personA, identityA, EXACT_EMAIL)],
    [submissionDeclined, contact(submissionDeclined, personC, identityC, 'grace@example.org')]
  ]);
  const source = createSQLiteDecisionAudienceSource({
    sqlite,
    contacts: {
      readSubmissionContact(_scope, submissionId) {
        const value = contacts.get(submissionId);
        if (value === undefined) throw new TypeError('intake_contact_missing');
        return value;
      }
    },
    submissions: {
      readSourceRow(_scope, submissionId) {
        if (submissionId === submissionAccepted) {
          return triageRow(submissionId, 'Deterministic Diffs', 'Ada Lovelace');
        }
        if (submissionId === submissionNoEmail) {
          return triageRow(submissionId, 'Untitled Systems', 'Mary Shelley');
        }
        return triageRow(submissionId, 'Declined Topic', 'Grace Hopper');
      }
    },
    addressFingerprintKeyBytes: new Uint8Array(32).fill(0x42)
  });
  const repository = new SQLiteOrganizerAudiencePreviewRepository(sqlite, classifiedStore, {
    drafts: createOrganizerPreviewDraftBindingSource({
      authoring,
      plainTextRenderer: renderer,
      plainTextMergeRegistry: mergeRegistry.identity
    }),
    opaqueTokens: createHmacOrganizerPreviewOpaqueTokenCodec({
      keyBytes: new Uint8Array(32).fill(0x43),
      profile: { key: 'communication.preview.opaque-token', version: 1 }
    }),
    render: createOrganizerPlainTextRenderStrategyPort({
      mergeRegistry,
      content: createSQLiteDraftRenderContentSource({ sqlite, authoring }),
      values: source
    }),
    digestProfile: { key: 'communication.preview.sha256', version: 1 },
    audienceCursorKeyBytes: new Uint8Array(32).fill(0x44),
    registeredSources: decisionAudienceDelegates(source)
  });
  return { sqlite, classifiedStore, authoring, repository, source, seeded, mergeRegistry };
}

type Fixture = ReturnType<typeof fixture>;

function inTransaction<Value>(input: Fixture, work: () => Value): Value {
  return input.sqlite.transaction(work).immediate();
}

function acceptedDraft(input: Fixture): { readonly draftId: string; readonly version: number } {
  const option = decisionAudienceOption({
    status: 'accepted',
    purposeRevision: input.seeded.purposeRevision
  });
  const acceptedTemplate = input.seeded.templates.find((entry) => entry.status === 'accepted')!;
  const templateRevision = {
    templateId: acceptedTemplate.templateId,
    templateRevisionId: acceptedTemplate.templateRevisionId,
    revisionNumber: acceptedTemplate.revisionNumber,
    digestSha256: acceptedTemplate.digestSha256
  };
  return inTransaction(input, () => {
    const contentRef = input.authoring.storeAuthoringPayload({
      scope,
      ownerKey,
      payloadRefId: contentPayloadId,
      createdAt: now,
      payload: {
        payloadKind: 'message_content',
        schemaVersion: 1,
        value: {
          kind: 'email/v1',
          subject: 'Your submission decision',
          body: { kind: 'template_revision/v1', templateRevision }
        }
      }
    });
    const audienceRef = input.authoring.storeAuthoringPayload({
      scope,
      ownerKey,
      payloadRefId: audiencePayloadId,
      createdAt: now,
      payload: {
        payloadKind: 'message_audience_draft',
        schemaVersion: 1,
        value: option.audienceDraft
      }
    });
    mintDecisionAudienceRecipes({
      repository: input.repository,
      scope,
      purposeRevision: input.seeded.purposeRevision
    });
    const created = input.authoring.createDraft({
      scope,
      ownerKey,
      draftId,
      provenance: { kind: 'human' },
      now,
      businessInput: {
        channel: 'email',
        purposeRevision: input.seeded.purposeRevision,
        templateRevision,
        initial: {
          kind: 'adopted_payload_refs',
          contentPayload: contentRef,
          audiencePayload: audienceRef
        }
      }
    });
    return { draftId: created.draftId, version: created.version };
  });
}

async function adoptPreview(input: Fixture, draft: { draftId: string; version: number }):
  Promise<OrganizerMessagePreviewSummary> {
  const preparation = await input.repository.preparePreview({
    scope,
    ownerKey,
    draftId: draft.draftId,
    expectedDraftVersion: draft.version,
    now
  });
  return inTransaction(input, () => input.repository.adoptPreparedPreview({
    preparation,
    scope,
    ownerKey,
    now
  }));
}

describe('decision-set audience over decision heads', () => {
  test('mints immutable recipes that list_audience_options serves', () => {
    const input = fixture();
    inTransaction(input, () => mintDecisionAudienceRecipes({
      repository: input.repository,
      scope,
      purposeRevision: input.seeded.purposeRevision
    }));
    // Idempotent re-mint converges on identical immutable rows.
    inTransaction(input, () => mintDecisionAudienceRecipes({
      repository: input.repository,
      scope,
      purposeRevision: input.seeded.purposeRevision
    }));
    const listed = input.repository.listAudienceOptions(scope, ownerKey, {});
    expect(listed).toMatchObject({
      kind: 'success',
      data: {
        rows: [
          {
            label: 'Accepted submissions',
            recipientEstimate: { knowledge: 'unknown', reasonCode: 'audience.resolved_at_preview' }
          },
          {
            label: 'Declined submissions',
            recipientEstimate: { knowledge: 'unknown' }
          }
        ],
        page: { hasMore: false }
      }
    });
    expect(() => input.sqlite.query(
      `UPDATE communication_registered_audience_recipes SET option_version = 2`
    ).run()).toThrow('registered audience recipes are immutable');
  });

  test('serves BLOCKED-4 templates through the authoring reads via a seed path', () => {
    const input = fixture();
    const templates = input.authoring.listTemplates(scope, {});
    expect(templates).toMatchObject({
      kind: 'success',
      data: {
        rows: [
          { key: expect.stringContaining('decision.') },
          { key: expect.stringContaining('decision.') }
        ]
      }
    });
    const accepted = input.seeded.templates.find((entry) => entry.status === 'accepted')!;
    expect(input.authoring.getTemplate(scope, { templateId: accepted.templateId })).toMatchObject({
      kind: 'success',
      data: {
        content: { body: { mode: 'composed' } },
        renderer: { reference: { key: 'renderer.communication.plain-text', version: 1 } },
        mergeRegistry: { reference: { key: 'merge-registry.communication.plain-text', version: 1 } },
        fieldBindings: [
          { fieldKey: 'decision.status' },
          { fieldKey: 'person.name' },
          { fieldKey: 'submission.title' }
        ]
      }
    });
    expect(input.authoring.listPurposes(scope, {})).toMatchObject({
      kind: 'success',
      data: { rows: [{ label: 'Decision notifications', communicationClass: 'transactional' }] }
    });
  });

  test('previews the accepted decision set with per-person identity and exclusion reasons', async () => {
    const input = fixture();
    const draft = acceptedDraft(input);
    const summary = await adoptPreview(input, draft);
    expect(summary.counts).toEqual({
      visibleCandidateCount: 2,
      includedCount: 1,
      excludedCount: 1,
      blockedCount: 0
    });
    expect(summary.reasonCodes).toEqual(['address.no_eligible']);
    expect(summary.sourceVersions.map((source) => source.sourceKey))
      .toEqual(['decision-set.accepted']);

    const masked = await input.repository.listMessagePreviewRecipients(
      scope, ownerKey, summary.identity, 'masked'
    );
    expect(masked).toMatchObject({
      kind: 'success',
      data: {
        rows: [
          { state: 'included', safeLabel: 'Ada Lovelace', channel: { disclosure: 'masked' } },
          { state: 'excluded', reasonCode: 'address.no_eligible', safeLabel: 'Mary Shelley' }
        ]
      }
    });
    const exact = await input.repository.listMessagePreviewRecipients(
      scope, ownerKey, summary.identity, 'exact_authorized'
    );
    expect(exact).toMatchObject({
      kind: 'success',
      data: {
        rows: [
          { state: 'included', channel: { disclosure: 'exact_authorized', exactValue: EXACT_EMAIL } },
          { state: 'excluded' }
        ]
      }
    });
    const included = (exact as { data: { rows: readonly { state: string; recipientResolutionId: string }[] } })
      .data.rows.find((row) => row.state === 'included')!;
    const detail = await input.repository.getMessageBatchPreview(scope, ownerKey, {
      ...summary.identity,
      selectedRecipientResolutionId: included.recipientResolutionId
    });
    if (detail.kind !== 'success') throw new Error('expected success detail');
    const selected = (detail.data as {
      selected: { kind: string; render?: { subject?: unknown; plainText?: unknown } };
    }).selected;
    expect(selected.kind).toBe('rendered_email');
    expect(selected.render?.subject).toBe('Your submission decision');
    const plainText = String(selected.render?.plainText);
    expect(plainText).toContain('Ada Lovelace, good news');
    expect(plainText).toContain('Deterministic Diffs');
    expect(plainText).toContain('accepted');
  });

  test('a re-decide invalidates the adopted preview', async () => {
    const input = fixture();
    const draft = acceptedDraft(input);
    const summary = await adoptPreview(input, draft);
    expect(await input.repository.getMessageBatchPreview(scope, ownerKey, summary.identity))
      .toMatchObject({ kind: 'success' });
    reDecide(input.sqlite, submissionAccepted, 'declined', 2);
    expect(await input.repository.getMessageBatchPreview(scope, ownerKey, summary.identity))
      .toMatchObject({
        kind: 'outcome',
        outcome: { class: 'stale_revision', kind: 'communication.revision_changed' }
      });
  });

  test('a wrong purpose is excluded as purpose.not_allowed, never silently sent', () => {
    const input = fixture();
    const resolution = input.source.resolveEmail({
      scope,
      purposeRevision: {
        ...input.seeded.purposeRevision,
        purposeKey: 'marketing.newsletter',
        digestSha256: 'b'.repeat(64)
      },
      candidate: input.source.resolveCurrentSnapshot({
        scope,
        audience: decisionAudienceOption({
          status: 'accepted',
          purposeRevision: input.seeded.purposeRevision
        }).audienceDraft
      }).candidates[0]!,
      asOf: now
    });
    expect(resolution).toMatchObject({ kind: 'evaluated', purposeBasis: { state: 'denied' } });
  });

  test('classified addresses never land in ordinary rows', async () => {
    const input = fixture();
    const draft = acceptedDraft(input);
    await adoptPreview(input, draft);
    const bytes = Buffer.from(input.sqlite.serialize());
    expect(bytes.includes(Buffer.from(EXACT_EMAIL))).toBe(false);
  });
});

const sender = Object.freeze({
  fromAddress: 'organizer@jooevents.example',
  fromDisplayName: 'JooEvents Organizers',
  senderProfileRevisionId: 'sender.profile.rev-1',
  senderPresentationContractKey: 'sender.presentation.email-v1',
  senderPresentationContractVersion: 1,
  senderPresentationDigestSha256: digest({ sender: 'presentation-v1' })
});
const receiptExpectation = Object.freeze({
  surface: 'operator_http' as const,
  scopePartitionKey: '6'.repeat(64),
  requestHashSha256: '7'.repeat(64)
});
const authorityPrincipalKey = '5'.repeat(64);
const sendBatchId = 'batch.decision-notification.currency';

function countRows(sqlite: Database, table: string): number {
  return sqlite.query<{ readonly count: number }, []>(
    `SELECT count(*) AS count FROM ${table}`
  ).get()?.count ?? -1;
}

function sendUuid(suffix: number): string {
  return `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
}

/**
 * Drives the real one-transaction send commit against the adopted preview,
 * with the audience-preview repository itself as the live currency authority —
 * exactly the composition the runtime adapter mounts.
 */
function sendCommit(input: Fixture, summary: OrganizerMessagePreviewSummary) {
  const release = buildCommunicationMessageRelease({
    workspaceId,
    eventId,
    releaseId: 'mrel1.ada',
    batchId: sendBatchId,
    recipientRefId: `rr1_${digest({ recipient: 'ada' }).slice(0, 30)}`,
    personRefId: personA,
    contactRefId: `submission-contact:${submissionAccepted}`,
    templateRevisionRefId: sendUuid(0x400),
    contentRefId: sendUuid(0x401),
    purposeKey: 'decision_notification',
    reviewedMessageDigestSha256: digest({ message: 'ada' }),
    sender,
    toAddress: EXACT_EMAIL,
    subject: 'Your submission decision',
    textBody: 'Ada Lovelace, good news — your submission was accepted.',
    createdAt: now
  });
  const authorInput = sendMessagesAuthorInputSchema.parse({
    schemaVersion: 1,
    action: 'send',
    scope: { workspaceId, eventId },
    batchId: sendBatchId,
    purposeRevision: input.seeded.purposeRevision,
    subject: 'Your submission decision',
    audienceLabel: 'Accepted submissions',
    preview: {
      identity: summary.identity,
      membershipDigestSha256: summary.membershipDigestSha256,
      evidenceDigestSha256: summary.evidenceDigestSha256,
      sourceVersions: summary.sourceVersions
    },
    releases: [{
      releaseId: release.releaseId,
      deliveryId: sendUuid(0x500),
      recipientRefId: release.recipientRefId,
      personRefId: release.personRefId,
      contactRefId: release.contactRefId,
      templateRevisionRefId: release.templateRevisionRefId,
      contentRefId: release.contentRefId,
      reviewedMessageDigestSha256: release.reviewedMessageDigestSha256,
      reviewedEnvelopeDigestSha256: release.reviewedEnvelopeDigestSha256,
      providerConnectionRevisionId: 'provider.connection.rev-1',
      externalDeliveryKey: 'fake.rejected-terminal',
      senderProfileRevisionId: sender.senderProfileRevisionId,
      senderPresentationContractKey: sender.senderPresentationContractKey,
      senderPresentationContractVersion: sender.senderPresentationContractVersion,
      senderPresentationDigestSha256: sender.senderPresentationDigestSha256,
      channelAddressId: `addr1_${digest({ address: release.releaseId }).slice(0, 30)}`,
      channelAddressVersion: 1,
      addressLookupFingerprintProfile: 'communication.address-fingerprint.hmac-sha256',
      addressLookupFingerprintVersion: 1,
      addressLookupFingerprintSha256: digest({ fingerprint: release.releaseId })
    }],
    requestedAt: now
  });
  let payloadSeq = 0xf00;
  const releases = new SQLiteCommunicationMessageReleaseStore(input.sqlite, input.classifiedStore, {
    newEnvelopePayloadRefId: () => sendUuid((payloadSeq += 1))
  });
  let idSeq = 0x800;
  const nextId = () => sendUuid((idSeq += 1));
  return inTransaction(input, () => commitSendMessagesRelease({
    sqlite: input.sqlite,
    releases,
    previewCurrency: input.repository,
    ids: { newEvidenceId: nextId },
    context: {
      workspaceId,
      eventId,
      principalKey: ownerKey,
      authorityPrincipalKey,
      evaluatedAt: now
    },
    authorInput,
    materializedReleases: [release]
  }));
}

describe('send commit currency over the adopted decision-set preview', () => {
  test('a currently-adopted preview commits through the real currency probe', async () => {
    const input = fixture();
    const draft = acceptedDraft(input);
    const summary = await adoptPreview(input, draft);
    expect(input.repository.checkAdoptedPreviewCurrency({
      scope,
      identity: summary.identity
    })).toBe('current');
    const outcome = sendCommit(input, summary);
    expect(outcome).toMatchObject({
      kind: 'committed',
      result: { batchId: sendBatchId, dispatchGeneration: 1, releaseCount: 1 }
    });
    const head = input.sqlite.query<{
      readonly state: string;
      readonly dispatch_generation: number;
    }, []>(
      'SELECT state, dispatch_generation FROM communication_outbound_delivery_heads'
    ).get();
    expect(head).toEqual({ state: 'pending', dispatch_generation: 1 });
  });

  test('a re-decide between adoption and send refuses the commit typed and writes nothing', async () => {
    const input = fixture();
    const draft = acceptedDraft(input);
    const summary = await adoptPreview(input, draft);
    // The reviewed world drifts: the accepted submission is re-decided to
    // declined. Every preview read refuses; the send commit must too, even
    // though the plan still matches the immutable adopted snapshot exactly.
    reDecide(input.sqlite, submissionAccepted, 'declined', 2);
    expect(input.repository.checkAdoptedPreviewCurrency({
      scope,
      identity: summary.identity
    })).toBe('stale');
    const outcome = sendCommit(input, summary);
    expect(outcome).toMatchObject({
      kind: 'refused',
      refusal: {
        class: 'stale_revision',
        kind: 'communication.preview_changed',
        retryable: false,
        detailSchemaVersion: 1,
        detail: { includedCount: 1, irreversibleExternalEffectCount: 1 }
      }
    });
    expect(countRows(input.sqlite, 'communication_message_releases')).toBe(0);
    expect(countRows(input.sqlite, 'communication_release_effect_specs')).toBe(0);
    expect(countRows(input.sqlite, 'communication_outbound_delivery_heads')).toBe(0);
    expect(countRows(input.sqlite, 'communication_outbound_delivery_outbox')).toBe(0);
  });
});
