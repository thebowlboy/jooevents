import {
  encodeCanonicalFrame,
  type AuthorityCitationId,
  type Brand,
  type CapabilityRevisionId,
  type CeremonyEvidenceId,
  type ConsumerAttemptId,
  type ConsumerDeliveryId,
  type ContractVersion,
  type GrantRevisionId,
  type IntegrationInboxReceiptId,
  type JobId,
  type MembershipId,
  type ParticipantIdentityId,
  type ParticipantSessionId,
  type PersonId,
  type PublicPolicyRevisionId,
  type ServiceIdentityId,
  type SourceConnectionId,
  type SourceConnectionRevisionId,
  type UserId,
  type VerifiedEnvelopeHandleId,
  type VerifierRevisionId
} from '@jooevents/kernel';

export interface VersionedKeyProfileRef {
  readonly key: string;
  readonly version: ContractVersion;
}

export type AuthorityPrincipalRef =
  | {
      readonly kind: 'workspace_user';
      readonly userId: UserId;
      readonly membershipId: MembershipId;
    }
  | {
      readonly kind: 'participant';
      readonly participantIdentityId: ParticipantIdentityId;
      readonly personId: PersonId;
      readonly participantSessionId: ParticipantSessionId;
    }
  | {
      readonly kind: 'service';
      readonly serviceIdentityId: ServiceIdentityId;
      readonly grantKey: string;
      readonly grantRevisionId: GrantRevisionId;
    }
  | {
      readonly kind: 'public_capability';
      readonly publicPolicyRevisionId: PublicPolicyRevisionId;
      readonly authority:
        | { readonly kind: 'open_policy' }
        | { readonly kind: 'mutation_ceremony'; readonly ceremonyEvidenceId: CeremonyEvidenceId };
    }
  | {
      readonly kind: 'registered_job';
      readonly jobId: JobId;
      readonly capabilityRevisionId: CapabilityRevisionId;
      readonly authorityCitationId: AuthorityCitationId;
    }
  | {
      readonly kind: 'registered_consumer_delivery';
      readonly consumerDeliveryId: ConsumerDeliveryId;
      readonly consumerAttemptId: ConsumerAttemptId;
      readonly consumerKey: string;
      readonly consumerVersion: ContractVersion;
      readonly capabilityRevisionId: CapabilityRevisionId;
      readonly authorityCitationId: AuthorityCitationId;
    }
  | {
      readonly kind: 'registered_scheduler';
      readonly schedulerKey: string;
      readonly schedulerVersion: ContractVersion;
      readonly capabilityRevisionId: CapabilityRevisionId;
      readonly authorityCitationId: AuthorityCitationId;
    }
  | {
      readonly kind: 'verified_ingress_intake';
      readonly verifiedEnvelopeHandleId: VerifiedEnvelopeHandleId;
      readonly sourceConnectionId: SourceConnectionId;
      readonly sourceConnectionRevisionId: SourceConnectionRevisionId;
      readonly verifierContractKey: string;
      readonly verifierContractVersion: ContractVersion;
      readonly verifierRevisionId: VerifierRevisionId;
    }
  | {
      readonly kind: 'verified_inbox_processing';
      readonly inboxReceiptId: IntegrationInboxReceiptId;
      readonly verifierRevisionId: VerifierRevisionId;
    };

export type AuthorityPrincipalKeyFrame =
  Brand<Uint8Array, 'AuthorityPrincipalKeyFrameV1'>;

function exhaustive(value: never): never {
  throw new TypeError(`unknown authority principal: ${String(value)}`);
}

function identityFields(principal: AuthorityPrincipalRef): readonly string[] {
  switch (principal.kind) {
    case 'workspace_user':
      return [principal.userId, principal.membershipId];
    case 'participant':
      return [principal.participantIdentityId, principal.personId];
    case 'service':
      return [principal.serviceIdentityId, principal.grantKey];
    case 'public_capability':
      return principal.authority.kind === 'open_policy'
        ? [principal.publicPolicyRevisionId, 'open_policy']
        : [
            principal.publicPolicyRevisionId,
            'mutation_ceremony',
            principal.authority.ceremonyEvidenceId
          ];
    case 'registered_job':
      return [
        principal.jobId,
        principal.capabilityRevisionId,
        principal.authorityCitationId
      ];
    case 'registered_consumer_delivery':
      return [
        principal.consumerDeliveryId,
        principal.consumerAttemptId,
        principal.consumerKey,
        String(principal.consumerVersion),
        principal.capabilityRevisionId,
        principal.authorityCitationId
      ];
    case 'registered_scheduler':
      return [
        principal.schedulerKey,
        String(principal.schedulerVersion),
        principal.capabilityRevisionId,
        principal.authorityCitationId
      ];
    case 'verified_ingress_intake':
      return [
        principal.sourceConnectionId,
        principal.sourceConnectionRevisionId,
        principal.verifierContractKey,
        String(principal.verifierContractVersion),
        principal.verifierRevisionId
      ];
    case 'verified_inbox_processing':
      return [principal.inboxReceiptId, principal.verifierRevisionId];
    default:
      return exhaustive(principal);
  }
}

/**
 * Returns stable binary material for a profile-selected cryptographic digest.
 * Scope, operation, surface, request hash, and current access stay outside this key.
 */
export function canonicalAuthorityPrincipalKeyFrame(
  principal: AuthorityPrincipalRef,
  profile: VersionedKeyProfileRef
): AuthorityPrincipalKeyFrame {
  return encodeCanonicalFrame({
    namespace: 'jooevents.authority-principal-key',
    profileKey: profile.key,
    profileVersion: profile.version,
    kind: principal.kind,
    fields: identityFields(principal)
  }) as AuthorityPrincipalKeyFrame;
}
