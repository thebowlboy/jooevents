import type {
  ActorRef,
  AuthorityCitationId,
  ContractVersion,
  Instant,
  OperationSurface,
  ResolvedScope
} from '@jooevents/kernel';
import type { AuthorityPrincipalRef } from './authority-principal';

export const OPERATION_ACCESS_LANE_KINDS = [
  'operator',
  'participant',
  'public_open',
  'public_ceremony',
  'external_mcp',
  'app_model',
  'registered_job',
  'registered_consumer',
  'registered_scheduler',
  'verified_intake',
  'verified_inbox'
] as const;

export type OperationAccessLaneKind = (typeof OPERATION_ACCESS_LANE_KINDS)[number];

export interface VersionedAccessPolicyRef {
  readonly key: string;
  readonly version: ContractVersion;
}

type Lane<Kind extends OperationAccessLaneKind, Surface extends OperationSurface> = {
  readonly kind: Kind;
  readonly surface: Surface;
  readonly policy: VersionedAccessPolicyRef;
};

/**
 * A closed, operation-registered authority lane. The policy reference selects the
 * current evaluator; a transport surface or actor kind is never authority by itself.
 */
export type OperationAccessLane =
  | Lane<'operator', 'operator_http'>
  | Lane<'participant', 'participant_http'>
  | Lane<'public_open', 'public_http'>
  | Lane<'public_ceremony', 'public_http'>
  | Lane<'external_mcp', 'external_mcp'>
  | Lane<'app_model', 'app_model'>
  | Lane<'registered_job', 'application_job'>
  | Lane<'registered_consumer', 'application_job'>
  | Lane<'registered_scheduler', 'application_job'>
  | Lane<'verified_intake', 'provider_ingress'>
  | Lane<'verified_inbox', 'provider_ingress'>;

const laneSurface = Object.freeze({
  operator: 'operator_http',
  participant: 'participant_http',
  public_open: 'public_http',
  public_ceremony: 'public_http',
  external_mcp: 'external_mcp',
  app_model: 'app_model',
  registered_job: 'application_job',
  registered_consumer: 'application_job',
  registered_scheduler: 'application_job',
  verified_intake: 'provider_ingress',
  verified_inbox: 'provider_ingress'
} satisfies Record<OperationAccessLaneKind, OperationSurface>);

const stableKeyPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Runtime validation for internal manifests before a lane can receive traffic. */
export function parseOperationAccessLane(value: unknown): OperationAccessLane {
  if (!isPlainRecord(value)) throw new TypeError('operation access lane must be a plain record');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'kind,policy,surface') {
    throw new TypeError('operation access lane contains unknown fields');
  }
  if (
    typeof value.kind !== 'string' ||
    !OPERATION_ACCESS_LANE_KINDS.includes(value.kind as OperationAccessLaneKind)
  ) {
    throw new TypeError('unknown operation access lane');
  }
  const kind = value.kind as OperationAccessLaneKind;
  if (value.surface !== laneSurface[kind]) {
    throw new TypeError('operation access lane does not match its surface');
  }
  if (!isPlainRecord(value.policy)) throw new TypeError('access policy reference is invalid');
  const policyKeys = Object.keys(value.policy).sort();
  if (policyKeys.join(',') !== 'key,version') {
    throw new TypeError('access policy reference contains unknown fields');
  }
  if (
    typeof value.policy.key !== 'string' ||
    !stableKeyPattern.test(value.policy.key) ||
    typeof value.policy.version !== 'number' ||
    !Number.isSafeInteger(value.policy.version) ||
    value.policy.version <= 0
  ) {
    throw new TypeError('access policy reference is invalid');
  }
  return Object.freeze({
    kind,
    surface: laneSurface[kind],
    policy: Object.freeze({
      key: value.policy.key,
      version: value.policy.version as ContractVersion
    })
  }) as OperationAccessLane;
}

export const CURRENT_AUTHORITY_GRANT_KINDS = [
  'permission',
  'token_scope',
  'participant_relationship',
  'public_policy',
  'registered_capability'
] as const;

export type CurrentAuthorityGrantKind = (typeof CURRENT_AUTHORITY_GRANT_KINDS)[number];

export interface CurrentAuthorityGrant {
  readonly kind: CurrentAuthorityGrantKind;
  readonly key: string;
}

/** The current, already-authorized result retained in a sealed invocation. */
export interface CurrentResolvedAuthority {
  readonly actor: ActorRef;
  readonly principal: AuthorityPrincipalRef;
  readonly lane: OperationAccessLane;
  readonly scope: ResolvedScope;
  readonly grants: readonly CurrentAuthorityGrant[];
  readonly evidenceIds: readonly string[];
  readonly authorityCitationIds: readonly AuthorityCitationId[];
  readonly evaluatedAt: Instant;
}

export const CURRENT_AUTHORITY_DENIAL_REASONS = [
  'missing',
  'not_authorized',
  'stale',
  'revoked',
  'cross_scope',
  'lane_mismatch'
] as const;

export type CurrentAuthorityDenialReason =
  (typeof CURRENT_AUTHORITY_DENIAL_REASONS)[number];

export type CurrentAuthorityResolution =
  | { readonly kind: 'authorized'; readonly authority: CurrentResolvedAuthority }
  | { readonly kind: 'denied'; readonly reason: CurrentAuthorityDenialReason };

export interface CurrentAuthorityResolutionInput<Evidence> {
  readonly operation: {
    readonly name: string;
    readonly version: number;
    readonly effect: 'read' | 'draft' | 'commit';
  };
  readonly evidence: Evidence;
  readonly lane: OperationAccessLane;
  readonly scope: ResolvedScope;
  readonly evaluatedAt: Instant;
}

/** Implementations reload current relationships/capabilities for every invocation. */
export interface CurrentAuthorityResolver<Evidence> {
  resolve(
    input: CurrentAuthorityResolutionInput<Evidence>
  ): CurrentAuthorityResolution | Promise<CurrentAuthorityResolution>;
}
