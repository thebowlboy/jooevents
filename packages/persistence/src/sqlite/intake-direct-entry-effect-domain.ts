import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type ClassifiedPayloadProfiles,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  adoptSynchronousClassifiedPayload,
  type SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import { submissionDirectEntryInputSchema, submissionDirectEntryResultSchema } from '@jooevents/contracts';
import {
  ApplicationAnswerError,
  ApplicationPlanningError,
  finalizeGovernedAnswerIndex,
  parseApplicationDirectEntryPlan,
  planApplicationDirectEntry,
  prepareApplicationAnswers,
  submissionDirectEntryAnswerOwner,
  type ApplicationDirectEntryPlan
} from '@jooevents/intake';
import {
  SUBMISSION_DIRECT_ENTRY_ACCESS_POLICY,
  SUBMISSION_DIRECT_ENTRY_CREATE_OPERATION,
  SUBMISSION_DIRECT_ENTRY_DIRECT_HANDLER_CAPABILITY,
  sealIntakePreparation,
  submissionDirectEntryDirectContributionSchema
} from '@jooevents/intake-operations';
import {
  parseInstant,
  parsePayloadRefId,
  parseUserId,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { SubmissionTriageInitializationPort } from '@jooevents/submission-triage';
import { SQLiteEventSpineRepository } from './event-spine';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';
import type { SQLiteIntakeClassifiedProjection } from './intake-classified-projection';
import type { SQLiteIntakeRepository } from './intake';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';

const same = (
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
) => left.key === right.key && left.version === right.version;

function exact(context: EffectInvocationContext): boolean {
  return context.scope.eventId !== undefined
    && context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId)
    && context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === context.scope.eventId);
}

type SubmissionDirectEntryRefusalCode =
  | 'wrong_scope' | 'form_missing' | 'form_not_open' | 'form_version_mismatch'
  | 'target_unavailable' | 'deadline_unavailable' | 'deadline_changed'
  | 'invalid_answers' | 'invalid_submission_identity'
  | 'direct_entry_title_required' | 'direct_entry_email_required' | 'invalid_plan';

const staleCodes = new Set<SubmissionDirectEntryRefusalCode>([
  'wrong_scope', 'form_missing', 'form_not_open', 'form_version_mismatch',
  'target_unavailable', 'deadline_unavailable', 'deadline_changed'
]);

function refusalCode(error: unknown): SubmissionDirectEntryRefusalCode {
  if (error instanceof ApplicationAnswerError) return 'invalid_answers';
  if (error instanceof ApplicationPlanningError) {
    const allowed: readonly SubmissionDirectEntryRefusalCode[] = [
      'wrong_scope', 'form_missing', 'form_not_open', 'form_version_mismatch',
      'target_unavailable', 'deadline_unavailable', 'deadline_changed',
      'invalid_answers', 'invalid_submission_identity',
      'direct_entry_title_required', 'direct_entry_email_required', 'invalid_plan'
    ];
    return (allowed as readonly string[]).includes(error.code)
      ? error.code as SubmissionDirectEntryRefusalCode
      : 'invalid_plan';
  }
  return 'invalid_plan';
}

export interface SQLiteIntakeDirectEntryEffectIds {
  newPayloadRefId(): string;
  newSubmissionId(): string;
  newEntryEvidenceId(): string;
  newPersonId(): string;
  newParticipantIdentityId(): string;
  newParticipantEvidenceId(): string;
}

export class SQLiteIntakeDirectEntryEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  readonly #issuedIds = new Set<string>();
  readonly #pendingBuffers = new Set<Uint8Array>();

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly repository: SQLiteIntakeRepository;
    readonly projection: SQLiteIntakeClassifiedProjection;
    readonly submissionTriage: SubmissionTriageInitializationPort;
    readonly classifiedStore: SynchronousClassifiedPayloadStore;
    readonly classifiedProfiles: ClassifiedPayloadProfiles;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteIntakeDirectEntryEffectIds;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction
        || !same(capability, SUBMISSION_DIRECT_ENTRY_DIRECT_HANDLER_CAPABILITY)) {
      throw new TypeError('intake_direct_entry_capability_mismatch');
    }
    if (context.operation.name !== SUBMISSION_DIRECT_ENTRY_CREATE_OPERATION.name
        || context.operation.version !== SUBMISSION_DIRECT_ENTRY_CREATE_OPERATION.version
        || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId
        || !exact(context)) {
      throw new TypeError('intake_direct_entry_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const occurredAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || !same(authority.lane.policy, SUBMISSION_DIRECT_ENTRY_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage')) {
      throw new TypeError('intake_direct_entry_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const scope = { workspaceId: this.#workspaceId, eventId: context.scope.eventId! };
    const current = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventState(this.#workspaceId);
    const relationship = this.input.eventRelationships.validateEvent({
      sqlite: this.input.sqlite,
      workspaceId: this.#workspaceId,
      eventId: scope.eventId,
      userId: actorUserId,
      evaluatedAt: occurredAt
    });
    if (relationship.kind !== 'valid' || current?.currentEvent?.id !== scope.eventId) {
      throw new TypeError('intake_direct_entry_event_relationship_mismatch');
    }
    return sealIntakePreparation({
      capability,
      context,
      preparation: { prepare: ({ businessInput, context: received }) => {
        if (received !== context || !this.input.sqlite.inTransaction) {
          throw new TypeError('intake_direct_entry_context_substitution');
        }
        const wire = submissionDirectEntryInputSchema.parse(businessInput);
        const rawBuffers: Uint8Array[] = [];
        this.input.sqlite.exec('SAVEPOINT intake_direct_entry_prepare');
        try {
          const formHead = this.input.repository.readFormHead(scope, wire.formId);
          if (!formHead) throw new ApplicationPlanningError('form_version_mismatch');
          if (formHead.version !== wire.expectedFormDefinitionVersion) {
            throw new ApplicationPlanningError('form_version_mismatch');
          }
          if (formHead.status !== 'open' || formHead.currentPublishedVersionId === null) {
            throw new ApplicationPlanningError('form_not_open');
          }
          const formVersion = this.input.repository.readFormVersion(
            scope, formHead.currentPublishedVersionId
          );
          if (!formVersion) throw new ApplicationPlanningError('form_version_mismatch');
          const entryEvidenceId = this.fresh('newEntryEvidenceId');
          const identities = {
            submissionId: this.fresh('newSubmissionId'),
            entryEvidenceId,
            submitEvidenceId: entryEvidenceId,
            personId: this.fresh('newPersonId'),
            participantIdentityId: this.fresh('newParticipantIdentityId'),
            participantEvidenceId: this.fresh('newParticipantEvidenceId'),
            consentEvidenceIds: []
          };
          const prepared = prepareApplicationAnswers({
            answers: wire.answers,
            formVersion,
            optionSource: this.input.repository,
            mode: 'direct_entry',
            owner: submissionDirectEntryAnswerOwner({
              scope: formVersion.scope,
              submissionId: identities.submissionId,
              entryEvidenceId: identities.entryEvidenceId,
              enteredByUserId: actorUserId
            })
          });
          const adoptions = prepared.payloads.map((payload) => {
            rawBuffers.push(payload.bytes);
            this.#pendingBuffers.add(payload.bytes);
            return adoptSynchronousClassifiedPayload({
              store: this.input.classifiedStore,
              put: {
                payloadRefId: parsePayloadRefId(this.fresh('newPayloadRefId')),
                binding: {
                  profiles: this.input.classifiedProfiles,
                  scopeBinding: payload.binding.scopeBinding,
                  contentType: payload.binding.contentType
                },
                purpose: payload.binding.profileKey,
                bytes: payload.bytes,
                createdAt: parseInstant(occurredAt)
              }
            });
          });
          const answers = finalizeGovernedAnswerIndex({
            prepared,
            adoptions,
            expectedStore: this.input.classifiedStore,
            expectedProfiles: this.input.classifiedProfiles
          });
          const plan = planApplicationDirectEntry({
            formHead,
            formVersion,
            collection: this.input.repository,
            answers,
            identities,
            enteredByUserId: actorUserId,
            requestDigestSha256: context.requestBinding.requestHashSha256,
            server: { submittedAt: occurredAt }
          });
          const data = submissionDirectEntryResultSchema.parse({
            schemaVersion: 1,
            action: 'create',
            submissionId: plan.submission.id,
            formId: plan.submission.formId,
            formVersionId: plan.submission.formVersionId,
            source: 'direct_entry',
            submittedAt: plan.submission.submittedAt
          });
          const contribution = submissionDirectEntryDirectContributionSchema.parse({
            result: { kind: 'success', data },
            domain: { kind: 'submission_direct_entry_direct', plan },
            effectContributions: []
          });
          this.input.sqlite.exec('RELEASE SAVEPOINT intake_direct_entry_prepare');
          return contribution;
        } catch (error) {
          this.input.sqlite.exec('ROLLBACK TO SAVEPOINT intake_direct_entry_prepare');
          this.input.sqlite.exec('RELEASE SAVEPOINT intake_direct_entry_prepare');
          rawBuffers.forEach((buffer) => buffer.fill(0));
          if (!(error instanceof ApplicationPlanningError)
              && !(error instanceof ApplicationAnswerError)) throw error;
          const code = refusalCode(error);
          const stale = staleCodes.has(code);
          return submissionDirectEntryDirectContributionSchema.parse({
            result: { kind: 'outcome', outcome: {
              class: stale ? 'stale_revision' : 'policy_violation',
              kind: stale ? 'submission_direct_entry.changed' : 'submission_direct_entry.refused',
              retryable: false,
              subjects: [],
              detail: { code, action: 'create', formId: wire.formId },
              detailSchemaVersion: 1
            } }, domain: null, effectContributions: []
          });
        }
      } }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction
        || (contribution as { readonly kind?: unknown })?.kind
          !== 'submission_direct_entry_direct') {
      throw new TypeError('intake_direct_entry_contribution_invalid');
    }
    const plan = parseApplicationDirectEntryPlan(
      (contribution as { readonly plan?: unknown }).plan
    );
    this.input.repository.applyApplicationMutation(plan, this.input.projection);
    const initialized = this.input.submissionTriage.initializeWithinTransaction({
      scope: plan.submission.scope,
      submission: {
        id: plan.submission.id,
        formId: plan.submission.formId,
        formVersionId: plan.submission.formVersionId,
        source: 'direct_entry',
        submittedAt: plan.submission.submittedAt
      },
      recordedAt: plan.submission.submittedAt,
      closeEvidence: plan.closeEvidence
    });
    if (initialized.submissionId !== plan.submission.id) {
      throw new TypeError('intake_direct_entry_triage_mismatch');
    }
  }

  afterUnitOfWorkCommitted(): void { this.clearSensitive(); }
  afterUnitOfWorkFinished(): void { this.clearSensitive(); }

  private fresh(method: keyof SQLiteIntakeDirectEntryEffectIds): string {
    const value = this.input.ids[method]();
    if (this.#issuedIds.has(value)) throw new TypeError('intake_direct_entry_id_collision');
    this.#issuedIds.add(value);
    return value;
  }

  private clearSensitive(): void {
    for (const buffer of this.#pendingBuffers) buffer.fill(0);
    this.#pendingBuffers.clear();
  }
}

export function createSQLiteIntakeDirectEntryEffectDomainRegistration(
  input: ConstructorParameters<typeof SQLiteIntakeDirectEntryEffectDomainAdapter>[0]
): SQLiteEffectDomainAdapterRegistration {
  return Object.freeze({
    capability: SUBMISSION_DIRECT_ENTRY_DIRECT_HANDLER_CAPABILITY,
    adapter: new SQLiteIntakeDirectEntryEffectDomainAdapter(input)
  });
}

export type { ApplicationDirectEntryPlan };
