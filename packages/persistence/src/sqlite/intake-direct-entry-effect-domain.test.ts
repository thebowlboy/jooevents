import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
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
  CHANGESET_LIFECYCLE_ACCESS_POLICY,
  CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
  COMMIT_CHANGESET_OPERATION,
  PROPOSE_CHANGESET_OPERATION,
  changesetLifecycleOperationResultSchema,
  createChangesetOperationModule
} from '@jooevents/changeset-operations';
import {
  submissionDirectEntryDraftOperationResultSchema,
  type FieldRegistrySnapshotDto,
  type FormDefinitionCreateAuthorInput
} from '@jooevents/contracts';
import {
  applyFormMutationPlan,
  issueSubmissionDirectEntryChangesetPolicy,
  parseFormCatalogState,
  planFormCreation,
  planFormLifecycleChange
} from '@jooevents/intake';
import {
  SUBMISSION_DIRECT_ENTRY_ACCESS_POLICY,
  SUBMISSION_DIRECT_ENTRY_DRAFT_OPERATION,
  SUBMISSION_DIRECT_ENTRY_DRAFT_REQUEST_HASH_PROFILE,
  createSubmissionDirectEntryDraftOperationModule
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
import { openSQLite } from './database';
import { installSQLiteChangesetLifecycleSchema } from './changeset-lifecycle';
import { createSQLiteChangesetLifecycleEffectDomainRouter } from './changeset-lifecycle-effect-domain-router';
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
  installFoundationTrialUnitOfWorkSchema,
  type SQLiteEffectDomainAdapter
} from './foundation-trial-uow';
import { SQLiteIntakeClassifiedProjection } from './intake-classified-projection';
import {
  createSQLiteIntakeDirectEntryChangesetEffectDomainRegistration,
  createSQLiteIntakeDirectEntryDraftEffectDomainRegistration,
  installSQLiteIntakeDirectEntryEffectSchema,
  type SQLiteIntakeDirectEntryChangesetEffectIds,
  type SQLiteIntakeDirectEntryDraftEffectIds
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
const policy = issueSubmissionDirectEntryChangesetPolicy({
  key: 'submission.direct-entry.bounded', version: 1, approval: { create: 'none' }
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

function count(sqlite: ReturnType<typeof openSQLite>['sqlite'], table: string): number {
  return sqlite.query<{ readonly total: number }, []>(`SELECT count(*) AS total FROM ${table}`)
    .get()?.total ?? -1;
}

function failOnFact(base: SQLiteEffectDomainAdapter): SQLiteEffectDomainAdapter {
  return {
    openHandlerSnapshot: base.openHandlerSnapshot.bind(base),
    applyDomainContribution: base.applyDomainContribution.bind(base),
    ...(base.afterReceiptParentInserted
      ? { afterReceiptParentInserted: base.afterReceiptParentInserted.bind(base) } : {}),
    afterReceiptChildInserted(receiptId, contribution) {
      if ((contribution as { readonly kind?: unknown }).kind === 'domain_fact') {
        throw new TypeError('injected_direct_entry_fact_failure');
      }
      return base.afterReceiptChildInserted?.(receiptId, contribution);
    },
    ...(base.afterExecutionClaimReleased
      ? { afterExecutionClaimReleased: base.afterExecutionClaimReleased.bind(base) } : {}),
    ...(base.afterUnitOfWorkCommitted
      ? { afterUnitOfWorkCommitted: base.afterUnitOfWorkCommitted.bind(base) } : {}),
    ...(base.afterUnitOfWorkFinished
      ? { afterUnitOfWorkFinished: base.afterUnitOfWorkFinished.bind(base) } : {})
  };
}

function openFixture(options: { readonly failFact?: boolean } = {}) {
  const { sqlite } = openSQLite(':memory:');
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installSQLiteIntakeSchema(sqlite);
  installFieldRegistrySchema(sqlite);
  installDeadlineSchema(sqlite);
  installSQLiteSubmissionTriageSchema(sqlite);
  installSQLiteClassifiedPayloadStoreSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installSQLiteIntakeDirectEntryEffectSchema(sqlite);
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
  let changesetIdOverride: string | undefined;
  const draftIds: SQLiteIntakeDirectEntryDraftEffectIds = {
    newChangesetId: () => changesetIdOverride ?? next(),
    newRevisionId: next,
    newPreparationHandle: next,
    newTimelineId: next,
    newPayloadRefId: next,
    newSubmissionId: next,
    newEntryEvidenceId: next,
    newPersonId: next,
    newParticipantIdentityId: next,
    newParticipantEvidenceId: next
  };
  const lifecycleIds: SQLiteIntakeDirectEntryChangesetEffectIds = {
    newChangesetId: next, newRevisionId: next, newApprovalId: next,
    newCorrectionAttemptId: next, newPreparationHandle: next,
    newTimelineId: next, newFactId: next, newPointerId: next
  };
  const eventRelationships = createSQLiteEventSpineOperatorEventRelationshipSource();
  const submissionTriage = createSubmissionTriageSubmitInitializer({
    store: triageRepository,
    ids: { newArrivalId: next }
  });
  let referenceCount = 0;
  const draftRegistration = createSQLiteIntakeDirectEntryDraftEffectDomainRegistration({
    sqlite, workspaceId, policy, repository, classifiedStore,
    classifiedProfiles: profiles, eventRelationships, ids: draftIds
  });
  const lifecycleRegistration = createSQLiteIntakeDirectEntryChangesetEffectDomainRegistration({
    sqlite, workspaceId, policy, repository, projection, submissionTriage,
    references: [{ countSubmissionReferences: () => referenceCount }],
    eventRelationships, ids: lifecycleIds
  });
  const routed = createSQLiteChangesetLifecycleEffectDomainRouter([{
    ownerId: lifecycleRegistration.ownerId,
    adapter: options.failFact
      ? failOnFact(lifecycleRegistration.adapter)
      : lifecycleRegistration.adapter,
    ownerResolution: lifecycleRegistration.ownerResolution,
    subjectRelationships: lifecycleRegistration.subjectRelationships
  }]);
  const adapters = createSQLiteEffectDomainAdapterRegistry([draftRegistration, routed]);
  let revoked = false;
  let grantKey = 'event.manage';
  let currentTime: Instant = start;
  const authority: Parameters<
    typeof createSubmissionDirectEntryDraftOperationModule
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
  const draftModule = createSubmissionDirectEntryDraftOperationModule({
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
        profile: SUBMISSION_DIRECT_ENTRY_DRAFT_REQUEST_HASH_PROFILE,
        keyBytes: new Uint8Array(32).fill(0x64)
      }),
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: {
        seal(raw: string) {
          return {
            verifierProfile: profile,
            verifierSha256: createHash('sha256').update(`draft:${raw}`).digest('hex')
          };
        }
      }
    }
  });
  const lifecycleModule = createChangesetOperationModule({
    workspaceId, policy: CHANGESET_LIFECYCLE_ACCESS_POLICY,
    currentAuthority: authority,
    lifecycleStore: lifecycleRegistration.lifecycleStore,
    ownerResolution: routed.ownerResolution,
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x46)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw) {
        return {
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`lifecycle:${raw}`).digest('hex')
        };
      }
    }
  });
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, adapters, {
    resolveAuthority: authority.resolve, now: () => currentTime
  });
  let receipt = 0x8000;
  const runtime = createApplicationOperationRuntime({
    source: composeOperationRegistryModules([draftModule, lifecycleModule]),
    read: {
      operationalTrace: { emit() {} }, immutableAudit: { append() {} },
      clock: { now: () => currentTime }, newInvocationId: () => parseInvocationId(next())
    },
    unitOfWork, newReceiptId: () => id(receipt++)
  });
  let request = 0x9000;
  return {
    sqlite, repository, triageRepository,
    lifecycle: lifecycleRegistration.lifecycleStore,
    ownerResolution: routed.ownerResolution,
    close: () => sqlite.close(),
    setRevoked(value: boolean) { revoked = value; },
    setGrantKey(value: string) { grantKey = value; },
    setReferenceCount(value: number) { referenceCount = value; },
    forceNextChangesetId(value: string | undefined) { changesetIdOverride = value; },
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
    receipts: count(fixture.sqlite, 'foundation_trial_operation_receipts'),
    audits: count(fixture.sqlite, 'foundation_trial_operation_audits'),
    submissions: count(fixture.sqlite, 'intake_submission_heads'),
    entryEvidence: count(fixture.sqlite, 'intake_submission_direct_entry_evidence'),
    participants: count(fixture.sqlite, 'intake_submission_participant_evidence'),
    arrivals: count(fixture.sqlite, 'submission_arrival_facts'),
    triageHeads: count(fixture.sqlite, 'submission_triage_heads'),
    draftLinks: count(fixture.sqlite, 'intake_direct_entry_draft_receipt_links'),
    lifecycleLinks: count(fixture.sqlite, 'intake_direct_entry_changeset_receipt_links'),
    facts: count(fixture.sqlite, 'intake_direct_entry_changeset_domain_facts'),
    pointers: count(fixture.sqlite, 'intake_direct_entry_changeset_outbox_pointers'),
    commits: count(fixture.sqlite, 'changeset_commit_links')
  };
}

async function draftEntry(
  fixture: ReturnType<typeof openFixture>,
  key: string,
  input: Record<string, unknown> = {}
) {
  return submissionDirectEntryDraftOperationResultSchema.parse(await fixture.effect(
    SUBMISSION_DIRECT_ENTRY_DRAFT_OPERATION,
    {
      formId,
      expectedFormDefinitionVersion: 2,
      answers: goodAnswers,
      ...input
    },
    key
  ));
}

async function draftAndPropose(fixture: ReturnType<typeof openFixture>, key: string) {
  const draft = await draftEntry(fixture, `${key}-draft`);
  if (draft.kind !== 'success') throw new TypeError('direct_entry_draft_failed');
  const selector = {
    changesetId: draft.data.changesetId,
    revisionId: draft.data.revision.id,
    revisionDigest: draft.data.revision.digestSha256
  };
  const proposed = changesetLifecycleOperationResultSchema.parse(await fixture.effect(
    PROPOSE_CHANGESET_OPERATION,
    { ...selector, expectedHeadVersion: draft.data.headVersion },
    `${key}-propose`
  ));
  if (proposed.kind !== 'success' || proposed.data.action !== 'propose') {
    throw new TypeError('direct_entry_propose_failed');
  }
  return { draft, selector, proposedHeadVersion: proposed.data.diff.headVersion };
}

describe('SQLite direct-entry effect domains', () => {
  test('commits one submission with same-transaction triage initialization, replay-safe receipts, and typed authority denial', async () => {
    const fixture = openFixture();
    try {
      const entryTime = fixture.currentTime();
      const { draft, selector, proposedHeadVersion } = await draftAndPropose(fixture, 'happy');
      if (draft.kind !== 'success') throw new TypeError('draft_failed');
      expect(draft.data).toMatchObject({
        action: 'create', riskTier: 'low', status: 'draft'
      });
      const submissionId = draft.data.safeDiff.submission.id;
      expect(draft.data.safeDiff.submission).toMatchObject({
        source: 'direct_entry', formId, formVersionId, submittedAt: entryTime
      });
      expect(JSON.stringify(draft.data.safeDiff)).not.toContain('entered.speaker@example.test');
      expect(await fixture.ownerResolution.resolveOwner(
        fixture.lifecycle.read(selector.changesetId)!
      )).toMatchObject({ id: 'intake_direct_entry' });
      // Nothing effective exists while the changeset is only drafted/proposed.
      expect(fixture.repository.readSubmissionHead({ workspaceId, eventId }, submissionId))
        .toBeUndefined();
      expect(fixture.triageRepository.readTriageState({ workspaceId, eventId })).toBeUndefined();

      fixture.advance();
      const commitInput = { ...selector, expectedHeadVersion: proposedHeadVersion };
      const committed = changesetLifecycleOperationResultSchema.parse(await fixture.effect(
        COMMIT_CHANGESET_OPERATION, commitInput, 'happy-commit'
      ));
      expect(committed).toMatchObject({ kind: 'success', data: { action: 'commit' } });
      if (committed.kind !== 'success') throw new TypeError('commit_failed');

      const head = fixture.repository.readSubmissionHead({ workspaceId, eventId }, submissionId);
      expect(head).toMatchObject({
        source: 'direct_entry', status: 'submitted', version: 1, submittedAt: entryTime
      });
      const entryEvidence = fixture.repository.readDirectEntryEvidence(
        { workspaceId, eventId }, submissionId
      );
      expect(entryEvidence).toMatchObject({ enteredByUserId: userId, submittedAt: entryTime });
      const triage = fixture.triageRepository.readTriageState({ workspaceId, eventId });
      expect(triage?.entries).toHaveLength(1);
      expect(triage?.entries[0]).toMatchObject({
        arrival: { source: 'direct_entry', classification: 'on_time', closeEvidence: null },
        head: { state: 'inbox', version: 1 }
      });
      const factRow = fixture.sqlite.query<{ readonly payload_json: string }, []>(`
        SELECT payload_json FROM intake_direct_entry_changeset_domain_facts
      `).get();
      expect(factRow).toBeDefined();
      const payload = JSON.parse(factRow!.payload_json) as {
        readonly contributions: readonly { readonly result: {
          readonly submissionId: string;
          readonly undo: { readonly kind: string; readonly submissionId: string };
          readonly triage: { readonly replay: boolean };
        }; }[];
      };
      expect(payload.contributions[0]?.result).toMatchObject({
        submissionId,
        undo: { kind: 'submission_triage_discard_recoverable', submissionId },
        triage: { replay: false }
      });
      expect(JSON.stringify(fixture.sqlite.query('SELECT * FROM changeset_revisions').all()))
        .not.toContain('entered.speaker@example.test');
      expect(JSON.stringify(fixture.sqlite.query('SELECT * FROM intake_submission_direct_entry_evidence').all()))
        .not.toContain('entered.speaker@example.test');
      const committedCounts = durableCounts(fixture);
      expect(committedCounts).toMatchObject({
        submissions: 1, entryEvidence: 1, participants: 1, arrivals: 1, triageHeads: 1,
        draftLinks: 1, lifecycleLinks: 2, facts: 1, pointers: 1, commits: 1
      });

      // Response loss: replaying the same idempotency key returns the stored receipt.
      const replayed = await fixture.effect(
        COMMIT_CHANGESET_OPERATION, commitInput, 'happy-commit'
      );
      expect(replayed).toMatchObject({ kind: 'success', receipt: { id: committed.receipt.id } });
      expect(durableCounts(fixture)).toEqual({
        ...committedCounts, audits: committedCounts.audits + 1
      });

      // Idempotent-key reuse with a different request refuses instead of double-writing.
      const conflictBase = durableCounts(fixture);
      expect(await fixture.effect(
        COMMIT_CHANGESET_OPERATION,
        { ...commitInput, expectedHeadVersion: commitInput.expectedHeadVersion + 1 },
        'happy-commit'
      )).toMatchObject({
        kind: 'outcome',
        outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
      });
      expect(durableCounts(fixture)).toEqual({
        ...conflictBase, audits: conflictBase.audits + 1
      });

      // Authority denial is a typed outcome, not a silent skip.
      fixture.setRevoked(true);
      fixture.advance();
      const deniedBase = durableCounts(fixture);
      expect(await draftEntry(fixture, 'revoked-draft')).toMatchObject({
        kind: 'outcome', outcome: { class: 'access_denied', kind: 'authority.revoked' }
      });
      expect(durableCounts(fixture)).toEqual({
        ...deniedBase, audits: deniedBase.audits + 1
      });
      fixture.setRevoked(false);

      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally { fixture.close(); }
  });

  test('missing permission grant, cross-scope form, and duplicate server ids all refuse without partial writes', async () => {
    const fixture = openFixture();
    try {
      const before = durableCounts(fixture);
      fixture.setGrantKey('event.read');
      await expect(draftEntry(fixture, 'wrong-grant'))
        .rejects.toThrow('Operation execution failed during write_snapshot.');
      fixture.setGrantKey('event.manage');
      expect(durableCounts(fixture)).toEqual(before);

      // A form outside the current event scope is invisible, not borrowable.
      expect(fixture.repository.readFormHead(
        { workspaceId, eventId: otherEventId }, formId
      )).toBeUndefined();
      const crossScope = await draftEntry(fixture, 'cross-scope', { formId: id(0x7777) });
      expect(crossScope).toMatchObject({
        kind: 'outcome',
        outcome: {
          class: 'stale_revision',
          kind: 'submission_direct_entry.changed',
          detail: { code: 'form_missing', action: 'create' }
        }
      });

      const first = await draftEntry(fixture, 'collision-first');
      if (first.kind !== 'success') throw new TypeError('draft_failed');
      const collisionBase = durableCounts(fixture);
      fixture.forceNextChangesetId(first.data.changesetId);
      await expect(draftEntry(fixture, 'collision-second')).rejects.toThrow();
      fixture.forceNextChangesetId(undefined);
      expect(durableCounts(fixture)).toEqual(collisionBase);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally { fixture.close(); }
  });

  test('typed refusals: titleless, missing email, consent transcription, closed form, and no backdated submittedAt input', async () => {
    const fixture = openFixture();
    try {
      const refused = (detailCode: string, kind = 'submission_direct_entry.refused', klass = 'policy_violation') =>
        expect.objectContaining({
          kind: 'outcome',
          outcome: expect.objectContaining({
            class: klass, kind, retryable: false,
            detail: expect.objectContaining({ code: detailCode, action: 'create', formId })
          })
        });
      expect(await draftEntry(fixture, 'titleless', {
        answers: goodAnswers.filter((answer) => answer.fieldId !== titleId)
      })).toEqual(refused('direct_entry_title_required'));
      expect(await draftEntry(fixture, 'emailless', {
        answers: goodAnswers.filter((answer) => answer.fieldId !== emailId)
      })).toEqual(refused('direct_entry_email_required'));
      expect(await draftEntry(fixture, 'consented', {
        answers: [...goodAnswers, { kind: 'checkbox', fieldId: consentId, checked: true }]
      })).toEqual(refused('invalid_answers'));

      // The wire cannot carry its own submittedAt or source: strict input refuses.
      await expect(draftEntry(fixture, 'backdated', {
        submittedAt: '2020-01-01T00:00:00.000Z'
      })).rejects.toBeDefined();
      await expect(draftEntry(fixture, 'sourced', { source: 'public_form' }))
        .rejects.toBeDefined();

      // Stale expected form version refuses as stale, never writes.
      expect(await draftEntry(fixture, 'stale-version', {
        expectedFormDefinitionVersion: 9
      })).toEqual(refused('form_version_mismatch', 'submission_direct_entry.changed', 'stale_revision'));

      // Close the form, then both a fresh draft and a pre-closed commit refuse.
      const { selector, proposedHeadVersion } = await draftAndPropose(fixture, 'pre-close');
      const registry = fixture.repository.readFieldRegistrySnapshot({ workspaceId, eventId })!;
      const catalog = fixture.repository.readFormCatalog({ workspaceId, eventId })!;
      const head = catalog.heads.find((candidate) => candidate.id === formId)!;
      const close = planFormLifecycleChange({
        head,
        registry,
        existingVersions: fixture.repository.readFormVersions({ workspaceId, eventId }, formId),
        authorInput: {
          transition: 'close',
          formId,
          expectedDefinitionVersion: head.version
        },
        references: fixture.repository,
        server: { updatedByUserId: userId, updatedAt: fixture.currentTime() }
      });
      fixture.sqlite.exec('BEGIN IMMEDIATE');
      fixture.repository.applyFormMutation(close);
      fixture.sqlite.exec('COMMIT');

      expect(await draftEntry(fixture, 'closed-draft'))
        .toEqual(refused('form_not_open', 'submission_direct_entry.changed', 'stale_revision'));
      const beforeCommit = durableCounts(fixture);
      const closedCommit = await fixture.effect(
        COMMIT_CHANGESET_OPERATION,
        { ...selector, expectedHeadVersion: proposedHeadVersion },
        'closed-commit'
      );
      expect(closedCommit).toMatchObject({ kind: 'outcome' });
      const after = durableCounts(fixture);
      expect(after.submissions).toBe(beforeCommit.submissions);
      expect(after.arrivals).toBe(beforeCommit.arrivals);
      expect(after.commits).toBe(beforeCommit.commits);
      expect(after.facts).toBe(beforeCommit.facts);
    } finally { fixture.close(); }
  });

  test('a late commit-evidence failure rolls the submission, triage spine, and receipts back atomically', async () => {
    const fixture = openFixture({ failFact: true });
    try {
      const { draft, selector, proposedHeadVersion } = await draftAndPropose(fixture, 'rollback');
      if (draft.kind !== 'success') throw new TypeError('draft_failed');
      const submissionId = draft.data.safeDiff.submission.id;
      const before = durableCounts(fixture);
      await expect(fixture.effect(
        COMMIT_CHANGESET_OPERATION,
        { ...selector, expectedHeadVersion: proposedHeadVersion },
        'rollback-commit'
      )).rejects.toThrow('Operation execution failed during receipt_children.');
      expect(durableCounts(fixture)).toEqual(before);
      expect(fixture.repository.readSubmissionHead({ workspaceId, eventId }, submissionId))
        .toBeUndefined();
      expect(fixture.triageRepository.readTriageState({ workspaceId, eventId })).toBeUndefined();
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally { fixture.close(); }
  });
});
