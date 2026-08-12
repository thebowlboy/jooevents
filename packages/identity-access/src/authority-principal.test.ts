import { expect, test } from 'bun:test';
import {
  parseAuthorityCitationId,
  parseCapabilityRevisionId,
  parseCeremonyEvidenceId,
  parseConsumerAttemptId,
  parseConsumerDeliveryId,
  parseContractVersion,
  parseGrantRevisionId,
  parseIntegrationInboxReceiptId,
  parseJobId,
  parseMembershipId,
  parseParticipantIdentityId,
  parseParticipantSessionId,
  parsePersonId,
  parsePublicPolicyRevisionId,
  parseServiceIdentityId,
  parseSourceConnectionId,
  parseSourceConnectionRevisionId,
  parseVerifiedEnvelopeHandleId,
  parseVerifierRevisionId,
  parseUserId
} from '@jooevents/kernel';
import {
  canonicalAuthorityPrincipalKeyFrame,
  type AuthorityPrincipalRef,
  type VersionedKeyProfileRef
} from './authority-principal';

const ids = {
  user: parseUserId('550e8400-e29b-41d4-a716-446655440000'),
  membership: parseMembershipId('550e8400-e29b-41d4-a716-446655440001'),
  participant: parseParticipantIdentityId('01890f47-9abc-7def-8123-456789abc001'),
  person: parsePersonId('01890f47-9abc-7def-8123-456789abc002'),
  session1: parseParticipantSessionId('01890f47-9abc-7def-8123-456789abc003'),
  session2: parseParticipantSessionId('01890f47-9abc-7def-8123-456789abc004'),
  delivery: parseConsumerDeliveryId('01890f47-9abc-7def-8123-456789abc005'),
  attempt1: parseConsumerAttemptId('01890f47-9abc-7def-8123-456789abc006'),
  attempt2: parseConsumerAttemptId('01890f47-9abc-7def-8123-456789abc007'),
  capability: parseCapabilityRevisionId('01890f47-9abc-7def-8123-456789abc008'),
  citation: parseAuthorityCitationId('01890f47-9abc-7def-8123-456789abc009'),
  grantRevision1: parseGrantRevisionId('01890f47-9abc-7def-8123-456789abc010'),
  grantRevision2: parseGrantRevisionId('01890f47-9abc-7def-8123-456789abc011'),
  job: parseJobId('01890f47-9abc-7def-8123-456789abc013'),
  publicPolicy: parsePublicPolicyRevisionId('01890f47-9abc-7def-8123-456789abc014'),
  ceremony1: parseCeremonyEvidenceId('01890f47-9abc-7def-8123-456789abc015'),
  ceremony2: parseCeremonyEvidenceId('01890f47-9abc-7def-8123-456789abc016'),
  connection: parseSourceConnectionId('01890f47-9abc-7def-8123-456789abc017'),
  connectionRevision: parseSourceConnectionRevisionId('01890f47-9abc-7def-8123-456789abc018'),
  verifier1: parseVerifierRevisionId('01890f47-9abc-7def-8123-456789abc019'),
  verifier2: parseVerifierRevisionId('01890f47-9abc-7def-8123-456789abc020'),
  envelope1: parseVerifiedEnvelopeHandleId('01890f47-9abc-7def-8123-456789abc021'),
  envelope2: parseVerifiedEnvelopeHandleId('01890f47-9abc-7def-8123-456789abc022'),
  inbox: parseIntegrationInboxReceiptId('01890f47-9abc-7def-8123-456789abc023')
};

const profile: VersionedKeyProfileRef = {
  key: 'authority-principal-key',
  version: parseContractVersion(1)
};
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

test('workspace authority identity is deterministic and kind-separated', () => {
  const workspace: AuthorityPrincipalRef = {
    kind: 'workspace_user',
    userId: ids.user,
    membershipId: ids.membership
  };
  const participant: AuthorityPrincipalRef = {
    kind: 'participant',
    participantIdentityId: ids.participant,
    personId: ids.person,
    participantSessionId: ids.session1
  };

  expect(hex(canonicalAuthorityPrincipalKeyFrame(workspace, profile))).toBe(
    '4a4543460100000006000000216a6f6f6576656e74732e617574686f72697479' +
    '2d7072696e636970616c2d6b657900000017617574686f726974792d7072696e' +
    '636970616c2d6b657900000001310000000e776f726b73706163655f75736572' +
    '0000002435353065383430302d653239622d343164342d613731362d34343636' +
    '35353434303030300000002435353065383430302d653239622d343164342d61' +
    '3731362d343436363535343430303031'
  );
  expect(hex(canonicalAuthorityPrincipalKeyFrame(workspace, profile))).not.toBe(
    hex(canonicalAuthorityPrincipalKeyFrame(participant, profile))
  );
});

test('session refresh and compatible service-grant revision keep stable identity', () => {
  const participant = (participantSessionId: typeof ids.session1): AuthorityPrincipalRef => ({
    kind: 'participant',
    participantIdentityId: ids.participant,
    personId: ids.person,
    participantSessionId
  });
  const service = (grantRevisionId: typeof ids.grantRevision1): AuthorityPrincipalRef => ({
    kind: 'service',
    serviceIdentityId: parseServiceIdentityId('01890f47-9abc-7def-8123-456789abc012'),
    grantKey: 'speaker-import',
    grantRevisionId
  });

  expect(hex(canonicalAuthorityPrincipalKeyFrame(participant(ids.session1), profile))).toBe(
    hex(canonicalAuthorityPrincipalKeyFrame(participant(ids.session2), profile))
  );
  expect(hex(canonicalAuthorityPrincipalKeyFrame(service(ids.grantRevision1), profile))).toBe(
    hex(canonicalAuthorityPrincipalKeyFrame(service(ids.grantRevision2), profile))
  );
});

test('consumer attempt and key-profile rotation change stable identity', () => {
  const consumer = (consumerAttemptId: typeof ids.attempt1): AuthorityPrincipalRef => ({
    kind: 'registered_consumer_delivery',
    consumerDeliveryId: ids.delivery,
    consumerAttemptId,
    consumerKey: 'activity-projection',
    consumerVersion: parseContractVersion(1),
    capabilityRevisionId: ids.capability,
    authorityCitationId: ids.citation
  });
  const original = hex(canonicalAuthorityPrincipalKeyFrame(consumer(ids.attempt1), profile));

  expect(original).not.toBe(hex(canonicalAuthorityPrincipalKeyFrame(consumer(ids.attempt2), profile)));
  expect(original).not.toBe(hex(canonicalAuthorityPrincipalKeyFrame(consumer(ids.attempt1), {
    key: profile.key,
    version: parseContractVersion(2)
  })));
});

test('every core authority branch receives a distinct canonical frame', () => {
  const principals = [
    {
      kind: 'workspace_user', userId: ids.user, membershipId: ids.membership
    },
    {
      kind: 'participant', participantIdentityId: ids.participant, personId: ids.person,
      participantSessionId: ids.session1
    },
    {
      kind: 'service',
      serviceIdentityId: parseServiceIdentityId('01890f47-9abc-7def-8123-456789abc012'),
      grantKey: 'speaker-import', grantRevisionId: ids.grantRevision1
    },
    {
      kind: 'public_capability', publicPolicyRevisionId: ids.publicPolicy,
      authority: { kind: 'open_policy' }
    },
    {
      kind: 'registered_job', jobId: ids.job, capabilityRevisionId: ids.capability,
      authorityCitationId: ids.citation
    },
    {
      kind: 'registered_consumer_delivery', consumerDeliveryId: ids.delivery,
      consumerAttemptId: ids.attempt1, consumerKey: 'activity-projection',
      consumerVersion: parseContractVersion(1), capabilityRevisionId: ids.capability,
      authorityCitationId: ids.citation
    },
    {
      kind: 'registered_scheduler', schedulerKey: 'due-work',
      schedulerVersion: parseContractVersion(1), capabilityRevisionId: ids.capability,
      authorityCitationId: ids.citation
    },
    {
      kind: 'verified_ingress_intake', verifiedEnvelopeHandleId: ids.envelope1,
      sourceConnectionId: ids.connection, sourceConnectionRevisionId: ids.connectionRevision,
      verifierContractKey: 'email-callback', verifierContractVersion: parseContractVersion(1),
      verifierRevisionId: ids.verifier1
    },
    {
      kind: 'verified_inbox_processing', inboxReceiptId: ids.inbox, verifierRevisionId: ids.verifier1
    }
  ] satisfies readonly AuthorityPrincipalRef[];
  const frames = principals.map((principal) =>
    hex(canonicalAuthorityPrincipalKeyFrame(principal, profile))
  );

  expect(new Set(frames).size).toBe(principals.length);
});

test('public mutation evidence and inbox verifier revisions change identity', () => {
  const publicPrincipal = (ceremonyEvidenceId: typeof ids.ceremony1): AuthorityPrincipalRef => ({
    kind: 'public_capability',
    publicPolicyRevisionId: ids.publicPolicy,
    authority: { kind: 'mutation_ceremony', ceremonyEvidenceId }
  });
  const inboxPrincipal = (verifierRevisionId: typeof ids.verifier1): AuthorityPrincipalRef => ({
    kind: 'verified_inbox_processing', inboxReceiptId: ids.inbox, verifierRevisionId
  });

  expect(hex(canonicalAuthorityPrincipalKeyFrame(publicPrincipal(ids.ceremony1), profile))).not.toBe(
    hex(canonicalAuthorityPrincipalKeyFrame(publicPrincipal(ids.ceremony2), profile))
  );
  expect(hex(canonicalAuthorityPrincipalKeyFrame(inboxPrincipal(ids.verifier1), profile))).not.toBe(
    hex(canonicalAuthorityPrincipalKeyFrame(inboxPrincipal(ids.verifier2), profile))
  );
});

test('ingress redelivery stays stable while verifier identity changes', () => {
  const intake = (
    verifiedEnvelopeHandleId: typeof ids.envelope1,
    verifierRevisionId: typeof ids.verifier1
  ): AuthorityPrincipalRef => ({
    kind: 'verified_ingress_intake',
    verifiedEnvelopeHandleId,
    sourceConnectionId: ids.connection,
    sourceConnectionRevisionId: ids.connectionRevision,
    verifierContractKey: 'email-callback',
    verifierContractVersion: parseContractVersion(1),
    verifierRevisionId
  });

  expect(hex(canonicalAuthorityPrincipalKeyFrame(intake(ids.envelope1, ids.verifier1), profile))).toBe(
    hex(canonicalAuthorityPrincipalKeyFrame(intake(ids.envelope2, ids.verifier1), profile))
  );
  expect(hex(canonicalAuthorityPrincipalKeyFrame(intake(ids.envelope1, ids.verifier1), profile))).not.toBe(
    hex(canonicalAuthorityPrincipalKeyFrame(intake(ids.envelope1, ids.verifier2), profile))
  );
});
