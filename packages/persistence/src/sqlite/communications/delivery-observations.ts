import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { safeEvidenceSchema, type SafeEvidence } from '@jooevents/contracts';
import { canonicalJsonText, parseInstant, parseWorkspaceId, parseEventId } from '@jooevents/kernel';

export type CommunicationDeliveryObservationKind =
  | 'delivered'
  | 'permanent_bounce'
  | 'delivery_failed';

export type CommunicationDeliveryEvidenceSource =
  | 'synchronous_response'
  | 'provider_lookup'
  | 'verified_ingress';

export interface CommunicationDeliveryObservation {
  readonly observationId: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly deliveryId: string;
  readonly attemptId: string | null;
  readonly providerConnectionRevisionId: string;
  readonly adapterKey: string;
  readonly providerMessageId: string | null;
  readonly providerEventKey: string;
  readonly providerEventDigestSha256: string;
  readonly kind: CommunicationDeliveryObservationKind;
  readonly source: CommunicationDeliveryEvidenceSource;
  readonly quality: 'provider_conclusive' | 'provider_reported';
  readonly providerObservedAt: string | null;
  readonly ingestedAt: string;
  readonly safeEvidence: SafeEvidence;
}

export interface CommunicationDeliveryDisposition {
  readonly kind: CommunicationDeliveryObservationKind;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly attemptKind: 'original' | 'marked_resend';
  readonly evidenceClass: 'submission_attempt' | 'provider_observation';
  readonly evidenceId: string;
  readonly evidenceDigestSha256: string;
  readonly observedAt: string;
}

export type SQLiteCommunicationDeliveryObservationErrorCode =
  | 'transaction_required'
  | 'invalid_input'
  | 'delivery_not_found'
  | 'provider_event_conflict'
  | 'data_corrupt';

export class SQLiteCommunicationDeliveryObservationError extends Error {
  constructor(readonly code: SQLiteCommunicationDeliveryObservationErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteCommunicationDeliveryObservationError';
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonText(value), 'utf8').digest('hex');
}

function deterministicUuid(namespace: string, material: unknown): string {
  const hex = digest({ namespace, material });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function instantMs(value: string): number {
  return Date.parse(parseInstant(value));
}

function bounded(value: string, maximum: number): string {
  if (value.length < 1 || value.length > maximum) {
    throw new SQLiteCommunicationDeliveryObservationError('invalid_input');
  }
  return value;
}

function dispositionFromEvidence(evidence: SafeEvidence): CommunicationDeliveryObservationKind | undefined {
  const observation = evidence.registeredFacts.find((fact) =>
    fact.factKey === 'cloudflare.observation' && fact.valueKind === 'enum'
  );
  if (observation?.valueKind !== 'enum') return undefined;
  switch (observation.enumValue) {
    case 'accepted_delivered': return 'delivered';
    case 'accepted_permanent_bounce': return 'permanent_bounce';
    case 'delivery_failed': return 'delivery_failed';
    default: return undefined;
  }
}

interface ObservationRow {
  readonly observation_id: string;
  readonly workspace_id: string;
  readonly event_id: string;
  readonly delivery_id: string;
  readonly attempt_id: string | null;
  readonly provider_connection_revision_id: string;
  readonly adapter_key: string;
  readonly provider_message_id: string | null;
  readonly provider_event_key: string;
  readonly provider_event_digest_sha256: string;
  readonly observation_kind: CommunicationDeliveryObservationKind;
  readonly evidence_source: CommunicationDeliveryEvidenceSource;
  readonly evidence_quality: 'provider_conclusive' | 'provider_reported';
  readonly provider_observed_at_ms: number | null;
  readonly ingested_at_ms: number;
  readonly safe_evidence_json: string;
}

function observationFromRow(row: ObservationRow): CommunicationDeliveryObservation {
  try {
    return Object.freeze({
      observationId: row.observation_id,
      workspaceId: row.workspace_id,
      eventId: row.event_id,
      deliveryId: row.delivery_id,
      attemptId: row.attempt_id,
      providerConnectionRevisionId: row.provider_connection_revision_id,
      adapterKey: row.adapter_key,
      providerMessageId: row.provider_message_id,
      providerEventKey: row.provider_event_key,
      providerEventDigestSha256: row.provider_event_digest_sha256,
      kind: row.observation_kind,
      source: row.evidence_source,
      quality: row.evidence_quality,
      providerObservedAt: row.provider_observed_at_ms === null
        ? null : new Date(row.provider_observed_at_ms).toISOString(),
      ingestedAt: new Date(row.ingested_at_ms).toISOString(),
      safeEvidence: safeEvidenceSchema.parse(JSON.parse(row.safe_evidence_json))
    });
  } catch (error) {
    throw new SQLiteCommunicationDeliveryObservationError('data_corrupt', error);
  }
}

const OBSERVATION_COLUMNS = `
  observation_id,workspace_id,event_id,delivery_id,attempt_id,
  provider_connection_revision_id,adapter_key,provider_message_id,provider_event_key,
  provider_event_digest_sha256,observation_kind,evidence_source,evidence_quality,
  provider_observed_at_ms,ingested_at_ms,safe_evidence_json`;

/**
 * Transaction-borrowing writer and evidence fold for delivery observations.
 * Submission attempts remain first-hand evidence; these rows are later provider evidence.
 */
export class SQLiteCommunicationDeliveryObservationRepository {
  constructor(private readonly sqlite: Database) {}

  list(deliveryId: string): readonly CommunicationDeliveryObservation[] {
    bounded(deliveryId, 512);
    const rows = this.sqlite.query<ObservationRow, [string]>(`
      SELECT ${OBSERVATION_COLUMNS} FROM communication_delivery_observations
       WHERE delivery_id=?
       ORDER BY coalesce(provider_observed_at_ms,ingested_at_ms),observation_id
    `).all(deliveryId);
    return Object.freeze(rows.map(observationFromRow));
  }

  append(input: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly deliveryId: string;
    readonly attemptId?: string;
    readonly providerConnectionRevisionId: string;
    readonly adapterKey: string;
    readonly providerMessageId?: string;
    readonly providerEventKey: string;
    readonly kind: CommunicationDeliveryObservationKind;
    readonly source: CommunicationDeliveryEvidenceSource;
    readonly quality: 'provider_conclusive' | 'provider_reported';
    readonly providerObservedAt?: string;
    readonly ingestedAt: string;
    readonly safeEvidence: unknown;
    readonly rawPayloadRefId?: string;
  }): { readonly replayed: boolean; readonly observation: CommunicationDeliveryObservation } {
    if (!this.sqlite.inTransaction) {
      throw new SQLiteCommunicationDeliveryObservationError('transaction_required');
    }
    let workspaceId: string;
    let eventId: string;
    let evidence: SafeEvidence;
    try {
      workspaceId = parseWorkspaceId(input.workspaceId);
      eventId = parseEventId(input.eventId);
      evidence = safeEvidenceSchema.parse(input.safeEvidence);
      if (dispositionFromEvidence(evidence) !== input.kind) {
        throw new SQLiteCommunicationDeliveryObservationError('invalid_input');
      }
      bounded(input.deliveryId, 512);
      bounded(input.providerConnectionRevisionId, 512);
      bounded(input.adapterKey, 160);
      bounded(input.providerEventKey, 512);
    } catch (error) {
      if (error instanceof SQLiteCommunicationDeliveryObservationError) throw error;
      throw new SQLiteCommunicationDeliveryObservationError('invalid_input', error);
    }
    const ingestedAtMs = instantMs(input.ingestedAt);
    const providerObservedAtMs = input.providerObservedAt === undefined
      ? null : instantMs(input.providerObservedAt);
    const head = this.sqlite.query<{
      readonly provider_connection_revision_id: string;
      readonly address_lookup_fingerprint_profile: string;
      readonly address_lookup_fingerprint_version: number;
      readonly address_lookup_fingerprint_sha256: string;
      readonly channel_address_id: string;
      readonly channel_address_version: number;
    }, [string, string, string]>(`
      SELECT provider_connection_revision_id,address_lookup_fingerprint_profile,
             address_lookup_fingerprint_version,address_lookup_fingerprint_sha256,
             channel_address_id,channel_address_version
        FROM communication_outbound_delivery_heads
       WHERE workspace_id=? AND event_id=? AND delivery_id=? LIMIT 2
    `).all(workspaceId, eventId, input.deliveryId);
    if (head.length === 0) {
      throw new SQLiteCommunicationDeliveryObservationError('delivery_not_found');
    }
    if (head.length !== 1
        || head[0]!.provider_connection_revision_id !== input.providerConnectionRevisionId) {
      throw new SQLiteCommunicationDeliveryObservationError('data_corrupt');
    }

    let attemptId = input.attemptId ?? null;
    if (attemptId === null && input.providerMessageId !== undefined) {
      const matches = this.sqlite.query<{ readonly attempt_id: string }, [string, string]>(`
        SELECT attempt_id FROM communication_outbound_delivery_attempts
         WHERE delivery_id=? AND provider_message_id=? ORDER BY attempt_number DESC LIMIT 2
      `).all(input.deliveryId, input.providerMessageId);
      if (matches.length > 1) throw new SQLiteCommunicationDeliveryObservationError('data_corrupt');
      attemptId = matches[0]?.attempt_id ?? null;
    }
    if (attemptId !== null) {
      const attempt = this.sqlite.query<{ readonly provider_message_id: string | null }, [string, string]>(`
        SELECT provider_message_id FROM communication_outbound_delivery_attempts
         WHERE delivery_id=? AND attempt_id=? LIMIT 2
      `).all(input.deliveryId, attemptId);
      if (attempt.length !== 1
          || (input.providerMessageId !== undefined
            && attempt[0]!.provider_message_id !== input.providerMessageId)) {
        throw new SQLiteCommunicationDeliveryObservationError('invalid_input');
      }
    }
    const eventMaterial = Object.freeze({
      workspaceId,
      eventId,
      deliveryId: input.deliveryId,
      attemptId,
      providerConnectionRevisionId: input.providerConnectionRevisionId,
      adapterKey: input.adapterKey,
      providerMessageId: input.providerMessageId ?? null,
      providerEventKey: input.providerEventKey,
      kind: input.kind,
      source: input.source,
      quality: input.quality,
      providerObservedAtMs,
      evidenceDigestSha256: evidence.canonicalDigestSha256,
      rawPayloadRefId: input.rawPayloadRefId ?? null
    });
    const eventDigest = digest(eventMaterial);
    const existing = this.sqlite.query<ObservationRow, [string, string]>(`
      SELECT ${OBSERVATION_COLUMNS} FROM communication_delivery_observations
       WHERE provider_connection_revision_id=? AND provider_event_key=? LIMIT 2
    `).all(input.providerConnectionRevisionId, input.providerEventKey);
    if (existing.length > 1) throw new SQLiteCommunicationDeliveryObservationError('data_corrupt');
    if (existing[0] !== undefined) {
      if (existing[0].provider_event_digest_sha256 !== eventDigest) {
        throw new SQLiteCommunicationDeliveryObservationError('provider_event_conflict');
      }
      return Object.freeze({ replayed: true, observation: observationFromRow(existing[0]) });
    }
    const observationId = deterministicUuid('communication.delivery-observation', {
      providerConnectionRevisionId: input.providerConnectionRevisionId,
      providerEventKey: input.providerEventKey
    });
    const providerMessageFingerprint = digest({
      providerConnectionRevisionId: input.providerConnectionRevisionId,
      providerMessageId: input.providerMessageId ?? null,
      deliveryId: input.deliveryId
    });
    this.sqlite.query(`
      INSERT INTO communication_delivery_observations (
        ${OBSERVATION_COLUMNS},provider_message_fingerprint_sha256,raw_payload_ref_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      observationId, workspaceId, eventId, input.deliveryId, attemptId,
      input.providerConnectionRevisionId, input.adapterKey, input.providerMessageId ?? null,
      input.providerEventKey, eventDigest, input.kind, input.source, input.quality,
      providerObservedAtMs, ingestedAtMs, canonicalJsonText(evidence),
      providerMessageFingerprint, input.rawPayloadRefId ?? null
    );

    if (input.kind === 'permanent_bounce') {
      const address = head[0]!;
      const factId = deterministicUuid('communication.address-suppression', observationId);
      this.sqlite.query(`
        INSERT INTO communication_address_suppression_facts (
          suppression_fact_id,workspace_id,source_event_id,address_ref_id,address_version,
          lookup_profile,lookup_version,lookup_keyed_value,state,reason,observation_id,
          occurred_at_ms,safe_evidence_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        factId, workspaceId, eventId, address.channel_address_id,
        address.channel_address_version, address.address_lookup_fingerprint_profile,
        address.address_lookup_fingerprint_version, address.address_lookup_fingerprint_sha256,
        'suppressed', 'provider_permanent_bounce', observationId,
        providerObservedAtMs ?? ingestedAtMs, canonicalJsonText(evidence)
      );
      this.sqlite.query(`
        INSERT INTO communication_current_address_suppressions (
          workspace_id,lookup_profile,lookup_version,lookup_keyed_value,
          current_fact_id,state,version,updated_at_ms
        ) VALUES (?,?,?,?,?,'suppressed',1,?)
        ON CONFLICT(workspace_id,lookup_profile,lookup_version,lookup_keyed_value)
        DO UPDATE SET current_fact_id=excluded.current_fact_id,state='suppressed',
                      version=communication_current_address_suppressions.version+1,
                      updated_at_ms=max(communication_current_address_suppressions.updated_at_ms,
                                        excluded.updated_at_ms)
      `).run(
        workspaceId, address.address_lookup_fingerprint_profile,
        address.address_lookup_fingerprint_version, address.address_lookup_fingerprint_sha256,
        factId, providerObservedAtMs ?? ingestedAtMs
      );
    }
    const row = this.sqlite.query<ObservationRow, [string]>(`
      SELECT ${OBSERVATION_COLUMNS} FROM communication_delivery_observations
       WHERE observation_id=?
    `).get(observationId);
    if (row === null || row === undefined) {
      throw new SQLiteCommunicationDeliveryObservationError('data_corrupt');
    }
    return Object.freeze({ replayed: false, observation: observationFromRow(row) });
  }

  currentDisposition(deliveryId: string): CommunicationDeliveryDisposition | undefined {
    const attempts = this.sqlite.query<{
      readonly attempt_id: string;
      readonly attempt_number: number;
      readonly attempt_kind: 'original' | 'marked_resend';
      readonly safe_evidence_json: string | null;
      readonly completed_at_ms: number | null;
    }, [string]>(`
      SELECT attempt_id,attempt_number,attempt_kind,safe_evidence_json,completed_at_ms
        FROM communication_outbound_delivery_attempts
       WHERE delivery_id=? ORDER BY attempt_number DESC
    `).all(deliveryId);
    const observations = this.sqlite.query<ObservationRow & {
      readonly attempt_number: number | null;
      readonly attempt_kind: 'original' | 'marked_resend' | null;
    }, [string]>(`
      SELECT o.${OBSERVATION_COLUMNS.replaceAll(',', ',o.')},
             a.attempt_number,a.attempt_kind
        FROM communication_delivery_observations o
        LEFT JOIN communication_outbound_delivery_attempts a ON a.attempt_id=o.attempt_id
       WHERE o.delivery_id=?
       ORDER BY coalesce(a.attempt_number,0) DESC,
                coalesce(o.provider_observed_at_ms,o.ingested_at_ms) DESC,o.observation_id DESC
    `).all(deliveryId);
    const candidates: CommunicationDeliveryDisposition[] = [];
    for (const attempt of attempts) {
      if (attempt.safe_evidence_json === null || attempt.completed_at_ms === null) continue;
      let evidence: SafeEvidence;
      try {
        evidence = safeEvidenceSchema.parse(JSON.parse(attempt.safe_evidence_json));
      } catch (error) {
        throw new SQLiteCommunicationDeliveryObservationError('data_corrupt', error);
      }
      const kind = dispositionFromEvidence(evidence);
      if (kind !== undefined) candidates.push(Object.freeze({
        kind,
        attemptId: attempt.attempt_id,
        attemptNumber: attempt.attempt_number,
        attemptKind: attempt.attempt_kind,
        evidenceClass: 'submission_attempt',
        evidenceId: attempt.attempt_id,
        evidenceDigestSha256: evidence.canonicalDigestSha256,
        observedAt: new Date(attempt.completed_at_ms).toISOString()
      }));
    }
    for (const row of observations) {
      if (row.attempt_id === null || row.attempt_number === null || row.attempt_kind === null) continue;
      candidates.push(Object.freeze({
        kind: row.observation_kind,
        attemptId: row.attempt_id,
        attemptNumber: row.attempt_number,
        attemptKind: row.attempt_kind,
        evidenceClass: 'provider_observation',
        evidenceId: row.observation_id,
        evidenceDigestSha256: row.provider_event_digest_sha256,
        observedAt: new Date(row.provider_observed_at_ms ?? row.ingested_at_ms).toISOString()
      }));
    }
    const rank: Readonly<Record<CommunicationDeliveryObservationKind, number>> = {
      delivered: 1,
      delivery_failed: 2,
      permanent_bounce: 3
    };
    candidates.sort((left, right) =>
      right.attemptNumber - left.attemptNumber
      || rank[right.kind] - rank[left.kind]
      || right.observedAt.localeCompare(left.observedAt)
      || right.evidenceId.localeCompare(left.evidenceId)
    );
    return candidates[0];
  }

  isAddressSuppressed(input: {
    readonly workspaceId: string;
    readonly lookupProfile: string;
    readonly lookupVersion: number;
    readonly lookupKeyedValue: string;
  }): boolean {
    const row = this.sqlite.query<{ readonly state: 'suppressed' | 'clear' }, [string, string, number, string]>(`
      SELECT state FROM communication_current_address_suppressions
       WHERE workspace_id=? AND lookup_profile=? AND lookup_version=? AND lookup_keyed_value=?
    `).get(
      parseWorkspaceId(input.workspaceId), input.lookupProfile,
      input.lookupVersion, input.lookupKeyedValue
    );
    return row?.state === 'suppressed';
  }
}
