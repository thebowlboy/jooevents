import type { Database } from 'bun:sqlite';
import {
  effectOperationIdentitiesEqual,
  effectOperationIdentityMatchesContext,
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  WORKSPACE_TEAM_DRAFT_HANDLER_CAPABILITY,
  WORKSPACE_TEAM_OPERATION_ACCESS,
  sealWorkspaceTeamDraftPreparation,
  workspaceTeamDraftActionForOperation,
  workspaceTeamDraftContributionSchema,
  workspaceTeamDraftDomainContributionSchema,
  workspaceTeamDraftEvidenceChildSchema,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type EffectOperationIdentity,
  type SealedEffectAuthorityRecheckResult,
  type TerminalEffectReceipt,
  type WorkspaceTeamDraftAction,
  type WorkspaceTeamDraftContribution
} from '@jooevents/application';
import type { SynchronousClassifiedPayloadStore } from '@jooevents/application/synchronous-classified-payload-store';
import type { ChangesetPlanningSnapshot, ChangesetReadPortKey } from '@jooevents/changesets';
import { appendChangesetDraftSynchronous } from '@jooevents/changeset-operations';
import {
  workspaceTeamInviteDraftInputSchema,
  workspaceTeamRoleChangeDraftInputSchema,
  workspaceTeamRemovalDraftInputSchema,
  workspaceTeamDraftOperationResultSchema
} from '@jooevents/contracts';
import {
  WorkspaceTeamPlanningError,
  normalizeEmail
} from '@jooevents/identity-access';
import {
  canonicalJsonText,
  parseChangesetId,
  parseChangesetRevisionId,
  parseInstant,
  parseOperationReceiptId,
  parsePayloadRefId,
  parseUserId,
  parseWorkspaceId,
  type Instant,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import {
  createSQLiteDraftOnlyChangesetLifecycleStore,
  type SQLiteChangesetLifecycleStore
} from './changeset-lifecycle';
import {
  WORKSPACE_TEAM_CHANGESET_KIND,
  WORKSPACE_TEAM_CHANGESET_VERSION,
  assertWorkspaceTeamChangesetBundle,
  captureWorkspaceTeamApprovalPolicy,
  createWorkspaceTeamChangesetBundle,
  workspaceTeamChangesetAuthorInputSchema,
  workspaceTeamReadPort,
  type WorkspaceTeamChangesetAuthorInput,
  type WorkspaceTeamChangesetBundle,
  type WorkspaceTeamChangesetPolicy
} from './workspace-team-changesets';
import {
  SQLiteWorkspaceTeamRepository,
  adoptWorkspaceInvitationRecipient,
  workspaceInvitationLookupBinding,
  workspaceInvitationRecipientHint
} from './workspace-team';

export const WORKSPACE_TEAM_DRAFT_EFFECT_SQL = `
CREATE TABLE workspace_team_draft_receipt_links (
  receipt_id TEXT PRIMARY KEY REFERENCES foundation_trial_operation_receipts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  revision_digest_sha256 TEXT NOT NULL CHECK(length(revision_digest_sha256) = 64),
  record_digest_sha256 TEXT NOT NULL CHECK(length(record_digest_sha256) = 64),
  action TEXT NOT NULL CHECK(action IN ('invite','change_role','remove')),
  operation_name TEXT NOT NULL,
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000)
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_team_draft_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE REFERENCES workspace_team_draft_receipt_links(receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind = 'changeset_revision')
) STRICT, WITHOUT ROWID;

CREATE TRIGGER workspace_team_draft_receipt_no_update
BEFORE UPDATE ON workspace_team_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'workspace team draft receipt is immutable'); END;
CREATE TRIGGER workspace_team_draft_receipt_no_delete
BEFORE DELETE ON workspace_team_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'workspace team draft receipt is immutable'); END;
CREATE TRIGGER workspace_team_draft_timeline_no_update
BEFORE UPDATE ON workspace_team_draft_timeline
BEGIN SELECT RAISE(ABORT, 'workspace team draft timeline is immutable'); END;
CREATE TRIGGER workspace_team_draft_timeline_no_delete
BEFORE DELETE ON workspace_team_draft_timeline
BEGIN SELECT RAISE(ABORT, 'workspace team draft timeline is immutable'); END;
`;

export function installWorkspaceTeamDraftEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('workspace_team_draft_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(WORKSPACE_TEAM_DRAFT_EFFECT_SQL)).immediate();
}

export interface SQLiteWorkspaceTeamDraftEffectIds {
  newChangesetId(): string;
  newRevisionId(): string;
  newPreparationHandle(): string;
  newTimelineId(): string;
  newReservationId(): string;
  newReservationRoleAssignmentId(): string;
  newReleaseIntentId(): string;
  newHistoryId(): string;
  newPayloadRefId(): string;
  newSessionRevocationIntentId(): string;
}

type DraftSuccess = Extract<
  WorkspaceTeamDraftContribution,
  { result: { kind: 'success' } }
>;

interface PreparedDraft {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly action: WorkspaceTeamDraftAction;
  readonly workspaceId: WorkspaceId;
  readonly actorUserId: UserId;
  readonly evaluatedAt: Instant;
  readonly contribution: DraftSuccess;
  phase: 'prepared' | 'applied' | 'parent_linked' | 'evidence_complete' | 'claim_released';
  receiptId?: string;
}

function collisionContribution(): WorkspaceTeamDraftContribution {
  return workspaceTeamDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'conflict', kind: 'changeset.id_collision', retryable: false,
        subjects: [], detail: null, detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

function planningRefusal(
  error: WorkspaceTeamPlanningError,
  action: WorkspaceTeamDraftAction
): WorkspaceTeamDraftContribution {
  const stale = error.code === 'stale_team' || error.code === 'stale_subject';
  const policy = [
    'unsupported_assignment', 'current_actor_role_change',
    'current_actor_removal', 'last_owner'
  ].includes(error.code);
  return workspaceTeamDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: stale ? 'stale_revision' : policy ? 'policy_violation' : 'conflict',
        kind: 'workspace_team.change_refused', retryable: false, subjects: [],
        detail: { code: error.code, action }, detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

function permissionFor(action: WorkspaceTeamDraftAction): string {
  if (action === 'invite') return WORKSPACE_TEAM_OPERATION_ACCESS.invite.permissionId;
  if (action === 'change_role') return WORKSPACE_TEAM_OPERATION_ACCESS.changeRole.permissionId;
  return WORKSPACE_TEAM_OPERATION_ACCESS.remove.permissionId;
}

function policyFor(action: WorkspaceTeamDraftAction) {
  if (action === 'invite') return WORKSPACE_TEAM_OPERATION_ACCESS.invite.policy;
  if (action === 'change_role') return WORKSPACE_TEAM_OPERATION_ACCESS.changeRole.policy;
  return WORKSPACE_TEAM_OPERATION_ACCESS.remove.policy;
}

function exactWorkspaceSubjects(context: EffectInvocationContext): boolean {
  return context.scope.eventId === undefined
    && context.scope.subjects.length === 1
    && context.scope.subjects[0]?.kind === 'workspace'
    && context.scope.subjects[0].id === context.scope.workspaceId;
}

/** Transaction-owned inert changeset draft; effective team state remains unchanged. */
export class SQLiteWorkspaceTeamDraftEffectDomainAdapter
implements SQLiteEffectDomainAdapter {
  readonly #bundle: WorkspaceTeamChangesetBundle;
  readonly #changesets: SQLiteChangesetLifecycleStore;
  readonly #ids: SQLiteWorkspaceTeamDraftEffectIds;
  readonly #issued = new Set<string>();
  readonly #prepared = new Map<string, PreparedDraft>();
  #active: PreparedDraft | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly policy: WorkspaceTeamChangesetPolicy;
    readonly classifiedStore: SynchronousClassifiedPayloadStore;
    readonly invitationLookupKeyBytes: Uint8Array;
    readonly ids: SQLiteWorkspaceTeamDraftEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    this.#bundle = createWorkspaceTeamChangesetBundle({ policy: input.policy });
    assertWorkspaceTeamChangesetBundle(this.#bundle);
    this.#changesets = createSQLiteDraftOnlyChangesetLifecycleStore(input.sqlite);
    this.#ids = input.ids;
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction
        || capability.key !== WORKSPACE_TEAM_DRAFT_HANDLER_CAPABILITY.key
        || capability.version !== WORKSPACE_TEAM_DRAFT_HANDLER_CAPABILITY.version) {
      throw new TypeError('workspace_team_draft_capability_mismatch');
    }
    const action = workspaceTeamDraftActionForOperation(
      context.operation.name, context.operation.version
    );
    if (!action || context.operation.effect !== 'draft'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || !exactWorkspaceSubjects(context)) {
      throw new TypeError('workspace_team_draft_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    const expectedPolicy = policyFor(action);
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator'
        || authority.lane.policy.key !== expectedPolicy.key
        || authority.lane.policy.version !== expectedPolicy.version
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === permissionFor(action)
        )) {
      throw new TypeError('workspace_team_draft_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const repository = new SQLiteWorkspaceTeamRepository(
      this.input.sqlite, this.input.classifiedStore
    );
    const snapshot: ChangesetPlanningSnapshot = Object.freeze({
      getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
        if ((key as unknown) !== workspaceTeamReadPort) {
          throw new TypeError('workspace_team_draft_undeclared_read_port');
        }
        return repository as unknown as Port;
      }
    });
    return sealWorkspaceTeamDraftPreparation({
      capability,
      context,
      preparation: {
        prepare: ({ action: receivedAction, businessInput, context: receivedContext }) => {
          if (receivedAction !== action || receivedContext !== context
              || !this.input.sqlite.inTransaction) {
            throw new TypeError('workspace_team_draft_context_substitution');
          }
          const changesetId = parseChangesetId(this.#fresh(this.#ids.newChangesetId));
          const revisionId = parseChangesetRevisionId(this.#fresh(this.#ids.newRevisionId));
          const handle = this.#fresh(this.#ids.newPreparationHandle);
          const timelineId = this.#fresh(this.#ids.newTimelineId);
          let author: WorkspaceTeamChangesetAuthorInput;
          let invitationAdoption: {
            readonly reservationId: string;
            readonly payloadRefId: string;
            readonly normalizedEmail: string;
          } | undefined;
          try {
            if (action === 'invite') {
              const request = workspaceTeamInviteDraftInputSchema.parse(businessInput);
              const reservationId = this.#fresh(this.#ids.newReservationId);
              const payloadRefId = parsePayloadRefId(this.#fresh(this.#ids.newPayloadRefId));
              const normalizedEmail = normalizeEmail(request.email);
              const lookupBinding = workspaceInvitationLookupBinding({
                keyBytes: this.input.invitationLookupKeyBytes,
                workspaceId: this.input.workspaceId,
                normalizedEmail
              });
              const recipient = {
                payloadRefId,
                lookupBinding,
                hint: workspaceInvitationRecipientHint(lookupBinding)
              };
              invitationAdoption = { reservationId, payloadRefId, normalizedEmail };
              author = workspaceTeamChangesetAuthorInputSchema.parse({
                action, workspaceId: this.input.workspaceId,
                expectedTeamVersion: request.expectedTeamVersion,
                expectedTeamDigestSha256: request.expectedTeamDigestSha256,
                roleKey: request.roleKey, recipient,
                ids: {
                  reservationId,
                  reservationRoleAssignmentId: this.#fresh(
                    this.#ids.newReservationRoleAssignmentId
                  ),
                  releaseIntentId: this.#fresh(this.#ids.newReleaseIntentId),
                  historyId: this.#fresh(this.#ids.newHistoryId)
                },
                actorUserId,
                evaluatedAt
              });
            } else if (action === 'change_role') {
              const request = workspaceTeamRoleChangeDraftInputSchema.parse(businessInput);
              author = workspaceTeamChangesetAuthorInputSchema.parse({
                action, workspaceId: this.input.workspaceId,
                expectedTeamVersion: request.expectedTeamVersion,
                expectedTeamDigestSha256: request.expectedTeamDigestSha256,
                subject: request.subject, roleKey: request.roleKey,
                actorUserId, evaluatedAt,
                historyId: this.#fresh(this.#ids.newHistoryId)
              });
            } else {
              const request = workspaceTeamRemovalDraftInputSchema.parse(businessInput);
              author = workspaceTeamChangesetAuthorInputSchema.parse({
                action, workspaceId: this.input.workspaceId,
                expectedTeamVersion: request.expectedTeamVersion,
                expectedTeamDigestSha256: request.expectedTeamDigestSha256,
                subject: request.subject, actorUserId, evaluatedAt,
                historyId: this.#fresh(this.#ids.newHistoryId),
                ...(request.subject.kind === 'member'
                  ? { sessionRevocationIntentId: this.#fresh(
                      this.#ids.newSessionRevocationIntentId
                    ) }
                  : {})
              });
            }
            const before = repository.readPlanningSnapshot(this.input.workspaceId);
            const appended = appendChangesetDraftSynchronous({
              store: this.#changesets,
              registry: this.#bundle.registry,
              snapshot,
              ids: {
                newChangesetId: () => changesetId,
                newRevisionId: () => revisionId,
                newApprovalId: () => { throw new TypeError('approval_unavailable'); },
                newCorrectionAttemptId: () => { throw new TypeError('correction_unavailable'); }
              },
              context: {
                workspaceId: this.input.workspaceId,
                principalKey: `workspace_user:${actorUserId}`,
                authorityPrincipalKey: context.authorityPrincipalKey,
                evaluatedAt
              },
              operations: [{
                kind: WORKSPACE_TEAM_CHANGESET_KIND,
                version: WORKSPACE_TEAM_CHANGESET_VERSION,
                dependencyGroup: 'workspace_team',
                authorInput: author
              }],
              dependencyGroups: [{ key: 'workspace_team', dependsOn: [] }],
              approvalPolicy: captureWorkspaceTeamApprovalPolicy(this.input.policy),
              origin: 'human_ui'
            });
            if (appended.kind === 'refused') {
              this.#nonterminalContext = context;
              return collisionContribution();
            }
            if (invitationAdoption) {
              const adopted = adoptWorkspaceInvitationRecipient({
                store: this.input.classifiedStore,
                workspaceId: this.input.workspaceId,
                reservationId: invitationAdoption.reservationId,
                payloadRefId: invitationAdoption.payloadRefId,
                normalizedEmail: invitationAdoption.normalizedEmail,
                lookupKeyBytes: this.input.invitationLookupKeyBytes,
                createdAt: evaluatedAt
              });
              const planned = author.action === 'invite' ? author.recipient : undefined;
              if (!planned || canonicalJsonText(planned) !== canonicalJsonText(adopted)) {
                throw new TypeError('workspace_team_draft_recipient_adoption_mismatch');
              }
            }
            const after = repository.readPlanningSnapshot(this.input.workspaceId);
            if (before.version !== after.version
                || before.digestSha256 !== after.digestSha256) {
              throw new TypeError('workspace_team_draft_mutated_effective_state');
            }
            const revision = appended.record.revisions[0];
            const operation = revision?.revision.operations[0];
            if (!revision || !operation || revision.revision.operations.length !== 1) {
              throw new TypeError('workspace_team_draft_record_incoherent');
            }
            const contribution = workspaceTeamDraftContributionSchema.parse({
              result: {
                kind: 'success',
                data: {
                  schemaVersion: 1, action, changesetId,
                  headVersion: appended.record.head.version,
                  status: appended.record.head.status,
                  revision: {
                    id: revisionId, number: revision.revision.number,
                    digestSha256: revision.revision.digest
                  },
                  riskTier: revision.revision.riskTier,
                  approvalPolicy: revision.approvalPolicy,
                  safeDiff: operation.safeDiff
                }
              },
              domain: {
                kind: 'workspace_team_changeset_draft',
                preparationHandle: handle, action,
                workspaceId: this.input.workspaceId,
                changesetId, revisionId,
                revisionDigestSha256: revision.revision.digest,
                recordDigestSha256: appended.record.recordDigestSha256,
                occurredAt: evaluatedAt
              },
              receiptChildren: [{
                kind: 'timeline', timelineId, sourceKind: 'changeset_revision',
                workspaceId: this.input.workspaceId,
                changesetId, revisionId, occurredAt: evaluatedAt
              }]
            });
            if (contribution.result.kind !== 'success' || !contribution.domain) {
              throw new TypeError('workspace_team_draft_contribution_invalid');
            }
            const success = contribution as DraftSuccess;
            this.#prepared.set(handle, {
              handle, context, action, workspaceId: this.input.workspaceId,
              actorUserId, evaluatedAt, contribution: success, phase: 'prepared'
            });
            return success;
          } catch (error) {
            if (error instanceof WorkspaceTeamPlanningError) {
              this.#nonterminalContext = context;
              return planningRefusal(error, action);
            }
            throw error;
          }
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('workspace_team_draft_transaction_required');
    const parsed = workspaceTeamDraftDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    const stored = prepared ? this.#changesets.read(parsed.changesetId) : undefined;
    if (!prepared || prepared.phase !== 'prepared' || !stored
        || stored.recordDigestSha256 !== parsed.recordDigestSha256
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('workspace_team_draft_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsed = workspaceTeamDraftOperationResultSchema.safeParse(receipt.result);
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || !parsed.success || parsed.data.kind !== 'success'
        || canonicalJsonText(parsed.data.data)
          !== canonicalJsonText(active.contribution.result.data)) {
      throw new TypeError('workspace_team_draft_receipt_mismatch');
    }
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    const domain = active.contribution.domain;
    this.input.sqlite.query(`
      INSERT INTO workspace_team_draft_receipt_links (
        receipt_id, workspace_id, changeset_id, revision_id,
        revision_digest_sha256, record_digest_sha256, action,
        operation_name, operation_version, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(receiptId, active.workspaceId, domain.changesetId, domain.revisionId,
      domain.revisionDigestSha256, domain.recordDigestSha256, active.action,
      active.context.operation.name, active.context.operation.version,
      Date.parse(active.evaluatedAt));
    active.receiptId = receiptId;
    active.phase = 'parent_linked';
    this.#expectedIdentity = receipt.identity;
  }

  afterReceiptChildInserted(receiptId: string, contribution: unknown): void {
    const active = this.#active;
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'parent_linked'
        || receiptId !== active.receiptId) {
      throw new TypeError('workspace_team_draft_receipt_parent_missing');
    }
    const child = workspaceTeamDraftEvidenceChildSchema.parse(contribution);
    if (canonicalJsonText(child)
        !== canonicalJsonText(active.contribution.receiptChildren[0])) {
      throw new TypeError('workspace_team_draft_evidence_mismatch');
    }
    this.input.sqlite.query(`
      INSERT INTO workspace_team_draft_timeline (
        timeline_id, receipt_id, workspace_id, changeset_id,
        revision_id, occurred_at_ms, source_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(child.timelineId, receiptId, child.workspaceId, child.changesetId,
      child.revisionId, Date.parse(parseInstant(child.occurredAt)), child.sourceKind);
    active.phase = 'evidence_complete';
  }

  afterExecutionClaimReleased(identity: EffectOperationIdentity): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('workspace_team_draft_transaction_required');
    if (!this.#active) {
      if (!this.#nonterminalContext
          || !effectOperationIdentityMatchesContext(identity, this.#nonterminalContext)) {
        throw new TypeError('workspace_team_draft_incomplete');
      }
      this.#nonterminalContext = undefined;
      return;
    }
    if (this.#active.phase !== 'evidence_complete' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('workspace_team_draft_incomplete');
    }
    this.#active.phase = 'claim_released';
  }

  afterUnitOfWorkFinished(): void {
    this.#prepared.clear();
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalContext = undefined;
  }

  #fresh(factory: () => string): string {
    const value = factory.call(this.#ids);
    if (typeof value !== 'string' || this.#issued.has(value)) {
      throw new TypeError('workspace_team_draft_id_invalid');
    }
    this.#issued.add(value);
    return value;
  }
}
