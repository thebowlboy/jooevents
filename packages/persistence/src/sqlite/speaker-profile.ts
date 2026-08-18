import type { Database } from 'bun:sqlite';
import {
  speakerProfileApprovePlanSchema,
  speakerProfileUpdatePlanSchema,
  speakerProfileViewSchema,
  type SpeakerProfileApprovalDto,
  type SpeakerProfileApprovePlanDto,
  type SpeakerProfileDto,
  type SpeakerProfileFieldKey,
  type SpeakerProfileUpdatePlanDto,
  type SpeakerProfileViewDto
} from '@jooevents/contracts';
import {
  SPEAKER_PROFILE_FIELDS,
  type SpeakerProfilePlanningRepository
} from '@jooevents/engagement';
import { canonicalJsonSha256 } from '@jooevents/kernel';

interface ProfileHeadRow {
  readonly version: number;
  readonly updated_at_ms: number;
}

interface FieldRow {
  readonly field_key: SpeakerProfileFieldKey;
  readonly current_revision: number;
  readonly current_digest_sha256: string;
  readonly value_json: string;
}

interface ApprovalRow {
  readonly id: string;
  readonly field_key: SpeakerProfileFieldKey;
  readonly field_revision: number;
  readonly field_digest_sha256: string;
  readonly approved_by_user_id: string;
  readonly approved_at_ms: number;
}

interface CountRow { readonly count: number }

export type SQLiteSpeakerProfileErrorCode =
  | 'transaction_required'
  | 'data_corrupt'
  | 'stale_profile';

export class SQLiteSpeakerProfileError extends Error {
  constructor(readonly code: SQLiteSpeakerProfileErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteSpeakerProfileError';
  }
}

function instant(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function same(left: SpeakerProfileViewDto, right: SpeakerProfileViewDto): boolean {
  return canonicalJsonSha256(left) === canonicalJsonSha256(right);
}

function changedExactlyOnce(result: { readonly changes: number }): void {
  if (result.changes !== 1) throw new SQLiteSpeakerProfileError('stale_profile');
}

/** Exact Person profile and event approval persistence on the caller-owned SQLite handle. */
export class SQLiteSpeakerProfileRepository implements SpeakerProfilePlanningRepository {
  constructor(private readonly sqlite: Database) {}

  hasEventPersonRelationship(input: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly personId: string;
  }): boolean {
    const row = this.sqlite.query<CountRow, [string, string, string, string, string, string]>(`
      SELECT count(*) AS count FROM (
        SELECT person_id FROM engagement_heads
         WHERE workspace_id = ? AND event_id = ? AND person_id = ?
        UNION
        SELECT person_id FROM speaker_lineup_entries
         WHERE workspace_id = ? AND event_id = ? AND person_id = ?
      ) exact_relationship
    `).get(
      input.workspaceId, input.eventId, input.personId,
      input.workspaceId, input.eventId, input.personId
    );
    return (row?.count ?? 0) > 0;
  }

  readSpeakerProfileView(input: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly personId: string;
  }): SpeakerProfileViewDto {
    const heads = this.sqlite.query<ProfileHeadRow, [string, string]>(`
      SELECT version,updated_at_ms FROM speaker_profile_heads
       WHERE workspace_id = ? AND person_id = ? LIMIT 2
    `).all(input.workspaceId, input.personId);
    if (heads.length > 1) throw new SQLiteSpeakerProfileError('data_corrupt');
    if (heads.length === 0) {
      return speakerProfileViewSchema.parse({
        schemaVersion: 1, ...input, profile: null, approvals: []
      });
    }

    const fields = this.sqlite.query<FieldRow, [string, string]>(`
      SELECT h.field_key,h.current_revision,h.current_digest_sha256,r.value_json
        FROM speaker_profile_field_heads h
        JOIN speaker_profile_field_revisions r
          ON r.workspace_id = h.workspace_id AND r.person_id = h.person_id
         AND r.field_key = h.field_key AND r.revision = h.current_revision
         AND r.digest_sha256 = h.current_digest_sha256
       WHERE h.workspace_id = ? AND h.person_id = ?
       ORDER BY CASE h.field_key
         WHEN 'headline' THEN 0 WHEN 'biography' THEN 1
         WHEN 'location' THEN 2 WHEN 'links' THEN 3 END
    `).all(input.workspaceId, input.personId);
    if (fields.length !== SPEAKER_PROFILE_FIELDS.length) {
      throw new SQLiteSpeakerProfileError('data_corrupt');
    }
    const byKey = new Map(fields.map((field) => [field.field_key, field]));
    try {
      const field = (key: SpeakerProfileFieldKey) => {
        const row = byKey.get(key);
        if (!row) throw new SQLiteSpeakerProfileError('data_corrupt');
        return {
          revision: row.current_revision,
          digestSha256: row.current_digest_sha256,
          value: JSON.parse(row.value_json) as unknown
        };
      };
      const head = heads[0]!;
      const profile: SpeakerProfileDto = {
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        personId: input.personId,
        version: head.version,
        headline: field('headline') as SpeakerProfileDto['headline'],
        biography: field('biography') as SpeakerProfileDto['biography'],
        location: field('location') as SpeakerProfileDto['location'],
        links: field('links') as SpeakerProfileDto['links'],
        updatedAt: instant(head.updated_at_ms)
      };
      const approvals: SpeakerProfileApprovalDto[] = this.sqlite.query<ApprovalRow, [string, string, string]>(`
        SELECT a.id,a.field_key,a.field_revision,a.field_digest_sha256,
               a.approved_by_user_id,a.approved_at_ms
          FROM content_approvals a
          JOIN speaker_profile_field_heads h
            ON h.workspace_id = a.workspace_id AND h.person_id = a.person_id
           AND h.field_key = a.field_key AND h.current_revision = a.field_revision
           AND h.current_digest_sha256 = a.field_digest_sha256
         WHERE a.workspace_id = ? AND a.event_id = ? AND a.person_id = ?
         ORDER BY CASE a.field_key
           WHEN 'headline' THEN 0 WHEN 'biography' THEN 1
           WHEN 'location' THEN 2 WHEN 'links' THEN 3 END
      `).all(input.workspaceId, input.eventId, input.personId).map((row) => ({
        id: row.id,
        workspaceId: input.workspaceId,
        eventId: input.eventId,
        personId: input.personId,
        field: row.field_key,
        fieldRevision: row.field_revision,
        fieldDigestSha256: row.field_digest_sha256,
        approvedByUserId: row.approved_by_user_id,
        approvedAt: instant(row.approved_at_ms)
      }));
      return speakerProfileViewSchema.parse({
        schemaVersion: 1, ...input, profile, approvals
      });
    } catch (error) {
      if (error instanceof SQLiteSpeakerProfileError) throw error;
      throw new SQLiteSpeakerProfileError('data_corrupt', error);
    }
  }

  applySpeakerProfileUpdatePlan(planInput: SpeakerProfileUpdatePlanDto): SpeakerProfileViewDto {
    this.requireTransaction();
    const plan = speakerProfileUpdatePlanSchema.parse(planInput);
    const scope = {
      workspaceId: plan.input.scope.workspaceId,
      eventId: plan.input.scope.eventId,
      personId: plan.input.authorInput.personId
    };
    const current = this.readSpeakerProfileView(scope);
    if (!same(current, plan.before) || !plan.after.profile) {
      throw new SQLiteSpeakerProfileError('stale_profile');
    }
    const after = plan.after.profile;
    const occurredAtMs = Date.parse(plan.input.occurredAt);
    if (plan.before.profile === null) {
      this.sqlite.query<never, [string, string, number]>(`
        INSERT INTO workspace_people(workspace_id,person_id,registered_at_ms)
        VALUES (?,?,?) ON CONFLICT(workspace_id,person_id) DO NOTHING
      `).run(scope.workspaceId, scope.personId, occurredAtMs);
      changedExactlyOnce(this.sqlite.query<never, [string, string, number, number]>(`
        INSERT INTO speaker_profile_heads(workspace_id,person_id,version,updated_at_ms)
        VALUES (?,?,?,?)
      `).run(scope.workspaceId, scope.personId, after.version, occurredAtMs));
      for (const key of SPEAKER_PROFILE_FIELDS) this.insertInitialField(after, key, occurredAtMs);
    } else {
      for (const key of plan.changedFields) this.advanceField(after, key, occurredAtMs);
      changedExactlyOnce(this.sqlite.query<never, [number, number, string, string, number]>(`
        UPDATE speaker_profile_heads SET version = ?,updated_at_ms = ?
         WHERE workspace_id = ? AND person_id = ? AND version = ?
      `).run(
        after.version, occurredAtMs, scope.workspaceId, scope.personId,
        plan.before.profile.version
      ));
    }
    const saved = this.readSpeakerProfileView(scope);
    if (!same(saved, plan.after)) throw new SQLiteSpeakerProfileError('data_corrupt');
    return saved;
  }

  applySpeakerProfileApprovePlan(planInput: SpeakerProfileApprovePlanDto): SpeakerProfileViewDto {
    this.requireTransaction();
    const plan = speakerProfileApprovePlanSchema.parse(planInput);
    const scope = {
      workspaceId: plan.input.scope.workspaceId,
      eventId: plan.input.scope.eventId,
      personId: plan.input.authorInput.personId
    };
    const current = this.readSpeakerProfileView(scope);
    if (!same(current, plan.before)) throw new SQLiteSpeakerProfileError('stale_profile');
    for (const approval of plan.inserted) {
      changedExactlyOnce(this.sqlite.query<never, [
        string, string, string, string, string, number, string, string, number
      ]>(`
        INSERT INTO content_approvals(
          workspace_id,event_id,id,person_id,field_key,field_revision,
          field_digest_sha256,approved_by_user_id,approved_at_ms
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        approval.workspaceId, approval.eventId, approval.id, approval.personId,
        approval.field, approval.fieldRevision, approval.fieldDigestSha256,
        approval.approvedByUserId, Date.parse(approval.approvedAt)
      ));
    }
    const saved = this.readSpeakerProfileView(scope);
    if (!same(saved, plan.after)) throw new SQLiteSpeakerProfileError('data_corrupt');
    return saved;
  }

  private insertInitialField(
    profile: SpeakerProfileDto,
    key: SpeakerProfileFieldKey,
    occurredAtMs: number
  ): void {
    const value = profile[key];
    changedExactlyOnce(this.sqlite.query<never, [
      string, string, string, number, string, string, number
    ]>(`
      INSERT INTO speaker_profile_field_revisions(
        workspace_id,person_id,field_key,revision,value_json,digest_sha256,created_at_ms
      ) VALUES (?,?,?,?,?,?,?)
    `).run(
      profile.workspaceId, profile.personId, key, value.revision,
      JSON.stringify(value.value), value.digestSha256, occurredAtMs
    ));
    changedExactlyOnce(this.sqlite.query<never, [string, string, string, number, string]>(`
      INSERT INTO speaker_profile_field_heads(
        workspace_id,person_id,field_key,current_revision,current_digest_sha256
      ) VALUES (?,?,?,?,?)
    `).run(
      profile.workspaceId, profile.personId, key, value.revision, value.digestSha256
    ));
  }

  private advanceField(
    profile: SpeakerProfileDto,
    key: SpeakerProfileFieldKey,
    occurredAtMs: number
  ): void {
    const value = profile[key];
    changedExactlyOnce(this.sqlite.query<never, [
      string, string, string, number, string, string, number
    ]>(`
      INSERT INTO speaker_profile_field_revisions(
        workspace_id,person_id,field_key,revision,value_json,digest_sha256,created_at_ms
      ) VALUES (?,?,?,?,?,?,?)
    `).run(
      profile.workspaceId, profile.personId, key, value.revision,
      JSON.stringify(value.value), value.digestSha256, occurredAtMs
    ));
    changedExactlyOnce(this.sqlite.query<never, [
      number, string, string, string, string, number
    ]>(`
      UPDATE speaker_profile_field_heads
         SET current_revision = ?,current_digest_sha256 = ?
       WHERE workspace_id = ? AND person_id = ? AND field_key = ?
         AND current_revision = ?
    `).run(
      value.revision, value.digestSha256, profile.workspaceId, profile.personId,
      key, value.revision - 1
    ));
  }

  private requireTransaction(): void {
    if (!this.sqlite.inTransaction) throw new SQLiteSpeakerProfileError('transaction_required');
  }
}
