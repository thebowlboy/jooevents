import { describe, expect, test } from 'bun:test';
import type { OrganizerCommunicationAudienceDraft } from '@jooevents/contracts/communications/organizer';
import { parseEventId, parseWorkspaceId } from '@jooevents/kernel';
import {
  ORGANIZER_AUDIENCE_EXCLUSION_REASONS,
  OrganizerAudienceResolutionError,
  createInMemoryOrganizerAddressPolicyPort,
  createInMemoryOrganizerAudienceSourcePort,
  resolveOrganizerAudience,
  type InMemoryOrganizerAddressPolicyFixture,
  type OrganizerAddressPolicyResolution,
  type OrganizerAudienceCandidate,
  type OrganizerAudienceScope
} from './resolution';

const scope: OrganizerAudienceScope = Object.freeze({
  workspaceId: parseWorkspaceId('01890f47-9abc-7def-8123-456789abcdef'),
  eventId: parseEventId('01890f47-9abc-7def-9234-56789abcdef0')
});
const otherScope: OrganizerAudienceScope = Object.freeze({
  workspaceId: scope.workspaceId,
  eventId: parseEventId('01890f47-9abc-7def-a345-6789abcdef01')
});
const asOf = '2026-08-13T00:00:00.000Z';
const hex = (index: number) => (index % 16).toString(16).repeat(64);

const purposeRevision = Object.freeze({
  purposeId: 'purpose-event-transactional',
  purposeKey: 'event.transactional',
  revisionId: 'purpose-event-transactional-r1',
  revisionNumber: 1,
  digestSha256: hex(1)
});

const registeredSource = Object.freeze({
  kind: 'registered_query' as const,
  recipeId: 'recipe-confirmed-speakers',
  recipeVersion: 3,
  recipeDigestSha256: hex(2),
  sourceDefinition: Object.freeze({
    reference: Object.freeze({ key: 'audience.confirmed-speakers', version: 2 }),
    definitionDigestSha256: hex(3)
  })
});

function evidence(key: string, index: number) {
  return Object.freeze({
    evidenceRefId: `evidence-${key}`,
    evidenceVersion: 1,
    evidenceDigestSha256: hex(index)
  });
}

function candidate(index: number): OrganizerAudienceCandidate {
  const suffix = String(index).padStart(3, '0');
  return Object.freeze({
    subjectRefId: `assignment-${suffix}`,
    subjectVersion: 2,
    personRefId: `person-${suffix}`,
    contactRefId: `contact-${suffix}`,
    safeLabel: `Speaker ${suffix}`,
    membershipEvidence: evidence(`membership-${suffix}`, index + 1)
  });
}

function evaluatedAddress(
  member: OrganizerAudienceCandidate,
  index: number,
  override: {
    readonly contactRefId?: string;
    readonly lifecycle?: 'active' | 'revoked';
    readonly purpose?: 'allowed' | 'denied';
    readonly consent?: 'not_required' | 'granted' | 'missing' | 'withdrawn';
    readonly suppression?: 'clear' | 'suppressed';
    readonly doNotContact?: 'clear' | 'active';
    readonly email?: string;
  } = {}
): OrganizerAddressPolicyResolution {
  const suffix = String(index).padStart(3, '0');
  return Object.freeze({
    kind: 'evaluated',
    selectionPolicy: Object.freeze({
      reference: Object.freeze({ key: 'address.selection.event-email', version: 1 }),
      definitionDigestSha256: hex(4)
    }),
    address: Object.freeze({
      addressRefId: `address-${suffix}`,
      addressVersion: 4,
      contactRefId: override.contactRefId ?? member.contactRefId,
      channel: 'email',
      lifecycle: override.lifecycle ?? 'active',
      lifecycleEvidence: evidence(`address-lifecycle-${suffix}`, index + 2),
      lookupFingerprint: Object.freeze({
        profile: 'email.lookup.hmac',
        version: 2,
        keyedValue: hex(index + 3)
      }),
      classifiedValue: Object.freeze({
        payloadRefId: `payload-address-${suffix}`,
        payloadRefVersion: 1,
        classification: 'communication.contact.email',
        value: override.email ?? `speaker${index}@example.test`
      })
    }),
    purposeBasis: Object.freeze({
      state: override.purpose ?? 'allowed',
      evidence: evidence(`purpose-${suffix}`, index + 4)
    }),
    consent: Object.freeze({
      state: override.consent ?? 'not_required',
      evidence: evidence(`consent-${suffix}`, index + 5)
    }),
    suppression: Object.freeze({
      state: override.suppression ?? 'clear',
      evidence: evidence(`suppression-${suffix}`, index + 6)
    }),
    doNotContact: Object.freeze({
      state: override.doNotContact ?? 'clear',
      evidence: evidence(`do-not-contact-${suffix}`, index + 7)
    })
  });
}

function registeredAudience(): OrganizerCommunicationAudienceDraft {
  return Object.freeze({
    schemaVersion: 1,
    binding: 'current_snapshot',
    purposeRevision,
    source: registeredSource
  });
}

describe('organizer audience resolution', () => {
  test('resolves 41 eligible people and explicit ordinary exclusions with exact policy evidence', async () => {
    const candidates = Array.from({ length: 44 }, (_, index) => candidate(index));
    const addressFixtures: InMemoryOrganizerAddressPolicyFixture[] = candidates.map((member, index) => ({
      scope,
      contactRefId: member.contactRefId,
      result: index === 41
        ? { kind: 'no_eligible_address', evidence: evidence('no-address-041', 9) }
        : index === 42
          ? evaluatedAddress(member, index, { consent: 'missing' })
          : index === 43
            ? evaluatedAddress(member, index, { suppression: 'suppressed' })
            : evaluatedAddress(member, index, index < 2
              ? { email: 'shared@example.test' }
              : {})
    }));
    const source = createInMemoryOrganizerAudienceSourcePort([{
      scope,
      candidates: [...candidates].reverse(),
      sourceVersions: [
        { sourceKey: 'person.current', sourceVersion: 8, digestSha256: hex(10) },
        { sourceKey: 'assignment.current', sourceVersion: 12, digestSha256: hex(11) }
      ],
      registeredQueries: [registeredSource]
    }]);
    const snapshot = await resolveOrganizerAudience({
      scope,
      audience: registeredAudience(),
      asOf,
      source,
      addressPolicy: createInMemoryOrganizerAddressPolicyPort(addressFixtures)
    });

    expect(snapshot.members).toHaveLength(44);
    expect(snapshot.members.filter((member) => member.state === 'eligible')).toHaveLength(41);
    expect(snapshot.members.filter((member) => member.state === 'excluded').map((member) => member.reasonCode))
      .toEqual([
        ORGANIZER_AUDIENCE_EXCLUSION_REASONS.noEligibleAddress,
        ORGANIZER_AUDIENCE_EXCLUSION_REASONS.consentMissing,
        ORGANIZER_AUDIENCE_EXCLUSION_REASONS.suppressed
      ]);
    expect(snapshot.sourceVersions.map((version) => version.sourceKey))
      .toEqual(['assignment.current', 'person.current']);
    expect(snapshot.members[0]?.candidate.subjectRefId).toBe('assignment-000');
    expect(snapshot.members[1]?.candidate.subjectRefId).toBe('assignment-001');
    expect(snapshot.members[0]?.state).toBe('eligible');
    expect(snapshot.members[1]?.state).toBe('eligible');
    if (snapshot.members[0]?.state !== 'eligible' || snapshot.members[1]?.state !== 'eligible') {
      throw new Error('fixture mismatch');
    }
    expect(snapshot.members[0].address.classifiedValue.value).toBe('shared@example.test');
    expect(snapshot.members[1].address.classifiedValue.value).toBe('shared@example.test');
    expect(snapshot.members[0].candidate.personRefId).not.toBe(snapshot.members[1].candidate.personRefId);
    expect(snapshot.members[0].candidate.contactRefId).not.toBe(snapshot.members[1].candidate.contactRefId);
    expect(snapshot.members[0].evidence).toHaveLength(6);
    expect(snapshot.members[0].policyEvidence).toMatchObject({
      kind: 'evaluated',
      addressLifecycle: { state: 'active' },
      purposeBasis: { state: 'allowed' },
      consent: { state: 'not_required' },
      suppression: { state: 'clear' },
      doNotContact: { state: 'clear' }
    });
  });

  test('explicit contacts omit cross-scope refs without leaking a hidden row or count', async () => {
    const visible = candidate(1);
    const hidden = candidate(2);
    const source = createInMemoryOrganizerAudienceSourcePort([
      {
        scope,
        candidates: [visible],
        sourceVersions: [{ sourceKey: 'contact.current', sourceVersion: 1, digestSha256: hex(1) }]
      },
      {
        scope: otherScope,
        candidates: [hidden],
        sourceVersions: [{ sourceKey: 'contact.current', sourceVersion: 1, digestSha256: hex(1) }]
      }
    ]);
    const audience: OrganizerCommunicationAudienceDraft = {
      schemaVersion: 1,
      binding: 'current_snapshot',
      purposeRevision,
      source: {
        kind: 'explicit_contacts',
        contactRefIds: [visible.contactRefId, hidden.contactRefId].sort()
      }
    };
    const snapshot = await resolveOrganizerAudience({
      scope,
      audience,
      asOf,
      source,
      addressPolicy: createInMemoryOrganizerAddressPolicyPort([{
        scope,
        contactRefId: visible.contactRefId,
        result: evaluatedAddress(visible, 1)
      }])
    });

    expect(snapshot.members).toHaveLength(1);
    expect(snapshot.members[0]?.candidate.contactRefId).toBe(visible.contactRefId);
    expect(JSON.stringify(snapshot)).not.toContain(hidden.personRefId);
    expect(JSON.stringify(snapshot)).not.toContain(hidden.subjectRefId);
  });

  test('requires the exact registered recipe revision and digest', async () => {
    const member = candidate(1);
    const source = createInMemoryOrganizerAudienceSourcePort([{
      scope,
      candidates: [member],
      sourceVersions: [{ sourceKey: 'person.current', sourceVersion: 1, digestSha256: hex(1) }],
      registeredQueries: [registeredSource]
    }]);
    const changed = {
      ...registeredAudience(),
      source: { ...registeredSource, recipeDigestSha256: hex(15) }
    };
    await expect(resolveOrganizerAudience({
      scope,
      audience: changed,
      asOf,
      source,
      addressPolicy: createInMemoryOrganizerAddressPolicyPort([])
    })).rejects.toMatchObject({ code: 'source_not_registered' });
  });

  test('refuses an address selected for another contact even when the address value matches', async () => {
    const member = candidate(1);
    const source = createInMemoryOrganizerAudienceSourcePort([{
      scope,
      candidates: [member],
      sourceVersions: [{ sourceKey: 'person.current', sourceVersion: 1, digestSha256: hex(1) }],
      registeredQueries: [registeredSource]
    }]);
    const promise = resolveOrganizerAudience({
      scope,
      audience: registeredAudience(),
      asOf,
      source,
      addressPolicy: createInMemoryOrganizerAddressPolicyPort([{
        scope,
        contactRefId: member.contactRefId,
        result: evaluatedAddress(member, 1, {
          contactRefId: 'contact-unrelated',
          email: 'speaker1@example.test'
        })
      }])
    });
    await expect(promise).rejects.toBeInstanceOf(OrganizerAudienceResolutionError);
    await expect(promise).rejects.toMatchObject({ code: 'address_contact_mismatch' });
  });
});
