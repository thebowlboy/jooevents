import { describe, expect, test } from 'bun:test';
import { parseCeremonyEvidenceId } from '@jooevents/kernel';
import { openSQLite } from './database';
import {
  assertIntakeParticipantAttributionSource,
  createSQLiteCeremonyMintedIntakeParticipantAttributionSource,
  createSQLiteIntakeParticipantAttributionConformance,
  installSQLiteIntakeParticipantAttributionConformanceSchema
} from './intake-participant-attribution-conformance';

const id = (suffix: number): string =>
  `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;

describe('SQLite Intake participant attribution conformance source', () => {
  test('requires one transaction-local exact partition and prevents cross-role identity swaps', () => {
    const { sqlite } = openSQLite(':memory:');
    try {
      installSQLiteIntakeParticipantAttributionConformanceSchema(sqlite);
      const source = createSQLiteIntakeParticipantAttributionConformance(sqlite);
      expect(() => assertIntakeParticipantAttributionSource({ resolve: () => undefined }))
        .toThrow('intake_participant_attribution_source_unsealed');
      expect(() => source.resolve({
        ceremonyEvidenceId: parseCeremonyEvidenceId(id(1)),
        authorityPartitionDigestSha256: 'a'.repeat(64)
      })).toThrow('intake_participant_transaction_required');

      sqlite.exec('BEGIN IMMEDIATE');
      source.register({
        ceremonyEvidenceId: parseCeremonyEvidenceId(id(1)),
        authorityPartitionDigestSha256: 'a'.repeat(64),
        personId: id(2),
        participantIdentityId: id(3),
        evidenceIds: ['conformance:participant-one']
      });
      sqlite.exec('COMMIT');

      sqlite.exec('BEGIN IMMEDIATE');
      expect(source.resolve({
        ceremonyEvidenceId: parseCeremonyEvidenceId(id(1)),
        authorityPartitionDigestSha256: 'b'.repeat(64)
      })).toBeUndefined();
      expect(source.resolve({
        ceremonyEvidenceId: parseCeremonyEvidenceId(id(1)),
        authorityPartitionDigestSha256: 'a'.repeat(64)
      })).toEqual({
        personId: id(2),
        participantIdentityId: id(3),
        evidenceIds: ['conformance:participant-one']
      });
      expect(() => source.register({
        ceremonyEvidenceId: parseCeremonyEvidenceId(id(4)),
        authorityPartitionDigestSha256: 'c'.repeat(64),
        personId: id(3),
        participantIdentityId: id(2),
        evidenceIds: ['conformance:participant-two']
      })).toThrow('intake participant attribution role collision');
      expect(sqlite.query<{ readonly total: number }, []>(`
        SELECT count(*) AS total FROM intake_participant_attribution_conformance
      `).get()?.total).toBe(1);
      sqlite.exec('ROLLBACK');
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      sqlite.close();
    }
  });

  test('ceremony-minted attribution mints one immutable identity per ceremony, idempotently', () => {
    const { sqlite } = openSQLite(':memory:');
    try {
      installSQLiteIntakeParticipantAttributionConformanceSchema(sqlite);
      let minted = 0x10;
      const source = createSQLiteCeremonyMintedIntakeParticipantAttributionSource(sqlite, {
        newPersonId: () => id(minted++),
        newParticipantIdentityId: () => id(minted++)
      });
      assertIntakeParticipantAttributionSource(source);

      sqlite.exec('BEGIN IMMEDIATE');
      const first = source.resolve({
        ceremonyEvidenceId: parseCeremonyEvidenceId(id(1)),
        authorityPartitionDigestSha256: 'a'.repeat(64)
      });
      expect(first).toEqual({
        personId: id(0x10),
        participantIdentityId: id(0x11),
        evidenceIds: [`public-ceremony:${id(1)}`]
      });
      const replayed = source.resolve({
        ceremonyEvidenceId: parseCeremonyEvidenceId(id(1)),
        authorityPartitionDigestSha256: 'a'.repeat(64)
      });
      expect(replayed).toEqual(first);
      // A different principal partition never resolves (and never re-mints)
      // the ceremony's identity: the registered row already owns the ceremony.
      expect(() => source.resolve({
        ceremonyEvidenceId: parseCeremonyEvidenceId(id(1)),
        authorityPartitionDigestSha256: 'b'.repeat(64)
      })).toThrow();
      const second = source.resolve({
        ceremonyEvidenceId: parseCeremonyEvidenceId(id(2)),
        authorityPartitionDigestSha256: 'b'.repeat(64)
      });
      expect(second?.personId).not.toBe(first?.personId);
      expect(second?.participantIdentityId).not.toBe(first?.participantIdentityId);
      expect(sqlite.query<{ readonly total: number }, []>(`
        SELECT count(*) AS total FROM intake_participant_attribution_conformance
      `).get()?.total).toBe(2);
      sqlite.exec('COMMIT');
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      sqlite.close();
    }
  });
});
