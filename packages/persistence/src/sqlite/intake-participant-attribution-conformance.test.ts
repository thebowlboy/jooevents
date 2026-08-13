import { describe, expect, test } from 'bun:test';
import { parseCeremonyEvidenceId } from '@jooevents/kernel';
import { openSQLite } from './database';
import {
  assertIntakeParticipantAttributionSource,
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
});
