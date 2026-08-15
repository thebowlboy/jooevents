import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { issueSynchronousClassifiedPayloadEncryptionProfile } from '@jooevents/application/synchronous-classified-payload-store';
import {
  createDeterministicFakeEmailProvider,
  createOutboundEmailDeliveryWorker,
  isOutboundEmailDispatchSkipped
} from '@jooevents/communications';
import {
  PARTICIPANT_ACCESS_LAUNCH_POLICY,
  PARTICIPANT_MAGIC_LINK_LAUNCH_TTL_MS,
  adoptIntakeAttributedParticipant,
  completeParticipantSignInLink,
  hashParticipantToken,
  parseParticipantEmail,
  participantSubjectAccess,
  requestParticipantSignInLink,
  resolveParticipantAuthority,
  resolveParticipantContext,
  signOutParticipant,
  type ParticipantLane,
  type ParticipantTokenSource
} from '@jooevents/identity-access';
import {
  parseEventId,
  parseParticipantIdentityId,
  parseParticipantSessionId,
  parsePersonId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  installSQLiteClassifiedPayloadStoreSchema,
  SQLiteClassifiedPayloadStore
} from './sqlite-classified-payload-store';
import {
  installSQLiteOutboundEmailDeliverySchema,
  SQLiteOutboundEmailDeliveryLedger
} from './outbound-email-delivery';
import {
  createSQLiteOutboundEmailEnvelopeResolver,
  installSQLiteCommunicationMessageReleaseSchema,
  SQLiteCommunicationMessageReleaseStore
} from './communications/message-releases';
import {
  createSQLiteIntakeAttributedParticipantSource,
  createSQLiteParticipantRelationshipSource,
  installSQLiteParticipantAccessSchema,
  SQLiteParticipantAccessStore,
  type ParticipantAttributionContactSource
} from './participant-access';
import {
  createSQLiteParticipantChallengeDelivery,
  renderParticipantSignInLinkMessage
} from './participant-challenge-delivery';

const laneA: ParticipantLane = Object.freeze({
  workspaceId: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  eventId: parseEventId('019c1df7-86b5-769b-bba4-5f7097bfb101')
});
const laneB: ParticipantLane = Object.freeze({
  workspaceId: laneA.workspaceId,
  eventId: parseEventId('019c1df7-86b5-769b-bba4-5f7097bfb102')
});

const T0 = '2026-08-14T10:00:00.000Z';
const DAY = 24 * 60 * 60_000;

function at(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

function uuid(suffix: number): string {
  return `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
}

function deterministicTokens(seed: number): ParticipantTokenSource {
  let counter = seed;
  return {
    randomBytes(size: number): Uint8Array {
      counter += 1;
      return Uint8Array.from({ length: size }, (_, index) => (counter * 7 + index * 13) % 256);
    }
  };
}

const SENDER = Object.freeze({
  fromAddress: 'auth@installation.example',
  fromDisplayName: 'Example Conference',
  source: 'installation' as const
});
const SENDER_RESOLVER = Object.freeze({ resolve: () => SENDER });
const PORTAL_ORIGIN = 'https://portal.installation.example';

const databases: Database[] = [];
afterEach(() => {
  for (const sqlite of databases.splice(0)) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    sqlite.close(false);
  }
});

/**
 * Canonical-name clones of the three intake/engagement tables, limited to the
 * columns `createSQLiteParticipantRelationshipSource` and
 * `createSQLiteIntakeAttributedParticipantSource` read. The full DDL lives in
 * `intake.ts` (`intake_submission_heads`,
 * `intake_submission_participant_evidence`) and `engagement.ts`
 * (`engagement_heads`); installing those here would drag the whole
 * form/event-spine graph into a ceremony test, so the joined runtime keeps
 * the real-schema coverage.
 */
const RELATIONSHIP_TABLE_CLONES_SQL = `
CREATE TABLE intake_submission_heads (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL PRIMARY KEY,
  submitted_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE intake_submission_participant_evidence (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL PRIMARY KEY,
  person_id TEXT NOT NULL,
  participant_identity_id TEXT NOT NULL
) STRICT;
CREATE TABLE engagement_heads (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  submission_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('invited', 'confirmed', 'declined', 'cancelled'))
) STRICT;
`;

function fixture() {
  const sqlite = new Database(':memory:', { strict: true });
  databases.push(sqlite);
  installSQLiteClassifiedPayloadStoreSchema(sqlite);
  installSQLiteCommunicationMessageReleaseSchema(sqlite);
  installSQLiteOutboundEmailDeliverySchema(sqlite);
  installSQLiteParticipantAccessSchema(sqlite);
  sqlite.exec(RELATIONSHIP_TABLE_CLONES_SQL);

  let nonceSeed = 1;
  const classifiedStore = new SQLiteClassifiedPayloadStore(sqlite, {
    encryptionProfile: issueSynchronousClassifiedPayloadEncryptionProfile({
      reference: { key: 'encryption.participant-access-test', version: 1 },
      keyBytes: new Uint8Array(32).fill(0x37)
    }),
    nonceSource(size) {
      const nonce = Uint8Array.from({ length: size }, (_, index) => (nonceSeed + index * 19) % 256);
      nonceSeed += 1;
      return nonce;
    }
  });
  let idSeq = 0x1000;
  const nextUuid = () => uuid((idSeq += 1));
  const releases = new SQLiteCommunicationMessageReleaseStore(sqlite, classifiedStore, {
    newEnvelopePayloadRefId: nextUuid
  });
  const store = new SQLiteParticipantAccessStore(sqlite, {
    policy: PARTICIPANT_ACCESS_LAUNCH_POLICY
  });
  const delivery = createSQLiteParticipantChallengeDelivery({
    sqlite,
    releases,
    ids: {
      newReleaseId: nextUuid,
      newDeliveryId: nextUuid,
      newEvidenceId: nextUuid
    },
    senderResolver: SENDER_RESOLVER,
    portalOrigin: PORTAL_ORIGIN,
    challenges: store
  });
  const ledger = new SQLiteOutboundEmailDeliveryLedger(sqlite, {
    newFactId: nextUuid,
    newPointerId: nextUuid,
    newHistoryId: nextUuid
  });
  const fake = createDeterministicFakeEmailProvider();
  const worker = createOutboundEmailDeliveryWorker({
    ledger,
    provider: fake.delivery,
    envelopes: createSQLiteOutboundEmailEnvelopeResolver(releases),
    ids: { newAttemptId: nextUuid, newClaimId: nextUuid },
    clock: { now: () => at(5_000) }
  });
  const relationships = createSQLiteParticipantRelationshipSource(sqlite);
  // Stand-in for the intake store's classified contact projection
  // (`readSubmissionContact`); tests seed it beside the evidence rows.
  const contactRows = new Map<string, {
    readonly submissionId: string;
    readonly personId: string;
    readonly participantIdentityId: string;
    readonly email: string;
  }>();
  const contactReads: string[] = [];
  const contacts: ParticipantAttributionContactSource = {
    readSubmissionContact(scope, submissionId) {
      contactReads.push(submissionId);
      return contactRows.get(`${scope.workspaceId}${scope.eventId}${submissionId}`);
    }
  };
  const intakeAttribution = createSQLiteIntakeAttributedParticipantSource({ sqlite, contacts });
  const ids = {
    newChallengeId: nextUuid,
    newReceiptId: nextUuid,
    newPersonId: () => parsePersonId(nextUuid()),
    newParticipantIdentityId: () => parseParticipantIdentityId(nextUuid()),
    newSessionId: () => parseParticipantSessionId(nextUuid())
  };
  return {
    sqlite, classifiedStore, releases, store, delivery, ledger, fake, worker,
    relationships, contactRows, contactReads, intakeAttribution, ids
  };
}

/** Seeds one intake-attributed submission: heads + evidence rows and the classified contact. */
function seedIntakeSubmission(f: Fixture, input: {
  readonly lane?: ParticipantLane;
  readonly submissionId: string;
  readonly personId: string;
  readonly participantIdentityId: string;
  readonly email: string;
  readonly submittedAtMs?: number;
  readonly contactPairOverride?: { readonly personId: string; readonly participantIdentityId: string };
}): void {
  const lane = input.lane ?? laneA;
  f.sqlite.query(`
    INSERT INTO intake_submission_heads (workspace_id, event_id, submission_id, submitted_at_ms)
    VALUES (?, ?, ?, ?)
  `).run(lane.workspaceId, lane.eventId, input.submissionId, input.submittedAtMs ?? Date.parse(T0));
  f.sqlite.query(`
    INSERT INTO intake_submission_participant_evidence (
      workspace_id, event_id, submission_id, evidence_id, person_id, participant_identity_id
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(lane.workspaceId, lane.eventId, input.submissionId, `ev-${input.submissionId}`,
    input.personId, input.participantIdentityId);
  f.contactRows.set(`${lane.workspaceId}${lane.eventId}${input.submissionId}`, {
    submissionId: input.submissionId,
    personId: input.contactPairOverride?.personId ?? input.personId,
    participantIdentityId:
      input.contactPairOverride?.participantIdentityId ?? input.participantIdentityId,
    email: input.email
  });
}

type Fixture = ReturnType<typeof fixture>;

function tx<Value>(sqlite: Database, work: () => Value): Value {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    const value = work();
    sqlite.exec('COMMIT;');
    return value;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}

function requestLink(f: Fixture, email: string, options?: {
  readonly now?: string;
  readonly lane?: ParticipantLane;
  readonly tokens?: ParticipantTokenSource;
}) {
  return tx(f.sqlite, () => requestParticipantSignInLink({
    challenges: f.store,
    delivery: f.delivery,
    ids: f.ids,
    policy: PARTICIPANT_ACCESS_LAUNCH_POLICY,
    lane: options?.lane ?? laneA,
    email,
    now: options?.now ?? T0,
    ...(options?.tokens ? { tokens: options.tokens } : {})
  }));
}

function completeLink(f: Fixture, token: string, options?: {
  readonly now?: string;
  readonly lane?: ParticipantLane;
}) {
  return tx(f.sqlite, () => completeParticipantSignInLink({
    challenges: f.store,
    identities: f.store,
    intakeAttribution: f.intakeAttribution,
    sessions: f.store,
    ids: f.ids,
    policy: PARTICIPANT_ACCESS_LAUNCH_POLICY,
    lane: options?.lane ?? laneA,
    token,
    now: options?.now ?? at(60_000)
  }));
}

interface ChallengeRow {
  readonly challenge_id: string;
  readonly state: string;
  readonly token_hash_sha256: string;
  readonly normalized_email: string;
  readonly superseded_by_challenge_id: string | null;
  readonly delivery_id: string | null;
}

function challengeRow(f: Fixture, challengeId: string): ChallengeRow {
  const row = f.sqlite.query<ChallengeRow, [string]>(`
    SELECT challenge_id, state, token_hash_sha256, normalized_email,
           superseded_by_challenge_id, delivery_id
      FROM participant_sign_in_challenges WHERE challenge_id = ?
  `).get(challengeId);
  if (!row) throw new Error(`missing challenge ${challengeId}`);
  return row;
}

/**
 * Recovers the emailed link the way the dev-only fixture control would: the
 * challenge's delivery evidence points at the immutable release, whose
 * classified envelope is the only place the raw token exists.
 */
function emailedLinkToken(f: Fixture, challengeId: string): string {
  const row = challengeRow(f, challengeId);
  if (row.delivery_id === null) throw new Error('challenge has no delivery');
  const head = f.ledger.read(row.delivery_id);
  if (!head) throw new Error('delivery head missing');
  const release = f.releases.read(head.releaseId);
  if (!release) throw new Error('release missing');
  const match = /https:\/\/[^\s]+\/p\/([^\s]+)/.exec(release.envelope.textBody);
  if (!match) throw new Error('no link in envelope');
  return decodeURIComponent(match[1]!);
}

function count(f: Fixture, table: string): number {
  return f.sqlite.query<{ readonly count: number }, []>(
    `SELECT count(*) AS count FROM ${table}`
  ).get()?.count ?? -1;
}

describe('participant magic-link request ceremony (persistence)', () => {
  test('one transaction records hash-only challenge, classified release, and pending delivery', () => {
    const f = fixture();
    const { result, challengeId } = requestLink(f, 'Speaker@Example.org');
    expect(result).toEqual({ outcome: 'link_requested' });

    const row = challengeRow(f, challengeId);
    expect(row.state).toBe('issued');
    expect(row.normalized_email).toBe('speaker@example.org');
    expect(row.token_hash_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.delivery_id).not.toBeNull();

    const head = f.ledger.read(row.delivery_id!);
    if (!head) throw new Error('delivery head missing');
    expect(head.state).toBe('pending');
    expect(head.externalDeliveryKey).toBe('provider.not-activated');
    expect(head.providerConnectionRevisionId).toBe('provider.connection.not-activated');

    const release = f.releases.read(head.releaseId);
    if (!release) throw new Error('release missing');
    expect(release.purposeKey).toBe('security_challenge');
    expect(release.envelope.to.address as string).toBe('Speaker@Example.org');
    expect(release.envelope.from.address as string).toBe(SENDER.fromAddress);
    expect(release.envelope.textBody).toContain(`${PORTAL_ORIGIN}/p/plt1_`);
    expect(release.envelope.htmlBody).toContain(`${PORTAL_ORIGIN}/p/plt1_`);

    const pointer = f.sqlite.query<{ readonly purpose: string }, [string]>(`
      SELECT purpose FROM communication_outbound_delivery_outbox WHERE delivery_id = ?
    `).get(row.delivery_id!);
    expect(pointer?.purpose).toBe('communication.outbound-email.dispatch');
    expect(f.sqlite.query<{ readonly summary_code: string }, [string]>(`
      SELECT summary_code FROM communication_outbound_delivery_history WHERE delivery_id = ?
    `).get(row.delivery_id!)?.summary_code).toBe('communication.outbound-email.requested');

    // No organizer projection exists for security mail: only the ledger rows.
    expect(count(f, 'communication_message_releases')).toBe(1);
  });

  test('the outbox effect is atomic with the ceremony: a failing transaction leaves nothing', () => {
    const f = fixture();
    expect(() => tx(f.sqlite, () => {
      requestParticipantSignInLink({
        challenges: f.store,
        delivery: f.delivery,
        ids: f.ids,
        policy: PARTICIPANT_ACCESS_LAUNCH_POLICY,
        lane: laneA,
        email: 'speaker@example.org',
        now: T0
      });
      throw new Error('later ceremony work failed');
    })).toThrow('later ceremony work failed');
    expect(count(f, 'participant_sign_in_challenges')).toBe(0);
    expect(count(f, 'communication_outbound_delivery_heads')).toBe(0);
    expect(count(f, 'communication_message_releases')).toBe(0);
  });

  test('an inline send is impossible: the ceremony refuses to run without a transaction', () => {
    const f = fixture();
    expect(() => requestParticipantSignInLink({
      challenges: f.store,
      delivery: f.delivery,
      ids: f.ids,
      policy: PARTICIPANT_ACCESS_LAUNCH_POLICY,
      lane: laneA,
      email: 'speaker@example.org',
      now: T0
    })).toThrow('participant_access_transaction_required');
  });

  test('hash-only storage: the raw token appears nowhere outside the encrypted envelope', () => {
    const f = fixture();
    const { challengeId } = requestLink(f, 'speaker@example.org', {
      tokens: deterministicTokens(7)
    });
    const rawToken = emailedLinkToken(f, challengeId);
    expect(rawToken.startsWith('plt1_')).toBe(true);
    expect(challengeRow(f, challengeId).token_hash_sha256).toBe(hashParticipantToken(rawToken));

    // The whole serialized database — every table, index, and the encrypted
    // classified payload bytes — must not contain the raw token or even the
    // token-prefix marker anywhere in plaintext.
    const serialized = Buffer.from(f.sqlite.serialize());
    expect(serialized.includes(Buffer.from(rawToken, 'utf8'))).toBe(false);
    expect(serialized.includes(Buffer.from('plt1_', 'utf8'))).toBe(false);
    // The one-way hash is what the store holds instead.
    expect(serialized.includes(Buffer.from(hashParticipantToken(rawToken), 'utf8'))).toBe(true);
  });

  test('non-enumeration: known and unknown addresses leave identical shapes', () => {
    const f = fixture();
    tx(f.sqlite, () => f.store.mint({
      participantIdentityId: f.ids.newParticipantIdentityId(),
      personId: f.ids.newPersonId(),
      lane: laneA,
      normalizedEmail: 'known@example.org',
      displayEmail: 'known@example.org',
      displayName: 'known',
      origin: 'portal_ceremony',
      mintedAt: T0
    }));
    const known = requestLink(f, 'known@example.org');
    const unknown = requestLink(f, 'unknown@example.org');
    expect(known.result).toEqual(unknown.result);
    const rows = f.sqlite.query<{ readonly challenge_id: string; readonly state: string }, []>(`
      SELECT challenge_id, state FROM participant_sign_in_challenges ORDER BY requested_at_ms
    `).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.state === 'issued')).toBe(true);
    expect(count(f, 'communication_outbound_delivery_heads')).toBe(2);
    expect(count(f, 'communication_message_releases')).toBe(2);
    const populated = (challengeId: string) => {
      const row = f.sqlite.query<Record<string, unknown>, [string]>(`
        SELECT * FROM participant_sign_in_challenges WHERE challenge_id = ?
      `).get(challengeId)!;
      return Object.entries(row).map(([key, value]) => `${key}:${value === null ? 'null' : 'set'}`);
    };
    expect(populated(known.challengeId)).toEqual(populated(unknown.challengeId));
  });

  test('newest-wins: a new request supersedes prior unused links for its address+lane only', () => {
    const f = fixture();
    const first = requestLink(f, 'speaker@example.org', { tokens: deterministicTokens(11) });
    const firstToken = emailedLinkToken(f, first.challengeId);
    const other = requestLink(f, 'other@example.org', { tokens: deterministicTokens(12) });
    const otherLane = requestLink(f, 'speaker@example.org', {
      lane: laneB,
      tokens: deterministicTokens(13)
    });
    const second = requestLink(f, 'SPEAKER@example.org', {
      now: at(30_000),
      tokens: deterministicTokens(14)
    });

    expect(challengeRow(f, first.challengeId).state).toBe('superseded');
    expect(challengeRow(f, first.challengeId).superseded_by_challenge_id).toBe(second.challengeId);
    expect(challengeRow(f, second.challengeId).state).toBe('issued');
    expect(challengeRow(f, other.challengeId).state).toBe('issued');
    expect(challengeRow(f, otherLane.challengeId).state).toBe('issued');

    expect(completeLink(f, firstToken)).toEqual({ kind: 'link_invalid', reason: 'superseded' });
    expect(completeLink(f, emailedLinkToken(f, second.challengeId)).kind).toBe('signed_in');
  });

  test('dispatching under the inert provider records honest terminal not-delivered history', async () => {
    const f = fixture();
    const { challengeId } = requestLink(f, 'speaker@example.org');
    const deliveryId = challengeRow(f, challengeId).delivery_id!;

    const dispatched = await f.worker.dispatch({ deliveryId });
    if (isOutboundEmailDispatchSkipped(dispatched)) throw new Error('dispatch was not claimed');
    expect(dispatched.state).toBe('known_rejected_terminal');
    expect(dispatched.followUp).toBe('complete');

    const head = f.ledger.read(deliveryId);
    expect(head?.state).toBe('known_rejected_terminal');
    expect(head?.attemptCount).toBe(1);
    const attempts = f.ledger.listAttempts(deliveryId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.adapterKey).toBe('fake.email');
    expect(attempts[0]?.state).toBe('known_rejected_terminal');
    const summaries = f.sqlite.query<{ readonly summary_code: string }, [string]>(`
      SELECT summary_code FROM communication_outbound_delivery_history
       WHERE delivery_id = ? ORDER BY sequence
    `).all(deliveryId).map((row) => row.summary_code);
    expect(summaries).toEqual([
      'communication.outbound-email.requested',
      'communication.outbound-email.rejected-terminal'
    ]);
    expect(f.fake.capturedOrdinaryRequests()).toHaveLength(1);
  });
});

describe('participant magic-link callback (persistence)', () => {
  test('single use under replay: the second and every later claim reads link_used', () => {
    const f = fixture();
    const { challengeId } = requestLink(f, 'speaker@example.org');
    const token = emailedLinkToken(f, challengeId);
    expect(completeLink(f, token).kind).toBe('signed_in');
    expect(completeLink(f, token)).toEqual({ kind: 'link_used' });
    expect(completeLink(f, token)).toEqual({ kind: 'link_used' });
    expect(challengeRow(f, challengeId).state).toBe('used');
  });

  test('single use under race: only one guarded claim can ever win', () => {
    const f = fixture();
    const { challengeId } = requestLink(f, 'speaker@example.org');
    const tokenHash = challengeRow(f, challengeId).token_hash_sha256;
    // Two racing completion requests serialize on the guarded UPDATE; the
    // loser observes the terminal state, never a second `claimed`.
    const first = tx(f.sqlite, () => f.store.claim({
      lane: laneA,
      tokenHashSha256: tokenHash,
      now: at(1_000)
    }));
    const second = tx(f.sqlite, () => f.store.claim({
      lane: laneA,
      tokenHashSha256: tokenHash,
      now: at(1_000)
    }));
    expect(first.kind).toBe('claimed');
    expect(second.kind).toBe('used');
  });

  test('TTL expiry is typed and terminal', () => {
    const f = fixture();
    const { challengeId } = requestLink(f, 'speaker@example.org');
    const token = emailedLinkToken(f, challengeId);
    const justAfter = at(PARTICIPANT_MAGIC_LINK_LAUNCH_TTL_MS + 1);
    expect(completeLink(f, token, { now: justAfter })).toEqual({ kind: 'link_expired' });
    expect(challengeRow(f, challengeId).state).toBe('expired');
    expect(completeLink(f, token, { now: at(DAY) })).toEqual({ kind: 'link_expired' });
  });

  test('a token never completes in another lane', () => {
    const f = fixture();
    const { challengeId } = requestLink(f, 'speaker@example.org');
    const token = emailedLinkToken(f, challengeId);
    expect(completeLink(f, token, { lane: laneB }))
      .toEqual({ kind: 'link_invalid', reason: 'unknown_token' });
    expect(challengeRow(f, challengeId).state).toBe('issued');
  });

  test('completion mints one immutable family pair and later ceremonies resume it', () => {
    const f = fixture();
    const first = completeLink(f, emailedLinkToken(f, requestLink(f, 'speaker@example.org', {
      tokens: deterministicTokens(21)
    }).challengeId));
    if (first.kind !== 'signed_in') throw new Error('expected signed_in');
    expect(first.resumed).toBe(false);
    expect(first.identity.personId as string)
      .not.toBe(first.identity.participantIdentityId as string);

    const second = completeLink(f, emailedLinkToken(f, requestLink(f, 'speaker@example.org', {
      now: at(120_000),
      tokens: deterministicTokens(22)
    }).challengeId), { now: at(180_000) });
    if (second.kind !== 'signed_in') throw new Error('expected signed_in');
    expect(second.resumed).toBe(true);
    expect(second.identity.personId).toBe(first.identity.personId);
    expect(second.identity.participantIdentityId).toBe(first.identity.participantIdentityId);
    expect(count(f, 'participant_identity_family')).toBe(1);

    // The pair is physically immutable and role-collision-guarded.
    expect(() => f.sqlite.query(`
      UPDATE participant_identity_family SET person_id = ? WHERE participant_identity_id = ?
    `).run(uuid(0xdead), first.identity.participantIdentityId))
      .toThrow('participant identity pair is immutable');
    expect(() => tx(f.sqlite, () => f.store.mint({
      participantIdentityId: parseParticipantIdentityId(uuid(0xd01)),
      personId: parsePersonId(first.identity.participantIdentityId as string),
      lane: laneA,
      normalizedEmail: 'collide@example.org',
      displayEmail: 'collide@example.org',
      displayName: 'collide',
      origin: 'portal_ceremony',
      mintedAt: T0
    }))).toThrow('participant identity role collision');
  });

  test('an adopted intake-attributed pair is resumed, never shadowed', () => {
    const f = fixture();
    const attribution = {
      personId: parsePersonId(uuid(0xa01)),
      participantIdentityId: parseParticipantIdentityId(uuid(0xa02))
    };
    tx(f.sqlite, () => adoptIntakeAttributedParticipant({
      identities: f.store,
      lane: laneA,
      attribution,
      email: parseParticipantEmail('speaker@example.org'),
      displayName: 'Speaker',
      now: T0
    }));
    const outcome = completeLink(f, emailedLinkToken(f, requestLink(f, 'speaker@example.org')
      .challengeId));
    if (outcome.kind !== 'signed_in') throw new Error('expected signed_in');
    expect(outcome.resumed).toBe(true);
    expect(outcome.identity.personId).toBe(attribution.personId);
    expect(outcome.identity.participantIdentityId).toBe(attribution.participantIdentityId);
    expect(outcome.identity.origin).toBe('adopted_attribution');
    expect(count(f, 'participant_identity_family')).toBe(1);
  });

  test('an intake-attributed speaker signs in as the intake pair and sees their submission', () => {
    const f = fixture();
    // The intake ceremony attributed speaker@example.org as (P1, I1) with
    // participant evidence on submission S — before any portal contact.
    const p1 = uuid(0xb01);
    const i1 = uuid(0xb02);
    const submission = uuid(0xb03);
    seedIntakeSubmission(f, {
      submissionId: submission,
      personId: p1,
      participantIdentityId: i1,
      email: 'Speaker@Example.org'
    });

    const outcome = completeLink(f, emailedLinkToken(f, requestLink(f, 'speaker@example.org', {
      tokens: deterministicTokens(71)
    }).challengeId));
    if (outcome.kind !== 'signed_in') throw new Error('expected signed_in');
    expect(outcome.identity.personId as string).toBe(p1);
    expect(outcome.identity.participantIdentityId as string).toBe(i1);
    expect(outcome.identity.origin).toBe('adopted_attribution');
    expect(outcome.resumed).toBe(false);
    expect(count(f, 'participant_identity_family')).toBe(1);

    // The signed-in speaker's freshly evaluated relationship reaches the
    // submission their intake evidence is keyed by.
    const authority = resolveParticipantAuthority({
      sessions: f.store,
      identities: f.store,
      relationships: f.relationships,
      lane: laneA,
      sessionToken: outcome.session.sessionToken,
      now: at(120_000)
    });
    if (authority.kind !== 'authorized') throw new Error('expected authorized');
    expect(authority.relationship).toEqual({
      kind: 'related',
      submissionIds: [submission],
      engagementIds: []
    });
    expect(participantSubjectAccess(authority.relationship, { kind: 'submission', id: submission }))
      .toEqual({ allowed: true });

    // Later ceremonies resume the adopted member without another intake scan.
    const scans = f.contactReads.length;
    const again = completeLink(f, emailedLinkToken(f, requestLink(f, 'speaker@example.org', {
      now: at(180_000), tokens: deterministicTokens(72)
    }).challengeId), { now: at(240_000) });
    if (again.kind !== 'signed_in') throw new Error('expected signed_in');
    expect(again.resumed).toBe(true);
    expect(again.identity.personId as string).toBe(p1);
    expect(f.contactReads.length).toBe(scans);
    expect(count(f, 'participant_identity_family')).toBe(1);
  });

  test('several attributed pairs on one address adopt deterministically: earliest submission wins', () => {
    const f = fixture();
    // Intake minted a pair per ceremony, so a twice-applying speaker carries
    // two pairs. Insert the newer submission first to prove ordering comes
    // from submitted_at, not insertion or id order.
    seedIntakeSubmission(f, {
      submissionId: uuid(0xb11),
      personId: uuid(0xb12),
      participantIdentityId: uuid(0xb13),
      email: 'twice@example.org',
      submittedAtMs: Date.parse(T0) + 60_000
    });
    seedIntakeSubmission(f, {
      submissionId: uuid(0xb21),
      personId: uuid(0xb22),
      participantIdentityId: uuid(0xb23),
      email: 'twice@example.org',
      submittedAtMs: Date.parse(T0)
    });

    const outcome = completeLink(f, emailedLinkToken(f, requestLink(f, 'twice@example.org', {
      tokens: deterministicTokens(73)
    }).challengeId));
    if (outcome.kind !== 'signed_in') throw new Error('expected signed_in');
    expect(outcome.identity.personId as string).toBe(uuid(0xb22));
    expect(outcome.identity.participantIdentityId as string).toBe(uuid(0xb23));
    expect(outcome.identity.origin).toBe('adopted_attribution');
  });

  test('a contact that contradicts the participant evidence fails the ceremony closed', () => {
    const f = fixture();
    seedIntakeSubmission(f, {
      submissionId: uuid(0xb31),
      personId: uuid(0xb32),
      participantIdentityId: uuid(0xb33),
      email: 'corrupt@example.org',
      contactPairOverride: {
        personId: uuid(0xb42),
        participantIdentityId: uuid(0xb43)
      }
    });
    const { challengeId } = requestLink(f, 'corrupt@example.org', {
      tokens: deterministicTokens(74)
    });
    const token = emailedLinkToken(f, challengeId);
    expect(() => completeLink(f, token)).toThrow('participant_attribution_corrupt');
    // The whole completion transaction rolled back: no member, no session,
    // and the unclaimed challenge is still issued for a retry after repair.
    expect(count(f, 'participant_identity_family')).toBe(0);
    expect(count(f, 'participant_sessions')).toBe(0);
    expect(challengeRow(f, challengeId).state).toBe('issued');
  });

  test('equal email is a separate family member per lane, never a merge', () => {
    const f = fixture();
    const inA = completeLink(f, emailedLinkToken(f, requestLink(f, 'speaker@example.org', {
      lane: laneA, tokens: deterministicTokens(31)
    }).challengeId), { lane: laneA });
    const inB = completeLink(f, emailedLinkToken(f, requestLink(f, 'speaker@example.org', {
      lane: laneB, tokens: deterministicTokens(32)
    }).challengeId), { lane: laneB });
    if (inA.kind !== 'signed_in' || inB.kind !== 'signed_in') throw new Error('expected signed_in');
    expect(inA.identity.personId).not.toBe(inB.identity.personId);
    expect(count(f, 'participant_identity_family')).toBe(2);
  });
});

describe('participant session store (persistence)', () => {
  function signIn(f: Fixture, email = 'speaker@example.org') {
    const { challengeId } = requestLink(f, email, {
      tokens: deterministicTokens(41 + count(f, 'participant_sign_in_challenges'))
    });
    const outcome = completeLink(f, emailedLinkToken(f, challengeId));
    if (outcome.kind !== 'signed_in') throw new Error('expected signed_in');
    return outcome;
  }

  function context(f: Fixture, sessionToken: string | undefined, now: string, lane = laneA) {
    return resolveParticipantContext({
      sessions: f.store,
      identities: f.store,
      lane,
      sessionToken,
      now
    });
  }

  test('the cookie token is stored hash-only in the ParticipantSessionId-keyed row', () => {
    const f = fixture();
    const { session } = signIn(f);
    const row = f.sqlite.query<{
      readonly session_id: string;
      readonly token_hash_sha256: string;
    }, []>('SELECT session_id, token_hash_sha256 FROM participant_sessions').get()!;
    expect(row.session_id).toBe(session.sessionId as string);
    expect(row.token_hash_sha256).toBe(hashParticipantToken(session.sessionToken));
    const serialized = Buffer.from(f.sqlite.serialize());
    expect(serialized.includes(Buffer.from(session.sessionToken, 'utf8'))).toBe(false);
    expect(serialized.includes(Buffer.from('pst1_', 'utf8'))).toBe(false);
  });

  test('activity slides the window; inactivity past 30 days expires the session', () => {
    const f = fixture();
    const { session } = signIn(f);
    expect(context(f, session.sessionToken, at(29 * DAY)).kind).toBe('active');
    expect(context(f, session.sessionToken, at(58 * DAY)).kind).toBe('active');
    expect(context(f, session.sessionToken, at(89.5 * DAY)))
      .toEqual({ kind: 'expired', reason: 'sliding_window_elapsed' });
  });

  test('the 90-day absolute cap ends the session despite daily activity', () => {
    const f = fixture();
    const { session } = signIn(f);
    for (let day = 1; day <= 89; day += 1) {
      expect(context(f, session.sessionToken, at(day * DAY)).kind).toBe('active');
    }
    expect(context(f, session.sessionToken, at(90 * DAY + 60_000)))
      .toEqual({ kind: 'expired', reason: 'absolute_cap_reached' });
    const row = f.sqlite.query<{ readonly sliding_expires_at_ms: number; readonly absolute_expires_at_ms: number }, []>(
      'SELECT sliding_expires_at_ms, absolute_expires_at_ms FROM participant_sessions'
    ).get()!;
    expect(row.sliding_expires_at_ms).toBeLessThanOrEqual(row.absolute_expires_at_ms);
  });

  test('explicit sign-out revokes idempotently and is honestly non-enumerating', () => {
    const f = fixture();
    const { session } = signIn(f);
    expect(signOutParticipant({
      sessions: f.store, lane: laneA, sessionToken: session.sessionToken, now: at(60_000)
    })).toEqual({ signedOut: true });
    expect(context(f, session.sessionToken, at(120_000)))
      .toEqual({ kind: 'expired', reason: 'signed_out' });
    expect(signOutParticipant({
      sessions: f.store, lane: laneA, sessionToken: session.sessionToken, now: at(180_000)
    })).toEqual({ signedOut: true });
    expect(signOutParticipant({
      sessions: f.store,
      lane: laneA,
      sessionToken: 'pst1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      now: at(180_000)
    })).toEqual({ signedOut: true });
  });

  test('sessions are lane-separate: another lane resolves nothing', () => {
    const f = fixture();
    const { session } = signIn(f);
    expect(context(f, session.sessionToken, at(60_000), laneB)).toEqual({ kind: 'anonymous' });
  });
});

describe('per-request authority re-evaluation (persistence)', () => {
  function signIn(f: Fixture) {
    const { challengeId } = requestLink(f, 'speaker@example.org', {
      tokens: deterministicTokens(51)
    });
    const outcome = completeLink(f, emailedLinkToken(f, challengeId));
    if (outcome.kind !== 'signed_in') throw new Error('expected signed_in');
    return outcome;
  }

  function authority(f: Fixture, sessionToken: string, now: string) {
    return resolveParticipantAuthority({
      sessions: f.store,
      identities: f.store,
      relationships: f.relationships,
      lane: laneA,
      sessionToken,
      now
    });
  }

  test('a removed participant fails on the next request despite a live session', () => {
    const f = fixture();
    const { session, identity } = signIn(f);
    const engagementId = uuid(0xe01);
    f.sqlite.query(`
      INSERT INTO engagement_heads (workspace_id, event_id, id, session_id, person_id, state)
      VALUES (?, ?, ?, ?, ?, 'invited')
    `).run(laneA.workspaceId, laneA.eventId, engagementId, uuid(0xe02),
      identity.personId as string);

    const before = authority(f, session.sessionToken, at(60_000));
    if (before.kind !== 'authorized') throw new Error('expected authorized');
    expect(before.actor).toEqual({
      kind: 'participant',
      participantIdentityId: identity.participantIdentityId,
      personId: identity.personId
    });
    expect(participantSubjectAccess(before.relationship, { kind: 'engagement', id: engagementId }))
      .toEqual({ allowed: true });

    // The organizer cancels the engagement; the session row is untouched.
    f.sqlite.query(`UPDATE engagement_heads SET state = 'cancelled' WHERE id = ?`)
      .run(engagementId);
    const after = authority(f, session.sessionToken, at(120_000));
    if (after.kind !== 'authorized') throw new Error('expected authorized');
    expect(after.relationship).toEqual({ kind: 'none' });
    expect(participantSubjectAccess(after.relationship, { kind: 'engagement', id: engagementId }))
      .toEqual({ allowed: false, reason: 'no_current_relationship' });
  });

  test('submission participant evidence relates; other people and lanes stay isolated', () => {
    const f = fixture();
    const { session, identity } = signIn(f);
    f.sqlite.query(`
      INSERT INTO intake_submission_participant_evidence (
        workspace_id, event_id, submission_id, evidence_id, person_id, participant_identity_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(laneA.workspaceId, laneA.eventId, uuid(0xf01), uuid(0xf02),
      identity.personId as string, identity.participantIdentityId as string);
    // Same person, different lane: must not leak into laneA's relationship.
    f.sqlite.query(`
      INSERT INTO intake_submission_participant_evidence (
        workspace_id, event_id, submission_id, evidence_id, person_id, participant_identity_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(laneB.workspaceId, laneB.eventId, uuid(0xf03), uuid(0xf04),
      identity.personId as string, identity.participantIdentityId as string);

    const resolved = authority(f, session.sessionToken, at(60_000));
    if (resolved.kind !== 'authorized') throw new Error('expected authorized');
    expect(resolved.relationship).toEqual({
      kind: 'related',
      submissionIds: [uuid(0xf01)],
      engagementIds: []
    });
    expect(participantSubjectAccess(resolved.relationship, { kind: 'submission', id: uuid(0xf03) }))
      .toEqual({ allowed: false, reason: 'no_current_relationship' });
  });

  test('a co-speaker reaches the shared submission through the seeded engagement (D3)', () => {
    const f = fixture();
    // Bob has no participant-evidence row (evidence is unique per submission
    // and names the primary submitter); acceptance seeded him an engagement
    // carrying the shared submission. That engagement must grant the
    // any_participant_acts relationship to the submission itself.
    const { session, identity } = signIn(f);
    const sharedSubmission = uuid(0xc01);
    const engagementId = uuid(0xc02);
    f.sqlite.query(`
      INSERT INTO engagement_heads (
        workspace_id, event_id, id, session_id, person_id, submission_id, state
      ) VALUES (?, ?, ?, ?, ?, ?, 'invited')
    `).run(laneA.workspaceId, laneA.eventId, engagementId, uuid(0xc03),
      identity.personId as string, sharedSubmission);

    const resolved = authority(f, session.sessionToken, at(60_000));
    if (resolved.kind !== 'authorized') throw new Error('expected authorized');
    expect(resolved.relationship).toEqual({
      kind: 'related',
      submissionIds: [sharedSubmission],
      engagementIds: [engagementId]
    });
    expect(participantSubjectAccess(resolved.relationship, {
      kind: 'submission', id: sharedSubmission
    })).toEqual({ allowed: true });
    expect(participantSubjectAccess(resolved.relationship, {
      kind: 'engagement', id: engagementId
    })).toEqual({ allowed: true });

    // Cancelling the engagement withdraws the shared submission with it.
    f.sqlite.query(`UPDATE engagement_heads SET state = 'cancelled' WHERE id = ?`)
      .run(engagementId);
    const after = authority(f, session.sessionToken, at(120_000));
    if (after.kind !== 'authorized') throw new Error('expected authorized');
    expect(after.relationship).toEqual({ kind: 'none' });
    expect(participantSubjectAccess(after.relationship, {
      kind: 'submission', id: sharedSubmission
    })).toEqual({ allowed: false, reason: 'no_current_relationship' });
  });

  test('identity revocation fails the next request and the next ceremony, session or not', () => {
    const f = fixture();
    const { session, identity } = signIn(f);
    f.store.revokeIdentity({
      lane: laneA,
      participantIdentityId: identity.participantIdentityId,
      now: at(90_000)
    });
    expect(authority(f, session.sessionToken, at(120_000)))
      .toEqual({ kind: 'refused', reason: 'identity_revoked' });
    expect(resolveParticipantContext({
      sessions: f.store,
      identities: f.store,
      lane: laneA,
      sessionToken: session.sessionToken,
      now: at(120_000)
    })).toEqual({ kind: 'expired', reason: 'identity_revoked' });

    const again = requestLink(f, 'speaker@example.org', {
      now: at(150_000),
      tokens: deterministicTokens(61)
    });
    expect(completeLink(f, emailedLinkToken(f, again.challengeId), { now: at(180_000) }))
      .toEqual({ kind: 'link_invalid', reason: 'identity_revoked' });
  });
});

describe('participant sign-in message rendering', () => {
  test('the link targets the short portal path on the configured origin', () => {
    const message = renderParticipantSignInLinkMessage({
      portalOrigin: PORTAL_ORIGIN,
      linkToken: 'plt1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      requestedAt: T0,
      expiresAt: at(PARTICIPANT_MAGIC_LINK_LAUNCH_TTL_MS)
    });
    expect(message.linkUrl).toBe(
      `${PORTAL_ORIGIN}/p/plt1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
    );
    expect(message.textBody).toContain(message.linkUrl);
    expect(message.htmlBody).toContain(message.linkUrl);
    expect(message.textBody).toContain('valid for 15 minutes');
    expect(message.textBody).toContain('works once');
  });

  test('a non-origin base is refused', () => {
    expect(() => renderParticipantSignInLinkMessage({
      portalOrigin: 'https://portal.example/path',
      linkToken: 'plt1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      requestedAt: T0,
      expiresAt: at(60_000)
    })).toThrow('participant_portal_origin_invalid');
  });
});
