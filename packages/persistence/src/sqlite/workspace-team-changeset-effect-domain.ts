import type { Database } from 'bun:sqlite';
import {
  effectOperationIdentitiesEqual,
  effectOperationIdentityMatchesContext,
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type EffectOperationIdentity,
  type SealedEffectAuthorityRecheckResult,
  type TerminalEffectReceipt
} from '@jooevents/application';
import type {
  SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  applyPreparedChangesetSynchronous,
  canonicalJsonSha256,
  prepareChangesetCommitSynchronous,
  type ChangesetCommitTransaction,
  type ChangesetPlanningSnapshot,
  type ChangesetReadPortKey,
  type ChangesetTransactionPortKey,
  type ChangesetValidationPortKey,
  type FrozenChangesetOperation
} from '@jooevents/changesets';
import {
  CHANGESET_LIFECYCLE_ACCESS_POLICY,
  CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
  COMMIT_CHANGESET_OPERATION,
  approveChangesetRevisionInputSchema,
  approveStoredChangeset,
  changesetLifecycleActionForOperation,
  changesetLifecycleContributionSchema,
  changesetLifecycleDomainContributionSchema,
  changesetLifecycleOperationResultSchema,
  changesetLifecycleRefusalOutcome,
  changesetOutboxEvidenceChildSchema,
  commitChangesetInputSchema,
  commitStoredChangeset,
  draftChangesetCorrectionInputSchema,
  draftChangesetCorrectionSynchronous,
  parseChangesetCommitTerminalReceipt,
  projectStoredChangesetDiff,
  proposeChangesetInputSchema,
  proposeStoredChangeset,
  rebuildChangesetInputSchema,
  rebuildStoredChangesetSynchronous,
  sealChangesetLifecyclePreparation,
  validateStoredChangesetCommit,
  workspaceChangesetDomainFactEvidenceChildSchema,
  workspaceChangesetTimelineEvidenceChildSchema,
  type ChangesetLifecycleAction,
  type ChangesetLifecycleContribution,
  type ChangesetLifecycleIds,
  type ChangesetLifecycleOwnerResolution,
  type ChangesetLifecycleOwnerResolutionSource,
  type ChangesetLifecyclePreparation,
  type ChangesetLifecycleRefusal,
  type ExactStoredChangesetCommit,
  type StoredChangesetRecord
} from '@jooevents/changeset-operations';
import {
  WORKSPACE_TEAM_PERMISSIONS,
  workspaceTeamRequiredPermission,
  type PermissionId
} from '@jooevents/identity-access';
import {
  WORKSPACE_TEAM_CHANGESET_KIND,
  WORKSPACE_TEAM_CHANGESET_VERSION,
  assertWorkspaceTeamChangesetBundle,
  captureWorkspaceTeamApprovalPolicy,
  createWorkspaceTeamChangesetBundle,
  workspaceTeamReadPort,
  workspaceTeamTransactionPort,
  workspaceTeamValidationPort,
  type WorkspaceTeamChangesetBundle,
  type WorkspaceTeamChangesetPlan,
  type WorkspaceTeamChangesetPolicy
} from './workspace-team-changesets';
import {
  canonicalJsonText,
  isApplicationId,
  parseInstant,
  parseOperationReceiptId,
  parseUserId,
  parseWorkspaceId,
  type Instant,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import {
  SQLiteChangesetLifecycleStore,
  type SQLiteChangesetTerminalReceiptSource
} from './changeset-lifecycle';
import type { SQLiteOperatorSubjectRelationshipSource } from './operator-authority-repositories';
import { SQLiteWorkspaceTeamRepository } from './workspace-team';

export const WORKSPACE_TEAM_CHANGESET_EFFECT_SQL = `
CREATE TABLE workspace_team_changeset_effect_receipt_links (
  receipt_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK(action IN ('propose', 'approve', 'rebuild', 'correction', 'commit')),
  operation_name TEXT NOT NULL,
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  workspace_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision_digest_sha256 TEXT NOT NULL CHECK(
    length(revision_digest_sha256) = 64
    AND revision_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  record_digest_sha256 TEXT NOT NULL CHECK(
    length(record_digest_sha256) = 64
    AND record_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  CHECK(
    (action = 'propose' AND operation_name = 'changeset.propose')
    OR (action = 'approve' AND operation_name = 'changeset.approve')
    OR (action = 'rebuild' AND operation_name = 'changeset.rebuild')
    OR (action = 'correction' AND operation_name = 'changeset.correction.draft')
    OR (action = 'commit' AND operation_name = 'changeset.commit')
  ),
  FOREIGN KEY(receipt_id)
    REFERENCES foundation_trial_operation_receipts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(changeset_id, revision_id, revision_digest_sha256)
    REFERENCES changeset_revisions(changeset_id, revision_id, revision_digest_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE(receipt_id, workspace_id, changeset_id, revision_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_team_changeset_domain_facts (
  fact_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  fact_kind TEXT NOT NULL CHECK(fact_kind = 'workspace_team_changed'),
  fact_version INTEGER NOT NULL CHECK(fact_version = 1),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  FOREIGN KEY(receipt_id, workspace_id, changeset_id, revision_id)
    REFERENCES workspace_team_changeset_effect_receipt_links(
      receipt_id, workspace_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE(fact_id, receipt_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_team_changeset_outbox_pointers (
  pointer_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  fact_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL CHECK(source_kind = 'domain_fact'),
  FOREIGN KEY(fact_id, receipt_id)
    REFERENCES workspace_team_changeset_domain_facts(fact_id, receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_team_changeset_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL CHECK(source_kind IN (
    'changeset_proposal', 'changeset_approval', 'changeset_rebuild',
    'changeset_correction', 'changeset_commit'
  )),
  workspace_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  FOREIGN KEY(receipt_id, workspace_id, changeset_id, revision_id)
    REFERENCES workspace_team_changeset_effect_receipt_links(
      receipt_id, workspace_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER workspace_team_changeset_effect_receipt_links_no_update
BEFORE UPDATE ON workspace_team_changeset_effect_receipt_links
BEGIN SELECT RAISE(ABORT, 'workspace team changeset receipt links are immutable'); END;
CREATE TRIGGER workspace_team_changeset_effect_receipt_links_no_delete
BEFORE DELETE ON workspace_team_changeset_effect_receipt_links
BEGIN SELECT RAISE(ABORT, 'workspace team changeset receipt links are immutable'); END;
CREATE TRIGGER workspace_team_changeset_domain_facts_no_update
BEFORE UPDATE ON workspace_team_changeset_domain_facts
BEGIN SELECT RAISE(ABORT, 'workspace team changeset facts are immutable'); END;
CREATE TRIGGER workspace_team_changeset_domain_facts_no_delete
BEFORE DELETE ON workspace_team_changeset_domain_facts
BEGIN SELECT RAISE(ABORT, 'workspace team changeset facts are immutable'); END;
CREATE TRIGGER workspace_team_changeset_outbox_pointers_no_update
BEFORE UPDATE ON workspace_team_changeset_outbox_pointers
BEGIN SELECT RAISE(ABORT, 'workspace team changeset pointers are immutable'); END;
CREATE TRIGGER workspace_team_changeset_outbox_pointers_no_delete
BEFORE DELETE ON workspace_team_changeset_outbox_pointers
BEGIN SELECT RAISE(ABORT, 'workspace team changeset pointers are immutable'); END;
CREATE TRIGGER workspace_team_changeset_timeline_no_update
BEFORE UPDATE ON workspace_team_changeset_timeline
BEGIN SELECT RAISE(ABORT, 'workspace team changeset timeline is immutable'); END;
CREATE TRIGGER workspace_team_changeset_timeline_no_delete
BEFORE DELETE ON workspace_team_changeset_timeline
BEGIN SELECT RAISE(ABORT, 'workspace team changeset timeline is immutable'); END;
`;

export function installWorkspaceTeamChangesetEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('workspace_team_changeset_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(WORKSPACE_TEAM_CHANGESET_EFFECT_SQL)).immediate();
}

interface FoundationReceiptRow {
  readonly id: string;
  readonly scope_partition_key: string;
  readonly authority_principal_key: string;
  readonly operation_name: string;
  readonly operation_version: number;
  readonly surface: EffectOperationIdentity['surface'];
  readonly idempotency_verifier_profile_key: string;
  readonly idempotency_verifier_profile_version: number;
  readonly idempotency_key_verifier: string;
  readonly request_hash: string;
  readonly result_json: string;
}

function terminalReceiptSource(sqlite: Database): SQLiteChangesetTerminalReceiptSource {
  return Object.freeze({
    commitOperations: Object.freeze([COMMIT_CHANGESET_OPERATION]),
    readTerminalReceipt(receiptId: string) {
      const row = sqlite.query<FoundationReceiptRow, [string]>(`
        SELECT id, scope_partition_key, authority_principal_key, operation_name,
               operation_version, surface, idempotency_verifier_profile_key,
               idempotency_verifier_profile_version, idempotency_key_verifier,
               request_hash, result_json
          FROM foundation_trial_operation_receipts
         WHERE id = ?
      `).get(parseOperationReceiptId(receiptId));
      if (!row) return undefined;
      return Object.freeze({
        ref: Object.freeze({
          id: row.id,
          operationName: row.operation_name,
          operationVersion: row.operation_version
        }),
        identity: Object.freeze({
          scopePartitionKey: row.scope_partition_key,
          authorityPrincipalKey: row.authority_principal_key,
          operationName: row.operation_name,
          operationVersion: row.operation_version,
          surface: row.surface,
          idempotencyVerifierProfile: Object.freeze({
            key: row.idempotency_verifier_profile_key,
            version: row.idempotency_verifier_profile_version
          }),
          idempotencyKeyVerifier: row.idempotency_key_verifier
        }),
        requestHash: row.request_hash,
        result: JSON.parse(row.result_json) as never
      });
    }
  });
}

export function createSQLiteWorkspaceTeamChangesetLifecycleStore(
  sqlite: Database
): SQLiteChangesetLifecycleStore {
  return new SQLiteChangesetLifecycleStore(sqlite, terminalReceiptSource(sqlite));
}

export interface SQLiteWorkspaceTeamChangesetEffectIds extends ChangesetLifecycleIds {
  newPreparationHandle(): string;
  newTimelineId(): string;
  newFactId(): string;
  newPointerId(): string;
}

export interface WorkspaceTeamApproverAuthoritySource {
  isCurrentlyAuthorized(input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly principalKey: string;
    readonly permissionId: string;
    readonly evaluatedAt: Instant;
  }): boolean;
}

type LifecycleSuccess = Extract<
  ChangesetLifecycleContribution,
  { readonly result: { readonly kind: 'success' } }
>;

interface PreparedLifecycle {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly action: ChangesetLifecycleAction;
  readonly workspaceId: WorkspaceId;
  readonly evaluatedAt: Instant;
  readonly record: StoredChangesetRecord;
  readonly contribution: LifecycleSuccess;
  readonly exactCommit?: ExactStoredChangesetCommit;
  phase: 'prepared' | 'applied' | 'parent_linked' | 'evidence_complete' | 'claim_released';
  receiptId?: string;
  nextChild: number;
}

function applicationId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isApplicationId(value)) {
    throw new TypeError(`workspace_team_changeset_${label}_invalid`);
  }
  return value;
}

function sameReference(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function timelineSource(action: ChangesetLifecycleAction) {
  return ({
    propose: 'changeset_proposal',
    approve: 'changeset_approval',
    rebuild: 'changeset_rebuild',
    correction: 'changeset_correction',
    commit: 'changeset_commit'
  } as const)[action];
}

function exactSubjects(context: EffectInvocationContext): boolean {
  return context.scope.eventId === undefined
    && context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId
    )
    && context.scope.subjects.some((subject) =>
      subject.kind === 'domain'
      && subject.domain === 'changeset'
      && subject.entity === 'owner'
      && subject.id === 'workspace_team'
      && subject.version === undefined
    );
}

function operationPlan(input: {
  readonly bundle: WorkspaceTeamChangesetBundle;
  readonly operation: FrozenChangesetOperation;
}): WorkspaceTeamChangesetPlan | undefined {
  if (input.operation.kind !== WORKSPACE_TEAM_CHANGESET_KIND
      || input.operation.version !== WORKSPACE_TEAM_CHANGESET_VERSION) return undefined;
  const definition = input.bundle.registry.get(input.operation.kind, input.operation.version);
  if (!definition
      || !sameReference(definition.schemas.plan, input.operation.planSchema)
      || !sameReference(definition.schemas.diff, input.operation.diffSchema)
      || !sameReference(definition.schemas.result, input.operation.resultSchema)) return undefined;
  const schema = input.bundle.registry.getSchema(input.operation.planSchema);
  const plan = schema?.schema.parse(input.operation.plan) as WorkspaceTeamChangesetPlan | undefined;
  if (!plan || canonicalJsonSha256(plan.policy) !== canonicalJsonSha256(input.bundle.policy)) {
    return undefined;
  }
  return plan;
}

function ownsWorkspaceTeamChangeset(input: {
  readonly bundle: WorkspaceTeamChangesetBundle;
  readonly record: StoredChangesetRecord;
}): boolean {
  if (input.record.head.eventId !== undefined) return false;
  for (const revision of input.record.revisions) {
    if (revision.revision.operations.length === 0) return false;
    for (const operation of revision.revision.operations) {
      const plan = operationPlan({ bundle: input.bundle, operation });
      if (!plan || plan.mutation.workspaceId !== input.record.head.workspaceId) return false;
    }
  }
  return true;
}

function requiredPermissions(input: {
  readonly bundle: WorkspaceTeamChangesetBundle;
  readonly record: StoredChangesetRecord;
}): readonly [PermissionId, ...PermissionId[]] {
  const revision = input.record.revisions.at(-1);
  if (!revision) throw new TypeError('workspace_team_changeset_revision_missing');
  const permissions = new Set<PermissionId>();
  for (const operation of revision.revision.operations) {
    const plan = operationPlan({ bundle: input.bundle, operation });
    if (!plan) throw new TypeError('workspace_team_changeset_owner_mismatch');
    permissions.add(workspaceTeamRequiredPermission(plan.mutation.action));
  }
  if (permissions.size === 0) throw new TypeError('workspace_team_changeset_permission_missing');
  return Object.freeze([...permissions].sort()) as readonly [PermissionId, ...PermissionId[]];
}

function hasPermissions(
  permissions: readonly string[],
  grants: ReadonlySet<string>
): boolean {
  return permissions.every((permission) => grants.has(permission));
}

function refusalContribution(
  refusal: ChangesetLifecycleRefusal | { readonly kind: 'domain_changed' }
) {
  return changesetLifecycleContributionSchema.parse({
    result: { kind: 'outcome', outcome: changesetLifecycleRefusalOutcome(refusal) },
    domain: null,
    receiptChildren: []
  });
}

export class SQLiteWorkspaceTeamChangesetEffectDomainAdapter
implements SQLiteEffectDomainAdapter, ChangesetLifecycleOwnerResolutionSource {
  readonly lifecycleStore: SQLiteChangesetLifecycleStore;
  readonly subjectRelationships: SQLiteOperatorSubjectRelationshipSource;
  readonly #bundle: WorkspaceTeamChangesetBundle;
  readonly #ids: SQLiteWorkspaceTeamChangesetEffectIds;
  readonly #prepared = new Map<string, PreparedLifecycle>();
  readonly #issuedIds = new Set<string>();
  #active: PreparedLifecycle | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly policy: WorkspaceTeamChangesetPolicy;
    readonly classifiedStore: SynchronousClassifiedPayloadStore;
    readonly ids: SQLiteWorkspaceTeamChangesetEffectIds;
    readonly approverAuthority?: WorkspaceTeamApproverAuthoritySource;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    this.#bundle = createWorkspaceTeamChangesetBundle({ policy: input.policy });
    assertWorkspaceTeamChangesetBundle(this.#bundle);
    this.lifecycleStore = createSQLiteWorkspaceTeamChangesetLifecycleStore(input.sqlite);
    for (const method of [
      'newChangesetId', 'newRevisionId', 'newApprovalId', 'newCorrectionAttemptId',
      'newPreparationHandle', 'newTimelineId', 'newFactId', 'newPointerId'
    ] as const) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('workspace_team_changeset_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze(Object.fromEntries(
      (['newChangesetId', 'newRevisionId', 'newApprovalId', 'newCorrectionAttemptId',
        'newPreparationHandle', 'newTimelineId', 'newFactId', 'newPointerId'] as const)
        .map((method) => [method, input.ids[method].bind(input.ids)])
    ) as unknown as SQLiteWorkspaceTeamChangesetEffectIds);
    this.subjectRelationships = Object.freeze({
      validateSubject: ({ sqlite, workspaceId, eventId, subject }:
        Parameters<SQLiteOperatorSubjectRelationshipSource['validateSubject']>[0]) => {
        if (sqlite !== this.input.sqlite
            || workspaceId !== this.input.workspaceId
            || eventId !== undefined
            || subject.kind !== 'domain'
            || subject.domain !== 'changeset'
            || subject.entity !== 'owner'
            || subject.id !== 'workspace_team'
            || subject.version !== undefined) {
          return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
        }
        const rows = sqlite.query<{ workspace_id: string }, [string]>(`
          SELECT workspace_id FROM workspace_team_heads WHERE workspace_id = ? LIMIT 2
        `).all(workspaceId);
        return rows.length === 1 && rows[0]?.workspace_id === workspaceId
          ? Object.freeze({
              kind: 'valid' as const,
              evidenceIds: Object.freeze([
                `changeset-owner:workspace_team:${workspaceId}:${this.#bundle.policy.definitionDigestSha256}`
              ])
            })
          : Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
      }
    });
  }

  resolveOwner(record: StoredChangesetRecord): ChangesetLifecycleOwnerResolution | undefined {
    if (!ownsWorkspaceTeamChangeset({ bundle: this.#bundle, record })) return undefined;
    return Object.freeze({
      id: 'workspace_team',
      diffReadPermissionIds: requiredPermissions({ bundle: this.#bundle, record }),
      evidenceIds: Object.freeze([
        `workspace-team-policy:${this.#bundle.policy.definitionDigestSha256}`
      ])
    });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('workspace_team_changeset_transaction_required');
    }
    if (!sameReference(capability, CHANGESET_LIFECYCLE_HANDLER_CAPABILITY)) {
      throw new TypeError('workspace_team_changeset_capability_mismatch');
    }
    const action = changesetLifecycleActionForOperation(
      context.operation.name, context.operation.version
    );
    const expectedEffect = action === 'propose' || action === 'rebuild' || action === 'correction'
      ? 'draft'
      : 'commit';
    if (action === undefined
        || context.operation.effect !== expectedEffect
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || context.scope.eventId !== undefined
        || !exactSubjects(context)) {
      throw new TypeError('workspace_team_changeset_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    const grants = new Set(authority.grants.flatMap((grant) =>
      grant.kind === 'permission' ? [grant.key] : []
    ));
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || !sameReference(authority.lane.policy, CHANGESET_LIFECYCLE_ACCESS_POLICY)
        || ![WORKSPACE_TEAM_PERMISSIONS.invite, WORKSPACE_TEAM_PERMISSIONS.changeRole,
          WORKSPACE_TEAM_PERMISSIONS.remove].some((permission) => grants.has(permission))) {
      throw new TypeError('workspace_team_changeset_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const relationship = this.subjectRelationships.validateSubject({
      sqlite: this.input.sqlite,
      workspaceId: this.input.workspaceId,
      userId: actorUserId,
      subject: {
        kind: 'domain', domain: 'changeset', entity: 'owner', id: 'workspace_team'
      },
      evaluatedAt
    });
    if (relationship.kind !== 'valid') {
      throw new TypeError('workspace_team_changeset_relationship_mismatch');
    }
    this.#prepared.clear();
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;
    return sealChangesetLifecyclePreparation({
      capability,
      context,
      preparation: Object.freeze({
        prepare: ({ action: receivedAction, businessInput, context: receivedContext }:
          Parameters<ChangesetLifecyclePreparation['prepare']>[0]) => {
          if (receivedAction !== action || receivedContext !== context
              || !this.input.sqlite.inTransaction) {
            throw new TypeError('workspace_team_changeset_context_substitution');
          }
          return this.prepare({
            action, businessInput, context, actorUserId, evaluatedAt, grants
          });
        }
      })
    });
  }

  private nextId(method: keyof SQLiteWorkspaceTeamChangesetEffectIds): string {
    const value = applicationId(this.#ids[method](), method);
    if (this.#issuedIds.has(value)) throw new TypeError('workspace_team_changeset_ids_not_unique');
    this.#issuedIds.add(value);
    return value;
  }

  private repository(): SQLiteWorkspaceTeamRepository {
    return new SQLiteWorkspaceTeamRepository(this.input.sqlite, this.input.classifiedStore);
  }

  private planningSnapshot(repository: SQLiteWorkspaceTeamRepository): ChangesetPlanningSnapshot {
    return Object.freeze({
      getPort: <Port>(key: ChangesetReadPortKey<Port>): Port => {
        if ((key as unknown) !== workspaceTeamReadPort) {
          throw new TypeError('workspace_team_changeset_undeclared_read_port');
        }
        return repository as unknown as Port;
      }
    });
  }

  private commitTransaction(repository: SQLiteWorkspaceTeamRepository): ChangesetCommitTransaction {
    return Object.freeze({
      getPort: <Port>(
        key: ChangesetValidationPortKey<Port> | ChangesetTransactionPortKey<Port>
      ): Port => {
        if ((key as unknown) !== workspaceTeamValidationPort
            && (key as unknown) !== workspaceTeamTransactionPort) {
          throw new TypeError('workspace_team_changeset_undeclared_transaction_port');
        }
        return repository as unknown as Port;
      }
    });
  }

  private exactRecord(changesetId: string): StoredChangesetRecord | undefined {
    const record = this.lifecycleStore.read(changesetId);
    return record
      && record.head.workspaceId === this.input.workspaceId
      && record.head.eventId === undefined
      && this.resolveOwner(record)?.id === 'workspace_team'
      ? record
      : undefined;
  }

  private currentCommitEvidence(repository: SQLiteWorkspaceTeamRepository) {
    const state = repository.readPlanningSnapshot(this.input.workspaceId);
    const aggregateId = `workspace_team:${this.input.workspaceId}`;
    const guardId = `workspace_team_guard:${this.input.workspaceId}`;
    return Object.freeze({
      aggregateVersions: new Map<string, number>([[aggregateId, state.version]]),
      guardVersions: new Map<string, number>([[guardId, state.version]]),
      guardDigests: new Map<string, string>([[guardId, state.digestSha256]])
    });
  }

  private prepare(input: {
    readonly action: ChangesetLifecycleAction;
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
    readonly actorUserId: UserId;
    readonly evaluatedAt: Instant;
    readonly grants: ReadonlySet<string>;
  }): ChangesetLifecycleContribution {
    const actorContext = Object.freeze({
      workspaceId: this.input.workspaceId,
      principalKey: `workspace_user:${input.actorUserId}`,
      authorityPrincipalKey: input.context.authorityPrincipalKey,
      evaluatedAt: input.evaluatedAt
    });
    const ids: ChangesetLifecycleIds = Object.freeze({
      newChangesetId: () => this.nextId('newChangesetId'),
      newRevisionId: () => this.nextId('newRevisionId'),
      newApprovalId: () => this.nextId('newApprovalId'),
      newCorrectionAttemptId: () => this.nextId('newCorrectionAttemptId')
    });
    const repository = this.repository();
    let record: StoredChangesetRecord;
    let data: Record<string, unknown>;
    let exactCommit: ExactStoredChangesetCommit | undefined;
    let factPayload: unknown;

    const authorize = (candidate: StoredChangesetRecord): boolean =>
      hasPermissions(requiredPermissions({ bundle: this.#bundle, record: candidate }), input.grants);
    const deny = () => {
      throw new TypeError('workspace_team_changeset_permission_mismatch');
    };

    if (input.action === 'propose') {
      const wire = proposeChangesetInputSchema.parse(input.businessInput);
      const current = this.exactRecord(wire.changesetId);
      if (!current) {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution({ kind: 'scope_changed' });
      }
      if (!authorize(current)) return deny();
      const result = proposeStoredChangeset({
        store: this.lifecycleStore, context: actorContext, ...wire
      });
      if (result.kind === 'refused') {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution(result.refusal);
      }
      record = result.record;
      const diff = projectStoredChangesetDiff(record, wire.revisionId, wire.revisionDigest);
      if (!diff) throw new TypeError('workspace_team_changeset_proposal_diff_missing');
      data = { schemaVersion: 1, action: 'propose', diff };
    } else if (input.action === 'approve') {
      const wire = approveChangesetRevisionInputSchema.parse(input.businessInput);
      const current = this.exactRecord(wire.changesetId);
      if (!current) {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution({ kind: 'scope_changed' });
      }
      if (!authorize(current)) return deny();
      const expiresAt = parseInstant(
        new Date(Date.parse(input.evaluatedAt) + 15 * 60_000).toISOString()
      );
      const result = approveStoredChangeset({
        store: this.lifecycleStore,
        ids,
        context: actorContext,
        ...wire,
        currentApprovalPolicy: captureWorkspaceTeamApprovalPolicy(this.#bundle.policy),
        expiresAt
      });
      if (result.kind === 'refused') {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution(result.refusal);
      }
      record = this.lifecycleStore.read(wire.changesetId)!;
      data = {
        schemaVersion: 1,
        action: 'approve',
        changesetId: wire.changesetId,
        headVersion: record.head.version,
        revisionId: wire.revisionId,
        revisionDigest: wire.revisionDigest,
        approvalId: result.approval.receipt.id,
        expiresAt: result.approval.receipt.expiresAt
      };
    } else if (input.action === 'rebuild') {
      const wire = rebuildChangesetInputSchema.parse(input.businessInput);
      const current = this.exactRecord(wire.changesetId);
      if (!current) {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution({ kind: 'scope_changed' });
      }
      if (!authorize(current)) return deny();
      const result = rebuildStoredChangesetSynchronous({
        store: this.lifecycleStore,
        registry: this.#bundle.registry,
        snapshot: this.planningSnapshot(repository),
        ids,
        context: actorContext,
        changesetId: wire.changesetId,
        expectedHeadVersion: wire.expectedHeadVersion,
        sourceRevisionId: wire.sourceRevisionId,
        sourceRevisionDigest: wire.sourceRevisionDigest,
        groups: wire.groups,
        approvalPolicy: captureWorkspaceTeamApprovalPolicy(this.#bundle.policy)
      });
      if (result.kind === 'refused') {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution(result.refusal);
      }
      record = result.record;
      const revision = record.revisions.at(-1)!.revision;
      const diff = projectStoredChangesetDiff(record, revision.id, revision.digest);
      if (!diff) throw new TypeError('workspace_team_changeset_rebuild_diff_missing');
      data = {
        schemaVersion: 1,
        action: 'rebuild',
        sourceRevisionId: wire.sourceRevisionId,
        sourceRevisionDigest: wire.sourceRevisionDigest,
        diff
      };
    } else if (input.action === 'correction') {
      const wire = draftChangesetCorrectionInputSchema.parse(input.businessInput);
      const current = this.exactRecord(wire.sourceChangesetId);
      if (!current) {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution({ kind: 'scope_changed' });
      }
      if (!authorize(current)) return deny();
      const result = draftChangesetCorrectionSynchronous({
        store: this.lifecycleStore,
        registry: this.#bundle.registry,
        snapshot: this.planningSnapshot(repository),
        ids,
        context: actorContext,
        ...wire,
        approvalPolicy: captureWorkspaceTeamApprovalPolicy(this.#bundle.policy)
      });
      if (result.kind === 'refused') {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution(result.refusal);
      }
      record = result.record ?? current;
      const target = result.record === null
        ? null
        : projectStoredChangesetDiff(
            result.record,
            result.record.revisions.at(-1)!.revision.id,
            result.record.revisions.at(-1)!.revision.digest
          );
      if (result.record !== null && !target) {
        throw new TypeError('workspace_team_changeset_correction_diff_missing');
      }
      data = {
        schemaVersion: 1,
        action: 'correction',
        sourceChangesetId: wire.sourceChangesetId,
        sourceRevisionId: wire.sourceRevisionId,
        sourceRevisionDigest: wire.sourceRevisionDigest,
        resultKind: result.kind,
        target,
        evidence: result.link.evidence
      };
    } else {
      const wire = commitChangesetInputSchema.parse(input.businessInput);
      const current = this.exactRecord(wire.changesetId);
      if (!current) {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution({ kind: 'scope_changed' });
      }
      const permissions = requiredPermissions({ bundle: this.#bundle, record: current });
      if (!hasPermissions(permissions, input.grants)) return deny();
      const evidence = this.currentCommitEvidence(repository);
      const validation = validateStoredChangesetCommit({
        store: this.lifecycleStore,
        context: actorContext,
        ...wire,
        currentApprovalPolicy: captureWorkspaceTeamApprovalPolicy(this.#bundle.policy),
        currentAggregateVersions: evidence.aggregateVersions,
        currentGuardVersions: evidence.guardVersions,
        currentGuardDigests: evidence.guardDigests,
        approverCurrentlyAuthorized: (principalKey) => permissions.every((permissionId) =>
          this.input.approverAuthority?.isCurrentlyAuthorized({
            sqlite: this.input.sqlite,
            workspaceId: this.input.workspaceId,
            principalKey,
            permissionId,
            evaluatedAt: input.evaluatedAt
          }) ?? false
        ),
        receiptExpectation: {
          operation: COMMIT_CHANGESET_OPERATION,
          surface: input.context.surface,
          scopePartitionKey: input.context.requestBinding.scopePartitionKey,
          authorityPrincipalKey: input.context.authorityPrincipalKey,
          requestHashSha256: input.context.requestBinding.requestHashSha256
        }
      });
      if (validation.kind === 'refused') {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution(validation.refusal);
      }
      const prepared = prepareChangesetCommitSynchronous({
        registry: this.#bundle.registry,
        authorization: validation.commit.authorization,
        transaction: this.commitTransaction(repository)
      });
      if (prepared.kind === 'outcome') {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution({ kind: 'domain_changed' });
      }
      const applied = applyPreparedChangesetSynchronous(prepared.prepared);
      exactCommit = validation.commit;
      record = current;
      factPayload = {
        changesetId: wire.changesetId,
        revisionId: wire.revisionId,
        revisionDigest: wire.revisionDigest,
        contributions: applied.map((contribution) => ({
          result: contribution.result,
          facts: contribution.facts
        }))
      };
      data = {
        schemaVersion: 1,
        action: 'commit',
        changesetId: wire.changesetId,
        expectedHeadVersion: wire.expectedHeadVersion,
        committedHeadVersion: wire.expectedHeadVersion + 1,
        revisionId: wire.revisionId,
        revisionDigest: wire.revisionDigest
      };
    }

    const revision = input.action === 'correction' && data.target === null
      ? record.revisions.find((candidate) => candidate.revision.id === data.sourceRevisionId)
      : record.revisions.at(-1);
    if (!revision) throw new TypeError('workspace_team_changeset_revision_missing');
    const handle = this.nextId('newPreparationHandle');
    const timelineId = this.nextId('newTimelineId');
    const domain = {
      kind: 'changeset_lifecycle',
      action: input.action,
      preparationHandle: handle,
      workspaceId: this.input.workspaceId,
      changesetId: record.head.id,
      revisionId: revision.revision.id,
      revisionDigest: revision.revision.digest,
      contributionDigestSha256: canonicalJsonSha256({ action: input.action, data }),
      occurredAt: input.evaluatedAt
    };
    const timeline = {
      kind: 'timeline',
      timelineId,
      sourceKind: timelineSource(input.action),
      workspaceId: this.input.workspaceId,
      changesetId: record.head.id,
      revisionId: revision.revision.id,
      occurredAt: input.evaluatedAt
    };
    const receiptChildren = input.action === 'commit'
      ? [{
          kind: 'domain_fact',
          factId: this.nextId('newFactId'),
          factKind: 'workspace_team_changed',
          factVersion: 1,
          workspaceId: this.input.workspaceId,
          changesetId: record.head.id,
          revisionId: revision.revision.id,
          payload: factPayload
        }, {
          kind: 'outbox_pointer',
          pointerId: this.nextId('newPointerId'),
          sourceKind: 'domain_fact',
          factId: ''
        }, timeline]
      : [timeline];
    if (input.action === 'commit') {
      (receiptChildren[1] as { factId: string }).factId =
        (receiptChildren[0] as { factId: string }).factId;
    }
    const candidate = changesetLifecycleContributionSchema.parse({
      result: { kind: 'success', data },
      domain,
      receiptChildren
    });
    if (candidate.result.kind !== 'success' || candidate.domain === null) {
      throw new TypeError('workspace_team_changeset_success_contribution_invalid');
    }
    const contribution = candidate as LifecycleSuccess;
    this.#prepared.set(handle, {
      handle,
      context: input.context,
      action: input.action,
      workspaceId: this.input.workspaceId,
      evaluatedAt: input.evaluatedAt,
      record,
      contribution,
      ...(exactCommit === undefined ? {} : { exactCommit }),
      phase: 'prepared',
      nextChild: 0
    });
    return contribution;
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('workspace_team_changeset_transaction_required');
    }
    const parsed = changesetLifecycleDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (!prepared || prepared.phase !== 'prepared'
        || parsed.eventId !== undefined
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('workspace_team_changeset_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsedResult = changesetLifecycleOperationResultSchema.safeParse(receipt.result);
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== active.context.operation.name
        || receipt.ref.operationVersion !== active.context.operation.version
        || !parsedResult.success || parsedResult.data.kind !== 'success'
        || parsedResult.data.receipt.id !== receipt.ref.id
        || canonicalJsonText(parsedResult.data.data)
          !== canonicalJsonText(active.contribution.result.data)) {
      throw new TypeError('workspace_team_changeset_receipt_mismatch');
    }
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    let record = active.record;
    if (active.action === 'commit') {
      if (!active.exactCommit) throw new TypeError('workspace_team_changeset_commit_missing');
      record = commitStoredChangeset({
        store: this.lifecycleStore,
        commit: active.exactCommit,
        terminalReceipt: parseChangesetCommitTerminalReceipt(receipt)
      }).record;
    }
    const domain = active.contribution.domain;
    this.input.sqlite.query(`
      INSERT INTO workspace_team_changeset_effect_receipt_links (
        receipt_id, action, operation_name, operation_version,
        workspace_id, changeset_id, revision_id,
        revision_digest_sha256, record_digest_sha256, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId,
      active.action,
      active.context.operation.name,
      active.context.operation.version,
      active.workspaceId,
      domain.changesetId,
      domain.revisionId,
      domain.revisionDigest,
      record.recordDigestSha256,
      Date.parse(active.evaluatedAt)
    );
    active.receiptId = receiptId;
    active.phase = 'parent_linked';
    this.#expectedIdentity = receipt.identity;
  }

  afterReceiptChildInserted(receiptId: string, contribution: unknown): void {
    const active = this.#active;
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'parent_linked'
        || !this.#expectedIdentity || active.receiptId !== receiptId) {
      throw new TypeError('workspace_team_changeset_receipt_parent_missing');
    }
    const expected = active.contribution.receiptChildren[active.nextChild];
    if (!expected || canonicalJsonText(contribution) !== canonicalJsonText(expected)) {
      throw new TypeError('workspace_team_changeset_evidence_mismatch');
    }
    if ((contribution as { readonly kind?: unknown }).kind === 'domain_fact') {
      const child = workspaceChangesetDomainFactEvidenceChildSchema.parse(contribution);
      this.input.sqlite.query(`
        INSERT INTO workspace_team_changeset_domain_facts (
          fact_id, receipt_id, workspace_id, changeset_id, revision_id,
          fact_kind, fact_version, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        child.factId, receiptId, child.workspaceId, child.changesetId,
        child.revisionId, child.factKind, child.factVersion,
        canonicalJsonText(child.payload)
      );
    } else if ((contribution as { readonly kind?: unknown }).kind === 'outbox_pointer') {
      const child = changesetOutboxEvidenceChildSchema.parse(contribution);
      this.input.sqlite.query(`
        INSERT INTO workspace_team_changeset_outbox_pointers (
          pointer_id, receipt_id, fact_id, source_kind
        ) VALUES (?, ?, ?, ?)
      `).run(child.pointerId, receiptId, child.factId, child.sourceKind);
    } else {
      const child = workspaceChangesetTimelineEvidenceChildSchema.parse(contribution);
      this.input.sqlite.query(`
        INSERT INTO workspace_team_changeset_timeline (
          timeline_id, receipt_id, source_kind, workspace_id,
          changeset_id, revision_id, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        child.timelineId, receiptId, child.sourceKind, child.workspaceId,
        child.changesetId, child.revisionId, Date.parse(parseInstant(child.occurredAt))
      );
    }
    active.nextChild += 1;
    if (active.nextChild === active.contribution.receiptChildren.length) {
      active.phase = 'evidence_complete';
    }
  }

  afterExecutionClaimReleased(identity: EffectOperationIdentity): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('workspace_team_changeset_transaction_required');
    }
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('workspace_team_changeset_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (active.phase !== 'evidence_complete' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('workspace_team_changeset_incomplete');
    }
    active.phase = 'claim_released';
  }

  afterUnitOfWorkFinished(): void {
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;
    this.#prepared.clear();
  }
}

export function createSQLiteWorkspaceTeamChangesetEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly policy: WorkspaceTeamChangesetPolicy;
  readonly classifiedStore: SynchronousClassifiedPayloadStore;
  readonly ids: SQLiteWorkspaceTeamChangesetEffectIds;
  readonly approverAuthority?: WorkspaceTeamApproverAuthoritySource;
}) {
  const adapter = new SQLiteWorkspaceTeamChangesetEffectDomainAdapter(input);
  return Object.freeze({
    capability: CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
    adapter,
    lifecycleStore: adapter.lifecycleStore,
    ownerResolution: adapter as ChangesetLifecycleOwnerResolutionSource,
    subjectRelationships: adapter.subjectRelationships
  });
}
