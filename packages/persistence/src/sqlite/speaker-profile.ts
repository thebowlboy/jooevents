import type { Database } from 'bun:sqlite';
import {
  speakerProfileApprovePlanSchema,
  speakerProfilePolicyApprovalCandidateSchema,
  speakerProfileReviewPolicyUpdatePlanSchema,
  speakerProfileReviewQueueSchema,
  speakerProfileUpdatePlanSchema,
  speakerProfileViewSchema,
  type SpeakerProfileApprovalDto,
  type SpeakerProfileApprovePlanDto,
  type SpeakerProfileDto,
  type SpeakerProfileFieldKey,
  type SpeakerProfilePolicyApprovalCandidateDto,
  type SpeakerProfileReviewPolicyDto,
  type SpeakerProfileReviewQueueDto,
  type SpeakerProfileReviewPolicyUpdatePlanDto,
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
  readonly actor_kind: 'user' | 'policy';
  readonly approved_by_user_id: string | null;
  readonly policy_key: 'profile_content_review' | null;
  readonly policy_version: number | null;
  readonly initiated_by_user_id: string | null;
  readonly approved_at_ms: number;
}

interface ReviewPolicyRow {
  readonly event_version: number;
  readonly profile_content_review: number;
}

interface PolicyApprovalCandidateRow {
  readonly person_id: string;
  readonly field_key: SpeakerProfileFieldKey;
  readonly current_revision: number;
  readonly current_digest_sha256: string;
}

interface ReviewQueueFieldRow {
  readonly person_id: string;
  readonly profile_version: number;
  readonly field_key: SpeakerProfileFieldKey;
  readonly is_present: number;
  readonly is_approved: number;
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

  readReviewPolicy(input: {
    readonly workspaceId: string;
    readonly eventId: string;
  }): SpeakerProfileReviewPolicyDto {
    const rows = this.sqlite.query<ReviewPolicyRow, [string, string]>(`
      SELECT event_version,profile_content_review
        FROM event_settings_companions
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY workspace_id,event_id LIMIT 2
    `).all(input.workspaceId, input.eventId);
    if (rows.length !== 1) throw new SQLiteSpeakerProfileError('data_corrupt');
    const row = rows[0]!;
    if (row.profile_content_review !== 0 && row.profile_content_review !== 1) {
      throw new SQLiteSpeakerProfileError('data_corrupt');
    }
    return {
      schemaVersion: 1,
      workspaceId: input.workspaceId,
      eventId: input.eventId,
      eventVersion: row.event_version,
      reviewRequired: row.profile_content_review === 1
    };
  }

  readPolicyApprovalCandidates(input: {
    readonly workspaceId: string;
    readonly eventId: string;
  }): readonly SpeakerProfilePolicyApprovalCandidateDto[] {
    return this.sqlite.query<PolicyApprovalCandidateRow, [
      string, string, string, string, string, string
    ]>(`
      WITH exact_event_people AS (
        SELECT person_id FROM engagement_heads WHERE workspace_id = ? AND event_id = ?
        UNION
        SELECT person_id FROM speaker_lineup_entries WHERE workspace_id = ? AND event_id = ?
      )
      SELECT h.person_id,h.field_key,h.current_revision,h.current_digest_sha256
        FROM exact_event_people p
        JOIN speaker_profile_field_heads h ON h.person_id = p.person_id
       WHERE h.workspace_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM content_approvals a
            WHERE a.workspace_id = h.workspace_id AND a.event_id = ?
              AND a.person_id = h.person_id AND a.field_key = h.field_key
              AND a.field_revision = h.current_revision
              AND a.field_digest_sha256 = h.current_digest_sha256
              AND a.actor_kind = 'policy'
         )
       ORDER BY h.person_id,CASE h.field_key
         WHEN 'headline' THEN 0 WHEN 'biography' THEN 1
         WHEN 'location' THEN 2 WHEN 'links' THEN 3 END
    `).all(
      input.workspaceId, input.eventId,
      input.workspaceId, input.eventId,
      input.workspaceId, input.eventId
    ).map((row) => speakerProfilePolicyApprovalCandidateSchema.parse({
      personId: row.person_id,
      field: row.field_key,
      fieldRevision: row.current_revision,
      fieldDigestSha256: row.current_digest_sha256
    }));
  }

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
    const reviewPolicy = this.readReviewPolicy(input);
    const heads = this.sqlite.query<ProfileHeadRow, [string, string]>(`
      SELECT version,updated_at_ms FROM speaker_profile_heads
       WHERE workspace_id = ? AND person_id = ? LIMIT 2
    `).all(input.workspaceId, input.personId);
    if (heads.length > 1) throw new SQLiteSpeakerProfileError('data_corrupt');
    if (heads.length === 0) {
      return speakerProfileViewSchema.parse({
        schemaVersion: 1, ...input, reviewPolicy, profile: null, approvals: []
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
      const approvals: SpeakerProfileApprovalDto[] = this.sqlite.query<ApprovalRow, [
        string, string, string, number
      ]>(`
        WITH ranked AS (
          SELECT a.id,a.field_key,a.field_revision,a.field_digest_sha256,
                 a.actor_kind,a.approved_by_user_id,a.policy_key,a.policy_version,
                 a.initiated_by_user_id,a.approved_at_ms,
                 row_number() OVER (
                   PARTITION BY a.field_key
                   ORDER BY CASE a.actor_kind WHEN 'user' THEN 0 ELSE 1 END,a.id
                 ) AS preference
            FROM content_approvals a
            JOIN speaker_profile_field_heads h
              ON h.workspace_id = a.workspace_id AND h.person_id = a.person_id
             AND h.field_key = a.field_key AND h.current_revision = a.field_revision
             AND h.current_digest_sha256 = a.field_digest_sha256
           WHERE a.workspace_id = ? AND a.event_id = ? AND a.person_id = ?
             AND (? = 0 OR a.actor_kind = 'user')
        )
        SELECT id,field_key,field_revision,field_digest_sha256,
               actor_kind,approved_by_user_id,policy_key,policy_version,
               initiated_by_user_id,approved_at_ms
          FROM ranked WHERE preference = 1
         ORDER BY CASE field_key
           WHEN 'headline' THEN 0 WHEN 'biography' THEN 1
           WHEN 'location' THEN 2 WHEN 'links' THEN 3 END
      `).all(
        input.workspaceId, input.eventId, input.personId,
        reviewPolicy.reviewRequired ? 1 : 0
      ).map((row) => ({
        id: row.id,
        workspaceId: input.workspaceId,
        eventId: input.eventId,
        personId: input.personId,
        field: row.field_key,
        fieldRevision: row.field_revision,
        fieldDigestSha256: row.field_digest_sha256,
        actor: row.actor_kind === 'user'
          ? { kind: 'user' as const, userId: row.approved_by_user_id! }
          : {
              kind: 'policy' as const,
              policyKey: row.policy_key!,
              policyVersion: 1 as const,
              initiatedByUserId: row.initiated_by_user_id
            },
        approvedAt: instant(row.approved_at_ms)
      }));
      return speakerProfileViewSchema.parse({
        schemaVersion: 1, ...input, reviewPolicy, profile, approvals
      });
    } catch (error) {
      if (error instanceof SQLiteSpeakerProfileError) throw error;
      throw new SQLiteSpeakerProfileError('data_corrupt', error);
    }
  }

  readReviewQueue(input: {
    readonly workspaceId: string;
    readonly eventId: string;
  }): SpeakerProfileReviewQueueDto {
    const policy = this.readReviewPolicy(input);
    if (!policy.reviewRequired) {
      return speakerProfileReviewQueueSchema.parse({ schemaVersion: 1, policy, profiles: [] });
    }
    // One compact event query, rather than one biography-bearing profile read
    // per person. It exposes only field presence and exact human-review state.
    const rows = this.sqlite.query<ReviewQueueFieldRow, [
      string, string, string, string, string, string
    ]>(`
      WITH exact_event_people AS (
        SELECT person_id FROM engagement_heads WHERE workspace_id = ? AND event_id = ?
        UNION
        SELECT person_id FROM speaker_lineup_entries WHERE workspace_id = ? AND event_id = ?
      )
      SELECT ph.person_id,ph.version AS profile_version,fh.field_key,
             CASE WHEN fh.field_key = 'links'
               THEN CASE WHEN json_array_length(fr.value_json) > 0 THEN 1 ELSE 0 END
               ELSE CASE WHEN length(json_extract(fr.value_json,'$')) > 0 THEN 1 ELSE 0 END
             END AS is_present,
             EXISTS (
               SELECT 1 FROM content_approvals a
                WHERE a.workspace_id = fh.workspace_id AND a.event_id = ?
                  AND a.person_id = fh.person_id AND a.field_key = fh.field_key
                  AND a.field_revision = fh.current_revision
                  AND a.field_digest_sha256 = fh.current_digest_sha256
                  AND a.actor_kind = 'user'
             ) AS is_approved
        FROM exact_event_people p
        JOIN speaker_profile_heads ph
          ON ph.workspace_id = ? AND ph.person_id = p.person_id
        JOIN speaker_profile_field_heads fh
          ON fh.workspace_id = ph.workspace_id AND fh.person_id = ph.person_id
        JOIN speaker_profile_field_revisions fr
          ON fr.workspace_id = fh.workspace_id AND fr.person_id = fh.person_id
         AND fr.field_key = fh.field_key AND fr.revision = fh.current_revision
         AND fr.digest_sha256 = fh.current_digest_sha256
       ORDER BY ph.person_id,CASE fh.field_key
         WHEN 'headline' THEN 0 WHEN 'biography' THEN 1
         WHEN 'location' THEN 2 WHEN 'links' THEN 3 END
    `).all(
      input.workspaceId, input.eventId,
      input.workspaceId, input.eventId,
      input.eventId, input.workspaceId
    );
    const byPerson = new Map<string, ReviewQueueFieldRow[]>();
    for (const row of rows) {
      if ((row.is_present !== 0 && row.is_present !== 1)
          || (row.is_approved !== 0 && row.is_approved !== 1)) {
        throw new SQLiteSpeakerProfileError('data_corrupt');
      }
      byPerson.set(row.person_id, [...(byPerson.get(row.person_id) ?? []), row]);
    }
    const profiles = [...byPerson.entries()].map(([personId, fields]) => {
      if (fields.length !== SPEAKER_PROFILE_FIELDS.length
          || new Set(fields.map((field) => field.field_key)).size !== SPEAKER_PROFILE_FIELDS.length) {
        throw new SQLiteSpeakerProfileError('data_corrupt');
      }
      const presentFields = fields.filter((field) => field.is_present === 1)
        .map((field) => field.field_key);
      return {
        personId,
        profileVersion: fields[0]!.profile_version,
        presentFields,
        approvedFields: fields.filter((field) => field.is_present === 1 && field.is_approved === 1)
          .map((field) => field.field_key)
      };
    });
    return speakerProfileReviewQueueSchema.parse({ schemaVersion: 1, policy, profiles });
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
    for (const approval of plan.insertedApprovals) this.insertApproval(approval);
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
    for (const approval of plan.inserted) this.insertApproval(approval);
    const saved = this.readSpeakerProfileView(scope);
    if (!same(saved, plan.after)) throw new SQLiteSpeakerProfileError('data_corrupt');
    return saved;
  }

  applyReviewPolicyUpdatePlan(
    planInput: SpeakerProfileReviewPolicyUpdatePlanDto
  ): SpeakerProfileReviewPolicyDto {
    this.requireTransaction();
    const plan = speakerProfileReviewPolicyUpdatePlanSchema.parse(planInput);
    const current = this.readReviewPolicy(plan.input.scope);
    if (canonicalJsonSha256(current) !== canonicalJsonSha256(plan.before)) {
      throw new SQLiteSpeakerProfileError('stale_profile');
    }
    this.sqlite.exec('SAVEPOINT speaker_profile_policy_apply');
    try {
      changedExactlyOnce(this.sqlite.query<never, [number, string, string, number, string]>(`
        UPDATE event_spine_heads SET version = ?
         WHERE workspace_id = ? AND id = ? AND version = ?
           AND EXISTS (
             SELECT 1 FROM event_spine_workspace_sets s
              WHERE s.workspace_id = ? AND s.current_event_id = event_spine_heads.id
           )
      `).run(
        plan.after.eventVersion,
        plan.after.workspaceId,
        plan.after.eventId,
        plan.before.eventVersion,
        plan.after.workspaceId
      ));
      changedExactlyOnce(this.sqlite.query<never, [number, number, string, string, number, number]>(`
        UPDATE event_settings_companions
           SET event_version = ?,profile_content_review = ?
         WHERE workspace_id = ? AND event_id = ? AND event_version = ?
           AND profile_content_review = ?
      `).run(
        plan.after.eventVersion,
        plan.after.reviewRequired ? 1 : 0,
        plan.after.workspaceId,
        plan.after.eventId,
        plan.before.eventVersion,
        plan.before.reviewRequired ? 1 : 0
      ));
      for (const approval of plan.insertedApprovals) this.insertApproval(approval);
      const saved = this.readReviewPolicy(plan.input.scope);
      if (canonicalJsonSha256(saved) !== canonicalJsonSha256(plan.after)) {
        throw new SQLiteSpeakerProfileError('data_corrupt');
      }
      this.sqlite.exec('RELEASE SAVEPOINT speaker_profile_policy_apply');
      return saved;
    } catch (error) {
      this.sqlite.exec('ROLLBACK TO SAVEPOINT speaker_profile_policy_apply');
      this.sqlite.exec('RELEASE SAVEPOINT speaker_profile_policy_apply');
      if (error instanceof SQLiteSpeakerProfileError) throw error;
      throw new SQLiteSpeakerProfileError('stale_profile', error);
    }
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

  private insertApproval(approval: SpeakerProfileApprovalDto): void {
    const userId = approval.actor.kind === 'user' ? approval.actor.userId : null;
    const policyKey = approval.actor.kind === 'policy' ? approval.actor.policyKey : null;
    const policyVersion = approval.actor.kind === 'policy' ? approval.actor.policyVersion : null;
    const initiatedByUserId = approval.actor.kind === 'policy'
      ? approval.actor.initiatedByUserId
      : null;
    changedExactlyOnce(this.sqlite.query<never, [
      string, string, string, string, string, number, string,
      string, string | null, string | null, number | null, string | null, number
    ]>(`
      INSERT INTO content_approvals(
        workspace_id,event_id,id,person_id,field_key,field_revision,
        field_digest_sha256,actor_kind,approved_by_user_id,policy_key,
        policy_version,initiated_by_user_id,approved_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      approval.workspaceId, approval.eventId, approval.id, approval.personId,
      approval.field, approval.fieldRevision, approval.fieldDigestSha256,
      approval.actor.kind, userId, policyKey, policyVersion, initiatedByUserId,
      Date.parse(approval.approvedAt)
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
