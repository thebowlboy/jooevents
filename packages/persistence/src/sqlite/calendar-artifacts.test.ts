import { afterEach, describe, expect, test } from 'bun:test';
import { issueSynchronousClassifiedPayloadEncryptionProfile } from
  '@jooevents/application/synchronous-classified-payload-store';
import { openSQLite, type OpenSQLiteResult } from './database';
import { SQLiteClassifiedPayloadStore } from './sqlite-classified-payload-store';
import { SQLiteCalendarNoticeArtifactStore } from './calendar-artifacts';

const opened: OpenSQLiteResult[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()?.sqlite.close();
});

describe('SQLite calendar notice artifacts', () => {
  test('encrypts immutable bytes and resolves them after constructing a fresh adapter', () => {
    const runtime = openSQLite(':memory:');
    opened.push(runtime);
    const classified = new SQLiteClassifiedPayloadStore(runtime.sqlite, {
      encryptionProfile: issueSynchronousClassifiedPayloadEncryptionProfile({
        reference: { key: 'encryption.calendar-artifact-test', version: 1 },
        keyBytes: Uint8Array.from({ length: 32 }, (_, index) => index + 1)
      }),
      nonceSource: (size) => Uint8Array.from({ length: size }, (_, index) => index + 9)
    });
    const store = new SQLiteCalendarNoticeArtifactStore(runtime.sqlite, classified);
    const bytes = new TextEncoder().encode('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
    runtime.sqlite.exec('BEGIN IMMEDIATE;');
    const reference = store.put({
      payloadRefId: '60000000-0000-4000-8000-000000000001',
      workspaceId: '60000000-0000-4000-8000-000000000002',
      eventId: '60000000-0000-4000-8000-000000000003',
      generationId: '60000000-0000-4000-8000-000000000004',
      method: 'REQUEST', bytes, createdAt: '2026-08-18T01:00:00.000Z'
    });
    runtime.sqlite.exec('COMMIT;');
    expect(reference).toMatchObject({
      contentBytesRef: '60000000-0000-4000-8000-000000000001',
      filename: 'calendar-update.ics', method: 'REQUEST', byteLength: bytes.byteLength
    });
    expect(new SQLiteCalendarNoticeArtifactStore(runtime.sqlite, classified)
      .resolveContentBytes(reference.contentBytesRef)).toEqual(bytes);
    const stored = runtime.sqlite.query<{ plaintext: string }, []>(`
      SELECT CAST(ciphertext AS TEXT) AS plaintext FROM classified_payload_records
    `).get();
    expect(stored?.plaintext).not.toContain('VCALENDAR');
  });
});
