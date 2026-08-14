import type { Database } from 'bun:sqlite';
import {
  normalizeEmail,
  slideParticipantSessionWindow,
  type IntakeAttributedParticipant,
  type IntakeAttributedParticipantSource,
  type ParticipantAccessPolicy,
  type ParticipantChallengeClaim,
  type ParticipantChallengeStore,
  type ParticipantIdentityDirectory,
  type ParticipantIdentityRecord,
  type ParticipantLane,
  type ParticipantRelationship,
  type ParticipantRelationshipSource,
  type ParticipantSessionRecord,
  type ParticipantSessionResolution,
  type ParticipantSessionStore
} from '@jooevents/identity-access';
import {
  parseEventId,
  parseInstant,
  parseParticipantIdentityId,
  parseParticipantSessionId,
  parsePersonId,
  parseWorkspaceId
} from '@jooevents/kernel';

/**
 * C0 trial persistence for participant email-proof access (fresh/disposable
 * schema; retained migrations are coordinated separately). Three records:
 *
 * - `participant_identity_family` — the portal lane's members of the one
 *   person + participant-identity family the intake attribution ceremony
 *   already resolves. Pairs are immutable, role-collision-guarded exactly like
 *   `intake_participant_attribution_conformance`, and unique per lane+address;
 *   only standing (and the person's display name) may change later.
 * - `participant_sign_in_challenges` — hash-only magic-link challenges with
 *   single-use claim and newest-wins supersession per address+lane. No raw
 *   token ever reaches this table.
 * - `participant_sessions` — the server-side session store keyed by the
 *   reserved `ParticipantSessionId`, resolved by one-way cookie-token hash,
 *   with sliding/absolute expiry. Lane-separate from every operator record.
 */
export const SQLITE_PARTICIPANT_ACCESS_SQL = `
CREATE TABLE participant_identity_family (
  participant_identity_id TEXT PRIMARY KEY CHECK(
    length(participant_identity_id) = 36 AND participant_identity_id = lower(participant_identity_id)
  ),
  person_id TEXT NOT NULL UNIQUE CHECK(length(person_id) = 36 AND person_id = lower(person_id)),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  normalized_email TEXT NOT NULL CHECK(length(normalized_email) BETWEEN 3 AND 320),
  display_email TEXT NOT NULL CHECK(length(display_email) BETWEEN 3 AND 320),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
  standing TEXT NOT NULL CHECK(standing IN ('active', 'revoked')),
  origin TEXT NOT NULL CHECK(origin IN ('portal_ceremony', 'adopted_attribution')),
  minted_at_ms INTEGER NOT NULL CHECK(minted_at_ms BETWEEN 0 AND 8640000000000000),
  revoked_at_ms INTEGER CHECK(revoked_at_ms IS NULL OR revoked_at_ms >= minted_at_ms),
  UNIQUE(workspace_id, event_id, normalized_email),
  CHECK((standing = 'revoked') = (revoked_at_ms IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE TRIGGER participant_identity_family_role_collision
BEFORE INSERT ON participant_identity_family
WHEN NEW.person_id = NEW.participant_identity_id
  OR EXISTS (
    SELECT 1 FROM participant_identity_family
     WHERE person_id = NEW.participant_identity_id
        OR participant_identity_id = NEW.person_id
  )
BEGIN SELECT RAISE(ABORT, 'participant identity role collision'); END;

CREATE TRIGGER participant_identity_family_pair_immutable
BEFORE UPDATE ON participant_identity_family
WHEN NEW.participant_identity_id IS NOT OLD.participant_identity_id
  OR NEW.person_id IS NOT OLD.person_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.event_id IS NOT OLD.event_id
  OR NEW.normalized_email IS NOT OLD.normalized_email
  OR NEW.display_email IS NOT OLD.display_email
  OR NEW.origin IS NOT OLD.origin
  OR NEW.minted_at_ms IS NOT OLD.minted_at_ms
BEGIN SELECT RAISE(ABORT, 'participant identity pair is immutable'); END;

CREATE TRIGGER participant_identity_family_no_delete
BEFORE DELETE ON participant_identity_family
BEGIN SELECT RAISE(ABORT, 'participant identities are never deleted'); END;

CREATE TABLE participant_sign_in_challenges (
  challenge_id TEXT PRIMARY KEY CHECK(
    length(challenge_id) = 36 AND challenge_id = lower(challenge_id)
  ),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  method TEXT NOT NULL CHECK(method IN ('magic_link')),
  normalized_email TEXT NOT NULL CHECK(length(normalized_email) BETWEEN 3 AND 320),
  display_email TEXT NOT NULL CHECK(length(display_email) BETWEEN 3 AND 320),
  token_hash_sha256 TEXT NOT NULL UNIQUE CHECK(
    length(token_hash_sha256) = 64 AND token_hash_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK(state IN ('issued', 'used', 'superseded', 'expired')),
  requested_at_ms INTEGER NOT NULL CHECK(requested_at_ms BETWEEN 0 AND 8640000000000000),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > requested_at_ms),
  closed_at_ms INTEGER CHECK(closed_at_ms IS NULL OR closed_at_ms >= requested_at_ms),
  superseded_by_challenge_id TEXT CHECK(
    superseded_by_challenge_id IS NULL OR (
      length(superseded_by_challenge_id) = 36
      AND superseded_by_challenge_id <> challenge_id
    )
  ),
  receipt_id TEXT NOT NULL CHECK(length(receipt_id) = 36),
  delivery_id TEXT UNIQUE CHECK(delivery_id IS NULL OR length(delivery_id) BETWEEN 1 AND 256),
  CHECK((state = 'issued') = (closed_at_ms IS NULL)),
  CHECK((state = 'superseded') = (superseded_by_challenge_id IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX participant_sign_in_challenges_address_lane
  ON participant_sign_in_challenges(workspace_id, event_id, normalized_email, state);

CREATE TRIGGER participant_sign_in_challenges_transitions
BEFORE UPDATE ON participant_sign_in_challenges
WHEN NEW.challenge_id IS NOT OLD.challenge_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.event_id IS NOT OLD.event_id
  OR NEW.method IS NOT OLD.method
  OR NEW.normalized_email IS NOT OLD.normalized_email
  OR NEW.display_email IS NOT OLD.display_email
  OR NEW.token_hash_sha256 IS NOT OLD.token_hash_sha256
  OR NEW.requested_at_ms IS NOT OLD.requested_at_ms
  OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
  OR NEW.receipt_id IS NOT OLD.receipt_id
  OR (OLD.state <> 'issued' AND NEW.state IS NOT OLD.state)
  OR (OLD.delivery_id IS NOT NULL AND NEW.delivery_id IS NOT OLD.delivery_id)
BEGIN SELECT RAISE(ABORT, 'participant challenge evidence is immutable'); END;

CREATE TRIGGER participant_sign_in_challenges_no_delete
BEFORE DELETE ON participant_sign_in_challenges
BEGIN SELECT RAISE(ABORT, 'participant challenges are never deleted'); END;

CREATE TABLE participant_sessions (
  session_id TEXT PRIMARY KEY CHECK(length(session_id) = 36 AND session_id = lower(session_id)),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  participant_identity_id TEXT NOT NULL
    REFERENCES participant_identity_family(participant_identity_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  token_hash_sha256 TEXT NOT NULL UNIQUE CHECK(
    length(token_hash_sha256) = 64 AND token_hash_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  last_seen_at_ms INTEGER NOT NULL CHECK(last_seen_at_ms >= created_at_ms),
  sliding_expires_at_ms INTEGER NOT NULL CHECK(sliding_expires_at_ms > created_at_ms),
  absolute_expires_at_ms INTEGER NOT NULL CHECK(absolute_expires_at_ms >= sliding_expires_at_ms),
  revoked_at_ms INTEGER CHECK(revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms),
  revoke_reason TEXT CHECK(revoke_reason IS NULL OR revoke_reason IN ('signed_out')),
  CHECK((revoked_at_ms IS NULL) = (revoke_reason IS NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX participant_sessions_identity
  ON participant_sessions(participant_identity_id, created_at_ms);

CREATE TRIGGER participant_sessions_identity_immutable
BEFORE UPDATE ON participant_sessions
WHEN NEW.session_id IS NOT OLD.session_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.event_id IS NOT OLD.event_id
  OR NEW.participant_identity_id IS NOT OLD.participant_identity_id
  OR NEW.person_id IS NOT OLD.person_id
  OR NEW.token_hash_sha256 IS NOT OLD.token_hash_sha256
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
  OR NEW.absolute_expires_at_ms IS NOT OLD.absolute_expires_at_ms
  OR NEW.last_seen_at_ms < OLD.last_seen_at_ms
  OR (OLD.revoked_at_ms IS NOT NULL AND (
    NEW.revoked_at_ms IS NOT OLD.revoked_at_ms OR NEW.revoke_reason IS NOT OLD.revoke_reason
  ))
BEGIN SELECT RAISE(ABORT, 'participant session identity is immutable'); END;

CREATE TRIGGER participant_sessions_no_delete
BEFORE DELETE ON participant_sessions
BEGIN SELECT RAISE(ABORT, 'participant sessions are never deleted'); END;
`;

export function installSQLiteParticipantAccessSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('participant_access_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(SQLITE_PARTICIPANT_ACCESS_SQL);
}

function instantMs(value: string): number {
  return Date.parse(parseInstant(value));
}

function toInstant(ms: number): string {
  return new Date(ms).toISOString();
}

function hashOrThrow(candidate: string): string {
  if (!/^[0-9a-f]{64}$/.test(candidate)) throw new TypeError('participant_token_hash_invalid');
  return candidate;
}

interface IdentityRow {
  readonly participant_identity_id: string;
  readonly person_id: string;
  readonly workspace_id: string;
  readonly event_id: string;
  readonly normalized_email: string;
  readonly display_email: string;
  readonly display_name: string;
  readonly standing: 'active' | 'revoked';
  readonly origin: 'portal_ceremony' | 'adopted_attribution';
  readonly minted_at_ms: number;
}

const IDENTITY_SELECT = `
SELECT participant_identity_id, person_id, workspace_id, event_id, normalized_email,
       display_email, display_name, standing, origin, minted_at_ms
  FROM participant_identity_family`;

function identityFromRow(row: IdentityRow): ParticipantIdentityRecord {
  return Object.freeze({
    participantIdentityId: parseParticipantIdentityId(row.participant_identity_id),
    personId: parsePersonId(row.person_id),
    lane: Object.freeze({
      workspaceId: parseWorkspaceId(row.workspace_id),
      eventId: parseEventId(row.event_id)
    }),
    normalizedEmail: row.normalized_email,
    displayEmail: row.display_email,
    displayName: row.display_name,
    standing: row.standing,
    origin: row.origin,
    mintedAt: toInstant(row.minted_at_ms)
  });
}

interface SessionRow {
  readonly session_id: string;
  readonly workspace_id: string;
  readonly event_id: string;
  readonly participant_identity_id: string;
  readonly person_id: string;
  readonly created_at_ms: number;
  readonly last_seen_at_ms: number;
  readonly sliding_expires_at_ms: number;
  readonly absolute_expires_at_ms: number;
  readonly revoked_at_ms: number | null;
  readonly revoke_reason: 'signed_out' | null;
}

const SESSION_SELECT = `
SELECT session_id, workspace_id, event_id, participant_identity_id, person_id,
       created_at_ms, last_seen_at_ms, sliding_expires_at_ms, absolute_expires_at_ms,
       revoked_at_ms, revoke_reason
  FROM participant_sessions`;

function sessionFromRow(row: SessionRow): ParticipantSessionRecord {
  return Object.freeze({
    sessionId: parseParticipantSessionId(row.session_id),
    lane: Object.freeze({
      workspaceId: parseWorkspaceId(row.workspace_id),
      eventId: parseEventId(row.event_id)
    }),
    participantIdentityId: parseParticipantIdentityId(row.participant_identity_id),
    personId: parsePersonId(row.person_id),
    createdAt: toInstant(row.created_at_ms),
    lastSeenAt: toInstant(row.last_seen_at_ms),
    slidingExpiresAt: toInstant(row.sliding_expires_at_ms),
    absoluteExpiresAt: toInstant(row.absolute_expires_at_ms)
  });
}

/**
 * The three participant-access ports on one SQLite handle. Ceremony writes
 * (issue, claim, mint, create) require the caller's open request transaction;
 * session resolution and sign-out run standalone in their own short
 * transaction when none is open, because the context read is not a unit of
 * work.
 */
export class SQLiteParticipantAccessStore
implements ParticipantChallengeStore, ParticipantIdentityDirectory, ParticipantSessionStore {
  readonly #policy: Pick<ParticipantAccessPolicy, 'sessionSlidingWindowMs'>;

  public constructor(
    private readonly sqlite: Database,
    options: { readonly policy: Pick<ParticipantAccessPolicy, 'sessionSlidingWindowMs'> }
  ) {
    if (
      !Number.isInteger(options.policy.sessionSlidingWindowMs)
      || options.policy.sessionSlidingWindowMs <= 0
    ) {
      throw new TypeError('participant_access_policy_invalid');
    }
    this.#policy = Object.freeze({ sessionSlidingWindowMs: options.policy.sessionSlidingWindowMs });
  }

  // -- challenges -----------------------------------------------------------

  issue(input: Parameters<ParticipantChallengeStore['issue']>[0]): void {
    if (!this.sqlite.inTransaction) throw new TypeError('participant_access_transaction_required');
    if (input.method !== 'magic_link') {
      throw new TypeError('participant_verification_method_unsupported');
    }
    const workspaceId = parseWorkspaceId(input.lane.workspaceId);
    const eventId = parseEventId(input.lane.eventId);
    const requestedAtMs = instantMs(input.requestedAt);
    // Newest wins: the new request supersedes every prior unused link for
    // this address+lane inside the same transaction.
    this.sqlite.query<never, [string, number, string, string, string]>(`
      UPDATE participant_sign_in_challenges
         SET state = 'superseded', superseded_by_challenge_id = ?, closed_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND normalized_email = ? AND state = 'issued'
    `).run(input.challengeId, requestedAtMs, workspaceId, eventId, input.normalizedEmail);
    this.sqlite.query<never, [
      string, string, string, string, string, string, number, number, string
    ]>(`
      INSERT INTO participant_sign_in_challenges (
        challenge_id, workspace_id, event_id, method, normalized_email, display_email,
        token_hash_sha256, state, requested_at_ms, expires_at_ms, receipt_id
      ) VALUES (?, ?, ?, 'magic_link', ?, ?, ?, 'issued', ?, ?, ?)
    `).run(
      input.challengeId, workspaceId, eventId, input.normalizedEmail, input.displayEmail,
      hashOrThrow(input.tokenHashSha256), requestedAtMs, instantMs(input.expiresAt),
      input.receiptId
    );
  }

  claim(input: Parameters<ParticipantChallengeStore['claim']>[0]): ParticipantChallengeClaim {
    if (!this.sqlite.inTransaction) throw new TypeError('participant_access_transaction_required');
    const workspaceId = parseWorkspaceId(input.lane.workspaceId);
    const eventId = parseEventId(input.lane.eventId);
    const tokenHash = hashOrThrow(input.tokenHashSha256);
    const nowMs = instantMs(input.now);
    // The single-use gate: exactly one guarded UPDATE can ever flip
    // issued → used for a token hash. A racing or replayed claim changes
    // nothing here and reads the terminal state below.
    const claimed = this.sqlite.query<never, [number, string, string, string, number]>(`
      UPDATE participant_sign_in_challenges
         SET state = 'used', closed_at_ms = ?
       WHERE token_hash_sha256 = ? AND workspace_id = ? AND event_id = ?
         AND state = 'issued' AND expires_at_ms > ?
    `).run(nowMs, tokenHash, workspaceId, eventId, nowMs);
    const row = this.sqlite.query<{
      readonly challenge_id: string;
      readonly workspace_id: string;
      readonly event_id: string;
      readonly method: 'magic_link';
      readonly normalized_email: string;
      readonly display_email: string;
      readonly state: 'issued' | 'used' | 'superseded' | 'expired';
      readonly requested_at_ms: number;
      readonly expires_at_ms: number;
      readonly closed_at_ms: number | null;
    }, [string, string, string]>(`
      SELECT challenge_id, workspace_id, event_id, method, normalized_email, display_email,
             state, requested_at_ms, expires_at_ms, closed_at_ms
        FROM participant_sign_in_challenges
       WHERE token_hash_sha256 = ? AND workspace_id = ? AND event_id = ?
    `).get(tokenHash, workspaceId, eventId);
    if (!row) return Object.freeze({ kind: 'unknown' });
    if (claimed.changes === 1) {
      return Object.freeze({
        kind: 'claimed',
        challenge: Object.freeze({
          challengeId: row.challenge_id,
          lane: Object.freeze({
            workspaceId: parseWorkspaceId(row.workspace_id),
            eventId: parseEventId(row.event_id)
          }),
          method: row.method,
          normalizedEmail: row.normalized_email,
          displayEmail: row.display_email,
          tokenHashSha256: tokenHash,
          requestedAt: toInstant(row.requested_at_ms),
          expiresAt: toInstant(row.expires_at_ms),
          state: 'used' as const
        })
      });
    }
    if (row.state === 'used') return Object.freeze({ kind: 'used' });
    if (row.state === 'superseded') return Object.freeze({ kind: 'superseded' });
    if (row.state === 'issued' && row.expires_at_ms <= nowMs) {
      this.sqlite.query<never, [number, string]>(`
        UPDATE participant_sign_in_challenges SET state = 'expired', closed_at_ms = ?
         WHERE token_hash_sha256 = ? AND state = 'issued'
      `).run(nowMs, tokenHash);
      return Object.freeze({ kind: 'expired' });
    }
    return Object.freeze({ kind: 'expired' });
  }

  /** Delivery evidence backlink; set once by the challenge delivery adapter. */
  linkChallengeDelivery(input: { readonly challengeId: string; readonly deliveryId: string }): void {
    if (!this.sqlite.inTransaction) throw new TypeError('participant_access_transaction_required');
    const changed = this.sqlite.query<never, [string, string]>(`
      UPDATE participant_sign_in_challenges SET delivery_id = ?
       WHERE challenge_id = ? AND delivery_id IS NULL
    `).run(input.deliveryId, input.challengeId);
    if (changed.changes !== 1) throw new TypeError('participant_challenge_delivery_conflict');
  }

  // -- identity family ------------------------------------------------------

  resolveByEmail(input: {
    readonly lane: ParticipantLane;
    readonly normalizedEmail: string;
  }): ParticipantIdentityRecord | undefined {
    const row = this.sqlite.query<IdentityRow, [string, string, string]>(`${IDENTITY_SELECT}
      WHERE workspace_id = ? AND event_id = ? AND normalized_email = ?`
    ).get(
      parseWorkspaceId(input.lane.workspaceId),
      parseEventId(input.lane.eventId),
      input.normalizedEmail
    );
    return row ? identityFromRow(row) : undefined;
  }

  get(input: {
    readonly lane: ParticipantLane;
    readonly participantIdentityId: ParticipantIdentityRecord['participantIdentityId'];
  }): ParticipantIdentityRecord | undefined {
    const row = this.sqlite.query<IdentityRow, [string, string, string]>(`${IDENTITY_SELECT}
      WHERE participant_identity_id = ? AND workspace_id = ? AND event_id = ?`
    ).get(
      parseParticipantIdentityId(input.participantIdentityId),
      parseWorkspaceId(input.lane.workspaceId),
      parseEventId(input.lane.eventId)
    );
    return row ? identityFromRow(row) : undefined;
  }

  mint(input: Parameters<ParticipantIdentityDirectory['mint']>[0]): ParticipantIdentityRecord {
    if (!this.sqlite.inTransaction) throw new TypeError('participant_access_transaction_required');
    const participantIdentityId = parseParticipantIdentityId(input.participantIdentityId);
    const personId = parsePersonId(input.personId);
    this.sqlite.query<never, [
      string, string, string, string, string, string, string, string, number
    ]>(`
      INSERT INTO participant_identity_family (
        participant_identity_id, person_id, workspace_id, event_id, normalized_email,
        display_email, display_name, standing, origin, minted_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      participantIdentityId, personId,
      parseWorkspaceId(input.lane.workspaceId), parseEventId(input.lane.eventId),
      input.normalizedEmail, input.displayEmail, input.displayName,
      input.origin, instantMs(input.mintedAt)
    );
    const record = this.get({ lane: input.lane, participantIdentityId });
    if (!record) throw new TypeError('participant_identity_mint_missing');
    return record;
  }

  /**
   * Administrative standing change (organizer removal). Not part of the
   * ceremony ports: the ceremony only ever reads standing, per request.
   */
  revokeIdentity(input: {
    readonly lane: ParticipantLane;
    readonly participantIdentityId: ParticipantIdentityRecord['participantIdentityId'];
    readonly now: string;
  }): void {
    const changed = this.sqlite.query<never, [number, string, string, string]>(`
      UPDATE participant_identity_family SET standing = 'revoked', revoked_at_ms = ?
       WHERE participant_identity_id = ? AND workspace_id = ? AND event_id = ?
         AND standing = 'active'
    `).run(
      instantMs(input.now),
      parseParticipantIdentityId(input.participantIdentityId),
      parseWorkspaceId(input.lane.workspaceId),
      parseEventId(input.lane.eventId)
    );
    if (changed.changes !== 1) throw new TypeError('participant_identity_revoke_conflict');
  }

  // -- sessions -------------------------------------------------------------

  create(input: Parameters<ParticipantSessionStore['create']>[0]): void {
    if (!this.sqlite.inTransaction) throw new TypeError('participant_access_transaction_required');
    const createdAtMs = instantMs(input.createdAt);
    this.sqlite.query<never, [
      string, string, string, string, string, string, number, number, number, number
    ]>(`
      INSERT INTO participant_sessions (
        session_id, workspace_id, event_id, participant_identity_id, person_id,
        token_hash_sha256, created_at_ms, last_seen_at_ms,
        sliding_expires_at_ms, absolute_expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parseParticipantSessionId(input.sessionId),
      parseWorkspaceId(input.lane.workspaceId), parseEventId(input.lane.eventId),
      parseParticipantIdentityId(input.participantIdentityId), parsePersonId(input.personId),
      hashOrThrow(input.tokenHashSha256), createdAtMs, createdAtMs,
      instantMs(input.window.slidingExpiresAt), instantMs(input.window.absoluteExpiresAt)
    );
  }

  resolve(input: Parameters<ParticipantSessionStore['resolve']>[0]): ParticipantSessionResolution {
    const tokenHash = hashOrThrow(input.tokenHashSha256);
    const workspaceId = parseWorkspaceId(input.lane.workspaceId);
    const eventId = parseEventId(input.lane.eventId);
    const nowMs = instantMs(input.now);
    return this.#inTransaction(() => {
      const row = this.sqlite.query<SessionRow, [string, string, string]>(`${SESSION_SELECT}
        WHERE token_hash_sha256 = ? AND workspace_id = ? AND event_id = ?`
      ).get(tokenHash, workspaceId, eventId);
      if (!row) return Object.freeze({ kind: 'unknown' as const });
      if (row.revoked_at_ms !== null) {
        return Object.freeze({ kind: 'expired' as const, reason: 'signed_out' as const });
      }
      if (nowMs >= row.absolute_expires_at_ms) {
        return Object.freeze({ kind: 'expired' as const, reason: 'absolute_cap_reached' as const });
      }
      if (nowMs >= row.sliding_expires_at_ms) {
        return Object.freeze({
          kind: 'expired' as const,
          reason: 'sliding_window_elapsed' as const
        });
      }
      const slidTo = instantMs(parseInstant(slideParticipantSessionWindow(
        this.#policy,
        { absoluteExpiresAt: toInstant(row.absolute_expires_at_ms) },
        toInstant(nowMs)
      )));
      const changed = this.sqlite.query<never, [number, number, string, number, number]>(`
        UPDATE participant_sessions
           SET last_seen_at_ms = ?, sliding_expires_at_ms = ?
         WHERE token_hash_sha256 = ? AND revoked_at_ms IS NULL
           AND absolute_expires_at_ms > ? AND sliding_expires_at_ms > ?
      `).run(Math.max(nowMs, row.last_seen_at_ms), Math.max(slidTo, row.sliding_expires_at_ms),
        tokenHash, nowMs, nowMs);
      if (changed.changes !== 1) throw new TypeError('participant_session_slide_conflict');
      const refreshed = this.sqlite.query<SessionRow, [string]>(`${SESSION_SELECT}
        WHERE token_hash_sha256 = ?`).get(tokenHash);
      if (!refreshed) throw new TypeError('participant_session_slide_conflict');
      return Object.freeze({ kind: 'active' as const, session: sessionFromRow(refreshed) });
    });
  }

  revokeByTokenHash(input: Parameters<ParticipantSessionStore['revokeByTokenHash']>[0]): void {
    const tokenHash = hashOrThrow(input.tokenHashSha256);
    this.#inTransaction(() => {
      this.sqlite.query<never, [number, string, string, string]>(`
        UPDATE participant_sessions SET revoked_at_ms = ?, revoke_reason = 'signed_out'
         WHERE token_hash_sha256 = ? AND workspace_id = ? AND event_id = ?
           AND revoked_at_ms IS NULL
      `).run(
        instantMs(input.now), tokenHash,
        parseWorkspaceId(input.lane.workspaceId), parseEventId(input.lane.eventId)
      );
      return undefined;
    });
  }

  #inTransaction<Value>(work: () => Value): Value {
    if (this.sqlite.inTransaction) return work();
    let began = false;
    try {
      this.sqlite.exec('BEGIN IMMEDIATE;');
      began = true;
      const value = work();
      this.sqlite.exec('COMMIT;');
      return value;
    } catch (error) {
      if (began && this.sqlite.inTransaction) this.sqlite.exec('ROLLBACK;');
      throw error;
    }
  }
}

/**
 * Current Person→submission/engagement relationship, computed from canonical
 * intake and engagement state at call time. This is the per-request authority
 * evaluation seam: it deliberately holds no cache and no session linkage, so
 * an organizer-side removal (for example a cancelled engagement) changes the
 * very next answer. A person reaches a submission two ways: through the
 * immutable participant evidence (the primary submitter — that evidence is
 * unique per submission), or through a non-cancelled engagement that carries
 * the shared `submission_id` (the acceptance-seeded co-speaker linkage; D3's
 * any_participant_acts authority over the shared submission rides on it, and
 * cancelling the engagement withdraws it on the next request).
 */
export function createSQLiteParticipantRelationshipSource(
  sqlite: Database
): ParticipantRelationshipSource {
  return Object.freeze({
    evaluate(input: {
      readonly lane: ParticipantLane;
      readonly personId: ParticipantIdentityRecord['personId'];
    }): ParticipantRelationship {
      const workspaceId = parseWorkspaceId(input.lane.workspaceId);
      const eventId = parseEventId(input.lane.eventId);
      const personId = parsePersonId(input.personId);
      const evidenceSubmissionIds = sqlite.query<{ readonly submission_id: string }, [string, string, string]>(`
        SELECT DISTINCT submission_id FROM intake_submission_participant_evidence
         WHERE workspace_id = ? AND event_id = ? AND person_id = ?
      `).all(workspaceId, eventId, personId).map((row) => row.submission_id);
      const engagementRows = sqlite.query<{
        readonly id: string;
        readonly submission_id: string | null;
      }, [string, string, string]>(`
        SELECT id, submission_id FROM engagement_heads
         WHERE workspace_id = ? AND event_id = ? AND person_id = ? AND state <> 'cancelled'
         ORDER BY id
      `).all(workspaceId, eventId, personId);
      const submissionIds = [...new Set([
        ...evidenceSubmissionIds,
        ...engagementRows.flatMap((row) => row.submission_id === null ? [] : [row.submission_id])
      ])].sort();
      const engagementIds = engagementRows.map((row) => row.id);
      if (submissionIds.length === 0 && engagementIds.length === 0) {
        return Object.freeze({ kind: 'none' });
      }
      return Object.freeze({
        kind: 'related',
        submissionIds: Object.freeze(submissionIds),
        engagementIds: Object.freeze(engagementIds)
      });
    }
  });
}

/**
 * The classified contact read the attribution join rides on. Structurally
 * satisfied by `SQLiteIntakeStore.readSubmissionContact` (both submission
 * sources), mirroring the decision-audience source: the email text lives only
 * in classified submission answers, so this projection is the one canonical
 * intake email→person association — the same one the decision-notification
 * send lane mails.
 */
export interface ParticipantAttributionContactSource {
  readSubmissionContact(
    scope: { readonly workspaceId: string; readonly eventId: string },
    submissionId: string
  ): {
    readonly submissionId: string;
    readonly personId: string;
    readonly participantIdentityId: string;
    readonly email: string;
  } | undefined;
}

/**
 * Resolves the intake-attributed person + participant-identity pair for a
 * proven mailbox address by scanning the lane's immutable participant
 * evidence and reading each submission's classified contact at call time —
 * no email is ever persisted as a lookup key and nothing is cached. Because
 * intake mints one pair per submission ceremony, one address can carry
 * several pairs; the earliest-submitted match wins so the choice is
 * deterministic and independent of when the first portal sign-in happens.
 * A contact whose pair disagrees with the submission's participant evidence
 * is corrupt state and fails the ceremony closed.
 */
export function createSQLiteIntakeAttributedParticipantSource(input: {
  readonly sqlite: Database;
  readonly contacts: ParticipantAttributionContactSource;
}): IntakeAttributedParticipantSource {
  return Object.freeze({
    resolveByEmail(query: {
      readonly lane: ParticipantLane;
      readonly normalizedEmail: string;
    }): IntakeAttributedParticipant | undefined {
      const workspaceId = parseWorkspaceId(query.lane.workspaceId);
      const eventId = parseEventId(query.lane.eventId);
      const rows = input.sqlite.query<{
        readonly submission_id: string;
        readonly person_id: string;
        readonly participant_identity_id: string;
      }, [string, string]>(`
        SELECT e.submission_id, e.person_id, e.participant_identity_id
          FROM intake_submission_participant_evidence e
          JOIN intake_submission_heads h
            ON h.workspace_id = e.workspace_id AND h.event_id = e.event_id
           AND h.submission_id = e.submission_id
         WHERE e.workspace_id = ? AND e.event_id = ?
         ORDER BY h.submitted_at_ms, e.submission_id
      `).all(workspaceId, eventId);
      for (const row of rows) {
        let contact;
        try {
          contact = input.contacts.readSubmissionContact(
            { workspaceId, eventId },
            row.submission_id
          );
        } catch (error) {
          // A submission without a resolvable contact answer cannot be
          // signed into; it is skipped, not a ceremony failure.
          if (error instanceof TypeError && error.message.startsWith('intake_contact')) continue;
          throw error;
        }
        if (contact === undefined) continue;
        if (contact.submissionId !== row.submission_id
            || contact.personId !== row.person_id
            || contact.participantIdentityId !== row.participant_identity_id) {
          throw new TypeError('participant_attribution_corrupt');
        }
        if (normalizeEmail(contact.email) !== query.normalizedEmail) continue;
        return Object.freeze({
          personId: parsePersonId(row.person_id),
          participantIdentityId: parseParticipantIdentityId(row.participant_identity_id)
        });
      }
      return undefined;
    }
  });
}
