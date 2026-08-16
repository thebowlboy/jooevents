import { createHash } from 'node:crypto';
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
import {
  templateEditClassifyDataSchema,
  templateEditClassifyOperationResultSchema,
  templateEditRequestSchema,
  templateEditReviseOperationResultSchema
} from '@jooevents/contracts';
import { EVENT_MANAGE_ACCESS_POLICY } from '@jooevents/event-operations';
import {
  canonicalJsonText,
  parseInstant,
  parseOperationReceiptId,
  parseWorkspaceId,
  type Instant,
  type WorkspaceId
} from '@jooevents/kernel';
import { DeterministicTemplateEditService } from '@jooevents/template-authoring';
import {
  TEMPLATE_EDIT_CLASSIFY_OPERATION,
  TEMPLATE_EDIT_HANDLER_CAPABILITY,
  TEMPLATE_EDIT_REVISE_OPERATION,
  sealTemplateEditPreparation,
  templateEditContributionSchema,
  templateEditDomainContributionSchema
} from '@jooevents/template-authoring-operations';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import { SQLiteTemplateAuthoringRepository } from './template-authoring';

export const TEMPLATE_EDIT_EFFECT_SQL = `
CREATE TABLE template_edit_model_receipts (
  receipt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('classify','revise')),
  run_id TEXT NOT NULL UNIQUE CHECK(length(run_id) = 36),
  attempt_id TEXT NOT NULL UNIQUE CHECK(length(attempt_id) = 36),
  profile_key TEXT NOT NULL CHECK(length(profile_key) BETWEEN 1 AND 160),
  profile_version INTEGER NOT NULL CHECK(profile_version > 0),
  profile_digest_sha256 TEXT NOT NULL CHECK(
    length(profile_digest_sha256) = 64
    AND profile_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  scaffold_key TEXT,
  scaffold_version INTEGER,
  scaffold_digest_sha256 TEXT,
  result_digest_sha256 TEXT NOT NULL CHECK(
    length(result_digest_sha256) = 64
    AND result_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  operation_name TEXT NOT NULL CHECK(operation_name IN (
    'template.edit.classify','template.edit.revise'
  )),
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  CHECK(
    (action = 'classify' AND scaffold_key IS NULL
      AND scaffold_version IS NULL AND scaffold_digest_sha256 IS NULL)
    OR
    (action = 'revise' AND scaffold_key IS NOT NULL
      AND scaffold_version IS NOT NULL AND scaffold_version > 0
      AND length(scaffold_digest_sha256) = 64
      AND scaffold_digest_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  CHECK(json_extract(result_json, '$.artifactId') = artifact_id),
  FOREIGN KEY(receipt_id)
    REFERENCES operation_log(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id,artifact_id)
    REFERENCES template_artifact_heads(workspace_id,event_id,artifact_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER template_edit_model_receipts_no_update
BEFORE UPDATE ON template_edit_model_receipts
BEGIN SELECT RAISE(ABORT, 'template edit model receipts are immutable'); END;
CREATE TRIGGER template_edit_model_receipts_no_delete
BEFORE DELETE ON template_edit_model_receipts
BEGIN SELECT RAISE(ABORT, 'template edit model receipts are immutable'); END;
`;

export function installTemplateEditEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('template_edit_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(TEMPLATE_EDIT_EFFECT_SQL)).immediate();
}

export interface SQLiteTemplateEditEffectIds {
  newPreparationHandle(): string;
  newRunId(): string;
  newAttemptId(): string;
}

type TemplateEditContribution = ReturnType<typeof templateEditContributionSchema.parse>;
type TemplateEditSuccess = Extract<
  TemplateEditContribution,
  { readonly result: { readonly kind: 'success' } }
>;

interface PreparedEdit {
  readonly context: EffectInvocationContext;
  readonly contribution: TemplateEditSuccess;
  readonly evaluatedAt: Instant;
  phase: 'prepared' | 'applied' | 'parent_linked' | 'invocation_released';
  receiptId?: string;
}

const APPLICATION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function applicationUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !APPLICATION_UUID.test(value)) {
    throw new TypeError(`template_edit_${label}_invalid`);
  }
  return value.toLowerCase();
}

function exactCapability(value: { readonly key: string; readonly version: number }): boolean {
  return value.key === TEMPLATE_EDIT_HANDLER_CAPABILITY.key
    && value.version === TEMPLATE_EDIT_HANDLER_CAPABILITY.version;
}

function exactSubjects(context: EffectInvocationContext): boolean {
  return context.scope.eventId === undefined
    && context.scope.subjects.length === 1
    && context.scope.subjects[0]?.kind === 'workspace'
    && context.scope.subjects[0].id === context.scope.workspaceId;
}

function refusal(kind: string): TemplateEditContribution {
  return templateEditContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'conflict', kind, retryable: false,
        subjects: [], detail: null, detailSchemaVersion: 1
      }
    },
    domain: null,
    effectContributions: []
  });
}

function resultDigest(result: unknown): string {
  return createHash('sha256').update(canonicalJsonText(result)).digest('hex');
}

/** Produces and receipts an inert model-authored candidate without changing an artifact head. */
export class SQLiteTemplateEditEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #prepared = new Map<string, PreparedEdit>();
  readonly #issuedIds = new Set<string>();
  readonly #ids: SQLiteTemplateEditEffectIds;
  #active: PreparedEdit | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly service: DeterministicTemplateEditService;
    readonly ids: SQLiteTemplateEditEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    for (const method of ['newPreparationHandle', 'newRunId', 'newAttemptId'] as const) {
      if (typeof input.ids[method] !== 'function') throw new TypeError('template_edit_id_factory_invalid');
    }
    this.#ids = Object.freeze({
      newPreparationHandle: input.ids.newPreparationHandle.bind(input.ids),
      newRunId: input.ids.newRunId.bind(input.ids),
      newAttemptId: input.ids.newAttemptId.bind(input.ids)
    });
  }

  private nextId(method: keyof SQLiteTemplateEditEffectIds): string {
    const value = applicationUuid(this.#ids[method](), method);
    if (this.#issuedIds.has(value)) throw new TypeError('template_edit_ids_not_unique');
    this.#issuedIds.add(value);
    return value;
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('template_edit_transaction_required');
    const action = context.operation.name === TEMPLATE_EDIT_CLASSIFY_OPERATION.name
      && context.operation.version === TEMPLATE_EDIT_CLASSIFY_OPERATION.version
      ? 'classify'
      : context.operation.name === TEMPLATE_EDIT_REVISE_OPERATION.name
        && context.operation.version === TEMPLATE_EDIT_REVISE_OPERATION.version
        ? 'revise'
        : undefined;
    if (!exactCapability(capability) || action === undefined
        || context.operation.effect !== 'draft'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || !exactSubjects(context)) {
      throw new TypeError('template_edit_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || authority.lane.policy.key !== EVENT_MANAGE_ACCESS_POLICY.key
        || authority.lane.policy.version !== EVENT_MANAGE_ACCESS_POLICY.version
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage')) {
      throw new TypeError('template_edit_authority_mismatch');
    }

    this.#prepared.clear();
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;

    return sealTemplateEditPreparation({
      capability,
      context,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('template_edit_context_substitution');
          }
          const business = templateEditRequestSchema.parse(businessInput);
          const rows = this.input.sqlite.query<{
            readonly current_event_id: string | null;
          }, [string]>(`
            SELECT current_event_id FROM event_spine_workspace_sets
             WHERE workspace_id = ? LIMIT 2
          `).all(this.input.workspaceId);
          const eventId = rows.length === 1 ? rows[0]?.current_event_id : null;
          if (!eventId) {
            this.#nonterminalReleaseContext = context;
            return refusal('template.artifact.event_required');
          }
          const artifact = new SQLiteTemplateAuthoringRepository(this.input.sqlite)
            .readArtifact({ workspaceId: this.input.workspaceId, eventId }, business.artifactId);
          if (!artifact) {
            this.#nonterminalReleaseContext = context;
            return refusal('template.artifact.not_found');
          }
          const handle = this.nextId('newPreparationHandle');
          const runId = this.nextId('newRunId');
          const attemptId = this.nextId('newAttemptId');
          let data: unknown;
          try {
            data = action === 'classify'
              ? templateEditClassifyDataSchema.parse({
                schemaVersion: 1,
                artifactId: business.artifactId,
                classification: this.input.service.classifySynchronous(business)
              })
              : this.input.service.reviseSynchronous({
                ...business,
                baseRevisionNumber: artifact.head.currentRevisionNumber,
                document: artifact.current.document
              });
          } catch (error) {
            if (error instanceof TypeError && error.message === 'template_edit_model_choice_unknown') {
              this.#nonterminalReleaseContext = context;
              return refusal('template.edit.model_choice_unknown');
            }
            throw error;
          }
          const contribution = templateEditContributionSchema.parse({
            result: { kind: 'success', data },
            domain: {
              kind: 'template_edit_model_run', preparationHandle: handle, action,
              workspaceId: this.input.workspaceId, eventId,
              artifactId: business.artifactId, runId, attemptId,
              resultDigestSha256: resultDigest(data), occurredAt: evaluatedAt
            },
            effectContributions: []
          });
          if (contribution.result.kind !== 'success' || contribution.domain === null) {
            throw new TypeError('template_edit_success_contribution_invalid');
          }
          const prepared: PreparedEdit = {
            context, contribution: contribution as TemplateEditSuccess,
            evaluatedAt, phase: 'prepared'
          };
          this.#prepared.set(handle, prepared);
          return contribution;
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('template_edit_transaction_required');
    const parsed = templateEditDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(prepared.contribution.domain) !== canonicalJsonText(parsed)) {
      throw new TypeError('template_edit_preparation_invalid');
    }
    this.#prepared.delete(parsed.preparationHandle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterOperationLogInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || active.contribution.result.kind !== 'success') {
      throw new TypeError('template_edit_receipt_mismatch');
    }
    const operation = active.context.operation.name;
    const parsed = operation === TEMPLATE_EDIT_CLASSIFY_OPERATION.name
      ? templateEditClassifyOperationResultSchema.safeParse(receipt.result)
      : templateEditReviseOperationResultSchema.safeParse(receipt.result);
    if (!parsed.success || parsed.data.kind !== 'success'
        || parsed.data.receipt.id !== receipt.ref.id
        || parsed.data.receipt.operationName !== active.context.operation.name
        || parsed.data.receipt.operationVersion !== active.context.operation.version
        || canonicalJsonText(parsed.data.data)
          !== canonicalJsonText(active.contribution.result.data)) {
      throw new TypeError('template_edit_receipt_mismatch');
    }
    const data = active.contribution.result.data;
    const domain = active.contribution.domain;
    const classification = data.classification;
    const revise = 'scaffold' in data ? data : undefined;
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    this.input.sqlite.query(`
      INSERT INTO template_edit_model_receipts (
        receipt_id,workspace_id,event_id,artifact_id,action,run_id,attempt_id,
        profile_key,profile_version,profile_digest_sha256,
        scaffold_key,scaffold_version,scaffold_digest_sha256,
        result_digest_sha256,result_json,operation_name,operation_version,occurred_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      receiptId, domain.workspaceId, domain.eventId, domain.artifactId, domain.action,
      domain.runId, domain.attemptId,
      classification.profile.key, classification.profile.version,
      classification.profileDigestSha256,
      revise?.scaffold.key ?? null, revise?.scaffold.version ?? null,
      revise?.scaffoldDigestSha256 ?? null,
      domain.resultDigestSha256, canonicalJsonText(data),
      active.context.operation.name, active.context.operation.version,
      Date.parse(parseInstant(active.evaluatedAt))
    );
    active.receiptId = receiptId;
    active.phase = 'parent_linked';
    this.#expectedIdentity = receipt.identity;
  }

  afterEffectApplicationCommitted(identity: EffectOperationIdentity): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('template_edit_transaction_required');
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('template_edit_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (active.phase !== 'parent_linked' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('template_edit_incomplete');
    }
    active.phase = 'invocation_released';
  }

  afterUnitOfWorkCommitted(): void {
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;
    this.#prepared.clear();
  }
}

export function createSQLiteTemplateEditEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly service: DeterministicTemplateEditService;
  readonly ids: SQLiteTemplateEditEffectIds;
}): {
  readonly capability: typeof TEMPLATE_EDIT_HANDLER_CAPABILITY;
  readonly adapter: SQLiteTemplateEditEffectDomainAdapter;
} {
  return Object.freeze({
    capability: TEMPLATE_EDIT_HANDLER_CAPABILITY,
    adapter: new SQLiteTemplateEditEffectDomainAdapter(input)
  });
}
