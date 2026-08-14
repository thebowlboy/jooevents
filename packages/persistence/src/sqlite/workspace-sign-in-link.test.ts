import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';
import { issueSynchronousClassifiedPayloadEncryptionProfile } from '@jooevents/application/synchronous-classified-payload-store';
import { encodeCanonicalJson } from '@jooevents/kernel';
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
  createSQLiteWorkspaceSignInLinkDelivery,
  renderWorkspaceSignInLinkMessage,
  type WorkspaceSignInLinkDeliveryEffect
} from './workspace-sign-in-link';

const T0 = '2026-08-14T10:00:00.000Z';
const LINK_URL = 'https://app.installation.example/a/wlt1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WORKSPACE_ID = '550e8400-e29b-41d4-a716-446655440000';
const EVENT_ID = '019c1df7-86b5-769b-bba4-5f7097bfb101';

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
      reference: { key: 'encryption.workspace-sign-in-link-test', version: 1 },
      keyBytes: new Uint8Array(32).fill(0x53)
    }),
    nonceSource(size) {
      const nonce = Uint8Array.from({ length: size }, (_, index) => (nonceSeed + index * 19) % 256);
      nonceSeed += 1;
      return nonce;
    }
  });
  let idSeq = 0x2000;
  const nextUuid = () => uuid((idSeq += 1));
  const releases = new SQLiteCommunicationMessageReleaseStore(sqlite, classifiedStore, {
    newEnvelopePayloadRefId: nextUuid
  });
  const delivery = createSQLiteWorkspaceSignInLinkDelivery({
    sqlite,
    releases,
    ids: {
      newReleaseId: nextUuid,
      newDeliveryId: nextUuid,
      newEvidenceId: nextUuid
    },
    sender: { fromAddress: 'auth@installation.example', fromDisplayName: 'Example Conference' }
  });
  const ledger = new SQLiteOutboundEmailDeliveryLedger(sqlite, {
    newFactId: nextUuid,
    newPointerId: nextUuid,
    newHistoryId: nextUuid
  });
  return { sqlite, releases, delivery, ledger };
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
  overrides: Partial<WorkspaceSignInLinkDeliveryEffect> = {}
): WorkspaceSignInLinkDeliveryEffect {
  return {
    workspaceId: WORKSPACE_ID,
    eventId: EVENT_ID,
    requestId: uuid(0xf001),
    recipientEmail: 'member@example.org',
    linkUrl: LINK_URL,
    requestedAt: T0,
    expiresAt: at(15 * 60_000),
    ...overrides
  };
}

describe('workspace sign-in message rendering', () => {
  test('renders text and HTML around the short link rendered verbatim', () => {
    const message = renderWorkspaceSignInLinkMessage({
      linkUrl: LINK_URL,
      requestedAt: T0,
      expiresAt: at(15 * 60_000)
    });
    expect(message.subject).toBe('Your sign-in link');
    expect(message.textBody).toContain(LINK_URL);
    expect(message.textBody).toContain('valid for 15 minutes');
    expect(message.textBody).toContain('works once');
    // The button and the copy-paste line both carry the same short link.
    expect((message.htmlBody.match(new RegExp(`<a href="${LINK_URL}"`, 'g')) ?? []).length)
      .toBe(2);
    expect(message.htmlBody).toContain('Sign in to JooEvents');
    expect(message.htmlBody).toContain('>Sign in</a>');
  });

  test('a non-http(s) link is refused', () => {
    expect(() => renderWorkspaceSignInLinkMessage({
      linkUrl: 'ftp://app.installation.example/a/wlt1_A',
      requestedAt: T0,
      expiresAt: at(60_000)
    })).toThrow('workspace_sign_in_link_url_invalid');
  });
});

describe('workspace sign-in link delivery (persistence)', () => {
  test('enqueue returns the delivery id and pins the v2 digest over both bodies', () => {
    const f = fixture();
    const { deliveryId } = tx(f.sqlite, () => f.delivery.enqueueSignInLink(effect()));

    const head = f.ledger.read(deliveryId);
    if (!head) throw new Error('delivery head missing');
    expect(head.state).toBe('pending');
    expect(head.externalDeliveryKey).toBe('provider.not-activated');

    const release = f.releases.read(head.releaseId);
    if (!release) throw new Error('release missing');
    expect(release.purposeKey).toBe('workspace.sign-in-link');
    expect(release.envelope.textBody).toContain(LINK_URL);
    expect(release.envelope.htmlBody).toBeDefined();
    expect(release.envelope.htmlBody).toContain(LINK_URL);
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
      .toThrow('workspace_sign_in_link_delivery_transaction_required');
  });
});
