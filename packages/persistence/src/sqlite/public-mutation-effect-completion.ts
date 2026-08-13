import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import {
  effectOperationIdentitiesEqual,
  type TerminalEffectReceipt
} from '@jooevents/application';
import {
  openPublicMutationEffectCompletion,
  parsePublicMutationEffectCompletionReference,
  PublicMutationEffectCompletionError,
  type PublicMutationEffectCompletionPort,
  type PublicMutationEffectCompletionResult,
  type SealedPublicMutationEffectCompletion
} from '@jooevents/application/public-mutation-effect-completion';
import { effectfulOperationResultSchema } from '@jooevents/contracts';
import {
  canonicalJsonText,
  parseAuditEventId,
  parseContractVersion,
  parseInstant,
  parseOperationReceiptId,
  type AuditEventId,
  type Clock,
  type Instant
} from '@jooevents/kernel';

const stableKeyPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const operationSurfaces = new Set([
  'operator_http', 'participant_http', 'public_http', 'external_mcp', 'app_model',
  'application_job', 'provider_ingress'
]);

export const SQLITE_PUBLIC_MUTATION_EFFECT_COMPLETION_TABLES = Object.freeze([
  'public_mutation_registered_effect_completions'
]);

export const SQLITE_PUBLIC_MUTATION_EFFECT_COMPLETION_SQL = `
  CREATE TABLE public_mutation_registered_effect_completions (
    ceremony_evidence_id TEXT PRIMARY KEY,
    completion_reference TEXT NOT NULL UNIQUE CHECK (completion_reference GLOB 'pcr_*'),
    receipt_id TEXT NOT NULL UNIQUE,
    scope_partition_key TEXT NOT NULL,
    authority_principal_key TEXT NOT NULL,
    operation_name TEXT NOT NULL,
    operation_version INTEGER NOT NULL CHECK (operation_version > 0),
    surface TEXT NOT NULL,
    idempotency_profile_key TEXT NOT NULL,
    idempotency_profile_version INTEGER NOT NULL CHECK (idempotency_profile_version > 0),
    idempotency_key_verifier TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    configuration_digest_sha256 TEXT NOT NULL CHECK (
      length(configuration_digest_sha256) = 64
      AND configuration_digest_sha256 NOT GLOB '*[^a-f0-9]*'
    ),
    principal_partition_key TEXT NOT NULL CHECK (principal_partition_key GLOB 'ppv1_*'),
    completed_at_ms INTEGER NOT NULL,
    FOREIGN KEY (ceremony_evidence_id, completion_reference)
      REFERENCES public_mutation_effect_proofs_trial(ceremony_evidence_id, completion_reference)
      ON UPDATE NO ACTION ON DELETE NO ACTION,
    FOREIGN KEY (receipt_id)
      REFERENCES foundation_trial_operation_receipts(id)
      ON UPDATE NO ACTION ON DELETE NO ACTION
  ) STRICT;

  CREATE TRIGGER public_mutation_registered_effect_completions_immutable
  BEFORE UPDATE ON public_mutation_registered_effect_completions BEGIN
    SELECT RAISE(ABORT, 'public_mutation_registered_effect_completion_immutable');
  END;

  CREATE TRIGGER public_mutation_registered_effect_completions_delete_immutable
  BEFORE DELETE ON public_mutation_registered_effect_completions BEGIN
    SELECT RAISE(ABORT, 'public_mutation_registered_effect_completion_immutable');
  END;
`;

export function installSQLitePublicMutationEffectCompletion(sqlite: Database): void {
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(SQLITE_PUBLIC_MUTATION_EFFECT_COMPLETION_SQL);
}

export type SQLitePublicMutationEffectCompletionErrorCode =
  | 'transaction_required'
  | 'invalid_seal'
  | 'receipt_mismatch'
  | 'completion_collision'
  | 'corrupt_completion';

export class SQLitePublicMutationEffectCompletionError extends TypeError {
  constructor(readonly code: SQLitePublicMutationEffectCompletionErrorCode) {
    super(code);
    this.name = 'SQLitePublicMutationEffectCompletionError';
  }
}

export interface SQLitePublicMutationEffectCompletionFaults {
  readonly afterProofInserted?: () => void;
  readonly afterBindingInserted?: () => void;
  readonly afterCeremonyTerminal?: () => void;
  readonly beforeSecurityAudit?: () => void;
}

export interface SQLitePublicMutationEffectCompletionOptions {
  readonly clock: Clock;
  readonly newAuditEventId: () => AuditEventId;
  readonly faults?: SQLitePublicMutationEffectCompletionFaults;
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
  readonly created_at_ms: number;
  readonly expires_at_ms: number;
  readonly revoked_at_ms: number | null;
  readonly state: string;
  readonly completion_reference: string | null;
}

interface AliasRow {
  readonly ordinal: number;
  readonly profile_key: string;
  readonly profile_version: number;
  readonly key_verifier: string;
}

interface FoundationReceiptRow {
  readonly id: string;
  readonly scope_partition_key: string;
  readonly authority_principal_key: string;
  readonly operation_name: string;
  readonly operation_version: number;
  readonly surface: string;
  readonly idempotency_verifier_profile_key: string;
  readonly idempotency_verifier_profile_version: number;
  readonly idempotency_key_verifier: string;
  readonly request_hash: string;
  readonly result_json: string;
}

interface CompletionRow {
  readonly ceremony_evidence_id: string;
  readonly completion_reference: string;
  readonly receipt_id: string;
  readonly scope_partition_key: string;
  readonly authority_principal_key: string;
  readonly operation_name: string;
  readonly operation_version: number;
  readonly surface: string;
  readonly idempotency_profile_key: string;
  readonly idempotency_profile_version: number;
  readonly idempotency_key_verifier: string;
  readonly request_hash: string;
  readonly configuration_digest_sha256: string;
  readonly principal_partition_key: string;
  readonly completed_at_ms: number;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonText(value)).digest('hex');
}

function corrupt(): never {
  throw new SQLitePublicMutationEffectCompletionError('corrupt_completion');
}

function exactText(value: unknown, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512
      || (pattern && !pattern.test(value))) corrupt();
  return value;
}

function exactInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) corrupt();
  return value;
}

function receiptFromRow(row: FoundationReceiptRow): TerminalEffectReceipt {
  const operationName = exactText(row.operation_name, stableKeyPattern);
  const operationVersion = parseContractVersion(exactInteger(row.operation_version));
  const surface = exactText(row.surface);
  if (!operationSurfaces.has(surface)) corrupt();
  let result: ReturnType<typeof effectfulOperationResultSchema.parse>;
  try {
    result = effectfulOperationResultSchema.parse(JSON.parse(row.result_json));
  } catch {
    return corrupt();
  }
  const receipt = Object.freeze({
    ref: Object.freeze({
      id: parseOperationReceiptId(row.id),
      operationName,
      operationVersion
    }),
    identity: Object.freeze({
      scopePartitionKey: exactText(row.scope_partition_key),
      authorityPrincipalKey: exactText(row.authority_principal_key),
      operationName,
      operationVersion,
      surface: surface as TerminalEffectReceipt['identity']['surface'],
      idempotencyVerifierProfile: Object.freeze({
        key: exactText(row.idempotency_verifier_profile_key, stableKeyPattern),
        version: parseContractVersion(exactInteger(row.idempotency_verifier_profile_version))
      }),
      idempotencyKeyVerifier: exactText(row.idempotency_key_verifier)
    }),
    requestHash: exactText(row.request_hash),
    result: Object.freeze(result)
  });
  if ((receipt.result.kind === 'outcome' && receipt.result.terminal !== true)
      || !('receipt' in receipt.result)
      || receipt.result.receipt.id !== receipt.ref.id
      || receipt.result.receipt.operationName !== receipt.ref.operationName
      || receipt.result.receipt.operationVersion !== receipt.ref.operationVersion) corrupt();
  return receipt;
}

const receiptSql = `
  SELECT id, scope_partition_key, authority_principal_key, operation_name,
         operation_version, surface, idempotency_verifier_profile_key,
         idempotency_verifier_profile_version, idempotency_key_verifier,
         request_hash, result_json
    FROM foundation_trial_operation_receipts
   WHERE id = ?
`;

function exactReceipt(left: TerminalEffectReceipt, right: TerminalEffectReceipt): boolean {
  return left.ref.id === right.ref.id
    && left.ref.operationName === right.ref.operationName
    && left.ref.operationVersion === right.ref.operationVersion
    && effectOperationIdentitiesEqual(left.identity, right.identity)
    && left.requestHash === right.requestHash
    && canonicalJsonText(left.result) === canonicalJsonText(right.result);
}

function sameReference(
  left: { readonly key: string; readonly version: number },
  key: string,
  version: number
): boolean {
  return left.key === key && left.version === version;
}

function rowMatchesMaterial(
  row: CeremonyRow,
  aliases: readonly AliasRow[],
  opened: NonNullable<ReturnType<typeof openPublicMutationEffectCompletion>>
): boolean {
  const configuration = opened.configuration;
  return sameReference(configuration.binding, row.binding_key, row.binding_version)
    && configuration.publicPolicyRevisionId === row.public_policy_revision_id
    && configuration.operation.name === row.operation_name
    && configuration.operation.version === row.operation_version
    && configuration.scope.workspaceId === row.workspace_id
    && configuration.scope.eventId === row.event_id
    && configuration.purpose === row.purpose_key
    && configuration.action === row.action_key
    && canonicalJsonText(configuration.resourceBindings) === row.resource_bindings_json
    && configuration.actionAnchorId === row.action_anchor_id
    && configuration.lifetimeMs === row.lifetime_ms
    && sameReference(configuration.bootstrapVerifier, row.bootstrap_verifier_key, row.bootstrap_verifier_version)
    && sameReference(configuration.originPolicy, row.origin_policy_key, row.origin_policy_version)
    && sameReference(configuration.csrfPolicy, row.csrf_policy_key, row.csrf_policy_version)
    && sameReference(configuration.rateLimitPolicy, row.rate_limit_policy_key, row.rate_limit_policy_version)
    && sameReference(configuration.replayPolicy, row.replay_policy_key, row.replay_policy_version)
    && sameReference(configuration.principalPartitionProfile.reference, row.principal_profile_key, row.principal_profile_version)
    && configuration.principalPartitionProfile.keyVerifier === row.principal_key_verifier
    && sameReference(configuration.bootstrapReplayProfile.reference, row.replay_profile_key, row.replay_profile_version)
    && configuration.bootstrapReplayProfile.keyVerifier === row.replay_key_verifier
    && opened.principalPartitionKey === row.principal_partition_key
    && Date.parse(opened.ceremonyCreatedAt) === row.created_at_ms
    && Date.parse(opened.ceremonyExpiresAt) === row.expires_at_ms
    && aliases.length === configuration.continuationProfiles.length
    && aliases.every((alias, index) => {
      const expected = configuration.continuationProfiles[index];
      return alias.ordinal === index
        && expected !== undefined
        && sameReference(expected.reference, alias.profile_key, alias.profile_version)
        && expected.keyVerifier === alias.key_verifier;
    });
}

export class SQLitePublicMutationEffectCompletionPort
implements PublicMutationEffectCompletionPort {
  readonly #sqlite: Database;
  readonly #clock: Clock;
  readonly #newAuditEventId: () => AuditEventId;
  readonly #faults: SQLitePublicMutationEffectCompletionFaults;

  constructor(sqlite: Database, options: SQLitePublicMutationEffectCompletionOptions) {
    if (!options.clock || typeof options.clock.now !== 'function'
        || typeof options.newAuditEventId !== 'function') {
      throw new TypeError('public_mutation_effect_completion_options_invalid');
    }
    this.#sqlite = sqlite;
    this.#clock = Object.freeze({ now: options.clock.now.bind(options.clock) });
    this.#newAuditEventId = options.newAuditEventId.bind(options);
    this.#faults = options.faults ?? {};
  }

  #ceremony(ceremonyEvidenceId: string): CeremonyRow | undefined {
    return this.#sqlite.query<CeremonyRow, [string]>(`
      SELECT ceremony_evidence_id, binding_key, binding_version,
             public_policy_revision_id, operation_name, operation_version,
             workspace_id, event_id, purpose_key, action_key, action_anchor_id,
             resource_bindings_json,
             lifetime_ms, bootstrap_verifier_key, bootstrap_verifier_version,
             origin_policy_key, origin_policy_version, csrf_policy_key,
             csrf_policy_version, rate_limit_policy_key, rate_limit_policy_version,
             replay_policy_key, replay_policy_version, principal_profile_key,
             principal_profile_version, principal_key_verifier, replay_profile_key,
             replay_profile_version, replay_key_verifier, principal_partition_key,
             created_at_ms, expires_at_ms, revoked_at_ms, state, completion_reference
        FROM public_mutation_continuations_trial
       WHERE ceremony_evidence_id = ?
    `).get(ceremonyEvidenceId) ?? undefined;
  }

  #aliases(ceremonyEvidenceId: string): readonly AliasRow[] {
    return this.#sqlite.query<AliasRow, [string]>(`
      SELECT ordinal, profile_key, profile_version, key_verifier
        FROM public_mutation_continuation_aliases_trial
       WHERE ceremony_evidence_id = ?
       ORDER BY ordinal ASC
    `).all(ceremonyEvidenceId);
  }

  #completionByCeremony(ceremonyEvidenceId: string): CompletionRow | undefined {
    return this.#sqlite.query<CompletionRow, [string]>(`
      SELECT * FROM public_mutation_registered_effect_completions
       WHERE ceremony_evidence_id = ?
    `).get(ceremonyEvidenceId) ?? undefined;
  }

  #receipt(receiptId: string): TerminalEffectReceipt | undefined {
    const row = this.#sqlite.query<FoundationReceiptRow, [string]>(receiptSql).get(receiptId);
    return row ? receiptFromRow(row) : undefined;
  }

  complete(sealed: SealedPublicMutationEffectCompletion): PublicMutationEffectCompletionResult {
    if (!this.#sqlite.inTransaction) {
      throw new SQLitePublicMutationEffectCompletionError('transaction_required');
    }
    const opened = openPublicMutationEffectCompletion(sealed);
    if (!opened) throw new SQLitePublicMutationEffectCompletionError('invalid_seal');
    const authentic = opened.sealReader.open(opened.evidence);
    if (!authentic || canonicalJsonText(authentic.configuration) !== canonicalJsonText(opened.configuration)
        || authentic.principalPartitionKey !== opened.principalPartitionKey
        || authentic.createdAt !== opened.ceremonyCreatedAt
        || authentic.expiresAt !== opened.ceremonyExpiresAt) {
      throw new SQLitePublicMutationEffectCompletionError('invalid_seal');
    }

    const ceremonyId = authentic.ceremonyEvidenceId;
    const row = this.#ceremony(ceremonyId);
    if (!row) return Object.freeze({ kind: 'stopped', reason: 'not_available' });
    if (!rowMatchesMaterial(row, this.#aliases(ceremonyId), opened)) {
      return Object.freeze({ kind: 'stopped', reason: 'not_available' });
    }
    const now = parseInstant(this.#clock.now());
    if (row.revoked_at_ms !== null) {
      return Object.freeze({ kind: 'stopped', reason: 'revoked' });
    }
    if (Date.parse(now) >= row.expires_at_ms) {
      return Object.freeze({ kind: 'stopped', reason: 'expired' });
    }
    const current = opened.sealReader.openCurrent(opened.evidence);
    if (!current
        || canonicalJsonText(current.configuration) !== canonicalJsonText(opened.configuration)
        || current.principalPartitionKey !== opened.principalPartitionKey) {
      return Object.freeze({ kind: 'stopped', reason: 'policy_changed' });
    }

    const durableReceipt = this.#receipt(opened.receipt.ref.id);
    if (!durableReceipt || !exactReceipt(durableReceipt, opened.receipt)) {
      throw new SQLitePublicMutationEffectCompletionError('receipt_mismatch');
    }
    const configurationDigest = digest(opened.configuration);

    if (row.state === 'terminal') {
      const completion = this.#completionByCeremony(ceremonyId);
      if (!completion || row.completion_reference !== completion.completion_reference
          || completion.receipt_id !== opened.receipt.ref.id
          || completion.completion_reference !== opened.completionReference
          || completion.configuration_digest_sha256 !== configurationDigest
          || completion.principal_partition_key !== opened.principalPartitionKey
          || completion.scope_partition_key !== opened.receipt.identity.scopePartitionKey
          || completion.authority_principal_key !== opened.receipt.identity.authorityPrincipalKey
          || completion.operation_name !== opened.receipt.identity.operationName
          || completion.operation_version !== opened.receipt.identity.operationVersion
          || completion.surface !== opened.receipt.identity.surface
          || completion.idempotency_profile_key !== opened.receipt.identity.idempotencyVerifierProfile.key
          || completion.idempotency_profile_version !== opened.receipt.identity.idempotencyVerifierProfile.version
          || completion.idempotency_key_verifier !== opened.receipt.identity.idempotencyKeyVerifier
          || completion.request_hash !== opened.receipt.requestHash) {
        throw new SQLitePublicMutationEffectCompletionError('receipt_mismatch');
      }
      return Object.freeze({
        kind: 'terminal',
        completionReference: completion.completion_reference,
        receipt: durableReceipt,
        replay: true
      });
    }
    if (row.state !== 'ready' || row.completion_reference !== null) corrupt();

    try {
      this.#sqlite.query(`
        INSERT INTO public_mutation_effect_proofs_trial (
          ceremony_evidence_id, completion_reference, committed_at_ms
        ) VALUES (?, ?, ?)
      `).run(ceremonyId, opened.completionReference, Date.parse(now));
      this.#faults.afterProofInserted?.();
      const identity = opened.receipt.identity;
      this.#sqlite.query(`
        INSERT INTO public_mutation_registered_effect_completions (
          ceremony_evidence_id, completion_reference, receipt_id,
          scope_partition_key, authority_principal_key, operation_name,
          operation_version, surface, idempotency_profile_key,
          idempotency_profile_version, idempotency_key_verifier, request_hash,
          configuration_digest_sha256, principal_partition_key, completed_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ceremonyId,
        opened.completionReference,
        opened.receipt.ref.id,
        identity.scopePartitionKey,
        identity.authorityPrincipalKey,
        identity.operationName,
        identity.operationVersion,
        identity.surface,
        identity.idempotencyVerifierProfile.key,
        identity.idempotencyVerifierProfile.version,
        identity.idempotencyKeyVerifier,
        opened.receipt.requestHash,
        configurationDigest,
        opened.principalPartitionKey,
        Date.parse(now)
      );
      this.#faults.afterBindingInserted?.();
      const advanced = this.#sqlite.query(`
        UPDATE public_mutation_continuations_trial
           SET state = 'terminal', completion_reference = ?
         WHERE ceremony_evidence_id = ?
           AND state = 'ready'
           AND completion_reference IS NULL
           AND revoked_at_ms IS NULL
           AND expires_at_ms > ?
      `).run(opened.completionReference, ceremonyId, Date.parse(now));
      if (advanced.changes !== 1) {
        throw new SQLitePublicMutationEffectCompletionError('completion_collision');
      }
      this.#faults.afterCeremonyTerminal?.();
      this.#faults.beforeSecurityAudit?.();
      const configuration = opened.configuration;
      this.#sqlite.query(`
        INSERT INTO public_mutation_security_audits_trial (
          audit_event_id, ceremony_evidence_id, binding_key, binding_version,
          public_policy_revision_id, operation_name, operation_version,
          workspace_id, event_id, purpose_key, action_key, resource_bindings_json,
          action_anchor_id,
          disposition, reason_code, recorded_at_ms, origin_evidence_id,
          csrf_evidence_id, rate_limit_evidence_id, replay_evidence_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proof_terminal',
                  'registered_effect_terminal', ?, NULL, NULL, NULL, NULL)
      `).run(
        parseAuditEventId(this.#newAuditEventId()),
        ceremonyId,
        configuration.binding.key,
        configuration.binding.version,
        configuration.publicPolicyRevisionId,
        configuration.operation.name,
        configuration.operation.version,
        configuration.scope.workspaceId,
        configuration.scope.eventId,
        configuration.purpose,
        configuration.action,
        canonicalJsonText(configuration.resourceBindings),
        configuration.actionAnchorId,
        Date.parse(now)
      );
    } catch (error) {
      if (error instanceof SQLitePublicMutationEffectCompletionError) throw error;
      throw new SQLitePublicMutationEffectCompletionError('completion_collision');
    }

    return Object.freeze({
      kind: 'terminal',
      completionReference: opened.completionReference,
      receipt: durableReceipt,
      replay: false
    });
  }

  resume(candidate: string): TerminalEffectReceipt | undefined {
    let completionReference: string;
    try {
      completionReference = parsePublicMutationEffectCompletionReference(candidate);
    } catch (error) {
      if (error instanceof PublicMutationEffectCompletionError) return undefined;
      throw error;
    }
    const completion = this.#sqlite.query<CompletionRow, [string]>(`
      SELECT * FROM public_mutation_registered_effect_completions
       WHERE completion_reference = ?
    `).get(completionReference);
    if (!completion) return undefined;
    const ceremony = this.#ceremony(completion.ceremony_evidence_id);
    if (!ceremony || ceremony.state !== 'terminal'
        || ceremony.completion_reference !== completionReference) corrupt();
    const receipt = this.#receipt(completion.receipt_id);
    if (!receipt
        || receipt.identity.scopePartitionKey !== completion.scope_partition_key
        || receipt.identity.authorityPrincipalKey !== completion.authority_principal_key
        || receipt.identity.operationName !== completion.operation_name
        || receipt.identity.operationVersion !== completion.operation_version
        || receipt.identity.surface !== completion.surface
        || receipt.identity.idempotencyVerifierProfile.key !== completion.idempotency_profile_key
        || receipt.identity.idempotencyVerifierProfile.version !== completion.idempotency_profile_version
        || receipt.identity.idempotencyKeyVerifier !== completion.idempotency_key_verifier
        || receipt.requestHash !== completion.request_hash) corrupt();
    return receipt;
  }
}
