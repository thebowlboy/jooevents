import type { Database } from 'bun:sqlite';
import { intakeDigestSchema, intakeIdSchema } from '@jooevents/contracts';
import { canonicalJsonText, parseCeremonyEvidenceId, type CeremonyEvidenceId } from '@jooevents/kernel';

export const SQLITE_INTAKE_PARTICIPANT_ATTRIBUTION_CONFORMANCE_SQL = `
CREATE TABLE intake_participant_attribution_conformance (
  ceremony_evidence_id TEXT PRIMARY KEY,
  authority_partition_digest_sha256 TEXT NOT NULL CHECK(
    length(authority_partition_digest_sha256) = 64
    AND authority_partition_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  person_id TEXT NOT NULL UNIQUE CHECK(length(person_id) = 36 AND person_id = lower(person_id)),
  participant_identity_id TEXT NOT NULL UNIQUE
    CHECK(length(participant_identity_id) = 36 AND participant_identity_id = lower(participant_identity_id)),
  evidence_ids_json TEXT NOT NULL CHECK(
    json_valid(evidence_ids_json) AND json_type(evidence_ids_json) = 'array'
    AND json_array_length(evidence_ids_json) BETWEEN 1 AND 16
  )
) STRICT, WITHOUT ROWID;

CREATE TRIGGER intake_participant_attribution_conformance_role_collision
BEFORE INSERT ON intake_participant_attribution_conformance
WHEN NEW.person_id = NEW.participant_identity_id
  OR EXISTS (
    SELECT 1 FROM intake_participant_attribution_conformance
     WHERE person_id = NEW.participant_identity_id
        OR participant_identity_id = NEW.person_id
  )
BEGIN SELECT RAISE(ABORT, 'intake participant attribution role collision'); END;

CREATE TRIGGER intake_participant_attribution_conformance_no_update
BEFORE UPDATE ON intake_participant_attribution_conformance
BEGIN SELECT RAISE(ABORT, 'intake participant attribution is immutable'); END;
CREATE TRIGGER intake_participant_attribution_conformance_no_delete
BEFORE DELETE ON intake_participant_attribution_conformance
BEGIN SELECT RAISE(ABORT, 'intake participant attribution is immutable'); END;
`;

export function installSQLiteIntakeParticipantAttributionConformanceSchema(
  sqlite: Database
): void {
  if (sqlite.inTransaction) throw new TypeError('intake_participant_schema_inside_transaction');
  sqlite.exec(SQLITE_INTAKE_PARTICIPANT_ATTRIBUTION_CONFORMANCE_SQL);
}

export interface IntakeParticipantAttribution {
  readonly personId: string;
  readonly participantIdentityId: string;
  readonly evidenceIds: readonly string[];
}

export interface IntakeParticipantAttributionSource {
  resolve(input: {
    readonly ceremonyEvidenceId: CeremonyEvidenceId;
    readonly authorityPartitionDigestSha256: string;
  }): IntakeParticipantAttribution | undefined;
}

export interface SQLiteIntakeParticipantAttributionConformance
extends IntakeParticipantAttributionSource {
  register(input: {
    readonly ceremonyEvidenceId: CeremonyEvidenceId;
    readonly authorityPartitionDigestSha256: string;
    readonly personId: string;
    readonly participantIdentityId: string;
    readonly evidenceIds: readonly string[];
  }): void;
}

const issuedSources = new WeakSet<object>();

function evidenceIds(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 16) {
    throw new TypeError('intake_participant_attribution_invalid');
  }
  const canonical = [...new Set(values.map((value) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 240
        || value.trim() !== value || value.includes('\0')) {
      throw new TypeError('intake_participant_attribution_invalid');
    }
    return value;
  }))].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (canonical.length !== values.length) {
    throw new TypeError('intake_participant_attribution_invalid');
  }
  return Object.freeze(canonical);
}

export function createSQLiteIntakeParticipantAttributionConformance(
  sqlite: Database
): SQLiteIntakeParticipantAttributionConformance {
  const source: SQLiteIntakeParticipantAttributionConformance = Object.freeze({
    register(input: Parameters<SQLiteIntakeParticipantAttributionConformance['register']>[0]) {
      if (!sqlite.inTransaction) throw new TypeError('intake_participant_transaction_required');
      const canonicalEvidence = evidenceIds(input.evidenceIds);
      sqlite.query(`
        INSERT INTO intake_participant_attribution_conformance (
          ceremony_evidence_id, authority_partition_digest_sha256,
          person_id, participant_identity_id, evidence_ids_json
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        parseCeremonyEvidenceId(input.ceremonyEvidenceId),
        intakeDigestSchema.parse(input.authorityPartitionDigestSha256),
        intakeIdSchema.parse(input.personId),
        intakeIdSchema.parse(input.participantIdentityId),
        canonicalJsonText(canonicalEvidence)
      );
    },
    resolve(input: Parameters<IntakeParticipantAttributionSource['resolve']>[0]) {
      if (!sqlite.inTransaction) throw new TypeError('intake_participant_transaction_required');
      const row = sqlite.query<{
        readonly authority_partition_digest_sha256: string;
        readonly person_id: string;
        readonly participant_identity_id: string;
        readonly evidence_ids_json: string;
      }, [string]>(`
        SELECT authority_partition_digest_sha256, person_id,
               participant_identity_id, evidence_ids_json
          FROM intake_participant_attribution_conformance
         WHERE ceremony_evidence_id = ? LIMIT 2
      `).get(parseCeremonyEvidenceId(input.ceremonyEvidenceId));
      if (!row || row.authority_partition_digest_sha256
          !== intakeDigestSchema.parse(input.authorityPartitionDigestSha256)) return undefined;
      let parsedEvidence: readonly string[];
      try {
        const parsed: unknown = JSON.parse(row.evidence_ids_json);
        if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
          throw new TypeError();
        }
        parsedEvidence = evidenceIds(parsed as string[]);
        if (canonicalJsonText(parsedEvidence) !== row.evidence_ids_json) throw new TypeError();
      } catch {
        throw new TypeError('intake_participant_attribution_corrupt');
      }
      return Object.freeze({
        personId: intakeIdSchema.parse(row.person_id),
        participantIdentityId: intakeIdSchema.parse(row.participant_identity_id),
        evidenceIds: parsedEvidence
      });
    }
  });
  issuedSources.add(source);
  return source;
}

export function assertIntakeParticipantAttributionSource(
  source: IntakeParticipantAttributionSource
): void {
  if (!issuedSources.has(source)) throw new TypeError('intake_participant_attribution_source_unsealed');
}
