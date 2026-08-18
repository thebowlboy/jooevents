import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { DirectOperationFeatureContribution } from '@jooevents/application';
import {
  createCalendarProjectorState,
  materializeCalendarCommitmentFacts,
  projectCalendarCommitmentFacts,
  type CalendarCommitmentProjection,
  type CalendarProjectorState
} from '@jooevents/calendar';
import {
  calendarCommitmentFactSchema,
  calendarOperationFactBatchSchema,
  calendarScopeSchema,
  type CalendarCommitmentFact,
  type CalendarScope
} from '@jooevents/contracts/calendar';
import { canonicalJsonText } from '@jooevents/kernel';
import type { SQLiteOperationFeatureContributionAdapter } from './operation-feature-contribution-registry';

export const SQLITE_CALENDAR_COMMITMENT_FACT_CONTRIBUTOR = Object.freeze({
  key: 'feature.calendar.commitment-facts',
  version: 1
});

export const CALENDAR_CANONICAL_STATE_ADAPTER_AVAILABILITY = Object.freeze({
  sqlite: 'available' as const,
  d1: 'unavailable' as const
});

export type SQLiteCalendarCanonicalStateErrorCode =
  | 'transaction_required'
  | 'fact_conflict'
  | 'cursor_busy'
  | 'projection_poisoned'
  | 'stale_version'
  | 'not_found';

export class SQLiteCalendarCanonicalStateError extends Error {
  constructor(readonly code: SQLiteCalendarCanonicalStateErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteCalendarCanonicalStateError';
  }
}

interface FactRow {
  readonly intake_position: number;
  readonly operation_log_id: string;
  readonly ordinal: number;
  readonly workspace_id: string;
  readonly event_id: string;
  readonly occurred_at_ms: number;
  readonly payload_json: string;
  readonly canonical_fact_sha256: string;
  readonly fact_id: string;
}

interface CursorRow {
  readonly last_intake_position: number;
  readonly version: number;
  readonly state: 'ready' | 'poisoned' | 'stalled';
}

interface SourceRow {
  readonly source_kind: 'session' | 'occurrence' | 'engagement' | 'room' | 'deadline';
  readonly source_state: string;
  readonly head_json: string;
}

interface CommitmentRow {
  readonly commitment_id: string;
  readonly workspace_id: string;
  readonly event_id: string;
  readonly person_id: string;
  readonly session_id: string;
  readonly occurrence_id: string;
  readonly uid: string;
  readonly sequence: number;
  readonly last_dtstamp_ms: number;
  readonly lifecycle: CalendarCommitmentProjection['lifecycle'];
  readonly session_title: string;
  readonly session_version: number;
  readonly engagement_version: number;
  readonly occurrence_version: number;
  readonly start_at_ms: number;
  readonly end_at_ms: number;
  readonly room_id: string;
  readonly room_name: string | null;
  readonly embargoed: number;
  readonly reincarnation_generation_id: string | null;
  readonly reincarnation_intake_position: number | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function uuidFromSeed(seed: string): string {
  const digest = sha256(seed);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function milliseconds(instant: string): number {
  const value = Date.parse(instant);
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('calendar_instant_invalid');
  return value;
}

function instant(value: number): string {
  return new Date(value).toISOString();
}

function factFromRow(row: FactRow): CalendarCommitmentFact {
  return calendarCommitmentFactSchema.parse({
    schemaVersion: 1,
    source: { operationLogId: row.operation_log_id, ordinal: row.ordinal },
    scope: { workspaceId: row.workspace_id, eventId: row.event_id },
    occurredAt: instant(row.occurred_at_ms),
    fact: JSON.parse(row.payload_json)
  });
}

function contributionKey(contribution: DirectOperationFeatureContribution): string {
  return `${contribution.contributor.key}@${contribution.contributor.version}`;
}

export interface CalendarProjectionBatchResult {
  readonly processed: number;
  readonly fromIntakePosition: number;
  readonly toIntakePosition: number;
  readonly remaining: number;
}

export interface CalendarProjectionAttentionItem {
  readonly code: 'calendar_projection_poison_fact' | 'calendar_projection_stalled_cursor';
  readonly count: number;
  readonly destination: '/communications/calendar/projection-attention';
}

function isSQLiteBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { readonly code?: unknown }).code === 'SQLITE_BUSY';
}

export class SQLiteCalendarCanonicalStateRepository {
  constructor(private readonly sqlite: Database) {}

  appendFact(factInput: CalendarCommitmentFact): { readonly intakePosition: number; readonly replay: boolean } {
    if (!this.sqlite.inTransaction) throw new SQLiteCalendarCanonicalStateError('transaction_required');
    const fact = calendarCommitmentFactSchema.parse(factInput);
    const canonical = canonicalJsonText(fact);
    const digest = sha256(canonical);
    const existing = this.sqlite.query<Pick<FactRow, 'intake_position' | 'canonical_fact_sha256'>, [string, number]>(`
      SELECT intake_position,canonical_fact_sha256 FROM calendar_commitment_facts
       WHERE operation_log_id=? AND ordinal=?
    `).get(fact.source.operationLogId, fact.source.ordinal);
    if (existing) {
      if (existing.canonical_fact_sha256 !== digest) {
        throw new SQLiteCalendarCanonicalStateError('fact_conflict');
      }
      return { intakePosition: existing.intake_position, replay: true };
    }
    const factId = uuidFromSeed(`calendar-fact\0${fact.source.operationLogId}\0${fact.source.ordinal}`);
    this.sqlite.query(`
      INSERT INTO calendar_commitment_facts (
        fact_id,operation_log_id,ordinal,workspace_id,event_id,fact_kind,fact_version,
        occurred_at_ms,payload_json,canonical_fact_sha256
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      factId, fact.source.operationLogId, fact.source.ordinal,
      fact.scope.workspaceId, fact.scope.eventId, fact.fact.kind, fact.fact.version,
      milliseconds(fact.occurredAt), canonicalJsonText(fact.fact), digest
    );
    const inserted = this.sqlite.query<{ readonly intake_position: number }, [string]>(`
      SELECT intake_position FROM calendar_commitment_facts WHERE fact_id=?
    `).get(factId);
    if (!inserted) throw new SQLiteCalendarCanonicalStateError('not_found');
    return { intakePosition: inserted.intake_position, replay: false };
  }

  applyContribution(contribution: DirectOperationFeatureContribution): void {
    if (contributionKey(contribution) !== 'feature.calendar.commitment-facts@1') {
      throw new TypeError('sqlite_calendar_contributor_mismatch');
    }
    const batch = calendarOperationFactBatchSchema.parse(contribution.value);
    for (const fact of materializeCalendarCommitmentFacts({
      operationLogId: contribution.operationLogId,
      batch
    })) this.appendFact(fact);
  }

  createContributionAdapter(): SQLiteOperationFeatureContributionAdapter {
    return Object.freeze({
      apply: (contribution: DirectOperationFeatureContribution) => this.applyContribution(contribution)
    });
  }

  projectNextBatch(scopeInput: CalendarScope, limit = 100): CalendarProjectionBatchResult {
    const scope = calendarScopeSchema.parse(scopeInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError('calendar_batch_limit');
    if (this.sqlite.inTransaction) throw new SQLiteCalendarCanonicalStateError('cursor_busy');
    let poisonFactId: string | undefined;
    try {
      this.sqlite.exec('BEGIN IMMEDIATE;');
      const cursor = this.ensureCursor(scope);
      if (cursor.state !== 'ready') throw new SQLiteCalendarCanonicalStateError('projection_poisoned');
      const rows = this.sqlite.query<FactRow, [string, string, number, number]>(`
        SELECT intake_position,fact_id,operation_log_id,ordinal,workspace_id,event_id,
               occurred_at_ms,payload_json,canonical_fact_sha256
          FROM calendar_commitment_facts
         WHERE workspace_id=? AND event_id=? AND intake_position>?
         ORDER BY intake_position LIMIT ?
      `).all(scope.workspaceId, scope.eventId, cursor.last_intake_position, limit);
      if (rows.length === 0) {
        this.sqlite.exec('COMMIT;');
        return {
          processed: 0,
          fromIntakePosition: cursor.last_intake_position,
          toIntakePosition: cursor.last_intake_position,
          remaining: 0
        };
      }
      const facts = rows.map((row) => {
        poisonFactId = row.fact_id;
        const fact = factFromRow(row);
        if (sha256(canonicalJsonText(fact)) !== row.canonical_fact_sha256) {
          throw new TypeError('calendar_fact_digest_mismatch');
        }
        return fact;
      });
      const before = this.readProjectorState(scope, cursor.last_intake_position);
      const after = projectCalendarCommitmentFacts({
        state: before,
        facts,
        identities: {
          mintCommitment: ({ scope: identityScope, personId, sessionId, occurrenceId }) => {
            const id = uuidFromSeed(
              `calendar-commitment\0${identityScope.workspaceId}\0${identityScope.eventId}\0${personId}\0${sessionId}\0${occurrenceId}`
            );
            return Object.freeze({ id, uid: `urn:uuid:${id}` });
          },
          mintNoticeGeneration: (identityScope) => uuidFromSeed(
            `calendar-generation\0${identityScope.workspaceId}\0${identityScope.eventId}\0${rows.at(-1)!.intake_position}`
          )
        }
      });
      const terminal = rows.at(-1)!.intake_position;
      for (let index = 0; index < facts.length; index += 1) {
        this.persistSourceFact(facts[index]!, rows[index]!.intake_position);
      }
      this.persistSourceProjection(after, terminal);
      this.persistProjection(before, after, terminal, facts.at(-1)!.occurredAt);
      this.sqlite.query(`
        UPDATE calendar_commitment_cursors
           SET last_intake_position=?,version=version+1,state='ready',attention_code=NULL,
               attention_fact_id=NULL,updated_at_ms=?
         WHERE workspace_id=? AND event_id=? AND version=?
      `).run(terminal, milliseconds(facts.at(-1)!.occurredAt), scope.workspaceId, scope.eventId, cursor.version);
      if (this.sqlite.query<{ readonly changed: number }, []>('SELECT changes() AS changed').get()?.changed !== 1) {
        throw new SQLiteCalendarCanonicalStateError('cursor_busy');
      }
      const remaining = this.sqlite.query<{ readonly count: number }, [string, string, number]>(`
        SELECT count(*) AS count FROM calendar_commitment_facts
         WHERE workspace_id=? AND event_id=? AND intake_position>?
      `).get(scope.workspaceId, scope.eventId, terminal)?.count ?? 0;
      this.sqlite.exec('COMMIT;');
      return {
        processed: rows.length,
        fromIntakePosition: cursor.last_intake_position,
        toIntakePosition: terminal,
        remaining
      };
    } catch (error) {
      if (this.sqlite.inTransaction) this.sqlite.exec('ROLLBACK;');
      if (isSQLiteBusy(error)) {
        throw new SQLiteCalendarCanonicalStateError('cursor_busy', error);
      }
      if (error instanceof SQLiteCalendarCanonicalStateError
          && (error.code === 'projection_poisoned' || error.code === 'cursor_busy')) throw error;
      this.recordAttention(scope, 'calendar_projection_poison_fact', poisonFactId);
      throw new SQLiteCalendarCanonicalStateError('projection_poisoned', error);
    }
  }

  markCursorStalled(scopeInput: CalendarScope, occurredAt: string): void {
    const scope = calendarScopeSchema.parse(scopeInput);
    this.recordAttention(scope, 'calendar_projection_stalled_cursor', undefined, milliseconds(occurredAt));
  }

  listAttentionItems(scopeInput: CalendarScope): readonly CalendarProjectionAttentionItem[] {
    const scope = calendarScopeSchema.parse(scopeInput);
    return this.sqlite.query<{ readonly attention_code: CalendarProjectionAttentionItem['code']; readonly count: number }, [string, string]>(`
      SELECT attention_code,count(*) AS count FROM calendar_commitment_cursors
       WHERE workspace_id=? AND event_id=? AND state IN ('poisoned','stalled')
       GROUP BY attention_code ORDER BY attention_code
    `).all(scope.workspaceId, scope.eventId).map((row) => Object.freeze({
      code: row.attention_code,
      count: row.count,
      destination: '/communications/calendar/projection-attention' as const
    }));
  }

  readCommitments(scopeInput: CalendarScope, personId?: string): readonly CalendarCommitmentProjection[] {
    const scope = calendarScopeSchema.parse(scopeInput);
    const rows = personId
      ? this.sqlite.query<CommitmentRow, [string, string, string]>(`
          SELECT * FROM calendar_commitments WHERE workspace_id=? AND event_id=? AND person_id=?
           ORDER BY start_at_ms,commitment_id
        `).all(scope.workspaceId, scope.eventId, personId)
      : this.sqlite.query<CommitmentRow, [string, string]>(`
          SELECT * FROM calendar_commitments WHERE workspace_id=? AND event_id=?
           ORDER BY person_id,start_at_ms,commitment_id
        `).all(scope.workspaceId, scope.eventId);
    return Object.freeze(rows.map((row) => Object.freeze(this.projectionFromRow(row))));
  }

  setGenerationHold(generationId: string, expectedVersion: number, held: boolean): void {
    if (!this.sqlite.inTransaction) throw new SQLiteCalendarCanonicalStateError('transaction_required');
    this.sqlite.query(`
      UPDATE calendar_notice_generations SET held=?,version=version+1
       WHERE generation_id=? AND version=? AND state IN ('open','sealed')
    `).run(held ? 1 : 0, generationId, expectedVersion);
    this.assertChanged();
  }

  sealGeneration(input: {
    generationId: string; expectedVersion: number;
    reason: 'window_expired' | 'near_event_bypass' | 'manual_release'; sealedAt: string;
  }): void {
    if (!this.sqlite.inTransaction) throw new SQLiteCalendarCanonicalStateError('transaction_required');
    this.sqlite.query(`
      UPDATE calendar_notice_generations
         SET state='sealed',seal_reason=?,sealed_at_ms=?,
             sealed_intake_position=(
               SELECT last_intake_position FROM calendar_commitment_cursors cursor
                WHERE cursor.workspace_id=calendar_notice_generations.workspace_id
                  AND cursor.event_id=calendar_notice_generations.event_id
             ),version=version+1
       WHERE generation_id=? AND version=? AND state='open'
    `).run(input.reason, milliseconds(input.sealedAt), input.generationId, input.expectedVersion);
    this.assertChanged();
  }

  releaseGeneration(generationId: string, expectedVersion: number, communicationReleaseId: string): void {
    if (!this.sqlite.inTransaction) throw new SQLiteCalendarCanonicalStateError('transaction_required');
    const existing = this.sqlite.query<{
      readonly state: 'open' | 'sealed' | 'released'; readonly version: number;
      readonly communication_release_id: string | null;
    }, [string]>('SELECT state,version,communication_release_id FROM calendar_notice_generations WHERE generation_id=?')
      .get(generationId);
    if (existing?.state === 'released' && existing.communication_release_id === communicationReleaseId) return;
    this.sqlite.query(`
      UPDATE calendar_notice_generations
         SET state='released',communication_release_id=?,version=version+1
       WHERE generation_id=? AND version=? AND state='sealed'
    `).run(communicationReleaseId, generationId, expectedVersion);
    this.assertChanged();
  }

  effectivePreference(scopeInput: CalendarScope, personId: string): Readonly<{
    mode: 'invite_primary' | 'feed_primary'; deadlineOptIn: boolean; version: number;
  }> {
    const scope = calendarScopeSchema.parse(scopeInput);
    const row = this.sqlite.query<{
      readonly mode: 'invite_primary' | 'feed_primary'; readonly deadline_opt_in: number; readonly version: number;
    }, [string, string, string]>(`
      SELECT mode,deadline_opt_in,version FROM calendar_delivery_preferences
       WHERE workspace_id=? AND event_id=? AND person_id=?
    `).get(scope.workspaceId, scope.eventId, personId);
    return Object.freeze(row
      ? { mode: row.mode, deadlineOptIn: row.deadline_opt_in === 1, version: row.version }
      : { mode: 'invite_primary' as const, deadlineOptIn: false, version: 0 });
  }

  changePreference(input: {
    scope: CalendarScope; personId: string; mode: 'invite_primary' | 'feed_primary';
    deadlineOptIn: boolean; expectedVersion: number; operationLogId: string; occurredAt: string;
  }): void {
    if (!this.sqlite.inTransaction) throw new SQLiteCalendarCanonicalStateError('transaction_required');
    const scope = calendarScopeSchema.parse(input.scope);
    const current = this.effectivePreference(scope, input.personId);
    if (current.version !== input.expectedVersion) throw new SQLiteCalendarCanonicalStateError('stale_version');
    if (input.mode === 'invite_primary' && !input.deadlineOptIn) {
      if (current.version === 0) return;
      throw new TypeError('calendar_default_preference_is_absence');
    }
    this.sqlite.query(`
      INSERT INTO calendar_delivery_preferences (
        workspace_id,event_id,person_id,mode,deadline_opt_in,version,operation_log_id,changed_at_ms
      ) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(workspace_id,event_id,person_id) DO UPDATE SET
        mode=excluded.mode,deadline_opt_in=excluded.deadline_opt_in,version=excluded.version,
        operation_log_id=excluded.operation_log_id,changed_at_ms=excluded.changed_at_ms
    `).run(scope.workspaceId, scope.eventId, input.personId, input.mode,
      input.deadlineOptIn ? 1 : 0, current.version + 1, input.operationLogId, milliseconds(input.occurredAt));
  }

  issueFeed(input: {
    scope: CalendarScope; personId: string; feedId: string; lookupProfile: string;
    lookupVersion: number; lookupKeyedSha256: string; occurredAt: string;
  }): void {
    if (!this.sqlite.inTransaction) throw new SQLiteCalendarCanonicalStateError('transaction_required');
    const scope = calendarScopeSchema.parse(input.scope);
    this.sqlite.query(`
      INSERT INTO calendar_feeds (
        feed_id,workspace_id,event_id,person_id,version,state,lookup_profile,lookup_version,
        lookup_keyed_sha256,created_at_ms,rotated_at_ms,revoked_at_ms
      ) VALUES (?,?,?,?,1,'active',?,?,?, ?,NULL,NULL)
    `).run(input.feedId, scope.workspaceId, scope.eventId, input.personId, input.lookupProfile,
      input.lookupVersion, input.lookupKeyedSha256, milliseconds(input.occurredAt));
  }

  rotateFeed(input: {
    feedId: string; expectedVersion: number; lookupProfile: string; lookupVersion: number;
    lookupKeyedSha256: string; occurredAt: string;
  }): void {
    if (!this.sqlite.inTransaction) throw new SQLiteCalendarCanonicalStateError('transaction_required');
    this.sqlite.query(`
      UPDATE calendar_feeds SET version=version+1,state='active',lookup_profile=?,lookup_version=?,
        lookup_keyed_sha256=?,rotated_at_ms=?,revoked_at_ms=NULL
       WHERE feed_id=? AND version=?
    `).run(input.lookupProfile, input.lookupVersion, input.lookupKeyedSha256,
      milliseconds(input.occurredAt), input.feedId, input.expectedVersion);
    this.assertChanged();
  }

  revokeFeed(feedId: string, expectedVersion: number, occurredAt: string): void {
    if (!this.sqlite.inTransaction) throw new SQLiteCalendarCanonicalStateError('transaction_required');
    this.sqlite.query(`
      UPDATE calendar_feeds SET version=version+1,state='revoked',revoked_at_ms=?
       WHERE feed_id=? AND version=? AND state='active'
    `).run(milliseconds(occurredAt), feedId, expectedVersion);
    this.assertChanged();
  }

  lookupFeed(workspaceId: string, lookupProfile: string, lookupVersion: number, lookupKeyedSha256: string):
  Readonly<{ feedId: string; eventId: string; personId: string; version: number }> | undefined {
    const row = this.sqlite.query<{
      readonly feed_id: string; readonly event_id: string; readonly person_id: string; readonly version: number;
    }, [string, string, number, string]>(`
      SELECT feed_id,event_id,person_id,version FROM calendar_feeds
       WHERE workspace_id=? AND lookup_profile=? AND lookup_version=? AND lookup_keyed_sha256=?
         AND state='active'
    `).get(workspaceId, lookupProfile, lookupVersion, lookupKeyedSha256);
    return row ? Object.freeze({
      feedId: row.feed_id, eventId: row.event_id, personId: row.person_id, version: row.version
    }) : undefined;
  }

  private ensureCursor(scope: CalendarScope): CursorRow {
    this.sqlite.query(`
      INSERT INTO calendar_commitment_cursors (
        workspace_id,event_id,last_intake_position,version,state,attention_code,attention_fact_id,updated_at_ms
      ) VALUES (?,?,0,1,'ready',NULL,NULL,0) ON CONFLICT(workspace_id,event_id) DO NOTHING
    `).run(scope.workspaceId, scope.eventId);
    const row = this.sqlite.query<CursorRow, [string, string]>(`
      SELECT last_intake_position,version,state FROM calendar_commitment_cursors
       WHERE workspace_id=? AND event_id=?
    `).get(scope.workspaceId, scope.eventId);
    if (!row) throw new SQLiteCalendarCanonicalStateError('not_found');
    return row;
  }

  private readProjectorState(scope: CalendarScope, cursor: number): CalendarProjectorState {
    const empty = createCalendarProjectorState(scope);
    const sources = this.sqlite.query<SourceRow, [string, string]>(`
      SELECT source_kind,source_state,head_json FROM calendar_commitment_source_heads
       WHERE workspace_id=? AND event_id=? ORDER BY source_kind,source_id
    `).all(scope.workspaceId, scope.eventId);
    const parsed = sources.map((row) => ({ ...row, value: JSON.parse(row.head_json) }));
    const processedRows = this.sqlite.query<FactRow, [string, string, number]>(`
      SELECT intake_position,fact_id,operation_log_id,ordinal,workspace_id,event_id,
             occurred_at_ms,payload_json,canonical_fact_sha256
        FROM calendar_commitment_facts
       WHERE workspace_id=? AND event_id=? AND intake_position<=? ORDER BY intake_position
    `).all(scope.workspaceId, scope.eventId, cursor);
    const commitments = this.readCommitmentRows(scope).map((row) => this.projectionFromRow(row));
    const open = this.sqlite.query<{ readonly generation_id: string }, [string, string]>(`
      SELECT generation_id FROM calendar_notice_generations
       WHERE workspace_id=? AND event_id=? AND state='open' ORDER BY generation_id LIMIT 1
    `).get(scope.workspaceId, scope.eventId);
    return Object.freeze({
      ...empty,
      sessions: parsed.filter((row) => row.source_kind === 'session' && row.source_state !== 'removed')
        .map((row) => row.value),
      occurrences: parsed.filter((row) => row.source_kind === 'occurrence' && row.source_state === 'active')
        .map((row) => row.value),
      engagements: parsed.filter((row) => row.source_kind === 'engagement').map((row) => row.value),
      rooms: parsed.filter((row) => row.source_kind === 'room').map((row) => row.value),
      deadlines: parsed.filter((row) => row.source_kind === 'deadline').map((row) => row.value),
      commitments,
      processedSources: processedRows.map((row) => {
        const fact = factFromRow(row);
        return { key: `${fact.source.operationLogId}:${fact.source.ordinal}`, canonicalFact: canonicalJsonText(fact) };
      }),
      openNoticeGenerationId: open?.generation_id ?? null,
      pendingReincarnations: this.readCommitmentRows(scope)
        .filter((row) => row.reincarnation_generation_id && row.reincarnation_intake_position)
        .map((row) => ({
          personId: row.person_id, sessionId: row.session_id, occurrenceId: row.occurrence_id,
          generationId: row.reincarnation_generation_id!, intakeOrder: row.reincarnation_intake_position!
        }))
    }) as CalendarProjectorState;
  }

  private persistSourceFact(fact: CalendarCommitmentFact, intakePosition: number): void {
    let kind: SourceRow['source_kind'];
    let sourceId: string;
    let sessionId: string | null = null;
    let personId: string | null = null;
    let version = 1;
    let state = 'active';
    let value: unknown;
    if (fact.fact.kind === 'session_changed') {
      kind = 'session'; sourceId = fact.fact.data.sessionId; value = fact.fact.data.session ?? { id: sourceId, removed: true };
      sessionId = sourceId; version = fact.fact.data.session?.version ?? this.nextSourceVersion(fact.scope, kind, sourceId);
      state = fact.fact.data.session?.lifecycle ?? 'removed';
    } else if (fact.fact.kind === 'occurrence_changed') {
      kind = 'occurrence'; sourceId = fact.fact.data.occurrenceId;
      const current = this.readSourceValue(fact.scope, kind, sourceId);
      value = fact.fact.data.occurrence ?? current ?? { id: sourceId, removed: true };
      sessionId = fact.fact.data.occurrence?.sessionId ?? (current as { sessionId?: string } | undefined)?.sessionId ?? null;
      version = fact.fact.data.occurrence?.version ?? this.nextSourceVersion(fact.scope, kind, sourceId);
      state = fact.fact.data.action === 'unplace' ? 'removed' : 'active';
    } else if (fact.fact.kind === 'engagement_changed') {
      kind = 'engagement'; sourceId = fact.fact.data.engagement.id; value = fact.fact.data.engagement;
      sessionId = fact.fact.data.engagement.sessionId; personId = fact.fact.data.engagement.personId;
      version = fact.fact.data.engagement.version; state = fact.fact.data.engagement.state;
    } else if (fact.fact.kind === 'room_changed') {
      kind = 'room';
      const data = fact.fact.data;
      sourceId = data.action === 'merge' ? data.sourceRoomId : data.roomId;
      const current = this.readSourceValue(fact.scope, kind, sourceId) as Record<string, unknown> | undefined;
      value = data.action === 'create' || data.action === 'edit'
        ? { id: sourceId, name: data.name, status: 'active', version: data.version }
        : data.action === 'retire' || data.action === 'restore'
          ? { id: sourceId, name: current?.name ?? null, status: data.status, version: data.version }
          : { id: sourceId, name: null, status: 'deleted', version: this.nextSourceVersion(fact.scope, kind, sourceId) };
      version = Number((value as { version: number }).version); state = String((value as { status: string }).status);
    } else {
      kind = 'deadline'; sourceId = fact.fact.data.deadlineId; value = fact.fact.data;
      version = fact.fact.data.version; state = fact.fact.data.status;
    }
    this.sqlite.query(`
      INSERT INTO calendar_commitment_source_heads (
        workspace_id,event_id,source_kind,source_id,session_id,person_id,source_version,
        source_state,head_json,last_intake_position,provenance_profile,provenance_version
      ) VALUES (?,?,?,?,?,?,?,?,?,?,'calendar.commitment-fact',1)
      ON CONFLICT(workspace_id,event_id,source_kind,source_id) DO UPDATE SET
        session_id=excluded.session_id,person_id=excluded.person_id,source_version=excluded.source_version,
        source_state=excluded.source_state,head_json=excluded.head_json,
        last_intake_position=excluded.last_intake_position,provenance_profile=excluded.provenance_profile
    `).run(fact.scope.workspaceId, fact.scope.eventId, kind, sourceId, sessionId, personId,
      version, state, canonicalJsonText(value), intakePosition);
  }

  private persistProjection(
    before: CalendarProjectorState,
    after: CalendarProjectorState,
    intakePosition: number,
    occurredAt: string
  ): void {
    const previous = new Map(before.commitments.map((item) => [item.id, item]));
    const pending = new Map(after.pendingReincarnations.map((item) => [
      `${item.personId}\0${item.sessionId}\0${item.occurrenceId}`, item
    ]));
    for (const commitment of after.commitments) {
      const old = previous.get(commitment.id);
      if (old && canonicalJsonText(old) === canonicalJsonText(commitment)) continue;
      const reincarnation = pending.get(`${commitment.personId}\0${commitment.sessionId}\0${commitment.occurrenceId}`);
      this.sqlite.query(`
        INSERT INTO calendar_commitments (
          commitment_id,workspace_id,event_id,person_id,session_id,occurrence_id,uid,sequence,
          last_dtstamp_ms,lifecycle,embargoed,embargo_version,session_version,engagement_version,
          occurrence_version,session_title,start_at_ms,end_at_ms,room_id,room_name,
          last_projected_intake_position,provenance_profile,provenance_version,
          reincarnation_generation_id,reincarnation_intake_position
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'calendar.commitment-projector',1,?,?)
        ON CONFLICT(commitment_id) DO UPDATE SET
          person_id=excluded.person_id,session_id=excluded.session_id,occurrence_id=excluded.occurrence_id,
          sequence=excluded.sequence,last_dtstamp_ms=excluded.last_dtstamp_ms,lifecycle=excluded.lifecycle,
          embargoed=excluded.embargoed,session_version=excluded.session_version,
          engagement_version=excluded.engagement_version,occurrence_version=excluded.occurrence_version,
          session_title=excluded.session_title,start_at_ms=excluded.start_at_ms,end_at_ms=excluded.end_at_ms,
          room_id=excluded.room_id,room_name=excluded.room_name,
          last_projected_intake_position=excluded.last_projected_intake_position,
          provenance_profile=excluded.provenance_profile,reincarnation_generation_id=excluded.reincarnation_generation_id,
          reincarnation_intake_position=excluded.reincarnation_intake_position
      `).run(
        commitment.id, commitment.workspaceId, commitment.eventId, commitment.personId,
        commitment.sessionId, commitment.occurrenceId, commitment.uid, commitment.sequence,
        milliseconds(commitment.lastDtstamp), commitment.lifecycle, commitment.embargoed ? 1 : 0, 0,
        commitment.sessionVersion, commitment.engagementVersion, commitment.occurrenceVersion,
        commitment.sessionTitle, milliseconds(commitment.startAt), milliseconds(commitment.endAt),
        commitment.roomId, commitment.roomName, intakePosition,
        reincarnation?.generationId ?? null, reincarnation?.intakeOrder ?? null
      );
      const generationId = this.ensureOpenGeneration(commitment, intakePosition, occurredAt);
      this.sqlite.query(`
        INSERT INTO calendar_notice_generation_items (
          generation_id,commitment_id,before_method,before_sequence,after_method,after_sequence,net_method,artifact_sha256
        ) VALUES (?,?,?,?,?,?,?,NULL)
        ON CONFLICT(generation_id,commitment_id) DO UPDATE SET
          after_method=excluded.after_method,after_sequence=excluded.after_sequence,net_method=excluded.net_method
      `).run(
        generationId, commitment.id,
        old ? (old.lifecycle === 'cancelled' ? 'CANCEL' : 'REQUEST') : null,
        old?.sequence ?? null,
        commitment.lifecycle === 'cancelled' ? 'CANCEL' : 'REQUEST', commitment.sequence,
        commitment.lifecycle === 'cancelled' ? 'CANCEL' : 'REQUEST'
      );
    }
  }

  private persistSourceProjection(state: CalendarProjectorState, intakePosition: number): void {
    const rows: Array<{
      kind: SourceRow['source_kind']; id: string; sessionId: string | null; personId: string | null;
      version: number; sourceState: string; value: unknown;
    }> = [
      ...state.sessions.map((value) => ({
        kind: 'session' as const, id: value.id, sessionId: value.id, personId: null,
        version: value.version, sourceState: value.lifecycle, value
      })),
      ...state.occurrences.map((value) => ({
        kind: 'occurrence' as const, id: value.id, sessionId: value.sessionId, personId: null,
        version: value.version, sourceState: 'active', value
      })),
      ...state.engagements.map((value) => ({
        kind: 'engagement' as const, id: value.id, sessionId: value.sessionId, personId: value.personId,
        version: value.version, sourceState: value.state, value
      })),
      ...state.rooms.map((value) => ({
        kind: 'room' as const, id: value.id, sessionId: null, personId: null,
        version: value.version, sourceState: value.status, value
      })),
      ...state.deadlines.map((value) => ({
        kind: 'deadline' as const, id: value.deadlineId, sessionId: null, personId: null,
        version: value.version, sourceState: value.status, value
      }))
    ];
    const statement = this.sqlite.query(`
      INSERT INTO calendar_commitment_source_heads (
        workspace_id,event_id,source_kind,source_id,session_id,person_id,source_version,
        source_state,head_json,last_intake_position,provenance_profile,provenance_version
      ) VALUES (?,?,?,?,?,?,?,?,?,?,'calendar.commitment-fact',1)
      ON CONFLICT(workspace_id,event_id,source_kind,source_id) DO UPDATE SET
        session_id=excluded.session_id,person_id=excluded.person_id,source_version=excluded.source_version,
        source_state=excluded.source_state,head_json=excluded.head_json,
        last_intake_position=excluded.last_intake_position,provenance_profile=excluded.provenance_profile
    `);
    for (const row of rows) statement.run(
      state.scope.workspaceId, state.scope.eventId, row.kind, row.id, row.sessionId, row.personId,
      row.version, row.sourceState, canonicalJsonText(row.value), intakePosition
    );
  }

  private ensureOpenGeneration(commitment: CalendarCommitmentProjection, intakePosition: number, occurredAt: string): string {
    const existing = this.sqlite.query<{ readonly generation_id: string }, [string, string, string]>(`
      SELECT generation_id FROM calendar_notice_generations
       WHERE workspace_id=? AND event_id=? AND person_id=? AND state='open'
    `).get(commitment.workspaceId, commitment.eventId, commitment.personId);
    if (existing) return existing.generation_id;
    const number = (this.sqlite.query<{ readonly value: number }, [string, string, string]>(`
      SELECT coalesce(max(generation_number),0)+1 AS value FROM calendar_notice_generations
       WHERE workspace_id=? AND event_id=? AND person_id=?
    `).get(commitment.workspaceId, commitment.eventId, commitment.personId)?.value ?? 1);
    const id = uuidFromSeed(
      `calendar-generation\0${commitment.workspaceId}\0${commitment.eventId}\0${commitment.personId}\0${number}`
    );
    const opened = milliseconds(occurredAt);
    this.sqlite.query(`
      INSERT INTO calendar_notice_generations (
        generation_id,workspace_id,event_id,person_id,generation_number,state,opened_at_ms,
        opened_intake_position,seal_at_ms,held,seal_reason,sealed_at_ms,sealed_intake_position,
        communication_release_id,version
      ) VALUES (?,?,?,?,?,'open',?,?,?,0,NULL,NULL,NULL,NULL,1)
    `).run(id, commitment.workspaceId, commitment.eventId, commitment.personId, number,
      opened, intakePosition, opened + 21_600_000);
    return id;
  }

  private readCommitmentRows(scope: CalendarScope): readonly CommitmentRow[] {
    return this.sqlite.query<CommitmentRow, [string, string]>(`
      SELECT commitment_id,workspace_id,event_id,person_id,session_id,occurrence_id,uid,sequence,
             last_dtstamp_ms,lifecycle,session_title,session_version,engagement_version,occurrence_version,
             start_at_ms,end_at_ms,room_id,room_name,embargoed,reincarnation_generation_id,
             reincarnation_intake_position
        FROM calendar_commitments WHERE workspace_id=? AND event_id=?
       ORDER BY person_id,start_at_ms,commitment_id
    `).all(scope.workspaceId, scope.eventId);
  }

  private projectionFromRow(row: CommitmentRow): CalendarCommitmentProjection {
    return {
      id: row.commitment_id, workspaceId: row.workspace_id, eventId: row.event_id,
      personId: row.person_id, sessionId: row.session_id, occurrenceId: row.occurrence_id,
      uid: row.uid, sequence: row.sequence, lastDtstamp: instant(row.last_dtstamp_ms),
      lifecycle: row.lifecycle, sessionTitle: row.session_title, sessionVersion: row.session_version,
      engagementVersion: row.engagement_version, occurrenceVersion: row.occurrence_version,
      startAt: instant(row.start_at_ms), endAt: instant(row.end_at_ms), roomId: row.room_id,
      roomName: row.room_name, embargoed: row.embargoed === 1
    };
  }

  private readSourceValue(scope: CalendarScope, kind: SourceRow['source_kind'], sourceId: string): unknown {
    const row = this.sqlite.query<{ readonly head_json: string }, [string, string, string, string]>(`
      SELECT head_json FROM calendar_commitment_source_heads
       WHERE workspace_id=? AND event_id=? AND source_kind=? AND source_id=?
    `).get(scope.workspaceId, scope.eventId, kind, sourceId);
    return row ? JSON.parse(row.head_json) : undefined;
  }

  private nextSourceVersion(scope: CalendarScope, kind: SourceRow['source_kind'], sourceId: string): number {
    return (this.sqlite.query<{ readonly source_version: number }, [string, string, string, string]>(`
      SELECT source_version FROM calendar_commitment_source_heads
       WHERE workspace_id=? AND event_id=? AND source_kind=? AND source_id=?
    `).get(scope.workspaceId, scope.eventId, kind, sourceId)?.source_version ?? 0) + 1;
  }

  private recordAttention(
    scope: CalendarScope,
    code: CalendarProjectionAttentionItem['code'],
    factId?: string,
    at = 0
  ): void {
    if (this.sqlite.inTransaction) throw new SQLiteCalendarCanonicalStateError('cursor_busy');
    this.sqlite.exec('BEGIN IMMEDIATE;');
    try {
      this.sqlite.query(`
        INSERT INTO calendar_commitment_cursors (
          workspace_id,event_id,last_intake_position,version,state,attention_code,attention_fact_id,updated_at_ms
        ) VALUES (?,?,0,1,?,?,?,?)
        ON CONFLICT(workspace_id,event_id) DO UPDATE SET
          version=calendar_commitment_cursors.version+1,state=excluded.state,
          attention_code=excluded.attention_code,attention_fact_id=excluded.attention_fact_id,
          updated_at_ms=excluded.updated_at_ms
      `).run(scope.workspaceId, scope.eventId,
        code === 'calendar_projection_poison_fact' ? 'poisoned' : 'stalled', code, factId ?? null, at);
      this.sqlite.exec('COMMIT;');
    } catch (error) {
      if (this.sqlite.inTransaction) this.sqlite.exec('ROLLBACK;');
      throw error;
    }
  }

  private assertChanged(): void {
    if (this.sqlite.query<{ readonly changed: number }, []>('SELECT changes() AS changed').get()?.changed !== 1) {
      throw new SQLiteCalendarCanonicalStateError('stale_version');
    }
  }
}

export function createSQLiteCalendarCommitmentFactAdapter(
  sqlite: Database
): SQLiteOperationFeatureContributionAdapter {
  return new SQLiteCalendarCanonicalStateRepository(sqlite).createContributionAdapter();
}
