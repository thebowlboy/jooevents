import type { Database } from 'bun:sqlite';
import {
  effectOperationIdentitiesEqual,
  effectOperationIdentityMatchesContext,
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type ClassifiedPayloadProfiles,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type EffectOperationIdentity,
  type SealedEffectAuthorityRecheckResult,
  type TerminalEffectReceipt
} from '@jooevents/application';
import { sealPublicMutationEffectCompletion } from '@jooevents/application/public-mutation-effect-completion';
import {
  adoptSynchronousClassifiedPayload,
  type SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  intakeIdSchema,
  type TransientApplicationAnswersInput
} from '@jooevents/contracts';
import {
  ApplicationAnswerError,
  ApplicationPlanningError,
  PUBLIC_INPUT_POLICY_ACTION,
  assertPublicInputPolicyEvaluator,
  applicationMutationPlanDigest,
  evaluatePublicInputPolicy,
  finalizeGovernedAnswerIndex,
  openPublicInputPolicyDecision,
  parseApplicationMutationPlan,
  planApplicationDraftBegin,
  planApplicationDraftSave,
  planApplicationSubmit,
  prepareApplicationAnswers,
  projectPublicApplicationDraftStatus,
  type ApplicationMutationPlan,
  type PublicInputPolicyEvaluator
} from '@jooevents/intake';
import {
  INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY,
  INTAKE_PUBLIC_MUTATE_OPERATION,
  INTAKE_PUBLIC_MUTATION_HANDLER_CAPABILITY,
  intakeMutationDomainContributionSchema,
  intakeMutationEvidenceChildSchema,
  intakePublicMutateInputSchema,
  intakePublicMutationContributionSchema,
  intakePublicMutationOperationResultSchema,
  sealIntakePreparation,
  type IntakeMutationEvidenceChild,
  type IntakePublicMutationResultData
} from '@jooevents/intake-operations';
import {
  canonicalJsonText,
  parseCeremonyEvidenceId,
  parseInstant,
  parseOperationReceiptId,
  parsePayloadRefId,
  parseWorkspaceId,
  type CeremonyEvidenceId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { SubmissionTriageInitializationPort } from '@jooevents/submission-triage';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import { SQLiteIntakeRepository } from './intake';
import type { SQLiteIntakeClassifiedProjection } from './intake-classified-projection';
import {
  assertIntakeParticipantAttributionSource,
  type IntakeParticipantAttributionSource
} from './intake-participant-attribution-conformance';
import {
  assertIntakePublicCeremonyDirectory,
  type IntakePublicCeremonyDirectory
} from './intake-public-ceremony';

export const SQLITE_INTAKE_PUBLIC_MUTATION_EFFECT_SQL = `
CREATE TABLE intake_public_mutation_receipt_links (
  receipt_id TEXT PRIMARY KEY,
  ceremony_evidence_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('begin', 'save', 'submit')),
  plan_digest_sha256 TEXT NOT NULL CHECK(
    length(plan_digest_sha256) = 64 AND plan_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  operation_name TEXT NOT NULL CHECK(operation_name = 'application.public.mutate'),
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  participant_attribution_evidence_json TEXT,
  CHECK(
    (action = 'submit' AND participant_attribution_evidence_json IS NOT NULL
      AND json_valid(participant_attribution_evidence_json)
      AND json_type(participant_attribution_evidence_json) = 'array'
      AND json_array_length(participant_attribution_evidence_json) BETWEEN 1 AND 16)
    OR (action IN ('begin', 'save') AND participant_attribution_evidence_json IS NULL)
  ),
  UNIQUE(ceremony_evidence_id, receipt_id),
  UNIQUE(receipt_id, workspace_id, event_id, action, plan_digest_sha256, occurred_at_ms),
  FOREIGN KEY(receipt_id) REFERENCES foundation_trial_operation_receipts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id, event_id, draft_id)
    REFERENCES intake_application_draft_heads(workspace_id, event_id, draft_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_public_mutation_facts (
  fact_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  fact_kind TEXT NOT NULL CHECK(fact_kind IN ('application_draft_changed', 'application_submitted')),
  action TEXT NOT NULL CHECK(action IN ('begin', 'save', 'submit')),
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  plan_digest_sha256 TEXT NOT NULL,
  source_plan_json TEXT NOT NULL CHECK(json_valid(source_plan_json) AND json_type(source_plan_json) = 'object'),
  occurred_at_ms INTEGER NOT NULL,
  UNIQUE(fact_id, receipt_id),
  UNIQUE(fact_id, receipt_id, workspace_id, event_id, action, occurred_at_ms),
  FOREIGN KEY(
    receipt_id, workspace_id, event_id, action, plan_digest_sha256, occurred_at_ms
  )
    REFERENCES intake_public_mutation_receipt_links(
      receipt_id, workspace_id, event_id, action, plan_digest_sha256, occurred_at_ms
    )
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_public_mutation_pointers (
  pointer_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  fact_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL CHECK(source_kind = 'domain_fact'),
  FOREIGN KEY(fact_id, receipt_id)
    REFERENCES intake_public_mutation_facts(fact_id, receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_public_mutation_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  fact_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('begin', 'save', 'submit')),
  source_kind TEXT NOT NULL CHECK(source_kind = 'domain_fact'),
  occurred_at_ms INTEGER NOT NULL,
  FOREIGN KEY(fact_id, receipt_id, workspace_id, event_id, action, occurred_at_ms)
    REFERENCES intake_public_mutation_facts(
      fact_id, receipt_id, workspace_id, event_id, action, occurred_at_ms
    )
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER intake_public_mutation_receipt_links_no_update BEFORE UPDATE
ON intake_public_mutation_receipt_links BEGIN SELECT RAISE(ABORT, 'intake receipt link immutable'); END;
CREATE TRIGGER intake_public_mutation_receipt_links_no_delete BEFORE DELETE
ON intake_public_mutation_receipt_links BEGIN SELECT RAISE(ABORT, 'intake receipt link immutable'); END;
CREATE TRIGGER intake_public_mutation_facts_no_update BEFORE UPDATE
ON intake_public_mutation_facts BEGIN SELECT RAISE(ABORT, 'intake fact immutable'); END;
CREATE TRIGGER intake_public_mutation_facts_no_delete BEFORE DELETE
ON intake_public_mutation_facts BEGIN SELECT RAISE(ABORT, 'intake fact immutable'); END;
CREATE TRIGGER intake_public_mutation_pointers_no_update BEFORE UPDATE
ON intake_public_mutation_pointers BEGIN SELECT RAISE(ABORT, 'intake pointer immutable'); END;
CREATE TRIGGER intake_public_mutation_pointers_no_delete BEFORE DELETE
ON intake_public_mutation_pointers BEGIN SELECT RAISE(ABORT, 'intake pointer immutable'); END;
CREATE TRIGGER intake_public_mutation_timeline_no_update BEFORE UPDATE
ON intake_public_mutation_timeline BEGIN SELECT RAISE(ABORT, 'intake timeline immutable'); END;
CREATE TRIGGER intake_public_mutation_timeline_no_delete BEFORE DELETE
ON intake_public_mutation_timeline BEGIN SELECT RAISE(ABORT, 'intake timeline immutable'); END;
`;

export function installSQLiteIntakePublicMutationEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('intake_public_effect_schema_inside_transaction');
  sqlite.exec(SQLITE_INTAKE_PUBLIC_MUTATION_EFFECT_SQL);
}

export interface SQLiteIntakePublicMutationEffectIds {
  newPreparationHandle(): string;
  newRevisionId(): string;
  newPayloadRefId(): string;
  newSubmissionId(): string;
  newSubmitEvidenceId(): string;
  newParticipantEvidenceId(): string;
  newConsentEvidenceId(): string;
  newFactId(): string;
  newPointerId(): string;
  newTimelineId(): string;
  newCompletionReference(): string;
}

type SuccessContribution = Extract<
  ReturnType<typeof intakePublicMutationContributionSchema.parse>,
  { readonly result: { readonly kind: 'success' } }
>;

interface PreparedMutation {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly ceremonyEvidenceId: CeremonyEvidenceId;
  readonly plan: ApplicationMutationPlan;
  readonly contribution: SuccessContribution;
  readonly completionReference: string | undefined;
  readonly participantAttributionEvidenceIds: readonly string[] | undefined;
  readonly rawBuffers: readonly Uint8Array[];
  phase: 'prepared' | 'applied' | 'parent_linked' | 'evidence_complete' | 'claim_released';
  nextChild: number;
  receipt?: TerminalEffectReceipt;
}

function sameCapability(value: { readonly key: string; readonly version: number }): boolean {
  return value.key === INTAKE_PUBLIC_MUTATION_HANDLER_CAPABILITY.key
    && value.version === INTAKE_PUBLIC_MUTATION_HANDLER_CAPABILITY.version;
}

function planningRefusal(error: unknown) {
  const stale = error instanceof ApplicationPlanningError
    && ['stale_draft', 'draft_submitted', 'draft_revision_mismatch',
      'form_version_mismatch', 'form_not_open'].includes(error.code);
  return intakePublicMutationContributionSchema.parse({
    result: { kind: 'outcome', outcome: {
      class: stale ? 'conflict' : 'policy_violation',
      kind: stale ? 'intake.changed' : 'intake.refused',
      retryable: false, subjects: [], detail: null, detailSchemaVersion: 1
    } },
    domain: null,
    receiptChildren: []
  });
}

function exactSubjects(context: EffectInvocationContext, binding: {
  readonly workspaceId: string; readonly eventId: string; readonly draftId: string;
  readonly formId: string; readonly formVersionId: string;
  readonly authorityPartitionDigestSha256: string;
}): boolean {
  const expected = [
    { kind: 'workspace', id: binding.workspaceId },
    { kind: 'event', id: binding.eventId },
    { kind: 'domain', domain: 'intake', entity: 'application_draft', id: binding.draftId },
    { kind: 'domain', domain: 'intake', entity: 'form', id: binding.formId },
    { kind: 'domain', domain: 'intake', entity: 'form_version', id: binding.formVersionId },
    { kind: 'domain', domain: 'intake', entity: 'authority_partition',
      id: binding.authorityPartitionDigestSha256 }
  ];
  const canonicalSubjects = (values: readonly unknown[]) => values
    .map((value) => canonicalJsonText(value))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const actual = canonicalSubjects(context.scope.subjects);
  const wanted = canonicalSubjects(expected);
  return actual.length === new Set(actual).size
    && canonicalJsonText(actual) === canonicalJsonText(wanted);
}

/** Transaction-local public Application begin/save/submit adapter. */
export class SQLiteIntakePublicMutationEffectDomainAdapter
implements SQLiteEffectDomainAdapter {
  readonly #ids: SQLiteIntakePublicMutationEffectIds;
  readonly #prepared = new Map<string, PreparedMutation>();
  readonly #issuedIds = new Set<string>();
  readonly #pendingBuffers = new Set<Uint8Array>();
  #active: PreparedMutation | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly repository: SQLiteIntakeRepository;
    readonly projection: SQLiteIntakeClassifiedProjection;
    readonly classifiedStore: SynchronousClassifiedPayloadStore;
    readonly classifiedProfiles: ClassifiedPayloadProfiles;
    readonly inputPolicy: PublicInputPolicyEvaluator;
    readonly ceremonies: IntakePublicCeremonyDirectory;
    readonly participantAttribution: IntakeParticipantAttributionSource;
    readonly submissionTriage: SubmissionTriageInitializationPort;
    readonly ids: SQLiteIntakePublicMutationEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    assertPublicInputPolicyEvaluator(input.inputPolicy);
    assertIntakePublicCeremonyDirectory(input.ceremonies);
    assertIntakeParticipantAttributionSource(input.participantAttribution);
    if (typeof input.submissionTriage?.initializeWithinTransaction !== 'function') {
      throw new TypeError('intake_public_submission_triage_invalid');
    }
    for (const method of Object.keys(input.ids) as (keyof SQLiteIntakePublicMutationEffectIds)[]) {
      if (typeof input.ids[method] !== 'function') throw new TypeError('intake_public_ids_invalid');
    }
    this.#ids = input.ids;
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('intake_public_transaction_required');
    if (!sameCapability(capability)
        || context.operation.name !== INTAKE_PUBLIC_MUTATE_OPERATION.name
        || context.operation.version !== INTAKE_PUBLIC_MUTATE_OPERATION.version
        || context.operation.effect !== 'commit' || context.surface !== 'public_http'
        || context.provenance.kind !== 'public_ceremony') {
      throw new TypeError('intake_public_capability_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    const ceremonyEvidenceId = parseCeremonyEvidenceId(context.provenance.ceremonyEvidenceId);
    const current = this.input.ceremonies.openForEffect(ceremonyEvidenceId);
    if (!current || current.binding.workspaceId !== this.input.workspaceId
        || context.scope.workspaceId !== current.binding.workspaceId
        || context.scope.eventId !== current.binding.eventId
        || !exactSubjects(context, current.binding)
        || authority.actor.kind !== 'public_request'
        || authority.principal.kind !== 'public_capability'
        || authority.actor.authority.kind !== 'mutation_ceremony'
        || authority.principal.authority.kind !== 'mutation_ceremony'
        || authority.actor.authority.ceremonyEvidenceId !== ceremonyEvidenceId
        || authority.principal.authority.ceremonyEvidenceId !== ceremonyEvidenceId
        || authority.lane.kind !== 'public_ceremony'
        || authority.lane.surface !== 'public_http'
        || authority.lane.policy.key !== INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY.key
        || authority.lane.policy.version !== INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY.version
        || !authority.grants.some((grant) =>
          grant.kind === 'public_policy' && grant.key === INTAKE_PUBLIC_MUTATE_OPERATION.name
        )) throw new TypeError('intake_public_authority_mismatch');

    this.#clearTransient();
    return sealIntakePreparation({ capability, context, preparation: {
      prepare: ({ businessInput, context: received }) => {
        if (received !== context || !this.input.sqlite.inTransaction) {
          throw new TypeError('intake_public_context_substitution');
        }
        const rawBuffers: Uint8Array[] = [];
        this.input.sqlite.exec('SAVEPOINT intake_public_prepare');
        try {
          const parsed = intakePublicMutateInputSchema.parse(businessInput);
          const scope = { workspaceId: current.binding.workspaceId, eventId: current.binding.eventId };
          const formHead = this.input.repository.readFormHead(scope, current.binding.formId);
          const formVersion = this.input.repository.readFormVersion(
            scope, current.binding.formVersionId
          );
          if (!formHead || !formVersion) throw new ApplicationPlanningError('form_not_open');
          const requestDigestSha256 = context.requestBinding.requestHashSha256;
          const policyAction = parsed.action === 'begin'
            ? PUBLIC_INPUT_POLICY_ACTION.draftBegin
            : parsed.action === 'save'
              ? PUBLIC_INPUT_POLICY_ACTION.draftSave
              : PUBLIC_INPUT_POLICY_ACTION.submit;
          const policyContext = { scope, action: policyAction, requestDigestSha256, evaluatedAt };
          const inputPolicy = evaluatePublicInputPolicy(this.input.inputPolicy, policyContext);
          if (openPublicInputPolicyDecision(inputPolicy, policyContext).disposition !== 'allow') {
            throw new ApplicationPlanningError('input_policy_refused');
          }
          let plan: ApplicationMutationPlan;
          let participantAttributionEvidenceIds: readonly string[] | undefined;
          if (parsed.action === 'begin') {
            if (parsed.input.formId !== current.binding.formId
                || this.input.repository.readDraft(scope, current.binding.draftId)) {
              throw new ApplicationPlanningError('stale_draft');
            }
            plan = planApplicationDraftBegin({
              formHead, formVersion, requestDigestSha256,
              collection: this.input.repository,
              inputPolicy,
              server: {
                draftId: current.binding.draftId,
                revisionId: this.#freshId(this.#ids.newRevisionId, 'revision'),
                authorityPartitionDigestSha256:
                  current.binding.authorityPartitionDigestSha256,
                createdAt: evaluatedAt
              }
            });
          } else {
            const draft = this.input.repository.readDraft(scope, current.binding.draftId);
            if (!draft || draft.head.formId !== current.binding.formId
                || draft.head.formVersionId !== current.binding.formVersionId
                || draft.head.authorityPartitionDigestSha256
                  !== current.binding.authorityPartitionDigestSha256) {
              throw new ApplicationPlanningError('stale_draft');
            }
            if (parsed.action === 'save') {
              const revisionId = this.#freshId(this.#ids.newRevisionId, 'revision');
              const answers = this.#adoptAnswers({
                answers: parsed.input.answers,
                formVersion,
                mode: 'draft',
                owner: {
                  draftId: draft.head.id,
                  revisionId,
                  authorityPartitionDigestSha256:
                    current.binding.authorityPartitionDigestSha256
                },
                createdAt: evaluatedAt,
                rawBuffers
              });
              plan = planApplicationDraftSave({
                formHead, formVersion, draftHead: draft.head,
                collection: this.input.repository,
                currentRevision: draft.revision,
                expectedDraftVersion: parsed.input.expectedDraftVersion,
                expectedAuthorityPartitionDigestSha256:
                  current.binding.authorityPartitionDigestSha256,
                requestDigestSha256,
                inputPolicy,
                answers,
                server: { revisionId, savedAt: evaluatedAt }
              });
            } else {
              const attribution = this.input.participantAttribution.resolve({
                ceremonyEvidenceId,
                authorityPartitionDigestSha256:
                  current.binding.authorityPartitionDigestSha256
              });
              if (!attribution) throw new ApplicationPlanningError('invalid_submission_identity');
              participantAttributionEvidenceIds = attribution.evidenceIds;
              const consentFields = formVersion.definition.fields
                .filter((field) => field.purpose.kind === 'consent')
                .map((field) => ({
                  fieldId: field.id,
                  evidenceId: this.#freshId(this.#ids.newConsentEvidenceId, 'consent_evidence')
                }));
              plan = planApplicationSubmit({
                formHead, formVersion, draftHead: draft.head,
                collection: this.input.repository,
                currentRevision: draft.revision,
                expectedDraftVersion: parsed.input.expectedDraftVersion,
                expectedAuthorityPartitionDigestSha256:
                  current.binding.authorityPartitionDigestSha256,
                requestDigestSha256,
                inputPolicy,
                identities: {
                  submissionId: this.#freshId(this.#ids.newSubmissionId, 'submission'),
                  submitEvidenceId: this.#freshId(
                    this.#ids.newSubmitEvidenceId, 'submit_evidence'
                  ),
                  personId: attribution.personId,
                  participantIdentityId: attribution.participantIdentityId,
                  participantEvidenceId: this.#freshId(
                    this.#ids.newParticipantEvidenceId, 'participant_evidence'
                  ),
                  consentEvidenceIds: consentFields
                },
                server: { submittedAt: evaluatedAt }
              });
            }
          }
          plan = parseApplicationMutationPlan(plan);
          const handle = this.#freshId(this.#ids.newPreparationHandle, 'preparation');
          const factId = this.#freshId(this.#ids.newFactId, 'fact');
          const pointerId = this.#freshId(this.#ids.newPointerId, 'pointer');
          const timelineId = this.#freshId(this.#ids.newTimelineId, 'timeline');
          const planDigestSha256 = applicationMutationPlanDigest(plan);
          const result: IntakePublicMutationResultData = plan.action === 'submit'
            ? { action: 'submit', submission: plan.result }
            : { action: plan.action, draft: projectPublicApplicationDraftStatus(
                plan.action === 'begin' ? plan.head : plan.afterHead,
                plan.action === 'begin' ? plan.revision : plan.afterRevision
              ) };
          const candidate = intakePublicMutationContributionSchema.parse({
            result: { kind: 'success', data: result },
            domain: {
              kind: 'intake_public_mutation', preparationHandle: handle,
              action: plan.action, workspaceId: scope.workspaceId, eventId: scope.eventId,
              planDigestSha256, occurredAt: evaluatedAt
            },
            receiptChildren: [{
              kind: 'domain_fact', factId,
              factKind: plan.action === 'submit'
                ? 'application_submitted' : 'application_draft_changed',
              action: plan.action, workspaceId: scope.workspaceId, eventId: scope.eventId,
              planDigestSha256, sourcePlan: plan, occurredAt: evaluatedAt
            }, {
              kind: 'outbox_pointer', pointerId, sourceKind: 'domain_fact', factId
            }, {
              kind: 'timeline', timelineId, sourceKind: 'domain_fact', factId,
              workspaceId: scope.workspaceId, eventId: scope.eventId,
              action: plan.action, occurredAt: evaluatedAt
            }]
          });
          if (candidate.result.kind !== 'success' || candidate.domain === null) {
            throw new TypeError('intake_public_contribution_invalid');
          }
          const completionReference = plan.action === 'submit'
            ? this.#completionReference(this.#ids.newCompletionReference())
            : undefined;
          const prepared: PreparedMutation = {
            handle, context, ceremonyEvidenceId, plan,
            contribution: candidate as SuccessContribution,
            completionReference,
            participantAttributionEvidenceIds,
            rawBuffers: Object.freeze(rawBuffers),
            phase: 'prepared', nextChild: 0
          };
          this.#prepared.set(handle, prepared);
          this.input.sqlite.exec('RELEASE SAVEPOINT intake_public_prepare');
          return candidate;
        } catch (error) {
          this.input.sqlite.exec('ROLLBACK TO SAVEPOINT intake_public_prepare');
          this.input.sqlite.exec('RELEASE SAVEPOINT intake_public_prepare');
          rawBuffers.forEach((buffer) => buffer.fill(0));
          if (error instanceof ApplicationPlanningError
              || error instanceof ApplicationAnswerError) {
            this.#nonterminalContext = context;
            return planningRefusal(error);
          }
          throw error;
        }
      }
    } });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('intake_public_transaction_required');
    const parsed = intakeMutationDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)
        || parsed.planDigestSha256 !== applicationMutationPlanDigest(prepared.plan)) {
      throw new TypeError('intake_public_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    this.input.repository.applyApplicationMutation(prepared.plan, this.input.projection);
    if (prepared.plan.action === 'submit') {
      const initialized = this.input.submissionTriage.initializeWithinTransaction({
        scope: prepared.plan.submission.scope,
        submission: {
          id: prepared.plan.submission.id,
          formId: prepared.plan.submission.formId,
          formVersionId: prepared.plan.submission.formVersionId,
          source: 'public_form',
          submittedAt: prepared.plan.submission.submittedAt
        },
        recordedAt: prepared.plan.submission.submittedAt,
        closeEvidence: null
      });
      if (initialized.submissionId !== prepared.plan.submission.id) {
        throw new TypeError('intake_public_submission_triage_mismatch');
      }
    }
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsed = intakePublicMutationOperationResultSchema.safeParse(receipt.result);
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== INTAKE_PUBLIC_MUTATE_OPERATION.name
        || receipt.ref.operationVersion !== INTAKE_PUBLIC_MUTATE_OPERATION.version
        || !parsed.success || parsed.data.kind !== 'success'
        || parsed.data.receipt.id !== receipt.ref.id
        || canonicalJsonText(parsed.data.data)
          !== canonicalJsonText(active.contribution.result.data)) {
      throw new TypeError('intake_public_receipt_mismatch');
    }
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    const binding = this.input.ceremonies.resolveCurrent(active.ceremonyEvidenceId);
    if (!binding || binding.draftId !== (active.plan.action === 'begin'
      ? active.plan.head.id : active.plan.beforeHead.id)) {
      throw new TypeError('intake_public_ceremony_stale');
    }
    this.input.sqlite.query(`
      INSERT INTO intake_public_mutation_receipt_links (
        receipt_id, ceremony_evidence_id, workspace_id, event_id, draft_id,
        action, plan_digest_sha256, operation_name, operation_version, occurred_at_ms
        , participant_attribution_evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId, active.ceremonyEvidenceId, binding.workspaceId, binding.eventId,
      binding.draftId, active.plan.action, applicationMutationPlanDigest(active.plan),
      INTAKE_PUBLIC_MUTATE_OPERATION.name, INTAKE_PUBLIC_MUTATE_OPERATION.version,
      Date.parse(active.contribution.domain.occurredAt),
      active.participantAttributionEvidenceIds === undefined
        ? null : canonicalJsonText(active.participantAttributionEvidenceIds)
    );
    active.receipt = receipt;
    active.phase = 'parent_linked';
    this.#expectedIdentity = receipt.identity;
  }

  afterReceiptChildInserted(receiptId: string, contribution: unknown): void {
    const active = this.#active;
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'parent_linked'
        || !active.receipt || receiptId !== active.receipt.ref.id) {
      throw new TypeError('intake_public_receipt_parent_missing');
    }
    const child = intakeMutationEvidenceChildSchema.parse(contribution);
    const expected = active.contribution.receiptChildren[active.nextChild];
    if (!expected || canonicalJsonText(child) !== canonicalJsonText(expected)) {
      throw new TypeError('intake_public_evidence_order_mismatch');
    }
    this.#insertChild(receiptId, child);
    active.nextChild += 1;
    if (active.nextChild === active.contribution.receiptChildren.length) {
      if (active.plan.action === 'submit') this.#complete(active);
      active.phase = 'evidence_complete';
    }
  }

  afterExecutionClaimReleased(identity: EffectOperationIdentity): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('intake_public_transaction_required');
    const active = this.#active;
    if (!active) {
      if (!this.#nonterminalContext
          || !effectOperationIdentityMatchesContext(identity, this.#nonterminalContext)) {
        throw new TypeError('intake_public_incomplete');
      }
      this.#nonterminalContext = undefined;
      return;
    }
    if (active.phase !== 'evidence_complete' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('intake_public_incomplete');
    }
    active.phase = 'claim_released';
  }

  afterUnitOfWorkFinished(): void { this.#clearTransient(); }

  #adoptAnswers(input: {
    readonly answers: TransientApplicationAnswersInput;
    readonly formVersion: Parameters<typeof prepareApplicationAnswers>[0]['formVersion'];
    readonly mode: 'draft' | 'submit';
    readonly owner: Parameters<typeof prepareApplicationAnswers>[0]['owner'];
    readonly createdAt: string;
    readonly rawBuffers: Uint8Array[];
  }) {
    const prepared = prepareApplicationAnswers({
      answers: input.answers,
      formVersion: input.formVersion,
      optionSource: this.input.repository,
      mode: input.mode,
      owner: input.owner
    });
    const adoptions = prepared.payloads.map((payload) => {
      input.rawBuffers.push(payload.bytes);
      this.#pendingBuffers.add(payload.bytes);
      return adoptSynchronousClassifiedPayload({
        store: this.input.classifiedStore,
        put: {
          payloadRefId: parsePayloadRefId(this.#freshId(this.#ids.newPayloadRefId, 'payload')),
          binding: {
            profiles: this.input.classifiedProfiles,
            scopeBinding: payload.binding.scopeBinding,
            contentType: payload.binding.contentType
          },
          purpose: payload.binding.profileKey,
          bytes: payload.bytes,
          createdAt: parseInstant(input.createdAt)
        }
      });
    });
    return finalizeGovernedAnswerIndex({
      prepared,
      adoptions,
      expectedStore: this.input.classifiedStore,
      expectedProfiles: this.input.classifiedProfiles
    });
  }

  #complete(active: PreparedMutation): void {
    if (!active.receipt || !active.completionReference) {
      throw new TypeError('intake_public_completion_missing');
    }
    const ceremony = this.input.ceremonies.openForEffect(active.ceremonyEvidenceId);
    if (!ceremony) throw new TypeError('intake_public_ceremony_stale');
    const result = ceremony.completion.complete(sealPublicMutationEffectCompletion({
      evidence: ceremony.evidence,
      sealReader: ceremony.boundary.sealReader,
      context: active.context,
      receipt: active.receipt,
      completionReference: active.completionReference
    }));
    if (result.kind !== 'terminal' || result.replay
        || result.receipt.ref.id !== active.receipt.ref.id
        || canonicalJsonText(result.receipt.result) !== canonicalJsonText(active.receipt.result)) {
      throw new TypeError('intake_public_completion_refused');
    }
  }

  #insertChild(receiptId: string, child: IntakeMutationEvidenceChild): void {
    if (child.kind === 'domain_fact') {
      this.input.sqlite.query(`
        INSERT INTO intake_public_mutation_facts (
          fact_id, receipt_id, fact_kind, action, workspace_id, event_id,
          plan_digest_sha256, source_plan_json, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(child.factId, receiptId, child.factKind, child.action, child.workspaceId,
        child.eventId, child.planDigestSha256, canonicalJsonText(child.sourcePlan),
        Date.parse(child.occurredAt));
    } else if (child.kind === 'outbox_pointer') {
      this.input.sqlite.query(`
        INSERT INTO intake_public_mutation_pointers (
          pointer_id, receipt_id, fact_id, source_kind
        ) VALUES (?, ?, ?, ?)
      `).run(child.pointerId, receiptId, child.factId, child.sourceKind);
    } else {
      this.input.sqlite.query(`
        INSERT INTO intake_public_mutation_timeline (
          timeline_id, receipt_id, fact_id, workspace_id, event_id,
          action, source_kind, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(child.timelineId, receiptId, child.factId, child.workspaceId,
        child.eventId, child.action, child.sourceKind, Date.parse(child.occurredAt));
    }
  }

  #freshId(factory: () => string, label: string): string {
    const value = intakeIdSchema.parse(factory());
    if (this.#issuedIds.has(value)) throw new TypeError(`intake_public_${label}_collision`);
    this.#issuedIds.add(value);
    return value;
  }

  #completionReference(value: string): string {
    if (!/^pcr_[A-Za-z0-9_-]{24,240}$/.test(value)) {
      throw new TypeError('intake_public_completion_reference_invalid');
    }
    return value;
  }

  #clearTransient(): void {
    for (const buffer of this.#pendingBuffers) buffer.fill(0);
    this.#pendingBuffers.clear();
    this.#prepared.clear();
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalContext = undefined;
  }
}

export function createSQLiteIntakePublicMutationEffectDomainRegistration(input:
  ConstructorParameters<typeof SQLiteIntakePublicMutationEffectDomainAdapter>[0]
): {
  readonly capability: typeof INTAKE_PUBLIC_MUTATION_HANDLER_CAPABILITY;
  readonly adapter: SQLiteIntakePublicMutationEffectDomainAdapter;
} {
  return Object.freeze({
    capability: INTAKE_PUBLIC_MUTATION_HANDLER_CAPABILITY,
    adapter: new SQLiteIntakePublicMutationEffectDomainAdapter(input)
  });
}
