import {
  type PublicMutationContinuationAlias,
  type PublicMutationContinuationConfigurationSnapshot,
  type PublicMutationContinuationConfigurationTemplateSnapshot,
  type PublicMutationContinuationEvidence,
  type PublicMutationContinuationProfileSnapshot,
  type PublicMutationContinuationSealReader,
  type PublicMutationContinuationSecurityAuditInput,
  type PublicMutationContinuationStore,
  type PublicMutationStoredCeremony
} from '@jooevents/application/public-mutation-continuation';
import {
  canonicalJsonText,
  parseAuditEventId,
  parseCeremonyEvidenceId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parsePublicPolicyRevisionId,
  parseWorkspaceId,
  type AuditEventId,
  type CeremonyEvidenceId,
  type Clock,
  type Instant
} from '@jooevents/kernel';
import type { Database } from 'bun:sqlite';

const safeCodePattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const completionReferencePattern = /^pcr_[A-Za-z0-9_-]{24,240}$/;

export const PUBLIC_MUTATION_CONTINUATION_TRIAL_TABLES = Object.freeze([
  'public_mutation_continuations_trial',
  'public_mutation_continuation_aliases_trial',
  'public_mutation_security_audits_trial',
  'public_mutation_effect_proofs_trial'
]);

export interface SQLitePublicMutationContinuationTrialFaults {
  readonly afterCeremonyInserted?: () => void;
  readonly afterAliasesInserted?: () => void;
  readonly beforeMintAudit?: () => void;
  readonly afterProofInserted?: () => void;
  readonly afterCeremonyTerminal?: () => void;
  readonly beforeProofAudit?: () => void;
  readonly afterProofCommitBeforeReturn?: () => void;
}

export interface SQLitePublicMutationContinuationTrialOptions {
  readonly clock: Clock;
  readonly newAuditEventId: () => AuditEventId;
  readonly newCompletionReference: () => string;
  readonly faults?: SQLitePublicMutationContinuationTrialFaults;
}

export class SQLitePublicMutationContinuationTrialError extends Error {
  constructor(
    readonly code:
      | 'invalid_security_audit'
      | 'configuration_conflict'
      | 'invalid_evidence'
      | 'ceremony_not_found'
      | 'corrupt_ceremony'
      | 'invalid_completion_reference',
    message: string
  ) {
    super(message);
    this.name = 'SQLitePublicMutationContinuationTrialError';
  }
}

interface CeremonyRow {
  readonly ceremony_evidence_id: string;
  readonly binding_key: string;
  readonly binding_version: number;
  readonly public_policy_revision_id: string;
  readonly operation_name: string;
  readonly operation_version: number;
  readonly workspace_id: string;
  readonly event_id: string;
  readonly purpose_key: string;
  readonly action_key: string;
  readonly resource_bindings_json: string;
  readonly action_anchor_id: string;
  readonly lifetime_ms: number;
  readonly bootstrap_verifier_key: string;
  readonly bootstrap_verifier_version: number;
  readonly origin_policy_key: string;
  readonly origin_policy_version: number;
  readonly csrf_policy_key: string;
  readonly csrf_policy_version: number;
  readonly rate_limit_policy_key: string;
  readonly rate_limit_policy_version: number;
  readonly replay_policy_key: string;
  readonly replay_policy_version: number;
  readonly principal_profile_key: string;
  readonly principal_profile_version: number;
  readonly principal_key_verifier: string;
  readonly replay_profile_key: string;
  readonly replay_profile_version: number;
  readonly replay_key_verifier: string;
  readonly principal_partition_key: string;
  readonly bootstrap_replay_verifier: string;
  readonly created_at_ms: number;
  readonly expires_at_ms: number;
  readonly revoked_at_ms: number | null;
  readonly state: 'ready' | 'terminal';
  readonly completion_reference: string | null;
}

interface AliasRow {
  readonly ordinal: number;
  readonly profile_key: string;
  readonly profile_version: number;
  readonly key_verifier: string;
  readonly continuation_verifier: string;
}

interface CeremonyIdRow {
  readonly ceremony_evidence_id: string;
}

function ref(key: string, version: number) {
  if (!safeCodePattern.test(key)) throw new SQLitePublicMutationContinuationTrialError('corrupt_ceremony', 'Stored definition key is invalid.');
  return Object.freeze({ key, version: parseContractVersion(version) });
}

function instantFromMilliseconds(value: number): Instant {
  if (!Number.isSafeInteger(value)) throw new SQLitePublicMutationContinuationTrialError('corrupt_ceremony', 'Stored instant is invalid.');
  return parseInstant(new Date(value).toISOString());
}

function assertSafeCode(value: string, label: string): void {
  if (!safeCodePattern.test(value) || value.length > 160) {
    throw new SQLitePublicMutationContinuationTrialError('invalid_security_audit', `${label} is invalid.`);
  }
}

function profileFromRow(
  key: string,
  version: number,
  keyVerifier: string
): PublicMutationContinuationProfileSnapshot {
  if (!/^(?:pck1|ppk1|prk1)_[a-f0-9]{64}$/.test(keyVerifier)) {
    throw new SQLitePublicMutationContinuationTrialError('corrupt_ceremony', 'Stored key verifier is invalid.');
  }
  return Object.freeze({ reference: ref(key, version), keyVerifier });
}

function configurationFrom(
  row: CeremonyRow,
  aliases: readonly AliasRow[]
): PublicMutationContinuationConfigurationSnapshot {
  if (aliases.length === 0 || aliases.length > 8 || aliases.some((alias, index) => alias.ordinal !== index)) {
    throw new SQLitePublicMutationContinuationTrialError('corrupt_ceremony', 'Stored continuation aliases are invalid.');
  }
  const continuationProfiles = aliases.map((alias) =>
    profileFromRow(alias.profile_key, alias.profile_version, alias.key_verifier)
  );
  const first = continuationProfiles[0];
  if (!first) throw new SQLitePublicMutationContinuationTrialError('corrupt_ceremony', 'Stored continuation aliases are empty.');
  let resourceBindings: PublicMutationContinuationConfigurationSnapshot['resourceBindings'];
  try {
    const candidate: unknown = JSON.parse(row.resource_bindings_json);
    if (!Array.isArray(candidate) || candidate.length === 0 || candidate.length > 8) throw new TypeError();
    const parsed = candidate.map((binding) => {
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)
          || Object.keys(binding).sort().join(',') !== 'id,kind') throw new TypeError();
      const value = binding as { readonly kind?: unknown; readonly id?: unknown };
      if (typeof value.kind !== 'string' || !safeCodePattern.test(value.kind)
          || typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 240
          || value.id.trim() !== value.id || value.id.normalize('NFC') !== value.id
          || value.id.includes('\0')) throw new TypeError();
      return Object.freeze({ kind: value.kind, id: value.id });
    });
    if (parsed.some((value, index) => index > 0 && (
      parsed[index - 1]!.kind > value.kind
      || (parsed[index - 1]!.kind === value.kind && parsed[index - 1]!.id >= value.id)
    ))) throw new TypeError();
    if (canonicalJsonText(parsed) !== row.resource_bindings_json) throw new TypeError();
    resourceBindings = Object.freeze(parsed);
  } catch {
    throw new SQLitePublicMutationContinuationTrialError('corrupt_ceremony', 'Stored resource bindings are invalid.');
  }
  const actionAnchorId = row.action_anchor_id;
  if (!/^pma_[A-Za-z0-9_-]{16,240}$/.test(actionAnchorId) &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(actionAnchorId)) {
    throw new SQLitePublicMutationContinuationTrialError('corrupt_ceremony', 'Stored action anchor is invalid.');
  }
  return Object.freeze({
    version: 1 as const,
    binding: ref(row.binding_key, row.binding_version),
    publicPolicyRevisionId: parsePublicPolicyRevisionId(row.public_policy_revision_id),
    operation: Object.freeze({
      name: row.operation_name,
      version: parseContractVersion(row.operation_version)
    }),
    scope: Object.freeze({
      kind: 'event' as const,
      workspaceId: parseWorkspaceId(row.workspace_id),
      eventId: parseEventId(row.event_id)
    }),
    purpose: row.purpose_key,
    action: row.action_key,
    resourceBindings,
    actionAnchorId,
    lifetimeMs: row.lifetime_ms,
    bootstrapVerifier: ref(row.bootstrap_verifier_key, row.bootstrap_verifier_version),
    originPolicy: ref(row.origin_policy_key, row.origin_policy_version),
    csrfPolicy: ref(row.csrf_policy_key, row.csrf_policy_version),
    rateLimitPolicy: ref(row.rate_limit_policy_key, row.rate_limit_policy_version),
    replayPolicy: ref(row.replay_policy_key, row.replay_policy_version),
    continuationProfiles: Object.freeze([first, ...continuationProfiles.slice(1)]) as readonly [
      PublicMutationContinuationProfileSnapshot,
      ...PublicMutationContinuationProfileSnapshot[]
    ],
    principalPartitionProfile: profileFromRow(
      row.principal_profile_key,
      row.principal_profile_version,
      row.principal_key_verifier
    ),
    bootstrapReplayProfile: profileFromRow(
      row.replay_profile_key,
      row.replay_profile_version,
      row.replay_key_verifier
    )
  });
}

function storedCeremony(
  row: CeremonyRow,
  aliases: readonly AliasRow[]
): PublicMutationStoredCeremony {
  if (!/^ppv1_[a-f0-9]{64}$/.test(row.principal_partition_key) ||
    !/^prv1_[a-f0-9]{64}$/.test(row.bootstrap_replay_verifier) ||
    (row.state === 'terminal') !== (row.completion_reference !== null) ||
    (row.completion_reference !== null && !completionReferencePattern.test(row.completion_reference))) {
    throw new SQLitePublicMutationContinuationTrialError('corrupt_ceremony', 'Stored ceremony branch is invalid.');
  }
  return Object.freeze({
    ceremonyEvidenceId: parseCeremonyEvidenceId(row.ceremony_evidence_id),
    configuration: configurationFrom(row, aliases),
    principalPartitionKey: row.principal_partition_key,
    createdAt: instantFromMilliseconds(row.created_at_ms),
    expiresAt: instantFromMilliseconds(row.expires_at_ms),
    state: row.state,
    completionReference: row.completion_reference
  });
}

function exactConfiguration(
  left: PublicMutationContinuationConfigurationSnapshot,
  right: PublicMutationContinuationConfigurationSnapshot
): boolean {
  return canonicalJsonText(left) === canonicalJsonText(right);
}

function configurationTemplate(
  configuration: PublicMutationContinuationConfigurationSnapshot
): PublicMutationContinuationConfigurationTemplateSnapshot {
  const { actionAnchorId: _dynamicActionAnchorId, ...template } = configuration;
  return Object.freeze(template);
}

function exactTemplate(
  left: PublicMutationContinuationConfigurationSnapshot,
  right: PublicMutationContinuationConfigurationTemplateSnapshot
): boolean {
  return canonicalJsonText(configurationTemplate(left)) === canonicalJsonText(right);
}

function auditMatchesConfiguration(
  audit: PublicMutationContinuationSecurityAuditInput,
  configuration: PublicMutationContinuationConfigurationSnapshot
): void {
  if (!exactConfiguration(audit.configuration, configuration)) {
    throw new SQLitePublicMutationContinuationTrialError('invalid_security_audit', 'Security audit configuration mismatch.');
  }
  assertSafeCode(audit.reasonCode, 'Security audit reason code');
  parseAuditEventId(audit.auditEventId);
  parseInstant(audit.recordedAt);
  if (audit.ceremonyEvidenceId !== null) parseCeremonyEvidenceId(audit.ceremonyEvidenceId);
}

function insertAudit(
  sqlite: Database,
  input: PublicMutationContinuationSecurityAuditInput
): void {
  auditMatchesConfiguration(input, input.configuration);
  sqlite.query(`
    INSERT INTO public_mutation_security_audits_trial (
      audit_event_id, ceremony_evidence_id, binding_key, binding_version,
      public_policy_revision_id, operation_name, operation_version,
      workspace_id, event_id, purpose_key, action_key, resource_bindings_json,
      action_anchor_id,
      disposition, reason_code, recorded_at_ms,
      origin_evidence_id, csrf_evidence_id, rate_limit_evidence_id, replay_evidence_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.auditEventId,
    input.ceremonyEvidenceId,
    input.configuration.binding.key,
    input.configuration.binding.version,
    input.configuration.publicPolicyRevisionId,
    input.configuration.operation.name,
    input.configuration.operation.version,
    input.configuration.scope.workspaceId,
    input.configuration.scope.eventId,
    input.configuration.purpose,
    input.configuration.action,
    canonicalJsonText(input.configuration.resourceBindings),
    input.configuration.actionAnchorId,
    input.disposition,
    input.reasonCode,
    Date.parse(input.recordedAt),
    input.originEvidenceId,
    input.csrfEvidenceId,
    input.rateLimitEvidenceId,
    input.replayEvidenceId
  );
}

function auditFor(
  auditEventId: AuditEventId,
  ceremony: PublicMutationStoredCeremony,
  disposition: PublicMutationContinuationSecurityAuditInput['disposition'],
  reasonCode: string,
  recordedAt: Instant
): PublicMutationContinuationSecurityAuditInput {
  return Object.freeze({
    auditEventId: parseAuditEventId(auditEventId),
    ceremonyEvidenceId: ceremony.ceremonyEvidenceId,
    configuration: ceremony.configuration,
    disposition,
    reasonCode,
    recordedAt: parseInstant(recordedAt),
    originEvidenceId: null,
    csrfEvidenceId: null,
    rateLimitEvidenceId: null,
    replayEvidenceId: null
  });
}

export const PUBLIC_MUTATION_CONTINUATION_TRIAL_SQL = `
    CREATE TABLE public_mutation_continuations_trial (
      ceremony_evidence_id TEXT PRIMARY KEY,
      binding_key TEXT NOT NULL,
      binding_version INTEGER NOT NULL CHECK (binding_version > 0),
      public_policy_revision_id TEXT NOT NULL,
      operation_name TEXT NOT NULL,
      operation_version INTEGER NOT NULL CHECK (operation_version > 0),
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      purpose_key TEXT NOT NULL,
      action_key TEXT NOT NULL,
      resource_bindings_json TEXT NOT NULL CHECK(
        json_valid(resource_bindings_json)
        AND json_type(resource_bindings_json) = 'array'
        AND json_array_length(resource_bindings_json) BETWEEN 1 AND 8
      ),
      action_anchor_id TEXT NOT NULL CHECK (
        action_anchor_id GLOB 'pma_*'
        OR (
          length(action_anchor_id) = 36
          AND action_anchor_id = lower(action_anchor_id)
          AND substr(action_anchor_id, 9, 1) = '-'
          AND substr(action_anchor_id, 14, 1) = '-'
          AND substr(action_anchor_id, 19, 1) = '-'
          AND substr(action_anchor_id, 24, 1) = '-'
          AND substr(action_anchor_id, 15, 1) IN ('4', '7')
          AND substr(action_anchor_id, 20, 1) IN ('8', '9', 'a', 'b')
          AND replace(action_anchor_id, '-', '') NOT GLOB '*[^0-9a-f]*'
        )
      ),
      lifetime_ms INTEGER NOT NULL CHECK (lifetime_ms > 0 AND lifetime_ms <= 900000),
      bootstrap_verifier_key TEXT NOT NULL,
      bootstrap_verifier_version INTEGER NOT NULL CHECK (bootstrap_verifier_version > 0),
      origin_policy_key TEXT NOT NULL,
      origin_policy_version INTEGER NOT NULL CHECK (origin_policy_version > 0),
      csrf_policy_key TEXT NOT NULL,
      csrf_policy_version INTEGER NOT NULL CHECK (csrf_policy_version > 0),
      rate_limit_policy_key TEXT NOT NULL,
      rate_limit_policy_version INTEGER NOT NULL CHECK (rate_limit_policy_version > 0),
      replay_policy_key TEXT NOT NULL,
      replay_policy_version INTEGER NOT NULL CHECK (replay_policy_version > 0),
      principal_profile_key TEXT NOT NULL,
      principal_profile_version INTEGER NOT NULL CHECK (principal_profile_version > 0),
      principal_key_verifier TEXT NOT NULL CHECK (principal_key_verifier GLOB 'ppk1_*'),
      replay_profile_key TEXT NOT NULL,
      replay_profile_version INTEGER NOT NULL CHECK (replay_profile_version > 0),
      replay_key_verifier TEXT NOT NULL CHECK (replay_key_verifier GLOB 'prk1_*'),
      principal_partition_key TEXT NOT NULL CHECK (principal_partition_key GLOB 'ppv1_*'),
      bootstrap_replay_verifier TEXT NOT NULL UNIQUE CHECK (bootstrap_replay_verifier GLOB 'prv1_*'),
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
      revoked_at_ms INTEGER,
      state TEXT NOT NULL CHECK (state IN ('ready', 'terminal')),
      completion_reference TEXT UNIQUE,
      CHECK ((state = 'ready' AND completion_reference IS NULL) OR
             (state = 'terminal' AND completion_reference IS NOT NULL)),
      CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms),
      UNIQUE (action_anchor_id),
      UNIQUE (
        principal_partition_key, public_policy_revision_id, operation_name,
        operation_version, workspace_id, event_id, purpose_key, action_key, action_anchor_id
      ),
      FOREIGN KEY (ceremony_evidence_id, completion_reference)
        REFERENCES public_mutation_effect_proofs_trial(ceremony_evidence_id, completion_reference)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    ) STRICT;

    CREATE TABLE public_mutation_continuation_aliases_trial (
      ceremony_evidence_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 8),
      profile_key TEXT NOT NULL,
      profile_version INTEGER NOT NULL CHECK (profile_version > 0),
      key_verifier TEXT NOT NULL CHECK (key_verifier GLOB 'pck1_*'),
      continuation_verifier TEXT NOT NULL UNIQUE CHECK (continuation_verifier GLOB 'pcv1_*'),
      PRIMARY KEY (ceremony_evidence_id, ordinal),
      UNIQUE (ceremony_evidence_id, profile_key, profile_version),
      FOREIGN KEY (ceremony_evidence_id)
        REFERENCES public_mutation_continuations_trial(ceremony_evidence_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    ) STRICT;

    CREATE TABLE public_mutation_security_audits_trial (
      audit_event_id TEXT PRIMARY KEY,
      ceremony_evidence_id TEXT,
      binding_key TEXT NOT NULL,
      binding_version INTEGER NOT NULL CHECK (binding_version > 0),
      public_policy_revision_id TEXT NOT NULL,
      operation_name TEXT NOT NULL,
      operation_version INTEGER NOT NULL CHECK (operation_version > 0),
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      purpose_key TEXT NOT NULL,
      action_key TEXT NOT NULL,
      resource_bindings_json TEXT NOT NULL CHECK(
        json_valid(resource_bindings_json)
        AND json_type(resource_bindings_json) = 'array'
        AND json_array_length(resource_bindings_json) BETWEEN 1 AND 8
      ),
      action_anchor_id TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN (
        'bootstrap_rejected', 'mint_issued', 'mint_already_issued',
        'continuation_admitted', 'continuation_terminal_replay', 'continuation_stopped',
        'proof_terminal', 'proof_replay', 'proof_stopped'
      )),
      reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 160),
      recorded_at_ms INTEGER NOT NULL,
      origin_evidence_id TEXT,
      csrf_evidence_id TEXT,
      rate_limit_evidence_id TEXT,
      replay_evidence_id TEXT,
      FOREIGN KEY (ceremony_evidence_id)
        REFERENCES public_mutation_continuations_trial(ceremony_evidence_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    ) STRICT;

    CREATE TABLE public_mutation_effect_proofs_trial (
      ceremony_evidence_id TEXT PRIMARY KEY,
      completion_reference TEXT NOT NULL UNIQUE CHECK (completion_reference GLOB 'pcr_*'),
      committed_at_ms INTEGER NOT NULL,
      UNIQUE (ceremony_evidence_id, completion_reference),
      FOREIGN KEY (ceremony_evidence_id)
        REFERENCES public_mutation_continuations_trial(ceremony_evidence_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    ) STRICT;

    CREATE TRIGGER public_mutation_continuation_aliases_immutable_trial
    BEFORE UPDATE ON public_mutation_continuation_aliases_trial BEGIN
      SELECT RAISE(ABORT, 'public_mutation_alias_immutable');
    END;
    CREATE TRIGGER public_mutation_continuation_aliases_delete_immutable_trial
    BEFORE DELETE ON public_mutation_continuation_aliases_trial BEGIN
      SELECT RAISE(ABORT, 'public_mutation_alias_immutable');
    END;
    CREATE TRIGGER public_mutation_security_audits_immutable_trial
    BEFORE UPDATE ON public_mutation_security_audits_trial BEGIN
      SELECT RAISE(ABORT, 'public_mutation_security_audit_immutable');
    END;
    CREATE TRIGGER public_mutation_security_audits_delete_immutable_trial
    BEFORE DELETE ON public_mutation_security_audits_trial BEGIN
      SELECT RAISE(ABORT, 'public_mutation_security_audit_immutable');
    END;
    CREATE TRIGGER public_mutation_effect_proofs_immutable_trial
    BEFORE UPDATE ON public_mutation_effect_proofs_trial BEGIN
      SELECT RAISE(ABORT, 'public_mutation_effect_proof_immutable');
    END;
    CREATE TRIGGER public_mutation_effect_proofs_delete_immutable_trial
    BEFORE DELETE ON public_mutation_effect_proofs_trial BEGIN
      SELECT RAISE(ABORT, 'public_mutation_effect_proof_immutable');
    END;
    CREATE TRIGGER public_mutation_continuations_delete_immutable_trial
    BEFORE DELETE ON public_mutation_continuations_trial BEGIN
      SELECT RAISE(ABORT, 'public_mutation_ceremony_immutable');
    END;
    CREATE TRIGGER public_mutation_continuations_identity_immutable_trial
    BEFORE UPDATE ON public_mutation_continuations_trial
    WHEN OLD.ceremony_evidence_id != NEW.ceremony_evidence_id
      OR OLD.binding_key != NEW.binding_key
      OR OLD.binding_version != NEW.binding_version
      OR OLD.public_policy_revision_id != NEW.public_policy_revision_id
      OR OLD.operation_name != NEW.operation_name
      OR OLD.operation_version != NEW.operation_version
      OR OLD.workspace_id != NEW.workspace_id
      OR OLD.event_id != NEW.event_id
      OR OLD.purpose_key != NEW.purpose_key
      OR OLD.action_key != NEW.action_key
      OR OLD.resource_bindings_json != NEW.resource_bindings_json
      OR OLD.action_anchor_id != NEW.action_anchor_id
      OR OLD.lifetime_ms != NEW.lifetime_ms
      OR OLD.bootstrap_verifier_key != NEW.bootstrap_verifier_key
      OR OLD.bootstrap_verifier_version != NEW.bootstrap_verifier_version
      OR OLD.origin_policy_key != NEW.origin_policy_key
      OR OLD.origin_policy_version != NEW.origin_policy_version
      OR OLD.csrf_policy_key != NEW.csrf_policy_key
      OR OLD.csrf_policy_version != NEW.csrf_policy_version
      OR OLD.rate_limit_policy_key != NEW.rate_limit_policy_key
      OR OLD.rate_limit_policy_version != NEW.rate_limit_policy_version
      OR OLD.replay_policy_key != NEW.replay_policy_key
      OR OLD.replay_policy_version != NEW.replay_policy_version
      OR OLD.principal_profile_key != NEW.principal_profile_key
      OR OLD.principal_profile_version != NEW.principal_profile_version
      OR OLD.principal_key_verifier != NEW.principal_key_verifier
      OR OLD.replay_profile_key != NEW.replay_profile_key
      OR OLD.replay_profile_version != NEW.replay_profile_version
      OR OLD.replay_key_verifier != NEW.replay_key_verifier
      OR OLD.principal_partition_key != NEW.principal_partition_key
      OR OLD.bootstrap_replay_verifier != NEW.bootstrap_replay_verifier
      OR OLD.created_at_ms != NEW.created_at_ms
      OR OLD.expires_at_ms != NEW.expires_at_ms
    BEGIN
      SELECT RAISE(ABORT, 'public_mutation_ceremony_identity_immutable');
    END;
    CREATE TRIGGER public_mutation_continuations_state_monotonic_trial
    BEFORE UPDATE ON public_mutation_continuations_trial
    WHEN (OLD.state = 'terminal' AND (NEW.state != OLD.state OR NEW.completion_reference != OLD.completion_reference))
      OR (OLD.revoked_at_ms IS NOT NULL AND NEW.revoked_at_ms != OLD.revoked_at_ms)
      OR (OLD.revoked_at_ms IS NULL AND NEW.revoked_at_ms IS NULL
          AND OLD.state = NEW.state AND OLD.completion_reference IS NEW.completion_reference)
    BEGIN
      SELECT CASE
        WHEN OLD.state = 'terminal' AND (NEW.state != OLD.state OR NEW.completion_reference != OLD.completion_reference)
          THEN RAISE(ABORT, 'public_mutation_terminal_immutable')
        WHEN OLD.revoked_at_ms IS NOT NULL AND NEW.revoked_at_ms != OLD.revoked_at_ms
          THEN RAISE(ABORT, 'public_mutation_revocation_immutable')
      END;
    END;
  `;

export function installSQLitePublicMutationContinuationTrial(sqlite: Database): void {
  sqlite.exec(PUBLIC_MUTATION_CONTINUATION_TRIAL_SQL);
}

export class SQLitePublicMutationContinuationTrial implements PublicMutationContinuationStore {
  readonly #sqlite: Database;
  readonly #options: SQLitePublicMutationContinuationTrialOptions;

  constructor(sqlite: Database, options: SQLitePublicMutationContinuationTrialOptions) {
    this.#sqlite = sqlite;
    this.#options = options;
  }

  #now(): Instant {
    return parseInstant(this.#options.clock.now());
  }

  #auditId(): AuditEventId {
    return parseAuditEventId(this.#options.newAuditEventId());
  }

  #aliases(ceremonyEvidenceId: string): readonly AliasRow[] {
    return this.#sqlite.query<AliasRow, [string]>(`
      SELECT ordinal, profile_key, profile_version, key_verifier, continuation_verifier
      FROM public_mutation_continuation_aliases_trial
      WHERE ceremony_evidence_id = ?
      ORDER BY ordinal ASC
    `).all(ceremonyEvidenceId);
  }

  #row(ceremonyEvidenceId: string): CeremonyRow | null {
    return this.#sqlite.query<CeremonyRow, [string]>(`
      SELECT * FROM public_mutation_continuations_trial WHERE ceremony_evidence_id = ?
    `).get(ceremonyEvidenceId) ?? null;
  }

  #stored(row: CeremonyRow): PublicMutationStoredCeremony {
    return storedCeremony(row, this.#aliases(row.ceremony_evidence_id));
  }

  recordBootstrapRejection(input: PublicMutationContinuationSecurityAuditInput): void {
    if (input.disposition !== 'bootstrap_rejected' || input.ceremonyEvidenceId !== null) {
      throw new SQLitePublicMutationContinuationTrialError('invalid_security_audit', 'Bootstrap rejection audit is invalid.');
    }
    const transaction = this.#sqlite.transaction(() => insertAudit(this.#sqlite, input));
    transaction.immediate();
  }

  mint(input: {
    readonly ceremonyEvidenceId: CeremonyEvidenceId;
    readonly configuration: PublicMutationContinuationConfigurationSnapshot;
    readonly principalPartitionKey: string;
    readonly bootstrapReplayVerifier: string;
    readonly aliases: readonly [PublicMutationContinuationAlias, ...PublicMutationContinuationAlias[]];
    readonly createdAt: Instant;
    readonly expiresAt: Instant;
    readonly audit: PublicMutationContinuationSecurityAuditInput;
  }):
    | { readonly kind: 'issued'; readonly ceremony: PublicMutationStoredCeremony }
    | { readonly kind: 'already_issued'; readonly ceremony: PublicMutationStoredCeremony } {
    if (input.audit.disposition !== 'mint_issued' || input.audit.ceremonyEvidenceId !== input.ceremonyEvidenceId) {
      throw new SQLitePublicMutationContinuationTrialError('invalid_security_audit', 'Mint audit is invalid.');
    }
    auditMatchesConfiguration(input.audit, input.configuration);
    const createdAtMs = Date.parse(parseInstant(input.createdAt));
    const expiresAtMs = Date.parse(parseInstant(input.expiresAt));
    if (expiresAtMs - createdAtMs !== input.configuration.lifetimeMs ||
      !/^ppv1_[a-f0-9]{64}$/.test(input.principalPartitionKey) ||
      !/^prv1_[a-f0-9]{64}$/.test(input.bootstrapReplayVerifier) ||
      input.aliases.length !== input.configuration.continuationProfiles.length) {
      throw new SQLitePublicMutationContinuationTrialError('configuration_conflict', 'Mint material does not match its configuration.');
    }

    const run = this.#sqlite.transaction(() => {
      const existingId = this.#sqlite.query<CeremonyIdRow, [string, string]>(`
        SELECT ceremony_evidence_id
        FROM public_mutation_continuations_trial
        WHERE bootstrap_replay_verifier = ?
           OR action_anchor_id = ?
        LIMIT 1
      `).get(input.bootstrapReplayVerifier, input.configuration.actionAnchorId);
      if (existingId) {
        const row = this.#row(existingId.ceremony_evidence_id);
        if (!row) throw new SQLitePublicMutationContinuationTrialError('corrupt_ceremony', 'Existing ceremony disappeared.');
        const ceremony = this.#stored(row);
        const exactReplay = exactTemplate(ceremony.configuration, configurationTemplate(input.configuration)) &&
          ceremony.principalPartitionKey === input.principalPartitionKey &&
          row.bootstrap_replay_verifier === input.bootstrapReplayVerifier;
        insertAudit(this.#sqlite, {
          ...input.audit,
          ceremonyEvidenceId: ceremony.ceremonyEvidenceId,
          configuration: ceremony.configuration,
          disposition: 'mint_already_issued',
          reasonCode: exactReplay ? 'already_issued' : 'action_already_issued'
        });
        return Object.freeze({ kind: 'already_issued' as const, ceremony });
      }

      const config = input.configuration;
      this.#sqlite.query(`
        INSERT INTO public_mutation_continuations_trial (
          ceremony_evidence_id, binding_key, binding_version, public_policy_revision_id,
          operation_name, operation_version, workspace_id, event_id, purpose_key,
          action_key, resource_bindings_json, action_anchor_id, lifetime_ms, bootstrap_verifier_key,
          bootstrap_verifier_version, origin_policy_key, origin_policy_version,
          csrf_policy_key, csrf_policy_version, rate_limit_policy_key,
          rate_limit_policy_version, replay_policy_key, replay_policy_version,
          principal_profile_key, principal_profile_version, principal_key_verifier,
          replay_profile_key, replay_profile_version, replay_key_verifier,
          principal_partition_key, bootstrap_replay_verifier, created_at_ms,
          expires_at_ms, revoked_at_ms, state, completion_reference
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'ready', NULL)
      `).run(
        input.ceremonyEvidenceId,
        config.binding.key,
        config.binding.version,
        config.publicPolicyRevisionId,
        config.operation.name,
        config.operation.version,
        config.scope.workspaceId,
        config.scope.eventId,
        config.purpose,
        config.action,
        canonicalJsonText(config.resourceBindings),
        config.actionAnchorId,
        config.lifetimeMs,
        config.bootstrapVerifier.key,
        config.bootstrapVerifier.version,
        config.originPolicy.key,
        config.originPolicy.version,
        config.csrfPolicy.key,
        config.csrfPolicy.version,
        config.rateLimitPolicy.key,
        config.rateLimitPolicy.version,
        config.replayPolicy.key,
        config.replayPolicy.version,
        config.principalPartitionProfile.reference.key,
        config.principalPartitionProfile.reference.version,
        config.principalPartitionProfile.keyVerifier,
        config.bootstrapReplayProfile.reference.key,
        config.bootstrapReplayProfile.reference.version,
        config.bootstrapReplayProfile.keyVerifier,
        input.principalPartitionKey,
        input.bootstrapReplayVerifier,
        createdAtMs,
        expiresAtMs
      );
      this.#options.faults?.afterCeremonyInserted?.();

      input.aliases.forEach((alias, ordinal) => {
        const expected = config.continuationProfiles[ordinal];
        if (!expected || canonicalJsonText(expected) !== canonicalJsonText(alias.profile) ||
          !/^pcv1_[a-f0-9]{64}$/.test(alias.verifier)) {
          throw new SQLitePublicMutationContinuationTrialError('configuration_conflict', 'Continuation alias does not match its profile.');
        }
        this.#sqlite.query(`
          INSERT INTO public_mutation_continuation_aliases_trial (
            ceremony_evidence_id, ordinal, profile_key, profile_version,
            key_verifier, continuation_verifier
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          input.ceremonyEvidenceId,
          ordinal,
          alias.profile.reference.key,
          alias.profile.reference.version,
          alias.profile.keyVerifier,
          alias.verifier
        );
      });
      this.#options.faults?.afterAliasesInserted?.();
      this.#options.faults?.beforeMintAudit?.();
      insertAudit(this.#sqlite, input.audit);
      const inserted = this.#row(input.ceremonyEvidenceId);
      if (!inserted) throw new SQLitePublicMutationContinuationTrialError('corrupt_ceremony', 'Inserted ceremony disappeared.');
      return Object.freeze({ kind: 'issued' as const, ceremony: this.#stored(inserted) });
    });
    return run.immediate();
  }

  resolve(input: {
    readonly template: PublicMutationContinuationConfigurationTemplateSnapshot;
    readonly aliases: readonly [PublicMutationContinuationAlias, ...PublicMutationContinuationAlias[]];
    readonly now: Instant;
    readonly auditEventId: AuditEventId;
  }):
    | { readonly kind: 'ready'; readonly ceremony: PublicMutationStoredCeremony }
    | { readonly kind: 'terminal'; readonly ceremony: PublicMutationStoredCeremony; readonly completionReference: string }
    | { readonly kind: 'stopped'; readonly reason: 'not_available' | 'expired' | 'revoked' | 'policy_changed' } {
    const aliasValues = [...new Set(input.aliases.map((alias) => alias.verifier))];
    if (aliasValues.length === 0 || aliasValues.length > 8 ||
      aliasValues.some((alias) => !/^pcv1_[a-f0-9]{64}$/.test(alias))) {
      return Object.freeze({ kind: 'stopped', reason: 'not_available' });
    }
    const placeholders = aliasValues.map(() => '?').join(', ');
    const run = this.#sqlite.transaction(() => {
      const ids = this.#sqlite.query<CeremonyIdRow, string[]>(`
        SELECT DISTINCT ceremony_evidence_id
        FROM public_mutation_continuation_aliases_trial
        WHERE continuation_verifier IN (${placeholders})
        LIMIT 2
      `).all(...aliasValues);
      if (ids.length !== 1) return Object.freeze({ kind: 'stopped' as const, reason: 'not_available' as const });
      const row = this.#row(ids[0]!.ceremony_evidence_id);
      if (!row) return Object.freeze({ kind: 'stopped' as const, reason: 'not_available' as const });
      const ceremony = this.#stored(row);
      const recordedAt = parseInstant(input.now);
      const stop = (reason: 'not_available' | 'expired' | 'revoked' | 'policy_changed', code: string) => {
        insertAudit(this.#sqlite, auditFor(
          input.auditEventId,
          ceremony,
          'continuation_stopped',
          code,
          recordedAt
        ));
        return Object.freeze({ kind: 'stopped' as const, reason });
      };
      if (!exactTemplate(ceremony.configuration, input.template)) {
        return stop('not_available', 'binding_mismatch');
      }
      if (row.revoked_at_ms !== null) return stop('revoked', 'revoked');
      if (Date.parse(recordedAt) >= row.expires_at_ms) return stop('expired', 'expired');
      if (ceremony.state === 'terminal') {
        if (!ceremony.completionReference) throw new SQLitePublicMutationContinuationTrialError('corrupt_ceremony', 'Terminal ceremony has no completion.');
        insertAudit(this.#sqlite, auditFor(
          input.auditEventId,
          ceremony,
          'continuation_terminal_replay',
          'terminal_replay',
          recordedAt
        ));
        return Object.freeze({
          kind: 'terminal' as const,
          ceremony,
          completionReference: ceremony.completionReference
        });
      }
      insertAudit(this.#sqlite, auditFor(
        input.auditEventId,
        ceremony,
        'continuation_admitted',
        'admitted',
        recordedAt
      ));
      return Object.freeze({ kind: 'ready' as const, ceremony });
    });
    return run.immediate();
  }

  recheckCurrent(input: {
    readonly ceremonyEvidenceId: CeremonyEvidenceId;
    readonly template: PublicMutationContinuationConfigurationTemplateSnapshot;
    readonly now: Instant;
  }):
    | { readonly kind: 'ready'; readonly ceremony: PublicMutationStoredCeremony }
    | { readonly kind: 'stopped'; readonly reason: 'not_available' | 'expired' | 'revoked' | 'policy_changed' } {
    const row = this.#row(parseCeremonyEvidenceId(input.ceremonyEvidenceId));
    if (!row) return Object.freeze({ kind: 'stopped', reason: 'not_available' });
    const ceremony = this.#stored(row);
    if (!exactTemplate(ceremony.configuration, input.template)) {
      return Object.freeze({ kind: 'stopped', reason: 'policy_changed' });
    }
    const now = parseInstant(input.now);
    if (row.revoked_at_ms !== null) return Object.freeze({ kind: 'stopped', reason: 'revoked' });
    if (Date.parse(now) >= row.expires_at_ms) {
      return Object.freeze({ kind: 'stopped', reason: 'expired' });
    }
    if (row.state !== 'ready' || row.completion_reference !== null) {
      return Object.freeze({ kind: 'stopped', reason: 'not_available' });
    }
    return Object.freeze({ kind: 'ready', ceremony });
  }

  /** Internal disposable-fixture revocation. There is deliberately no public route or lookup API. */
  revokeForTrial(ceremonyEvidenceId: CeremonyEvidenceId, reasonCode = 'revoked'): boolean {
    assertSafeCode(reasonCode, 'Revocation reason');
    const now = this.#now();
    const run = this.#sqlite.transaction(() => {
      const row = this.#row(parseCeremonyEvidenceId(ceremonyEvidenceId));
      if (!row) return false;
      const ceremony = this.#stored(row);
      if (row.revoked_at_ms === null) {
        this.#sqlite.query(`
          UPDATE public_mutation_continuations_trial
          SET revoked_at_ms = ?
          WHERE ceremony_evidence_id = ? AND revoked_at_ms IS NULL
        `).run(Date.parse(now), ceremony.ceremonyEvidenceId);
      }
      insertAudit(this.#sqlite, auditFor(
        this.#auditId(),
        ceremony,
        'continuation_stopped',
        reasonCode,
        now
      ));
      return true;
    });
    return run.immediate();
  }

  /**
   * Fixed proof reducer only. It accepts no operation, target, business input, or
   * callback, and is not connected to the operation registry or a transport route.
   */
  commitProvingEffect(input: {
    readonly evidence: PublicMutationContinuationEvidence;
    readonly sealReader: PublicMutationContinuationSealReader;
  }):
    | { readonly kind: 'terminal'; readonly completionReference: string; readonly replay: boolean }
    | { readonly kind: 'stopped'; readonly reason: 'expired' | 'revoked' | 'policy_changed' | 'not_available' } {
    const run = this.#sqlite.transaction(() => {
      // Both calls occur inside this write transaction: authenticity first, then
      // exact current policy/registration/expiry from the owning boundary.
      const admitted = input.sealReader.open(input.evidence);
      if (!admitted) {
        throw new SQLitePublicMutationContinuationTrialError('invalid_evidence', 'Continuation evidence is not authentic.');
      }
      const current = input.sealReader.openCurrent(input.evidence);
      const row = this.#row(admitted.ceremonyEvidenceId);
      if (!row) throw new SQLitePublicMutationContinuationTrialError('ceremony_not_found', 'Continuation ceremony does not exist.');
      const ceremony = this.#stored(row);
      const now = this.#now();
      const stopped = (reason: 'expired' | 'revoked' | 'policy_changed' | 'not_available', code: string) => {
        insertAudit(this.#sqlite, auditFor(
          this.#auditId(),
          ceremony,
          'proof_stopped',
          code,
          now
        ));
        return Object.freeze({ kind: 'stopped' as const, reason });
      };

      if (canonicalJsonText(ceremony.configuration) !== canonicalJsonText(admitted.configuration) ||
        ceremony.principalPartitionKey !== admitted.principalPartitionKey ||
        ceremony.createdAt !== admitted.createdAt || ceremony.expiresAt !== admitted.expiresAt) {
        return stopped('not_available', 'binding_mismatch');
      }
      if (row.revoked_at_ms !== null) return stopped('revoked', 'revoked');
      if (Date.parse(now) >= row.expires_at_ms) return stopped('expired', 'expired');
      if (!current || !exactConfiguration(current.configuration, ceremony.configuration)) {
        return stopped('policy_changed', 'policy_changed');
      }
      if (row.state === 'terminal') {
        if (!row.completion_reference) throw new SQLitePublicMutationContinuationTrialError('corrupt_ceremony', 'Terminal ceremony has no completion.');
        insertAudit(this.#sqlite, auditFor(
          this.#auditId(),
          ceremony,
          'proof_replay',
          'terminal_replay',
          now
        ));
        return Object.freeze({
          kind: 'terminal' as const,
          completionReference: row.completion_reference,
          replay: true
        });
      }

      const completionReference = this.#options.newCompletionReference();
      if (typeof completionReference !== 'string' || !completionReferencePattern.test(completionReference)) {
        throw new SQLitePublicMutationContinuationTrialError('invalid_completion_reference', 'Proof completion reference is invalid.');
      }
      this.#sqlite.query(`
        INSERT INTO public_mutation_effect_proofs_trial (
          ceremony_evidence_id, completion_reference, committed_at_ms
        ) VALUES (?, ?, ?)
      `).run(ceremony.ceremonyEvidenceId, completionReference, Date.parse(now));
      this.#options.faults?.afterProofInserted?.();
      const advanced = this.#sqlite.query(`
        UPDATE public_mutation_continuations_trial
        SET state = 'terminal', completion_reference = ?
        WHERE ceremony_evidence_id = ?
          AND state = 'ready'
          AND completion_reference IS NULL
          AND revoked_at_ms IS NULL
          AND expires_at_ms > ?
      `).run(completionReference, ceremony.ceremonyEvidenceId, Date.parse(now));
      if (advanced.changes !== 1) {
        throw new SQLitePublicMutationContinuationTrialError('configuration_conflict', 'Ceremony changed during proof commit.');
      }
      this.#options.faults?.afterCeremonyTerminal?.();
      this.#options.faults?.beforeProofAudit?.();
      insertAudit(this.#sqlite, auditFor(
        this.#auditId(),
        { ...ceremony, state: 'terminal', completionReference },
        'proof_terminal',
        'terminal',
        now
      ));
      return Object.freeze({
        kind: 'terminal' as const,
        completionReference,
        replay: false
      });
    });
    const result = run.immediate();
    this.#options.faults?.afterProofCommitBeforeReturn?.();
    return result;
  }
}
