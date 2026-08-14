import {
  operationNameSchema,
  operationOutcomeDeclarationSchema,
  operationVersionSchema,
  safeOperationManifestBodySchema,
  safeOperationManifestEntrySchema,
  safeOperationManifestSchema,
  safeSchemaManifestRefSchema,
  versionedDefinitionRefSchema,
  type OperationRisk,
  type SafeOperationAutonomy,
  type SafeOperationManifestBody,
  type SafeOperationManifestEntry,
  type SafeSchemaManifestRef,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { parseOperationAccessLane, type OperationAccessLane } from '@jooevents/identity-access';
import { canonicalJsonText, parseCapabilityRevisionId } from '@jooevents/kernel';
import {
  isTrustedOperationAutonomyPolicy,
  validateOperationAutonomyPolicy,
  type OperationAutonomyPolicy
} from '../autonomy';
import { getTrustedInvocationBuilderBinding } from './invocation-context';
import {
  isTrustedAutonomyEvidenceResolverRegistration,
  isTrustedAutonomyPreflightRegistration,
  isTrustedOperationRiskResolverRegistration,
  isTrustedRenewedApprovalResolverRegistration,
  probeAutonomyRegistrations,
  type AutonomyEvidenceResolverRegistration,
  type AutonomyPreflightRegistration,
  type OperationRiskResolverRegistration,
  type RenewedApprovalResolverRegistration
} from './autonomy-preflight';
import {
  assertSynchronousEffectHandler,
  isTrustedSingleUnitOfWorkFamilyRegistration,
  isTrustedSingleUnitOfWorkPhaseRegistration,
  isTrustedTerminalizationResolverRegistration,
  probeTerminalizationOutcomes,
  probeTerminalizationResolver,
  type SingleUnitOfWorkFamilyRegistration,
  type SingleUnitOfWorkPhaseRegistration,
  type TerminalizationResolverRegistration
} from './phase-contract';
import type {
  EffectContextBuilderRegistration,
  EffectHandlerRegistration,
  EffectOperationBindingDefinition,
  OperationRegistrySource,
  OperationRegistry,
  OperationAuditTargetRegistration,
  OperationAuditRecordProfileRegistration,
  OrdinaryEffectOperationDefinition,
  ReadCapabilityRegistration,
  ReadContextBuilderRegistration,
  ReadHandlerRegistration,
  ReadOperationDefinition,
  ReadOperationRegistry,
  ReadOperationRegistrySource,
  ReadProjectionRegistration,
  ReadOperationalTraceTargetRegistration,
  RegisteredAppModelEffectBinding,
  RegisteredAppModelReadBinding,
  RegisteredExternalMcpReadBinding,
  InternalOperationBindingManifestEntry,
  InternalOperationManifest,
  RegisteredOperationSchema,
  RegisteredOperatorHttpEffectBinding,
  RegisteredOperatorHttpReadBinding,
  RegisteredParticipantHttpEffectBinding,
  RegisteredParticipantHttpReadBinding,
  RegisteredPublicHttpEffectBinding,
  RegisteredPublicHttpReadBinding,
  RegisteredReadOperationBinding,
  RegistryValidationIssue
} from './types';
import {
  isPublicEffectConformanceActivation,
  isPublicEffectConformanceBuilderFor,
  type PublicEffectConformanceActivation
} from './public-effect-conformance-activation';

interface CompiledBinding {
  readonly public: RegisteredReadOperationBinding;
  readonly projection: ReadProjectionRegistration;
  readonly projectedResultSchema: RegisteredOperationSchema;
}

export interface CompiledReadOperation {
  readonly definition: ReadOperationDefinition;
  readonly autonomyPolicy: OperationAutonomyPolicy;
  readonly inputSchema: RegisteredOperationSchema;
  readonly canonicalResultSchema: RegisteredOperationSchema;
  readonly contextBuilder: ReadContextBuilderRegistration;
  readonly readCapability: ReadCapabilityRegistration;
  readonly handler: ReadHandlerRegistration;
  readonly traceTarget: ReadOperationalTraceTargetRegistration;
  readonly traceRecordProfile: OperationAuditRecordProfileRegistration;
  readonly auditTarget?: OperationAuditTargetRegistration;
  readonly auditRecordProfile?: OperationAuditRecordProfileRegistration;
  readonly outcomes: ReadonlyMap<string, ReadOperationDefinition['outcomes'][number]>;
  readonly bindings: ReadonlyMap<string, CompiledBinding>;
  readonly schemas: ReadonlyMap<string, RegisteredOperationSchema>;
}

interface RegistryState {
  readonly readOperations: ReadonlyMap<string, CompiledReadOperation>;
  readonly effectOperations: ReadonlyMap<string, CompiledEffectOperation>;
  readonly registeredConsumerOperations: ReadonlyMap<string, {
    readonly operation: CompiledEffectOperation;
    readonly binding: CompiledRegisteredConsumerEffectBinding;
  }>;
  readonly registeredJobOperations: ReadonlyMap<string, {
    readonly operation: CompiledEffectOperation;
    readonly binding: CompiledRegisteredJobEffectBinding;
  }>;
}

export interface CompiledOperatorHttpEffectBinding {
  readonly surface: 'operator_http';
  readonly method: 'POST';
  readonly path: string;
  readonly input: 'body';
  readonly projection: ReadProjectionRegistration;
  readonly projectedResultSchema: RegisteredOperationSchema;
}

export interface CompiledParticipantHttpEffectBinding {
  readonly surface: 'participant_http';
  readonly method: 'POST';
  readonly path: string;
  readonly input: 'body';
  readonly projection: ReadProjectionRegistration;
  readonly projectedResultSchema: RegisteredOperationSchema;
}

export interface CompiledPublicHttpEffectBinding {
  readonly surface: 'public_http';
  readonly method: 'POST';
  readonly path: string;
  readonly input: 'body';
  readonly browserResumption: RegisteredPublicHttpEffectBinding['browserResumption'];
  readonly projection: ReadProjectionRegistration;
  readonly projectedResultSchema: RegisteredOperationSchema;
}

export interface CompiledAppModelEffectBinding {
  readonly surface: 'app_model';
  readonly toolName: string;
  readonly projection: ReadProjectionRegistration;
  readonly projectedResultSchema: RegisteredOperationSchema;
}

export type CompiledEffectBinding =
  | CompiledOperatorHttpEffectBinding
  | CompiledParticipantHttpEffectBinding
  | CompiledPublicHttpEffectBinding
  | CompiledAppModelEffectBinding;

export interface CompiledRegisteredConsumerEffectBinding {
  readonly surface: 'application_job';
  readonly lane: 'registered_consumer';
  readonly consumer: VersionedDefinitionRef;
  readonly projection: ReadProjectionRegistration;
  readonly projectedResultSchema: RegisteredOperationSchema;
}

export interface CompiledRegisteredJobEffectBinding {
  readonly surface: 'application_job';
  readonly lane: 'registered_job';
  readonly job: VersionedDefinitionRef;
  readonly inputProjection: VersionedDefinitionRef;
  readonly capabilityRevisionId: NonNullable<OrdinaryEffectOperationDefinition['registeredJobBindings']>[number]['capabilityRevisionId'];
  readonly authorityCitation: VersionedDefinitionRef;
  readonly projection: ReadProjectionRegistration;
  readonly projectedResultSchema: RegisteredOperationSchema;
}

export interface CompiledEffectOperation {
  readonly definition: OrdinaryEffectOperationDefinition;
  readonly autonomyPolicy: OperationAutonomyPolicy;
  readonly inputSchema: RegisteredOperationSchema;
  readonly contributionSchema: RegisteredOperationSchema;
  readonly canonicalResultSchema: RegisteredOperationSchema;
  readonly contextBuilder: EffectContextBuilderRegistration;
  readonly handler: EffectHandlerRegistration;
  readonly executionFamily: SingleUnitOfWorkFamilyRegistration;
  readonly executionPhase: SingleUnitOfWorkPhaseRegistration;
  readonly terminalizationResolver: TerminalizationResolverRegistration;
  readonly autonomyPreflight: AutonomyPreflightRegistration;
  readonly riskResolver: OperationRiskResolverRegistration;
  readonly autonomyEvidenceResolver: AutonomyEvidenceResolverRegistration;
  readonly renewedApprovalResolver: RenewedApprovalResolverRegistration;
  readonly auditTarget: OperationAuditTargetRegistration;
  readonly auditRecordProfile: OperationAuditRecordProfileRegistration;
  readonly outcomes: ReadonlyMap<string, OrdinaryEffectOperationDefinition['outcomes'][number]>;
  readonly bindings: ReadonlyMap<string, CompiledEffectBinding>;
  readonly registeredConsumerBindings: ReadonlyMap<string, CompiledRegisteredConsumerEffectBinding>;
  readonly registeredJobBindings: ReadonlyMap<string, CompiledRegisteredJobEffectBinding>;
  readonly schemas: ReadonlyMap<string, RegisteredOperationSchema>;
}

const registryStates = new WeakMap<ReadOperationRegistry, RegistryState>();
const riskRank: Readonly<Record<OperationRisk, number>> = { low: 0, normal: 1, consequential: 2 };

export class OperationRegistryValidationError extends Error {
  readonly issues: readonly RegistryValidationIssue[];

  constructor(issues: readonly RegistryValidationIssue[]) {
    super(`Operation registry validation failed with ${issues.length} issue(s).`);
    this.name = 'OperationRegistryValidationError';
    this.issues = Object.freeze([...issues]);
  }
}

function refKey(reference: VersionedDefinitionRef): string {
  return `${reference.key}@${reference.version}`;
}

function operationKey(name: string, version: number): string {
  return `${name}@${version}`;
}

function sameRef(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

function sameSchemaRef(left: SafeSchemaManifestRef, right: SafeSchemaManifestRef): boolean {
  return sameRef(left, right) && left.digestSha256 === right.digestSha256;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJsonText(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function sealedReadonlyMap<Key, Value>(source: ReadonlyMap<Key, Value>): ReadonlyMap<Key, Value> {
  const snapshot = new Map<Key, Value>();
  for (const [key, value] of source) snapshot.set(key, deepFreeze(value));
  let view: ReadonlyMap<Key, Value>;
  view = Object.freeze({
    get size() { return snapshot.size; },
    has(key: Key) { return snapshot.has(key); },
    get(key: Key) { return snapshot.get(key); },
    entries() { return snapshot.entries(); },
    keys() { return snapshot.keys(); },
    values() { return snapshot.values(); },
    forEach(callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void, thisArg?: unknown) {
      snapshot.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
    [Symbol.iterator]() { return snapshot[Symbol.iterator](); }
  });
  return view;
}

function capturedSchemaRegistration(registration: RegisteredOperationSchema): RegisteredOperationSchema {
  const parser = registration.schema;
  const safeParse = parser?.safeParse;
  return Object.freeze({
    reference: deepFreeze({ ...registration.reference }),
    schema: Object.freeze({
      safeParse(value: unknown) {
        if (typeof safeParse !== 'function') throw new TypeError('registered schema has no captured parser');
        return Reflect.apply(safeParse, parser, [value]);
      }
    }) as unknown as RegisteredOperationSchema['schema']
  });
}

function capturedProjectionRegistration(registration: ReadProjectionRegistration): ReadProjectionRegistration {
  const project = registration.project;
  return Object.freeze({
    reference: deepFreeze({ ...registration.reference }),
    canonicalResultSchema: deepFreeze({ ...registration.canonicalResultSchema }),
    projectedResultSchema: deepFreeze({ ...registration.projectedResultSchema }),
    project(canonicalResult: unknown) {
      if (typeof project !== 'function') throw new TypeError('registered projection has no captured implementation');
      return Reflect.apply(project, undefined, [canonicalResult]);
    }
  });
}

function capturedEffectHandlerRegistration(registration: EffectHandlerRegistration): EffectHandlerRegistration {
  const handle = registration.handle;
  return Object.freeze({
    reference: deepFreeze({ ...registration.reference }),
    effect: registration.effect,
    handlerCapability: deepFreeze({ ...registration.handlerCapability }),
    contributionSchema: deepFreeze({ ...registration.contributionSchema }),
    canonicalResultSchema: deepFreeze({ ...registration.canonicalResultSchema }),
    handle(value: Parameters<EffectHandlerRegistration['handle']>[0]) {
      if (typeof handle !== 'function') throw new TypeError('registered effect handler has no captured implementation');
      return Reflect.apply(handle, undefined, [value]);
    }
  });
}

function referenceMap<Item>(input: {
  readonly category: string;
  readonly items: readonly Item[];
  readonly reference: (item: Item) => VersionedDefinitionRef;
  readonly issues: RegistryValidationIssue[];
}): Map<string, Item> {
  const result = new Map<string, Item>();
  for (const item of input.items) {
    const reference = input.reference(item);
    if (!versionedDefinitionRefSchema.safeParse({ key: reference.key, version: reference.version }).success) {
      input.issues.push({ code: 'invalid_reference', detail: `${input.category} has an invalid key or version.` });
      continue;
    }
    const key = refKey(reference);
    if (result.has(key)) {
      input.issues.push({ code: 'duplicate_reference', detail: `${input.category} reference ${key} is duplicated.` });
      continue;
    }
    result.set(key, item);
  }
  return result;
}

function findSchema(
  schemas: ReadonlyMap<string, RegisteredOperationSchema>,
  reference: SafeSchemaManifestRef,
  usage: string,
  issues: RegistryValidationIssue[],
  operation?: ReadOperationDefinition | OrdinaryEffectOperationDefinition
): RegisteredOperationSchema | undefined {
  if (!safeSchemaManifestRefSchema.safeParse(reference).success) {
    issues.push({
      code: 'invalid_schema_reference',
      detail: `${usage} has an invalid schema reference.`,
      ...(operation ? { operationName: operation.name, operationVersion: operation.version } : {})
    });
    return undefined;
  }
  const registered = schemas.get(refKey(reference));
  if (!registered) {
    issues.push({
      code: 'missing_schema_reference',
      detail: `${usage} references missing schema ${refKey(reference)}.`,
      ...(operation ? { operationName: operation.name, operationVersion: operation.version } : {})
    });
    return undefined;
  }
  if (!sameSchemaRef(reference, registered.reference)) {
    issues.push({
      code: 'schema_digest_mismatch',
      detail: `${usage} does not match the registered digest for ${refKey(reference)}.`,
      ...(operation ? { operationName: operation.name, operationVersion: operation.version } : {})
    });
    return undefined;
  }
  return registered;
}

function findDefinition<Item>(input: {
  readonly map: ReadonlyMap<string, Item>;
  readonly reference: VersionedDefinitionRef;
  readonly usage: string;
  readonly issues: RegistryValidationIssue[];
  readonly operation: ReadOperationDefinition | OrdinaryEffectOperationDefinition;
}): Item | undefined {
  if (!versionedDefinitionRefSchema.safeParse(input.reference).success) {
    input.issues.push({
      code: 'invalid_definition_reference',
      detail: `${input.usage} has an invalid definition reference.`,
      operationName: input.operation.name,
      operationVersion: input.operation.version
    });
    return undefined;
  }
  const found = input.map.get(refKey(input.reference));
  if (!found) {
    input.issues.push({
      code: 'missing_definition_reference',
      detail: `${input.usage} references missing definition ${refKey(input.reference)}.`,
      operationName: input.operation.name,
      operationVersion: input.operation.version
    });
  }
  return found;
}

function findAutonomyPolicy(input: {
  readonly policies: ReadonlyMap<string, OperationAutonomyPolicy>;
  readonly operation: ReadOperationDefinition | OrdinaryEffectOperationDefinition;
  readonly issues: RegistryValidationIssue[];
}): OperationAutonomyPolicy | undefined {
  const reference = (input.operation as { readonly autonomyPolicy?: unknown }).autonomyPolicy;
  if (!versionedDefinitionRefSchema.safeParse(reference).success) {
    input.issues.push({
      code: 'missing_autonomy_policy',
      detail: 'Every operation must cite one versioned autonomy policy.',
      operationName: input.operation.name,
      operationVersion: input.operation.version
    });
    return undefined;
  }
  const policy = input.policies.get(refKey(reference as VersionedDefinitionRef));
  if (!policy) {
    input.issues.push({
      code: 'missing_autonomy_policy',
      detail: `Operation cites unregistered autonomy policy ${refKey(reference as VersionedDefinitionRef)}.`,
      operationName: input.operation.name,
      operationVersion: input.operation.version
    });
    return undefined;
  }
  if (
    policy.operation.name !== input.operation.name
    || policy.operation.version !== input.operation.version
  ) {
    input.issues.push({
      code: 'autonomy_policy_operation_mismatch',
      detail: 'Autonomy policy is sealed to another operation name/version.',
      operationName: input.operation.name,
      operationVersion: input.operation.version
    });
  }
  if (riskRank[policy.riskFloor] > riskRank[input.operation.maxRisk]) {
    input.issues.push({
      code: 'autonomy_risk_floor_above_max',
      detail: 'Autonomy policy risk floor cannot exceed the operation maximum risk.',
      operationName: input.operation.name,
      operationVersion: input.operation.version
    });
  }
  return policy;
}

function safeAutonomy(policy: OperationAutonomyPolicy): SafeOperationAutonomy {
  return {
    policy: { ...policy.definition },
    riskFloor: policy.riskFloor,
    unattendedRiskCeiling: policy.unattendedRiskCeiling,
    requiresSeparateApproval: policy.requiresSeparateApproval,
    supportedDispositions: [...policy.supportedDispositions],
    triggerDispositions: { ...policy.triggerDispositions }
  };
}

function compareOperation(
  left: ReadOperationDefinition | OrdinaryEffectOperationDefinition,
  right: ReadOperationDefinition | OrdinaryEffectOperationDefinition
): number {
  return left.name.localeCompare(right.name) || left.version - right.version;
}

function laneKey(lane: OperationAccessLane): string {
  return `${lane.surface}:${lane.kind}:${lane.policy.key}@${lane.policy.version}`;
}

function laneIdentity(lane: OperationAccessLane): string {
  return `${lane.surface}:${lane.kind}`;
}

function normalizeOperationAccessLanes(
  operation: ReadOperationDefinition | OrdinaryEffectOperationDefinition,
  issues: RegistryValidationIssue[],
  publicEffectConformanceActivation?: PublicEffectConformanceActivation
): readonly OperationAccessLane[] {
  const raw = (operation as { readonly accessLanes?: unknown }).accessLanes;
  if (!Array.isArray(raw)) {
    issues.push({
      code: 'missing_access_lanes',
      detail: 'Operation must declare its internal access lanes inline.',
      operationName: operation.name,
      operationVersion: operation.version
    });
    return Object.freeze([]);
  }
  const parsed: OperationAccessLane[] = [];
  for (const candidate of raw) {
    try {
      parsed.push(parseOperationAccessLane(candidate));
    } catch {
      issues.push({
        code: 'invalid_access_lane',
        detail: 'Operation contains an invalid or surface-substituted access lane.',
        operationName: operation.name,
        operationVersion: operation.version
      });
    }
  }
  parsed.sort((left, right) => laneKey(left).localeCompare(laneKey(right)));
  const identities = parsed.map(laneIdentity);
  if (new Set(identities).size !== identities.length) {
    issues.push({
      code: 'substitutable_access_lane',
      detail: 'One operation cannot register competing policies for the same evidence lane.',
      operationName: operation.name,
      operationVersion: operation.version
    });
  }

  const registeredConsumerBindings = 'registeredConsumerBindings' in operation
    ? operation.registeredConsumerBindings ?? []
    : [];
  const registeredJobBindings = 'registeredJobBindings' in operation
    ? operation.registeredJobBindings ?? []
    : [];
  const boundSurfaces = new Set<string>([
    ...operation.bindings.map((binding) => binding.surface),
    ...registeredConsumerBindings.map((binding) => binding.surface),
    ...registeredJobBindings.map((binding) => binding.surface)
  ]);
  const laneSurfaces = new Set<string>(parsed.map((lane) => lane.surface));
  for (const surface of boundSurfaces) {
    if (!laneSurfaces.has(surface)) {
      issues.push({
        code: 'missing_access_lane',
        detail: `Enabled surface ${surface} has no access lane.`,
        operationName: operation.name,
        operationVersion: operation.version
      });
    }
  }
  for (const surface of laneSurfaces) {
    if (!boundSurfaces.has(surface)) {
      issues.push({
        code: 'extra_access_lane',
        detail: `Access lane surface ${surface} is not enabled by the operation.`,
        operationName: operation.name,
        operationVersion: operation.version
      });
    }
  }
  if (operation.effect !== 'read' && parsed.some((lane) =>
    lane.kind === 'public_open'
    || (lane.kind === 'public_ceremony'
      && !isPublicEffectConformanceActivation(publicEffectConformanceActivation))
  )) {
    issues.push({
      code: 'public_effect_lane_unactivated',
      detail: 'Effectful public lanes remain unactivated.',
      operationName: operation.name,
      operationVersion: operation.version
    });
  }
  if (operation.effect === 'commit' && parsed.some((lane) => lane.kind === 'app_model')) {
    issues.push({
      code: 'app_model_commit_lane',
      detail: 'App-model access cannot be registered for commit operations.',
      operationName: operation.name,
      operationVersion: operation.version
    });
  }
  return Object.freeze(parsed);
}

function sameLaneSet(left: readonly OperationAccessLane[], right: readonly OperationAccessLane[]): boolean {
  if (left.length !== right.length) return false;
  const leftKeys = left.map(laneKey).sort();
  const rightKeys = right.map(laneKey).sort();
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

function validateTrustedContextBuilder(input: {
  readonly builder: ReadContextBuilderRegistration | EffectContextBuilderRegistration | undefined;
  readonly operation: ReadOperationDefinition | OrdinaryEffectOperationDefinition;
  readonly accessLanes: readonly OperationAccessLane[];
  readonly issues: RegistryValidationIssue[];
  readonly publicEffectConformanceActivation?: PublicEffectConformanceActivation;
}): void {
  if (!input.builder) return;
  const binding = getTrustedInvocationBuilderBinding(input.builder);
  if (!binding) return;
  if (binding.operation.name !== input.operation.name || binding.operation.version !== input.operation.version) {
    input.issues.push({
      code: 'context_builder_operation_mismatch',
      detail: 'Context builder is sealed to another operation identity.',
      operationName: input.operation.name,
      operationVersion: input.operation.version
    });
  }
  if (binding.operation.effect !== input.operation.effect) {
    input.issues.push({
      code: 'context_builder_effect_mismatch',
      detail: 'Context builder is sealed to another operation effect.',
      operationName: input.operation.name,
      operationVersion: input.operation.version
    });
  }
  if (!sameLaneSet(binding.accessLanes, input.accessLanes)) {
    input.issues.push({
      code: 'context_builder_access_lane_mismatch',
      detail: 'Context builder and operation must have the exact same access-lane set.',
      operationName: input.operation.name,
      operationVersion: input.operation.version
    });
  }
  if (input.operation.effect !== 'read'
      && input.accessLanes.some((lane) => lane.kind === 'public_ceremony')
      && !isPublicEffectConformanceBuilderFor(
        input.builder,
        input.publicEffectConformanceActivation
      )) {
    input.issues.push({
      code: 'public_effect_context_unactivated',
      detail: 'A public ceremony effect requires the same isolated activation as its registry.',
      operationName: input.operation.name,
      operationVersion: input.operation.version
    });
  }
  if (input.operation.effect !== 'read') {
    const expectedRequestHash = input.operation.idempotency.requestHashProfile;
    const actualRequestHash = binding.requestHashProfile;
    if (!actualRequestHash || !sameRef(actualRequestHash, expectedRequestHash)) {
      input.issues.push({
        code: 'context_builder_request_hash_profile_mismatch',
        detail: 'Effect context builder and operation version must pin the same server-keyed request-hash profile.',
        operationName: input.operation.name,
        operationVersion: input.operation.version
      });
    }
    const expected = input.operation.idempotency.credentialVerifierProfile;
    const actual = binding.idempotencyCredentialProfile;
    if (!actual || !sameRef(actual, expected)) {
      input.issues.push({
        code: 'context_builder_idempotency_profile_mismatch',
        detail: 'Effect context builder and operation version must pin the same credential verifier profile.',
        operationName: input.operation.name,
        operationVersion: input.operation.version
      });
    }
  } else {
    if (binding.requestHashProfile !== undefined) {
      input.issues.push({
        code: 'read_context_builder_request_hash_profile',
        detail: 'Read context builders cannot carry an effect request-hash profile.',
        operationName: input.operation.name,
        operationVersion: input.operation.version
      });
    }
    if (binding.idempotencyCredentialProfile !== undefined) {
      input.issues.push({
        code: 'read_context_builder_idempotency_profile',
        detail: 'Read context builders cannot carry an idempotency credential profile.',
        operationName: input.operation.name,
        operationVersion: input.operation.version
      });
    }
  }
}

function sealedReadDefinition(
  operation: ReadOperationDefinition,
  accessLanes: readonly OperationAccessLane[]
): ReadOperationDefinition {
  return deepFreeze({
    ...operation,
    lifecycle: operation.lifecycle.status === 'deprecated'
      ? { ...operation.lifecycle, replacement: { ...operation.lifecycle.replacement } }
      : { ...operation.lifecycle },
    consequenceTags: [...operation.consequenceTags],
    autonomyPolicy: { ...operation.autonomyPolicy },
    inputSchema: { ...operation.inputSchema },
    canonicalResultSchema: { ...operation.canonicalResultSchema },
    outcomes: operation.outcomes.map((outcome) => ({ ...outcome, detailSchema: { ...outcome.detailSchema } })),
    accessLanes,
    contextBuilder: { ...operation.contextBuilder },
    readCapability: { ...operation.readCapability },
    handler: { ...operation.handler },
    observability: {
      trace: {
        mode: operation.observability.trace.mode,
        target: { ...operation.observability.trace.target }
      },
      immutableAudit: operation.observability.immutableAudit.mode === 'none'
        ? { mode: 'none' }
        : operation.observability.immutableAudit.mode === 'external_mcp_app_model'
          ? {
              mode: 'external_mcp_app_model',
              target: { ...operation.observability.immutableAudit.target }
            }
          : {
              mode: 'required',
              reason: operation.observability.immutableAudit.reason,
              target: { ...operation.observability.immutableAudit.target }
            }
    },
    bindings: operation.bindings.map((binding) => {
      switch (binding.surface) {
        case 'operator_http':
        case 'participant_http':
        case 'public_http':
          return {
            ...binding,
            browserResumption: { ...binding.browserResumption },
            projection: { ...binding.projection }
          };
        case 'external_mcp':
        case 'app_model':
          return { ...binding, projection: { ...binding.projection } };
      }
    })
  });
}

function sealedEffectDefinition(
  operation: OrdinaryEffectOperationDefinition,
  accessLanes: readonly OperationAccessLane[]
): OrdinaryEffectOperationDefinition {
  return deepFreeze({
    ...operation,
    lifecycle: operation.lifecycle.status === 'deprecated'
      ? { ...operation.lifecycle, replacement: { ...operation.lifecycle.replacement } }
      : { ...operation.lifecycle },
    consequenceTags: [...operation.consequenceTags],
    autonomyPolicy: { ...operation.autonomyPolicy },
    inputSchema: { ...operation.inputSchema },
    contributionSchema: { ...operation.contributionSchema },
    canonicalResultSchema: { ...operation.canonicalResultSchema },
    outcomes: operation.outcomes.map((outcome) => ({ ...outcome, detailSchema: { ...outcome.detailSchema } })),
    accessLanes,
    contextBuilder: { ...operation.contextBuilder },
    handlerCapability: { ...operation.handlerCapability },
    handler: { ...operation.handler },
    audit: {
      mode: operation.audit.mode,
      target: { ...operation.audit.target }
    },
    idempotency: {
      keySource: { ...operation.idempotency.keySource },
      credentialVerifierProfile: { ...operation.idempotency.credentialVerifierProfile },
      requestHashProfile: { ...operation.idempotency.requestHashProfile }
    },
    concurrency: { ...operation.concurrency },
    execution: {
      kind: 'single_unit_of_work',
      family: { ...operation.execution.family },
      phase: { ...operation.execution.phase },
      terminalization: { ...operation.execution.terminalization },
      autonomyPreflight: { ...operation.execution.autonomyPreflight }
    },
    bindings: operation.bindings.map<EffectOperationBindingDefinition>((binding) => {
      switch (binding.surface) {
        case 'operator_http':
        case 'participant_http':
          return {
            ...binding,
            browserResumption: { kind: 'none' },
            projection: { ...binding.projection }
          };
        case 'public_http':
          return {
            ...binding,
            browserResumption: {
              ...binding.browserResumption,
              referenceSchema: { ...binding.browserResumption.referenceSchema },
              requestCodec: { ...binding.browserResumption.requestCodec }
            },
            projection: { ...binding.projection }
          };
        case 'app_model':
          return { ...binding, projection: { ...binding.projection } };
      }
    }),
    registeredConsumerBindings: (operation.registeredConsumerBindings ?? []).map((binding) => ({
      ...binding,
      consumer: { ...binding.consumer },
      projection: { ...binding.projection }
    })),
    registeredJobBindings: (operation.registeredJobBindings ?? []).map((binding) => ({
      ...binding,
      job: { ...binding.job },
      inputProjection: { ...binding.inputProjection },
      authorityCitation: { ...binding.authorityCitation },
      projection: { ...binding.projection }
    }))
  });
}

function idempotencyConflictFixture(detailSchemaVersion: number) {
  return {
    class: 'idempotency_conflict' as const,
    kind: 'operation.request_changed',
    retryable: false,
    subjects: [],
    detail: null,
    detailSchemaVersion
  };
}

export async function createOperationRegistry(
  source: OperationRegistrySource,
  publicEffectConformanceActivation?: PublicEffectConformanceActivation
): Promise<OperationRegistry> {
  const publicEffectActivation = isPublicEffectConformanceActivation(
    publicEffectConformanceActivation
  ) ? publicEffectConformanceActivation : undefined;
  const issues: RegistryValidationIssue[] = [];
  const registeredAutonomyPolicies = source.autonomyPolicies ?? [];
  const autonomyPolicies = referenceMap({
    category: 'autonomy policy',
    items: registeredAutonomyPolicies,
    reference: (item) => item.definition,
    issues
  });
  for (const policy of registeredAutonomyPolicies) {
    try {
      validateOperationAutonomyPolicy(policy);
    } catch {
      issues.push({
        code: 'invalid_autonomy_policy',
        detail: 'Autonomy policy does not use the closed risk, trigger, and disposition vocabulary.'
      });
    }
    if (!isTrustedOperationAutonomyPolicy(policy)) {
      issues.push({
        code: 'untrusted_autonomy_policy',
        detail: 'Autonomy policies must be created by the trusted immutable policy factory.'
      });
    }
  }
  const schemas = referenceMap({
    category: 'schema',
    items: source.schemas.map(capturedSchemaRegistration),
    reference: (item) => item.reference,
    issues
  });
  for (const registered of source.schemas) {
    if (!safeSchemaManifestRefSchema.safeParse(registered.reference).success) {
      issues.push({ code: 'invalid_schema_reference', detail: 'A schema has an invalid safe manifest reference.' });
    }
    if (!registered.schema || typeof registered.schema.safeParse !== 'function') {
      issues.push({ code: 'invalid_schema_implementation', detail: `Schema ${refKey(registered.reference)} has no parser.` });
    }
  }
  const contextBuilders = referenceMap({ category: 'context builder', items: source.contextBuilders, reference: (item) => item.reference, issues });
  const readCapabilities = referenceMap({ category: 'read capability', items: source.readCapabilities, reference: (item) => item.reference, issues });
  const handlers = referenceMap({ category: 'handler', items: source.handlers, reference: (item) => item.reference, issues });
  const projections = referenceMap({
    category: 'projection',
    items: source.projections.map(capturedProjectionRegistration),
    reference: (item) => item.reference,
    issues
  });
  const effectContextBuilders = referenceMap({
    category: 'effect context builder',
    items: source.effectContextBuilders ?? [],
    reference: (item) => item.reference,
    issues
  });
  const effectHandlers = referenceMap({
    category: 'effect handler',
    items: source.effectHandlers ?? [],
    reference: (item) => item.reference,
    issues
  });
  const effectExecutionFamilies = referenceMap({
    category: 'effect execution family',
    items: source.effectExecutionFamilies ?? [],
    reference: (item) => item.reference,
    issues
  });
  const effectPhases = referenceMap({
    category: 'effect phase',
    items: source.effectPhases ?? [],
    reference: (item) => item.reference,
    issues
  });
  const terminalizationResolvers = referenceMap({
    category: 'terminalization resolver',
    items: source.terminalizationResolvers ?? [],
    reference: (item) => item.reference,
    issues
  });
  const riskResolvers = referenceMap({
    category: 'risk resolver',
    items: source.riskResolvers ?? [],
    reference: (item) => item.reference,
    issues
  });
  const autonomyEvidenceResolvers = referenceMap({
    category: 'autonomy evidence resolver',
    items: source.autonomyEvidenceResolvers ?? [],
    reference: (item) => item.reference,
    issues
  });
  const renewedApprovalResolvers = referenceMap({
    category: 'renewed approval resolver',
    items: source.renewedApprovalResolvers ?? [],
    reference: (item) => item.reference,
    issues
  });
  const autonomyPreflights = referenceMap({
    category: 'autonomy preflight',
    items: source.autonomyPreflights ?? [],
    reference: (item) => item.reference,
    issues
  });
  for (const family of source.effectExecutionFamilies ?? []) {
    if (!isTrustedSingleUnitOfWorkFamilyRegistration(family) || family.kind !== 'single_unit_of_work') {
      issues.push({ code: 'untrusted_execution_family', detail: 'Effect execution families must use the closed trusted single-unit-of-work factory.' });
    }
  }
  for (const registeredPhase of source.effectPhases ?? []) {
    if (!isTrustedSingleUnitOfWorkPhaseRegistration(registeredPhase) || registeredPhase.kind !== 'single_unit_of_work') {
      issues.push({ code: 'untrusted_execution_phase', detail: 'Effect phases must use the closed trusted single-unit-of-work phase factory.' });
    }
  }
  for (const resolver of source.terminalizationResolvers ?? []) {
    if (!isTrustedTerminalizationResolverRegistration(resolver)) {
      issues.push({ code: 'untrusted_terminalization_resolver', detail: 'Terminalization resolvers must use the trusted synchronous factory.' });
    }
  }
  for (const resolver of source.riskResolvers ?? []) {
    if (!isTrustedOperationRiskResolverRegistration(resolver)) {
      issues.push({ code: 'untrusted_risk_resolver', detail: 'Risk resolvers must use the trusted synchronous factory.' });
    }
  }
  for (const resolver of source.autonomyEvidenceResolvers ?? []) {
    if (!isTrustedAutonomyEvidenceResolverRegistration(resolver)) {
      issues.push({ code: 'untrusted_autonomy_evidence_resolver', detail: 'Autonomy evidence resolvers must use the trusted synchronous factory.' });
    }
  }
  for (const resolver of source.renewedApprovalResolvers ?? []) {
    if (!isTrustedRenewedApprovalResolverRegistration(resolver)) {
      issues.push({ code: 'untrusted_approval_resolver', detail: 'Renewed approval resolvers must use the trusted sealed factory.' });
    }
  }
  for (const preflight of source.autonomyPreflights ?? []) {
    if (!isTrustedAutonomyPreflightRegistration(preflight)) {
      issues.push({ code: 'untrusted_autonomy_preflight', detail: 'Autonomy preflights must use the trusted immutable factory.' });
    }
  }
  const operationAuditTargets = referenceMap({
    category: 'operation audit target',
    items: source.operationAuditTargets ?? [],
    reference: (item) => item.reference,
    issues
  });
  const operationAuditRecordProfiles = referenceMap({
    category: 'operation audit record profile',
    items: source.operationAuditRecordProfiles ?? [],
    reference: (item) => item.reference,
    issues
  });
  const readOperationalTraceTargets = referenceMap({
    category: 'read operational trace target',
    items: source.readOperationalTraceTargets ?? [],
    reference: (item) => item.reference,
    issues
  });
  const validOperationAuditRecordProfiles = new Set<string>();
  for (const profile of source.operationAuditRecordProfiles ?? []) {
    const candidate = profile as unknown;
    const valid = Boolean(
      candidate
      && typeof candidate === 'object'
      && !Array.isArray(candidate)
      && Object.keys(candidate).sort().join(',') === 'kind,maximumBytes,reference'
      && (candidate as { readonly kind?: unknown }).kind === 'canonical_json'
      && Number.isSafeInteger((candidate as { readonly maximumBytes?: unknown }).maximumBytes)
      && Number((candidate as { readonly maximumBytes?: unknown }).maximumBytes) > 0
      && Number((candidate as { readonly maximumBytes?: unknown }).maximumBytes) <= 1_000_000
      && versionedDefinitionRefSchema.safeParse(
        (candidate as { readonly reference?: unknown }).reference
      ).success
    );
    if (!valid) {
      issues.push({
        code: 'invalid_effect_audit_record_profile',
        detail: 'Operation audit record profiles require bounded canonical JSON.'
      });
    } else {
      validOperationAuditRecordProfiles.add(refKey(profile.reference));
    }
  }
  const validOperationAuditTargets = new Set<string>();
  for (const target of source.operationAuditTargets ?? []) {
    const candidate = target as unknown;
    const valid = Boolean(
      candidate
      && typeof candidate === 'object'
      && !Array.isArray(candidate)
      && Object.keys(candidate).sort().join(',') === 'kind,recordProfile,reference'
      && (candidate as { readonly kind?: unknown }).kind === 'operation_audit_record'
      && versionedDefinitionRefSchema.safeParse(
        (candidate as { readonly reference?: unknown }).reference
      ).success
      && versionedDefinitionRefSchema.safeParse(
        (candidate as { readonly recordProfile?: unknown }).recordProfile
      ).success
    );
    const profileReference = valid
      ? (target as OperationAuditTargetRegistration).recordProfile
      : undefined;
    const profile = profileReference
      ? operationAuditRecordProfiles.get(refKey(profileReference))
      : undefined;
    if (!valid) {
      issues.push({
        code: 'invalid_effect_audit_target',
        detail: 'Operation audit targets require an exact reference and canonical record profile.'
      });
    } else if (!profile || !validOperationAuditRecordProfiles.has(refKey(profile.reference))) {
      issues.push({
        code: 'unknown_effect_audit_record_profile',
        detail: 'The operation audit target record profile is not registered.'
      });
    } else {
      validOperationAuditTargets.add(refKey(target.reference));
    }
  }
  const validReadOperationalTraceTargets = new Set<string>();
  for (const target of source.readOperationalTraceTargets ?? []) {
    const candidate = target as unknown;
    const valid = Boolean(
      candidate
      && typeof candidate === 'object'
      && !Array.isArray(candidate)
      && Object.keys(candidate).sort().join(',') === 'kind,recordProfile,reference'
      && (candidate as { readonly kind?: unknown }).kind === 'read_operational_trace_record'
      && versionedDefinitionRefSchema.safeParse(
        (candidate as { readonly reference?: unknown }).reference
      ).success
      && versionedDefinitionRefSchema.safeParse(
        (candidate as { readonly recordProfile?: unknown }).recordProfile
      ).success
    );
    const profileReference = valid
      ? (target as ReadOperationalTraceTargetRegistration).recordProfile
      : undefined;
    const profile = profileReference
      ? operationAuditRecordProfiles.get(refKey(profileReference))
      : undefined;
    if (!valid) {
      issues.push({
        code: 'invalid_read_trace_target',
        detail: 'Read operational trace targets require an exact reference and canonical record profile.'
      });
    } else if (!profile || !validOperationAuditRecordProfiles.has(refKey(profile.reference))) {
      issues.push({
        code: 'unknown_read_trace_record_profile',
        detail: 'The read operational trace target record profile is not registered.'
      });
    } else {
      validReadOperationalTraceTargets.add(refKey(target.reference));
    }
  }
  for (const builder of [...source.contextBuilders, ...(source.effectContextBuilders ?? [])]) {
    if (!getTrustedInvocationBuilderBinding(builder)) {
      issues.push({
        code: 'untrusted_context_builder',
        detail: 'Every registered context builder must be created by the trusted invocation builder factory.'
      });
    }
  }

  const operationDefinitions = new Map<string, ReadOperationDefinition>();
  const readAccessLanes = new Map<string, readonly OperationAccessLane[]>();
  const readAutonomyPolicies = new Map<string, OperationAutonomyPolicy>();
  const activeNames = new Set<string>();
  for (const operation of source.operations) {
    const accessLanes = normalizeOperationAccessLanes(operation, issues);
    const autonomyPolicy = findAutonomyPolicy({ policies: autonomyPolicies, operation, issues });
    const metadata = {
      name: operation.name,
      version: operation.version,
      lifecycle: operation.lifecycle,
      summary: operation.summary,
      effect: operation.effect,
      maxRisk: operation.maxRisk,
      ...(autonomyPolicy ? { autonomy: safeAutonomy(autonomyPolicy) } : {}),
      consequenceTags: [...operation.consequenceTags],
      inputSchema: operation.inputSchema,
      idempotency: { required: false as const },
      concurrency: { kind: 'read_snapshot' as const },
      outcomes: [...operation.outcomes],
      enabledBindings: []
    };
    if (!safeOperationManifestEntrySchema.safeParse(metadata).success || operation.effect !== 'read') {
      issues.push({ code: 'invalid_operation_contract', detail: 'Operation metadata is not a valid read contract.', operationName: operation.name, operationVersion: operation.version });
    }
    if (!operationNameSchema.safeParse(operation.name).success || !operationVersionSchema.safeParse(operation.version).success) continue;
    const key = operationKey(operation.name, operation.version);
    if (operationDefinitions.has(key)) {
      issues.push({ code: 'duplicate_operation', detail: `Operation ${key} is duplicated.`, operationName: operation.name, operationVersion: operation.version });
      continue;
    }
    operationDefinitions.set(key, operation);
    readAccessLanes.set(key, accessLanes);
    if (autonomyPolicy) readAutonomyPolicies.set(key, autonomyPolicy);
    if (operation.lifecycle.status === 'active') {
      if (activeNames.has(operation.name)) {
        issues.push({ code: 'multiple_active_versions', detail: `Operation ${operation.name} has more than one active version.`, operationName: operation.name, operationVersion: operation.version });
      }
      activeNames.add(operation.name);
    }
    if (operation.lifecycle.status === 'replay_only' && operation.bindings.length > 0) {
      issues.push({ code: 'replay_only_binding', detail: 'Replay-only operations cannot accept new traffic.', operationName: operation.name, operationVersion: operation.version });
    }
  }

  const effectOperationDefinitions = new Map<string, OrdinaryEffectOperationDefinition>();
  const effectAccessLanes = new Map<string, readonly OperationAccessLane[]>();
  const effectAutonomyPolicies = new Map<string, OperationAutonomyPolicy>();
  for (const operation of source.effectOperations ?? []) {
    const accessLanes = normalizeOperationAccessLanes(operation, issues, publicEffectActivation);
    const autonomyPolicy = findAutonomyPolicy({ policies: autonomyPolicies, operation, issues });
    const metadata = {
      name: operation.name,
      version: operation.version,
      lifecycle: operation.lifecycle,
      summary: operation.summary,
      effect: operation.effect,
      maxRisk: operation.maxRisk,
      ...(autonomyPolicy ? { autonomy: safeAutonomy(autonomyPolicy) } : {}),
      consequenceTags: [...operation.consequenceTags],
      inputSchema: operation.inputSchema,
      idempotency: { required: true as const, ...operation.idempotency },
      concurrency: { kind: 'registered' as const, definition: operation.concurrency },
      outcomes: [...operation.outcomes],
      enabledBindings: []
    };
    if (!safeOperationManifestEntrySchema.safeParse(metadata).success || (operation.effect !== 'draft' && operation.effect !== 'commit')) {
      issues.push({ code: 'invalid_effect_contract', detail: 'Operation metadata is not a valid draft or commit contract.', operationName: operation.name, operationVersion: operation.version });
    }
    if (!versionedDefinitionRefSchema.safeParse(operation.idempotency.keySource).success
      || !versionedDefinitionRefSchema.safeParse(operation.idempotency.credentialVerifierProfile).success
      || !versionedDefinitionRefSchema.safeParse(operation.idempotency.requestHashProfile).success
      || !versionedDefinitionRefSchema.safeParse(operation.concurrency).success) {
      issues.push({ code: 'invalid_effect_binding_profile', detail: 'Effectful idempotency and concurrency references must be versioned.', operationName: operation.name, operationVersion: operation.version });
    }
    const execution = (operation as { readonly execution?: unknown }).execution;
    if (!execution || typeof execution !== 'object' || Array.isArray(execution)
      || Object.keys(execution).sort().join(',') !== 'autonomyPreflight,family,kind,phase,terminalization'
      || (execution as { readonly kind?: unknown }).kind !== 'single_unit_of_work'
      || !versionedDefinitionRefSchema.safeParse((execution as { readonly family?: unknown }).family).success
      || !versionedDefinitionRefSchema.safeParse((execution as { readonly phase?: unknown }).phase).success
      || !versionedDefinitionRefSchema.safeParse((execution as { readonly terminalization?: unknown }).terminalization).success
      || !versionedDefinitionRefSchema.safeParse((execution as { readonly autonomyPreflight?: unknown }).autonomyPreflight).success) {
      issues.push({
        code: 'invalid_effect_execution_contract',
        detail: 'Effectful operations require the exact closed single-unit-of-work execution declaration.',
        operationName: operation.name,
        operationVersion: operation.version
      });
    }
    if (!operationNameSchema.safeParse(operation.name).success || !operationVersionSchema.safeParse(operation.version).success) continue;
    const key = operationKey(operation.name, operation.version);
    if (operationDefinitions.has(key) || effectOperationDefinitions.has(key)) {
      issues.push({ code: 'duplicate_operation', detail: `Operation ${key} is duplicated.`, operationName: operation.name, operationVersion: operation.version });
      continue;
    }
    effectOperationDefinitions.set(key, operation);
    effectAccessLanes.set(key, accessLanes);
    if (autonomyPolicy) effectAutonomyPolicies.set(key, autonomyPolicy);
    if (operation.lifecycle.status === 'active') {
      if (activeNames.has(operation.name)) {
        issues.push({ code: 'multiple_active_versions', detail: `Operation ${operation.name} has more than one active version.`, operationName: operation.name, operationVersion: operation.version });
      }
      activeNames.add(operation.name);
    }
    if (
      operation.lifecycle.status === 'replay_only'
      && (
        operation.bindings.length > 0
        || (operation.registeredConsumerBindings?.length ?? 0) > 0
        || (operation.registeredJobBindings?.length ?? 0) > 0
      )
    ) {
      issues.push({ code: 'replay_only_binding', detail: 'Replay-only operations cannot accept new traffic.', operationName: operation.name, operationVersion: operation.version });
    }
  }

  for (const operation of operationDefinitions.values()) {
    if (operation.lifecycle.status === 'deprecated') {
      const replacement = operation.lifecycle.replacement;
      if (!operationDefinitions.has(operationKey(replacement.operationName, replacement.operationVersion))) {
        issues.push({ code: 'missing_lifecycle_replacement', detail: 'The deprecated operation replacement is not registered.', operationName: operation.name, operationVersion: operation.version });
      }
    }
  }
  for (const operation of effectOperationDefinitions.values()) {
    if (operation.lifecycle.status === 'deprecated') {
      const replacement = operation.lifecycle.replacement;
      const key = operationKey(replacement.operationName, replacement.operationVersion);
      if (!operationDefinitions.has(key) && !effectOperationDefinitions.has(key)) {
        issues.push({ code: 'missing_lifecycle_replacement', detail: 'The deprecated operation replacement is not registered.', operationName: operation.name, operationVersion: operation.version });
      }
    }
  }

  const compiled = new Map<string, CompiledReadOperation>();
  const routes = new Set<string>();
  const mcpTools = new Set<string>();
  const appModelTools = new Set<string>();
  for (const operation of [...operationDefinitions.values()].sort(compareOperation)) {
    const key = operationKey(operation.name, operation.version);
    const accessLanes = readAccessLanes.get(key) ?? Object.freeze([]);
    const autonomyPolicy = readAutonomyPolicies.get(key);
    const inputSchema = findSchema(schemas, operation.inputSchema, 'operation input', issues, operation);
    const canonicalResultSchema = findSchema(schemas, operation.canonicalResultSchema, 'canonical result', issues, operation);
    const contextBuilder = findDefinition({ map: contextBuilders, reference: operation.contextBuilder, usage: 'operation context builder', issues, operation });
    validateTrustedContextBuilder({ builder: contextBuilder, operation, accessLanes, issues });
    const readCapability = findDefinition({ map: readCapabilities, reference: operation.readCapability, usage: 'operation read capability', issues, operation });
    const handler = findDefinition({ map: handlers, reference: operation.handler, usage: 'operation handler', issues, operation });
    if (handler && !sameRef(handler.readCapability, operation.readCapability)) {
      issues.push({ code: 'handler_capability_mismatch', detail: 'The handler capability does not match the operation capability.', operationName: operation.name, operationVersion: operation.version });
    }
    if (handler && !sameSchemaRef(handler.canonicalResultSchema, operation.canonicalResultSchema)) {
      issues.push({ code: 'handler_schema_mismatch', detail: 'The handler canonical result schema does not match the operation contract.', operationName: operation.name, operationVersion: operation.version });
    }

    const observabilityCandidate = operation.observability as unknown;
    const validObservabilityShape = Boolean(
      observabilityCandidate
      && typeof observabilityCandidate === 'object'
      && !Array.isArray(observabilityCandidate)
      && Object.keys(observabilityCandidate).sort().join(',') === 'immutableAudit,trace'
    );
    const traceCandidate = validObservabilityShape
      ? (observabilityCandidate as { readonly trace?: unknown }).trace
      : undefined;
    const validTraceDeclaration = Boolean(
      traceCandidate
      && typeof traceCandidate === 'object'
      && !Array.isArray(traceCandidate)
      && Object.keys(traceCandidate).sort().join(',') === 'mode,target'
      && (traceCandidate as { readonly mode?: unknown }).mode === 'required'
      && versionedDefinitionRefSchema.safeParse(
        (traceCandidate as { readonly target?: unknown }).target
      ).success
    );
    if (!validObservabilityShape || !validTraceDeclaration) {
      issues.push({
        code: 'invalid_read_trace_declaration',
        detail: 'Every read operation requires one exact internal versioned operational trace target.',
        operationName: operation.name,
        operationVersion: operation.version
      });
    }
    const traceReference = validTraceDeclaration
      ? (traceCandidate as { readonly target: VersionedDefinitionRef }).target
      : undefined;
    const resolvedTraceTarget = traceReference
      ? readOperationalTraceTargets.get(refKey(traceReference))
      : undefined;
    if (traceReference && !resolvedTraceTarget) {
      issues.push({
        code: 'unknown_read_trace_target',
        detail: 'The read operation trace target is not registered.',
        operationName: operation.name,
        operationVersion: operation.version
      });
    }
    const validTraceTarget = Boolean(
      resolvedTraceTarget
      && validReadOperationalTraceTargets.has(refKey(resolvedTraceTarget.reference))
    );
    const resolvedTraceRecordProfile = validTraceTarget && resolvedTraceTarget
      ? operationAuditRecordProfiles.get(refKey(resolvedTraceTarget.recordProfile))
      : undefined;

    const immutableAuditCandidate = validObservabilityShape
      ? (observabilityCandidate as { readonly immutableAudit?: unknown }).immutableAudit
      : undefined;
    const immutableAuditMode = immutableAuditCandidate
      && typeof immutableAuditCandidate === 'object'
      && !Array.isArray(immutableAuditCandidate)
      ? (immutableAuditCandidate as { readonly mode?: unknown }).mode
      : undefined;
    const validImmutableAuditDeclaration = Boolean(
      immutableAuditMode === 'none'
        ? Object.keys(immutableAuditCandidate as object).join(',') === 'mode'
        : immutableAuditMode === 'external_mcp_app_model'
          ? Object.keys(immutableAuditCandidate as object).sort().join(',') === 'mode,target'
            && versionedDefinitionRefSchema.safeParse(
              (immutableAuditCandidate as { readonly target?: unknown }).target
            ).success
          : immutableAuditMode === 'required'
            ? Object.keys(immutableAuditCandidate as object).sort().join(',') === 'mode,reason,target'
              && ((immutableAuditCandidate as { readonly reason?: unknown }).reason === 'security_sensitive'
                || (immutableAuditCandidate as { readonly reason?: unknown }).reason === 'classified')
              && versionedDefinitionRefSchema.safeParse(
                (immutableAuditCandidate as { readonly target?: unknown }).target
              ).success
            : false
    );
    if (!validObservabilityShape || !validImmutableAuditDeclaration) {
      issues.push({
        code: 'invalid_read_audit_declaration',
        detail: 'Read immutable audit policy must use the closed none, external-MCP/app-model, or required sensitivity form.',
        operationName: operation.name,
        operationVersion: operation.version
      });
    }
    const hasMachineBinding = operation.bindings.some(
      (binding) => binding.surface === 'external_mcp' || binding.surface === 'app_model'
    );
    if (hasMachineBinding && immutableAuditMode === 'none') {
      issues.push({
        code: 'read_machine_audit_required',
        detail: 'External-MCP and app-model read bindings require immutable audit.',
        operationName: operation.name,
        operationVersion: operation.version
      });
    }
    if (!hasMachineBinding && immutableAuditMode === 'external_mcp_app_model') {
      issues.push({
        code: 'read_machine_audit_without_binding',
        detail: 'The machine-only read audit mode requires an external-MCP or app-model binding.',
        operationName: operation.name,
        operationVersion: operation.version
      });
    }
    const auditReference = validImmutableAuditDeclaration && immutableAuditMode !== 'none'
      ? (immutableAuditCandidate as { readonly target: VersionedDefinitionRef }).target
      : undefined;
    const resolvedReadAuditTarget = auditReference
      ? operationAuditTargets.get(refKey(auditReference))
      : undefined;
    if (auditReference && !resolvedReadAuditTarget) {
      issues.push({
        code: 'unknown_read_audit_target',
        detail: 'The read immutable audit target is not registered.',
        operationName: operation.name,
        operationVersion: operation.version
      });
    }
    const validReadAuditTarget = Boolean(
      resolvedReadAuditTarget
      && validOperationAuditTargets.has(refKey(resolvedReadAuditTarget.reference))
    );
    const resolvedReadAuditRecordProfile = validReadAuditTarget && resolvedReadAuditTarget
      ? operationAuditRecordProfiles.get(refKey(resolvedReadAuditTarget.recordProfile))
      : undefined;

    const declaredOutcomes = new Map<string, ReadOperationDefinition['outcomes'][number]>();
    for (const outcome of operation.outcomes) {
      if (!operationOutcomeDeclarationSchema.safeParse(outcome).success) {
        issues.push({ code: 'invalid_outcome_declaration', detail: 'An outcome declaration is invalid.', operationName: operation.name, operationVersion: operation.version });
      }
      const key = `${outcome.class}:${outcome.kind}`;
      if (declaredOutcomes.has(key)) {
        issues.push({ code: 'duplicate_outcome_declaration', detail: `Outcome ${key} is declared more than once.`, operationName: operation.name, operationVersion: operation.version });
      }
      declaredOutcomes.set(key, deepFreeze({ ...outcome, detailSchema: { ...outcome.detailSchema } }));
      findSchema(schemas, outcome.detailSchema, `outcome ${key} detail`, issues, operation);
    }

    const compiledBindings = new Map<string, CompiledBinding>();
    const seenSurfaces = new Set<string>();
    for (const binding of operation.bindings) {
      if (seenSurfaces.has(binding.surface)) {
        issues.push({ code: 'duplicate_surface_binding', detail: `Surface ${binding.surface} is bound more than once.`, operationName: operation.name, operationVersion: operation.version });
      }
      seenSurfaces.add(binding.surface);
      let publicBinding: RegisteredReadOperationBinding;
      if (
        binding.surface === 'operator_http'
        || binding.surface === 'participant_http'
        || binding.surface === 'public_http'
      ) {
        const routeKey = `${binding.method} ${binding.path}`;
        if (routes.has(routeKey)) {
          issues.push({ code: 'duplicate_http_binding', detail: `HTTP binding ${routeKey} is duplicated.`, operationName: operation.name, operationVersion: operation.version });
        }
        routes.add(routeKey);
        if (binding.method !== 'GET' || binding.input !== 'query' || binding.browserResumption.kind !== 'none') {
          issues.push({ code: 'unsupported_read_binding', detail: 'HTTP read bindings require GET/query with no browser resumption.', operationName: operation.name, operationVersion: operation.version });
        }
        publicBinding = binding.surface === 'operator_http'
          ? {
              operationName: operation.name,
              operationVersion: operation.version,
              surface: binding.surface,
              method: binding.method,
              path: binding.path,
              input: binding.input
            } satisfies RegisteredOperatorHttpReadBinding
          : binding.surface === 'participant_http'
            ? {
                operationName: operation.name,
                operationVersion: operation.version,
                surface: binding.surface,
                method: binding.method,
                path: binding.path,
                input: binding.input
              } satisfies RegisteredParticipantHttpReadBinding
            : {
                operationName: operation.name,
                operationVersion: operation.version,
                surface: binding.surface,
                method: binding.method,
                path: binding.path,
                input: binding.input
              } satisfies RegisteredPublicHttpReadBinding;
      } else if (binding.surface === 'external_mcp') {
        if (mcpTools.has(binding.toolName)) {
          issues.push({ code: 'duplicate_mcp_binding', detail: `MCP tool ${binding.toolName} is duplicated.`, operationName: operation.name, operationVersion: operation.version });
        }
        mcpTools.add(binding.toolName);
        publicBinding = {
          operationName: operation.name,
          operationVersion: operation.version,
          surface: binding.surface,
          toolName: binding.toolName
        } satisfies RegisteredExternalMcpReadBinding;
      } else {
        if (appModelTools.has(binding.toolName)) {
          issues.push({ code: 'duplicate_app_model_tool_binding', detail: `App-model tool ${binding.toolName} is duplicated.`, operationName: operation.name, operationVersion: operation.version });
        }
        appModelTools.add(binding.toolName);
        publicBinding = {
          operationName: operation.name,
          operationVersion: operation.version,
          surface: binding.surface,
          toolName: binding.toolName
        } satisfies RegisteredAppModelReadBinding;
      }
      const projection = findDefinition({ map: projections, reference: binding.projection, usage: `projection for ${binding.surface}`, issues, operation });
      if (projection && !sameSchemaRef(projection.canonicalResultSchema, operation.canonicalResultSchema)) {
        issues.push({ code: 'projection_input_mismatch', detail: 'The projection canonical schema does not match the operation contract.', operationName: operation.name, operationVersion: operation.version });
      }
      const projectedResultSchema = projection
        ? findSchema(schemas, projection.projectedResultSchema, `projection result for ${binding.surface}`, issues, operation)
        : undefined;
      if (projection && projectedResultSchema) {
        compiledBindings.set(binding.surface, { public: publicBinding, projection, projectedResultSchema });
      }
    }

    if (
      autonomyPolicy
      && inputSchema
      && canonicalResultSchema
      && contextBuilder
      && readCapability
      && handler
      && validObservabilityShape
      && validTraceDeclaration
      && resolvedTraceTarget
      && resolvedTraceRecordProfile
      && (immutableAuditMode === 'none' || (resolvedReadAuditTarget && resolvedReadAuditRecordProfile))
    ) {
      compiled.set(operationKey(operation.name, operation.version), {
        definition: sealedReadDefinition(operation, accessLanes),
        autonomyPolicy,
        inputSchema,
        canonicalResultSchema,
        contextBuilder,
        readCapability,
        handler,
        traceTarget: resolvedTraceTarget,
        traceRecordProfile: resolvedTraceRecordProfile,
        ...(resolvedReadAuditTarget && resolvedReadAuditRecordProfile
          ? {
              auditTarget: resolvedReadAuditTarget,
              auditRecordProfile: resolvedReadAuditRecordProfile
            }
          : {}),
        outcomes: declaredOutcomes,
        bindings: compiledBindings,
        schemas
      });
    }
  }

  const compiledEffects = new Map<string, CompiledEffectOperation>();
  const registeredConsumerOperations = new Map<string, {
    readonly operation: CompiledEffectOperation;
    readonly binding: CompiledRegisteredConsumerEffectBinding;
  }>();
  const registeredConsumerOwners = new Set<string>();
  const registeredJobOperations = new Map<string, {
    readonly operation: CompiledEffectOperation;
    readonly binding: CompiledRegisteredJobEffectBinding;
  }>();
  const registeredJobOwners = new Set<string>();
  for (const operation of [...effectOperationDefinitions.values()].sort(compareOperation)) {
    const key = operationKey(operation.name, operation.version);
    const accessLanes = effectAccessLanes.get(key) ?? Object.freeze([]);
    const autonomyPolicy = effectAutonomyPolicies.get(key);
    const inputSchema = findSchema(schemas, operation.inputSchema, 'operation input', issues, operation);
    const contributionSchema = findSchema(schemas, operation.contributionSchema, 'handler contribution', issues, operation);
    const canonicalResultSchema = findSchema(schemas, operation.canonicalResultSchema, 'canonical result', issues, operation);
    const contextBuilder = findDefinition({ map: effectContextBuilders, reference: operation.contextBuilder, usage: 'effect context builder', issues, operation });
    validateTrustedContextBuilder({
      builder: contextBuilder,
      operation,
      accessLanes,
      issues,
      ...(publicEffectActivation === undefined
        ? {}
        : { publicEffectConformanceActivation: publicEffectActivation })
    });
    const handler = findDefinition({ map: effectHandlers, reference: operation.handler, usage: 'effect handler', issues, operation });
    if (handler && handler.effect !== operation.effect) {
      issues.push({ code: 'handler_effect_mismatch', detail: 'The handler effect does not match the operation effect.', operationName: operation.name, operationVersion: operation.version });
    }
    if (handler && !sameRef(handler.handlerCapability, operation.handlerCapability)) {
      issues.push({ code: 'handler_capability_mismatch', detail: 'The handler capability does not match the operation capability.', operationName: operation.name, operationVersion: operation.version });
    }
    if (handler && !sameSchemaRef(handler.contributionSchema, operation.contributionSchema)) {
      issues.push({ code: 'handler_contribution_mismatch', detail: 'The handler contribution schema does not match the operation contract.', operationName: operation.name, operationVersion: operation.version });
    }
    if (handler && !sameSchemaRef(handler.canonicalResultSchema, operation.canonicalResultSchema)) {
      issues.push({ code: 'handler_schema_mismatch', detail: 'The handler canonical result schema does not match the operation contract.', operationName: operation.name, operationVersion: operation.version });
    }
    if (!versionedDefinitionRefSchema.safeParse(operation.handlerCapability).success) {
      issues.push({ code: 'invalid_handler_capability', detail: 'The handler capability reference is invalid.', operationName: operation.name, operationVersion: operation.version });
    }
    const executionDeclaration = (operation as { readonly execution?: OrdinaryEffectOperationDefinition['execution'] }).execution;
    const executionFamily = executionDeclaration
      ? findDefinition({
          map: effectExecutionFamilies,
          reference: executionDeclaration.family,
          usage: 'effect execution family',
          issues,
          operation
        })
      : undefined;
    const executionPhase = executionDeclaration
      ? findDefinition({
          map: effectPhases,
          reference: executionDeclaration.phase,
          usage: 'effect execution phase',
          issues,
          operation
        })
      : undefined;
    const terminalizationResolver = executionDeclaration
      ? findDefinition({
          map: terminalizationResolvers,
          reference: executionDeclaration.terminalization,
          usage: 'effect terminalization resolver',
          issues,
          operation
        })
      : undefined;
    const autonomyPreflight = executionDeclaration
      ? findDefinition({
          map: autonomyPreflights,
          reference: executionDeclaration.autonomyPreflight,
          usage: 'effect autonomy preflight',
          issues,
          operation
        })
      : undefined;
    const riskResolver = autonomyPreflight
      ? findDefinition({
          map: riskResolvers,
          reference: autonomyPreflight.riskResolver,
          usage: 'effect risk resolver',
          issues,
          operation
        })
      : undefined;
    const autonomyEvidenceResolver = autonomyPreflight
      ? findDefinition({
          map: autonomyEvidenceResolvers,
          reference: autonomyPreflight.evidenceResolver,
          usage: 'effect autonomy evidence resolver',
          issues,
          operation
        })
      : undefined;
    const renewedApprovalResolver = autonomyPreflight
      ? findDefinition({
          map: renewedApprovalResolvers,
          reference: autonomyPreflight.approvalResolver,
          usage: 'effect renewed approval resolver',
          issues,
          operation
        })
      : undefined;
    if (executionFamily && executionPhase) {
      if (executionFamily.kind !== 'single_unit_of_work'
        || executionPhase.kind !== 'single_unit_of_work'
        || !sameRef(executionFamily.phase, executionPhase.reference)
        || !sameRef(executionPhase.family, executionFamily.reference)) {
        issues.push({ code: 'execution_family_phase_mismatch', detail: 'Execution family and phase references do not join exactly.', operationName: operation.name, operationVersion: operation.version });
      }
      if (executionPhase.operation.name !== operation.name
        || executionPhase.operation.version !== operation.version
        || executionPhase.effect !== operation.effect
        || !sameRef(executionPhase.handler, operation.handler)
        || !sameRef(executionPhase.handlerCapability, operation.handlerCapability)
        || !sameSchemaRef(executionPhase.contributionSchema, operation.contributionSchema)
        || !sameRef(executionPhase.terminalization, executionDeclaration!.terminalization)) {
        issues.push({ code: 'execution_phase_operation_mismatch', detail: 'The phase does not match its exact operation, effect, handler, capability, schema, and terminalization.', operationName: operation.name, operationVersion: operation.version });
      }
    }
    if (terminalizationResolver && executionPhase) {
      if (terminalizationResolver.operation.name !== operation.name
        || terminalizationResolver.operation.version !== operation.version
        || !sameRef(terminalizationResolver.phase, executionPhase.reference)) {
        issues.push({ code: 'terminalization_operation_mismatch', detail: 'Terminalization resolver does not match the exact operation phase.', operationName: operation.name, operationVersion: operation.version });
      } else {
        try {
          probeTerminalizationResolver({
            operation: { name: operation.name, version: operation.version },
            phase: executionPhase.reference,
            resolver: terminalizationResolver
          });
        } catch {
          issues.push({ code: 'unsafe_terminalization_resolver', detail: 'Terminalization resolver must be synchronous, pure, total, and byte-repeatable.', operationName: operation.name, operationVersion: operation.version });
        }
      }
    }
    if (handler) {
      try {
        assertSynchronousEffectHandler(handler);
      } catch {
        issues.push({ code: 'async_effect_handler', detail: 'Single-unit-of-work handlers must be synchronous and capability-limited.', operationName: operation.name, operationVersion: operation.version });
      }
    }
    if (autonomyPreflight && autonomyPolicy) {
      if (autonomyPreflight.operation.name !== operation.name
        || autonomyPreflight.operation.version !== operation.version
        || !sameRef(autonomyPreflight.policy, autonomyPolicy.definition)) {
        issues.push({ code: 'autonomy_preflight_operation_mismatch', detail: 'Autonomy preflight must cite the exact operation and autonomy policy.', operationName: operation.name, operationVersion: operation.version });
      }
      for (const resolver of [riskResolver, autonomyEvidenceResolver, renewedApprovalResolver]) {
        if (resolver && (resolver.operation.name !== operation.name || resolver.operation.version !== operation.version)) {
          issues.push({ code: 'autonomy_resolver_operation_mismatch', detail: 'Every autonomy resolver must cite the exact operation version.', operationName: operation.name, operationVersion: operation.version });
        }
      }
      if (riskResolver && autonomyEvidenceResolver && renewedApprovalResolver) {
        try {
          probeAutonomyRegistrations({
            operation: { name: operation.name, version: operation.version, effect: operation.effect },
            maximumRisk: operation.maxRisk,
            consequenceTags: operation.consequenceTags,
            policy: autonomyPolicy,
            riskResolver,
            evidenceResolver: autonomyEvidenceResolver,
            approvalResolver: renewedApprovalResolver
          });
        } catch {
          issues.push({ code: 'unsafe_autonomy_resolver', detail: 'Autonomy resolvers must be synchronous, pure, total, byte-repeatable, and bounded.', operationName: operation.name, operationVersion: operation.version });
        }
      }
    }
    const auditCandidate = operation.audit as unknown;
    const validAuditDeclaration = Boolean(
      auditCandidate
      && typeof auditCandidate === 'object'
      && !Array.isArray(auditCandidate)
      && Object.keys(auditCandidate).sort().join(',') === 'mode,target'
      && (auditCandidate as { readonly mode?: unknown }).mode === 'required'
      && versionedDefinitionRefSchema.safeParse(
        (auditCandidate as { readonly target?: unknown }).target
      ).success
    );
    if (!validAuditDeclaration) {
      issues.push({
        code: 'invalid_effect_audit',
        detail: 'Effectful operations require one exact internal versioned audit target.',
        operationName: operation.name,
        operationVersion: operation.version
      });
    }
    const resolvedAuditTarget = validAuditDeclaration
      ? operationAuditTargets.get(refKey(operation.audit.target))
      : undefined;
    if (validAuditDeclaration && !resolvedAuditTarget) {
      issues.push({
        code: 'unknown_effect_audit_target',
        detail: 'The effect operation audit target is not registered.',
        operationName: operation.name,
        operationVersion: operation.version
      });
    }
    const validAudit = Boolean(
      resolvedAuditTarget
      && validOperationAuditTargets.has(refKey(resolvedAuditTarget.reference))
    );
    const resolvedAuditRecordProfile = validAudit && resolvedAuditTarget
      ? operationAuditRecordProfiles.get(refKey(resolvedAuditTarget.recordProfile))
      : undefined;

    const declaredOutcomes = new Map<string, OrdinaryEffectOperationDefinition['outcomes'][number]>();
    for (const outcome of operation.outcomes) {
      if (!operationOutcomeDeclarationSchema.safeParse(outcome).success) {
        issues.push({ code: 'invalid_outcome_declaration', detail: 'An outcome declaration is invalid.', operationName: operation.name, operationVersion: operation.version });
      }
      const key = `${outcome.class}:${outcome.kind}`;
      if (declaredOutcomes.has(key)) {
        issues.push({ code: 'duplicate_outcome_declaration', detail: `Outcome ${key} is declared more than once.`, operationName: operation.name, operationVersion: operation.version });
      }
      declaredOutcomes.set(key, outcome);
      findSchema(schemas, outcome.detailSchema, `outcome ${key} detail`, issues, operation);
    }
    const idempotencyConflict = declaredOutcomes.get('idempotency_conflict:operation.request_changed');
    if (!idempotencyConflict || idempotencyConflict.retryable) {
      issues.push({ code: 'missing_idempotency_conflict', detail: 'Effectful operations must declare the detail-free, non-retryable request-changed outcome.', operationName: operation.name, operationVersion: operation.version });
    } else {
      const detailSchema = schemas.get(refKey(idempotencyConflict.detailSchema));
      const conflict = { kind: 'outcome' as const, outcome: idempotencyConflictFixture(idempotencyConflict.detailSchema.version) };
      if (!detailSchema?.schema.safeParse(null).success || !canonicalResultSchema?.schema.safeParse(conflict).success) {
        issues.push({ code: 'idempotency_conflict_schema_mismatch', detail: 'The canonical result and detail schemas must admit the detail-free request-changed outcome.', operationName: operation.name, operationVersion: operation.version });
      }
    }
    const validateRegisteredNonterminalOutcome = (
      outcome: import('@jooevents/contracts').StructuredOutcome,
      usage: string
    ): void => {
      const declaration = declaredOutcomes.get(`${outcome.class}:${outcome.kind}`);
      const detailSchema = declaration ? schemas.get(refKey(declaration.detailSchema)) : undefined;
      if (!declaration
        || declaration.retryable !== outcome.retryable
        || declaration.detailSchema.version !== outcome.detailSchemaVersion
        || !detailSchema?.schema.safeParse(outcome.detail).success
        || !canonicalResultSchema?.schema.safeParse({ kind: 'outcome', outcome }).success) {
        issues.push({ code: 'unregistered_phase_outcome', detail: `${usage} must be an exact declared canonical outcome.`, operationName: operation.name, operationVersion: operation.version });
      }
    };
    if (executionPhase) {
      const reservedNonterminalOutcomeKeys = new Set([
        'idempotency_conflict:operation.request_changed',
        `${executionPhase.contentionOutcome.class}:${executionPhase.contentionOutcome.kind}`,
        ...Object.values(autonomyPreflight?.interventionOutcomes ?? {}).map(
          (outcome) => `${outcome.class}:${outcome.kind}`
        )
      ]);
      for (const terminalOutcomeKey of executionPhase.terminalOutcomeKeys) {
        if (!declaredOutcomes.has(terminalOutcomeKey)) {
          issues.push({
            code: 'undeclared_terminal_outcome',
            detail: 'The phase terminal-outcome allowlist must cite an exact declared operation outcome.',
            operationName: operation.name,
            operationVersion: operation.version
          });
        }
        if (reservedNonterminalOutcomeKeys.has(terminalOutcomeKey)) {
          issues.push({
            code: 'terminal_nonterminal_outcome',
            detail: 'System-owned progress, intervention, and request-conflict outcomes cannot terminalize.',
            operationName: operation.name,
            operationVersion: operation.version
          });
        }
      }
      const contention = executionPhase.contentionOutcome;
      if (contention.class !== 'conflict' || contention.kind !== 'operation.in_progress'
        || contention.retryable !== true || contention.subjects.length !== 0 || contention.detail !== null) {
        issues.push({ code: 'unsafe_contention_outcome', detail: 'Single-unit-of-work contention requires the detail-free registered retryable progress outcome.', operationName: operation.name, operationVersion: operation.version });
      }
      validateRegisteredNonterminalOutcome(contention, 'Execution contention outcome');
    }
    if (executionPhase && terminalizationResolver) {
      try {
        probeTerminalizationOutcomes({
          operation,
          phase: executionPhase,
          resolver: terminalizationResolver,
          outcomes: operation.outcomes
        });
      } catch {
        issues.push({
          code: 'unsafe_terminal_outcome_resolution',
          detail: 'Terminalization must be total and may terminalize only exact phase-allowlisted outcomes.',
          operationName: operation.name,
          operationVersion: operation.version
        });
      }
    }
    if (autonomyPreflight) {
      for (const disposition of autonomyPolicy?.supportedDispositions ?? []) {
        if (disposition === 'proceed') continue;
        validateRegisteredNonterminalOutcome(
          autonomyPreflight.interventionOutcomes[disposition],
          `Autonomy ${disposition} outcome`
        );
      }
    }

    const compiledBindings = new Map<string, CompiledEffectBinding>();
    const seenSurfaces = new Set<string>();
    for (const binding of operation.bindings) {
      if (seenSurfaces.has(binding.surface)) {
        issues.push({ code: 'duplicate_surface_binding', detail: `Surface ${binding.surface} is bound more than once.`, operationName: operation.name, operationVersion: operation.version });
      }
      seenSurfaces.add(binding.surface);
      if (binding.surface === 'operator_http' || binding.surface === 'participant_http') {
        const routeKey = `${binding.method} ${binding.path}`;
        if (routes.has(routeKey)) {
          issues.push({ code: 'duplicate_http_binding', detail: `HTTP binding ${routeKey} is duplicated.`, operationName: operation.name, operationVersion: operation.version });
        }
        routes.add(routeKey);
        if (binding.method !== 'POST' || binding.input !== 'body' || binding.browserResumption.kind !== 'none') {
          issues.push({ code: 'unsupported_effect_binding', detail: 'Operator and participant effect bindings require POST/body with explicit no-resumption policy.', operationName: operation.name, operationVersion: operation.version });
        }
      } else if (binding.surface === 'public_http') {
        const routeKey = `${binding.method} ${binding.path}`;
        if (routes.has(routeKey)) {
          issues.push({ code: 'duplicate_http_binding', detail: `HTTP binding ${routeKey} is duplicated.`, operationName: operation.name, operationVersion: operation.version });
        }
        routes.add(routeKey);
        if (!publicEffectActivation
            || binding.method !== 'POST'
            || binding.input !== 'body'
            || binding.browserResumption.kind !== 'server_ref') {
          issues.push({
            code: 'unsupported_public_effect_binding',
            detail: 'Closed-harness public effects require POST/body and an exact server-reference resumption contract.',
            operationName: operation.name,
            operationVersion: operation.version
          });
        }
      } else {
        if (operation.effect !== 'draft') {
          issues.push({ code: 'app_model_commit_forbidden', detail: 'App-model effect bindings may expose draft operations only.', operationName: operation.name, operationVersion: operation.version });
        }
        if (!accessLanes.some((lane) => lane.surface === 'app_model' && lane.kind === 'app_model')) {
          issues.push({ code: 'app_model_lane_mismatch', detail: 'App-model bindings require the exact app-model access lane.', operationName: operation.name, operationVersion: operation.version });
        }
        if (appModelTools.has(binding.toolName)) {
          issues.push({ code: 'duplicate_app_model_tool_binding', detail: `App-model tool ${binding.toolName} is duplicated.`, operationName: operation.name, operationVersion: operation.version });
        }
        appModelTools.add(binding.toolName);
      }
      const projection = findDefinition({ map: projections, reference: binding.projection, usage: `projection for ${binding.surface}`, issues, operation });
      if (projection && !sameSchemaRef(projection.canonicalResultSchema, operation.canonicalResultSchema)) {
        issues.push({ code: 'projection_input_mismatch', detail: 'The projection canonical schema does not match the operation contract.', operationName: operation.name, operationVersion: operation.version });
      }
      const projectedResultSchema = projection
        ? findSchema(schemas, projection.projectedResultSchema, `projection result for ${binding.surface}`, issues, operation)
        : undefined;
      if (projection && projectedResultSchema) {
        if (idempotencyConflict && !projectedResultSchema.schema.safeParse({
          kind: 'outcome',
          outcome: idempotencyConflictFixture(idempotencyConflict.detailSchema.version),
          terminal: false,
          correlationId: '018f0f47-7a86-7d36-8a25-9f86589c7a4d'
        }).success) {
          issues.push({ code: 'idempotency_conflict_projection_mismatch', detail: 'The projected result schema must admit the nonterminal request-changed outcome.', operationName: operation.name, operationVersion: operation.version });
        }
        if (binding.surface === 'operator_http' || binding.surface === 'participant_http') {
          compiledBindings.set(binding.surface, {
            surface: binding.surface,
            method: binding.method,
            path: binding.path,
            input: binding.input,
            projection,
            projectedResultSchema
          });
        } else if (binding.surface === 'public_http') {
          compiledBindings.set(binding.surface, {
            surface: binding.surface,
            method: binding.method,
            path: binding.path,
            input: binding.input,
            browserResumption: binding.browserResumption,
            projection,
            projectedResultSchema
          });
        } else {
          compiledBindings.set(binding.surface, {
            surface: binding.surface,
            toolName: binding.toolName,
            projection,
            projectedResultSchema
          });
        }
      }
    }

    const compiledRegisteredConsumerBindings = new Map<
      string,
      CompiledRegisteredConsumerEffectBinding
    >();
    for (const binding of operation.registeredConsumerBindings ?? []) {
      const consumerKey = refKey(binding.consumer);
      if (!versionedDefinitionRefSchema.safeParse(binding.consumer).success) {
        issues.push({
          code: 'invalid_registered_consumer_reference',
          detail: 'Registered-consumer bindings require an exact key and version.',
          operationName: operation.name,
          operationVersion: operation.version
        });
      }
      if (registeredConsumerOwners.has(consumerKey)) {
        issues.push({
          code: 'duplicate_registered_consumer_binding',
          detail: `Registered consumer ${consumerKey} is bound more than once.`,
          operationName: operation.name,
          operationVersion: operation.version
        });
      } else {
        registeredConsumerOwners.add(consumerKey);
      }
      if (binding.surface !== 'application_job' || binding.lane !== 'registered_consumer') {
        issues.push({
          code: 'unsupported_registered_consumer_binding',
          detail: 'Registered-consumer bindings require the application-job registered-consumer lane.',
          operationName: operation.name,
          operationVersion: operation.version
        });
      }
      if (!accessLanes.some(
        (lane) => lane.surface === 'application_job' && lane.kind === 'registered_consumer'
      )) {
        issues.push({
          code: 'registered_consumer_lane_mismatch',
          detail: 'Registered-consumer bindings require the exact registered-consumer access lane.',
          operationName: operation.name,
          operationVersion: operation.version
        });
      }
      const projection = findDefinition({
        map: projections,
        reference: binding.projection,
        usage: `projection for registered consumer ${consumerKey}`,
        issues,
        operation
      });
      if (projection && !sameSchemaRef(projection.canonicalResultSchema, operation.canonicalResultSchema)) {
        issues.push({
          code: 'projection_input_mismatch',
          detail: 'The registered-consumer projection canonical schema does not match the operation contract.',
          operationName: operation.name,
          operationVersion: operation.version
        });
      }
      const projectedResultSchema = projection
        ? findSchema(
            schemas,
            projection.projectedResultSchema,
            `projection result for registered consumer ${consumerKey}`,
            issues,
            operation
          )
        : undefined;
      if (projection && projectedResultSchema) {
        if (idempotencyConflict && !projectedResultSchema.schema.safeParse({
          kind: 'outcome',
          outcome: idempotencyConflictFixture(idempotencyConflict.detailSchema.version),
          terminal: false,
          correlationId: '018f0f47-7a86-7d36-8a25-9f86589c7a4d'
        }).success) {
          issues.push({
            code: 'idempotency_conflict_projection_mismatch',
            detail: 'The registered-consumer result schema must admit the nonterminal request-changed outcome.',
            operationName: operation.name,
            operationVersion: operation.version
          });
        }
        compiledRegisteredConsumerBindings.set(consumerKey, Object.freeze({
          surface: 'application_job',
          lane: 'registered_consumer',
          consumer: Object.freeze({ ...binding.consumer }),
          projection,
          projectedResultSchema
        }));
      }
    }

    const compiledRegisteredJobBindings = new Map<
      string,
      CompiledRegisteredJobEffectBinding
    >();
    for (const binding of operation.registeredJobBindings ?? []) {
      const jobKey = refKey(binding.job);
      if (!versionedDefinitionRefSchema.safeParse(binding.job).success) {
        issues.push({
          code: 'invalid_registered_job_reference',
          detail: 'Registered-job bindings require an exact key and version.',
          operationName: operation.name,
          operationVersion: operation.version
        });
      }
      if (registeredJobOwners.has(jobKey)) {
        issues.push({
          code: 'duplicate_registered_job_binding',
          detail: `Registered job ${jobKey} is bound more than once.`,
          operationName: operation.name,
          operationVersion: operation.version
        });
      } else {
        registeredJobOwners.add(jobKey);
      }
      if (binding.surface !== 'application_job' || binding.lane !== 'registered_job') {
        issues.push({
          code: 'unsupported_registered_job_binding',
          detail: 'Registered-job bindings require the application-job registered-job lane.',
          operationName: operation.name,
          operationVersion: operation.version
        });
      }
      if (!accessLanes.some(
        (lane) => lane.surface === 'application_job' && lane.kind === 'registered_job'
      )) {
        issues.push({
          code: 'registered_job_lane_mismatch',
          detail: 'Registered-job bindings require the exact registered-job access lane.',
          operationName: operation.name,
          operationVersion: operation.version
        });
      }
      if (!versionedDefinitionRefSchema.safeParse(binding.inputProjection).success) {
        issues.push({
          code: 'invalid_registered_job_input_projection',
          detail: 'Registered-job bindings require one exact job-input projection reference.',
          operationName: operation.name,
          operationVersion: operation.version
        });
      }
      try {
        parseCapabilityRevisionId(binding.capabilityRevisionId);
      } catch {
        issues.push({
          code: 'invalid_registered_job_capability',
          detail: 'Registered-job bindings require one exact capability revision.',
          operationName: operation.name,
          operationVersion: operation.version
        });
      }
      if (!versionedDefinitionRefSchema.safeParse(binding.authorityCitation).success) {
        issues.push({
          code: 'invalid_registered_job_authority_citation',
          detail: 'Registered-job bindings require one exact authority-citation definition.',
          operationName: operation.name,
          operationVersion: operation.version
        });
      }
      const projection = findDefinition({
        map: projections,
        reference: binding.projection,
        usage: `result projection for registered job ${jobKey}`,
        issues,
        operation
      });
      if (projection && !sameSchemaRef(projection.canonicalResultSchema, operation.canonicalResultSchema)) {
        issues.push({
          code: 'projection_input_mismatch',
          detail: 'The registered-job result projection canonical schema does not match the operation contract.',
          operationName: operation.name,
          operationVersion: operation.version
        });
      }
      const projectedResultSchema = projection
        ? findSchema(
            schemas,
            projection.projectedResultSchema,
            `result projection schema for registered job ${jobKey}`,
            issues,
            operation
          )
        : undefined;
      if (projection && projectedResultSchema) {
        if (idempotencyConflict && !projectedResultSchema.schema.safeParse({
          kind: 'outcome',
          outcome: idempotencyConflictFixture(idempotencyConflict.detailSchema.version),
          terminal: false,
          correlationId: '018f0f47-7a86-7d36-8a25-9f86589c7a4d'
        }).success) {
          issues.push({
            code: 'idempotency_conflict_projection_mismatch',
            detail: 'The registered-job result schema must admit the nonterminal request-changed outcome.',
            operationName: operation.name,
            operationVersion: operation.version
          });
        }
        compiledRegisteredJobBindings.set(jobKey, Object.freeze({
          surface: 'application_job',
          lane: 'registered_job',
          job: Object.freeze({ ...binding.job }),
          inputProjection: Object.freeze({ ...binding.inputProjection }),
          capabilityRevisionId: binding.capabilityRevisionId,
          authorityCitation: Object.freeze({ ...binding.authorityCitation }),
          projection,
          projectedResultSchema
        }));
      }
    }

    if (validAudit && resolvedAuditTarget && resolvedAuditRecordProfile && autonomyPolicy
      && inputSchema && contributionSchema && canonicalResultSchema && contextBuilder && handler
      && executionFamily && executionPhase && terminalizationResolver && autonomyPreflight
      && riskResolver && autonomyEvidenceResolver && renewedApprovalResolver) {
      const compiledOperation: CompiledEffectOperation = Object.freeze({
        definition: sealedEffectDefinition(operation, accessLanes),
        autonomyPolicy,
        inputSchema,
        contributionSchema,
        canonicalResultSchema,
        contextBuilder,
        handler: capturedEffectHandlerRegistration(handler),
        executionFamily,
        executionPhase,
        terminalizationResolver,
        autonomyPreflight,
        riskResolver,
        autonomyEvidenceResolver,
        renewedApprovalResolver,
        auditTarget: deepFreeze({
          reference: { ...resolvedAuditTarget.reference },
          kind: resolvedAuditTarget.kind,
          recordProfile: { ...resolvedAuditTarget.recordProfile }
        }),
        auditRecordProfile: deepFreeze({
          reference: { ...resolvedAuditRecordProfile.reference },
          kind: resolvedAuditRecordProfile.kind,
          maximumBytes: resolvedAuditRecordProfile.maximumBytes
        }),
        outcomes: sealedReadonlyMap(declaredOutcomes),
        bindings: sealedReadonlyMap(compiledBindings),
        registeredConsumerBindings: sealedReadonlyMap(compiledRegisteredConsumerBindings),
        registeredJobBindings: sealedReadonlyMap(compiledRegisteredJobBindings),
        schemas: sealedReadonlyMap(schemas)
      });
      compiledEffects.set(operationKey(operation.name, operation.version), compiledOperation);
      for (const [consumerKey, binding] of compiledRegisteredConsumerBindings) {
        if (!registeredConsumerOperations.has(consumerKey)) {
          registeredConsumerOperations.set(consumerKey, Object.freeze({
            operation: compiledOperation,
            binding
          }));
        }
      }
      for (const [jobKey, binding] of compiledRegisteredJobBindings) {
        if (!registeredJobOperations.has(jobKey)) {
          registeredJobOperations.set(jobKey, Object.freeze({
            operation: compiledOperation,
            binding
          }));
        }
      }
    }
  }

  if (issues.length > 0) throw new OperationRegistryValidationError(issues);

  const readEntries: SafeOperationManifestEntry[] = [...compiled.values()]
    .filter((operation) => operation.bindings.size > 0)
    .map((operation) => safeOperationManifestEntrySchema.parse({
      name: operation.definition.name,
      version: operation.definition.version,
      lifecycle: operation.definition.lifecycle,
      summary: operation.definition.summary,
      effect: 'read',
      maxRisk: operation.definition.maxRisk,
      autonomy: safeAutonomy(operation.autonomyPolicy),
      consequenceTags: [...new Set(operation.definition.consequenceTags)].sort(),
      inputSchema: operation.inputSchema.reference,
      idempotency: { required: false },
      concurrency: { kind: 'read_snapshot' },
      outcomes: [...operation.definition.outcomes].sort((left, right) => left.class.localeCompare(right.class) || left.kind.localeCompare(right.kind)),
      enabledBindings: [...operation.bindings.values()].map((binding) => {
        if (
          binding.public.surface === 'operator_http'
          || binding.public.surface === 'participant_http'
          || binding.public.surface === 'public_http'
        ) {
          return {
            surface: binding.public.surface,
            protocol: 'http' as const,
            method: binding.public.method,
            path: binding.public.path,
            input: binding.public.input,
            resultSchema: binding.projectedResultSchema.reference,
            browserResumption: { kind: 'none' as const }
          };
        }
        return {
          surface: binding.public.surface,
          protocol: 'tool' as const,
          toolName: binding.public.toolName,
          resultSchema: binding.projectedResultSchema.reference
        };
      }).sort((left, right) => {
            const surface = left.surface.localeCompare(right.surface);
            if (surface !== 0) return surface;
            const leftSelector = left.protocol === 'http' ? `${left.method} ${left.path}` : left.toolName;
            const rightSelector = right.protocol === 'http' ? `${right.method} ${right.path}` : right.toolName;
            return leftSelector.localeCompare(rightSelector);
          })
    }));
  const effectEntries: SafeOperationManifestEntry[] = [...compiledEffects.values()]
    .filter((operation) => operation.bindings.size > 0)
    .map((operation) => safeOperationManifestEntrySchema.parse({
      name: operation.definition.name,
      version: operation.definition.version,
      lifecycle: operation.definition.lifecycle,
      summary: operation.definition.summary,
      effect: operation.definition.effect,
      maxRisk: operation.definition.maxRisk,
      autonomy: safeAutonomy(operation.autonomyPolicy),
      consequenceTags: [...new Set(operation.definition.consequenceTags)].sort(),
      inputSchema: operation.inputSchema.reference,
      idempotency: { required: true, ...operation.definition.idempotency },
      concurrency: { kind: 'registered', definition: operation.definition.concurrency },
      outcomes: [...operation.definition.outcomes].sort((left, right) => left.class.localeCompare(right.class) || left.kind.localeCompare(right.kind)),
      enabledBindings: [...operation.bindings.values()].map((binding) => {
        if (binding.surface === 'operator_http' || binding.surface === 'participant_http') {
          return {
            surface: binding.surface,
            protocol: 'http' as const,
            method: binding.method,
            path: binding.path,
            input: binding.input,
            resultSchema: binding.projectedResultSchema.reference,
            browserResumption: { kind: 'none' as const }
          };
        }
        if (binding.surface === 'public_http') {
          return {
            surface: binding.surface,
            protocol: 'http' as const,
            method: binding.method,
            path: binding.path,
            input: binding.input,
            resultSchema: binding.projectedResultSchema.reference,
            browserResumption: binding.browserResumption
          };
        }
        return {
          surface: binding.surface,
          protocol: 'tool' as const,
          toolName: binding.toolName,
          resultSchema: binding.projectedResultSchema.reference
        };
      }).sort((left, right) => {
            const surface = left.surface.localeCompare(right.surface);
            if (surface !== 0) return surface;
            const leftSelector = left.protocol === 'http' ? `${left.method} ${left.path}` : left.toolName;
            const rightSelector = right.protocol === 'http' ? `${right.method} ${right.path}` : right.toolName;
            return leftSelector.localeCompare(rightSelector);
          })
    }));
  const entries = [...readEntries, ...effectEntries]
    .sort((left, right) => left.name.localeCompare(right.name) || left.version - right.version);
  const body: SafeOperationManifestBody = safeOperationManifestBodySchema.parse({ schemaVersion: 1, operations: entries });
  const registryDigestSha256 = await sha256(body);
  const safeManifest = deepFreeze(safeOperationManifestSchema.parse({ ...body, registryDigestSha256 }));
  const internalBindings: InternalOperationBindingManifestEntry[] = [
    ...[...registeredConsumerOperations.values()].map(({ operation, binding }) => ({
      kind: 'registered_consumer' as const,
      selector: { ...binding.consumer },
      operation: {
        name: operation.definition.name,
        version: operation.definition.version
      },
      resultProjection: { ...binding.projection.reference },
      resultSchema: { ...binding.projectedResultSchema.reference },
      accessLane: {
        ...operation.definition.accessLanes.find(
          (lane) => lane.surface === 'application_job' && lane.kind === 'registered_consumer'
        )!,
        policy: {
          ...operation.definition.accessLanes.find(
            (lane) => lane.surface === 'application_job' && lane.kind === 'registered_consumer'
          )!.policy
        }
      }
    })),
    ...[...registeredJobOperations.values()].map(({ operation, binding }) => ({
      kind: 'registered_job' as const,
      selector: { ...binding.job },
      operation: {
        name: operation.definition.name,
        version: operation.definition.version
      },
      operationInputSchema: { ...operation.inputSchema.reference },
      inputProjection: { ...binding.inputProjection },
      capabilityRevisionId: binding.capabilityRevisionId,
      authorityCitation: { ...binding.authorityCitation },
      resultProjection: { ...binding.projection.reference },
      resultSchema: { ...binding.projectedResultSchema.reference },
      accessLane: {
        ...operation.definition.accessLanes.find(
          (lane) => lane.surface === 'application_job' && lane.kind === 'registered_job'
        )!,
        policy: {
          ...operation.definition.accessLanes.find(
            (lane) => lane.surface === 'application_job' && lane.kind === 'registered_job'
          )!.policy
        }
      }
    }))
  ].sort((left, right) => left.kind.localeCompare(right.kind)
    || left.selector.key.localeCompare(right.selector.key)
    || left.selector.version - right.selector.version);
  const internalBody = {
    schemaVersion: 1 as const,
    bindings: internalBindings,
    operationRegistryDigestSha256: registryDigestSha256
  };
  const internalManifestDigestSha256 = await sha256(internalBody);
  const internalManifest: InternalOperationManifest = deepFreeze({
    ...internalBody
  });
  const operatorHttpBindings = deepFreeze([...compiled.values()]
    .flatMap((operation) => [...operation.bindings.values()]
      .map((binding) => binding.public)
      .filter((binding): binding is RegisteredOperatorHttpReadBinding => binding.surface === 'operator_http'))
    .sort((left, right) => left.path.localeCompare(right.path) || left.operationName.localeCompare(right.operationName) || left.operationVersion - right.operationVersion));
  const participantHttpBindings = deepFreeze([...compiled.values()]
    .flatMap((operation) => [...operation.bindings.values()]
      .map((binding) => binding.public)
      .filter((binding): binding is RegisteredParticipantHttpReadBinding => binding.surface === 'participant_http'))
    .sort((left, right) => left.path.localeCompare(right.path) || left.operationName.localeCompare(right.operationName) || left.operationVersion - right.operationVersion));
  const publicHttpBindings = deepFreeze([...compiled.values()]
    .flatMap((operation) => [...operation.bindings.values()]
      .map((binding) => binding.public)
      .filter((binding): binding is RegisteredPublicHttpReadBinding => binding.surface === 'public_http'))
    .sort((left, right) => left.path.localeCompare(right.path) || left.operationName.localeCompare(right.operationName) || left.operationVersion - right.operationVersion));
  const appModelReadBindings = deepFreeze([...compiled.values()]
    .flatMap((operation) => [...operation.bindings.values()]
      .map((binding) => binding.public)
      .filter((binding): binding is RegisteredAppModelReadBinding => binding.surface === 'app_model'))
    .sort((left, right) => left.toolName.localeCompare(right.toolName)
      || left.operationName.localeCompare(right.operationName)
      || left.operationVersion - right.operationVersion));
  const operatorHttpEffectBindings = deepFreeze([...compiledEffects.values()]
    .flatMap((operation) => [...operation.bindings.values()]
      .filter((binding): binding is CompiledOperatorHttpEffectBinding => binding.surface === 'operator_http')
      .map((binding) => ({
        operationName: operation.definition.name,
        operationVersion: operation.definition.version,
        surface: binding.surface,
        method: binding.method,
        path: binding.path,
        input: binding.input
      } satisfies RegisteredOperatorHttpEffectBinding)))
    .sort((left, right) => left.path.localeCompare(right.path)
      || left.operationName.localeCompare(right.operationName)
      || left.operationVersion - right.operationVersion));
  const participantHttpEffectBindings = deepFreeze([...compiledEffects.values()]
    .flatMap((operation) => [...operation.bindings.values()]
      .filter((binding): binding is CompiledParticipantHttpEffectBinding => binding.surface === 'participant_http')
      .map((binding) => ({
        operationName: operation.definition.name,
        operationVersion: operation.definition.version,
        surface: binding.surface,
        method: binding.method,
        path: binding.path,
        input: binding.input
      } satisfies RegisteredParticipantHttpEffectBinding)))
    .sort((left, right) => left.path.localeCompare(right.path)
      || left.operationName.localeCompare(right.operationName)
      || left.operationVersion - right.operationVersion));
  const publicHttpEffectBindings = deepFreeze([...compiledEffects.values()]
    .flatMap((operation) => [...operation.bindings.values()]
      .filter((binding): binding is CompiledPublicHttpEffectBinding => binding.surface === 'public_http')
      .map((binding) => ({
        operationName: operation.definition.name,
        operationVersion: operation.definition.version,
        surface: binding.surface,
        method: binding.method,
        path: binding.path,
        input: binding.input,
        browserResumption: binding.browserResumption
      } satisfies RegisteredPublicHttpEffectBinding)))
    .sort((left, right) => left.path.localeCompare(right.path)
      || left.operationName.localeCompare(right.operationName)
      || left.operationVersion - right.operationVersion));
  const appModelEffectBindings = deepFreeze([...compiledEffects.values()]
    .flatMap((operation) => [...operation.bindings.values()]
      .filter((binding): binding is CompiledAppModelEffectBinding => binding.surface === 'app_model')
      .map((binding) => ({
        operationName: operation.definition.name,
        operationVersion: operation.definition.version,
        surface: binding.surface,
        toolName: binding.toolName
      } satisfies RegisteredAppModelEffectBinding)))
    .sort((left, right) => left.toolName.localeCompare(right.toolName)
      || left.operationName.localeCompare(right.operationName)
      || left.operationVersion - right.operationVersion));
  const registry: OperationRegistry = Object.freeze({
    safeManifest,
    manifestDigestSha256: registryDigestSha256,
    internalManifest,
    internalManifestDigestSha256,
    operatorHttpBindings,
    participantHttpBindings,
    publicHttpBindings,
    appModelReadBindings,
    operatorHttpEffectBindings,
    participantHttpEffectBindings,
    publicHttpEffectBindings,
    appModelEffectBindings
  });
  registryStates.set(registry, {
    readOperations: compiled,
    effectOperations: compiledEffects,
    registeredConsumerOperations,
    registeredJobOperations
  });
  return registry;
}

export async function createReadOperationRegistry(source: ReadOperationRegistrySource): Promise<ReadOperationRegistry> {
  const registry = await createOperationRegistry({
    autonomyPolicies: source.autonomyPolicies,
    schemas: source.schemas,
    contextBuilders: source.contextBuilders,
    readCapabilities: source.readCapabilities,
    handlers: source.handlers,
    projections: source.projections,
    ...(source.readOperationalTraceTargets === undefined
      ? {}
      : { readOperationalTraceTargets: source.readOperationalTraceTargets }),
    ...(source.operationAuditTargets === undefined
      ? {}
      : { operationAuditTargets: source.operationAuditTargets }),
    ...(source.operationAuditRecordProfiles === undefined
      ? {}
      : { operationAuditRecordProfiles: source.operationAuditRecordProfiles }),
    operations: source.operations
  });
  const readRegistry: ReadOperationRegistry = Object.freeze({
    safeManifest: registry.safeManifest,
    manifestDigestSha256: registry.manifestDigestSha256,
    operatorHttpBindings: registry.operatorHttpBindings,
    participantHttpBindings: registry.participantHttpBindings,
    publicHttpBindings: registry.publicHttpBindings,
    appModelReadBindings: registry.appModelReadBindings
  });
  const state = registryStates.get(registry);
  if (!state) throw new OperationRegistryValidationError([{
    code: 'missing_registry_state',
    detail: 'The compiled operation registry state is unavailable.'
  }]);
  registryStates.set(readRegistry, state);
  return readRegistry;
}

export function getCompiledReadOperation(
  registry: ReadOperationRegistry,
  name: string,
  version: number,
  surface: string
): { readonly operation: CompiledReadOperation; readonly binding: CompiledBinding } | undefined {
  const operation = registryStates.get(registry)?.readOperations.get(operationKey(name, version));
  const binding = operation?.bindings.get(surface);
  return operation && binding ? { operation, binding } : undefined;
}

export function getCompiledEffectOperation(
  registry: OperationRegistry,
  name: string,
  version: number,
  surface: string
): { readonly operation: CompiledEffectOperation; readonly binding: CompiledEffectBinding } | undefined {
  const operation = registryStates.get(registry)?.effectOperations.get(operationKey(name, version));
  const binding = operation?.bindings.get(surface);
  return operation && binding ? { operation, binding } : undefined;
}

export function getCompiledRegisteredConsumerEffectOperation(
  registry: OperationRegistry,
  consumerKey: string,
  consumerVersion: number
): {
  readonly operation: CompiledEffectOperation;
  readonly binding: CompiledRegisteredConsumerEffectBinding;
} | undefined {
  return registryStates.get(registry)?.registeredConsumerOperations.get(
    `${consumerKey}@${consumerVersion}`
  );
}

export function getCompiledRegisteredJobEffectOperation(
  registry: OperationRegistry,
  jobKey: string,
  jobVersion: number
): {
  readonly operation: CompiledEffectOperation;
  readonly binding: CompiledRegisteredJobEffectBinding;
} | undefined {
  return registryStates.get(registry)?.registeredJobOperations.get(
    `${jobKey}@${jobVersion}`
  );
}

/** Application-internal composition view; never serialized into a safe manifest. */
export function listCompiledRegisteredConsumerEffectOperations(
  registry: OperationRegistry
): readonly {
  readonly operation: CompiledEffectOperation;
  readonly binding: CompiledRegisteredConsumerEffectBinding;
}[] {
  return Object.freeze(
    [...(registryStates.get(registry)?.registeredConsumerOperations.values() ?? [])]
      .sort((left, right) => refKey(left.binding.consumer).localeCompare(refKey(right.binding.consumer)))
  );
}

/** Application-internal composition view; never serialized into a safe manifest. */
export function listCompiledRegisteredJobEffectOperations(
  registry: OperationRegistry
): readonly {
  readonly operation: CompiledEffectOperation;
  readonly binding: CompiledRegisteredJobEffectBinding;
}[] {
  return Object.freeze(
    [...(registryStates.get(registry)?.registeredJobOperations.values() ?? [])]
      .sort((left, right) => refKey(left.binding.job).localeCompare(refKey(right.binding.job)))
  );
}
