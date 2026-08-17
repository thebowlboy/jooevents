import type { InvocationEvidence } from '@jooevents/application';
import {
  parseEventId,
  parseIntegrationInboxReceiptId,
  parseSourceConnectionId,
  parseVerifierRevisionId,
  parseWorkspaceId,
  type EventId,
  type SourceConnectionId,
  type VerifierRevisionId,
  type WorkspaceId
} from '@jooevents/kernel';
import type {
  CurrentAuthorityResolver,
  CurrentAuthorityResolutionInput,
  CurrentAuthorityResolution,
  VersionedAccessPolicyRef
} from '@jooevents/identity-access';

export interface AirtableVerifiedInboxAnchor {
  readonly sourceConnectionId: SourceConnectionId;
  readonly verifierRevisionId: VerifierRevisionId;
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
  readonly state: 'active' | 'paused' | 'needs_reconnect' | 'disconnected';
}

export interface AirtableVerifiedInboxAnchorSource {
  resolve(inboxReceiptId: string): Promise<AirtableVerifiedInboxAnchor | undefined>;
}

const ALLOWED_OPERATIONS = new Set(['task.mutation@1', 'engagement.change@1']);

/** Current, connection-scoped authority for the finite controlled inbound inventory. */
export function createAirtableVerifiedInboxAuthorityResolver(input: Readonly<{
  source: AirtableVerifiedInboxAnchorSource;
  policies: readonly VersionedAccessPolicyRef[];
}>): CurrentAuthorityResolver<InvocationEvidence> {
  const policies = new Set(input.policies.map((policy) => `${policy.key}@${policy.version}`));
  return Object.freeze({
    async resolve(request: CurrentAuthorityResolutionInput<InvocationEvidence>): Promise<CurrentAuthorityResolution> {
      if (request.evidence.kind !== 'verified_inbox'
          || request.lane.kind !== 'verified_inbox'
          || request.lane.surface !== 'provider_ingress'
          || !policies.has(`${request.lane.policy.key}@${request.lane.policy.version}`)
          || !ALLOWED_OPERATIONS.has(`${request.operation.name}@${request.operation.version}`)) {
        return { kind: 'denied', reason: 'lane_mismatch' };
      }
      const inboxReceiptId = parseIntegrationInboxReceiptId(request.evidence.inboxReceiptId);
      const anchor = await input.source.resolve(inboxReceiptId);
      if (!anchor) return { kind: 'denied', reason: 'missing' };
      if (anchor.state !== 'active') {
        return { kind: 'denied', reason: anchor.state === 'needs_reconnect' ? 'revoked' : 'not_authorized' };
      }
      const workspaceId = parseWorkspaceId(anchor.workspaceId);
      const eventId = parseEventId(anchor.eventId);
      if (request.scope.workspaceId !== workspaceId || request.scope.eventId !== eventId) {
        return { kind: 'denied', reason: 'cross_scope' };
      }
      return {
        kind: 'authorized',
        authority: Object.freeze({
          actor: Object.freeze({
            kind: 'verified_inbox_processing' as const,
            inboxReceiptId,
            sourceConnectionId: parseSourceConnectionId(anchor.sourceConnectionId)
          }),
          principal: Object.freeze({
            kind: 'verified_inbox_processing' as const,
            inboxReceiptId,
            verifierRevisionId: parseVerifierRevisionId(anchor.verifierRevisionId)
          }),
          lane: request.lane,
          scope: request.scope,
          grants: Object.freeze([{ kind: 'permission' as const, key: 'event.manage' }]),
          evidenceIds: Object.freeze([`airtable.inbox:${inboxReceiptId}`]),
          authorityCitationIds: Object.freeze([]),
          evaluatedAt: request.evaluatedAt
        })
      };
    }
  });
}
