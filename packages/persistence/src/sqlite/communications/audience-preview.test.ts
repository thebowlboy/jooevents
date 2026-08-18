import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  issueSynchronousClassifiedPayloadEncryptionProfile
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  createDeterministicOrganizerPreviewRenderPort,
  createHmacOrganizerPreviewOpaqueTokenCodec
} from '@jooevents/communications';
import { organizerMessagePreviewRecipientPageSchema } from '@jooevents/contracts/communications/organizer';
import { parseEventId, parseInstant, parseWorkspaceId } from '@jooevents/kernel';
import {
  SQLiteClassifiedPayloadStore,
  installSQLiteClassifiedPayloadStoreSchema
} from '../sqlite-classified-payload-store';
import {
  SQLiteOrganizerAudiencePreviewError,
  SQLiteOrganizerAudiencePreviewRepository,
  installSQLiteOrganizerAudiencePreviewSchema,
  type SQLiteOrganizerAudiencePreviewRepositoryOptions
} from './audience-preview';

const ids = Object.freeze({
  workspaceId: parseWorkspaceId('019c5000-0000-7000-8000-000000000001'),
  eventId: parseEventId('019c5000-0000-7000-8000-000000000002'),
  purposeId: '019c5000-0000-7000-8000-000000000003',
  purposeRevisionId: '019c5000-0000-7000-8000-000000000004',
  draftId: '019c5000-0000-7000-8000-000000000005',
  addressPayload1: '019c5000-0000-7000-8000-000000000006',
  addressPayload2: '019c5000-0000-7000-8000-000000000007',
  address1: '019c5000-0000-7000-8000-000000000008',
  address2: '019c5000-0000-7000-8000-000000000009',
  recipe: '019c5000-0000-7000-8000-000000000010',
  option: '019c5000-0000-7000-8000-000000000011'
});
const now = parseInstant('2026-08-13T08:00:00.000Z');
const digest = (character: string) => character.repeat(64);
const ownerKey = 'a'.repeat(64);
const purposeRevision = Object.freeze({
  purposeId: ids.purposeId,
  purposeKey: 'speaker.update',
  revisionId: ids.purposeRevisionId,
  revisionNumber: 1,
  digestSha256: digest('1')
});
const sourceDefinition = Object.freeze({
  reference: { key: 'audience.accepted-speakers', version: 1 },
  definitionDigestSha256: digest('2')
});
const renderer = Object.freeze({
  reference: { key: 'renderer.email-v1', version: 1 },
  definitionDigestSha256: digest('3')
});
const mergeRegistry = Object.freeze({
  reference: { key: 'merge-registry.event-v1', version: 1 },
  definitionDigestSha256: digest('4')
});
const source = Object.freeze({
  kind: 'registered_query' as const,
  recipeId: ids.recipe,
  recipeVersion: 1,
  recipeDigestSha256: digest('5'),
  sourceDefinition
});
const audience = Object.freeze({
  schemaVersion: 1 as const,
  binding: 'current_snapshot' as const,
  purposeRevision,
  source
});
const candidates = Object.freeze([
  candidate('subject-ada', 1, 'person-ada', 'contact-ada', 'Ada Lovelace', 'a'),
  candidate('subject-grace', 1, 'person-grace', 'contact-grace', 'Grace Hopper', 'b'),
  candidate('subject-katherine', 1, 'person-katherine', 'contact-katherine', 'Katherine Johnson', 'c')
]);
// Deliberately equal: identity remains person/contact/reference-bound, never email-inferred.
const exactAddresses = Object.freeze(['shared@example.test', 'shared@example.test']);
const databases: Database[] = [];

function evidence(id: string, fill: string) {
  return Object.freeze({
    evidenceRefId: `evidence-${id}`,
    evidenceVersion: 1,
    evidenceDigestSha256: digest(fill)
  });
}

function candidate(
  subjectRefId: string,
  subjectVersion: number,
  personRefId: string,
  contactRefId: string,
  safeLabel: string,
  fill: string
) {
  return Object.freeze({
    subjectRefId, subjectVersion, personRefId, contactRefId, safeLabel,
    membershipEvidence: evidence(`membership-${contactRefId}`, fill)
  });
}

function address(input: {
  readonly addressRefId: string;
  readonly payloadRefId: string;
  readonly contactRefId: string;
  readonly value: string;
  readonly fill: string;
}) {
  return Object.freeze({
    addressRefId: input.addressRefId,
    addressVersion: 1,
    contactRefId: input.contactRefId,
    channel: 'email' as const,
    lifecycle: 'active' as const,
    lifecycleEvidence: evidence(`lifecycle-${input.contactRefId}`, input.fill),
    lookupFingerprint: {
      profile: 'lookup.communication.email', version: 1, keyedValue: digest(input.fill)
    },
    classifiedValue: {
      payloadRefId: input.payloadRefId,
      payloadRefVersion: 1,
      classification: 'communication.contact.email' as const,
      value: input.value
    }
  });
}

function evaluatedPolicy(storedAddress: ReturnType<typeof address>, fill: string) {
  return Object.freeze({
    kind: 'evaluated' as const,
    selectionPolicy: {
      reference: { key: 'address-policy.email-current', version: 1 },
      definitionDigestSha256: digest(fill)
    },
    address: storedAddress,
    purposeBasis: { state: 'allowed' as const, evidence: evidence(`purpose-${fill}`, fill) },
    consent: { state: 'not_required' as const, evidence: evidence(`consent-${fill}`, fill) },
    suppression: { state: 'clear' as const, evidence: evidence(`suppression-${fill}`, fill) },
    doNotContact: { state: 'clear' as const, evidence: evidence(`dnc-${fill}`, fill) }
  });
}

interface Fixture {
  readonly sqlite: Database;
  readonly classified: SQLiteClassifiedPayloadStore;
  readonly options: SQLiteOrganizerAudiencePreviewRepositoryOptions;
  readonly repository: SQLiteOrganizerAudiencePreviewRepository;
  readonly zeroized: Uint8Array[];
}

function fixture(): Fixture {
  const sqlite = new Database(':memory:', { strict: true });
  databases.push(sqlite);
  installSQLiteClassifiedPayloadStoreSchema(sqlite);
  installSQLiteOrganizerAudiencePreviewSchema(sqlite);
  const encryptionProfile = issueSynchronousClassifiedPayloadEncryptionProfile({
    reference: { key: 'encryption.communication-audience-preview-test', version: 1 },
    keyBytes: new Uint8Array(32).fill(0x61)
  });
  let nonce = 1;
  const classified = new SQLiteClassifiedPayloadStore(sqlite, {
    encryptionProfile,
    nonceSource(size) {
      const bytes = Uint8Array.from({ length: size }, (_, index) => (nonce + index * 11) % 256);
      nonce += 1;
      return bytes;
    }
  });
  const draft = Object.freeze({
    draftId: ids.draftId,
    version: 1,
    purposeRevision,
    audience
  });
  const zeroized: Uint8Array[] = [];
  const options: SQLiteOrganizerAudiencePreviewRepositoryOptions = {
    drafts: {
      readCurrent(input) {
        return input.scope.workspaceId === ids.workspaceId
          && input.scope.eventId === ids.eventId
          && input.ownerKey === ownerKey
          && input.draftId === ids.draftId
          && input.expectedVersion === 1
          ? { draft, renderer, mergeRegistry }
          : undefined;
      }
    },
    opaqueTokens: createHmacOrganizerPreviewOpaqueTokenCodec({
      keyBytes: new Uint8Array(32).fill(0x62),
      profile: { key: 'communication.preview.tokens', version: 1 }
    }),
    render: createDeterministicOrganizerPreviewRenderPort([
      {
        subjectRefId: 'subject-ada',
        outcome: {
          kind: 'rendered', subject: 'Hello Ada', sanitizedHtml: '<p>Hello Ada</p>',
          plainText: 'Hello Ada'
        }
      },
      {
        subjectRefId: 'subject-grace',
        outcome: { kind: 'blocked', reasonCode: 'render.missing_required_field' }
      }
    ]),
    digestProfile: { key: 'communication.preview.sha256', version: 1 },
    audienceCursorKeyBytes: new Uint8Array(32).fill(0x63),
    preparedTtlMs: 30_000,
    testOnlyAfterPreparedBytesZeroized(bytes) {
      zeroized.push(Uint8Array.from(bytes));
    }
  };
  const repository = new SQLiteOrganizerAudiencePreviewRepository(sqlite, classified, options);
  return { sqlite, classified, options, repository, zeroized };
}

afterEach(() => {
  for (const sqlite of databases.splice(0)) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    sqlite.close(false);
  }
});

function seed(target: Fixture): void {
  const firstAddress = address({
    addressRefId: ids.address1,
    payloadRefId: ids.addressPayload1,
    contactRefId: 'contact-ada',
    value: exactAddresses[0]!,
    fill: '6'
  });
  const secondAddress = address({
    addressRefId: ids.address2,
    payloadRefId: ids.addressPayload2,
    contactRefId: 'contact-grace',
    value: exactAddresses[1]!,
    fill: '6'
  });
  target.sqlite.transaction(() => {
    for (const row of candidates) target.repository.upsertCurrentCandidate(ids, row);
    target.repository.registerAudienceRecipe(ids, {
      schemaVersion: 1,
      optionId: ids.option,
      optionVersion: 1,
      optionDigestSha256: digest('8'),
      label: 'Accepted speakers',
      recipientEstimate: { knowledge: 'known', value: 3 },
      audienceDraft: audience
    });
    target.repository.replaceRegisteredAudienceCurrentSnapshot({
      scope: ids,
      source,
      candidates,
      sourceVersions: [{ sourceKey: 'program.decisions', sourceVersion: 7, digestSha256: digest('9') }]
    });
    target.repository.putCurrentAddress({ scope: ids, address: firstAddress, createdAt: now });
    target.repository.putCurrentAddress({ scope: ids, address: secondAddress, createdAt: now });
    target.repository.putCurrentAddressPolicy({
      scope: ids,
      purposeRevision,
      contactRefId: 'contact-ada',
      resolution: evaluatedPolicy(firstAddress, 'a')
    });
    target.repository.putCurrentAddressPolicy({
      scope: ids,
      purposeRevision,
      contactRefId: 'contact-grace',
      resolution: evaluatedPolicy(secondAddress, 'b')
    });
    target.repository.putCurrentAddressPolicy({
      scope: ids,
      purposeRevision,
      contactRefId: 'contact-katherine',
      resolution: {
        kind: 'no_eligible_address',
        evidence: evidence('no-address-katherine', 'c')
      }
    });
  }).immediate();
}

describe('disposable SQLite organizer audience and preview packet', () => {
  test('resolves only an exact registered source/current snapshot and pages source-neutral options', () => {
    const target = fixture();
    seed(target);
    const page = target.repository.listAudienceOptions(ids, ownerKey, { limit: 1 });
    expect(page).toMatchObject({
      kind: 'success',
      data: {
        schemaVersion: 1,
        rows: [{ label: 'Accepted speakers', recipientEstimate: { knowledge: 'known', value: 1 } }]
      }
    });
    const snapshot = target.repository.resolveCurrentSnapshot({ scope: ids, audience });
    expect(snapshot.candidates.map((candidate) => candidate.subjectRefId)).toEqual([
      'subject-ada', 'subject-grace', 'subject-katherine'
    ]);
    expect(snapshot.sourceVersions).toEqual([
      { sourceKey: 'program.decisions', sourceVersion: 7, digestSha256: digest('9') }
    ]);
    expect(target.sqlite.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM communication_channel_address_versions
    `).get()?.count).toBe(2);
    expect(target.sqlite.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM communication_channel_address_versions
       WHERE lookup_keyed_value=?
    `).get(digest('6'))?.count).toBe(2);
    expect(() => target.repository.resolveCurrentSnapshot({
      scope: ids,
      audience: {
        ...audience,
        source: { ...source, recipeDigestSha256: digest('f') }
      }
    })).toThrow('source_not_registered');
  });

  test('keeps exact addresses and rendered content out of ordinary SQLite while preserving exact preview binding', async () => {
    const target = fixture();
    seed(target);
    for (const exact of exactAddresses) {
      expect(new TextDecoder().decode(target.sqlite.serialize())).not.toContain(exact);
    }
    const prepared = await target.repository.preparePreview({
      scope: ids, ownerKey, draftId: ids.draftId, expectedDraftVersion: 1, now
    });
    const summary = target.sqlite.transaction(() => target.repository.adoptPreparedPreview({
      preparation: prepared,
      scope: ids,
      ownerKey,
      now
    })).immediate();
    expect(summary.counts).toEqual({
      visibleCandidateCount: 3, includedCount: 1, excludedCount: 1, blockedCount: 1
    });
    expect(target.zeroized).toHaveLength(1);
    expect(target.zeroized[0]?.every((byte) => byte === 0)).toBe(true);
    const ordinary = target.sqlite.query<{ summary_json: string }, []>(`
      SELECT summary_json FROM communication_message_preview_snapshots
    `).get();
    expect(ordinary?.summary_json).not.toContain('@');
    const serializedAfterPreview = new TextDecoder().decode(target.sqlite.serialize());
    expect(serializedAfterPreview).not.toContain(exactAddresses[0]!);
    expect(serializedAfterPreview).not.toContain('Hello Ada');

    const masked = await target.repository.listMessagePreviewRecipients(
      ids, ownerKey, { ...summary.identity, limit: 200 }, 'masked'
    );
    expect(masked.kind).toBe('success');
    if (masked.kind !== 'success') throw new TypeError('expected success');
    const maskedPage = organizerMessagePreviewRecipientPageSchema.parse(masked.data);
    expect(maskedPage.rows[0]?.recipientResolutionId).toMatch(/^rr1_/);
    expect(maskedPage.rows[0]?.channel).toEqual({ disclosure: 'masked', maskedValue: 's***@e***.test' });
    expect(JSON.stringify(masked)).not.toContain(exactAddresses[0]!);

    const exact = await target.repository.listMessagePreviewRecipients(
      ids, ownerKey, { ...summary.identity, state: 'included', limit: 200 }, 'exact_authorized'
    );
    expect(exact).toMatchObject({
      kind: 'success', data: { rows: [{ channel: { disclosure: 'exact_authorized', exactValue: exactAddresses[0] } }] }
    });
    if (exact.kind !== 'success') throw new TypeError('expected success');
    const exactPage = organizerMessagePreviewRecipientPageSchema.parse(exact.data);
    const detail = await target.repository.getMessageBatchPreview(ids, ownerKey, {
      ...summary.identity,
      selectedRecipientResolutionId: exactPage.rows[0]!.recipientResolutionId
    });
    expect(detail).toMatchObject({
      kind: 'success', data: { selected: { kind: 'rendered_email', render: { subject: 'Hello Ada' } } }
    });
    expect(await target.repository.getMessageBatchPreview(ids, ownerKey, {
      ...summary.identity, previewDigestSha256: digest('0')
    })).toMatchObject({
      kind: 'outcome', outcome: { class: 'stale_revision', kind: 'communication.revision_changed' }
    });
    expect(await target.repository.listMessagePreviewRecipients(
      ids, ownerKey, { ...summary.identity, limit: 201 }, 'masked'
    )).toMatchObject({
      kind: 'outcome', outcome: { class: 'policy_violation', kind: 'communication.preview_invalid' }
    });
  });

  test('makes preparation one-use and zeroizes it on success, refusal, explicit disposal, and expiry', async () => {
    const target = fixture();
    seed(target);
    const successful = await target.repository.preparePreview({
      scope: ids, ownerKey, draftId: ids.draftId, expectedDraftVersion: 1, now
    });
    target.sqlite.transaction(() => target.repository.adoptPreparedPreview({
      preparation: successful, scope: ids, ownerKey, now
    })).immediate();
    expect(() => target.sqlite.transaction(() => target.repository.adoptPreparedPreview({
      preparation: successful, scope: ids, ownerKey, now
    })).immediate()).toThrow('preparation_spent');

    const refused = await target.repository.preparePreview({
      scope: ids, ownerKey, draftId: ids.draftId, expectedDraftVersion: 1, now
    });
    expect(() => target.sqlite.transaction(() => target.repository.adoptPreparedPreview({
      preparation: refused, scope: ids, ownerKey: 'b'.repeat(64), now
    })).immediate()).toThrow('preparation_scope_mismatch');
    expect(() => target.repository.disposePreparedPreview(refused)).toThrow('preparation_spent');

    const disposed = await target.repository.preparePreview({
      scope: ids, ownerKey, draftId: ids.draftId, expectedDraftVersion: 1, now
    });
    target.repository.disposePreparedPreview(disposed);
    expect(() => target.repository.disposePreparedPreview(disposed)).toThrow('preparation_spent');

    const expired = await target.repository.preparePreview({
      scope: ids, ownerKey, draftId: ids.draftId, expectedDraftVersion: 1, now
    });
    expect(target.repository.purgeExpiredPrepared('2026-08-13T08:01:00.000Z')).toBe(1);
    expect(() => target.sqlite.transaction(() => target.repository.adoptPreparedPreview({
      preparation: expired, scope: ids, ownerKey, now
    })).immediate()).toThrow('preparation_spent');

    const invalidScope = await target.repository.preparePreview({
      scope: ids, ownerKey, draftId: ids.draftId, expectedDraftVersion: 1, now
    });
    expect(() => target.sqlite.transaction(() => target.repository.adoptPreparedPreview({
      preparation: invalidScope,
      scope: { workspaceId: 'invalid' as typeof ids.workspaceId, eventId: ids.eventId },
      ownerKey,
      now
    })).immediate()).toThrow('invalid_input');
    expect(() => target.repository.disposePreparedPreview(invalidScope)).toThrow('preparation_spent');
    expect(target.zeroized).toHaveLength(5);
    expect(target.zeroized.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  });

  test('rolls classified adoption back even when its caller catches refusal and commits', async () => {
    const target = fixture();
    seed(target);
    const classifiedBefore = target.sqlite.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM classified_payload_records
    `).get()!.count;
    const prepared = await target.repository.preparePreview({
      scope: ids, ownerKey, draftId: ids.draftId, expectedDraftVersion: 1, now
    });
    target.sqlite.exec(`
      CREATE TRIGGER test_reject_preview_adoption
      BEFORE INSERT ON communication_message_preview_snapshots
      BEGIN SELECT RAISE(ABORT, 'test preview refusal'); END;
    `);
    let refused: unknown;
    target.sqlite.transaction(() => {
      try {
        target.repository.adoptPreparedPreview({ preparation: prepared, scope: ids, ownerKey, now });
      } catch (error) {
        refused = error;
      }
    }).immediate();
    expect(refused).toBeInstanceOf(SQLiteOrganizerAudiencePreviewError);
    expect(target.sqlite.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM communication_message_preview_snapshots
    `).get()?.count).toBe(0);
    expect(target.sqlite.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM classified_payload_records
    `).get()?.count).toBe(classifiedBefore);
    expect(target.zeroized).toHaveLength(1);
    expect(target.zeroized[0]?.every((byte) => byte === 0)).toBe(true);
  });

  test('binds a sealed preparation to the exact repository instance', async () => {
    const target = fixture();
    seed(target);
    const prepared = await target.repository.preparePreview({
      scope: ids, ownerKey, draftId: ids.draftId, expectedDraftVersion: 1, now
    });
    const otherRepository = new SQLiteOrganizerAudiencePreviewRepository(
      target.sqlite, target.classified, target.options
    );
    expect(() => target.sqlite.transaction(() => otherRepository.adoptPreparedPreview({
      preparation: prepared, scope: ids, ownerKey, now
    })).immediate()).toThrow('preparation_spent');
    expect(target.zeroized).toHaveLength(0);
    target.repository.disposePreparedPreview(prepared);
    expect(target.zeroized).toHaveLength(1);
    expect(target.zeroized[0]?.every((byte) => byte === 0)).toBe(true);
  });

  test('refuses a preview after current source evidence changes', async () => {
    const target = fixture();
    seed(target);
    const prepared = await target.repository.preparePreview({
      scope: ids, ownerKey, draftId: ids.draftId, expectedDraftVersion: 1, now
    });
    const summary = target.sqlite.transaction(() => target.repository.adoptPreparedPreview({
      preparation: prepared, scope: ids, ownerKey, now
    })).immediate();
    target.sqlite.transaction(() => target.repository.upsertCurrentCandidate(ids, {
      ...candidates[0], subjectVersion: 2, safeLabel: 'Ada Byron'
    })).immediate();
    expect(await target.repository.listMessagePreviewRecipients(
      ids, ownerKey, { ...summary.identity, limit: 200 }, 'masked'
    )).toMatchObject({
      kind: 'outcome', outcome: { class: 'stale_revision', kind: 'communication.revision_changed' }
    });
  });
});
