import {
  structuredOutcomeClassSchema,
  type OperationOutcomeDeclaration,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { canonicalJsonText } from '@jooevents/kernel';
import type { EffectHandlerRegistration, OrdinaryEffectOperationDefinition } from './types';

export type EffectExecutionFamily = 'single_unit_of_work';

export interface SingleUnitOfWorkFamilyRegistration {
  readonly reference: VersionedDefinitionRef;
  readonly kind: 'single_unit_of_work';
  readonly phase: VersionedDefinitionRef;
}

export interface SingleUnitOfWorkPhaseRegistration {
  readonly reference: VersionedDefinitionRef;
  readonly kind: 'single_unit_of_work';
  readonly family: VersionedDefinitionRef;
  readonly operation: { readonly name: string; readonly version: number };
  readonly effect: 'draft' | 'commit';
  readonly handler: VersionedDefinitionRef;
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly terminalization: VersionedDefinitionRef;
  readonly terminalOutcomeKeys: readonly string[];
  readonly contentionOutcome: StructuredOutcome;
}

export interface TerminalizationEvidence {
  readonly operation: { readonly name: string; readonly version: number };
  readonly phase: VersionedDefinitionRef;
  readonly result:
    | { readonly kind: 'success' }
    | {
        readonly kind: 'outcome';
        readonly outcomeClass: string;
        readonly outcomeKind: string;
        readonly retryable: boolean;
        readonly detailSchemaVersion: number;
      };
  readonly hasDomainContribution: boolean;
  readonly receiptChildCount: number;
}

export type TerminalizationDecision =
  | { readonly kind: 'terminal' }
  | { readonly kind: 'nonterminal' };

export interface TerminalizationResolverRegistration {
  readonly reference: VersionedDefinitionRef;
  readonly kind: 'synchronous_pure_terminalization';
  readonly operation: { readonly name: string; readonly version: number };
  readonly phase: VersionedDefinitionRef;
  resolve(evidence: TerminalizationEvidence): TerminalizationDecision;
}

const stableKey = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const trustedFamilies = new WeakSet<object>();
const trustedPhases = new WeakSet<object>();
const trustedTerminalizationResolvers = new WeakSet<object>();

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function assertRef(reference: VersionedDefinitionRef, label: string): void {
  if (!stableKey.test(reference.key) || !Number.isSafeInteger(reference.version) || reference.version <= 0) {
    throw new TypeError(`${label} must be an exact versioned reference`);
  }
}

function assertOperation(operation: { readonly name: string; readonly version: number }): void {
  if (!stableKey.test(operation.name) || !Number.isSafeInteger(operation.version) || operation.version <= 0) {
    throw new TypeError('phase registration must identify an exact operation version');
  }
}

function terminalOutcomeKeys(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 100) {
    throw new TypeError('terminal outcome allowlist must be bounded');
  }
  const parsed = values.map((value) => {
    if (typeof value !== 'string') throw new TypeError('terminal outcome allowlist uses invalid keys');
    const separator = value.indexOf(':');
    const outcomeClass = value.slice(0, separator);
    const outcomeKind = value.slice(separator + 1);
    if (separator <= 0 || value.indexOf(':', separator + 1) !== -1
      || !structuredOutcomeClassSchema.safeParse(outcomeClass).success
      || !stableKey.test(outcomeKind)) {
      throw new TypeError('terminal outcome allowlist uses invalid keys');
    }
    return `${outcomeClass}:${outcomeKind}`;
  });
  const normalized = [...new Set(parsed)].sort();
  if (normalized.length !== values.length) throw new TypeError('terminal outcome allowlist contains duplicates');
  return Object.freeze(normalized);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { readonly then?: unknown }).then === 'function');
}

function parseDecision(value: unknown): TerminalizationDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('terminalization resolver returned an invalid decision');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || (record.kind !== 'terminal' && record.kind !== 'nonterminal')) {
    throw new TypeError('terminalization resolver returned an invalid decision');
  }
  return Object.freeze({ kind: record.kind });
}

function summarizeCanonicalResult(value: unknown): TerminalizationEvidence['result'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('terminalization requires a canonical result envelope');
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'success') return Object.freeze({ kind: 'success' });
  const outcome = record.outcome;
  if (record.kind !== 'outcome' || !outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
    throw new TypeError('terminalization requires a canonical result envelope');
  }
  const candidate = outcome as Record<string, unknown>;
  if (typeof candidate.class !== 'string' || typeof candidate.kind !== 'string'
    || typeof candidate.retryable !== 'boolean'
    || !Number.isSafeInteger(candidate.detailSchemaVersion)) {
    throw new TypeError('terminalization requires declared outcome evidence');
  }
  return Object.freeze({
    kind: 'outcome',
    outcomeClass: candidate.class,
    outcomeKind: candidate.kind,
    retryable: candidate.retryable,
    detailSchemaVersion: candidate.detailSchemaVersion as number
  });
}

export function createSingleUnitOfWorkFamilyRegistration(input: {
  readonly reference: VersionedDefinitionRef;
  readonly phase: VersionedDefinitionRef;
}): SingleUnitOfWorkFamilyRegistration {
  assertRef(input.reference, 'execution family');
  assertRef(input.phase, 'execution phase');
  const registration = deepFreeze<SingleUnitOfWorkFamilyRegistration>({
    reference: { ...input.reference },
    kind: 'single_unit_of_work',
    phase: { ...input.phase }
  });
  trustedFamilies.add(registration);
  return registration;
}

export function createSingleUnitOfWorkPhaseRegistration(input: {
  readonly reference: VersionedDefinitionRef;
  readonly family: VersionedDefinitionRef;
  readonly operation: { readonly name: string; readonly version: number };
  readonly effect: 'draft' | 'commit';
  readonly handler: VersionedDefinitionRef;
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly terminalization: VersionedDefinitionRef;
  readonly terminalOutcomeKeys: readonly string[];
  readonly contentionOutcome: StructuredOutcome;
}): SingleUnitOfWorkPhaseRegistration {
  assertRef(input.reference, 'execution phase');
  assertRef(input.family, 'execution family');
  assertRef(input.handler, 'phase handler');
  assertRef(input.handlerCapability, 'phase handler capability');
  assertRef(input.contributionSchema, 'phase contribution schema');
  assertRef(input.terminalization, 'phase terminalization');
  assertOperation(input.operation);
  const registration = deepFreeze<SingleUnitOfWorkPhaseRegistration>({
    reference: { ...input.reference },
    kind: 'single_unit_of_work',
    family: { ...input.family },
    operation: { ...input.operation },
    effect: input.effect,
    handler: { ...input.handler },
    handlerCapability: { ...input.handlerCapability },
    contributionSchema: { ...input.contributionSchema },
    terminalization: { ...input.terminalization },
    terminalOutcomeKeys: terminalOutcomeKeys(input.terminalOutcomeKeys),
    contentionOutcome: structuredClone(input.contentionOutcome)
  });
  trustedPhases.add(registration);
  return registration;
}

export function createTerminalizationResolverRegistration(input: {
  readonly reference: VersionedDefinitionRef;
  readonly operation: { readonly name: string; readonly version: number };
  readonly phase: VersionedDefinitionRef;
  readonly resolve: (evidence: TerminalizationEvidence) => TerminalizationDecision | Promise<TerminalizationDecision>;
}): TerminalizationResolverRegistration {
  assertRef(input.reference, 'terminalization resolver');
  assertRef(input.phase, 'terminalization phase');
  assertOperation(input.operation);
  const resolve = input.resolve;
  if (resolve.constructor.name === 'AsyncFunction') {
    throw new TypeError('terminalization resolver must be synchronous');
  }
  const registration: TerminalizationResolverRegistration = Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    kind: 'synchronous_pure_terminalization',
    operation: Object.freeze({ ...input.operation }),
    phase: Object.freeze({ ...input.phase }),
    resolve(evidence: TerminalizationEvidence) {
      const candidate = resolve(deepFreeze(structuredClone(evidence)));
      if (isPromiseLike(candidate)) throw new TypeError('terminalization resolver must be synchronous');
      return parseDecision(candidate);
    }
  });
  trustedTerminalizationResolvers.add(registration);
  return registration;
}

export function isTrustedSingleUnitOfWorkFamilyRegistration(
  value: unknown
): value is SingleUnitOfWorkFamilyRegistration {
  return typeof value === 'object' && value !== null && trustedFamilies.has(value);
}

export function isTrustedSingleUnitOfWorkPhaseRegistration(
  value: unknown
): value is SingleUnitOfWorkPhaseRegistration {
  return typeof value === 'object' && value !== null && trustedPhases.has(value);
}

export function isTrustedTerminalizationResolverRegistration(
  value: unknown
): value is TerminalizationResolverRegistration {
  return typeof value === 'object' && value !== null && trustedTerminalizationResolvers.has(value);
}

export function assertSynchronousEffectHandler(handler: EffectHandlerRegistration): void {
  if (handler.handle.constructor.name === 'AsyncFunction') {
    throw new TypeError('single-unit-of-work handlers must be synchronous');
  }
}

export function resolveTerminalization(input: {
  readonly operation: OrdinaryEffectOperationDefinition;
  readonly phase: SingleUnitOfWorkPhaseRegistration;
  readonly resolver: TerminalizationResolverRegistration;
  readonly evidence: Omit<TerminalizationEvidence, 'operation' | 'phase'>;
}): TerminalizationDecision {
  const evidence = deepFreeze<TerminalizationEvidence>({
    operation: { name: input.operation.name, version: input.operation.version },
    phase: { ...input.phase.reference },
    result: structuredClone(input.evidence.result),
    hasDomainContribution: input.evidence.hasDomainContribution,
    receiptChildCount: input.evidence.receiptChildCount
  });
  const first = input.resolver.resolve(evidence);
  const second = input.resolver.resolve(structuredClone(evidence));
  if (canonicalJsonText(first) !== canonicalJsonText(second)) {
    throw new TypeError('terminalization resolver is nondeterministic');
  }
  if (first.kind === 'terminal' && evidence.result.kind === 'outcome'
    && !input.phase.terminalOutcomeKeys.includes(
      `${evidence.result.outcomeClass}:${evidence.result.outcomeKind}`
    )) {
    throw new TypeError('terminalization resolver selected an outcome outside the phase allowlist');
  }
  return first;
}

export function probeTerminalizationResolver(input: {
  readonly operation: { readonly name: string; readonly version: number };
  readonly phase: VersionedDefinitionRef;
  readonly resolver: TerminalizationResolverRegistration;
}): void {
  for (const hasDomainContribution of [false, true]) {
    for (const receiptChildCount of [0, 1]) {
      const evidence: TerminalizationEvidence = {
        operation: { ...input.operation },
        phase: { ...input.phase },
        result: { kind: 'success' },
        hasDomainContribution,
        receiptChildCount
      };
      const first = input.resolver.resolve(evidence);
      const second = input.resolver.resolve(structuredClone(evidence));
      if (canonicalJsonText(first) !== canonicalJsonText(second)) {
        throw new TypeError('terminalization resolver is nondeterministic');
      }
      if (first.kind !== 'terminal') {
        throw new TypeError('successful effect results must terminalize');
      }
    }
  }
}

export function probeTerminalizationOutcomes(input: {
  readonly operation: OrdinaryEffectOperationDefinition;
  readonly phase: SingleUnitOfWorkPhaseRegistration;
  readonly resolver: TerminalizationResolverRegistration;
  readonly outcomes: readonly OperationOutcomeDeclaration[];
}): void {
  for (const outcome of input.outcomes) {
    for (const hasDomainContribution of [false, true]) {
      for (const receiptChildCount of [0, 1]) {
        resolveTerminalization({
          operation: input.operation,
          phase: input.phase,
          resolver: input.resolver,
          evidence: {
            result: {
              kind: 'outcome',
              outcomeClass: outcome.class,
              outcomeKind: outcome.kind,
              retryable: outcome.retryable,
              detailSchemaVersion: outcome.detailSchema.version
            },
            hasDomainContribution,
            receiptChildCount
          }
        });
      }
    }
  }
}

export function terminalizationEvidenceFor(input: {
  readonly canonicalResult: unknown;
  readonly domainContribution: unknown;
  readonly receiptChildren: readonly unknown[];
}): Omit<TerminalizationEvidence, 'operation' | 'phase'> {
  return deepFreeze({
    result: summarizeCanonicalResult(input.canonicalResult),
    hasDomainContribution: input.domainContribution !== null,
    receiptChildCount: input.receiptChildren.length
  });
}
