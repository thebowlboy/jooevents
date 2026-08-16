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
  portalEngagementRespondResultSchema,
  type EngagementMutationPlanDto,
  type PortalEventDto,
  type PortalFileDto,
  type PortalProfileDto,
  type PortalResourceDto
} from '@jooevents/contracts';
import {
  createParticipantPortalRespondPreparation,
  participantEngagementResponseDomainContributionSchema,
  PORTAL_ENGAGEMENT_RESPOND_HANDLER_CAPABILITY,
  PORTAL_ENGAGEMENT_RESPOND_OPERATION,
  PORTAL_PARTICIPANT_ACT_ACCESS_POLICY,
  sealParticipantPortalPreparation,
  type ParticipantPortalActivityRecord,
  type ParticipantPortalActivityStore,
  type ParticipantPortalPresentationSource,
  type ParticipantPortalReadSource,
  type PortalSubmissionMaterial
} from '@jooevents/engagement-operations';
import type { ParticipantLane } from '@jooevents/identity-access';
import {
  canonicalJsonText,
  parseInstant,
  parseParticipantIdentityId,
  parsePersonId,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import { SQLiteEngagementRepository } from './engagement';
import { createSQLiteParticipantRelationshipSource } from './participant-access';
import type { SQLiteIntakeRepository } from './intake';

/**
 * C0 trial DDL (ephemeral-database class): the append-only participant portal
 * activity timeline. One canonical record per participant act on a shared
 * submission; per-viewer rendering happens at read time, never in storage.
 */
export const SQLITE_PARTICIPANT_PORTAL_EFFECT_SQL = `
CREATE TABLE participant_portal_activity (
  activity_id TEXT PRIMARY KEY CHECK(
    length(activity_id) = 36 AND activity_id = lower(activity_id)
  ),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  submission_id TEXT NOT NULL CHECK(length(submission_id) = 36),
  kind TEXT NOT NULL CHECK(kind IN (
    'submitted', 'edited', 'withdrawn', 'status_communicated',
    'appeal_submitted', 'engagement_invited', 'engagement_responded', 'task_completed'
  )),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  acting_person_id TEXT CHECK(acting_person_id IS NULL OR length(acting_person_id) = 36),
  summary_for_actor TEXT NOT NULL CHECK(length(summary_for_actor) BETWEEN 1 AND 1000),
  summary_for_others TEXT NOT NULL CHECK(length(summary_for_others) BETWEEN 1 AND 1000)
) STRICT, WITHOUT ROWID;

CREATE INDEX participant_portal_activity_submission
  ON participant_portal_activity(workspace_id, event_id, submission_id, occurred_at_ms);

CREATE TRIGGER participant_portal_activity_no_update
BEFORE UPDATE ON participant_portal_activity
BEGIN SELECT RAISE(ABORT, 'participant portal activity is append-only'); END;
CREATE TRIGGER participant_portal_activity_no_delete
BEFORE DELETE ON participant_portal_activity
BEGIN SELECT RAISE(ABORT, 'participant portal activity is append-only'); END;
`;

export function installSQLiteParticipantPortalEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('participant_portal_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(SQLITE_PARTICIPANT_PORTAL_EFFECT_SQL);
}

interface ActivityRow {
  readonly activity_id: string;
  readonly submission_id: string;
  readonly kind: ParticipantPortalActivityRecord['kind'];
  readonly occurred_at_ms: number;
  readonly acting_person_id: string | null;
  readonly summary_for_actor: string;
  readonly summary_for_others: string;
}

function activityFromRow(row: ActivityRow): ParticipantPortalActivityRecord {
  return Object.freeze({
    activityId: row.activity_id,
    submissionId: row.submission_id,
    kind: row.kind,
    occurredAt: new Date(row.occurred_at_ms).toISOString(),
    acting: row.acting_person_id === null
      ? Object.freeze({ kind: 'organizers' as const })
      : Object.freeze({ kind: 'participant' as const, personId: row.acting_person_id }),
    summaryForActor: row.summary_for_actor,
    summaryForOthers: row.summary_for_others
  });
}

/** Appends inside the caller's transaction; reads run standalone. */
export function createSQLiteParticipantPortalActivityStore(
  sqlite: Database
): ParticipantPortalActivityStore & {
  list(input: {
    readonly lane: ParticipantLane;
    readonly submissionId: string;
  }): readonly ParticipantPortalActivityRecord[];
} {
  return Object.freeze({
    append({ lane, record }: {
      readonly lane: ParticipantLane;
      readonly record: ParticipantPortalActivityRecord;
    }): void {
      if (!sqlite.inTransaction) throw new TypeError('participant_portal_transaction_required');
      sqlite.query<never, [
        string, string, string, string, string, number, string | null, string, string
      ]>(`
        INSERT INTO participant_portal_activity (
          activity_id, workspace_id, event_id, submission_id, kind,
          occurred_at_ms, acting_person_id, summary_for_actor, summary_for_others
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.activityId, lane.workspaceId, lane.eventId, record.submissionId, record.kind,
        Date.parse(parseInstant(record.occurredAt)),
        record.acting.kind === 'participant' ? record.acting.personId : null,
        record.summaryForActor, record.summaryForOthers
      );
    },
    list({ lane, submissionId }: {
      readonly lane: ParticipantLane;
      readonly submissionId: string;
    }): readonly ParticipantPortalActivityRecord[] {
      const rows = sqlite.query<ActivityRow, [string, string, string]>(`
        SELECT activity_id, submission_id, kind, occurred_at_ms, acting_person_id,
               summary_for_actor, summary_for_others
          FROM participant_portal_activity
         WHERE workspace_id = ? AND event_id = ? AND submission_id = ?
         ORDER BY occurred_at_ms, activity_id
      `).all(lane.workspaceId, lane.eventId, submissionId);
      return Object.freeze(rows.map(activityFromRow));
    }
  });
}

/**
 * Presentation lookups over canonical state. Display names resolve through
 * the portal identity family first, then through the person's own submission
 * evidence into the least-disclosure triage source row — the same audited
 * association the decision-notification lane uses. Never the raw classified
 * store.
 */
export function createSQLiteParticipantPortalPresentationSource(input: {
  readonly sqlite: Database;
  readonly intake: SQLiteIntakeRepository;
}): ParticipantPortalPresentationSource {
  const triage = (lane: ParticipantLane, submissionId: string) => {
    const summary = input.intake.listSubmissions({
      workspaceId: lane.workspaceId, eventId: lane.eventId
    }).find((candidate) => candidate.id === submissionId);
    return summary;
  };
  return Object.freeze({
    readSessionTitle({ lane, sessionId }: {
      readonly lane: ParticipantLane;
      readonly sessionId: string;
    }): string | undefined {
      const row = input.sqlite.query<{ readonly title: string }, [string, string, string]>(`
        SELECT title FROM sessions WHERE workspace_id = ? AND event_id = ? AND id = ?
      `).get(lane.workspaceId, lane.eventId, sessionId);
      return row?.title;
    },
    readPersonDisplayName({ lane, personId }: {
      readonly lane: ParticipantLane;
      readonly personId: string;
    }): string | undefined {
      const identity = input.sqlite.query<{ readonly display_name: string }, [
        string, string, string
      ]>(`
        SELECT display_name FROM participant_identity_family
         WHERE workspace_id = ? AND event_id = ? AND person_id = ?
      `).get(lane.workspaceId, lane.eventId, personId);
      if (identity) return identity.display_name;
      const evidence = input.sqlite.query<{ readonly submission_id: string }, [
        string, string, string
      ]>(`
        SELECT submission_id FROM intake_submission_participant_evidence
         WHERE workspace_id = ? AND event_id = ? AND person_id = ?
         ORDER BY submission_id LIMIT 1
      `).get(lane.workspaceId, lane.eventId, personId);
      if (!evidence) return undefined;
      const summary = triage(lane, evidence.submission_id);
      return summary?.primaryParticipantName ?? undefined;
    }
  });
}

function stringifyAnswerValue(answer: {
  readonly kind: string;
  readonly value?: unknown;
  readonly choice?: { readonly label: string };
  readonly choices?: readonly { readonly label: string }[];
  readonly checked?: boolean;
}): string {
  if (answer.choice !== undefined) return answer.choice.label;
  if (answer.choices !== undefined) return answer.choices.map((choice) => choice.label).join(', ');
  if (typeof answer.checked === 'boolean') return answer.checked ? 'Yes' : 'No';
  if (answer.value === undefined || answer.value === null) return '';
  return String(answer.value);
}

/**
 * The lane-scoped portal read source over canonical SQLite state. Decision
 * state is COMMUNICATED state: with no activated outbound provider nothing
 * has ever been communicated, so submissions honestly serve their submitted
 * standing and `statusNotifiedAt: null`. Tasks and files serve empty until
 * their domains exist; the appeal act is not served.
 */
export function createSQLiteParticipantPortalReadSource(input: {
  readonly sqlite: Database;
  readonly intake: SQLiteIntakeRepository;
}): ParticipantPortalReadSource {
  const presentation = createSQLiteParticipantPortalPresentationSource(input);
  const activity = createSQLiteParticipantPortalActivityStore(input.sqlite);
  return Object.freeze({
    ...presentation,
    readPortalEvent(lane: ParticipantLane): PortalEventDto | undefined {
      const head = input.sqlite.query<{
        readonly id: string;
        readonly name: string;
        readonly timezone: string;
        readonly end_date: string;
      }, [string, string]>(`
        SELECT id, name, timezone, end_date FROM event_spine_heads
         WHERE workspace_id = ? AND id = ?
      `).get(lane.workspaceId, lane.eventId);
      if (!head) return undefined;
      const deadline = input.sqlite.query<{
        readonly effective_at_ms: number | null;
        readonly grace_policy: 'soft';
        readonly event_timezone: string | null;
      }, [string, string]>(`
        SELECT effective_at_ms, grace_policy, event_timezone FROM deadlines
         WHERE workspace_id = ? AND event_id = ? AND kind = 'cfp_close' AND status = 'active'
         ORDER BY version DESC LIMIT 1
      `).get(lane.workspaceId, lane.eventId);
      const cfpClosesAt = deadline?.effective_at_ms != null
        ? new Date(deadline.effective_at_ms).toISOString()
        // No configured CFP close: the event's end is the last honest moment
        // anything could still be submitted, served as a soft boundary.
        : new Date(`${head.end_date}T23:59:59.999Z`).toISOString();
      return Object.freeze({
        id: head.id,
        name: head.name,
        timezone: deadline?.event_timezone ?? head.timezone,
        cfpClosesAt,
        closePolicy: deadline?.grace_policy ?? ('soft' as const)
      });
    },
    readSubmissionMaterial({ lane, submissionId }: {
      readonly lane: ParticipantLane;
      readonly submissionId: string;
    }): PortalSubmissionMaterial | undefined {
      const scope = { workspaceId: lane.workspaceId, eventId: lane.eventId };
      const summary = input.intake.listSubmissions(scope)
        .find((candidate) => candidate.id === submissionId);
      if (!summary) return undefined;
      const detail = input.intake.readSubmissionDetail(scope, submissionId);
      if (!detail
          || detail.submissionId !== summary.id
          || detail.formVersionId !== summary.formVersionId
          || detail.submittedAt !== summary.submittedAt) {
        throw new TypeError('participant_portal_submission_source_corrupt');
      }
      const version = input.sqlite.query<{ readonly version_number: number }, [
        string, string, string
      ]>(`
        SELECT version_number FROM intake_form_versions
         WHERE workspace_id = ? AND event_id = ? AND form_version_id = ?
      `).get(lane.workspaceId, lane.eventId, summary.formVersionId);
      const targetSessionId = summary.target.kind === 'session'
        ? summary.target.sessionId
        : undefined;
      const targetSessionTitle = targetSessionId === undefined
        ? undefined
        : presentation.readSessionTitle({ lane, sessionId: targetSessionId });
      const target = targetSessionId !== undefined && targetSessionTitle !== undefined
        ? Object.freeze({
            kind: 'collecting_session' as const,
            sessionId: targetSessionId,
            name: targetSessionTitle
          })
        : Object.freeze({ kind: 'new_session' as const });
      return Object.freeze({
        id: submissionId,
        title: summary.title ?? 'Untitled submission',
        formVersion: version?.version_number ?? 1,
        answers: detail.answers.map((answer) => Object.freeze({
          fieldId: answer.fieldId,
          label: answer.fieldLabel,
          value: stringifyAnswerValue(answer)
        })),
        target,
        // Communicated state only: nothing is communicated while the
        // outbound provider stays inert, so the standing stays `submitted`.
        status: 'submitted' as const,
        statusNotifiedAt: null,
        submittedAt: summary.submittedAt,
        editableUntilClose: false,
        late: false,
        appeal: Object.freeze({ kind: 'unavailable' as const })
      });
    },
    listSubmissionSpeakerPersonIds({ lane, submissionId }: {
      readonly lane: ParticipantLane;
      readonly submissionId: string;
    }): readonly string[] {
      const evidence = input.sqlite.query<{ readonly person_id: string }, [
        string, string, string
      ]>(`
        SELECT person_id FROM intake_submission_participant_evidence
         WHERE workspace_id = ? AND event_id = ? AND submission_id = ?
      `).all(lane.workspaceId, lane.eventId, submissionId);
      const engaged = input.sqlite.query<{ readonly person_id: string }, [
        string, string, string
      ]>(`
        SELECT person_id FROM engagement_heads
         WHERE workspace_id = ? AND event_id = ? AND submission_id = ? AND state <> 'cancelled'
      `).all(lane.workspaceId, lane.eventId, submissionId);
      return Object.freeze([...new Set([
        ...evidence.map((row) => row.person_id),
        ...engaged.map((row) => row.person_id)
      ])].sort());
    },
    listSessionFiles(): readonly PortalFileDto[] {
      // No file domain exists in this wave; empty is the honest projection.
      return Object.freeze([]);
    },
    listEventResources(): readonly PortalResourceDto[] {
      // No resource domain exists in this wave; empty is the honest projection.
      return Object.freeze([]);
    },
    readProfile({ lane, personId }: {
      readonly lane: ParticipantLane;
      readonly personId: string;
    }): PortalProfileDto {
      const identity = input.sqlite.query<{
        readonly display_name: string;
        readonly display_email: string;
      }, [string, string, string]>(`
        SELECT display_name, display_email FROM participant_identity_family
         WHERE workspace_id = ? AND event_id = ? AND person_id = ?
      `).get(lane.workspaceId, lane.eventId, personId);
      if (!identity) return Object.freeze({ fields: [] });
      return Object.freeze({
        fields: [
          Object.freeze({
            id: 'profile.display-name',
            label: 'Name',
            value: identity.display_name,
            kind: 'text' as const,
            access: Object.freeze({
              kind: 'locked' as const,
              reason: 'organizer_managed' as const,
              changeRequested: false
            })
          }),
          Object.freeze({
            id: 'profile.email',
            label: 'Email',
            value: identity.display_email,
            kind: 'email' as const,
            access: Object.freeze({
              kind: 'locked' as const,
              reason: 'verified_identity' as const,
              changeRequested: false
            })
          })
        ]
      });
    },
    listSubmissionActivity(query: {
      readonly lane: ParticipantLane;
      readonly submissionId: string;
    }): readonly ParticipantPortalActivityRecord[] {
      return activity.list(query);
    }
  });
}

/**
 * Per-request authority view over one participant session by its id. It
 * honors the sliding, absolute, and revocation predicates WITHOUT sliding the
 * window: the transport boundary's context resolve already slid it, and an
 * in-transaction authority recheck must never extend a session.
 */
export function createSQLiteParticipantSessionAuthorityView(sqlite: Database) {
  return Object.freeze({
    readCurrentSession({ lane, participantSessionId, now }: {
      readonly lane: ParticipantLane;
      readonly participantSessionId: string;
      readonly now: string;
    }): {
      readonly participantIdentityId: ReturnType<typeof parseParticipantIdentityId>;
      readonly personId: ReturnType<typeof parsePersonId>;
    } | undefined {
      const nowMs = Date.parse(parseInstant(now));
      const row = sqlite.query<{
        readonly participant_identity_id: string;
        readonly person_id: string;
        readonly sliding_expires_at_ms: number;
        readonly absolute_expires_at_ms: number;
        readonly revoked_at_ms: number | null;
      }, [string, string, string]>(`
        SELECT participant_identity_id, person_id, sliding_expires_at_ms,
               absolute_expires_at_ms, revoked_at_ms
          FROM participant_sessions
         WHERE session_id = ? AND workspace_id = ? AND event_id = ?
      `).get(participantSessionId, lane.workspaceId, lane.eventId);
      if (!row
          || row.revoked_at_ms !== null
          || nowMs >= row.absolute_expires_at_ms
          || nowMs >= row.sliding_expires_at_ms) {
        return undefined;
      }
      return Object.freeze({
        participantIdentityId: parseParticipantIdentityId(row.participant_identity_id),
        personId: parsePersonId(row.person_id)
      });
    }
  });
}

type RespondSuccess = {
  readonly result: { readonly kind: 'success'; readonly data: unknown };
  readonly domain: NonNullable<unknown>;
  readonly effectContributions: readonly unknown[];
};

interface PreparedResponse {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly contribution: RespondSuccess;
  phase: 'prepared' | 'applied' | 'parent_linked';
  childrenSeen: number;
  receiptId?: string;
}

function sameReference(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function exactSubjects(context: EffectInvocationContext, lane: ParticipantLane): boolean {
  return context.scope.workspaceId === lane.workspaceId
    && context.scope.eventId === lane.eventId
    && context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === lane.workspaceId
    )
    && context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === lane.eventId
    );
}

/**
 * Commits one `portal.engagement.respond` v1 act inside the shared unit of
 * work: transaction-bound relationship evaluation, the any_participant_acts
 * group plan, fenced engagement-head writes, and one canonical portal
 * timeline record. Attribution derives exclusively from the authenticated
 * participant actor the in-transaction authority recheck re-proved.
 */
export class SQLiteParticipantPortalEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #prepared = new Map<string, PreparedResponse>();
  readonly #issuedIds = new Set<string>();
  #active: PreparedResponse | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly lane: ParticipantLane;
    readonly intake: SQLiteIntakeRepository;
    readonly ids: {
      newPreparationHandle(): string;
      newActivityId(): string;
    };
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    for (const method of ['newPreparationHandle', 'newActivityId'] as const) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('participant_portal_id_factory_invalid');
      }
    }
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('participant_portal_transaction_required');
    }
    if (!sameReference(capability, PORTAL_ENGAGEMENT_RESPOND_HANDLER_CAPABILITY)) {
      throw new TypeError('participant_portal_capability_mismatch');
    }
    const lane = this.input.lane;
    if (context.operation.name !== PORTAL_ENGAGEMENT_RESPOND_OPERATION.name
        || context.operation.version !== PORTAL_ENGAGEMENT_RESPOND_OPERATION.version
        || context.operation.effect !== 'commit'
        || context.surface !== 'participant_http'
        || !exactSubjects(context, lane)) {
      throw new TypeError('participant_portal_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'participant'
        || authority.principal.kind !== 'participant'
        || authority.actor.personId !== authority.principal.personId
        || authority.actor.participantIdentityId !== authority.principal.participantIdentityId
        || context.actor.kind !== 'participant'
        || context.actor.personId !== authority.actor.personId
        || authority.lane.kind !== 'participant'
        || authority.lane.surface !== 'participant_http'
        || !sameReference(authority.lane.policy, PORTAL_PARTICIPANT_ACT_ACCESS_POLICY)) {
      throw new TypeError('participant_portal_authority_mismatch');
    }
    this.clearTransient();

    const sqlite = this.input.sqlite;
    const engagements = new SQLiteEngagementRepository(sqlite);
    const preparation = createParticipantPortalRespondPreparation({
      lane,
      ports: {
        relationships: createSQLiteParticipantRelationshipSource(sqlite),
        engagements,
        writer: Object.freeze({
          applyEngagementResponsePlan: (plan: EngagementMutationPlanDto) => {
            engagements.applyEngagementPlan(plan);
          }
        }),
        activity: createSQLiteParticipantPortalActivityStore(sqlite),
        presentation: createSQLiteParticipantPortalPresentationSource({
          sqlite, intake: this.input.intake
        })
      },
      ids: {
        newPreparationHandle: () => this.nextId('newPreparationHandle'),
        newActivityId: () => this.nextId('newActivityId')
      }
    });
    return sealParticipantPortalPreparation({
      capability: PORTAL_ENGAGEMENT_RESPOND_HANDLER_CAPABILITY,
      context,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context || !sqlite.inTransaction) {
            throw new TypeError('participant_portal_context_substitution');
          }
          const contribution = preparation.prepare({ businessInput, context });
          const domain = contribution.domain as { readonly preparationHandle?: unknown } | null;
          if (domain === null) {
            this.#nonterminalReleaseContext = context;
            return contribution;
          }
          const handle = domain.preparationHandle;
          if (typeof handle !== 'string') {
            throw new TypeError('participant_portal_preparation_handle_missing');
          }
          this.#prepared.set(handle, {
            handle,
            context,
            contribution: contribution as RespondSuccess,
            phase: 'prepared',
            childrenSeen: 0
          });
          return contribution;
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('participant_portal_transaction_required');
    }
    const parsed = participantEngagementResponseDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('participant_portal_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterOperationLogInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsedResult = portalEngagementRespondResultSchema.safeParse(receipt.result);
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== PORTAL_ENGAGEMENT_RESPOND_OPERATION.name
        || receipt.ref.operationVersion !== PORTAL_ENGAGEMENT_RESPOND_OPERATION.version
        || !parsedResult.success || parsedResult.data.kind !== 'success'
        || parsedResult.data.receipt.id !== receipt.ref.id
        || canonicalJsonText(parsedResult.data.data)
          !== canonicalJsonText(active.contribution.result.data)) {
      throw new TypeError('participant_portal_receipt_mismatch');
    }
    active.receiptId = receipt.ref.id;
    active.phase = 'parent_linked';
    this.#expectedIdentity = receipt.identity;
  }

  afterEffectContributionInserted(receiptId: string, contribution: unknown): void {
    const active = this.#active;
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'parent_linked'
        || !this.#expectedIdentity || active.receiptId !== receiptId) {
      throw new TypeError('participant_portal_operation_log_missing');
    }
    const expected = active.contribution.effectContributions[active.childrenSeen];
    if (expected === undefined
        || canonicalJsonText(contribution) !== canonicalJsonText(expected)) {
      throw new TypeError('participant_portal_evidence_mismatch');
    }
    active.childrenSeen += 1;
  }

  afterEffectApplicationCommitted(identity: EffectOperationIdentity): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('participant_portal_transaction_required');
    }
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('participant_portal_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (active.phase !== 'parent_linked'
        || active.childrenSeen !== active.contribution.effectContributions.length
        || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('participant_portal_incomplete');
    }
  }

  afterUnitOfWorkCommitted(): void {
    this.clearTransient();
  }

  afterUnitOfWorkFinished(): void {
    this.clearTransient();
  }

  private clearTransient(): void {
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;
    this.#prepared.clear();
  }

  private nextId(method: 'newPreparationHandle' | 'newActivityId'): string {
    const value = this.input.ids[method]();
    if (typeof value !== 'string' || value.length === 0 || this.#issuedIds.has(value)) {
      throw new TypeError('participant_portal_ids_not_unique');
    }
    this.#issuedIds.add(value);
    return value;
  }
}

export function createSQLiteParticipantPortalEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly lane: ParticipantLane;
  readonly intake: SQLiteIntakeRepository;
  readonly ids: {
    newPreparationHandle(): string;
    newActivityId(): string;
  };
}) {
  const adapter = new SQLiteParticipantPortalEffectDomainAdapter(input);
  return Object.freeze({
    capability: PORTAL_ENGAGEMENT_RESPOND_HANDLER_CAPABILITY,
    adapter
  });
}
