import type { Brand } from './brand';

export const APPLICATION_ID_KINDS = [
  'workspace',
  'event',
  'user',
  'person',
  'membership',
  'participant_identity',
  'participant_session',
  'service_identity',
  'agent_run',
  'model_attempt',
  'model_tool_call',
  'job',
  'consumer_delivery',
  'consumer_attempt',
  'integration_inbox_receipt',
  'operation_receipt',
  'approval',
  'audit_event',
  'domain_fact',
  'effect_specification',
  'outbox_pointer',
  'invocation',
  'correlation',
  'payload_ref',
  'payload_stage',
  'capability_revision',
  'authority_citation',
  'grant_revision',
  'public_policy_revision',
  'ceremony_evidence',
  'source_connection',
  'source_connection_revision',
  'verifier_revision',
  'verified_envelope_handle'
] as const;

export type ApplicationIdKind = (typeof APPLICATION_ID_KINDS)[number];
export type ApplicationId<Kind extends ApplicationIdKind> =
  Brand<string, `ApplicationId:${Kind}`>;

const APPLICATION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Accepts current UUIDv7 IDs and predecessor UUIDv4 IDs, returning lowercase form. */
export function parseApplicationId<Kind extends ApplicationIdKind>(
  kind: Kind,
  value: unknown
): ApplicationId<Kind> {
  if (typeof value !== 'string' || !APPLICATION_UUID.test(value)) {
    throw new TypeError(`${kind} must be an application UUIDv4 or UUIDv7`);
  }
  return value.toLowerCase() as ApplicationId<Kind>;
}

export function isApplicationId(value: unknown): value is ApplicationId<ApplicationIdKind> {
  return typeof value === 'string' && value === value.toLowerCase() && APPLICATION_UUID.test(value);
}

function parser<Kind extends ApplicationIdKind>(kind: Kind) {
  return (value: unknown): ApplicationId<Kind> => parseApplicationId(kind, value);
}

export type WorkspaceId = ApplicationId<'workspace'>;
export type EventId = ApplicationId<'event'>;
export type UserId = ApplicationId<'user'>;
export type PersonId = ApplicationId<'person'>;
export type MembershipId = ApplicationId<'membership'>;
export type ParticipantIdentityId = ApplicationId<'participant_identity'>;
export type ParticipantSessionId = ApplicationId<'participant_session'>;
export type ServiceIdentityId = ApplicationId<'service_identity'>;
export type AgentRunId = ApplicationId<'agent_run'>;
export type ModelAttemptId = ApplicationId<'model_attempt'>;
export type ModelToolCallId = ApplicationId<'model_tool_call'>;
export type JobId = ApplicationId<'job'>;
export type ConsumerDeliveryId = ApplicationId<'consumer_delivery'>;
export type ConsumerAttemptId = ApplicationId<'consumer_attempt'>;
export type IntegrationInboxReceiptId = ApplicationId<'integration_inbox_receipt'>;
export type OperationReceiptId = ApplicationId<'operation_receipt'>;
export type ApprovalId = ApplicationId<'approval'>;
export type AuditEventId = ApplicationId<'audit_event'>;
export type DomainFactId = ApplicationId<'domain_fact'>;
export type EffectSpecificationId = ApplicationId<'effect_specification'>;
export type OutboxPointerId = ApplicationId<'outbox_pointer'>;
export type InvocationId = ApplicationId<'invocation'>;
export type CorrelationId = ApplicationId<'correlation'>;
export type PayloadRefId = ApplicationId<'payload_ref'>;
export type PayloadStageId = ApplicationId<'payload_stage'>;
export type CapabilityRevisionId = ApplicationId<'capability_revision'>;
export type AuthorityCitationId = ApplicationId<'authority_citation'>;
export type GrantRevisionId = ApplicationId<'grant_revision'>;
export type PublicPolicyRevisionId = ApplicationId<'public_policy_revision'>;
export type CeremonyEvidenceId = ApplicationId<'ceremony_evidence'>;
export type SourceConnectionId = ApplicationId<'source_connection'>;
export type SourceConnectionRevisionId = ApplicationId<'source_connection_revision'>;
export type VerifierRevisionId = ApplicationId<'verifier_revision'>;
export type VerifiedEnvelopeHandleId = ApplicationId<'verified_envelope_handle'>;

export const parseWorkspaceId = parser('workspace');
export const parseEventId = parser('event');
export const parseUserId = parser('user');
export const parsePersonId = parser('person');
export const parseMembershipId = parser('membership');
export const parseParticipantIdentityId = parser('participant_identity');
export const parseParticipantSessionId = parser('participant_session');
export const parseServiceIdentityId = parser('service_identity');
export const parseAgentRunId = parser('agent_run');
export const parseModelAttemptId = parser('model_attempt');
export const parseModelToolCallId = parser('model_tool_call');
export const parseJobId = parser('job');
export const parseConsumerDeliveryId = parser('consumer_delivery');
export const parseConsumerAttemptId = parser('consumer_attempt');
export const parseIntegrationInboxReceiptId = parser('integration_inbox_receipt');
export const parseOperationReceiptId = parser('operation_receipt');
export const parseApprovalId = parser('approval');
export const parseAuditEventId = parser('audit_event');
export const parseDomainFactId = parser('domain_fact');
export const parseEffectSpecificationId = parser('effect_specification');
export const parseOutboxPointerId = parser('outbox_pointer');
export const parseInvocationId = parser('invocation');
export const parseCorrelationId = parser('correlation');
export const parsePayloadRefId = parser('payload_ref');
export const parsePayloadStageId = parser('payload_stage');
export const parseCapabilityRevisionId = parser('capability_revision');
export const parseAuthorityCitationId = parser('authority_citation');
export const parseGrantRevisionId = parser('grant_revision');
export const parsePublicPolicyRevisionId = parser('public_policy_revision');
export const parseCeremonyEvidenceId = parser('ceremony_evidence');
export const parseSourceConnectionId = parser('source_connection');
export const parseSourceConnectionRevisionId = parser('source_connection_revision');
export const parseVerifierRevisionId = parser('verifier_revision');
export const parseVerifiedEnvelopeHandleId = parser('verified_envelope_handle');
