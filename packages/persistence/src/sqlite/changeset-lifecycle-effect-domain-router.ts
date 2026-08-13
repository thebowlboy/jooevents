import {
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type EffectOperationIdentity,
  type SealedEffectAuthorityRecheckResult,
  type TerminalEffectReceipt
} from '@jooevents/application';
import {
  CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
  type ChangesetLifecycleOwnerResolution,
  type ChangesetLifecycleOwnerResolutionSource,
  type StoredChangesetRecord
} from '@jooevents/changeset-operations';
import type { SubjectRef } from '@jooevents/kernel';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import type { SQLiteOperatorSubjectRelationshipSource } from './operator-authority-repositories';

export interface SQLiteChangesetLifecycleOwnerRegistration {
  /** Stable owner identity emitted by the domain's authenticated resolver. */
  readonly ownerId: string;
  readonly adapter: SQLiteEffectDomainAdapter;
  readonly ownerResolution: ChangesetLifecycleOwnerResolutionSource;
  readonly subjectRelationships: SQLiteOperatorSubjectRelationshipSource;
}

interface BoundOwnerRegistration extends SQLiteChangesetLifecycleOwnerRegistration {
  readonly adapter: SQLiteEffectDomainAdapter;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ownerId(value: unknown): string {
  if (typeof value !== 'string'
      || value.length === 0
      || value.length > 160
      || value.trim() !== value
      || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value)) {
    throw new TypeError('changeset_lifecycle_owner_id_invalid');
  }
  return value;
}

function bindAdapter(adapter: SQLiteEffectDomainAdapter): SQLiteEffectDomainAdapter {
  if (!adapter
      || typeof adapter !== 'object'
      || typeof adapter.openHandlerSnapshot !== 'function'
      || typeof adapter.applyDomainContribution !== 'function') {
    throw new TypeError('changeset_lifecycle_owner_adapter_invalid');
  }
  for (const hook of [
    'afterReceiptParentInserted',
    'afterReceiptChildInserted',
    'afterExecutionClaimReleased',
    'afterUnitOfWorkCommitted',
    'afterUnitOfWorkFinished'
  ] as const) {
    if (adapter[hook] !== undefined && typeof adapter[hook] !== 'function') {
      throw new TypeError(`changeset_lifecycle_owner_adapter_hook_invalid:${hook}`);
    }
  }
  return Object.freeze({
    openHandlerSnapshot: adapter.openHandlerSnapshot.bind(adapter),
    applyDomainContribution: adapter.applyDomainContribution.bind(adapter),
    ...(adapter.afterReceiptParentInserted
      ? { afterReceiptParentInserted: adapter.afterReceiptParentInserted.bind(adapter) }
      : {}),
    ...(adapter.afterReceiptChildInserted
      ? { afterReceiptChildInserted: adapter.afterReceiptChildInserted.bind(adapter) }
      : {}),
    ...(adapter.afterExecutionClaimReleased
      ? { afterExecutionClaimReleased: adapter.afterExecutionClaimReleased.bind(adapter) }
      : {}),
    ...(adapter.afterUnitOfWorkCommitted
      ? { afterUnitOfWorkCommitted: adapter.afterUnitOfWorkCommitted.bind(adapter) }
      : {}),
    ...(adapter.afterUnitOfWorkFinished
      ? { afterUnitOfWorkFinished: adapter.afterUnitOfWorkFinished.bind(adapter) }
      : {})
  });
}

function bindRegistration(
  registration: SQLiteChangesetLifecycleOwnerRegistration
): BoundOwnerRegistration {
  if (!registration || typeof registration !== 'object') {
    throw new TypeError('changeset_lifecycle_owner_registration_invalid');
  }
  if (typeof registration.ownerResolution?.resolveOwner !== 'function') {
    throw new TypeError('changeset_lifecycle_owner_resolution_invalid');
  }
  if (typeof registration.subjectRelationships?.validateSubject !== 'function') {
    throw new TypeError('changeset_lifecycle_owner_subject_relationships_invalid');
  }
  return Object.freeze({
    ownerId: ownerId(registration.ownerId),
    adapter: bindAdapter(registration.adapter),
    ownerResolution: Object.freeze({
      resolveOwner: registration.ownerResolution.resolveOwner.bind(registration.ownerResolution)
    }),
    subjectRelationships: Object.freeze({
      validateSubject: registration.subjectRelationships.validateSubject.bind(
        registration.subjectRelationships
      )
    })
  });
}

type ChangesetOwnerSubject = Extract<
  SubjectRef,
  { readonly kind: 'domain' }
>;

function isChangesetOwnerSubject(subject: SubjectRef): subject is ChangesetOwnerSubject {
  return subject.kind === 'domain'
    && subject.domain === 'changeset'
    && subject.entity === 'owner';
}

function exactOwnerSubject(context: EffectInvocationContext): ChangesetOwnerSubject {
  const candidates = context.scope.subjects.filter(isChangesetOwnerSubject);
  const candidate = candidates[0];
  if (candidates.length !== 1 || candidate === undefined || candidate.version !== undefined) {
    throw new TypeError('changeset_lifecycle_owner_subject_not_exact');
  }
  return candidate;
}

/**
 * Dispatches the shared changeset lifecycle capability by the exact owner subject
 * that the registered changeset scope resolver authenticated. Domain adapters still
 * recheck their own authority, scope, definition ownership, and relationships.
 */
export class SQLiteChangesetLifecycleEffectDomainRouter
implements SQLiteEffectDomainAdapter, ChangesetLifecycleOwnerResolutionSource,
SQLiteOperatorSubjectRelationshipSource {
  readonly #owners: ReadonlyMap<string, BoundOwnerRegistration>;
  #selected: BoundOwnerRegistration | undefined;

  constructor(registrations: readonly SQLiteChangesetLifecycleOwnerRegistration[]) {
    if (!Array.isArray(registrations) || registrations.length === 0) {
      throw new TypeError('changeset_lifecycle_owner_registrations_invalid');
    }
    const owners = new Map<string, BoundOwnerRegistration>();
    for (const raw of registrations) {
      const registration = bindRegistration(raw);
      if (owners.has(registration.ownerId)) {
        throw new TypeError(`changeset_lifecycle_owner_duplicate:${registration.ownerId}`);
      }
      owners.set(registration.ownerId, registration);
    }
    this.#owners = new Map(
      [...owners.entries()].sort(([left], [right]) => compareCodeUnits(left, right))
    );
  }

  async resolveOwner(
    record: StoredChangesetRecord
  ): Promise<ChangesetLifecycleOwnerResolution | undefined> {
    const matches: ChangesetLifecycleOwnerResolution[] = [];
    for (const registration of this.#owners.values()) {
      const resolution = await registration.ownerResolution.resolveOwner(record);
      if (!resolution) continue;
      if (resolution.id !== registration.ownerId) {
        throw new TypeError('changeset_lifecycle_owner_resolution_mismatch');
      }
      if (resolution.diffReadPermissionIds !== undefined) {
        const permissions = [...resolution.diffReadPermissionIds];
        if (permissions.length === 0
            || new Set(permissions).size !== permissions.length
            || permissions.some((permission, index) =>
              index > 0 && compareCodeUnits(permissions[index - 1]!, permission) >= 0
            )) {
          throw new TypeError('changeset_lifecycle_owner_diff_permissions_invalid');
        }
      }
      matches.push(resolution);
    }
    if (matches.length > 1) throw new TypeError('changeset_lifecycle_owner_resolution_ambiguous');
    return matches[0];
  }

  validateSubject(
    input: Parameters<SQLiteOperatorSubjectRelationshipSource['validateSubject']>[0]
  ) {
    const subject = input.subject;
    if (subject.kind !== 'domain'
        || subject.domain !== 'changeset'
        || subject.entity !== 'owner'
        || subject.version !== undefined) {
      return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
    }
    const registration = this.#owners.get(subject.id);
    return registration
      ? registration.subjectRelationships.validateSubject(input)
      : Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (capability.key !== CHANGESET_LIFECYCLE_HANDLER_CAPABILITY.key
        || capability.version !== CHANGESET_LIFECYCLE_HANDLER_CAPABILITY.version) {
      throw new TypeError('changeset_lifecycle_router_capability_mismatch');
    }
    const subject = exactOwnerSubject(context);
    const selected = this.#owners.get(subject.id);
    if (!selected) throw new TypeError('changeset_lifecycle_owner_unregistered');
    this.#selected = selected;
    return selected.adapter.openHandlerSnapshot(capability, context, authorityRecheck);
  }

  applyDomainContribution(contribution: unknown): void | Promise<void> {
    return this.selected().adapter.applyDomainContribution(contribution);
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void | Promise<void> {
    return this.selected().adapter.afterReceiptParentInserted?.(receipt);
  }

  afterReceiptChildInserted(receiptId: string, contribution: unknown): void | Promise<void> {
    return this.selected().adapter.afterReceiptChildInserted?.(receiptId, contribution);
  }

  afterExecutionClaimReleased(identity: EffectOperationIdentity): void | Promise<void> {
    return this.selected().adapter.afterExecutionClaimReleased?.(identity);
  }

  async afterUnitOfWorkCommitted(): Promise<void> {
    await this.selected().adapter.afterUnitOfWorkCommitted?.();
  }

  async afterUnitOfWorkFinished(outcome: { readonly committed: boolean }): Promise<void> {
    const selected = this.selected();
    try {
      await selected.adapter.afterUnitOfWorkFinished?.(outcome);
    } finally {
      this.#selected = undefined;
    }
  }

  private selected(): BoundOwnerRegistration {
    if (!this.#selected) throw new TypeError('changeset_lifecycle_owner_not_selected');
    return this.#selected;
  }
}

export function createSQLiteChangesetLifecycleEffectDomainRouter(
  registrations: readonly SQLiteChangesetLifecycleOwnerRegistration[]
) {
  const router = new SQLiteChangesetLifecycleEffectDomainRouter(registrations);
  return Object.freeze({
    capability: CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
    adapter: router as SQLiteEffectDomainAdapter,
    ownerResolution: router as ChangesetLifecycleOwnerResolutionSource,
    subjectRelationships: router as SQLiteOperatorSubjectRelationshipSource
  });
}
