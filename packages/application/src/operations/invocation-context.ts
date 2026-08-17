import {
  structuredOutcomeSchema,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  CURRENT_AUTHORITY_GRANT_KINDS,
  CURRENT_AUTHORITY_DENIAL_REASONS,
  canonicalAuthorityPrincipalKeyFrame,
  parseOperationAccessLane,
  type AuthorityPrincipalRef,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type CurrentResolvedAuthority,
  type OperationAccessLane,
  type OperationAccessLaneKind,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  canonicalJsonText,
  encodeCanonicalJson,
  parseAgentRunId,
  parseAggregateVersion,
  parseAuthorityCitationId,
  parseCapabilityRevisionId,
  parseCeremonyEvidenceId,
  parseConsumerAttemptId,
  parseConsumerDeliveryId,
  parseContractVersion,
  parseCorrelationId,
  parseEventId,
  parseGrantRevisionId,
  parseInstant,
  parseIntegrationInboxReceiptId,
  parseInvocationId,
  parseJobId,
  parseMembershipId,
  parseModelAttemptId,
  parseModelToolCallId,
  parseParticipantIdentityId,
  parseParticipantSessionId,
  parsePersonId,
  parsePublicPolicyRevisionId,
  parseServiceIdentityId,
  parseSourceConnectionId,
  parseSourceConnectionRevisionId,
  parseUserId,
  parseVerifiedEnvelopeHandleId,
  parseVerifierRevisionId,
  parseWorkspaceId,
  type ActorRef,
  type AgentRunId,
  type CapabilityRevisionId,
  type CeremonyEvidenceId,
  type Clock,
  type ConsumerAttemptId,
  type ConsumerDeliveryId,
  type ContractVersion,
  type CorrelationId,
  type Instant,
  type IntegrationInboxReceiptId,
  type InvocationId,
  type JobId,
  type ModelAttemptId,
  type ModelToolCallId,
  type OperationSurface,
  type ParticipantSessionId,
  type PublicPolicyRevisionId,
  type ResolvedScope,
  type VerifiedEnvelopeHandleId
} from '@jooevents/kernel';
import type {
  EffectContextBuilderInput,
  EffectContextBuilderRegistration,
  EffectContextBuildResult,
  ReadContextBuilderInput,
  ReadContextBuilderRegistration,
  ReadContextBuildResult
} from './types';
import {
  bindPublicEffectConformanceBuilder,
  isPublicEffectConformanceActivation,
  type PublicEffectConformanceActivation
} from './public-effect-conformance-activation';

export interface InvocationClientRef {
  readonly key: string;
  readonly version?: string;
}

type EvidenceBase<Kind extends OperationAccessLaneKind, Surface extends OperationSurface> = {
  readonly kind: Kind;
  readonly surface: Surface;
  readonly client: InvocationClientRef;
};

export type InvocationEvidence =
  | (EvidenceBase<'operator', 'operator_http'> & {
      readonly sessionHandle: string;
    })
  | (EvidenceBase<'participant', 'participant_http'> & {
      readonly participantSessionId: ParticipantSessionId;
    })
  | (EvidenceBase<'public_open', 'public_http'> & {
      readonly publicPolicyRevisionId: PublicPolicyRevisionId;
    })
  | (EvidenceBase<'public_ceremony', 'public_http'> & {
      readonly ceremonyEvidenceId: CeremonyEvidenceId;
    })
  | (EvidenceBase<'external_mcp', 'external_mcp'> & {
      readonly credentialHandle: string;
      readonly clientKey: string;
    })
  | (EvidenceBase<'app_model', 'app_model'> & {
      readonly agentRunId: AgentRunId;
      readonly modelAttemptId: ModelAttemptId;
      readonly modelToolCallId: ModelToolCallId;
    })
  | (EvidenceBase<'registered_job', 'application_job'> & {
      readonly jobId: JobId;
    })
  | (EvidenceBase<'registered_consumer', 'application_job'> & {
      readonly consumerDeliveryId: ConsumerDeliveryId;
      readonly consumerAttemptId: ConsumerAttemptId;
    })
  | (EvidenceBase<'registered_scheduler', 'application_job'> & {
      readonly schedulerKey: string;
      readonly schedulerVersion: ContractVersion;
      readonly capabilityRevisionId: CapabilityRevisionId;
    })
  | (EvidenceBase<'verified_intake', 'provider_ingress'> & {
      readonly verifiedEnvelopeHandleId: VerifiedEnvelopeHandleId;
    })
  | (EvidenceBase<'verified_inbox', 'provider_ingress'> & {
      readonly inboxReceiptId: IntegrationInboxReceiptId;
    });

/**
 * Credential-free evidence made available to scope resolution. Scope is derived
 * from schema-parsed business targets or an already-verified durable work anchor;
 * it never receives session/token handles, transport client metadata, or another
 * authority credential.
 */
export type ScopeResolutionEvidence =
  | { readonly kind: 'operator'; readonly surface: 'operator_http' }
  | { readonly kind: 'participant'; readonly surface: 'participant_http' }
  | {
      readonly kind: 'public_open';
      readonly surface: 'public_http';
      readonly publicPolicyRevisionId: PublicPolicyRevisionId;
    }
  | {
      readonly kind: 'public_ceremony';
      readonly surface: 'public_http';
      readonly ceremonyEvidenceId: CeremonyEvidenceId;
    }
  | { readonly kind: 'external_mcp'; readonly surface: 'external_mcp' }
  | {
      readonly kind: 'app_model';
      readonly surface: 'app_model';
      readonly agentRunId: AgentRunId;
      readonly modelAttemptId: ModelAttemptId;
      readonly modelToolCallId: ModelToolCallId;
    }
  | {
      readonly kind: 'registered_job';
      readonly surface: 'application_job';
      readonly jobId: JobId;
    }
  | {
      readonly kind: 'registered_consumer';
      readonly surface: 'application_job';
      readonly consumerDeliveryId: ConsumerDeliveryId;
      readonly consumerAttemptId: ConsumerAttemptId;
    }
  | {
      readonly kind: 'registered_scheduler';
      readonly surface: 'application_job';
      readonly schedulerKey: string;
      readonly schedulerVersion: ContractVersion;
      readonly capabilityRevisionId: CapabilityRevisionId;
    }
  | {
      readonly kind: 'verified_intake';
      readonly surface: 'provider_ingress';
      readonly verifiedEnvelopeHandleId: VerifiedEnvelopeHandleId;
    }
  | {
      readonly kind: 'verified_inbox';
      readonly surface: 'provider_ingress';
      readonly inboxReceiptId: IntegrationInboxReceiptId;
    };

export const INVOCATION_CONTEXT_ERROR_CODES = [
  'caller_security_claim',
  'invalid_evidence',
  'lane_substitution',
  'public_mutation_disabled',
  'app_model_commit_forbidden',
  'invalid_scope',
  'invalid_authority',
  'invalid_request_binding'
] as const;

export type InvocationContextErrorCode = (typeof INVOCATION_CONTEXT_ERROR_CODES)[number];

export class InvocationContextError extends Error {
  readonly code: InvocationContextErrorCode;

  constructor(code: InvocationContextErrorCode) {
    super(`Trusted invocation construction failed: ${code}.`);
    this.name = 'InvocationContextError';
    this.code = code;
  }
}

export interface InvocationRequestBinding {
  readonly canonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSha256: string;
  /** Present for effects: the exact server-keyed request-binding profile. */
  readonly requestHashProfile?: VersionedDefinitionRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly scopePartitionKey: string;
  readonly idempotency?: {
    readonly verifierProfile: VersionedKeyProfileRef;
    readonly verifierSha256: string;
  };
}

export type InvocationProvenance =
  | { readonly kind: 'operator' }
  | { readonly kind: 'participant'; readonly participantSessionId: ParticipantSessionId }
  | { readonly kind: 'public_open'; readonly publicPolicyRevisionId: PublicPolicyRevisionId }
  | { readonly kind: 'public_ceremony'; readonly ceremonyEvidenceId: CeremonyEvidenceId }
  | { readonly kind: 'external_mcp'; readonly clientKey: string }
  | { readonly kind: 'app_model'; readonly agentRunId: AgentRunId; readonly modelAttemptId: ModelAttemptId; readonly modelToolCallId: ModelToolCallId }
  | { readonly kind: 'registered_job'; readonly jobId: JobId }
  | { readonly kind: 'registered_consumer'; readonly consumerDeliveryId: ConsumerDeliveryId; readonly consumerAttemptId: ConsumerAttemptId }
  | { readonly kind: 'registered_scheduler'; readonly schedulerKey: string; readonly schedulerVersion: ContractVersion; readonly capabilityRevisionId: CapabilityRevisionId }
  | { readonly kind: 'verified_intake'; readonly verifiedEnvelopeHandleId: VerifiedEnvelopeHandleId }
  | { readonly kind: 'verified_inbox'; readonly inboxReceiptId: IntegrationInboxReceiptId };

declare const invocationContextBrand: unique symbol;
declare const deniedEffectAuditAttemptBrand: unique symbol;
declare const deniedReadObservationAttemptBrand: unique symbol;

/** Opaque outside this module; runtime authenticity is held in a private WeakSet. */
export interface InvocationContext extends Readonly<Record<string, unknown>> {
  readonly invocationId: InvocationId;
  readonly correlationId: CorrelationId;
  readonly operation: {
    readonly name: string;
    readonly version: number;
    readonly effect: 'read' | 'draft' | 'commit';
  };
  readonly surface: OperationSurface;
  readonly client: InvocationClientRef;
  readonly provenance: InvocationProvenance;
  readonly actor: ActorRef;
  readonly authority: CurrentResolvedAuthority;
  readonly authorityPrincipalKey: string;
  readonly scope: ResolvedScope;
  readonly receivedAt: Instant;
  readonly requestBinding: InvocationRequestBinding;
  readonly [invocationContextBrand]: true;
}

/**
 * The only context-denial material exposed to the executor. It is intentionally
 * narrower than verified evidence and is authenticated by this module at runtime.
 */
export interface DeniedEffectAuditAttempt extends Readonly<Record<string, unknown>> {
  readonly invocationId: InvocationId;
  readonly correlationId: CorrelationId;
  readonly operation: {
    readonly name: string;
    readonly version: number;
    readonly effect: 'draft' | 'commit';
  };
  readonly surface: OperationSurface;
  readonly accessLane: OperationAccessLane;
  readonly client: InvocationClientRef;
  readonly provenance: InvocationProvenance;
  readonly scope: {
    readonly workspaceId: ResolvedScope['workspaceId'];
    readonly eventId?: ResolvedScope['eventId'];
    readonly subjects: ResolvedScope['subjects'];
  };
  readonly scopeResolutionEvidenceIds: readonly string[];
  readonly receivedAt: Instant;
  readonly denialReason: CurrentAuthorityDenialReason;
  readonly [deniedEffectAuditAttemptBrand]: true;
}

/**
 * Safe authority-denial material for read trace/audit construction. The verified
 * evidence itself and every request binding/hash remain sealed inside the builder.
 */
export interface DeniedReadObservationAttempt extends Readonly<Record<string, unknown>> {
  readonly invocationId: InvocationId;
  readonly correlationId: CorrelationId;
  readonly operation: {
    readonly name: string;
    readonly version: number;
    readonly effect: 'read';
  };
  readonly surface: OperationSurface;
  readonly accessLane: OperationAccessLane;
  readonly client: InvocationClientRef;
  readonly provenance: InvocationProvenance;
  readonly scope: {
    readonly workspaceId: ResolvedScope['workspaceId'];
    readonly eventId?: ResolvedScope['eventId'];
    readonly subjects: ResolvedScope['subjects'];
  };
  readonly scopeResolutionEvidenceIds: readonly string[];
  readonly receivedAt: Instant;
  readonly denialReason: CurrentAuthorityDenialReason;
  readonly [deniedReadObservationAttemptBrand]: true;
}

const sealedInvocationContexts = new WeakSet<object>();
const sealedDeniedReadObservationAttempts = new WeakSet<object>();
const sealedDeniedEffectAuditAttempts = new WeakSet<object>();
const sealedDeniedEffectAuditOutcomes = new WeakMap<object, StructuredOutcome>();
interface EffectAuthorityRecheckDirective {
  readonly operation: {
    readonly name: string;
    readonly version: number;
    readonly effect: 'draft' | 'commit';
  };
  readonly evidence: InvocationEvidence;
  readonly lane: OperationAccessLane;
  readonly scope: ResolvedScope;
  readonly initialAuthority: CurrentResolvedAuthority;
  readonly resolveAuthority: CurrentAuthorityResolver<InvocationEvidence>['resolve'];
  readonly now: Clock['now'];
  readonly deniedAuthorityOutcome: (reason: CurrentAuthorityDenialReason) => StructuredOutcome;
}
const effectAuthorityRechecks = new WeakMap<object, EffectAuthorityRecheckDirective>();
interface InternalEffectAuthorityRecheckResult {
  readonly context: InvocationContext;
  readonly evaluatedAt: Instant;
  readonly authority: CurrentResolvedAuthority;
  readonly result:
    | { readonly kind: 'authorized' }
    | {
        readonly kind: 'denied';
        readonly reason: CurrentAuthorityDenialReason;
        readonly outcome: StructuredOutcome;
      };
}
const sealedEffectAuthorityRecheckResults = new WeakMap<object, InternalEffectAuthorityRecheckResult>();
const sha256Pattern = /^[a-f0-9]{64}$/;
const stableKeyPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const reservedBusinessInputKeys = new Set([
  'actor',
  'scope',
  'approval',
  'renewedApproval',
  'approverCurrentlyAuthorized',
  'consequentialApprovalSatisfied'
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const actual = Object.keys(value).sort();
  const permitted = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && actual.every((key) => permitted.has(key));
}

function nonEmptyBoundedString(value: unknown, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new TypeError('expected a bounded non-empty string');
  }
  return value;
}

function parseClient(value: unknown): InvocationClientRef {
  if (!isPlainRecord(value) || !exactKeys(value, ['key'], ['version'])) {
    throw new TypeError('invalid invocation client');
  }
  if (typeof value.key !== 'string' || !stableKeyPattern.test(value.key)) {
    throw new TypeError('invalid invocation client');
  }
  if (value.version !== undefined && (typeof value.version !== 'string' || value.version.length > 80)) {
    throw new TypeError('invalid invocation client');
  }
  return Object.freeze({
    key: value.key,
    ...(value.version === undefined ? {} : { version: value.version })
  });
}

/** Rejects actor, scope, and every structural approval claim before schema parsing. */
export function assertNoCallerSecurityClaims(value: unknown): void {
  if (!isPlainRecord(value)) return;
  if (Object.keys(value).some((key) => reservedBusinessInputKeys.has(key))) {
    throw new InvocationContextError('caller_security_claim');
  }
}

export function parseInvocationEvidence(value: unknown): InvocationEvidence {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') {
    throw new InvocationContextError('invalid_evidence');
  }
  try {
    switch (value.kind) {
      case 'operator':
        if (!exactKeys(value, ['kind', 'surface', 'client', 'sessionHandle']) || value.surface !== 'operator_http') throw new TypeError();
        return Object.freeze({ kind: 'operator', surface: 'operator_http', client: parseClient(value.client), sessionHandle: nonEmptyBoundedString(value.sessionHandle) });
      case 'participant':
        if (!exactKeys(value, ['kind', 'surface', 'client', 'participantSessionId']) || value.surface !== 'participant_http') throw new TypeError();
        return Object.freeze({ kind: 'participant', surface: 'participant_http', client: parseClient(value.client), participantSessionId: parseParticipantSessionId(value.participantSessionId) });
      case 'public_open':
        if (!exactKeys(value, ['kind', 'surface', 'client', 'publicPolicyRevisionId']) || value.surface !== 'public_http') throw new TypeError();
        return Object.freeze({ kind: 'public_open', surface: 'public_http', client: parseClient(value.client), publicPolicyRevisionId: parsePublicPolicyRevisionId(value.publicPolicyRevisionId) });
      case 'public_ceremony':
        if (!exactKeys(value, ['kind', 'surface', 'client', 'ceremonyEvidenceId']) || value.surface !== 'public_http') throw new TypeError();
        return Object.freeze({ kind: 'public_ceremony', surface: 'public_http', client: parseClient(value.client), ceremonyEvidenceId: parseCeremonyEvidenceId(value.ceremonyEvidenceId) });
      case 'external_mcp':
        if (!exactKeys(value, ['kind', 'surface', 'client', 'credentialHandle', 'clientKey']) || value.surface !== 'external_mcp') throw new TypeError();
        return Object.freeze({ kind: 'external_mcp', surface: 'external_mcp', client: parseClient(value.client), credentialHandle: nonEmptyBoundedString(value.credentialHandle), clientKey: nonEmptyBoundedString(value.clientKey, 256) });
      case 'app_model':
        if (!exactKeys(value, ['kind', 'surface', 'client', 'agentRunId', 'modelAttemptId', 'modelToolCallId']) || value.surface !== 'app_model') throw new TypeError();
        return Object.freeze({ kind: 'app_model', surface: 'app_model', client: parseClient(value.client), agentRunId: parseAgentRunId(value.agentRunId), modelAttemptId: parseModelAttemptId(value.modelAttemptId), modelToolCallId: parseModelToolCallId(value.modelToolCallId) });
      case 'registered_job':
        if (!exactKeys(value, ['kind', 'surface', 'client', 'jobId']) || value.surface !== 'application_job') throw new TypeError();
        return Object.freeze({ kind: 'registered_job', surface: 'application_job', client: parseClient(value.client), jobId: parseJobId(value.jobId) });
      case 'registered_consumer':
        if (!exactKeys(value, ['kind', 'surface', 'client', 'consumerDeliveryId', 'consumerAttemptId']) || value.surface !== 'application_job') throw new TypeError();
        return Object.freeze({ kind: 'registered_consumer', surface: 'application_job', client: parseClient(value.client), consumerDeliveryId: parseConsumerDeliveryId(value.consumerDeliveryId), consumerAttemptId: parseConsumerAttemptId(value.consumerAttemptId) });
      case 'registered_scheduler':
        if (!exactKeys(value, ['kind', 'surface', 'client', 'schedulerKey', 'schedulerVersion', 'capabilityRevisionId']) || value.surface !== 'application_job') throw new TypeError();
        return Object.freeze({ kind: 'registered_scheduler', surface: 'application_job', client: parseClient(value.client), schedulerKey: nonEmptyBoundedString(value.schedulerKey, 160), schedulerVersion: parseContractVersion(value.schedulerVersion), capabilityRevisionId: parseCapabilityRevisionId(value.capabilityRevisionId) });
      case 'verified_intake':
        if (!exactKeys(value, ['kind', 'surface', 'client', 'verifiedEnvelopeHandleId']) || value.surface !== 'provider_ingress') throw new TypeError();
        return Object.freeze({ kind: 'verified_intake', surface: 'provider_ingress', client: parseClient(value.client), verifiedEnvelopeHandleId: parseVerifiedEnvelopeHandleId(value.verifiedEnvelopeHandleId) });
      case 'verified_inbox':
        if (!exactKeys(value, ['kind', 'surface', 'client', 'inboxReceiptId']) || value.surface !== 'provider_ingress') throw new TypeError();
        return Object.freeze({ kind: 'verified_inbox', surface: 'provider_ingress', client: parseClient(value.client), inboxReceiptId: parseIntegrationInboxReceiptId(value.inboxReceiptId) });
      default:
        throw new TypeError();
    }
  } catch {
    throw new InvocationContextError('invalid_evidence');
  }
}

function normalizeScope(value: unknown): ResolvedScope {
  if (!isPlainRecord(value) || !exactKeys(value, ['workspaceId', 'subjects', 'resolutionEvidenceIds'], ['eventId'])) {
    throw new InvocationContextError('invalid_scope');
  }
  try {
    const workspaceId = parseWorkspaceId(value.workspaceId);
    const eventId = value.eventId === undefined ? undefined : parseEventId(value.eventId);
    if (!Array.isArray(value.subjects) || !Array.isArray(value.resolutionEvidenceIds)) throw new TypeError();
    const subjects = value.subjects.map((subject) => {
      if (!isPlainRecord(subject) || typeof subject.kind !== 'string') throw new TypeError();
      switch (subject.kind) {
        case 'workspace': {
          if (!exactKeys(subject, ['kind', 'id'])) throw new TypeError();
          const id = parseWorkspaceId(subject.id);
          if (id !== workspaceId) throw new TypeError();
          return Object.freeze({ kind: 'workspace' as const, id });
        }
        case 'event': {
          if (!exactKeys(subject, ['kind', 'id'])) throw new TypeError();
          const id = parseEventId(subject.id);
          if (eventId === undefined || id !== eventId) throw new TypeError();
          return Object.freeze({ kind: 'event' as const, id });
        }
        case 'workspace_user':
          if (!exactKeys(subject, ['kind', 'id'])) throw new TypeError();
          return Object.freeze({ kind: 'workspace_user' as const, id: parseUserId(subject.id) });
        case 'participant_person':
          if (!exactKeys(subject, ['kind', 'id'])) throw new TypeError();
          return Object.freeze({ kind: 'participant_person' as const, id: parsePersonId(subject.id) });
        case 'domain':
          if (!exactKeys(subject, ['kind', 'domain', 'entity', 'id'], ['version'])) throw new TypeError();
          return Object.freeze({
            kind: 'domain' as const,
            domain: nonEmptyBoundedString(subject.domain, 160),
            entity: nonEmptyBoundedString(subject.entity, 160),
            id: nonEmptyBoundedString(subject.id, 256),
            ...(subject.version === undefined ? {} : { version: parseAggregateVersion(subject.version) })
          });
        default:
          throw new TypeError();
      }
    });
    subjects.sort((left, right) => canonicalJsonText(left).localeCompare(canonicalJsonText(right)));
    if (new Set(subjects.map(canonicalJsonText)).size !== subjects.length) throw new TypeError();
    const resolutionEvidenceIds = value.resolutionEvidenceIds
      .map((id) => nonEmptyBoundedString(id, 256))
      .sort();
    if (new Set(resolutionEvidenceIds).size !== resolutionEvidenceIds.length) throw new TypeError();
    return Object.freeze({
      workspaceId,
      ...(eventId === undefined ? {} : { eventId }),
      subjects: Object.freeze(subjects),
      resolutionEvidenceIds: Object.freeze(resolutionEvidenceIds)
    });
  } catch (error) {
    if (error instanceof InvocationContextError) throw error;
    throw new InvocationContextError('invalid_scope');
  }
}

function normalizeActor(value: unknown): ActorRef {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') throw new InvocationContextError('invalid_authority');
  try {
    switch (value.kind) {
      case 'workspace_user':
        if (!exactKeys(value, ['kind', 'userId'])) throw new TypeError();
        return Object.freeze({ kind: 'workspace_user', userId: parseUserId(value.userId) });
      case 'participant':
        if (!exactKeys(value, ['kind', 'participantIdentityId', 'personId'])) throw new TypeError();
        return Object.freeze({ kind: 'participant', participantIdentityId: parseParticipantIdentityId(value.participantIdentityId), personId: parsePersonId(value.personId) });
      case 'service':
        if (!exactKeys(value, ['kind', 'serviceIdentityId'])) throw new TypeError();
        return Object.freeze({ kind: 'service', serviceIdentityId: parseServiceIdentityId(value.serviceIdentityId) });
      case 'external_mcp_client':
        if (!exactKeys(value, ['kind', 'clientKey', 'authorityPrincipalId'])) throw new TypeError();
        return Object.freeze({ kind: 'external_mcp_client', clientKey: nonEmptyBoundedString(value.clientKey, 256), authorityPrincipalId: nonEmptyBoundedString(value.authorityPrincipalId, 256) });
      case 'app_model_run':
        if (!exactKeys(value, ['kind', 'agentRunId', 'delegatedByPrincipalId'])) throw new TypeError();
        return Object.freeze({ kind: 'app_model_run', agentRunId: parseAgentRunId(value.agentRunId), delegatedByPrincipalId: nonEmptyBoundedString(value.delegatedByPrincipalId, 256) });
      case 'system_job':
        if (!exactKeys(value, ['kind', 'jobId', 'registeredCapabilityRevisionId'])) throw new TypeError();
        return Object.freeze({ kind: 'system_job', jobId: parseJobId(value.jobId), registeredCapabilityRevisionId: parseCapabilityRevisionId(value.registeredCapabilityRevisionId) });
      case 'system_consumer_delivery':
        if (!exactKeys(value, ['kind', 'consumerDeliveryId', 'consumerAttemptId', 'consumerKey', 'consumerVersion'])) throw new TypeError();
        return Object.freeze({ kind: 'system_consumer_delivery', consumerDeliveryId: parseConsumerDeliveryId(value.consumerDeliveryId), consumerAttemptId: parseConsumerAttemptId(value.consumerAttemptId), consumerKey: nonEmptyBoundedString(value.consumerKey, 160), consumerVersion: parseContractVersion(value.consumerVersion) });
      case 'system_scheduler':
        if (!exactKeys(value, ['kind', 'schedulerKey', 'schedulerVersion', 'registeredCapabilityRevisionId'])) throw new TypeError();
        return Object.freeze({ kind: 'system_scheduler', schedulerKey: nonEmptyBoundedString(value.schedulerKey, 160), schedulerVersion: parseContractVersion(value.schedulerVersion), registeredCapabilityRevisionId: parseCapabilityRevisionId(value.registeredCapabilityRevisionId) });
      case 'verified_ingress_intake':
        if (!exactKeys(value, ['kind', 'verifiedEnvelopeHandleId', 'sourceConnectionId', 'sourceConnectionRevisionId', 'verifierContractKey', 'verifierContractVersion', 'verifierRevisionId'])) throw new TypeError();
        return Object.freeze({ kind: 'verified_ingress_intake', verifiedEnvelopeHandleId: parseVerifiedEnvelopeHandleId(value.verifiedEnvelopeHandleId), sourceConnectionId: parseSourceConnectionId(value.sourceConnectionId), sourceConnectionRevisionId: parseSourceConnectionRevisionId(value.sourceConnectionRevisionId), verifierContractKey: nonEmptyBoundedString(value.verifierContractKey, 160), verifierContractVersion: parseContractVersion(value.verifierContractVersion), verifierRevisionId: parseVerifierRevisionId(value.verifierRevisionId) });
      case 'verified_inbox_processing':
        if (!exactKeys(value, ['kind', 'inboxReceiptId', 'sourceConnectionId'])) throw new TypeError();
        return Object.freeze({ kind: 'verified_inbox_processing', inboxReceiptId: parseIntegrationInboxReceiptId(value.inboxReceiptId), sourceConnectionId: parseSourceConnectionId(value.sourceConnectionId) });
      case 'public_request': {
        if (!exactKeys(value, ['kind', 'publicPolicyRevisionId', 'authority']) || !isPlainRecord(value.authority) || typeof value.authority.kind !== 'string') throw new TypeError();
        const authority = value.authority.kind === 'open_policy' && exactKeys(value.authority, ['kind'])
          ? Object.freeze({ kind: 'open_policy' as const })
          : value.authority.kind === 'mutation_ceremony' && exactKeys(value.authority, ['kind', 'ceremonyEvidenceId'])
            ? Object.freeze({ kind: 'mutation_ceremony' as const, ceremonyEvidenceId: parseCeremonyEvidenceId(value.authority.ceremonyEvidenceId) })
            : undefined;
        if (!authority) throw new TypeError();
        return Object.freeze({ kind: 'public_request', publicPolicyRevisionId: parsePublicPolicyRevisionId(value.publicPolicyRevisionId), authority });
      }
      default:
        throw new TypeError();
    }
  } catch {
    throw new InvocationContextError('invalid_authority');
  }
}

function normalizePrincipal(value: unknown): AuthorityPrincipalRef {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') throw new InvocationContextError('invalid_authority');
  try {
    switch (value.kind) {
      case 'workspace_user':
        if (!exactKeys(value, ['kind', 'userId', 'membershipId'])) throw new TypeError();
        return Object.freeze({ kind: 'workspace_user', userId: parseUserId(value.userId), membershipId: parseMembershipId(value.membershipId) });
      case 'participant':
        if (!exactKeys(value, ['kind', 'participantIdentityId', 'personId', 'participantSessionId'])) throw new TypeError();
        return Object.freeze({ kind: 'participant', participantIdentityId: parseParticipantIdentityId(value.participantIdentityId), personId: parsePersonId(value.personId), participantSessionId: parseParticipantSessionId(value.participantSessionId) });
      case 'service':
        if (!exactKeys(value, ['kind', 'serviceIdentityId', 'grantKey', 'grantRevisionId'])) throw new TypeError();
        return Object.freeze({ kind: 'service', serviceIdentityId: parseServiceIdentityId(value.serviceIdentityId), grantKey: nonEmptyBoundedString(value.grantKey, 160), grantRevisionId: parseGrantRevisionId(value.grantRevisionId) });
      case 'public_capability': {
        if (!exactKeys(value, ['kind', 'publicPolicyRevisionId', 'authority']) || !isPlainRecord(value.authority) || typeof value.authority.kind !== 'string') throw new TypeError();
        const authority = value.authority.kind === 'open_policy' && exactKeys(value.authority, ['kind'])
          ? Object.freeze({ kind: 'open_policy' as const })
          : value.authority.kind === 'mutation_ceremony' && exactKeys(value.authority, ['kind', 'ceremonyEvidenceId'])
            ? Object.freeze({ kind: 'mutation_ceremony' as const, ceremonyEvidenceId: parseCeremonyEvidenceId(value.authority.ceremonyEvidenceId) })
            : undefined;
        if (!authority) throw new TypeError();
        return Object.freeze({ kind: 'public_capability', publicPolicyRevisionId: parsePublicPolicyRevisionId(value.publicPolicyRevisionId), authority });
      }
      case 'registered_job':
        if (!exactKeys(value, ['kind', 'jobId', 'capabilityRevisionId', 'authorityCitationId'])) throw new TypeError();
        return Object.freeze({ kind: 'registered_job', jobId: parseJobId(value.jobId), capabilityRevisionId: parseCapabilityRevisionId(value.capabilityRevisionId), authorityCitationId: parseAuthorityCitationId(value.authorityCitationId) });
      case 'registered_consumer_delivery':
        if (!exactKeys(value, ['kind', 'consumerDeliveryId', 'consumerAttemptId', 'consumerKey', 'consumerVersion', 'capabilityRevisionId', 'authorityCitationId'])) throw new TypeError();
        return Object.freeze({ kind: 'registered_consumer_delivery', consumerDeliveryId: parseConsumerDeliveryId(value.consumerDeliveryId), consumerAttemptId: parseConsumerAttemptId(value.consumerAttemptId), consumerKey: nonEmptyBoundedString(value.consumerKey, 160), consumerVersion: parseContractVersion(value.consumerVersion), capabilityRevisionId: parseCapabilityRevisionId(value.capabilityRevisionId), authorityCitationId: parseAuthorityCitationId(value.authorityCitationId) });
      case 'registered_scheduler':
        if (!exactKeys(value, ['kind', 'schedulerKey', 'schedulerVersion', 'capabilityRevisionId', 'authorityCitationId'])) throw new TypeError();
        return Object.freeze({ kind: 'registered_scheduler', schedulerKey: nonEmptyBoundedString(value.schedulerKey, 160), schedulerVersion: parseContractVersion(value.schedulerVersion), capabilityRevisionId: parseCapabilityRevisionId(value.capabilityRevisionId), authorityCitationId: parseAuthorityCitationId(value.authorityCitationId) });
      case 'verified_ingress_intake':
        if (!exactKeys(value, ['kind', 'verifiedEnvelopeHandleId', 'sourceConnectionId', 'sourceConnectionRevisionId', 'verifierContractKey', 'verifierContractVersion', 'verifierRevisionId'])) throw new TypeError();
        return Object.freeze({ kind: 'verified_ingress_intake', verifiedEnvelopeHandleId: parseVerifiedEnvelopeHandleId(value.verifiedEnvelopeHandleId), sourceConnectionId: parseSourceConnectionId(value.sourceConnectionId), sourceConnectionRevisionId: parseSourceConnectionRevisionId(value.sourceConnectionRevisionId), verifierContractKey: nonEmptyBoundedString(value.verifierContractKey, 160), verifierContractVersion: parseContractVersion(value.verifierContractVersion), verifierRevisionId: parseVerifierRevisionId(value.verifierRevisionId) });
      case 'verified_inbox_processing':
        if (!exactKeys(value, ['kind', 'inboxReceiptId', 'verifierRevisionId'])) throw new TypeError();
        return Object.freeze({ kind: 'verified_inbox_processing', inboxReceiptId: parseIntegrationInboxReceiptId(value.inboxReceiptId), verifierRevisionId: parseVerifierRevisionId(value.verifierRevisionId) });
      default:
        throw new TypeError();
    }
  } catch {
    throw new InvocationContextError('invalid_authority');
  }
}

function sameLane(left: OperationAccessLane, right: OperationAccessLane): boolean {
  return left.kind === right.kind
    && left.surface === right.surface
    && left.policy.key === right.policy.key
    && left.policy.version === right.policy.version;
}

function normalizeCurrentAuthority(value: unknown): CurrentResolvedAuthority {
  if (!isPlainRecord(value) || !exactKeys(value, ['actor', 'principal', 'lane', 'scope', 'grants', 'evidenceIds', 'authorityCitationIds', 'evaluatedAt'])) {
    throw new InvocationContextError('invalid_authority');
  }
  try {
    if (!Array.isArray(value.grants) || !Array.isArray(value.evidenceIds) || !Array.isArray(value.authorityCitationIds)) throw new TypeError();
    const parsedGrants = value.grants.map((grant) => {
      if (!isPlainRecord(grant) || !exactKeys(grant, ['kind', 'key']) || typeof grant.kind !== 'string' || !CURRENT_AUTHORITY_GRANT_KINDS.includes(grant.kind as never)) throw new TypeError();
      return Object.freeze({ kind: grant.kind, key: nonEmptyBoundedString(grant.key, 256) });
    });
    const grants = [...new Map(
      parsedGrants.map((grant) => [`${grant.kind}\u0000${grant.key}`, grant] as const)
    ).values()].sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key)
    );
    const evidenceIds = [...new Set(
      value.evidenceIds.map((id) => nonEmptyBoundedString(id, 256))
    )].sort();
    const authorityCitationIds = [...new Set(
      value.authorityCitationIds.map(parseAuthorityCitationId)
    )].sort();
    return Object.freeze({
      actor: normalizeActor(value.actor),
      principal: normalizePrincipal(value.principal),
      lane: parseOperationAccessLane(value.lane),
      scope: normalizeScope(value.scope),
      grants: Object.freeze(grants),
      evidenceIds: Object.freeze(evidenceIds),
      authorityCitationIds: Object.freeze(authorityCitationIds),
      evaluatedAt: parseInstant(value.evaluatedAt)
    }) as CurrentResolvedAuthority;
  } catch (error) {
    if (error instanceof InvocationContextError) throw error;
    throw new InvocationContextError('invalid_authority');
  }
}

function authorityMatchesEvidence(authority: CurrentResolvedAuthority, evidence: InvocationEvidence): boolean {
  const actor = authority.actor;
  const principal = authority.principal;
  switch (evidence.kind) {
    case 'operator':
      return actor.kind === 'workspace_user' && principal.kind === 'workspace_user' && actor.userId === principal.userId;
    case 'participant':
      return actor.kind === 'participant' && principal.kind === 'participant'
        && principal.participantSessionId === evidence.participantSessionId
        && actor.participantIdentityId === principal.participantIdentityId
        && actor.personId === principal.personId;
    case 'public_open':
      return actor.kind === 'public_request' && principal.kind === 'public_capability'
        && actor.authority.kind === 'open_policy'
        && principal.authority.kind === 'open_policy'
        && actor.publicPolicyRevisionId === evidence.publicPolicyRevisionId
        && principal.publicPolicyRevisionId === evidence.publicPolicyRevisionId;
    case 'public_ceremony':
      return actor.kind === 'public_request' && principal.kind === 'public_capability'
        && actor.authority.kind === 'mutation_ceremony'
        && principal.authority.kind === 'mutation_ceremony'
        && actor.authority.ceremonyEvidenceId === evidence.ceremonyEvidenceId
        && principal.authority.ceremonyEvidenceId === evidence.ceremonyEvidenceId
        && actor.publicPolicyRevisionId === principal.publicPolicyRevisionId;
    case 'external_mcp':
      return actor.kind === 'external_mcp_client' && actor.clientKey === evidence.clientKey
        && (principal.kind === 'workspace_user' || principal.kind === 'service');
    case 'app_model':
      return actor.kind === 'app_model_run' && actor.agentRunId === evidence.agentRunId
        && (principal.kind === 'workspace_user' || principal.kind === 'service');
    case 'registered_job':
      return actor.kind === 'system_job' && principal.kind === 'registered_job'
        && actor.jobId === evidence.jobId && principal.jobId === evidence.jobId
        && actor.registeredCapabilityRevisionId === principal.capabilityRevisionId;
    case 'registered_consumer':
      return actor.kind === 'system_consumer_delivery' && principal.kind === 'registered_consumer_delivery'
        && actor.consumerDeliveryId === evidence.consumerDeliveryId
        && actor.consumerAttemptId === evidence.consumerAttemptId
        && principal.consumerDeliveryId === evidence.consumerDeliveryId
        && principal.consumerAttemptId === evidence.consumerAttemptId
        && actor.consumerKey === principal.consumerKey
        && actor.consumerVersion === principal.consumerVersion;
    case 'registered_scheduler':
      return actor.kind === 'system_scheduler' && principal.kind === 'registered_scheduler'
        && actor.schedulerKey === evidence.schedulerKey && principal.schedulerKey === evidence.schedulerKey
        && actor.schedulerVersion === evidence.schedulerVersion && principal.schedulerVersion === evidence.schedulerVersion
        && actor.registeredCapabilityRevisionId === evidence.capabilityRevisionId
        && principal.capabilityRevisionId === evidence.capabilityRevisionId;
    case 'verified_intake':
      return actor.kind === 'verified_ingress_intake' && principal.kind === 'verified_ingress_intake'
        && actor.verifiedEnvelopeHandleId === evidence.verifiedEnvelopeHandleId
        && principal.verifiedEnvelopeHandleId === evidence.verifiedEnvelopeHandleId
        && actor.sourceConnectionId === principal.sourceConnectionId
        && actor.sourceConnectionRevisionId === principal.sourceConnectionRevisionId
        && actor.verifierContractKey === principal.verifierContractKey
        && actor.verifierContractVersion === principal.verifierContractVersion
        && actor.verifierRevisionId === principal.verifierRevisionId;
    case 'verified_inbox':
      return actor.kind === 'verified_inbox_processing' && principal.kind === 'verified_inbox_processing'
        && actor.inboxReceiptId === evidence.inboxReceiptId
        && principal.inboxReceiptId === evidence.inboxReceiptId;
  }
}

function authorityCitationsMatch(authority: CurrentResolvedAuthority): boolean {
  const principal = authority.principal;
  switch (principal.kind) {
    case 'registered_job':
    case 'registered_consumer_delivery':
    case 'registered_scheduler':
      return authority.authorityCitationIds.includes(principal.authorityCitationId);
    default:
      return true;
  }
}

function provenanceForEvidence(evidence: InvocationEvidence): InvocationProvenance {
  switch (evidence.kind) {
    case 'operator':
      return Object.freeze({ kind: 'operator' });
    case 'participant':
      return Object.freeze({ kind: 'participant', participantSessionId: evidence.participantSessionId });
    case 'public_open':
      return Object.freeze({ kind: 'public_open', publicPolicyRevisionId: evidence.publicPolicyRevisionId });
    case 'public_ceremony':
      return Object.freeze({ kind: 'public_ceremony', ceremonyEvidenceId: evidence.ceremonyEvidenceId });
    case 'external_mcp':
      return Object.freeze({ kind: 'external_mcp', clientKey: evidence.clientKey });
    case 'app_model':
      return Object.freeze({ kind: 'app_model', agentRunId: evidence.agentRunId, modelAttemptId: evidence.modelAttemptId, modelToolCallId: evidence.modelToolCallId });
    case 'registered_job':
      return Object.freeze({ kind: 'registered_job', jobId: evidence.jobId });
    case 'registered_consumer':
      return Object.freeze({ kind: 'registered_consumer', consumerDeliveryId: evidence.consumerDeliveryId, consumerAttemptId: evidence.consumerAttemptId });
    case 'registered_scheduler':
      return Object.freeze({ kind: 'registered_scheduler', schedulerKey: evidence.schedulerKey, schedulerVersion: evidence.schedulerVersion, capabilityRevisionId: evidence.capabilityRevisionId });
    case 'verified_intake':
      return Object.freeze({ kind: 'verified_intake', verifiedEnvelopeHandleId: evidence.verifiedEnvelopeHandleId });
    case 'verified_inbox':
      return Object.freeze({ kind: 'verified_inbox', inboxReceiptId: evidence.inboxReceiptId });
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(value).buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function profileValue(profile: VersionedKeyProfileRef) {
  return { key: profile.key, version: profile.version };
}

function stableScopeBinding(scope: ResolvedScope) {
  return {
    workspaceId: scope.workspaceId,
    ...(scope.eventId === undefined ? {} : { eventId: scope.eventId }),
    subjects: scope.subjects
  };
}

function parseProfile(value: VersionedDefinitionRef | VersionedKeyProfileRef): VersionedKeyProfileRef {
  if (!stableKeyPattern.test(value.key)) throw new InvocationContextError('invalid_request_binding');
  return Object.freeze({ key: value.key, version: parseContractVersion(value.version) });
}

export interface InvocationScopeResolver {
  resolve(input: {
    readonly operation: { readonly name: string; readonly version: number; readonly effect: 'read' | 'draft' | 'commit' };
    readonly businessInput: unknown;
    readonly evidence: ScopeResolutionEvidence;
  }): ResolvedScope | Promise<ResolvedScope>;
}

export interface IdempotencyCredentialSeal {
  readonly verifierProfile: VersionedKeyProfileRef;
  readonly verifierSha256: string;
}

export interface IdempotencyCredentialSealer {
  seal(rawIdempotencyKey: string): IdempotencyCredentialSeal | Promise<IdempotencyCredentialSeal>;
}

/** Default WebCrypto implementation for server-only idempotency-key verification. */
export function createHmacIdempotencyCredentialSealer(input: {
  readonly profile: VersionedKeyProfileRef;
  readonly keyBytes: Uint8Array;
}): IdempotencyCredentialSealer {
  const profile = parseProfile(input.profile);
  const keyBytes = Uint8Array.from(input.keyBytes);
  if (keyBytes.byteLength < 32) throw new InvocationContextError('invalid_request_binding');
  return Object.freeze({
    async seal(rawIdempotencyKey: string): Promise<IdempotencyCredentialSeal> {
      if (
        typeof rawIdempotencyKey !== 'string'
        || rawIdempotencyKey.length < 1
        || rawIdempotencyKey.length > 512
      ) {
        throw new InvocationContextError('invalid_request_binding');
      }
      const key = await crypto.subtle.importKey(
        'raw',
        Uint8Array.from(keyBytes).buffer,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const material = new TextEncoder().encode(`jooevents:idempotency:v1:${rawIdempotencyKey}`);
      const tag = new Uint8Array(await crypto.subtle.sign(
        'HMAC',
        key,
        Uint8Array.from(material).buffer
      ));
      return Object.freeze({
        verifierProfile: profile,
        verifierSha256: Array.from(tag, (byte) => byte.toString(16).padStart(2, '0')).join('')
      });
    }
  });
}

export interface RequestHashSeal {
  readonly verifierProfile: VersionedDefinitionRef;
  readonly verifierSha256: string;
}

/** Seals canonical request bytes with server-only key material. */
export interface RequestHashSealer {
  seal(canonicalRequestBytes: Uint8Array): RequestHashSeal | Promise<RequestHashSeal>;
}

/** Default WebCrypto implementation for an operation's versioned request-binding profile. */
export function createHmacRequestHashSealer(input: {
  readonly profile: VersionedDefinitionRef;
  readonly keyBytes: Uint8Array;
}): RequestHashSealer {
  const profile = parseProfile(input.profile);
  const keyBytes = Uint8Array.from(input.keyBytes);
  if (keyBytes.byteLength < 32) throw new InvocationContextError('invalid_request_binding');
  return Object.freeze({
    async seal(canonicalRequestBytes: Uint8Array): Promise<RequestHashSeal> {
      if (!(canonicalRequestBytes instanceof Uint8Array) || canonicalRequestBytes.byteLength === 0) {
        throw new InvocationContextError('invalid_request_binding');
      }
      const key = await crypto.subtle.importKey(
        'raw',
        Uint8Array.from(keyBytes).buffer,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const tag = new Uint8Array(await crypto.subtle.sign(
        'HMAC',
        key,
        Uint8Array.from(canonicalRequestBytes).buffer
      ));
      return Object.freeze({
        verifierProfile: profile,
        verifierSha256: Array.from(tag, (byte) => byte.toString(16).padStart(2, '0')).join('')
      });
    }
  });
}

interface TrustedBuilderBase {
  readonly reference: VersionedDefinitionRef;
  readonly operation: { readonly name: string; readonly version: number };
  readonly lanes: readonly OperationAccessLane[];
  readonly scopeResolver: InvocationScopeResolver;
  readonly authorityResolver: CurrentAuthorityResolver<InvocationEvidence>;
  readonly clock: Clock;
  readonly newInvocationId: () => InvocationId;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly deniedAuthorityOutcome: (reason: CurrentAuthorityDenialReason) => StructuredOutcome;
}

export interface ReadInvocationContextBuilderOptions extends TrustedBuilderBase {
  readonly effect: 'read';
}

export interface EffectInvocationContextBuilderOptions extends TrustedBuilderBase {
  readonly effect: 'draft' | 'commit';
  /** Immutable for the bound operation version. */
  readonly requestHashProfile: VersionedDefinitionRef;
  readonly requestHashSealer: RequestHashSealer;
  /** Immutable for the bound operation version. */
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

export interface TrustedInvocationBuilderBinding {
  readonly operation: {
    readonly name: string;
    readonly version: number;
    readonly effect: 'read' | 'draft' | 'commit';
  };
  readonly accessLanes: readonly OperationAccessLane[];
  readonly requestHashProfile?: VersionedDefinitionRef;
  readonly idempotencyCredentialProfile?: VersionedKeyProfileRef;
}

const trustedBuilderBindings = new WeakMap<object, TrustedInvocationBuilderBinding>();

function normalizeLanes(lanes: readonly OperationAccessLane[]): readonly OperationAccessLane[] {
  if (!Array.isArray(lanes) || lanes.length === 0) throw new InvocationContextError('lane_substitution');
  const parsed = lanes.map(parseOperationAccessLane)
    .sort((left, right) => left.surface.localeCompare(right.surface)
      || left.kind.localeCompare(right.kind)
      || left.policy.key.localeCompare(right.policy.key)
      || left.policy.version - right.policy.version);
  const identities = parsed.map((lane) => `${lane.surface}:${lane.kind}`);
  if (new Set(identities).size !== identities.length) {
    throw new InvocationContextError('lane_substitution');
  }
  return Object.freeze(parsed);
}

function normalizeBase(options: TrustedBuilderBase, effect: 'read' | 'draft' | 'commit'): TrustedBuilderBase {
  if (!stableKeyPattern.test(options.reference.key) || !stableKeyPattern.test(options.operation.name)) {
    throw new InvocationContextError('invalid_request_binding');
  }
  if (!Number.isSafeInteger(options.reference.version) || options.reference.version <= 0
    || !Number.isSafeInteger(options.operation.version) || options.operation.version <= 0) {
    throw new InvocationContextError('invalid_request_binding');
  }
  const resolveScope = options.scopeResolver.resolve.bind(options.scopeResolver);
  const resolveAuthority = options.authorityResolver.resolve.bind(options.authorityResolver);
  const readClock = options.clock.now.bind(options.clock);
  return Object.freeze({
    reference: Object.freeze({ key: options.reference.key, version: options.reference.version }),
    operation: Object.freeze({ name: options.operation.name, version: options.operation.version }),
    lanes: normalizeLanes(options.lanes),
    scopeResolver: Object.freeze({ resolve: resolveScope }),
    authorityResolver: Object.freeze({ resolve: resolveAuthority }),
    clock: Object.freeze({ now: readClock }),
    newInvocationId: options.newInvocationId,
    authorityPrincipalKeyProfile: parseProfile(options.authorityPrincipalKeyProfile),
    scopePartitionProfile: parseProfile(options.scopePartitionProfile),
    requestCanonicalizationProfile: parseProfile(options.requestCanonicalizationProfile),
    deniedAuthorityOutcome: options.deniedAuthorityOutcome,
    effect
  } as TrustedBuilderBase & { readonly effect: typeof effect });
}

function bindingFor(
  options: ReadInvocationContextBuilderOptions | EffectInvocationContextBuilderOptions
): TrustedInvocationBuilderBinding {
  return Object.freeze({
    operation: Object.freeze({
      name: options.operation.name,
      version: options.operation.version,
      effect: options.effect
    }),
    accessLanes: options.lanes,
    ...(options.effect === 'read'
      ? {}
      : {
          requestHashProfile: parseProfile(options.requestHashProfile),
          idempotencyCredentialProfile: parseProfile(options.idempotencyCredentialProfile)
        })
  });
}

/** Registry-only authenticity and immutable operation/lane binding inspection. */
export function getTrustedInvocationBuilderBinding(
  registration: unknown
): TrustedInvocationBuilderBinding | undefined {
  return typeof registration === 'object' && registration !== null
    ? trustedBuilderBindings.get(registration)
    : undefined;
}

function findLane(lanes: readonly OperationAccessLane[], evidence: InvocationEvidence): OperationAccessLane {
  const matching = lanes.filter((lane) => lane.kind === evidence.kind && lane.surface === evidence.surface);
  if (matching.length !== 1) throw new InvocationContextError('lane_substitution');
  return matching[0] as OperationAccessLane;
}

function scopeResolutionEvidenceFor(evidence: InvocationEvidence): ScopeResolutionEvidence {
  switch (evidence.kind) {
    case 'operator':
      return Object.freeze({ kind: evidence.kind, surface: evidence.surface });
    case 'participant':
      return Object.freeze({ kind: evidence.kind, surface: evidence.surface });
    case 'public_open':
      return Object.freeze({
        kind: evidence.kind,
        surface: evidence.surface,
        publicPolicyRevisionId: evidence.publicPolicyRevisionId
      });
    case 'public_ceremony':
      return Object.freeze({
        kind: evidence.kind,
        surface: evidence.surface,
        ceremonyEvidenceId: evidence.ceremonyEvidenceId
      });
    case 'external_mcp':
      return Object.freeze({ kind: evidence.kind, surface: evidence.surface });
    case 'app_model':
      return Object.freeze({
        kind: evidence.kind,
        surface: evidence.surface,
        agentRunId: evidence.agentRunId,
        modelAttemptId: evidence.modelAttemptId,
        modelToolCallId: evidence.modelToolCallId
      });
    case 'registered_job':
      return Object.freeze({
        kind: evidence.kind,
        surface: evidence.surface,
        jobId: evidence.jobId
      });
    case 'registered_consumer':
      return Object.freeze({
        kind: evidence.kind,
        surface: evidence.surface,
        consumerDeliveryId: evidence.consumerDeliveryId,
        consumerAttemptId: evidence.consumerAttemptId
      });
    case 'registered_scheduler':
      return Object.freeze({
        kind: evidence.kind,
        surface: evidence.surface,
        schedulerKey: evidence.schedulerKey,
        schedulerVersion: evidence.schedulerVersion,
        capabilityRevisionId: evidence.capabilityRevisionId
      });
    case 'verified_intake':
      return Object.freeze({
        kind: evidence.kind,
        surface: evidence.surface,
        verifiedEnvelopeHandleId: evidence.verifiedEnvelopeHandleId
      });
    case 'verified_inbox':
      return Object.freeze({
        kind: evidence.kind,
        surface: evidence.surface,
        inboxReceiptId: evidence.inboxReceiptId
      });
  }
}

async function buildContext(input: {
  readonly options: ReadInvocationContextBuilderOptions | EffectInvocationContextBuilderOptions;
  readonly invocation: ReadContextBuilderInput | EffectContextBuilderInput;
  readonly publicEffectConformanceActivation?: PublicEffectConformanceActivation;
}): Promise<
  | {
      readonly kind: 'outcome';
      readonly outcome: StructuredOutcome;
      readonly observationAttempt?: DeniedReadObservationAttempt;
      readonly auditAttempt?: DeniedEffectAuditAttempt;
    }
  | { readonly kind: 'ready'; readonly context: InvocationContext; readonly idempotency?: IdempotencyCredentialSeal }
> {
  const { options, invocation } = input;
  if (
    invocation.operationName !== options.operation.name
    || invocation.operationVersion !== options.operation.version
  ) throw new InvocationContextError('lane_substitution');
  assertNoCallerSecurityClaims(invocation.businessInput);
  const evidence = parseInvocationEvidence(invocation.verifiedEvidence);
  if (evidence.surface !== invocation.surface) throw new InvocationContextError('lane_substitution');
  const lane = findLane(options.lanes, evidence);
  if (options.effect !== 'read' && (
    lane.kind === 'public_open'
    || (lane.kind === 'public_ceremony'
      && !isPublicEffectConformanceActivation(input.publicEffectConformanceActivation))
  )) {
    throw new InvocationContextError('public_mutation_disabled');
  }
  if (options.effect === 'commit' && lane.kind === 'app_model') {
    throw new InvocationContextError('app_model_commit_forbidden');
  }

  const receivedAt = parseInstant(options.clock.now());
  const scope = normalizeScope(await options.scopeResolver.resolve({
    operation: { ...options.operation, effect: options.effect },
    businessInput: invocation.businessInput,
    evidence: scopeResolutionEvidenceFor(evidence)
  }));
  const invocationId = parseInvocationId(options.newInvocationId());
  const authorityResolution = await options.authorityResolver.resolve({
    operation: { ...options.operation, effect: options.effect },
    evidence,
    lane,
    scope,
    evaluatedAt: receivedAt
  });
  if (authorityResolution.kind === 'denied') {
    const outcome = structuredOutcomeSchema.parse(options.deniedAuthorityOutcome(authorityResolution.reason));
    const safeAttempt = {
      invocationId,
      correlationId: parseCorrelationId(invocation.correlationId),
      operation: { ...options.operation, effect: options.effect },
      surface: evidence.surface,
      accessLane: lane,
      client: evidence.client,
      provenance: provenanceForEvidence(evidence),
      scope: stableScopeBinding(scope),
      scopeResolutionEvidenceIds: [...scope.resolutionEvidenceIds],
      receivedAt,
      denialReason: authorityResolution.reason
    };
    if (options.effect === 'read') {
      const observationAttempt = deepFreeze(safeAttempt) as unknown as DeniedReadObservationAttempt;
      sealedDeniedReadObservationAttempts.add(observationAttempt);
      return { kind: 'outcome', outcome, observationAttempt };
    }
    const auditAttempt = deepFreeze(safeAttempt) as unknown as DeniedEffectAuditAttempt;
    sealedDeniedEffectAuditAttempts.add(auditAttempt);
    sealedDeniedEffectAuditOutcomes.set(auditAttempt, deepFreeze(structuredClone(outcome)));
    return { kind: 'outcome', outcome, auditAttempt };
  }
  if (authorityResolution.kind !== 'authorized') throw new InvocationContextError('invalid_authority');
  const authority = normalizeCurrentAuthority(authorityResolution.authority);
  if (
    !sameLane(authority.lane, lane)
    || authority.evaluatedAt !== receivedAt
    || canonicalJsonText(authority.scope) !== canonicalJsonText(scope)
    || !authorityMatchesEvidence(authority, evidence)
    || !authorityCitationsMatch(authority)
  ) throw new InvocationContextError('invalid_authority');

  const authorityProfile = parseProfile(options.authorityPrincipalKeyProfile);
  const scopeProfile = parseProfile(options.scopePartitionProfile);
  const requestProfile = parseProfile(options.requestCanonicalizationProfile);
  const authorityPrincipalKey = await sha256Hex(canonicalAuthorityPrincipalKeyFrame(authority.principal, authorityProfile));
  const scopePartitionKey = await sha256Hex(encodeCanonicalJson({
    namespace: 'jooevents.operation-scope-partition',
    profile: profileValue(scopeProfile),
    scope: stableScopeBinding(scope)
  }));
  const canonicalRequestBytes = encodeCanonicalJson({
    namespace: 'jooevents.operation-request-binding',
    profile: profileValue(requestProfile),
    operation: { ...options.operation, effect: options.effect },
    surface: evidence.surface,
    lane: { kind: lane.kind, policy: profileValue(lane.policy) },
    authorityPrincipalKey,
    scope: stableScopeBinding(scope),
    businessInput: invocation.businessInput
  });
  let requestHashSha256: string;
  let requestHashProfile: VersionedKeyProfileRef | undefined;
  if (options.effect === 'read') {
    requestHashSha256 = await sha256Hex(canonicalRequestBytes);
  } else {
    const sealed = await options.requestHashSealer.seal(Uint8Array.from(canonicalRequestBytes));
    requestHashProfile = parseProfile(sealed.verifierProfile);
    const expectedRequestHashProfile = parseProfile(options.requestHashProfile);
    const ordinaryDigest = await sha256Hex(canonicalRequestBytes);
    if (
      requestHashProfile.key !== expectedRequestHashProfile.key
      || requestHashProfile.version !== expectedRequestHashProfile.version
      || !sha256Pattern.test(sealed.verifierSha256)
      || sealed.verifierSha256 === ordinaryDigest
    ) {
      throw new InvocationContextError('invalid_request_binding');
    }
    requestHashSha256 = sealed.verifierSha256;
  }

  let idempotency: IdempotencyCredentialSeal | undefined;
  if (options.effect !== 'read') {
    if (!('rawIdempotencyKey' in invocation) || typeof invocation.rawIdempotencyKey !== 'string' || invocation.rawIdempotencyKey.length < 1 || invocation.rawIdempotencyKey.length > 512) {
      throw new InvocationContextError('invalid_request_binding');
    }
    const sealed = await options.idempotencyCredentialSealer.seal(invocation.rawIdempotencyKey);
    const verifierProfile = parseProfile(sealed.verifierProfile);
    const expectedVerifierProfile = parseProfile(options.idempotencyCredentialProfile);
    if (
      verifierProfile.key !== expectedVerifierProfile.key
      || verifierProfile.version !== expectedVerifierProfile.version
      || !sha256Pattern.test(sealed.verifierSha256)
      || sealed.verifierSha256 === invocation.rawIdempotencyKey
    ) {
      throw new InvocationContextError('invalid_request_binding');
    }
    idempotency = Object.freeze({ verifierProfile, verifierSha256: sealed.verifierSha256 });
  }

  const context = deepFreeze({
    invocationId,
    correlationId: parseCorrelationId(invocation.correlationId),
    operation: { ...options.operation, effect: options.effect },
    surface: evidence.surface,
    client: evidence.client,
    provenance: provenanceForEvidence(evidence),
    actor: authority.actor,
    authority,
    authorityPrincipalKey,
    scope,
    receivedAt,
    requestBinding: {
      canonicalizationProfile: requestProfile,
      requestHashSha256,
      ...(requestHashProfile === undefined ? {} : { requestHashProfile }),
      scopePartitionProfile: scopeProfile,
      scopePartitionKey,
      ...(idempotency === undefined ? {} : { idempotency })
    }
  }) as unknown as InvocationContext;
  sealedInvocationContexts.add(context);
  if (options.effect !== 'read') {
    effectAuthorityRechecks.set(context, Object.freeze({
      operation: context.operation,
      evidence,
      lane,
      scope,
      initialAuthority: authority,
      resolveAuthority: options.authorityResolver.resolve,
      now: options.clock.now,
      deniedAuthorityOutcome: options.deniedAuthorityOutcome
    }) as EffectAuthorityRecheckDirective);
  }
  return { kind: 'ready', context, ...(idempotency === undefined ? {} : { idempotency }) };
}

export function isSealedInvocationContext(value: unknown): value is InvocationContext {
  return typeof value === 'object' && value !== null && sealedInvocationContexts.has(value);
}

export interface EffectAuthorityRecheckSource {
  readonly resolveAuthority: CurrentAuthorityResolver<InvocationEvidence>['resolve'];
  readonly now: Clock['now'];
}

export interface SealedEffectAuthorityRecheckResult {
  readonly kind: 'sealed_effect_authority_recheck_result';
}

export type ConsumedEffectAuthorityRecheckResult =
  | { readonly kind: 'authorized'; readonly evaluatedAt: Instant }
  | {
      readonly kind: 'denied';
      readonly reason: CurrentAuthorityDenialReason;
      readonly outcome: StructuredOutcome;
      readonly evaluatedAt: Instant;
    };

function authoritySnapshot(authority: CurrentResolvedAuthority): string {
  return canonicalJsonText({
    actor: authority.actor,
    principal: authority.principal,
    lane: authority.lane,
    scope: authority.scope,
    grants: [...authority.grants]
      .map((grant) => ({ ...grant }))
      .sort((left, right) => left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key)),
    evidenceIds: [...authority.evidenceIds].sort(),
    authorityCitationIds: [...authority.authorityCitationIds].sort()
  });
}

async function sealEffectInvocationCurrentAuthorityRecheck(
  context: InvocationContext,
  source: EffectAuthorityRecheckSource
): Promise<SealedEffectAuthorityRecheckResult> {
  const directive = effectAuthorityRechecks.get(context);
  if (!directive || !isSealedInvocationContext(context) || context.operation.effect === 'read') {
    throw new InvocationContextError('invalid_authority');
  }
  const evaluatedAt = parseInstant(source.now());
  if (Date.parse(evaluatedAt) < Date.parse(context.receivedAt)) {
    throw new InvocationContextError('invalid_authority');
  }
  const candidate = await source.resolveAuthority({
    operation: directive.operation,
    evidence: directive.evidence,
    lane: directive.lane,
    scope: directive.scope,
    evaluatedAt
  });
  let reason: CurrentAuthorityDenialReason;
  if (candidate.kind === 'denied') {
    if (!CURRENT_AUTHORITY_DENIAL_REASONS.includes(candidate.reason)) {
      throw new InvocationContextError('invalid_authority');
    }
    reason = candidate.reason;
  } else if (candidate.kind === 'authorized') {
    const current = normalizeCurrentAuthority(candidate.authority);
    if (current.evaluatedAt !== evaluatedAt
      || !sameLane(current.lane, directive.lane)
      || canonicalJsonText(current.scope) !== canonicalJsonText(directive.scope)
      || !authorityMatchesEvidence(current, directive.evidence)
      || !authorityCitationsMatch(current)) {
      throw new InvocationContextError('invalid_authority');
    }
    if (authoritySnapshot(current) === authoritySnapshot(directive.initialAuthority)) {
      const sealed: SealedEffectAuthorityRecheckResult = Object.freeze({
        kind: 'sealed_effect_authority_recheck_result'
      });
      sealedEffectAuthorityRecheckResults.set(sealed, Object.freeze({
        context,
        evaluatedAt,
        authority: current,
        result: Object.freeze({ kind: 'authorized' })
      }));
      return sealed;
    }
    reason = 'stale';
  } else {
    throw new InvocationContextError('invalid_authority');
  }

  const outcome = structuredOutcomeSchema.parse(directive.deniedAuthorityOutcome(reason));
  if (outcome.class !== 'access_denied'
    || outcome.kind !== `authority.${reason}`
    || outcome.retryable !== false) {
    throw new InvocationContextError('invalid_authority');
  }
  const sealed: SealedEffectAuthorityRecheckResult = Object.freeze({
    kind: 'sealed_effect_authority_recheck_result'
  });
  sealedEffectAuthorityRecheckResults.set(sealed, Object.freeze({
    context,
    evaluatedAt,
    authority: directive.initialAuthority,
    result: Object.freeze({ kind: 'denied', reason, outcome })
  }));
  return sealed;
}

/** Rechecks before execution using the original trusted authority source. */
export function recheckEffectInvocationCurrentAuthority(
  context: InvocationContext
): Promise<SealedEffectAuthorityRecheckResult> {
  const directive = effectAuthorityRechecks.get(context);
  if (!directive) return Promise.reject(new InvocationContextError('invalid_authority'));
  return sealEffectInvocationCurrentAuthorityRecheck(context, {
    resolveAuthority: directive.resolveAuthority,
    now: directive.now
  });
}

/**
 * Rechecks with the authority source owned by the active transaction adapter.
 * The source must perform only current, transaction-local reads.
 */
export function recheckEffectInvocationCurrentAuthorityInTransaction(
  context: InvocationContext,
  source: EffectAuthorityRecheckSource
): Promise<SealedEffectAuthorityRecheckResult> {
  if (!source || typeof source.resolveAuthority !== 'function' || typeof source.now !== 'function') {
    return Promise.reject(new InvocationContextError('invalid_authority'));
  }
  return sealEffectInvocationCurrentAuthorityRecheck(context, source);
}

/** Opens only an authentic application-sealed result for its exact invocation. */
export function consumeEffectInvocationCurrentAuthorityRecheck(
  context: InvocationContext,
  sealed: SealedEffectAuthorityRecheckResult
): ConsumedEffectAuthorityRecheckResult {
  const internal = sealedEffectAuthorityRecheckResults.get(sealed);
  if (!internal || internal.context !== context) {
    throw new InvocationContextError('invalid_authority');
  }
  return internal.result.kind === 'authorized'
    ? Object.freeze({ kind: 'authorized', evaluatedAt: internal.evaluatedAt })
    : Object.freeze({ ...internal.result, evaluatedAt: internal.evaluatedAt });
}

/** Returns authenticated audit attribution from an exact recheck result. */
export function resolveEffectInvocationAuthorityRecheckAttribution(
  context: InvocationContext,
  sealed: SealedEffectAuthorityRecheckResult
): CurrentResolvedAuthority {
  const internal = sealedEffectAuthorityRecheckResults.get(sealed);
  if (!internal || internal.context !== context) {
    throw new InvocationContextError('invalid_authority');
  }
  return internal.authority;
}

/** Returns the trusted evaluation time from any authentic recheck result. */
export function resolveEffectInvocationCurrentAuthorityRecheckTime(
  context: InvocationContext,
  sealed: SealedEffectAuthorityRecheckResult
): Instant {
  const internal = sealedEffectAuthorityRecheckResults.get(sealed);
  if (!internal || internal.context !== context) {
    throw new InvocationContextError('invalid_authority');
  }
  return internal.evaluatedAt;
}

export function isSealedDeniedEffectAuditAttempt(value: unknown): value is DeniedEffectAuditAttempt {
  return typeof value === 'object' && value !== null && sealedDeniedEffectAuditAttempts.has(value);
}

/** Proves the outcome paired with an authentic effect-context denial attempt. */
export function isExactSealedDeniedEffectAuditOutcome(input: {
  readonly attempt: DeniedEffectAuditAttempt;
  readonly outcome: StructuredOutcome;
}): boolean {
  const expected = sealedDeniedEffectAuditOutcomes.get(input.attempt);
  return expected !== undefined && canonicalJsonText(expected) === canonicalJsonText(input.outcome);
}

export function isSealedDeniedReadObservationAttempt(value: unknown): value is DeniedReadObservationAttempt {
  return typeof value === 'object' && value !== null && sealedDeniedReadObservationAttempts.has(value);
}

export function createReadInvocationContextBuilder(
  options: ReadInvocationContextBuilderOptions
): ReadContextBuilderRegistration {
  const base = normalizeBase(options, 'read');
  const sealedOptions = Object.freeze({ ...base, effect: 'read' as const }) as ReadInvocationContextBuilderOptions;
  const registration: ReadContextBuilderRegistration = Object.freeze({
    reference: sealedOptions.reference,
    async build(invocation: ReadContextBuilderInput): Promise<ReadContextBuildResult> {
      const built = await buildContext({ options: sealedOptions, invocation });
      if (built.kind === 'ready') return { kind: 'ready', context: built.context };
      if (!built.observationAttempt) throw new InvocationContextError('invalid_authority');
      return {
        kind: 'outcome',
        outcome: built.outcome,
        observationAttempt: built.observationAttempt
      };
    }
  });
  trustedBuilderBindings.set(registration, bindingFor(sealedOptions));
  return registration;
}

export function createEffectInvocationContextBuilder(
  options: EffectInvocationContextBuilderOptions,
  publicEffectConformanceActivation?: PublicEffectConformanceActivation
): EffectContextBuilderRegistration {
  const base = normalizeBase(options, options.effect);
  const sealCredential = options.idempotencyCredentialSealer.seal.bind(options.idempotencyCredentialSealer);
  const sealRequestHash = options.requestHashSealer.seal.bind(options.requestHashSealer);
  const sealedOptions = Object.freeze({
    ...base,
    effect: options.effect,
    requestHashProfile: parseProfile(options.requestHashProfile),
    requestHashSealer: Object.freeze({ seal: sealRequestHash }),
    idempotencyCredentialProfile: parseProfile(options.idempotencyCredentialProfile),
    idempotencyCredentialSealer: Object.freeze({ seal: sealCredential })
  }) as EffectInvocationContextBuilderOptions;
  const registration: EffectContextBuilderRegistration = Object.freeze({
    reference: sealedOptions.reference,
    async build(invocation: EffectContextBuilderInput): Promise<EffectContextBuildResult> {
      const built = await buildContext({
        options: sealedOptions,
        invocation,
        ...(publicEffectConformanceActivation === undefined
          ? {}
          : { publicEffectConformanceActivation })
      });
      if (built.kind === 'outcome') {
        if (!built.auditAttempt) throw new InvocationContextError('invalid_authority');
        return { kind: 'outcome', outcome: built.outcome, auditAttempt: built.auditAttempt };
      }
      if (!built.idempotency) throw new InvocationContextError('invalid_request_binding');
      return {
        kind: 'ready',
        context: built.context,
        requestIdentity: {
          scopePartitionKey: built.context.requestBinding.scopePartitionKey,
          authorityPrincipalKey: built.context.authorityPrincipalKey,
          idempotencyVerifierProfile: built.idempotency.verifierProfile,
          idempotencyKeyVerifier: built.idempotency.verifierSha256,
          requestHash: built.context.requestBinding.requestHashSha256
        }
      };
    }
  });
  trustedBuilderBindings.set(registration, bindingFor(sealedOptions));
  if (publicEffectConformanceActivation !== undefined) {
    bindPublicEffectConformanceBuilder(registration, publicEffectConformanceActivation);
  }
  return registration;
}
