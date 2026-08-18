import { describe, expect, test } from 'bun:test';
import {
  ORGANIZER_COMMUNICATION_HISTORY_STATES,
  ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS,
  ORGANIZER_COMMUNICATION_PAGE_LIMIT,
  organizerCommunicationAudienceDraftSchema,
  organizerCommunicationAuthoringPayloadRefSchema,
  organizerCommunicationAuthoringPayloadInputSchema,
  organizerCommunicationDraftMutationResultSchema,
  organizerCommunicationDraftProjectionSchema,
  organizerCommunicationDraftSummarySchema,
  organizerCommunicationHistoryStateSchema,
  organizerCommunicationHistoryItemSchema,
  organizerCommunicationHistoryListInputSchema,
  organizerCommunicationPageInfoSchema,
  organizerCommunicationPurposePageSchema,
  organizerCommunicationRegisteredCountSchema,
  organizerCommunicationTimelinePageSchema,
  organizerCreateCommunicationDraftInputSchema,
  organizerEmailReadinessProjectionSchema,
  organizerMessageBatchPreviewDetailSchema,
  organizerMessagePreviewRecipientPageSchema,
  organizerMessagePreviewRecipientRowSchema,
  organizerMessagePreviewSummarySchema,
  organizerRecipientChannelProjectionSchema,
  type OrganizerCommunicationHistoryItem,
  type OrganizerMessagePreviewSummary
} from './organizer';

const digest = (value: string) => value.repeat(64);
const instant = '2026-08-13T00:00:00.000Z';

function definition(key: string, value = 'a') {
  return {
    reference: { key, version: 1 },
    definitionDigestSha256: digest(value)
  };
}

function purposeRevision() {
  return {
    purposeId: 'purpose-1',
    purposeKey: 'event.transactional',
    revisionId: 'purpose-revision-1',
    revisionNumber: 1,
    digestSha256: digest('1')
  };
}

function templateRevision() {
  return {
    templateId: 'template-1',
    templateRevisionId: 'template-revision-1',
    revisionNumber: 2,
    digestSha256: digest('2')
  };
}

function contentPayloadRef() {
  return {
    payloadRefId: 'payload-content-1',
    payloadRefVersion: 1,
    payloadKind: 'message_content' as const,
    schemaKey: 'communication.message-content',
    schemaVersion: 1,
    classification: 'communication.content'
  };
}

function audiencePayloadRef() {
  return {
    ...contentPayloadRef(),
    payloadRefId: 'payload-audience-1',
    payloadKind: 'message_audience_draft' as const,
    schemaKey: 'communication.message-audience'
  };
}

function previewIdentity() {
  return {
    audienceSpecId: 'audience-spec-1',
    draftId: 'draft-1',
    draftVersion: 3,
    previewGeneration: 4,
    previewDigestProfile: 'preview.digest',
    previewDigestVersion: 1,
    previewDigestSha256: digest('3')
  };
}

function previewSummary(): OrganizerMessagePreviewSummary {
  return {
    schemaVersion: 1,
    identity: previewIdentity(),
    purposeRevision: purposeRevision(),
    templateRevision: templateRevision(),
    counts: {
      visibleCandidateCount: 3,
      includedCount: 1,
      excludedCount: 1,
      blockedCount: 1
    },
    membershipDigestSha256: digest('4'),
    evidenceDigestSha256: digest('5'),
    reasonCodes: ['merge.required_missing', 'purpose.not_allowed'],
    sourceVersions: [
      { sourceKey: 'decision.current', sourceVersion: 7, digestSha256: digest('6') },
      { sourceKey: 'person.current', sourceVersion: 9, digestSha256: digest('7') }
    ],
    renderer: definition('email.renderer', '8'),
    mergeRegistry: definition('merge.registry', '9')
  };
}

function historyItem(state: OrganizerCommunicationHistoryItem['state']): OrganizerCommunicationHistoryItem {
  return {
    schemaVersion: 1,
    visibility: 'organizer_non_security',
    historyItemId: `history-${state}`,
    messageRefId: `message-${state}`,
    purposeRevision: purposeRevision(),
    templateRevision: templateRevision(),
    subject: 'Travel and arrival details',
    audienceLabel: 'Confirmed speakers',
    state,
    actor: { kind: 'human', displayLabel: 'Organizer' },
    cause: { summary: 'Prepared by an organizer' },
    counts: {
      audience: { knowledge: 'known', value: 3 },
      materialized: { knowledge: 'known', value: 3 },
      accepted: state === 'accepted'
        ? { knowledge: 'known', value: 3 }
        : { knowledge: 'unknown', reasonCode: 'provider.observation_absent' },
      delivered: state === 'delivered'
        ? { knowledge: 'known', value: 3 }
        : { knowledge: 'not_supported' },
      acceptanceUnknown: state === 'acceptance_unknown'
        ? { knowledge: 'known', value: 3 }
        : { knowledge: 'known', value: 0 },
      knownFailed: { knowledge: 'known', value: 0 }
    },
    authorizedAt: instant,
    availableActions: ['open_timeline']
  };
}

describe('organizer communication authoring contracts', () => {
  test('requires an exact purpose revision and explicit registered empty refs', () => {
    const valid = {
      channel: 'email' as const,
      purposeRevision: purposeRevision(),
      initial: {
        kind: 'registered_empty_refs' as const,
        contentRefId: 'je.communication.message-draft.empty-content/v1' as const,
        audienceRefId: 'je.communication.message-draft.empty-audience/v1' as const
      }
    };

    expect(organizerCreateCommunicationDraftInputSchema.parse(valid)).toEqual(valid);
    expect(() => organizerCreateCommunicationDraftInputSchema.parse({
      channel: 'email',
      initial: valid.initial
    })).toThrow();
    expect(() => organizerCreateCommunicationDraftInputSchema.parse({
      ...valid,
      initial: { ...valid.initial, contentRefId: 'caller-empty' }
    })).toThrow();
    expect(() => organizerCreateCommunicationDraftInputSchema.parse({
      ...valid,
      providerConnectionId: 'provider-1'
    })).toThrow();
  });

  test('normalizes bounded message authoring but rejects unknown payload shapes', () => {
    const parsed = organizerCommunicationAuthoringPayloadInputSchema.parse({
      payloadKind: 'message_content',
      schemaVersion: 1,
      value: {
        kind: 'email/v1',
        subject: '  Travel   details  ',
        body: { kind: 'plain_text/v1', text: 'Hello\r\nworld' }
      }
    });
    expect(parsed.payloadKind).toBe('message_content');
    if (parsed.payloadKind !== 'message_content') throw new Error('Expected message content.');
    expect(parsed.value.subject).toBe('Travel details');
    expect(parsed.value.body).toEqual({ kind: 'plain_text/v1', text: 'Hello\nworld' });

    expect(() => organizerCommunicationAuthoringPayloadInputSchema.parse({
      payloadKind: 'message_content',
      schemaVersion: 1,
      value: {
        kind: 'email/v1',
        subject: 'Hello',
        body: { kind: 'html', value: '<script>run()</script>' }
      }
    })).toThrow();
  });

  test('keeps classified authoring refs opaque and version-guarded', () => {
    const contentRef = contentPayloadRef();
    const audienceRef = audiencePayloadRef();

    expect(organizerCommunicationAuthoringPayloadRefSchema.parse(contentRef)).toEqual(contentRef);
    expect(() => organizerCommunicationAuthoringPayloadRefSchema.parse({
      ...contentRef,
      digestSha256: digest('a')
    })).toThrow();
    expect(() => organizerCommunicationAuthoringPayloadRefSchema.parse({
      ...contentRef,
      canonicalByteLength: 64
    })).toThrow();

    const mutation = {
      schemaVersion: 1 as const,
      draftId: 'draft-1',
      version: 2,
      state: 'active' as const,
      authoring: {
        state: 'ready' as const,
        subject: 'Travel details',
        contentPayload: contentRef,
        audiencePayload: audienceRef,
        recipientEstimate: { knowledge: 'unknown' as const, reasonCode: 'audience.not_resolved' }
      },
      nextRead: { operationName: 'get_message_draft' as const, draftId: 'draft-1', expectedVersion: 2 }
    };
    expect(organizerCommunicationDraftMutationResultSchema.parse(mutation)).toEqual(mutation);
    expect(() => organizerCommunicationDraftMutationResultSchema.parse({
      ...mutation,
      contentDigestSha256: digest('b')
    })).toThrow();
  });

  test('represents registered empty drafts explicitly without invented authoring facts', () => {
    const summary = {
      schemaVersion: 1 as const,
      draftId: 'draft-empty-1',
      version: 1,
      state: 'active' as const,
      channel: 'email' as const,
      purposeRevision: purposeRevision(),
      provenance: { kind: 'human' as const },
      updatedAt: instant,
      authoring: {
        state: 'uninitialized' as const,
        contentRefId: 'je.communication.message-draft.empty-content/v1' as const,
        audienceRefId: 'je.communication.message-draft.empty-audience/v1' as const
      }
    };
    const projection = {
      ...summary,
      allowedNextActions: ['revise', 'discard'] as Array<'revise' | 'discard'>
    };

    expect(organizerCommunicationDraftSummarySchema.parse(summary)).toEqual(summary);
    expect(organizerCommunicationDraftProjectionSchema.parse(projection)).toEqual(projection);
    expect('subject' in summary.authoring).toBe(false);
    expect('content' in projection).toBe(false);
    expect('audience' in projection).toBe(false);
    expect(() => organizerCommunicationDraftProjectionSchema.parse({
      ...projection,
      content: { kind: 'email/v1', subject: 'Fabricated', body: { kind: 'plain_text/v1', text: '' } }
    })).toThrow();
    expect(() => organizerCommunicationDraftProjectionSchema.parse({
      ...projection,
      allowedNextActions: ['revise', 'preview', 'discard', 'propose']
    })).toThrow();
    expect(() => organizerCommunicationDraftSummarySchema.parse({
      ...summary,
      state: 'proposed'
    })).toThrow();
  });

  test('requires ready drafts to carry exact parsed content and audience', () => {
    const audience = {
      schemaVersion: 1 as const,
      binding: 'current_snapshot' as const,
      purposeRevision: purposeRevision(),
      source: { kind: 'explicit_contacts' as const, contactRefIds: ['person-1'] }
    };
    const summary = {
      schemaVersion: 1 as const,
      draftId: 'draft-ready-1',
      version: 2,
      state: 'active' as const,
      channel: 'email' as const,
      purposeRevision: purposeRevision(),
      provenance: { kind: 'human' as const },
      updatedAt: instant,
      authoring: {
        state: 'ready' as const,
        subject: 'Travel details',
        recipientEstimate: { knowledge: 'unknown' as const, reasonCode: 'audience.not_resolved' },
        contentPayload: contentPayloadRef(),
        audiencePayload: audiencePayloadRef()
      }
    };
    const projection = {
      ...summary,
      content: { kind: 'email/v1' as const, subject: 'Travel details', body: { kind: 'plain_text/v1' as const, text: '' } },
      audience,
      allowedNextActions: ['revise', 'preview', 'discard', 'propose'] as Array<
        'revise' | 'preview' | 'discard' | 'propose'
      >
    };
    expect(organizerCommunicationDraftProjectionSchema.parse(projection)).toEqual(projection);
    expect(() => organizerCommunicationDraftProjectionSchema.parse({
      ...projection,
      content: undefined
    })).toThrow();
    expect(() => organizerCommunicationDraftProjectionSchema.parse({
      ...projection,
      authoring: {
        state: 'uninitialized',
        contentRefId: 'je.communication.message-draft.empty-content/v1',
        audienceRefId: 'je.communication.message-draft.empty-audience/v1'
      }
    })).toThrow();
  });

  test('permits only explicit contacts or a registered current-snapshot recipe', () => {
    const explicit = {
      schemaVersion: 1 as const,
      binding: 'current_snapshot' as const,
      purposeRevision: purposeRevision(),
      source: {
        kind: 'explicit_contacts' as const,
        contactRefIds: ['person-1', 'person-2']
      }
    };
    expect(organizerCommunicationAudienceDraftSchema.parse(explicit)).toEqual(explicit);
    expect(() => organizerCommunicationAudienceDraftSchema.parse({
      ...explicit,
      source: { ...explicit.source, contactRefIds: ['person-2', 'person-1'] }
    })).toThrow();
    expect(() => organizerCommunicationAudienceDraftSchema.parse({
      ...explicit,
      source: { kind: 'sql', query: 'select * from people' }
    })).toThrow();
  });
});

describe('organizer communication exact preview contracts', () => {
  test('binds rendered content to the full preview and opaque recipient identity', () => {
    const value = {
      schemaVersion: 1 as const,
      summary: previewSummary(),
      selected: {
        kind: 'rendered_email' as const,
        render: {
          recipientResolutionId: 'rr1_abcdefghijklmnop',
          releaseId: 'release-1',
          releaseDigestSha256: digest('a'),
          outputDigestSha256: digest('b'),
          resolvedInputDigestSha256: digest('c'),
          attachmentManifestDigestSha256: digest('d'),
          renderer: definition('email.renderer', '8'),
          mergeRegistry: definition('merge.registry', '9'),
          subject: 'Travel and arrival details',
          sanitizedHtml: '<p>Hello</p>',
          plainText: 'Hello',
          attachments: [],
          warningCodes: []
        }
      }
    };

    expect(organizerMessageBatchPreviewDetailSchema.parse(value)).toEqual(value);
    expect(() => organizerMessageBatchPreviewDetailSchema.parse({
      ...value,
      summary: {
        ...value.summary,
        identity: { ...value.summary.identity, previewDigestSha256: undefined }
      }
    })).toThrow();
    expect(() => organizerMessageBatchPreviewDetailSchema.parse({
      ...value,
      selected: {
        ...value.selected,
        render: { ...value.selected.render, recipientResolutionId: 'person@example.test' }
      }
    })).toThrow();
  });

  test('keeps masked contact data masked and rejects email-shaped identity fields', () => {
    const row = {
      recipientResolutionId: 'rr1_abcdefghijklmnop',
      safeLabel: 'M. Tan',
      channel: { disclosure: 'masked' as const, maskedValue: 'm•••@example.test' },
      mergeFallbackFieldKeys: [],
      state: 'included' as const,
      releaseId: 'release-1',
      releaseDigestSha256: digest('a')
    };
    const parsed = organizerMessagePreviewRecipientRowSchema.parse(row);
    expect(parsed.channel.disclosure).toBe('masked');
    expect('exactValue' in parsed.channel).toBe(false);
    expect('email' in parsed).toBe(false);

    expect(() => organizerRecipientChannelProjectionSchema.parse({
      disclosure: 'masked',
      maskedValue: 'm•••@example.test',
      exactValue: 'maya@example.test'
    })).toThrow();
    expect(() => organizerMessagePreviewRecipientRowSchema.parse({
      ...row,
      email: 'maya@example.test'
    })).toThrow();
  });

  test('keeps absent exact contact facts absent instead of neutralizing them', () => {
    const parsed = organizerRecipientChannelProjectionSchema.parse({
      disclosure: 'absent',
      reasonCode: 'address.not_eligible'
    });
    expect(parsed).toEqual({ disclosure: 'absent', reasonCode: 'address.not_eligible' });
    expect('maskedValue' in parsed).toBe(false);
    expect('exactValue' in parsed).toBe(false);

    expect(organizerCommunicationRegisteredCountSchema.parse({
      knowledge: 'unknown', reasonCode: 'provider.observation_absent'
    })).toEqual({ knowledge: 'unknown', reasonCode: 'provider.observation_absent' });
    expect(() => organizerCommunicationRegisteredCountSchema.parse({
      knowledge: 'unknown', value: 0, reasonCode: 'provider.observation_absent'
    })).toThrow();
  });

  test('requires coherent preview counts and canonical evidence order', () => {
    expect(organizerMessagePreviewSummarySchema.parse(previewSummary())).toEqual(previewSummary());
    expect(() => organizerMessagePreviewSummarySchema.parse({
      ...previewSummary(),
      counts: { ...previewSummary().counts, includedCount: 2 }
    })).toThrow();
    expect(() => organizerMessagePreviewSummarySchema.parse({
      ...previewSummary(),
      sourceVersions: [...previewSummary().sourceVersions].reverse()
    })).toThrow();
  });

  test('bounds recipient pages and refuses duplicate rows', () => {
    const row = {
      recipientResolutionId: 'rr1_abcdefghijklmnop',
      safeLabel: 'M. Tan',
      channel: { disclosure: 'absent' as const, reasonCode: 'address.not_eligible' },
      mergeFallbackFieldKeys: [],
      state: 'excluded' as const,
      reasonCode: 'address.not_eligible'
    };
    expect(() => organizerMessagePreviewRecipientPageSchema.parse({
      schemaVersion: 1,
      identity: previewIdentity(),
      rows: [row, row],
      page: { hasMore: false }
    })).toThrow();
  });
});

describe('organizer communication history and readiness truth', () => {
  test('freezes one unique accepted history-state vocabulary', () => {
    expect(ORGANIZER_COMMUNICATION_HISTORY_STATES).toEqual([
      'authorized',
      'blocked_provider_not_ready',
      'deferred',
      'materialized',
      'attempting',
      'accepted',
      'delivered',
      'delayed',
      'known_failed',
      'acceptance_unknown',
      'abandoned',
      'dead_lettered',
      'cancelled_before_attempt',
      'cancelled',
      'cancelled_before_materialization',
      'expired',
      'stale',
      'revoked'
    ]);
    expect(new Set(ORGANIZER_COMMUNICATION_HISTORY_STATES).size)
      .toBe(ORGANIZER_COMMUNICATION_HISTORY_STATES.length);
    for (const state of ORGANIZER_COMMUNICATION_HISTORY_STATES) {
      expect(organizerCommunicationHistoryStateSchema.parse(state)).toBe(state);
    }
    expect(() => organizerCommunicationHistoryStateSchema.parse('bounced')).toThrow();
    expect(() => organizerCommunicationHistoryStateSchema.parse('sent')).toThrow();
  });

  test('keeps accepted, delivered, and acceptance-unknown as distinct facts', () => {
    const accepted = organizerCommunicationHistoryItemSchema.parse(historyItem('accepted'));
    const delivered = organizerCommunicationHistoryItemSchema.parse(historyItem('delivered'));
    const ambiguous = organizerCommunicationHistoryItemSchema.parse(historyItem('acceptance_unknown'));

    expect(accepted.state).toBe('accepted');
    expect(accepted.counts.delivered).toEqual({ knowledge: 'not_supported' });
    expect(delivered.state).toBe('delivered');
    expect(delivered.counts.delivered).toEqual({ knowledge: 'known', value: 3 });
    expect(ambiguous.state).toBe('acceptance_unknown');
    expect(ambiguous.counts.acceptanceUnknown).toEqual({ knowledge: 'known', value: 3 });
    expect(() => organizerCommunicationHistoryItemSchema.parse({
      ...historyItem('known_failed'),
      state: 'bounced'
    })).toThrow();
  });

  test('fixes callbacks to not-supported and inbound to not-enabled', () => {
    const readiness = {
      schemaVersion: 1 as const,
      provider: {
        adapterKey: 'cloudflare.email',
        adapterVersion: 'v1',
        displayName: 'Cloudflare Email Sending'
      },
      outbound: {
        state: 'ready' as const,
        connectionRevisionId: 'connection-revision-1',
        evidence: {
          evidenceId: 'evidence-1',
          registeredCode: 'outbound.ready',
          digestSha256: digest('e'),
          observedAt: instant
        },
        validUntil: '2026-08-14T00:00:00.000Z'
      },
      callbacks: { state: 'not_supported' as const },
      inbound: { state: 'not_enabled' as const }
    };
    expect(organizerEmailReadinessProjectionSchema.parse(readiness)).toEqual(readiness);
    expect(() => organizerEmailReadinessProjectionSchema.parse({
      ...readiness,
      callbacks: { state: 'ready', deliveredCount: 3 }
    })).toThrow();
    expect(() => organizerEmailReadinessProjectionSchema.parse({
      ...readiness,
      inbound: { state: 'ready' }
    })).toThrow();
    expect(() => organizerEmailReadinessProjectionSchema.parse({
      schemaVersion: 1,
      outbound: { state: 'ready', connectionRevisionId: 'connection-1',
        evidence: readiness.outbound.evidence, validUntil: readiness.outbound.validUntil },
      callbacks: { state: 'not_supported' },
      inbound: { state: 'not_enabled' }
    })).toThrow();
  });

  test('organizer reads cannot request security mail or a fabricated bounce tray', () => {
    expect(organizerCommunicationHistoryListInputSchema.parse({})).toEqual({});
    expect(() => organizerCommunicationHistoryListInputSchema.parse({ includeSecurityMail: true }))
      .toThrow();
    expect(() => organizerCommunicationHistoryListInputSchema.parse({ state: 'bounced' })).toThrow();
  });

  test('timeline facts are immutable ordered safe summaries', () => {
    const base = {
      schemaVersion: 1 as const,
      visibility: 'organizer_non_security' as const,
      deliveryId: 'delivery-1',
      currentState: 'accepted' as const,
      rows: [
        { factId: 'fact-1', sequence: 1, occurredAt: instant, kind: 'attempt_started' as const,
          actor: { kind: 'human' as const, displayLabel: 'Organizer' },
          summaryCode: 'attempt.started' },
        { factId: 'fact-2', sequence: 2, occurredAt: instant, kind: 'provider_accepted' as const,
          actor: { kind: 'human' as const, displayLabel: 'Organizer' },
          summaryCode: 'provider.accepted', evidenceDigestSha256: digest('f') }
      ],
      page: { hasMore: false as const }
    };
    expect(organizerCommunicationTimelinePageSchema.parse(base)).toEqual(base);
    expect(() => organizerCommunicationTimelinePageSchema.parse({
      ...base,
      rows: [...base.rows].reverse()
    })).toThrow();
    expect(() => organizerCommunicationTimelinePageSchema.parse({
      ...base,
      rows: [{ ...base.rows[0], rawProviderResponse: '250 OK' }]
    })).toThrow();
  });
});

describe('organizer communication pagination and schema identities', () => {
  test('requires a cursor exactly when another bounded page exists', () => {
    expect(organizerCommunicationPageInfoSchema.parse({ hasMore: false })).toEqual({ hasMore: false });
    expect(() => organizerCommunicationPageInfoSchema.parse({ hasMore: false, nextCursor: 'cur1_abcdefgh' }))
      .toThrow();
    expect(() => organizerCommunicationPageInfoSchema.parse({ hasMore: true })).toThrow();
    expect(organizerCommunicationPageInfoSchema.parse({
      hasMore: true, nextCursor: 'cur1_abcdefgh'
    })).toEqual({ hasMore: true, nextCursor: 'cur1_abcdefgh' });
  });

  test('hard-bounds organizer page rows', () => {
    const row = {
      schemaVersion: 1 as const,
      revision: purposeRevision(),
      label: 'Transactional message',
      channel: 'email' as const,
      communicationClass: 'event.transactional',
      lifecycle: 'active' as const,
      policyDigestSha256: digest('a')
    };
    expect(organizerCommunicationPurposePageSchema.parse({
      schemaVersion: 1,
      rows: Array.from({ length: ORGANIZER_COMMUNICATION_PAGE_LIMIT }, () => ({ ...row })),
      page: { hasMore: false }
    }).rows).toHaveLength(ORGANIZER_COMMUNICATION_PAGE_LIMIT);
    expect(() => organizerCommunicationPurposePageSchema.parse({
      schemaVersion: 1,
      rows: Array.from({ length: ORGANIZER_COMMUNICATION_PAGE_LIMIT + 1 }, () => ({ ...row })),
      page: { hasMore: false }
    })).toThrow();
  });

  test('publishes stable exact refs without a direct-send or bounce operation', () => {
    const refs = ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS;
    expect(Object.keys(refs)).toEqual([
      'listPurposes',
      'getPurpose',
      'listTemplates',
      'getTemplate',
      'listAudienceOptions',
      'listDrafts',
      'getDraft',
      'storeAuthoringPayload',
      'createDraft',
      'createTemplate',
      'reviseDraft',
      'discardDraft',
      'previewBatch',
      'sendMessages',
      'prepareBatchPreview',
      'getPreview',
      'listPreviewRecipients',
      'getHistory',
      'listAttention',
      'getThread',
      'getTimeline',
      'getReadiness'
    ]);
    expect('send' in refs).toBe(false);
    expect('resendBounced' in refs).toBe(false);
    for (const operation of Object.values(refs)) {
      expect(operation.inputSchema.key).toMatch(/^schema\.communication\.organizer\./);
      expect(operation.resultSchema.key).toMatch(/^schema\.communication\.organizer\./);
      expect(operation.inputSchema.digestSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(operation.resultSchema.digestSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
