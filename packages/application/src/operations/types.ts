import type {
  OperationLifecycle,
  OperationOutcomeDeclaration,
  OperationRisk,
  OperationSurface,
  EffectfulOperationResult,
  OperationReceiptRef,
  ReadOperationResult,
  BrowserResumption,
  SafeOperationManifest,
  SafeSchemaManifestRef,
  StructuredOutcome,
  VersionedDefinitionRef
} from '@jooevents/contracts';
import type { CurrentAuthorityDenialReason, OperationAccessLane } from '@jooevents/identity-access';
import type {
  ActorRef,
  CapabilityRevisionId,
  Clock,
  CorrelationId,
  Instant,
  InvocationId,
  JobId,
  ResolvedScope
} from '@jooevents/kernel';
import type { ZodType } from 'zod';
import type { OperationAutonomyPolicy } from '../autonomy';
import type {
  AutonomyEvidenceResolverRegistration,
  AutonomyPreflightRegistration,
  NonProceedAutonomyDisposition,
  OperationRiskResolverRegistration,
  RenewedApprovalResolverRegistration
} from './autonomy-preflight';
import type {
  SingleUnitOfWorkFamilyRegistration,
  SingleUnitOfWorkPhaseRegistration,
  TerminalizationResolverRegistration
} from './phase-contract';
import type {
  DeniedReadObservationAttempt,
  DeniedEffectAuditAttempt,
  InvocationClientRef,
  InvocationContext,
  InvocationProvenance,
  SealedEffectAuthorityRecheckResult
} from './invocation-context';

export type ReturnTypeOrPromise<Value> = Value | Promise<Value>;

export interface RegisteredOperationSchema {
  readonly reference: SafeSchemaManifestRef;
  readonly schema: ZodType;
  /** Disclosure-safe draft-2020-12 form captured before the executable parser is sealed. */
  readonly jsonSchema?: unknown;
}

export type ReadInvocationContext = InvocationContext;
export type ReadCapabilitySnapshot = Readonly<Record<string, unknown>>;

export interface ReadContextBuilderInput {
  readonly operationName: string;
  readonly operationVersion: number;
  readonly surface: OperationSurface;
  readonly correlationId: string;
  readonly businessInput: unknown;
  readonly verifiedEvidence: unknown;
}

export type ReadContextBuildResult =
  | { readonly kind: 'ready'; readonly context: ReadInvocationContext }
  | {
      readonly kind: 'outcome';
      readonly outcome: StructuredOutcome;
      readonly observationAttempt: DeniedReadObservationAttempt;
    };

export interface ReadContextBuilderRegistration {
  readonly reference: VersionedDefinitionRef;
  build(input: ReadContextBuilderInput): ReturnTypeOrPromise<ReadContextBuildResult>;
}

export interface ReadCapabilityRegistration {
  readonly reference: VersionedDefinitionRef;
  openSnapshot(context: ReadInvocationContext): ReturnTypeOrPromise<ReadCapabilitySnapshot>;
}

export interface ReadHandlerRegistration {
  readonly reference: VersionedDefinitionRef;
  readonly readCapability: VersionedDefinitionRef;
  readonly canonicalResultSchema: SafeSchemaManifestRef;
  handle(input: {
    readonly businessInput: unknown;
    readonly context: ReadInvocationContext;
    readonly snapshot: ReadCapabilitySnapshot;
  }): ReturnTypeOrPromise<unknown>;
}

export interface ReadProjectionRegistration {
  readonly reference: VersionedDefinitionRef;
  readonly canonicalResultSchema: SafeSchemaManifestRef;
  readonly projectedResultSchema: SafeSchemaManifestRef;
  project(canonicalResult: unknown): unknown;
}

export interface OperatorHttpReadBindingDefinition {
  readonly surface: 'operator_http';
  readonly method: 'GET';
  readonly path: string;
  readonly input: 'query';
  readonly browserResumption: { readonly kind: 'none' };
  readonly projection: VersionedDefinitionRef;
}

export interface ParticipantHttpReadBindingDefinition {
  readonly surface: 'participant_http';
  readonly method: 'GET';
  readonly path: string;
  readonly input: 'query';
  readonly browserResumption: { readonly kind: 'none' };
  readonly projection: VersionedDefinitionRef;
}

export interface PublicHttpReadBindingDefinition {
  readonly surface: 'public_http';
  readonly method: 'GET';
  readonly path: string;
  readonly input: 'query';
  readonly browserResumption: { readonly kind: 'none' };
  readonly projection: VersionedDefinitionRef;
}

export interface ExternalMcpReadBindingDefinition {
  readonly surface: 'external_mcp';
  readonly toolName: string;
  readonly projection: VersionedDefinitionRef;
}

export interface AppModelReadBindingDefinition {
  readonly surface: 'app_model';
  readonly toolName: string;
  readonly projection: VersionedDefinitionRef;
}

export type ReadOperationBindingDefinition =
  | OperatorHttpReadBindingDefinition
  | ParticipantHttpReadBindingDefinition
  | PublicHttpReadBindingDefinition
  | ExternalMcpReadBindingDefinition
  | AppModelReadBindingDefinition;

export type ReadImmutableAuditDeclaration =
  | { readonly mode: 'none' }
  | {
      /** Immutable audit is required only for external-MCP and app-model invocations. */
      readonly mode: 'external_mcp_app_model';
      readonly target: VersionedDefinitionRef;
    }
  | {
      /** Explicit security/classification floor: every enabled surface is audited. */
      readonly mode: 'required';
      readonly reason: 'security_sensitive' | 'classified';
      readonly target: VersionedDefinitionRef;
    };

export interface ReadObservabilityDeclaration {
  readonly trace: {
    readonly mode: 'required';
    readonly target: VersionedDefinitionRef;
  };
  readonly immutableAudit: ReadImmutableAuditDeclaration;
}

export interface ReadOperationDefinition {
  readonly name: string;
  readonly version: number;
  readonly lifecycle: OperationLifecycle;
  readonly summary: string;
  readonly effect: 'read';
  readonly maxRisk: OperationRisk;
  readonly autonomyPolicy: VersionedDefinitionRef;
  readonly consequenceTags: readonly string[];
  readonly inputSchema: SafeSchemaManifestRef;
  readonly canonicalResultSchema: SafeSchemaManifestRef;
  readonly outcomes: readonly OperationOutcomeDeclaration[];
  /** Internal executable authority declarations; omitted from the public safe manifest. */
  readonly accessLanes: readonly OperationAccessLane[];
  readonly contextBuilder: VersionedDefinitionRef;
  readonly readCapability: VersionedDefinitionRef;
  readonly handler: VersionedDefinitionRef;
  /** Internal executable observability policy; omitted from the public safe manifest. */
  readonly observability: ReadObservabilityDeclaration;
  readonly bindings: readonly ReadOperationBindingDefinition[];
}

export interface ReadOperationalTraceTargetRegistration {
  readonly reference: VersionedDefinitionRef;
  readonly kind: 'read_operational_trace_record';
  readonly recordProfile: VersionedDefinitionRef;
}

export interface ReadOperationRegistrySource {
  readonly autonomyPolicies: readonly OperationAutonomyPolicy[];
  readonly schemas: readonly RegisteredOperationSchema[];
  readonly contextBuilders: readonly ReadContextBuilderRegistration[];
  readonly readCapabilities: readonly ReadCapabilityRegistration[];
  readonly handlers: readonly ReadHandlerRegistration[];
  readonly projections: readonly ReadProjectionRegistration[];
  readonly readOperationalTraceTargets?: readonly ReadOperationalTraceTargetRegistration[];
  readonly operationAuditTargets?: readonly OperationAuditTargetRegistration[];
  readonly operationAuditRecordProfiles?: readonly OperationAuditRecordProfileRegistration[];
  readonly operations: readonly ReadOperationDefinition[];
}

export interface RegisteredOperatorHttpReadBinding {
  readonly operationName: string;
  readonly operationVersion: number;
  readonly surface: 'operator_http';
  readonly method: 'GET';
  readonly path: string;
  readonly input: 'query';
}

export interface RegisteredParticipantHttpReadBinding {
  readonly operationName: string;
  readonly operationVersion: number;
  readonly surface: 'participant_http';
  readonly method: 'GET';
  readonly path: string;
  readonly input: 'query';
}

export interface RegisteredPublicHttpReadBinding {
  readonly operationName: string;
  readonly operationVersion: number;
  readonly surface: 'public_http';
  readonly method: 'GET';
  readonly path: string;
  readonly input: 'query';
}

export interface RegisteredExternalMcpReadBinding {
  readonly operationName: string;
  readonly operationVersion: number;
  readonly surface: 'external_mcp';
  readonly toolName: string;
}

export interface RegisteredAppModelReadBinding {
  readonly operationName: string;
  readonly operationVersion: number;
  readonly surface: 'app_model';
  readonly toolName: string;
}

export type RegisteredReadOperationBinding =
  | RegisteredOperatorHttpReadBinding
  | RegisteredParticipantHttpReadBinding
  | RegisteredPublicHttpReadBinding
  | RegisteredExternalMcpReadBinding
  | RegisteredAppModelReadBinding;

export interface ReadOperationRegistry {
  readonly safeManifest: SafeOperationManifest;
  readonly manifestDigestSha256: string;
  readonly operatorHttpBindings: readonly RegisteredOperatorHttpReadBinding[];
  readonly participantHttpBindings: readonly RegisteredParticipantHttpReadBinding[];
  readonly publicHttpBindings: readonly RegisteredPublicHttpReadBinding[];
  readonly appModelReadBindings: readonly RegisteredAppModelReadBinding[];
}

export interface RegistryValidationIssue {
  readonly code: string;
  readonly detail: string;
  readonly operationName?: string;
  readonly operationVersion?: number;
}

export interface ExecuteReadOperationInput {
  readonly operationName: string;
  readonly operationVersion: number;
  readonly surface: OperationSurface;
  readonly correlationId: string;
  readonly businessInput: unknown;
  readonly verifiedEvidence: unknown;
}

export interface ReadOperationExecutor {
  execute(input: ExecuteReadOperationInput): Promise<ReadOperationResult>;
}

export type EffectInvocationContext = InvocationContext;
export type EffectHandlerSnapshot = Readonly<Record<string, unknown>>;

export interface SealedEffectRequestIdentity {
  /** Server-derived stable scope partition; never copied from an unverified request hint. */
  readonly scopePartitionKey: string;
  readonly authorityPrincipalKey: string;
  /** Immutable for an operation version; changing it requires a new operation version. */
  readonly idempotencyVerifierProfile: VersionedDefinitionRef;
  readonly idempotencyKeyVerifier: string;
  readonly requestHash: string;
}

export interface EffectContextBuilderInput {
  readonly operationName: string;
  readonly operationVersion: number;
  readonly surface: OperationSurface;
  readonly correlationId: string;
  readonly businessInput: unknown;
  readonly verifiedEvidence: unknown;
  readonly rawIdempotencyKey: string;
}

export type EffectContextBuildResult =
  | {
      readonly kind: 'ready';
      readonly context: EffectInvocationContext;
      readonly requestIdentity: SealedEffectRequestIdentity;
    }
  | {
      readonly kind: 'outcome';
      readonly outcome: StructuredOutcome;
      readonly auditAttempt: DeniedEffectAuditAttempt;
    };

export interface EffectContextBuilderRegistration {
  readonly reference: VersionedDefinitionRef;
  build(input: EffectContextBuilderInput): ReturnTypeOrPromise<EffectContextBuildResult>;
}

export interface EffectHandlerRegistration {
  readonly reference: VersionedDefinitionRef;
  readonly effect: 'draft' | 'commit';
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: SafeSchemaManifestRef;
  readonly canonicalResultSchema: SafeSchemaManifestRef;
  handle(input: {
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
    readonly snapshot: EffectHandlerSnapshot;
  }): ReturnTypeOrPromise<unknown>;
}

export interface OperationAuditTargetRegistration {
  readonly reference: VersionedDefinitionRef;
  readonly kind: 'operation_audit_record';
  readonly recordProfile: VersionedDefinitionRef;
}

export interface OperationAuditRecordProfileRegistration {
  readonly reference: VersionedDefinitionRef;
  readonly kind: 'canonical_json';
  readonly maximumBytes: number;
}

export interface OperatorHttpEffectBindingDefinition {
  readonly surface: 'operator_http';
  readonly method: 'POST';
  readonly path: string;
  readonly input: 'body';
  readonly browserResumption: { readonly kind: 'none' };
  readonly projection: VersionedDefinitionRef;
}

export interface ParticipantHttpEffectBindingDefinition {
  readonly surface: 'participant_http';
  readonly method: 'POST';
  readonly path: string;
  readonly input: 'body';
  readonly browserResumption: { readonly kind: 'none' };
  readonly projection: VersionedDefinitionRef;
}

export interface PublicHttpEffectBindingDefinition {
  readonly surface: 'public_http';
  readonly method: 'POST';
  readonly path: string;
  readonly input: 'body';
  readonly browserResumption: Extract<BrowserResumption, { readonly kind: 'server_ref' }>;
  readonly projection: VersionedDefinitionRef;
}

export interface AppModelEffectBindingDefinition {
  readonly surface: 'app_model';
  readonly toolName: string;
  readonly projection: VersionedDefinitionRef;
}

export type EffectOperationBindingDefinition =
  | OperatorHttpEffectBindingDefinition
  | ParticipantHttpEffectBindingDefinition
  | PublicHttpEffectBindingDefinition
  | AppModelEffectBindingDefinition;

/**
 * An application-internal binding for one exact registered consumer version.
 * It is executable but is never published through the safe operation manifest.
 */
export interface RegisteredConsumerEffectBindingDefinition {
  readonly surface: 'application_job';
  readonly lane: 'registered_consumer';
  readonly consumer: VersionedDefinitionRef;
  readonly projection: VersionedDefinitionRef;
}

/**
 * An application-internal binding for one exact registered job version.
 * The job payload cannot select any of these execution references.
 */
export interface RegisteredJobEffectBindingDefinition {
  readonly surface: 'application_job';
  readonly lane: 'registered_job';
  readonly job: VersionedDefinitionRef;
  /** Exact pure job-input to operation-input projector cited by the job catalog. */
  readonly inputProjection: VersionedDefinitionRef;
  readonly capabilityRevisionId: CapabilityRevisionId;
  readonly authorityCitation: VersionedDefinitionRef;
  /** Exact canonical-result to application-job result projection. */
  readonly projection: VersionedDefinitionRef;
}

/** Internal verified-inbox binding; never published as an HTTP/tool surface. */
export interface VerifiedInboxEffectBindingDefinition {
  readonly surface: 'provider_ingress';
  readonly lane: 'verified_inbox';
  readonly projection: VersionedDefinitionRef;
}

export interface OrdinaryEffectOperationDefinition {
  readonly name: string;
  readonly version: number;
  readonly lifecycle: OperationLifecycle;
  readonly summary: string;
  readonly effect: 'draft' | 'commit';
  readonly maxRisk: OperationRisk;
  readonly autonomyPolicy: VersionedDefinitionRef;
  readonly consequenceTags: readonly string[];
  /** Explicit opt-in metadata for the internal approved agent-action lane. */
  readonly agentAction?: {
    readonly eligible: true;
    readonly displayLabel: string;
    readonly consequences: readonly string[];
    readonly externalEffect: 'none' | 'reconcilable';
  };
  readonly inputSchema: SafeSchemaManifestRef;
  readonly contributionSchema: SafeSchemaManifestRef;
  readonly canonicalResultSchema: SafeSchemaManifestRef;
  readonly outcomes: readonly OperationOutcomeDeclaration[];
  /** Internal executable authority declarations; omitted from the public safe manifest. */
  readonly accessLanes: readonly OperationAccessLane[];
  readonly contextBuilder: VersionedDefinitionRef;
  readonly handlerCapability: VersionedDefinitionRef;
  readonly handler: VersionedDefinitionRef;
  /** Internal trusted trace declaration; omitted from the public safe manifest. */
  readonly audit: {
    readonly mode: 'required';
    readonly target: VersionedDefinitionRef;
  };
  readonly idempotency: {
    readonly keySource: VersionedDefinitionRef;
    /** Pins the server-keyed credential verifier to this exact operation version. */
    readonly credentialVerifierProfile: VersionedDefinitionRef;
    readonly requestHashProfile: VersionedDefinitionRef;
  };
  readonly concurrency: VersionedDefinitionRef;
  readonly execution:
    | {
        /** Legacy ordinary-evidence profile retained only during bounded conversion. */
        readonly kind: 'single_unit_of_work';
        readonly family: VersionedDefinitionRef;
        readonly phase: VersionedDefinitionRef;
        readonly terminalization: VersionedDefinitionRef;
        readonly autonomyPreflight: VersionedDefinitionRef;
      }
    | {
        /** Direct domain contribution plus exactly one compact operation-log row. */
        readonly kind: 'single_unit_of_work';
        readonly profile: 'direct_audited';
        readonly family: VersionedDefinitionRef;
        readonly phase: VersionedDefinitionRef;
        readonly terminalization: VersionedDefinitionRef;
        readonly autonomyPreflight: VersionedDefinitionRef;
        readonly history:
          | { readonly summary: string }
          | {
              readonly summariesByAction: Readonly<Record<string, string>>;
            }
          | {
              readonly summariesByActionAndKind: Readonly<Record<string, string>>;
            };
      };
  readonly bindings: readonly EffectOperationBindingDefinition[];
  readonly registeredConsumerBindings?: readonly RegisteredConsumerEffectBindingDefinition[];
  readonly registeredJobBindings?: readonly RegisteredJobEffectBindingDefinition[];
  readonly verifiedInboxBindings?: readonly VerifiedInboxEffectBindingDefinition[];
}

export interface OperationRegistrySource extends ReadOperationRegistrySource {
  readonly effectContextBuilders?: readonly EffectContextBuilderRegistration[];
  readonly effectHandlers?: readonly EffectHandlerRegistration[];
  readonly effectOperations?: readonly OrdinaryEffectOperationDefinition[];
  readonly effectExecutionFamilies?: readonly SingleUnitOfWorkFamilyRegistration[];
  readonly effectPhases?: readonly SingleUnitOfWorkPhaseRegistration[];
  readonly terminalizationResolvers?: readonly TerminalizationResolverRegistration[];
  readonly riskResolvers?: readonly OperationRiskResolverRegistration[];
  readonly autonomyEvidenceResolvers?: readonly AutonomyEvidenceResolverRegistration[];
  readonly renewedApprovalResolvers?: readonly RenewedApprovalResolverRegistration[];
  readonly autonomyPreflights?: readonly AutonomyPreflightRegistration[];
}

export interface RegisteredOperatorHttpEffectBinding {
  readonly operationName: string;
  readonly operationVersion: number;
  readonly surface: 'operator_http';
  readonly method: 'POST';
  readonly path: string;
  readonly input: 'body';
}

export interface RegisteredParticipantHttpEffectBinding {
  readonly operationName: string;
  readonly operationVersion: number;
  readonly surface: 'participant_http';
  readonly method: 'POST';
  readonly path: string;
  readonly input: 'body';
}

export interface RegisteredPublicHttpEffectBinding {
  readonly operationName: string;
  readonly operationVersion: number;
  readonly surface: 'public_http';
  readonly method: 'POST';
  readonly path: string;
  readonly input: 'body';
  readonly browserResumption: Extract<BrowserResumption, { readonly kind: 'server_ref' }>;
}

export interface RegisteredAppModelEffectBinding {
  readonly operationName: string;
  readonly operationVersion: number;
  readonly surface: 'app_model';
  readonly toolName: string;
}

export interface OperationRegistry extends ReadOperationRegistry {
  readonly operatorHttpEffectBindings: readonly RegisteredOperatorHttpEffectBinding[];
  readonly participantHttpEffectBindings: readonly RegisteredParticipantHttpEffectBinding[];
  readonly publicHttpEffectBindings: readonly RegisteredPublicHttpEffectBinding[];
  readonly appModelEffectBindings: readonly RegisteredAppModelEffectBinding[];
  /** Executable internal bindings, deliberately separate from the public safe manifest. */
  readonly internalManifest: InternalOperationManifest;
  readonly internalManifestDigestSha256: string;
}

export interface InternalRegisteredConsumerOperationBindingManifestEntry {
  readonly kind: 'registered_consumer';
  readonly selector: VersionedDefinitionRef;
  readonly operation: { readonly name: string; readonly version: number };
  readonly resultProjection: VersionedDefinitionRef;
  readonly resultSchema: SafeSchemaManifestRef;
  readonly accessLane: OperationAccessLane;
}

export interface InternalRegisteredJobOperationBindingManifestEntry {
  readonly kind: 'registered_job';
  readonly selector: VersionedDefinitionRef;
  readonly operation: { readonly name: string; readonly version: number };
  readonly operationInputSchema: SafeSchemaManifestRef;
  readonly inputProjection: VersionedDefinitionRef;
  readonly capabilityRevisionId: CapabilityRevisionId;
  readonly authorityCitation: VersionedDefinitionRef;
  readonly resultProjection: VersionedDefinitionRef;
  readonly resultSchema: SafeSchemaManifestRef;
  readonly accessLane: OperationAccessLane;
}

export type InternalOperationBindingManifestEntry =
  | InternalRegisteredConsumerOperationBindingManifestEntry
  | InternalRegisteredJobOperationBindingManifestEntry;

export interface InternalOperationManifest {
  readonly schemaVersion: 1;
  readonly bindings: readonly InternalOperationBindingManifestEntry[];
  /** Digest of the public operation registry joined by these internal bindings. */
  readonly operationRegistryDigestSha256: string;
}

export interface BuildEffectInvocationInput {
  readonly operationName: string;
  readonly operationVersion: number;
  readonly surface: OperationSurface;
  readonly correlationId: string;
  readonly businessInput: unknown;
  readonly verifiedEvidence: unknown;
  readonly rawIdempotencyKey: string;
}

export interface BuildRegisteredConsumerEffectInvocationInput {
  /** Selected from the durable delivery by the runner, never from its payload. */
  readonly consumer: VersionedDefinitionRef;
  readonly correlationId: string;
  readonly businessInput: unknown;
  readonly verifiedEvidence: unknown;
  /** Derived by the runner from the durable delivery and attempt identities. */
  readonly rawIdempotencyKey: string;
}

export interface BuildRegisteredJobEffectInvocationInput {
  /** Selected from the durable job head by the runner, never from its payload. */
  readonly job: VersionedDefinitionRef;
  readonly jobId: JobId;
  readonly correlationId: string;
  /** Already projected by the exact registered pure projector. */
  readonly businessInput: unknown;
}

export interface RegisteredJobInvocationAnchorResolver {
  resolve(input: {
    readonly job: VersionedDefinitionRef;
    readonly jobId: JobId;
  }): ReturnTypeOrPromise<{
    /** Stable semantic job anchor; physical attempts must resolve the same value. */
    readonly registeredIdempotencyIdentity: string;
  }>;
}

export interface EffectInvocationBuilderOptions {
  readonly registeredJobAnchorResolver?: RegisteredJobInvocationAnchorResolver;
}

/** Runtime authenticity is enforced by an application-owned opaque seal. */
export interface SealedEffectInvocation {
  readonly operationName: string;
  readonly operationVersion: number;
  readonly surface: OperationSurface;
  readonly correlationId: string;
}

export interface EffectInvocationBuilder {
  build(input: BuildEffectInvocationInput): Promise<SealedEffectInvocation>;
  buildRegisteredConsumer(
    input: BuildRegisteredConsumerEffectInvocationInput
  ): Promise<SealedEffectInvocation>;
  buildRegisteredJob(
    input: BuildRegisteredJobEffectInvocationInput
  ): Promise<SealedEffectInvocation>;
}

export interface EffectOperationIdentity {
  readonly scopePartitionKey: string;
  readonly authorityPrincipalKey: string;
  readonly operationName: string;
  readonly operationVersion: number;
  readonly surface: OperationSurface;
  readonly idempotencyVerifierProfile: VersionedDefinitionRef;
  readonly idempotencyKeyVerifier: string;
}

export interface TerminalEffectReceipt {
  readonly ref: OperationReceiptRef;
  readonly identity: EffectOperationIdentity;
  readonly requestHash: string;
  readonly result: EffectfulOperationResult;
}

/** The one compact terminal row emitted by a successful direct-audited mutation. */
export interface DirectOperationLogRecord {
  readonly receipt: TerminalEffectReceipt;
  readonly registryDigestSha256: string;
  readonly actor: ActorRef;
  readonly scope: OperationAuditScope;
  readonly summary: string;
  readonly occurredAt: Instant;
  readonly correlationId: CorrelationId;
  readonly actionBatchId?: string;
  readonly actionStepId?: string;
}

export interface OperationAuditScope {
  readonly workspaceId: ResolvedScope['workspaceId'];
  readonly eventId?: ResolvedScope['eventId'];
  readonly subjects: ResolvedScope['subjects'];
}

export type ReadObservationResultSummary =
  | { readonly kind: 'success' }
  | { readonly kind: 'request_rejected'; readonly reason: 'invalid_input' }
  | {
      readonly kind: 'outcome';
      readonly outcomeClass: StructuredOutcome['class'];
      readonly outcomeKind: string;
      readonly retryable: boolean;
    }
  | {
      readonly kind: 'internal_failure';
      readonly phase:
        | 'context'
        | 'read_snapshot'
        | 'handler'
        | 'canonical_result'
        | 'projection'
        | 'projected_result'
        | 'immutable_audit';
    };

interface ReadObservationRecordBase {
  readonly eventId: InvocationId;
  readonly operation: {
    readonly name: string;
    readonly version: number;
    readonly effect: 'read';
  };
  readonly maxRisk: OperationRisk;
  readonly autonomyPolicy: VersionedDefinitionRef;
  readonly consequenceTags: readonly string[];
  readonly surface: OperationSurface;
  readonly accessLane: OperationAccessLane;
  readonly correlationId: CorrelationId;
  readonly recordedAt: Instant;
  readonly client: InvocationClientRef;
  readonly provenance: InvocationProvenance;
  readonly scope: OperationAuditScope;
  readonly scopeResolutionEvidenceIds: readonly string[];
  readonly resultSummary: ReadObservationResultSummary;
}

export interface AuthorizedReadObservationRecordBase extends ReadObservationRecordBase {
  readonly disposition: 'authorized';
  readonly actor: ActorRef;
  readonly authorityEvidenceIds: readonly string[];
  readonly authorityCitationIds: readonly string[];
}

export interface DeniedReadObservationRecordBase extends ReadObservationRecordBase {
  readonly disposition: 'context_denied';
  readonly denialReason: CurrentAuthorityDenialReason;
}

export type ReadObservationRecordBaseUnion =
  | AuthorizedReadObservationRecordBase
  | DeniedReadObservationRecordBase
  | {
      /** The binding is known but trusted context construction did not complete. */
      readonly disposition: 'pre_context_failure';
      readonly eventId: InvocationId;
      readonly operation: {
        readonly name: string;
        readonly version: number;
        readonly effect: 'read';
      };
      readonly maxRisk: OperationRisk;
      readonly autonomyPolicy: VersionedDefinitionRef;
      readonly consequenceTags: readonly string[];
      readonly surface: OperationSurface;
      readonly correlationId: CorrelationId;
      readonly recordedAt: Instant;
      readonly resultSummary: Extract<
        ReadObservationResultSummary,
        { readonly kind: 'request_rejected' | 'internal_failure' }
      >;
    };

export type ReadOperationalTraceRecord = ReadObservationRecordBaseUnion & {
  readonly recordKind: 'read_operational_trace';
  readonly traceTarget: VersionedDefinitionRef;
  readonly recordProfile: VersionedDefinitionRef;
};

export type ReadImmutableAuditRecord = ReadObservationRecordBaseUnion & {
  readonly recordKind: 'read_immutable_audit';
  readonly auditTarget: VersionedDefinitionRef;
  readonly recordProfile: VersionedDefinitionRef;
};

export interface ReadOperationalTracePort {
  /** Operational telemetry is deliberately non-authoritative and best effort. */
  emit(record: ReadOperationalTraceRecord): void;
}

export interface ReadImmutableAuditPort {
  /** Required reads await this append before disclosing their result. */
  append(record: ReadImmutableAuditRecord): ReturnTypeOrPromise<void>;
}

export interface ReadOperationObservabilityPorts {
  readonly operationalTrace: ReadOperationalTracePort;
  readonly immutableAudit: ReadImmutableAuditPort;
}

export interface ReadOperationExecutorOptions extends ReadOperationObservabilityPorts {
  /** Used only when parsing/context fails before the trusted builder can mint an invocation identity. */
  readonly clock: Clock;
  readonly newInvocationId: () => InvocationId;
}

export type OperationAuditResultSummary =
  | { readonly kind: 'success'; readonly terminal: true }
  | {
      readonly kind: 'outcome';
      readonly outcomeClass: StructuredOutcome['class'];
      readonly outcomeKind: string;
      readonly retryable: boolean;
      readonly terminal: boolean;
    };

interface OperationAuditRecordBase {
  /** One trusted audit event per builder-owned invocation identity. */
  readonly eventId: InvocationId;
  readonly operation: {
    readonly name: string;
    readonly version: number;
    readonly effect: 'draft' | 'commit';
  };
  readonly maxRisk: OperationRisk;
  readonly autonomyPolicy: VersionedDefinitionRef;
  readonly consequenceTags: readonly string[];
  readonly surface: OperationSurface;
  readonly accessLane: OperationAccessLane;
  readonly auditTarget: VersionedDefinitionRef;
  readonly auditRecordProfile: VersionedDefinitionRef;
  readonly correlationId: CorrelationId;
  readonly recordedAt: Instant;
  readonly client: InvocationClientRef;
  readonly provenance: InvocationProvenance;
  readonly scope: OperationAuditScope;
  readonly scopeResolutionEvidenceIds: readonly string[];
  readonly resultSummary: OperationAuditResultSummary;
}

interface AuthorizedOperationAuditRecordBase extends OperationAuditRecordBase {
  readonly actor: ActorRef;
  readonly authorityPrincipalKey: string;
  readonly authorityEvidenceIds: readonly string[];
  readonly authorityCitationIds: readonly string[];
}

export interface TerminalNewOperationAuditRecord extends AuthorizedOperationAuditRecordBase {
  readonly disposition: 'terminal_new';
  readonly receiptId: string;
}

export interface TerminalReplayOperationAuditRecord extends AuthorizedOperationAuditRecordBase {
  readonly disposition: 'terminal_replay';
  readonly relatedReceiptId: string;
}

export interface IdempotencyConflictOperationAuditRecord extends AuthorizedOperationAuditRecordBase {
  readonly disposition: 'idempotency_conflict';
}

export type NonterminalProgressReason =
  | {
      readonly kind: 'autonomy_intervention';
      readonly autonomyDisposition: NonProceedAutonomyDisposition;
    }
  | { readonly kind: 'same_request_contended' }
  | {
      readonly kind: 'authority_recheck';
      readonly denialReason: CurrentAuthorityDenialReason;
    }
  | { readonly kind: 'phase_nonterminal' };

export interface NonterminalProgressOperationAuditRecord extends AuthorizedOperationAuditRecordBase {
  readonly disposition: 'nonterminal_progress';
  readonly reason: NonterminalProgressReason;
}

export interface ContextDeniedOperationAuditRecord extends OperationAuditRecordBase {
  readonly disposition: 'context_denied';
  readonly denialReason: CurrentAuthorityDenialReason;
}

export type ShortOperationAuditRecord =
  | TerminalReplayOperationAuditRecord
  | IdempotencyConflictOperationAuditRecord
  | NonterminalProgressOperationAuditRecord
  | ContextDeniedOperationAuditRecord;

export type OperationAuditRecord = TerminalNewOperationAuditRecord | ShortOperationAuditRecord;

export interface EffectUnitOfWork {
  findTerminalReceipt(identity: EffectOperationIdentity): ReturnTypeOrPromise<TerminalEffectReceipt | undefined>;
  /** Reloads exact current authority through the transaction-bound adapter view. */
  recheckCurrentAuthority(
    context: EffectInvocationContext
  ): ReturnTypeOrPromise<SealedEffectAuthorityRecheckResult>;
  openHandlerSnapshot(
    capability: VersionedDefinitionRef,
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): ReturnTypeOrPromise<EffectHandlerSnapshot>;
  applyDomainContribution(
    capability: VersionedDefinitionRef,
    contribution: unknown
  ): ReturnTypeOrPromise<void>;
  insertOperationLog?(record: DirectOperationLogRecord): ReturnTypeOrPromise<void>;
  applyEffectContribution?(operationLogId: string, contribution: unknown): ReturnTypeOrPromise<void>;
  finishEffectApplication?(identity: EffectOperationIdentity): ReturnTypeOrPromise<void>;
}

export interface EffectUnitOfWorkPort {
  findTerminalReceipt(identity: EffectOperationIdentity): ReturnTypeOrPromise<TerminalEffectReceipt | undefined>;
  /** @deprecated Nonterminal attempts are operational telemetry, not shared durable state. */
  recordShortOperationAudit(record: ShortOperationAuditRecord): ReturnTypeOrPromise<void>;
  runInUnitOfWork<Value>(work: (unitOfWork: EffectUnitOfWork) => Promise<Value>): Promise<Value>;
  /** Present only in runtimes that admit the direct-audited execution profile. */
  findTerminalOperationLog?(
    identity: EffectOperationIdentity
  ): ReturnTypeOrPromise<TerminalEffectReceipt | undefined>;
  /** Present only in runtimes that admit the direct-audited execution profile. */
  runInDirectUnitOfWork?<Value>(
    work: (unitOfWork: DirectAuditedUnitOfWork) => Promise<Value>
  ): Promise<Value>;
}

/**
 * One optional, versioned feature contribution produced from a successful direct
 * operation. The contributor is synchronous and capability-free: it can identify
 * affected stable subjects, but it cannot perform reads, writes, or external I/O.
 */
export interface DirectOperationFeatureContributor {
  readonly reference: VersionedDefinitionRef;
  contribute(input: Readonly<{
    operation: Readonly<{ readonly name: string; readonly version: number }>;
    businessInput: unknown;
    canonicalResult: unknown;
    scope: ResolvedScope;
    occurredAt: Instant;
    provenance?: InvocationProvenance;
    /** Trusted process-local feature material attached after invocation sealing. */
    featureContext?: unknown;
  }>): unknown | undefined;
}

/**
 * An authentic, process-composed registry of feature contributors. The registry has
 * no mutation API: registration is frozen before an executor can receive it.
 */
export interface DirectOperationFeatureContributorRegistry {
  readonly references: readonly VersionedDefinitionRef[];
}

export interface DirectOperationFeatureContribution {
  readonly contributor: VersionedDefinitionRef;
  readonly operationLogId: string;
  readonly value: unknown;
}

export interface DirectAuditedUnitOfWork {
  /** Reloads exact current authority through the transaction-bound adapter view. */
  recheckCurrentAuthority(
    context: EffectInvocationContext
  ): ReturnTypeOrPromise<SealedEffectAuthorityRecheckResult>;
  findTerminalOperationLog(
    identity: EffectOperationIdentity
  ): ReturnTypeOrPromise<TerminalEffectReceipt | undefined>;
  openHandlerSnapshot(
    capability: VersionedDefinitionRef,
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): ReturnTypeOrPromise<EffectHandlerSnapshot>;
  applyDomainContribution(
    capability: VersionedDefinitionRef,
    contribution: unknown
  ): ReturnTypeOrPromise<void>;
  insertOperationLog(record: DirectOperationLogRecord): ReturnTypeOrPromise<void>;
  /**
   * Feature-owned current-state discovery committed beside domain state and the
   * operation log. Absent unless this runtime has explicitly mounted a contributor.
   */
  applyFeatureContribution?(
    contribution: DirectOperationFeatureContribution
  ): ReturnTypeOrPromise<void>;
}

export interface EffectOperationExecutor {
  execute(invocation: SealedEffectInvocation): Promise<EffectfulOperationResult>;
}
