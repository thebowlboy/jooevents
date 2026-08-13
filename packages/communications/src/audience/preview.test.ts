import { describe, expect, test } from 'bun:test';
import {
  ORGANIZER_COMMUNICATION_RECIPIENT_LIMIT,
  organizerMessageBatchPreviewDetailSchema,
  organizerMessagePreviewRecipientPageSchema,
  type OrganizerCommunicationAudienceDraft
} from '@jooevents/contracts/communications/organizer';
import { parseEventId, parseWorkspaceId } from '@jooevents/kernel';
import {
  createHmacOrganizerPreviewOpaqueTokenCodec,
  createDeterministicOrganizerPreviewRenderPort,
  getOrganizerMessageBatchPreview,
  isOrganizerMessageBatchPreviewCurrent,
  listOrganizerMessagePreviewRecipients,
  prepareOrganizerMessageBatchPreview,
  type OrganizerPrepareMessageBatchPreviewInput,
  type OrganizerPreviewDraft
} from './preview';
import {
  createInMemoryOrganizerAddressPolicyPort,
  createInMemoryOrganizerAudienceSourcePort,
  type InMemoryOrganizerAddressPolicyFixture,
  type OrganizerAddressPolicyResolution,
  type OrganizerAudienceCandidate,
  type OrganizerAudienceScope
} from './resolution';

const scope: OrganizerAudienceScope = Object.freeze({
  workspaceId: parseWorkspaceId('01890f47-9abc-7def-8123-456789abcdef'),
  eventId: parseEventId('01890f47-9abc-7def-9234-56789abcdef0')
});
const hex = (index: number) => (index % 16).toString(16).repeat(64);
const now = '2026-08-13T00:00:00.000Z';
const purposeRevision = Object.freeze({
  purposeId: 'purpose-event-transactional',
  purposeKey: 'event.transactional',
  revisionId: 'purpose-event-transactional-r1',
  revisionNumber: 1,
  digestSha256: hex(1)
});
const templateRevision = Object.freeze({
  templateId: 'template-reminder',
  templateRevisionId: 'template-reminder-r2',
  revisionNumber: 2,
  digestSha256: hex(2)
});
const sourceDefinition = Object.freeze({
  reference: Object.freeze({ key: 'audience.task-assignees', version: 1 }),
  definitionDigestSha256: hex(3)
});
const registeredSource = Object.freeze({
  kind: 'registered_query' as const,
  recipeId: 'recipe-task-assignees',
  recipeVersion: 7,
  recipeDigestSha256: hex(4),
  sourceDefinition
});
const audience: OrganizerCommunicationAudienceDraft = Object.freeze({
  schemaVersion: 1,
  binding: 'current_snapshot',
  purposeRevision,
  source: registeredSource
});
const draft: OrganizerPreviewDraft = Object.freeze({
  draftId: 'draft-task-reminder',
  version: 3,
  purposeRevision,
  templateRevision,
  audience
});
const renderer = Object.freeze({
  reference: Object.freeze({ key: 'email.renderer', version: 1 }),
  definitionDigestSha256: hex(5)
});
const mergeRegistry = Object.freeze({
  reference: Object.freeze({ key: 'merge.registry', version: 1 }),
  definitionDigestSha256: hex(6)
});
const digestProfile = Object.freeze({ key: 'preview.digest', version: 1 });
const opaqueTokens = createHmacOrganizerPreviewOpaqueTokenCodec({
  keyBytes: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
  profile: { key: 'preview.opaque-id', version: 1 }
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
    subjectVersion: 3,
    personRefId: `person-${suffix}`,
    contactRefId: `contact-${suffix}`,
    safeLabel: `Speaker ${suffix}`,
    membershipEvidence: evidence(`membership-${suffix}`, index + 1)
  });
}

function evaluatedAddress(
  member: OrganizerAudienceCandidate,
  index: number,
  options: {
    readonly consent?: 'not_required' | 'granted' | 'missing' | 'withdrawn';
    readonly suppression?: 'clear' | 'suppressed';
    readonly email?: string;
    readonly addressVersion?: number;
    readonly consentEvidenceIndex?: number;
  } = {}
): OrganizerAddressPolicyResolution {
  const suffix = String(index).padStart(3, '0');
  return Object.freeze({
    kind: 'evaluated',
    selectionPolicy: Object.freeze({
      reference: Object.freeze({ key: 'address.selection.event-email', version: 1 }),
      definitionDigestSha256: hex(7)
    }),
    address: Object.freeze({
      addressRefId: `address-${suffix}`,
      addressVersion: options.addressVersion ?? 2,
      contactRefId: member.contactRefId,
      channel: 'email',
      lifecycle: 'active',
      lifecycleEvidence: evidence(`address-${suffix}`, index + 2),
      lookupFingerprint: Object.freeze({
        profile: 'email.lookup.hmac',
        version: 1,
        keyedValue: hex(index + 3)
      }),
      classifiedValue: Object.freeze({
        payloadRefId: `payload-address-${suffix}`,
        payloadRefVersion: 1,
        classification: 'communication.contact.email',
        value: options.email ?? `speaker${index}@example.test`
      })
    }),
    purposeBasis: Object.freeze({ state: 'allowed', evidence: evidence(`purpose-${suffix}`, index + 4) }),
    consent: Object.freeze({
      state: options.consent ?? 'not_required',
      evidence: evidence(`consent-${suffix}`, options.consentEvidenceIndex ?? index + 5)
    }),
    suppression: Object.freeze({
      state: options.suppression ?? 'clear',
      evidence: evidence(`suppression-${suffix}`, index + 6)
    }),
    doNotContact: Object.freeze({ state: 'clear', evidence: evidence(`dnc-${suffix}`, index + 7) })
  });
}

function preparation(candidates: readonly OrganizerAudienceCandidate[], options: {
  readonly addressFixtures?: readonly InMemoryOrganizerAddressPolicyFixture[];
  readonly renderBlockedSubject?: string;
  readonly sourceVersion?: number;
} = {}): OrganizerPrepareMessageBatchPreviewInput {
  const addressFixtures = options.addressFixtures ?? candidates.map((member, index) => ({
    scope,
    contactRefId: member.contactRefId,
    result: evaluatedAddress(member, index)
  }));
  return {
    scope,
    draft,
    previewGeneration: 4,
    digestProfile,
    renderer,
    mergeRegistry,
    asOf: now,
    source: createInMemoryOrganizerAudienceSourcePort([{
      scope,
      candidates,
      sourceVersions: [
        { sourceKey: 'assignment.current', sourceVersion: options.sourceVersion ?? 12, digestSha256: hex(8) },
        { sourceKey: 'person.current', sourceVersion: 9, digestSha256: hex(9) }
      ],
      registeredQueries: [registeredSource]
    }]),
    addressPolicy: createInMemoryOrganizerAddressPolicyPort(addressFixtures),
    opaqueTokens,
    render: createDeterministicOrganizerPreviewRenderPort(candidates.map((member, index) => ({
      subjectRefId: member.subjectRefId,
      outcome: options.renderBlockedSubject === member.subjectRefId
        ? { kind: 'blocked', reasonCode: 'merge.required_missing' }
        : {
            kind: 'rendered',
            subject: `Reminder for ${member.safeLabel}`,
            sanitizedHtml: `<div data-jooevents-email="v1"><p>Hello ${member.safeLabel}</p></div>`,
            plainText: `Hello ${member.safeLabel}`,
            mergeFallbackFieldKeys: index === 0 ? ['event.title'] : []
          }
    })))
  };
}

function exactQuery(snapshot: Awaited<ReturnType<typeof prepareOrganizerMessageBatchPreview>>) {
  return { ...snapshot.summary.identity };
}

describe('organizer exact message-batch preview', () => {
  test('builds a deterministic 41-included snapshot with opaque identities and no plain email in summary', async () => {
    const candidates = Array.from({ length: 41 }, (_, index) => candidate(index));
    const addresses = candidates.map((member, index) => ({
      scope,
      contactRefId: member.contactRefId,
      result: evaluatedAddress(member, index, index < 2 ? { email: 'shared@example.test' } : {})
    }));
    const first = await prepareOrganizerMessageBatchPreview(preparation(candidates, { addressFixtures: addresses }));
    const second = await prepareOrganizerMessageBatchPreview(preparation(candidates, { addressFixtures: addresses }));

    expect(first.summary).toEqual(second.summary);
    expect(first.summary.counts).toEqual({
      visibleCandidateCount: 41,
      includedCount: 41,
      excludedCount: 0,
      blockedCount: 0
    });
    expect(new Set(first.rows.map((row) => row.recipientResolutionId)).size).toBe(41);
    expect(first.rows[0]?.recipientResolutionId).toMatch(/^rr1_[0-9a-f]{40}$/);
    expect(first.rows[1]?.recipientResolutionId).not.toBe(first.rows[0]?.recipientResolutionId);
    expect(JSON.stringify(first.summary)).not.toContain('shared@example.test');
    expect(JSON.stringify(first.summary)).not.toContain('speaker0@example.test');
    expect(first.rows[0]?.candidate.personRefId).not.toBe(first.rows[1]?.candidate.personRefId);
    expect(first.rows[0]?.mergeFallbackFieldKeys).toEqual(['event.title']);
  });

  test('keeps exclusions and render blocks factual and sums visible counts exactly', async () => {
    const candidates = Array.from({ length: 5 }, (_, index) => candidate(index));
    const addressFixtures: InMemoryOrganizerAddressPolicyFixture[] = candidates.map((member, index) => ({
      scope,
      contactRefId: member.contactRefId,
      result: index === 3
        ? { kind: 'no_eligible_address', evidence: evidence('no-address', 10) }
        : evaluatedAddress(member, index)
    }));
    const snapshot = await prepareOrganizerMessageBatchPreview(preparation(candidates, {
      addressFixtures,
      renderBlockedSubject: candidates[4]!.subjectRefId
    }));

    expect(snapshot.summary.counts).toEqual({
      visibleCandidateCount: 5,
      includedCount: 3,
      excludedCount: 1,
      blockedCount: 1
    });
    expect(snapshot.summary.reasonCodes).toEqual(['address.no_eligible', 'merge.required_missing']);
    expect(snapshot.rows.map((row) => row.state)).toEqual([
      'included', 'included', 'included', 'excluded', 'blocked'
    ]);
  });

  test('requires every exact tuple field and only exposes a selected included render', async () => {
    const snapshot = await prepareOrganizerMessageBatchPreview(preparation([candidate(1), candidate(2)]));
    const summaryOnly = getOrganizerMessageBatchPreview({ snapshot, query: exactQuery(snapshot) });
    expect(organizerMessageBatchPreviewDetailSchema.parse(summaryOnly).selected).toEqual({ kind: 'none' });
    const selected = getOrganizerMessageBatchPreview({
      snapshot,
      query: {
        ...exactQuery(snapshot),
        selectedRecipientResolutionId: snapshot.rows[0]!.recipientResolutionId
      }
    });
    expect(selected.selected.kind).toBe('rendered_email');
    if (selected.selected.kind !== 'rendered_email') throw new Error('fixture mismatch');
    expect(selected.selected.render.plainText).toContain('Speaker 001');

    for (const [field, value] of [
      ['audienceSpecId', 'audience-other'],
      ['draftId', 'draft-other'],
      ['draftVersion', 99],
      ['previewGeneration', 99],
      ['previewDigestProfile', 'preview.other'],
      ['previewDigestVersion', 99],
      ['previewDigestSha256', hex(15)]
    ] as const) {
      expect(() => getOrganizerMessageBatchPreview({
        snapshot,
        query: { ...exactQuery(snapshot), [field]: value }
      })).toThrow('stale_preview');
    }

    expect(() => getOrganizerMessageBatchPreview({
      snapshot,
      query: {
        ...exactQuery(snapshot),
        selectedRecipientResolutionId: 'rr1_0000000000000000000000000000000000000000'
      }
    })).toThrow('recipient_not_available');
  });

  test('pages within the 200-row bound, masks by default, and binds cursor to exact query/disclosure', async () => {
    const candidates = Array.from({ length: ORGANIZER_COMMUNICATION_RECIPIENT_LIMIT + 5 },
      (_, index) => candidate(index));
    const snapshot = await prepareOrganizerMessageBatchPreview(preparation(candidates));
    const first = listOrganizerMessagePreviewRecipients({
      snapshot,
      query: { ...exactQuery(snapshot), limit: ORGANIZER_COMMUNICATION_RECIPIENT_LIMIT },
      opaqueTokens
    });
    expect(organizerMessagePreviewRecipientPageSchema.parse(first).rows).toHaveLength(200);
    expect(first.page.hasMore).toBe(true);
    expect(first.rows[0]?.channel.disclosure).toBe('masked');
    expect(JSON.stringify(first.rows[0]?.channel)).not.toContain('speaker0@example.test');
    if (!first.page.hasMore) throw new Error('fixture mismatch');
    const nextCursor = first.page.nextCursor;
    const second = listOrganizerMessagePreviewRecipients({
      snapshot,
      query: {
        ...exactQuery(snapshot),
        cursor: nextCursor,
        limit: ORGANIZER_COMMUNICATION_RECIPIENT_LIMIT
      },
      opaqueTokens
    });
    expect(second.rows).toHaveLength(5);
    expect(second.page).toEqual({ hasMore: false });
    expect(() => listOrganizerMessagePreviewRecipients({
      snapshot,
      query: { ...exactQuery(snapshot), cursor: nextCursor },
      disclosure: 'exact_authorized',
      opaqueTokens
    })).toThrow('invalid_cursor');

    const exact = listOrganizerMessagePreviewRecipients({
      snapshot,
      query: { ...exactQuery(snapshot), limit: 1 },
      disclosure: 'exact_authorized',
      opaqueTokens
    });
    expect(exact.rows[0]?.channel.disclosure).toBe('exact_authorized');
    if (exact.rows[0]?.channel.disclosure !== 'exact_authorized') throw new Error('fixture mismatch');
    expect(exact.rows[0].channel.exactValue).toBe('speaker0@example.test');
  });

  test('changed source membership or address version makes the exact preview stale', async () => {
    const members = [candidate(1), candidate(2)];
    const expectedInput = preparation(members);
    const expected = await prepareOrganizerMessageBatchPreview(expectedInput);
    expect(await isOrganizerMessageBatchPreviewCurrent({
      expected,
      current: preparation(members)
    })).toBe(true);
    expect(await isOrganizerMessageBatchPreviewCurrent({
      expected,
      current: preparation(members, { sourceVersion: 13 })
    })).toBe(false);

    const changedAddress: InMemoryOrganizerAddressPolicyFixture[] = members.map((member, index) => ({
      scope,
      contactRefId: member.contactRefId,
      result: evaluatedAddress(member, index, {
        addressVersion: index === 0 ? 3 : 2
      })
    }));
    expect(await isOrganizerMessageBatchPreviewCurrent({
      expected,
      current: preparation(members, { addressFixtures: changedAddress })
    })).toBe(false);

    const changedConsentEvidence: InMemoryOrganizerAddressPolicyFixture[] = members.map((member, index) => ({
      scope,
      contactRefId: member.contactRefId,
      result: evaluatedAddress(member, index, {
        consentEvidenceIndex: index === 0 ? 14 : index + 5
      })
    }));
    expect(await isOrganizerMessageBatchPreviewCurrent({
      expected,
      current: preparation(members, { addressFixtures: changedConsentEvidence })
    })).toBe(false);
  });
});
