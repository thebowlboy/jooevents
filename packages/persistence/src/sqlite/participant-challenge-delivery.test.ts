import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';
import { issueSynchronousClassifiedPayloadEncryptionProfile } from '@jooevents/application/synchronous-classified-payload-store';
import {
  PARTICIPANT_SIGN_IN_CHALLENGE_PURPOSE,
  type ParticipantSignInLinkDeliveryEffect
} from '@jooevents/identity-access';
import { encodeCanonicalJson, parseEventId, parseWorkspaceId } from '@jooevents/kernel';
import {
  installSQLiteClassifiedPayloadStoreSchema,
  SQLiteClassifiedPayloadStore
} from './sqlite-classified-payload-store';
import {
  installSQLiteOutboundEmailDeliverySchema,
  SQLiteOutboundEmailDeliveryLedger
} from './outbound-email-delivery';
import {
  installSQLiteCommunicationMessageReleaseSchema,
  SQLiteCommunicationMessageReleaseStore
} from './communications/message-releases';
import {
  createSQLiteParticipantChallengeDelivery,
  renderParticipantSignInLinkMessage
} from './participant-challenge-delivery';

const T0 = '2026-08-14T10:00:00.000Z';
const PORTAL_ORIGIN = 'https://portal.installation.example';
const LINK_TOKEN = 'plt1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const lane = Object.freeze({
  workspaceId: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  eventId: parseEventId('019c1df7-86b5-769b-bba4-5f7097bfb101')
});

function at(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

function uuid(suffix: number): string {
  return `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

const databases: Database[] = [];
afterEach(() => {
  for (const sqlite of databases.splice(0)) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    sqlite.close(false);
  }
});

function fixture() {
  const sqlite = new Database(':memory:', { strict: true });
  databases.push(sqlite);
  installSQLiteClassifiedPayloadStoreSchema(sqlite);
  installSQLiteCommunicationMessageReleaseSchema(sqlite);
  installSQLiteOutboundEmailDeliverySchema(sqlite);

  let nonceSeed = 1;
  const classifiedStore = new SQLiteClassifiedPayloadStore(sqlite, {
    encryptionProfile: issueSynchronousClassifiedPayloadEncryptionProfile({
      reference: { key: 'encryption.participant-challenge-delivery-test', version: 1 },
      keyBytes: new Uint8Array(32).fill(0x41)
    }),
    nonceSource(size) {
      const nonce = Uint8Array.from({ length: size }, (_, index) => (nonceSeed + index * 19) % 256);
      nonceSeed += 1;
      return nonce;
    }
  });
  let idSeq = 0x3000;
  const nextUuid = () => uuid((idSeq += 1));
  const releases = new SQLiteCommunicationMessageReleaseStore(sqlite, classifiedStore, {
    newEnvelopePayloadRefId: nextUuid
  });
  const challengeLinks: { challengeId: string; deliveryId: string }[] = [];
  const delivery = createSQLiteParticipantChallengeDelivery({
    sqlite,
    releases,
    ids: {
      newReleaseId: nextUuid,
      newDeliveryId: nextUuid,
      newEvidenceId: nextUuid
    },
    senderResolver: {
      resolve: () => ({ fromAddress: 'auth@installation.example', source: 'installation' })
    },
    portalOrigin: PORTAL_ORIGIN,
    challenges: {
      linkChallengeDelivery(link) {
        challengeLinks.push({ ...link });
      }
    }
  });
  const ledger = new SQLiteOutboundEmailDeliveryLedger(sqlite, {
    newFactId: nextUuid,
    newPointerId: nextUuid,
    newHistoryId: nextUuid
  });
  return { sqlite, releases, delivery, ledger, challengeLinks };
}

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

function effect(
  overrides: Partial<ParticipantSignInLinkDeliveryEffect> = {}
): ParticipantSignInLinkDeliveryEffect {
  return {
    kind: 'participant_sign_in_link',
    purpose: PARTICIPANT_SIGN_IN_CHALLENGE_PURPOSE,
    lane,
    challengeId: uuid(0xe001),
    receiptId: uuid(0xe002),
    recipientEmail: 'speaker@example.org',
    linkToken: LINK_TOKEN,
    requestedAt: T0,
    expiresAt: at(15 * 60_000),
    ...overrides
  };
}

describe('participant sign-in message rendering', () => {
  test('renders text and HTML around the short portal link', () => {
    const message = renderParticipantSignInLinkMessage({
      portalOrigin: PORTAL_ORIGIN,
      linkToken: LINK_TOKEN,
      requestedAt: T0,
      expiresAt: at(15 * 60_000)
    });
    expect(message.subject).toBe('Your sign-in link');
    expect(message.linkUrl).toBe(`${PORTAL_ORIGIN}/p/${LINK_TOKEN}`);
    expect(message.textBody).toContain(message.linkUrl);
    expect(message.textBody).toContain('valid for 15 minutes');
    // The button and the copy-paste line both carry the same short link.
    expect((message.htmlBody.match(new RegExp(`<a href="${PORTAL_ORIGIN}/p/${LINK_TOKEN}"`, 'g'))
      ?? []).length).toBe(2);
    expect(message.htmlBody).toContain('Sign in to JooEvents');
    expect(message.htmlBody).toContain(
      '<img src="https://jooevents.com/assets/jooevents-wordmark.png" width="136" height="24" alt="JooEvents"'
    );
    expect(message.htmlBody).toContain('background-color:#b05a4f;border-radius:6px');
  });

  test('a token that is not path-safe is percent-encoded into the short link', () => {
    const message = renderParticipantSignInLinkMessage({
      portalOrigin: PORTAL_ORIGIN,
      linkToken: 'plt1_A/B?C',
      requestedAt: T0,
      expiresAt: at(60_000)
    });
    expect(message.linkUrl).toBe(`${PORTAL_ORIGIN}/p/plt1_A%2FB%3FC`);
  });

  test('a non-origin portal base is refused', () => {
    expect(() => renderParticipantSignInLinkMessage({
      portalOrigin: 'https://portal.example/path',
      linkToken: LINK_TOKEN,
      requestedAt: T0,
      expiresAt: at(60_000)
    })).toThrow('participant_portal_origin_invalid');
  });
});

describe('participant challenge delivery (persistence)', () => {
  test('enqueue returns the delivery id and pins the v2 digest over both bodies', () => {
    const f = fixture();
    const { deliveryId } = tx(f.sqlite, () => f.delivery.enqueueSignInLink(effect()));
    expect(f.challengeLinks).toEqual([{ challengeId: uuid(0xe001), deliveryId }]);

    const head = f.ledger.read(deliveryId);
    if (!head) throw new Error('delivery head missing');
    expect(head.state).toBe('pending');

    const release = f.releases.read(head.releaseId);
    if (!release) throw new Error('release missing');
    expect(release.purposeKey).toBe(PARTICIPANT_SIGN_IN_CHALLENGE_PURPOSE);
    expect(release.envelope.textBody).toContain(`${PORTAL_ORIGIN}/p/${LINK_TOKEN}`);
    expect(release.envelope.htmlBody).toBeDefined();
    expect(release.envelope.htmlBody).toContain(`${PORTAL_ORIGIN}/p/${LINK_TOKEN}`);
    expect(release.reviewedMessageDigestSha256).toBe(digest({
      schemaVersion: 2,
      subject: release.envelope.subject,
      textBody: release.envelope.textBody,
      htmlBody: release.envelope.htmlBody
    }));
    expect(head.reviewedMessageDigestSha256).toBe(release.reviewedMessageDigestSha256);
    expect(head.reviewedEnvelopeDigestSha256).toBe(release.reviewedEnvelopeDigestSha256);
  });

  test('an inline send is impossible: enqueue refuses to run without a transaction', () => {
    const f = fixture();
    expect(() => f.delivery.enqueueSignInLink(effect()))
      .toThrow('participant_challenge_delivery_transaction_required');
  });
});
