import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  issueSynchronousClassifiedPayloadEncryptionProfile
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID,
  ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID
} from '@jooevents/contracts/communications/organizer';
import { parseEventId, parseInstant, parseWorkspaceId } from '@jooevents/kernel';
import {
  SQLiteClassifiedPayloadStore,
  installSQLiteClassifiedPayloadStoreSchema
} from '../sqlite-classified-payload-store';
import {
  SQLiteOrganizerCommunicationAuthoringError,
  SQLiteOrganizerCommunicationAuthoringRepository,
  createSQLiteOrganizerCommunicationMutationPreparation,
  installSQLiteOrganizerCommunicationAuthoringSchema
} from './organizer-authoring';

const ids = Object.freeze({
  workspaceId: parseWorkspaceId('019c3000-0000-7000-8000-000000000001'),
  eventId: parseEventId('019c3000-0000-7000-8000-000000000002'),
  purposeId: '019c3000-0000-7000-8000-000000000003',
  purposeRevisionId: '019c3000-0000-7000-8000-000000000004',
  templateId: '019c3000-0000-7000-8000-000000000005',
  templateRevisionId: '019c3000-0000-7000-8000-000000000006',
  emptyDraftId: '019c3000-0000-7000-8000-000000000007',
  readyDraftId: '019c3000-0000-7000-8000-000000000008',
  contentPayloadId: '019c3000-0000-7000-8000-000000000009',
  audiencePayloadId: '019c3000-0000-7000-8000-000000000010',
  nextContentPayloadId: '019c3000-0000-7000-8000-000000000011',
  templateContentPayloadId: '019c3000-0000-7000-8000-000000000012',
  templateBindingsPayloadId: '019c3000-0000-7000-8000-000000000013'
});
const ownerKey = '1'.repeat(64);
const otherOwnerKey = '2'.repeat(64);
const now = parseInstant('2026-08-13T04:00:00.000Z');
const later = parseInstant('2026-08-13T04:01:00.000Z');
const digest = (fill: string) => fill.repeat(64);
const purposeRevision = Object.freeze({
  purposeId: ids.purposeId,
  purposeKey: 'speaker.update',
  revisionId: ids.purposeRevisionId,
  revisionNumber: 1,
  digestSha256: digest('a')
});
const databases: Database[] = [];

interface Fixture {
  readonly sqlite: Database;
  readonly repository: SQLiteOrganizerCommunicationAuthoringRepository;
}

function fixture(): Fixture {
  const sqlite = new Database(':memory:', { strict: true });
  databases.push(sqlite);
  installSQLiteClassifiedPayloadStoreSchema(sqlite);
  installSQLiteOrganizerCommunicationAuthoringSchema(sqlite);
  const encryptionProfile = issueSynchronousClassifiedPayloadEncryptionProfile({
    reference: { key: 'encryption.communication-authoring-test', version: 1 },
    keyBytes: new Uint8Array(32).fill(0x73)
  });
  let nonceSeed = 1;
  const classifiedStore = new SQLiteClassifiedPayloadStore(sqlite, {
    encryptionProfile,
    nonceSource(size) {
      const nonce = Uint8Array.from(
        { length: size },
        (_, index) => (nonceSeed + index * 17) % 256
      );
      nonceSeed += 1;
      return nonce;
    }
  });
  const repository = new SQLiteOrganizerCommunicationAuthoringRepository(sqlite, classifiedStore);
  sqlite.transaction(() => {
    sqlite.query(`
      INSERT INTO communication_purposes (
        workspace_id,event_id,purpose_id,purpose_key,lifecycle,current_revision_id
      ) VALUES (?,?,?,?,?,?)
    `).run(
      ids.workspaceId,
      ids.eventId,
      ids.purposeId,
      purposeRevision.purposeKey,
      'active',
      ids.purposeRevisionId
    );
    sqlite.query(`
      INSERT INTO communication_purpose_revisions (
        workspace_id,event_id,purpose_id,purpose_key,revision_id,revision_number,
        digest_sha256,label,communication_class,policy_digest_sha256,description,
        allowed_audience_sources_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      ids.workspaceId,
      ids.eventId,
      ids.purposeId,
      purposeRevision.purposeKey,
      ids.purposeRevisionId,
      1,
      purposeRevision.digestSha256,
      'Speaker update',
      'transactional',
      digest('b'),
      'A pinned test purpose.',
      '[]'
    );
  }).immediate();
  return { sqlite, repository };
}

afterEach(() => {
  for (const sqlite of databases.splice(0)) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    sqlite.close(false);
  }
});

function inTransaction<Value>(input: Fixture, work: () => Value): Value {
  return input.sqlite.transaction(work).immediate();
}

function storeMessageContent(
  input: Fixture,
  payloadRefId: string = ids.contentPayloadId,
  selectedOwner = ownerKey,
  subject = 'Arrival details',
  body = 'PRIVATE-BODY-CANARY'
) {
  return inTransaction(input, () => input.repository.storeAuthoringPayload({
    scope: ids,
    ownerKey: selectedOwner,
    payloadRefId,
    createdAt: now,
    payload: {
      payloadKind: 'message_content',
      schemaVersion: 1,
      value: {
        kind: 'email/v1',
        subject,
        body: { kind: 'plain_text/v1', text: body }
      }
    }
  }));
}

function storeAudience(input: Fixture, payloadRefId = ids.audiencePayloadId) {
  return inTransaction(input, () => input.repository.storeAuthoringPayload({
    scope: ids,
    ownerKey,
    payloadRefId,
    createdAt: now,
    payload: {
      payloadKind: 'message_audience_draft',
      schemaVersion: 1,
      value: {
        schemaVersion: 1,
        binding: 'current_snapshot',
        purposeRevision,
        source: { kind: 'explicit_contacts', contactRefIds: ['contact-1', 'contact-2'] }
      }
    }
  }));
}

function createEmptyDraft(input: Fixture, draftId: string = ids.emptyDraftId) {
  return inTransaction(input, () => input.repository.createDraft({
    scope: ids,
    ownerKey,
    draftId,
    provenance: { kind: 'human' },
    now,
    businessInput: {
      channel: 'email',
      purposeRevision,
      initial: {
        kind: 'registered_empty_refs',
        contentRefId: ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID,
        audienceRefId: ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID
      }
    }
  }));
}

describe('SQLite organizer communication authoring repository', () => {
  test('represents initialized-empty drafts without fabricating authoring facts', () => {
    const input = fixture();
    expect(createEmptyDraft(input)).toMatchObject({
      draftId: ids.emptyDraftId,
      version: 1,
      state: 'active',
      authoring: {
        state: 'uninitialized',
        contentRefId: ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID,
        audienceRefId: ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID
      }
    });

    const listed = input.repository.listDrafts(ids, ownerKey, {});
    expect(listed.kind).toBe('success');
    if (listed.kind !== 'success') throw new Error('expected success');
    const first = (listed.data as { rows: Array<Record<string, unknown>> }).rows[0]!;
    expect(first).toMatchObject({ draftId: ids.emptyDraftId, authoring: { state: 'uninitialized' } });
    expect('subject' in (first.authoring as object)).toBe(false);
    expect('recipientEstimate' in (first.authoring as object)).toBe(false);

    const projected = input.repository.getDraft(ids, ownerKey, { draftId: ids.emptyDraftId });
    expect(projected.kind).toBe('success');
    if (projected.kind !== 'success') throw new Error('expected success');
    expect(projected.data).toMatchObject({ allowedNextActions: ['revise', 'discard'] });
    expect('content' in (projected.data as object)).toBe(false);
    expect('audience' in (projected.data as object)).toBe(false);
    expect(input.repository.getDraft(ids, otherOwnerKey, { draftId: ids.emptyDraftId }))
      .toMatchObject({ kind: 'outcome', outcome: { kind: 'communication.not_found' } });
  });

  test('paginates owner drafts with a bounded opaque recent-order cursor', () => {
    const input = fixture();
    createEmptyDraft(input, ids.emptyDraftId);
    createEmptyDraft(input, ids.readyDraftId);
    const first = input.repository.listDrafts(ids, ownerKey, { limit: 1 });
    expect(first).toMatchObject({
      kind: 'success',
      data: {
        rows: [{ draftId: ids.readyDraftId }],
        page: { hasMore: true }
      }
    });
    if (first.kind !== 'success') throw new Error('expected success');
    const cursor = (first.data as { page: { nextCursor: string } }).page.nextCursor;
    expect(cursor.startsWith('cur1_')).toBe(true);
    expect(input.repository.listDrafts(ids, ownerKey, { limit: 1, cursor })).toMatchObject({
      kind: 'success',
      data: {
        rows: [{ draftId: ids.emptyDraftId }],
        page: { hasMore: false }
      }
    });
    expect(input.repository.listDrafts(ids, ownerKey, { limit: 1, cursor: 'cur1_abcdefgh' }))
      .toMatchObject({ kind: 'outcome', outcome: { kind: 'communication.authoring_invalid' } });
  });

  test('adopts opaque classified refs, guards owner and version, then terminalizes honestly', () => {
    const input = fixture();
    const content = storeMessageContent(input);
    const audience = storeAudience(input);
    createEmptyDraft(input);

    const revised = inTransaction(input, () => input.repository.reviseDraft({
      scope: ids,
      ownerKey,
      now: later,
      businessInput: {
        draftId: ids.emptyDraftId,
        expectedVersion: 1,
        contentPayload: content,
        audiencePayload: audience
      }
    }));
    expect(revised).toMatchObject({
      version: 2,
      authoring: {
        state: 'ready',
        subject: 'Arrival details',
        recipientEstimate: { knowledge: 'unknown', reasonCode: 'audience.not_resolved' }
      }
    });
    if (revised.authoring.state !== 'ready') throw new Error('expected ready authoring');
    expect('digestSha256' in revised.authoring.contentPayload).toBe(false);
    expect('canonicalByteLength' in revised.authoring.contentPayload).toBe(false);

    const projection = input.repository.getDraft(ids, ownerKey, {
      draftId: ids.emptyDraftId,
      expectedVersion: 2
    });
    expect(projection).toMatchObject({
      kind: 'success',
      data: {
        content: { subject: 'Arrival details' },
        audience: { source: { kind: 'explicit_contacts' } },
        allowedNextActions: ['revise', 'preview', 'discard', 'propose']
      }
    });
    expect(input.repository.getDraft(ids, ownerKey, {
      draftId: ids.emptyDraftId,
      expectedVersion: 1
    })).toMatchObject({ kind: 'outcome', outcome: { kind: 'communication.revision_changed' } });

    expect(() => inTransaction(input, () => input.repository.reviseDraft({
      scope: ids,
      ownerKey,
      now: later,
      businessInput: {
        draftId: ids.emptyDraftId,
        expectedVersion: 1,
        contentPayload: content,
        audiencePayload: audience
      }
    }))).toThrow(new SQLiteOrganizerCommunicationAuthoringError('stale_revision'));

    const foreign = storeMessageContent(
      input,
      ids.nextContentPayloadId,
      otherOwnerKey,
      'Foreign subject'
    );
    expect(() => inTransaction(input, () => input.repository.reviseDraft({
      scope: ids,
      ownerKey,
      now: later,
      businessInput: {
        draftId: ids.emptyDraftId,
        expectedVersion: 2,
        contentPayload: foreign,
        audiencePayload: audience
      }
    }))).toThrow(new SQLiteOrganizerCommunicationAuthoringError('payload_ref_invalid'));

    const discarded = inTransaction(input, () => input.repository.discardDraft({
      scope: ids,
      ownerKey,
      now: later,
      businessInput: { draftId: ids.emptyDraftId, expectedVersion: 2, reasonCode: 'user.cancelled' }
    }));
    expect(discarded).toMatchObject({ version: 3, state: 'discarded' });
    expect(input.repository.getDraft(ids, ownerKey, { draftId: ids.emptyDraftId }))
      .toMatchObject({ kind: 'success', data: { allowedNextActions: [] } });
    expect(Buffer.from(input.sqlite.serialize()).includes(Buffer.from('PRIVATE-BODY-CANARY')))
      .toBe(false);
  });

  test('reads pinned purpose and template revisions without inventing production defaults', () => {
    const input = fixture();
    const content = inTransaction(input, () => input.repository.storeAuthoringPayload({
      scope: ids,
      ownerKey,
      payloadRefId: ids.templateContentPayloadId,
      createdAt: now,
      payload: {
        payloadKind: 'template_content',
        schemaVersion: 1,
        value: {
          kind: 'email/v1',
          subject: [{ kind: 'text', value: 'Speaker update' }],
          body: { mode: 'composed', blocks: [] },
          plainTextPolicy: 'derive_v1',
          attachmentSlotKeys: []
        }
      }
    }));
    const bindings = inTransaction(input, () => input.repository.storeAuthoringPayload({
      scope: ids,
      ownerKey,
      payloadRefId: ids.templateBindingsPayloadId,
      createdAt: now,
      payload: { payloadKind: 'template_field_bindings', schemaVersion: 1, value: [] }
    }));
    inTransaction(input, () => {
      input.sqlite.query(`
        INSERT INTO message_templates (
          workspace_id,event_id,template_id,template_key,template_name,lifecycle,
          purpose_revision_id,current_revision_id
        ) VALUES (?,?,?,?,?,?,?,?)
      `).run(
        ids.workspaceId,
        ids.eventId,
        ids.templateId,
        'speaker.update',
        'Speaker update',
        'active',
        ids.purposeRevisionId,
        ids.templateRevisionId
      );
      input.sqlite.query(`
        INSERT INTO message_template_revisions (
          workspace_id,event_id,template_id,template_revision_id,revision_number,digest_sha256,
          content_payload_ref_id,field_bindings_payload_ref_id,renderer_key,renderer_version,
          renderer_digest_sha256,merge_registry_key,merge_registry_version,
          merge_registry_digest_sha256
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        ids.workspaceId,
        ids.eventId,
        ids.templateId,
        ids.templateRevisionId,
        1,
        digest('c'),
        content.payloadRefId,
        bindings.payloadRefId,
        'renderer.email-v1',
        1,
        digest('d'),
        'merge.registry-v1',
        1,
        digest('e')
      );
    });

    expect(input.repository.listPurposes(ids, {})).toMatchObject({
      kind: 'success', data: { rows: [{ label: 'Speaker update' }], page: { hasMore: false } }
    });
    expect(input.repository.getPurpose(ids, { purposeId: ids.purposeId })).toMatchObject({
      kind: 'success', data: { allowedAudienceSources: [] }
    });
    expect(input.repository.listTemplates(ids, {})).toMatchObject({
      kind: 'success', data: { rows: [{ subjectPreview: 'Speaker update' }] }
    });
    expect(input.repository.getTemplate(ids, { templateId: ids.templateId })).toMatchObject({
      kind: 'success',
      data: {
        content: { body: { mode: 'composed' } },
        fieldBindings: [],
        renderer: { reference: { key: 'renderer.email-v1', version: 1 } },
        mergeRegistry: { reference: { key: 'merge.registry-v1', version: 1 } }
      }
    });
  });

  test('requires an outer transaction and rolls classified adoption back atomically', () => {
    const input = fixture();
    expect(() => input.repository.storeAuthoringPayload({
      scope: ids,
      ownerKey,
      payloadRefId: ids.contentPayloadId,
      createdAt: now,
      payload: {
        payloadKind: 'message_content', schemaVersion: 1,
        value: { kind: 'email/v1', subject: 'Hello', body: { kind: 'plain_text/v1', text: '' } }
      }
    })).toThrow(new SQLiteOrganizerCommunicationAuthoringError('transaction_required'));

    expect(() => inTransaction(input, () => {
      storeMessageContent(input);
      throw new Error('late failure');
    })).toThrow('late failure');
    expect(input.sqlite.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM communication_authoring_payloads'
    ).get()?.count).toBe(0);
    expect(input.sqlite.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM classified_payload_records'
    ).get()?.count).toBe(0);

    storeMessageContent(input);
    expect(() => input.sqlite.query(
      `UPDATE communication_authoring_payloads SET payload_kind='message_audience_draft'`
    ).run()).toThrow('communication authoring payload metadata is immutable');
  });

  test('derives stable mutation identities from the server idempotency verifier', () => {
    const input = fixture();
    const preparation = createSQLiteOrganizerCommunicationMutationPreparation({
      repository: input.repository
    });
    const context = {
      scope: { workspaceId: ids.workspaceId, eventId: ids.eventId },
      authorityPrincipalKey: ownerKey,
      receivedAt: now,
      provenance: { kind: 'operator' },
      requestBinding: {
        scopePartitionKey: '3'.repeat(64),
        idempotency: {
          verifierProfile: { key: 'idempotency.communication-test', version: 1 },
          verifierSha256: '4'.repeat(64)
        }
      }
    } as Parameters<typeof preparation.prepare>[0]['context'];
    const businessInput = {
      payload: {
        payloadKind: 'message_content',
        schemaVersion: 1,
        value: {
          kind: 'email/v1',
          subject: 'Stable payload',
          body: { kind: 'plain_text/v1', text: '' }
        }
      }
    };
    const first = inTransaction(input, () => preparation.prepare({
      operationName: 'store_communication_authoring_payload', businessInput, context
    }));
    const replay = inTransaction(input, () => preparation.prepare({
      operationName: 'store_communication_authoring_payload', businessInput, context
    }));
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      result: { kind: 'success', data: { payloadKind: 'message_content' } },
      domain: { operationName: 'store_communication_authoring_payload' },
      receiptChildren: []
    });

    const changed = inTransaction(input, () => preparation.prepare({
      operationName: 'store_communication_authoring_payload',
      businessInput: {
        payload: {
          ...businessInput.payload,
          value: { ...businessInput.payload.value, subject: 'Changed payload' }
        }
      },
      context
    }));
    expect(changed).toMatchObject({
      result: { kind: 'outcome', outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' } },
      domain: null
    });
  });
});
