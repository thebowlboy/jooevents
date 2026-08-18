import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  composeOperationRegistryModules,
  createApplicationOperationRuntime,
  createClassifiedPayloadProfileRef,
  createHmacRequestHashSealer,
  type InvocationEvidence
} from '@jooevents/application';
import {
  issueSynchronousClassifiedPayloadEncryptionProfile,
  type SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  submissionDirectEntryOperationResultSchema,
  type FieldRegistrySnapshotDto,
  type FormDefinitionCreateAuthorInput
} from '@jooevents/contracts';
import {
  applyFormMutationPlan,
  parseFormCatalogState,
  planFormCreation,
  planFormLifecycleChange
} from '@jooevents/intake';
import {
  SUBMISSION_DIRECT_ENTRY_ACCESS_POLICY,
  SUBMISSION_DIRECT_ENTRY_CREATE_OPERATION,
  SUBMISSION_DIRECT_ENTRY_REQUEST_HASH_PROFILE,
  createSubmissionDirectEntryOperationModule
} from '@jooevents/intake-operations';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId,
  type Instant
} from '@jooevents/kernel';
import { createSubmissionTriageSubmitInitializer } from '@jooevents/submission-triage';
import { installDeadlineSchema } from './deadline';
import {
  createSQLiteEventSpineOperatorEventRelationshipSource,
  installEventSpineSchema
} from './event-spine';
import {
  initializeCanonicalFieldRegistry,
  installFieldRegistrySchema
} from './field-registry';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema
} from './foundation-trial-uow';
import { SQLiteIntakeClassifiedProjection } from './intake-classified-projection';
import {
  createSQLiteIntakeDirectEntryEffectDomainRegistration,
  type SQLiteIntakeDirectEntryEffectIds
} from './intake-direct-entry-effect-domain';
import { installSQLiteIntakeSchema, SQLiteIntakeRepository } from './intake';
import { installProgramVocabularySchema } from './program-vocabulary';
import {
  installSQLiteClassifiedPayloadStoreSchema,
  SQLiteClassifiedPayloadStore
} from './sqlite-classified-payload-store';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';
import {
  installSQLiteSubmissionTriageSchema,
  SQLiteIntakeSubmissionTriageSourceAdapter,
  SQLiteSubmissionTriageRepository
} from './submission-triage';

const id = (suffix: number): string =>
  `019c1df8-96b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = parseWorkspaceId(id(1));
const eventId = parseEventId(id(2));
const otherEventId = parseEventId(id(3));
const userId = parseUserId(id(4));
const membershipId = parseMembershipId(id(5));
const formId = id(6);
const formVersionId = id(7);
const titleId = id(8);
const emailId = id(9);
const consentId = id(10);
const trackFieldId = id(11);
const trackChoiceId = id(12);
const start = parseInstant('2026-08-13T09:00:00.000Z');
const profile = Object.freeze({ key: 'direct-entry-sqlite-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator', surface: 'operator_http', client: { key: 'web.operator' },
  sessionHandle: 'verified-session-handle'
});

const goodAnswers = Object.freeze([
  { kind: 'text' as const, fieldId: titleId, value: 'Directly entered talk' },
  { kind: 'email' as const, fieldId: emailId, value: 'entered.speaker@example.test' },
  { kind: 'select' as const, fieldId: trackFieldId, choiceId: trackChoiceId }
]);

function definition(registry: FieldRegistrySnapshotDto): FormDefinitionCreateAuthorInput {
  const included = new Set([titleId, emailId, consentId, trackFieldId]);
  return {
    kind: 'cfp', name: 'Main CFP', target: { kind: 'general_pool' },
    availability: { kind: 'evergreen' }, confirmation: 'Received.',
    composition: {
      excludedFieldIds: registry.fields
        .filter((field) => field.contexts.apply.visible && !included.has(field.id))
        .map((field) => field.id)
        .sort(),
      requiredOverrides: {},
      optionExposure: {}
    },
    rules: []
  };
}

const profiles = Object.freeze({
  classification: createClassifiedPayloadProfileRef(
    'classification', 'classification.intake-sensitive', 1
  ),
  schema: createClassifiedPayloadProfileRef('schema', 'schema.intake-answer', 1),
  content: createClassifiedPayloadProfileRef('content', 'content.intake-answer', 1),
  integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
  descriptorAuth: createClassifiedPayloadProfileRef(
    'descriptor_auth', 'descriptor-auth.intake-answer', 1
  )
});

function count(sqlite: Database, table: string): number {
  return sqlite.query<{ readonly total: number }, []>(`SELECT count(*) AS total FROM ${table}`)
    .get()?.total ?? -1;
}

function openFixture() {
  const sqlite = new Database(':memory:', { create: true, strict: true });
  sqlite.exec('PRAGMA foreign_keys = ON;');
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installSQLiteIntakeSchema(sqlite);
  installFieldRegistrySchema(sqlite);
  installDeadlineSchema(sqlite);
  installSQLiteSubmissionTriageSchema(sqlite);
  installSQLiteClassifiedPayloadStoreSchema(sqlite);
  sqlite.query(`INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, 'Workspace', 'active', 1, 1, 1)`).run(workspaceId);
  sqlite.query(`INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', 'Organizer', 1, 1, 1)`).run(userId);
  sqlite.exec('BEGIN IMMEDIATE');
  sqlite.query(`INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
    VALUES (?, 1, NULL)`).run(workspaceId);
  sqlite.query(`INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Direct Entry Event', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)`)
    .run(workspaceId, eventId, userId, Date.parse(start), 'a'.repeat(64));
  sqlite.query(`INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)`)
    .run(workspaceId, eventId);
  sqlite.query(`INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Other Event', 'UTC', '2026-12-01', '2026-12-02', 1, ?, ?, ?)`)
    .run(workspaceId, otherEventId, userId, Date.parse(start), 'b'.repeat(64));
  sqlite.query(`INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)`)
    .run(workspaceId, otherEventId);
  sqlite.query(`UPDATE event_spine_workspace_sets
    SET version = 2, current_event_id = ? WHERE workspace_id = ?`).run(eventId, workspaceId);
  sqlite.query(`INSERT INTO program_vocabulary_sets (
      workspace_id, event_id, set_version, created_by_user_id, created_at_ms,
      updated_by_user_id, updated_at_ms
    ) VALUES (?, ?, 2, ?, ?, ?, ?)`)
    .run(workspaceId, eventId, userId, Date.parse(start), userId, Date.parse(start));
  sqlite.query(`INSERT INTO program_vocabulary_tracks (
      workspace_id, event_id, id, name, status, version, created_by_user_id,
      created_at_ms, updated_by_user_id, updated_at_ms
    ) VALUES (?, ?, ?, 'Applied AI', 'active', 1, ?, ?, ?, ?)`)
    .run(workspaceId, eventId, trackChoiceId, userId, Date.parse(start), userId, Date.parse(start));
  sqlite.exec('COMMIT');

  let nextFieldId = 0x100;
  let nextChoiceId = 0x200;
  sqlite.exec('BEGIN IMMEDIATE');
  initializeCanonicalFieldRegistry({
    sqlite,
    scope: { workspaceId, eventId },
    ids: {
      newFieldId(key) {
        if (key === 'talk.title') return titleId;
        if (key === 'talk.track') return trackFieldId;
        if (key === 'person.email') return emailId;
        if (key === 'person.recording_consent') return consentId;
        return id(nextFieldId++);
      },
      newChoiceId() { return id(nextChoiceId++); }
    }
  });
  sqlite.exec('COMMIT');

  const encryption = issueSynchronousClassifiedPayloadEncryptionProfile({
    reference: { key: 'encryption.direct-entry-test', version: 1 },
    keyBytes: new Uint8Array(32).fill(0x33)
  });
  let nonce = 1;
  const classifiedStore: SynchronousClassifiedPayloadStore = new SQLiteClassifiedPayloadStore(
    sqlite,
    { encryptionProfile: encryption, nonceSource: () => new Uint8Array(12).fill(nonce++) }
  );
  const projection = new SQLiteIntakeClassifiedProjection({ store: classifiedStore, profiles });
  const repository = new SQLiteIntakeRepository(sqlite, {
    resolveActiveCategory() { return undefined; }
  }, projection);

  sqlite.exec('BEGIN IMMEDIATE');
  const empty = parseFormCatalogState({ scope: { workspaceId, eventId }, version: 1, heads: [] });
  const registry = repository.readFieldRegistrySnapshot({ workspaceId, eventId });
  if (!registry) throw new TypeError('registry_fixture_missing');
  const create = planFormCreation({
    catalog: empty,
    registry,
    authorInput: {
      expectedCatalogVersion: 1,
      expectedRegistryVersion: registry.version,
      definition: definition(registry)
    },
    identities: { formId, rules: [] },
    references: repository,
    deadlineContribution: null,
    server: { createdByUserId: userId, createdAt: start }
  });
  const created = applyFormMutationPlan({
    catalog: empty, registry, plan: create, references: repository
  }).catalog;
  const open = planFormLifecycleChange({
    head: create.after,
    registry,
    existingVersions: [],
    authorInput: {
      transition: 'publish_and_open',
      formId,
      expectedDefinitionVersion: 1,
      expectedRegistryVersion: registry.version
    },
    references: repository,
    server: { formVersionId, updatedByUserId: userId, updatedAt: start }
  });
  applyFormMutationPlan({
    catalog: created, registry, plan: open, references: repository, existingVersions: []
  });
  repository.applyFormMutation(create);
  repository.applyFormMutation(open);
  sqlite.exec('COMMIT');

  const triageRepository = new SQLiteSubmissionTriageRepository(
    sqlite,
    new SQLiteIntakeSubmissionTriageSourceAdapter(repository)
  );
  let generated = 0x1000;
  const next = () => id(generated++);
  const ids: SQLiteIntakeDirectEntryEffectIds = {
    newPayloadRefId: next,
    newSubmissionId: next,
    newEntryEvidenceId: next,
    newPersonId: next,
    newParticipantIdentityId: next,
    newParticipantEvidenceId: next
  };
  const eventRelationships = createSQLiteEventSpineOperatorEventRelationshipSource();
  const submissionTriage = createSubmissionTriageSubmitInitializer({
    store: triageRepository,
    ids: { newArrivalId: next }
  });
  const registration = createSQLiteIntakeDirectEntryEffectDomainRegistration({
    sqlite, workspaceId, repository, projection, submissionTriage, classifiedStore,
    classifiedProfiles: profiles, eventRelationships, ids
  });
  const adapters = createSQLiteEffectDomainAdapterRegistry([registration]);
  let revoked = false;
  let grantKey = 'event.manage';
  let currentTime: Instant = start;
  const authority: Parameters<
    typeof createSubmissionDirectEntryOperationModule
  >[0]['currentAuthority'] = {
    resolve(input) {
      if (revoked) return { kind: 'denied', reason: 'revoked' };
      if (input.evidence.kind !== 'operator') return { kind: 'denied', reason: 'lane_mismatch' };
      return {
        kind: 'authorized',
        authority: {
          actor: { kind: 'workspace_user', userId },
          principal: { kind: 'workspace_user', userId, membershipId },
          lane: input.lane, scope: input.scope,
          grants: [{ kind: 'permission', key: grantKey }],
          evidenceIds: ['membership.current'], authorityCitationIds: [],
          evaluatedAt: input.evaluatedAt
        }
      };
    }
  };
  const directModule = createSubmissionDirectEntryOperationModule({
    workspaceId,
    policy: SUBMISSION_DIRECT_ENTRY_ACCESS_POLICY,
    currentAuthority: authority,
    currentEvent: { resolveCurrentEvent: () => ({ eventId, evidenceIds: ['event.current'] }) },
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    crypto: {
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      requestHashSealer: createHmacRequestHashSealer({
        profile: SUBMISSION_DIRECT_ENTRY_REQUEST_HASH_PROFILE,
        keyBytes: new Uint8Array(32).fill(0x64)
      }),
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: {
        seal(raw: string) {
          return {
            verifierProfile: profile,
            verifierSha256: createHash('sha256').update(`direct:${raw}`).digest('hex')
          };
        }
      }
    }
  });
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, adapters, {
    resolveAuthority: authority.resolve, now: () => currentTime
  });
  let receipt = 0x8000;
  const runtime = createApplicationOperationRuntime({
    source: composeOperationRegistryModules([directModule]),
    read: {
      operationalTrace: { emit() {} }, immutableAudit: { append() {} },
      clock: { now: () => currentTime }, newInvocationId: () => parseInvocationId(next())
    },
    unitOfWork, newOperationLogId: () => id(receipt++)
  });
  let request = 0x9000;
  return {
    sqlite, repository, triageRepository,
    close: () => sqlite.close(),
    setRevoked(value: boolean) { revoked = value; },
    setGrantKey(value: string) { grantKey = value; },
    advance() {
      currentTime = parseInstant(new Date(Date.parse(currentTime) + 1_000).toISOString());
    },
    currentTime: () => currentTime,
    async effect(
      operation: { readonly name: string; readonly version: number },
      businessInput: unknown,
      key: string
    ) {
      const composed = await runtime;
      const invocation = await composed.effectBuilder.build({
        operationName: operation.name, operationVersion: operation.version,
        surface: 'operator_http', correlationId: id(request++), businessInput,
        verifiedEvidence: evidence, rawIdempotencyKey: key
      });
      return composed.effectExecutor.execute(invocation);
    }
  };
}

function durableCounts(fixture: ReturnType<typeof openFixture>) {
  return {
    receipts: 0,
    audits: 0,
    submissions: count(fixture.sqlite, 'intake_submission_heads'),
    entryEvidence: count(fixture.sqlite, 'intake_submission_direct_entry_evidence'),
    participants: count(fixture.sqlite, 'intake_submission_participant_evidence'),
    arrivals: count(fixture.sqlite, 'submission_arrival_facts'),
    triageHeads: count(fixture.sqlite, 'submission_triage_heads'),
    operationLog: count(fixture.sqlite, 'operation_log')
  };
}

async function createEntry(
  fixture: ReturnType<typeof openFixture>,
  key: string,
  input: Record<string, unknown> = {}
) {
  return submissionDirectEntryOperationResultSchema.parse(await fixture.effect(
    SUBMISSION_DIRECT_ENTRY_CREATE_OPERATION,
    {
      formId,
      expectedFormDefinitionVersion: 2,
      answers: goodAnswers,
      ...input
    },
    key
  ));
}

describe('SQLite direct-entry direct effect domain', () => {
  test('one call commits submission and triage atomically, replays, and key-conflicts changed bytes', async () => {
    const fixture = openFixture();
    try {
      const entryTime = fixture.currentTime();
      const committed = await createEntry(fixture, 'direct-entry-one-key');
      expect(committed).toMatchObject({
        kind: 'success',
        data: { action: 'create', formId, formVersionId, source: 'direct_entry', submittedAt: entryTime }
      });
      if (committed.kind !== 'success') throw new TypeError('direct_entry_commit_failed');
      const submissionId = committed.data.submissionId;
      expect(fixture.repository.readSubmissionHead({ workspaceId, eventId }, submissionId))
        .toMatchObject({ source: 'direct_entry', status: 'submitted', version: 1 });
      expect(fixture.triageRepository.readTriageState({ workspaceId, eventId })?.entries[0])
        .toMatchObject({
          arrival: { source: 'direct_entry', classification: 'on_time' },
          head: { state: 'inbox', version: 1 }
        });
      expect(fixture.triageRepository.listSourceRows({ workspaceId, eventId })[0]?.track)
        .toEqual({ id: trackChoiceId, label: 'Applied AI' });
      const committedCounts = durableCounts(fixture);
      expect(committedCounts).toMatchObject({
        submissions: 1, entryEvidence: 1, participants: 1, arrivals: 1, triageHeads: 1,
        receipts: 0, operationLog: 1
      });
			expect(fixture.sqlite.query<{ summary: string }, []>(
				"SELECT summary FROM operation_log WHERE operation_name = 'submission.direct_entry.create'"
			).get()).toEqual({ summary: 'Added a direct-entry submission' });

      const replayed = await createEntry(fixture, 'direct-entry-one-key');
      expect(replayed).toMatchObject({ kind: 'success', receipt: { id: committed.receipt.id } });
      expect(durableCounts(fixture)).toEqual(committedCounts);

      expect(await createEntry(fixture, 'direct-entry-one-key', {
        answers: goodAnswers.map((answer) => answer.kind === 'text'
          ? { ...answer, value: 'Changed request' }
          : answer)
      })).toMatchObject({
        kind: 'outcome',
        outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
      });
      expect(durableCounts(fixture)).toEqual(committedCounts);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally { fixture.close(); }
  });

  test('current authority and form guards refuse without partial writes', async () => {
    const fixture = openFixture();
    try {
      const before = durableCounts(fixture);
      fixture.setRevoked(true);
      expect(await createEntry(fixture, 'revoked-direct-entry')).toMatchObject({
        kind: 'outcome', outcome: { class: 'access_denied', kind: 'authority.revoked' }
      });
      expect(durableCounts(fixture)).toEqual(before);
      fixture.setRevoked(false);
      expect(await createEntry(fixture, 'stale-form', {
        expectedFormDefinitionVersion: 1
      })).toMatchObject({
        kind: 'outcome',
        outcome: { class: 'stale_revision', kind: 'submission_direct_entry.changed' }
      });
      expect(durableCounts(fixture)).toMatchObject({
        submissions: 0, entryEvidence: 0, participants: 0, arrivals: 0, triageHeads: 0
      });
    } finally { fixture.close(); }
  });
});
