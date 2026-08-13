import { describe, expect, test } from 'bun:test';
import type {
  EffectInvocationContext,
  SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
  type ChangesetLifecycleOwnerResolutionSource,
  type StoredChangesetRecord
} from '@jooevents/changeset-operations';
import {
  parseAggregateVersion,
  parseEventId,
  parseWorkspaceId,
  type SubjectRef
} from '@jooevents/kernel';
import {
  SQLiteChangesetLifecycleEffectDomainRouter,
  createSQLiteChangesetLifecycleEffectDomainRouter,
  type SQLiteChangesetLifecycleOwnerRegistration
} from './changeset-lifecycle-effect-domain-router';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import type { SQLiteOperatorSubjectRelationshipSource } from './operator-authority-repositories';

const authorityRecheck = Object.freeze({}) as SealedEffectAuthorityRecheckResult;
const record = Object.freeze({}) as StoredChangesetRecord;

function context(subjects: readonly SubjectRef[]): EffectInvocationContext {
  return Object.freeze({
    scope: Object.freeze({ subjects: Object.freeze([...subjects]) })
  }) as unknown as EffectInvocationContext;
}

function ownerSubject(id: string, version?: number): SubjectRef {
  return Object.freeze({
    kind: 'domain' as const,
    domain: 'changeset',
    entity: 'owner',
    id,
    ...(version === undefined ? {} : { version: parseAggregateVersion(version) })
  });
}

function registration(input: {
  readonly ownerId: 'program_vocabulary' | 'schedule_placement';
  readonly matches?: boolean;
  readonly returnedOwnerId?: string;
  readonly trace: string[];
}): SQLiteChangesetLifecycleOwnerRegistration {
  const adapter: SQLiteEffectDomainAdapter = {
    openHandlerSnapshot() {
      input.trace.push(`${input.ownerId}:open`);
      return Object.freeze({ owner: input.ownerId });
    },
    applyDomainContribution() {
      input.trace.push(`${input.ownerId}:apply`);
    },
    afterReceiptParentInserted() {
      input.trace.push(`${input.ownerId}:parent`);
    },
    afterReceiptChildInserted() {
      input.trace.push(`${input.ownerId}:child`);
    },
    afterExecutionClaimReleased() {
      input.trace.push(`${input.ownerId}:release`);
    },
    afterUnitOfWorkCommitted() {
      input.trace.push(`${input.ownerId}:commit`);
    },
    afterUnitOfWorkFinished({ committed }) {
      input.trace.push(`${input.ownerId}:finish:${committed}`);
    }
  };
  const ownerResolution: ChangesetLifecycleOwnerResolutionSource = Object.freeze({
    resolveOwner(received: StoredChangesetRecord) {
      input.trace.push(`${input.ownerId}:resolve`);
      if (received !== record || input.matches !== true) return undefined;
      return Object.freeze({
        id: input.returnedOwnerId ?? input.ownerId,
        evidenceIds: Object.freeze([`${input.ownerId}:evidence`])
      });
    }
  });
  const subjectRelationships: SQLiteOperatorSubjectRelationshipSource = Object.freeze({
    validateSubject({ subject }:
      Parameters<SQLiteOperatorSubjectRelationshipSource['validateSubject']>[0]) {
      input.trace.push(`${input.ownerId}:subject:${subject.id}`);
      return subject.kind === 'domain' && subject.id === input.ownerId
        ? Object.freeze({ kind: 'valid' as const, evidenceIds: Object.freeze(['valid']) })
        : Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
    }
  });
  return Object.freeze({ ownerId: input.ownerId, adapter, ownerResolution, subjectRelationships });
}

function subjectInput(subject: Extract<SubjectRef, { kind: 'domain' }>) {
  return {
    sqlite: Object.freeze({}),
    workspaceId: '550e8400-e29b-41d4-a716-446655440000',
    eventId: '019c1df7-86b5-769b-bba4-5f7097bfa101',
    userId: '019c1df7-86b5-769b-bba4-5f7097bfa201',
    subject,
    evaluatedAt: '2026-08-12T10:00:00.000Z'
  } as unknown as Parameters<SQLiteOperatorSubjectRelationshipSource['validateSubject']>[0];
}

describe('SQLite changeset lifecycle owner router', () => {
  test('dispatches the shared lifecycle capability and every hook to the exact owner', async () => {
    const trace: string[] = [];
    const router = new SQLiteChangesetLifecycleEffectDomainRouter([
      registration({ ownerId: 'program_vocabulary', trace }),
      registration({ ownerId: 'schedule_placement', trace })
    ]);
    const scheduleContext = context([
      { kind: 'workspace', id: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000') },
      { kind: 'event', id: parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101') },
      ownerSubject('schedule_placement')
    ]);

    expect(router.openHandlerSnapshot(
      CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
      scheduleContext,
      authorityRecheck
    )).toEqual({ owner: 'schedule_placement' });
    await router.applyDomainContribution({});
    await router.afterReceiptParentInserted?.({} as never);
    await router.afterReceiptChildInserted?.('receipt', {});
    await router.afterExecutionClaimReleased?.({} as never);
    await router.afterUnitOfWorkCommitted?.();
    await router.afterUnitOfWorkFinished?.({ committed: true });

    expect(trace).toEqual([
      'schedule_placement:open',
      'schedule_placement:apply',
      'schedule_placement:parent',
      'schedule_placement:child',
      'schedule_placement:release',
      'schedule_placement:commit',
      'schedule_placement:finish:true'
    ]);
    expect(() => router.applyDomainContribution({})).toThrow(
      'changeset_lifecycle_owner_not_selected'
    );
  });

  test('resolves exactly one registered Program or Schedule owner and fails ambiguity closed', async () => {
    const trace: string[] = [];
    const program = registration({ ownerId: 'program_vocabulary', matches: true, trace });
    const schedule = registration({ ownerId: 'schedule_placement', trace });
    const router = new SQLiteChangesetLifecycleEffectDomainRouter([program, schedule]);
    expect(await router.resolveOwner(record)).toEqual({
      id: 'program_vocabulary', evidenceIds: ['program_vocabulary:evidence']
    });

    const ambiguous = new SQLiteChangesetLifecycleEffectDomainRouter([
      program,
      registration({ ownerId: 'schedule_placement', matches: true, trace })
    ]);
    await expect(ambiguous.resolveOwner(record)).rejects.toThrow(
      'changeset_lifecycle_owner_resolution_ambiguous'
    );

    const forged = new SQLiteChangesetLifecycleEffectDomainRouter([
      registration({
        ownerId: 'program_vocabulary', matches: true,
        returnedOwnerId: 'schedule_placement', trace
      }),
      schedule
    ]);
    await expect(forged.resolveOwner(record)).rejects.toThrow(
      'changeset_lifecycle_owner_resolution_mismatch'
    );
  });

  test('a rolled-back selection cannot leak hooks into a later different owner', async () => {
    const trace: string[] = [];
    const router = new SQLiteChangesetLifecycleEffectDomainRouter([
      registration({ ownerId: 'program_vocabulary', trace }),
      registration({ ownerId: 'schedule_placement', trace })
    ]);
    router.openHandlerSnapshot(
      CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
      context([ownerSubject('program_vocabulary')]),
      authorityRecheck
    );
    await router.afterUnitOfWorkFinished?.({ committed: false });
    router.openHandlerSnapshot(
      CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
      context([ownerSubject('schedule_placement')]),
      authorityRecheck
    );
    await router.applyDomainContribution({});
    await router.afterReceiptParentInserted?.({} as never);
    await router.afterExecutionClaimReleased?.({} as never);
    await router.afterUnitOfWorkCommitted?.();
    await router.afterUnitOfWorkFinished?.({ committed: true });
    expect(trace).toEqual([
      'program_vocabulary:open',
      'program_vocabulary:finish:false',
      'schedule_placement:open',
      'schedule_placement:apply',
      'schedule_placement:parent',
      'schedule_placement:release',
      'schedule_placement:commit',
      'schedule_placement:finish:true'
    ]);
  });

  test('rejects duplicate, unknown, multiple, versioned, and wrong-capability routing', () => {
    const trace: string[] = [];
    const program = registration({ ownerId: 'program_vocabulary', trace });
    expect(() => new SQLiteChangesetLifecycleEffectDomainRouter([program, program])).toThrow(
      'changeset_lifecycle_owner_duplicate:program_vocabulary'
    );
    const router = new SQLiteChangesetLifecycleEffectDomainRouter([
      program,
      registration({ ownerId: 'schedule_placement', trace })
    ]);
    expect(() => router.openHandlerSnapshot(
      CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
      context([ownerSubject('unknown_owner')]),
      authorityRecheck
    )).toThrow('changeset_lifecycle_owner_unregistered');
    expect(() => router.openHandlerSnapshot(
      CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
      context([ownerSubject('program_vocabulary'), ownerSubject('schedule_placement')]),
      authorityRecheck
    )).toThrow('changeset_lifecycle_owner_subject_not_exact');
    expect(() => router.openHandlerSnapshot(
      CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
      context([ownerSubject('schedule_placement', 1)]),
      authorityRecheck
    )).toThrow('changeset_lifecycle_owner_subject_not_exact');
    expect(() => router.openHandlerSnapshot(
      { key: 'capability.not-changeset', version: 1 },
      context([ownerSubject('schedule_placement')]),
      authorityRecheck
    )).toThrow('changeset_lifecycle_router_capability_mismatch');
    expect(trace).toEqual([]);
  });

  test('routes only exact registered relationship subjects and exposes one registry binding', () => {
    const trace: string[] = [];
    const routed = createSQLiteChangesetLifecycleEffectDomainRouter([
      registration({ ownerId: 'program_vocabulary', trace }),
      registration({ ownerId: 'schedule_placement', trace })
    ]);
    expect(routed.capability).toEqual(CHANGESET_LIFECYCLE_HANDLER_CAPABILITY);
    expect(routed.subjectRelationships.validateSubject(
      subjectInput(ownerSubject('schedule_placement') as Extract<SubjectRef, { kind: 'domain' }>)
    )).toEqual({ kind: 'valid', evidenceIds: ['valid'] });
    expect(routed.subjectRelationships.validateSubject(
      subjectInput(ownerSubject('unregistered') as Extract<SubjectRef, { kind: 'domain' }>)
    )).toEqual({ kind: 'denied', reason: 'cross_scope' });
    expect(routed.subjectRelationships.validateSubject(
      subjectInput(ownerSubject('schedule_placement', 1) as Extract<SubjectRef, { kind: 'domain' }>)
    )).toEqual({ kind: 'denied', reason: 'cross_scope' });
    expect(trace).toEqual(['schedule_placement:subject:schedule_placement']);
  });
});
