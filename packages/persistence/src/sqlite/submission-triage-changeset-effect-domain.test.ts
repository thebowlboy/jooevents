import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  composeOperationRegistryModules,
  createApplicationOperationRuntime,
  createHmacRequestHashSealer,
  type InvocationEvidence
} from '@jooevents/application';
import {
  submissionTriageDraftOperationResultSchema,
  submissionTriageSourceRowSchema,
  type SubmissionTriageSourceRowDto
} from '@jooevents/contracts/submission-triage';
import {
  CHANGESET_LIFECYCLE_ACCESS_POLICY,
  CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
  COMMIT_CHANGESET_OPERATION,
  DRAFT_CHANGESET_CORRECTION_OPERATION,
  PROPOSE_CHANGESET_OPERATION,
  changesetLifecycleOperationResultSchema,
  createChangesetOperationModule
} from '@jooevents/changeset-operations';
import {
  SUBMISSION_TRIAGE_DRAFT_OPERATION,
  SUBMISSION_TRIAGE_DRAFT_REQUEST_HASH_PROFILE,
  SUBMISSION_TRIAGE_MANAGE_ACCESS_POLICY,
  createSubmissionTriageDraftOperationModule,
  createSubmissionTriageInitialization,
  issueSubmissionTriageChangesetPolicy,
  type SubmissionTriageScope,
  type SubmissionTriageSourcePort
} from '@jooevents/submission-triage';
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
import { openSQLite } from './database';
import { installSQLiteChangesetLifecycleSchema } from './changeset-lifecycle';
import { createSQLiteChangesetLifecycleEffectDomainRouter } from './changeset-lifecycle-effect-domain-router';
import {
  createSQLiteEventSpineOperatorEventRelationshipSource,
  installEventSpineSchema
} from './event-spine';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema,
  type SQLiteEffectDomainAdapter
} from './foundation-trial-uow';
import {
  createSQLiteSubmissionTriageChangesetEffectDomainRegistration,
  installSQLiteSubmissionTriageChangesetEffectSchema,
  type SQLiteSubmissionTriageChangesetEffectIds
} from './submission-triage-changeset-effect-domain';
import {
  createSQLiteSubmissionTriageDraftEffectDomainRegistration,
  installSQLiteSubmissionTriageDraftEffectSchema,
  type SQLiteSubmissionTriageDraftEffectIds
} from './submission-triage-draft-effect-domain';
import {
  installSQLiteSubmissionTriageSchema,
  SQLiteSubmissionTriageRepository
} from './submission-triage';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa201');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfa202');
const submissionId = '019c1df7-86b5-769b-bba4-5f7097bfa301';
const formId = '019c1df7-86b5-769b-bba4-5f7097bfa302';
const formVersionId = '019c1df7-86b5-769b-bba4-5f7097bfa303';
const fieldId = '019c1df7-86b5-769b-bba4-5f7097bfa304';
const now = parseInstant('2026-08-13T09:00:00.000Z');
const profile = Object.freeze({ key: 'triage-sqlite-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator', surface: 'operator_http', client: { key: 'web.operator' },
  sessionHandle: 'verified-session-handle'
});
const policy = issueSubmissionTriageChangesetPolicy({
  key: 'submission.triage.bounded', version: 1,
  approval: { ordinary: 'none', discardRecoverable: 'none' }
});

function uuid(suffix: number): string {
  return `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
}

function count(sqlite: ReturnType<typeof openSQLite>['sqlite'], table: string): number {
  return sqlite.query<{ readonly count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
    .get()?.count ?? -1;
}

class Source implements SubmissionTriageSourcePort {
  readonly row: SubmissionTriageSourceRowDto = submissionTriageSourceRowSchema.parse({
    schemaVersion: 1,
    scope: { workspaceId, eventId },
    source: 'public_form',
    summary: {
      schemaVersion: 1, id: submissionId, formId, formVersionId,
      target: { kind: 'general_pool' }, title: 'A safe proposal',
      primaryParticipantName: 'Ada Example', submittedAt: now
    },
    detail: {
      schemaVersion: 1, submissionId, formId, formVersionId, submittedAt: now,
      participantCount: 1,
      answers: [{ kind: 'text', fieldId, fieldLabel: 'Session title', value: 'A safe proposal' }],
      affirmedConsentFieldIds: []
    },
    abstract: 'A recoverable triage test', track: null, format: null
  });
  listSourceRows(scope: SubmissionTriageScope) {
    return scope.workspaceId === workspaceId && scope.eventId === eventId ? [this.row] : [];
  }
  readSourceRow(scope: SubmissionTriageScope, candidate: string) {
    return candidate === submissionId ? this.listSourceRows(scope)[0] : undefined;
  }
}

function failOnFact(base: SQLiteEffectDomainAdapter): SQLiteEffectDomainAdapter {
  return {
    openHandlerSnapshot: base.openHandlerSnapshot.bind(base),
    applyDomainContribution: base.applyDomainContribution.bind(base),
    ...(base.afterReceiptParentInserted
      ? { afterReceiptParentInserted: base.afterReceiptParentInserted.bind(base) } : {}),
    afterReceiptChildInserted(receiptId, contribution) {
      if ((contribution as { readonly kind?: unknown }).kind === 'domain_fact') {
        throw new TypeError('injected_triage_fact_failure');
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
  installSQLiteChangesetLifecycleSchema(sqlite);
  installSQLiteSubmissionTriageSchema(sqlite);
  installSQLiteSubmissionTriageDraftEffectSchema(sqlite);
  installSQLiteSubmissionTriageChangesetEffectSchema(sqlite);
  sqlite.query(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, 'Primary workspace', 'active', 1, 1, 1)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', 'Triage owner', 1, 1, 1)
  `).run(userId);
  sqlite.exec('BEGIN IMMEDIATE');
  sqlite.query(`
    INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
    VALUES (?, 1, NULL)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Triage Event', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)
  `).run(workspaceId, eventId, userId, Date.parse(now), 'a'.repeat(64));
  sqlite.query(`
    INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)
  `).run(workspaceId, eventId);
  sqlite.query(`
    UPDATE event_spine_workspace_sets SET version = 2, current_event_id = ? WHERE workspace_id = ?
  `).run(eventId, workspaceId);
  sqlite.exec('COMMIT');

  const source = new Source();
  const repository = new SQLiteSubmissionTriageRepository(sqlite, source);
  sqlite.exec('BEGIN IMMEDIATE');
  repository.initializeSubmissionTriage(createSubmissionTriageInitialization({
    scope: { workspaceId, eventId },
    submission: {
      id: submissionId, formId, formVersionId, source: 'public_form', submittedAt: now
    },
    arrivalId: uuid(0x80), recordedAt: now, closeEvidence: null
  }));
  sqlite.exec('COMMIT');

  let nextId = 0x100;
  const next = () => uuid(nextId++);
  const draftIds: SQLiteSubmissionTriageDraftEffectIds = {
    newChangesetId: next, newRevisionId: next,
    newPreparationHandle: next, newTimelineId: next
  };
  const lifecycleIds: SQLiteSubmissionTriageChangesetEffectIds = {
    newChangesetId: next, newRevisionId: next, newApprovalId: next,
    newCorrectionAttemptId: next, newPreparationHandle: next,
    newTimelineId: next, newFactId: next, newPointerId: next
  };
  const eventRelationships = createSQLiteEventSpineOperatorEventRelationshipSource();
  const draftRegistration = createSQLiteSubmissionTriageDraftEffectDomainRegistration({
    sqlite, workspaceId, policy, repository, eventRelationships, ids: draftIds
  });
  const lifecycleRegistration = createSQLiteSubmissionTriageChangesetEffectDomainRegistration({
    sqlite, workspaceId, policy, repository, eventRelationships, ids: lifecycleIds
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
  let currentTime: Instant = now;
  const authority: Parameters<typeof createSubmissionTriageDraftOperationModule>[0]['currentAuthority'] = {
    resolve(input) {
      if (revoked) return { kind: 'denied', reason: 'revoked' };
      if (input.evidence.kind !== 'operator') return { kind: 'denied', reason: 'lane_mismatch' };
      return {
        kind: 'authorized',
        authority: {
          actor: { kind: 'workspace_user', userId },
          principal: { kind: 'workspace_user', userId, membershipId },
          lane: input.lane, scope: input.scope,
          grants: [{ kind: 'permission', key: 'event.manage' }],
          evidenceIds: ['membership.current'], authorityCitationIds: [],
          evaluatedAt: input.evaluatedAt
        }
      };
    }
  };
  const crypto = (hashProfile: typeof SUBMISSION_TRIAGE_DRAFT_REQUEST_HASH_PROFILE, prefix: string) => ({
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: hashProfile, keyBytes: new Uint8Array(32).fill(prefix.charCodeAt(0))
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw: string) {
        return {
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`${prefix}:${raw}`).digest('hex')
        };
      }
    }
  });
  const draftModule = createSubmissionTriageDraftOperationModule({
    workspaceId, policy: SUBMISSION_TRIAGE_MANAGE_ACCESS_POLICY,
    currentAuthority: authority,
    currentEvent: { resolveCurrentEvent: () => ({ eventId, evidenceIds: ['event.current'] }) },
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    crypto: crypto(SUBMISSION_TRIAGE_DRAFT_REQUEST_HASH_PROFILE, 'draft')
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
  let receipt = 0x800;
  const runtime = createApplicationOperationRuntime({
    source: composeOperationRegistryModules([draftModule, lifecycleModule]),
    read: {
      operationalTrace: { emit() {} }, immutableAudit: { append() {} },
      clock: { now: () => currentTime }, newInvocationId: () => parseInvocationId(next())
    },
    unitOfWork, newReceiptId: () => uuid(receipt++)
  });
  let request = 0x900;
  return {
    sqlite, repository, lifecycle: lifecycleRegistration.lifecycleStore,
    ownerResolution: routed.ownerResolution,
    close: () => sqlite.close(),
    setRevoked(value: boolean) { revoked = value; },
    advance() { currentTime = parseInstant(new Date(Date.parse(currentTime) + 1_000).toISOString()); },
    async effect(operation: { readonly name: string; readonly version: number }, businessInput: unknown, key: string) {
      const composed = await runtime;
      const invocation = await composed.effectBuilder.build({
        operationName: operation.name, operationVersion: operation.version,
        surface: 'operator_http', correlationId: uuid(request++), businessInput,
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
    lifecycleLinks: count(fixture.sqlite, 'submission_triage_changeset_receipt_links'),
    facts: count(fixture.sqlite, 'submission_triage_changeset_domain_facts'),
    pointers: count(fixture.sqlite, 'submission_triage_changeset_outbox_pointers'),
    timeline: count(fixture.sqlite, 'submission_triage_changeset_timeline'),
    commits: count(fixture.sqlite, 'changeset_commit_links'),
    corrections: count(fixture.sqlite, 'changeset_correction_links')
  };
}

async function draftAndPropose(fixture: ReturnType<typeof openFixture>, key: string) {
  const state = fixture.repository.readTriageState({ workspaceId, eventId })!;
  const draft = submissionTriageDraftOperationResultSchema.parse(await fixture.effect(
    SUBMISSION_TRIAGE_DRAFT_OPERATION,
    {
      action: 'set_aside', submissionIds: [submissionId],
      expectedHeads: [{ submissionId, version: state.entries[0]!.head.version }],
      expectedQueryGuard: {
        version: state.queryGuard.version,
        digestSha256: state.queryGuard.digestSha256
      }
    }, `${key}-draft`
  ));
  if (draft.kind !== 'success') throw new TypeError('triage_draft_failed');
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
    throw new TypeError('triage_propose_failed');
  }
  return { draft, selector, proposed, proposedHeadVersion: proposed.data.diff.headVersion };
}

describe('SQLite submission-triage changeset lifecycle', () => {
  test('commits once with causal receipt/audit/fact/outbox/history, then enforces replay conflict and revocation', async () => {
    const fixture = openFixture();
    try {
      const { selector, proposedHeadVersion } = await draftAndPropose(fixture, 'set-aside');
      expect(await fixture.ownerResolution.resolveOwner(fixture.lifecycle.read(selector.changesetId)!))
        .toMatchObject({ id: 'submission_triage' });
      const commitInput = { ...selector, expectedHeadVersion: proposedHeadVersion };
      const committed = changesetLifecycleOperationResultSchema.parse(await fixture.effect(
        COMMIT_CHANGESET_OPERATION, commitInput, 'set-aside-commit'
      ));
      expect(committed).toMatchObject({
        kind: 'success', data: { action: 'commit', committedHeadVersion: 3 }
      });
      if (committed.kind !== 'success') throw new TypeError('triage_commit_failed');
      expect(fixture.repository.readTriageState({ workspaceId, eventId })?.entries[0]?.head)
        .toMatchObject({ version: 2, state: 'set_aside' });
      const receiptId = committed.receipt.id;
      const committedCounts = durableCounts(fixture);
      expect(committedCounts).toMatchObject({
        lifecycleLinks: 2, facts: 1, pointers: 1, timeline: 2, commits: 1
      });
      expect(fixture.sqlite.query<{
        readonly receipt_id: string; readonly fact_kind: string;
        readonly pointer_source: string; readonly timeline_source: string;
        readonly audit_disposition: string;
      }, [string]>(`
        SELECT link.receipt_id, fact.fact_kind,
               pointer.source_kind AS pointer_source,
               timeline.source_kind AS timeline_source,
               audit.disposition AS audit_disposition
          FROM submission_triage_changeset_receipt_links AS link
          JOIN submission_triage_changeset_domain_facts AS fact
            ON fact.receipt_id = link.receipt_id
          JOIN submission_triage_changeset_outbox_pointers AS pointer
            ON pointer.receipt_id = link.receipt_id AND pointer.fact_id = fact.fact_id
          JOIN submission_triage_changeset_timeline AS timeline
            ON timeline.receipt_id = link.receipt_id
          JOIN changeset_commit_links AS committed
            ON committed.changeset_id = link.changeset_id
           AND committed.revision_id = link.revision_id
           AND committed.commit_receipt_id = link.receipt_id
          JOIN foundation_trial_operation_audits AS audit ON audit.receipt_id = link.receipt_id
         WHERE link.receipt_id = ?
      `).get(receiptId)).toEqual({
        receipt_id: receiptId, fact_kind: 'submission_triage_changed',
        pointer_source: 'domain_fact', timeline_source: 'changeset_commit',
        audit_disposition: 'terminal_new'
      });

      expect(await fixture.effect(
        COMMIT_CHANGESET_OPERATION, commitInput, 'set-aside-commit'
      )).toMatchObject({ kind: 'success', receipt: { id: receiptId } });
      expect(durableCounts(fixture)).toEqual({
        ...committedCounts, audits: committedCounts.audits + 1
      });
      const replayCounts = durableCounts(fixture);
      expect(await fixture.effect(
        COMMIT_CHANGESET_OPERATION,
        { ...commitInput, expectedHeadVersion: commitInput.expectedHeadVersion + 1 },
        'set-aside-commit'
      )).toMatchObject({
        kind: 'outcome', outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
      });
      expect(durableCounts(fixture)).toEqual({ ...replayCounts, audits: replayCounts.audits + 1 });
      const conflictCounts = durableCounts(fixture);
      fixture.setRevoked(true);
      fixture.advance();
      expect(await fixture.effect(
        COMMIT_CHANGESET_OPERATION, commitInput, 'set-aside-commit'
      )).toMatchObject({
        kind: 'outcome', outcome: { class: 'access_denied', kind: 'authority.revoked' }
      });
      expect(durableCounts(fixture)).toEqual({
        ...conflictCounts, audits: conflictCounts.audits + 1
      });
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally { fixture.close(); }
  });

  test('drafts an exact compensation while unchanged and rolls all commit evidence back on late failure', async () => {
    const fixture = openFixture();
    try {
      const { selector, proposedHeadVersion } = await draftAndPropose(fixture, 'correctable');
      const committed = changesetLifecycleOperationResultSchema.parse(await fixture.effect(
        COMMIT_CHANGESET_OPERATION,
        { ...selector, expectedHeadVersion: proposedHeadVersion },
        'correctable-commit'
      ));
      if (committed.kind !== 'success') throw new TypeError('triage_commit_failed');
      fixture.advance();
      const correction = changesetLifecycleOperationResultSchema.parse(await fixture.effect(
        DRAFT_CHANGESET_CORRECTION_OPERATION,
        {
          sourceChangesetId: selector.changesetId,
          sourceRevisionId: selector.revisionId,
          sourceRevisionDigest: selector.revisionDigest,
          sourceCommitReceiptId: committed.receipt.id
        },
        'correctable-correction'
      ));
      expect(correction).toMatchObject({
        kind: 'success',
        data: { action: 'correction', resultKind: 'exact', target: { status: 'draft' } }
      });
      if (correction.kind !== 'success' || correction.data.action !== 'correction'
          || !correction.data.target) throw new TypeError('triage_correction_missing');
      const target = {
        changesetId: correction.data.target.changesetId,
        revisionId: correction.data.target.revisionId,
        revisionDigest: correction.data.target.revisionDigest
      };
      const proposedCorrection = changesetLifecycleOperationResultSchema.parse(await fixture.effect(
        PROPOSE_CHANGESET_OPERATION,
        { ...target, expectedHeadVersion: correction.data.target.headVersion },
        'correctable-correction-propose'
      ));
      if (proposedCorrection.kind !== 'success'
          || proposedCorrection.data.action !== 'propose') {
        throw new TypeError('triage_correction_proposal_missing');
      }
      expect(await fixture.effect(
        COMMIT_CHANGESET_OPERATION,
        { ...target, expectedHeadVersion: proposedCorrection.data.diff.headVersion },
        'correctable-correction-commit'
      )).toMatchObject({ kind: 'success', data: { action: 'commit' } });
      expect(fixture.repository.readTriageState({ workspaceId, eventId })?.entries[0]?.head)
        .toMatchObject({ version: 3, state: 'inbox', setAsideAttribution: null });
      expect(durableCounts(fixture).corrections).toBe(1);
    } finally { fixture.close(); }

    const failing = openFixture({ failFact: true });
    try {
      const { selector, proposedHeadVersion } = await draftAndPropose(failing, 'atomic');
      const before = durableCounts(failing);
      const headBefore = failing.repository.readTriageState({ workspaceId, eventId })!.entries[0]!.head;
      await expect(failing.effect(
        COMMIT_CHANGESET_OPERATION,
        { ...selector, expectedHeadVersion: proposedHeadVersion },
        'atomic-commit'
      )).rejects.toThrow('Operation execution failed during receipt_children.');
      expect(durableCounts(failing)).toEqual(before);
      expect(failing.repository.readTriageState({ workspaceId, eventId })!.entries[0]!.head)
        .toEqual(headBefore);
    } finally { failing.close(); }
  });
});
