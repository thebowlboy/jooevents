import { canonicalJsonText, parseCeremonyEvidenceId, type Instant } from '@jooevents/kernel';
import type { EffectfulOperationResult } from '@jooevents/contracts';
import {
  effectOperationIdentityMatchesContext
} from './operations/effect-identity';
import { isSealedInvocationContext } from './operations/invocation-context';
import type {
  EffectInvocationContext,
  TerminalEffectReceipt
} from './operations/types';
import type {
  PublicMutationContinuationEvidence,
  PublicMutationContinuationSealReader,
  PublicMutationContinuationConfigurationSnapshot
} from './public-mutation-continuation';

const completionReferencePattern = /^pcr_[A-Za-z0-9_-]{24,240}$/;

export type PublicMutationEffectCompletionStopReason =
  | 'not_available'
  | 'expired'
  | 'revoked'
  | 'policy_changed';

export type PublicMutationEffectCompletionResult =
  | {
      readonly kind: 'terminal';
      readonly completionReference: string;
      readonly receipt: TerminalEffectReceipt;
      readonly replay: boolean;
    }
  | {
      readonly kind: 'stopped';
      readonly reason: PublicMutationEffectCompletionStopReason;
    };

export interface SealedPublicMutationEffectCompletion {
  readonly kind: 'public_mutation_effect_completion';
}

export interface OpenedPublicMutationEffectCompletion {
  readonly evidence: PublicMutationContinuationEvidence;
  readonly sealReader: PublicMutationContinuationSealReader;
  readonly configuration: PublicMutationContinuationConfigurationSnapshot;
  readonly principalPartitionKey: string;
  readonly ceremonyCreatedAt: Instant;
  readonly ceremonyExpiresAt: Instant;
  readonly context: EffectInvocationContext;
  readonly receipt: TerminalEffectReceipt;
  readonly completionReference: string;
}

export interface PublicMutationEffectCompletionPort {
  complete(
    completion: SealedPublicMutationEffectCompletion
  ): PublicMutationEffectCompletionResult;

  /**
   * Resolves an opaque terminal server reference. The caller must first have
   * obtained it from the continuation boundary's current terminal admission.
   */
  resume(completionReference: string): TerminalEffectReceipt | undefined;
}

export type PublicMutationEffectCompletionErrorCode =
  | 'invalid_completion_input'
  | 'continuation_mismatch'
  | 'operation_mismatch'
  | 'receipt_mismatch';

export class PublicMutationEffectCompletionError extends TypeError {
  constructor(readonly code: PublicMutationEffectCompletionErrorCode) {
    super(code);
    this.name = 'PublicMutationEffectCompletionError';
  }
}

const sealedCompletions = new WeakMap<object, OpenedPublicMutationEffectCompletion>();

function exactScope(
  configuration: PublicMutationContinuationConfigurationSnapshot,
  context: EffectInvocationContext
): boolean {
  return configuration.scope.workspaceId === context.scope.workspaceId
    && configuration.scope.eventId === context.scope.eventId;
}

function exactPublicAuthority(
  configuration: PublicMutationContinuationConfigurationSnapshot,
  context: EffectInvocationContext
): boolean {
  if (context.provenance.kind !== 'public_ceremony') return false;
  const principal = context.authority.principal;
  return context.actor.kind === 'public_request'
    && principal.kind === 'public_capability'
    && context.actor.authority.kind === 'mutation_ceremony'
    && principal.authority.kind === 'mutation_ceremony'
    && context.actor.publicPolicyRevisionId === configuration.publicPolicyRevisionId
    && principal.publicPolicyRevisionId === configuration.publicPolicyRevisionId
    && context.actor.authority.ceremonyEvidenceId === context.provenance.ceremonyEvidenceId
    && principal.authority.ceremonyEvidenceId === context.provenance.ceremonyEvidenceId;
}

function cloneReceipt(receipt: TerminalEffectReceipt): TerminalEffectReceipt {
  return Object.freeze({
    ref: Object.freeze({ ...receipt.ref }),
    identity: Object.freeze({
      ...receipt.identity,
      idempotencyVerifierProfile: Object.freeze({
        ...receipt.identity.idempotencyVerifierProfile
      })
    }),
    requestHash: receipt.requestHash,
    result: structuredClone(receipt.result) as EffectfulOperationResult
  });
}

function terminalResultMatchesReceipt(receipt: TerminalEffectReceipt): boolean {
  const result = receipt.result;
  if (result.kind === 'outcome' && result.terminal !== true) return false;
  return 'receipt' in result
    && result.receipt.id === receipt.ref.id
    && result.receipt.operationName === receipt.ref.operationName
    && result.receipt.operationVersion === receipt.ref.operationVersion;
}

/**
 * Seals one exact continuation-backed terminal receipt for transaction-owned
 * persistence. The raw continuation never enters this object or durable state.
 */
export function sealPublicMutationEffectCompletion(input: {
  readonly evidence: PublicMutationContinuationEvidence;
  readonly sealReader: PublicMutationContinuationSealReader;
  readonly context: EffectInvocationContext;
  readonly receipt: TerminalEffectReceipt;
  readonly completionReference: string;
}): SealedPublicMutationEffectCompletion {
  if (!completionReferencePattern.test(input.completionReference)) {
    throw new PublicMutationEffectCompletionError('invalid_completion_input');
  }
  if (!isSealedInvocationContext(input.context)
      || input.context.surface !== 'public_http'
      || input.context.provenance.kind !== 'public_ceremony'
      || input.context.operation.effect === 'read') {
    throw new PublicMutationEffectCompletionError('operation_mismatch');
  }
  const material = input.sealReader.open(input.evidence);
  if (!material
      || parseCeremonyEvidenceId(material.ceremonyEvidenceId)
        !== input.context.provenance.ceremonyEvidenceId) {
    throw new PublicMutationEffectCompletionError('continuation_mismatch');
  }
  if (material.configuration.operation.name !== input.context.operation.name
      || material.configuration.operation.version !== input.context.operation.version
      || !exactScope(material.configuration, input.context)
      || !exactPublicAuthority(material.configuration, input.context)) {
    throw new PublicMutationEffectCompletionError('operation_mismatch');
  }
  if (!effectOperationIdentityMatchesContext(input.receipt.identity, input.context)
      || input.receipt.ref.operationName !== input.context.operation.name
      || input.receipt.ref.operationVersion !== input.context.operation.version
      || input.receipt.requestHash !== input.context.requestBinding.requestHashSha256
      || !terminalResultMatchesReceipt(input.receipt)
      || canonicalJsonText(input.receipt.result).length === 0) {
    throw new PublicMutationEffectCompletionError('receipt_mismatch');
  }

  const sealed = Object.freeze({
    kind: 'public_mutation_effect_completion' as const
  });
  sealedCompletions.set(sealed, Object.freeze({
    evidence: input.evidence,
    sealReader: input.sealReader,
    configuration: structuredClone(material.configuration),
    principalPartitionKey: material.principalPartitionKey,
    ceremonyCreatedAt: material.createdAt,
    ceremonyExpiresAt: material.expiresAt,
    context: input.context,
    receipt: cloneReceipt(input.receipt),
    completionReference: input.completionReference
  }));
  return sealed;
}

/** Opens only a module-issued completion seal. */
export function openPublicMutationEffectCompletion(
  value: unknown
): OpenedPublicMutationEffectCompletion | undefined {
  return typeof value === 'object' && value !== null
    ? sealedCompletions.get(value)
    : undefined;
}

export function parsePublicMutationEffectCompletionReference(value: unknown): string {
  if (typeof value !== 'string' || !completionReferencePattern.test(value)) {
    throw new PublicMutationEffectCompletionError('invalid_completion_input');
  }
  return value;
}
