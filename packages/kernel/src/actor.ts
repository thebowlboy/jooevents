import type {
  AgentRunId,
  CapabilityRevisionId,
  CeremonyEvidenceId,
  ConsumerAttemptId,
  ConsumerDeliveryId,
  IntegrationInboxReceiptId,
  JobId,
  ParticipantIdentityId,
  PersonId,
  PublicPolicyRevisionId,
  ServiceIdentityId,
  SourceConnectionId,
  SourceConnectionRevisionId,
  UserId,
  VerifiedEnvelopeHandleId,
  VerifierRevisionId
} from './ids';
import type { ContractVersion } from './versions';

export type PublicRequestAuthorityRef =
  | { readonly kind: 'open_policy' }
  | { readonly kind: 'mutation_ceremony'; readonly ceremonyEvidenceId: CeremonyEvidenceId };

export type ActorRef =
  | { readonly kind: 'workspace_user'; readonly userId: UserId }
  | {
      readonly kind: 'participant';
      readonly participantIdentityId: ParticipantIdentityId;
      readonly personId: PersonId;
    }
  | { readonly kind: 'service'; readonly serviceIdentityId: ServiceIdentityId }
  | {
      readonly kind: 'external_mcp_client';
      readonly clientKey: string;
      readonly authorityPrincipalId: string;
    }
  | {
      readonly kind: 'app_model_run';
      readonly agentRunId: AgentRunId;
      readonly delegatedByPrincipalId: string;
    }
  | {
      readonly kind: 'system_job';
      readonly jobId: JobId;
      readonly registeredCapabilityRevisionId: CapabilityRevisionId;
    }
  | {
      readonly kind: 'system_consumer_delivery';
      readonly consumerDeliveryId: ConsumerDeliveryId;
      readonly consumerAttemptId: ConsumerAttemptId;
      readonly consumerKey: string;
      readonly consumerVersion: ContractVersion;
    }
  | {
      readonly kind: 'system_scheduler';
      readonly schedulerKey: string;
      readonly schedulerVersion: ContractVersion;
      readonly registeredCapabilityRevisionId: CapabilityRevisionId;
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
      readonly sourceConnectionId: SourceConnectionId;
    }
  | {
      readonly kind: 'public_request';
      readonly publicPolicyRevisionId: PublicPolicyRevisionId;
      readonly authority: PublicRequestAuthorityRef;
    };
