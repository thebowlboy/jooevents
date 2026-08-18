import { describe, expect, test } from 'bun:test';
import {
  FAKE_CALLBACK_VERIFICATION_CONTRACT_VERSION,
  FAKE_CALLBACK_VERIFIER_CONTEXT,
  FAKE_CALLBACK_VERIFIER_KEY,
  FAKE_CALLBACK_VERIFIER_VERSION,
  FAKE_EMAIL_ADAPTER_KEY,
  FAKE_EMAIL_ADAPTER_VERSION,
  FAKE_EMAIL_SETUP_MANIFEST,
  FAKE_PROVIDER_SCENARIO_KEYS,
  FAKE_SAFE_EVIDENCE_CATALOG,
  createDeterministicFakeEmailProvider,
  createFakeDiagnosticSubmission,
  createFakeEmailEnvelope,
  createFakeOrdinarySubmission,
  createFakeProviderCallbackFixture
} from './fake';
import { createEmailCallbackVerifierRegistry } from './callback-verifier-registry';
import { createSafeEvidence } from './outcomes';
import {
  computeReviewedEmailEnvelopeDigestSha256,
  createEmailSubmissionPreparer,
  type CallbackVerifierCandidate,
  type CallbackVerifierCandidateSet,
  type PreparedEmailSubmission
} from './port';

const digest = 'a'.repeat(64);

function envelope() {
  return createFakeEmailEnvelope({
    from: 'organizer@example.test',
    to: 'speaker@example.test'
  });
}

function ordinaryLookupInput(scenario: string) {
  return {
    contractVersion: 1 as const,
    deliveryAttemptId: 'attempt_lookup_1',
    providerConnectionRevisionId: 'connection_revision_fake_v1',
    adapterKey: FAKE_EMAIL_ADAPTER_KEY,
    adapterVersion: FAKE_EMAIL_ADAPTER_VERSION,
    externalDeliveryKey: scenario,
    lookupContractKey: 'fake.lookup',
    lookupContractVersion: 1,
    providerRequestDigestSha256: digest,
    frozenCallbackCorrelationMode: 'provider_message_id_with_lookup' as const
  };
}

function diagnosticLookupInput(scenario: string) {
  return {
    contractVersion: 1 as const,
    diagnosticAttemptId: 'diagnostic_lookup_1',
    providerConnectionRevisionId: 'connection_revision_fake_v1',
    adapterKey: FAKE_EMAIL_ADAPTER_KEY,
    adapterVersion: FAKE_EMAIL_ADAPTER_VERSION,
    externalDiagnosticKey: scenario,
    lookupContractKey: 'fake.diagnostic.lookup',
    lookupContractVersion: 1,
    providerRequestDigestSha256: digest,
    frozenCallbackCorrelationMode: 'provider_message_id_with_lookup' as const
  };
}

function readinessInput(
  externalCheckKey: string,
  capability:
    | 'transactional_outbound'
    | 'delivery_callbacks'
    | 'suppression_callbacks'
    | 'inbound_replies' = 'transactional_outbound'
) {
  return {
    contractVersion: 1 as const,
    connectionId: 'connection_fake',
    connectionRevisionId: 'connection_revision_fake_v1',
    connectionConfigDigestSha256: digest,
    capability,
    readinessCheckId: 'readiness_check_1',
    checkKey: 'fake.readiness',
    manifestKey: FAKE_EMAIL_SETUP_MANIFEST.manifestKey,
    manifestVersion: FAKE_EMAIL_SETUP_MANIFEST.manifestVersion,
    manifestDigestSha256: FAKE_EMAIL_SETUP_MANIFEST.manifestDigestSha256,
    adapterKey: FAKE_EMAIL_ADAPTER_KEY,
    adapterVersion: FAKE_EMAIL_ADAPTER_VERSION,
    externalCheckKey,
    requestDigestSha256: digest,
    requestedValidUntil: 1_900_000_000_000,
    observationSchemaVersion: 1,
    normalizerVersion: 1
  };
}

describe('authenticated prepared email submissions', () => {
  test('accepts the v2 attachment and calendar reference contract end to end', async () => {
    const provider = createDeterministicFakeEmailProvider();
    const base = envelope();
    const v2 = Object.freeze({
      ...base,
      contractVersion: 2 as const,
      attachments: Object.freeze([Object.freeze({
        contentBytesRef: 'content/speaker-pack', filename: 'speaker-pack.pdf',
        mediaType: 'application/pdf', byteLength: 12, contentSha256: digest,
        disposition: 'attachment' as const
      })]),
      calendarPart: Object.freeze({
        method: 'REQUEST' as const, filename: 'invite.ics',
        contentBytesRef: 'calendar/slot-1', byteLength: 128, contentSha256: digest
      })
    });
    const submission = createFakeOrdinarySubmission({
      scenario: FAKE_PROVIDER_SCENARIO_KEYS.ordinary.acceptedWithId,
      envelope: v2
    });
    expect(provider.delivery.capabilities).toMatchObject({
      attachments: true, calendarMime: true
    });
    expect(await provider.delivery.submit(provider.delivery.prepare(submission)))
      .toMatchObject({ kind: 'accepted' });
  });

  test('freezes an immutable snapshot and rejects copied or changed prepared values', async () => {
    const provider = createDeterministicFakeEmailProvider();
    const submission = createFakeOrdinarySubmission({
      scenario: FAKE_PROVIDER_SCENARIO_KEYS.ordinary.acceptedWithId,
      envelope: envelope()
    });
    const prepared = provider.delivery.prepare(submission);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.opaque)).toBe(true);
    expect(await provider.delivery.submit(prepared)).toMatchObject({ kind: 'accepted' });

    const spread = { ...prepared } as PreparedEmailSubmission<typeof prepared.opaque>;
    await expect(provider.delivery.submit(spread)).rejects.toThrow('not authenticated');
    const changed = {
      ...prepared,
      providerRequestDigestSha256: 'b'.repeat(64)
    } as PreparedEmailSubmission<typeof prepared.opaque>;
    await expect(provider.delivery.submit(changed)).rejects.toThrow('not authenticated');
  });

  test('rejects cross-adapter substitution before any request capture', () => {
    const first = createEmailSubmissionPreparer('fake.first', 'v1');
    const second = createEmailSubmissionPreparer('fake.second', 'v1');
    const submission = createFakeOrdinarySubmission({
      scenario: FAKE_PROVIDER_SCENARIO_KEYS.ordinary.acceptedWithId,
      envelope: envelope()
    });
    const prepared = first.prepare(submission, () => Object.freeze({ protocol: 'fake' }));
    expect(() => second.open(prepared as never)).toThrow('not authenticated');
  });

  test('refuses a changed request whose reviewed-envelope digest no longer matches', () => {
    const provider = createDeterministicFakeEmailProvider();
    const originalEnvelope = envelope();
    const submission = createFakeOrdinarySubmission({
      scenario: FAKE_PROVIDER_SCENARIO_KEYS.ordinary.acceptedWithId,
      envelope: originalEnvelope
    });
    expect(() => provider.delivery.prepare({
      ...submission,
      envelope: { ...originalEnvelope, subject: 'Changed after review' }
    })).toThrow('digest');
  });
});

describe('deterministic ordinary delivery outcomes', () => {
  test.each([
    [FAKE_PROVIDER_SCENARIO_KEYS.ordinary.acceptedWithId, 'accepted', true],
    [FAKE_PROVIDER_SCENARIO_KEYS.ordinary.acceptedWithoutId, 'accepted', false],
    [FAKE_PROVIDER_SCENARIO_KEYS.ordinary.rejectedSafeRetryable, 'known_rejected', false],
    [FAKE_PROVIDER_SCENARIO_KEYS.ordinary.rejectedTerminal, 'known_rejected', false],
    [FAKE_PROVIDER_SCENARIO_KEYS.ordinary.timeoutBeforeAcceptance, 'acceptance_unknown', false],
    [FAKE_PROVIDER_SCENARIO_KEYS.ordinary.timeoutAfterAcceptance, 'acceptance_unknown', false],
    [FAKE_PROVIDER_SCENARIO_KEYS.ordinary.connectionLostBeforeAcceptance, 'acceptance_unknown', false],
    [FAKE_PROVIDER_SCENARIO_KEYS.ordinary.connectionLostAfterAcceptance, 'acceptance_unknown', false],
    [FAKE_PROVIDER_SCENARIO_KEYS.ordinary.malformedResponse, 'acceptance_unknown', false],
    [FAKE_PROVIDER_SCENARIO_KEYS.ordinary.thrownBeforeCapture, 'known_rejected', false],
    [FAKE_PROVIDER_SCENARIO_KEYS.ordinary.thrownAfterCapture, 'acceptance_unknown', false]
  ] as const)('normalizes %s to %s', async (scenario, kind, hasProviderId) => {
    const provider = createDeterministicFakeEmailProvider();
    const prepared = provider.delivery.prepare(createFakeOrdinarySubmission({
      scenario,
      envelope: envelope()
    }));
    const outcome = await provider.delivery.submit(prepared);
    expect(outcome.kind).toBe(kind);
    expect('providerMessageId' in outcome).toBe(hasProviderId);
    expect(outcome.evidence.canonicalDigestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(outcome)).not.toContain('speaker@example.test');
    expect(JSON.stringify(outcome)).not.toContain('provider boundary failure');
    expect(provider.capturedOrdinaryRequests().length).toBe(
      scenario === FAKE_PROVIDER_SCENARIO_KEYS.ordinary.thrownBeforeCapture ? 0 : 1
    );
  });

  test('safe and terminal rejections stay structurally distinct', async () => {
    const provider = createDeterministicFakeEmailProvider();
    const safe = await provider.delivery.submit(provider.delivery.prepare(
      createFakeOrdinarySubmission({
        scenario: FAKE_PROVIDER_SCENARIO_KEYS.ordinary.rejectedSafeRetryable,
        envelope: envelope()
      })
    ));
    const terminal = await provider.delivery.submit(provider.delivery.prepare(
      createFakeOrdinarySubmission({
        scenario: FAKE_PROVIDER_SCENARIO_KEYS.ordinary.rejectedTerminal,
        envelope: envelope()
      })
    ));
    expect(safe).toMatchObject({ kind: 'known_rejected', retryClass: 'safe_retryable' });
    expect(terminal).toMatchObject({ kind: 'known_rejected', retryClass: 'terminal' });
  });
});

describe('deterministic lookup outcomes', () => {
  test.each([
    [FAKE_PROVIDER_SCENARIO_KEYS.lookup.acceptedWithId, 'accepted'],
    [FAKE_PROVIDER_SCENARIO_KEYS.lookup.acceptedWithoutId, 'accepted'],
    [FAKE_PROVIDER_SCENARIO_KEYS.lookup.rejectedSafeRetryable, 'known_rejected'],
    [FAKE_PROVIDER_SCENARIO_KEYS.lookup.rejectedTerminal, 'known_rejected'],
    [FAKE_PROVIDER_SCENARIO_KEYS.lookup.notFound, 'not_found'],
    [FAKE_PROVIDER_SCENARIO_KEYS.lookup.timeout, 'indeterminate'],
    [FAKE_PROVIDER_SCENARIO_KEYS.lookup.connectionLost, 'indeterminate'],
    [FAKE_PROVIDER_SCENARIO_KEYS.lookup.malformedResponse, 'indeterminate'],
    [FAKE_PROVIDER_SCENARIO_KEYS.lookup.conflictingEvidence, 'indeterminate']
  ] as const)('normalizes ordinary lookup %s', async (scenario, kind) => {
    const lookup = createDeterministicFakeEmailProvider().delivery.lookup!;
    expect((await lookup(ordinaryLookupInput(scenario))).kind).toBe(kind);
  });

  test.each([
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnosticLookup.acceptedWithId, 'accepted'],
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnosticLookup.rejectedSafeRetryable, 'known_rejected_safe_retryable'],
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnosticLookup.rejectedTerminal, 'known_rejected_terminal'],
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnosticLookup.notFound, 'not_found'],
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnosticLookup.timeout, 'indeterminate'],
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnosticLookup.connectionLost, 'indeterminate'],
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnosticLookup.malformedResponse, 'indeterminate'],
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnosticLookup.conflictingEvidence, 'indeterminate']
  ] as const)('normalizes diagnostic lookup %s', async (scenario, kind) => {
    const lookup = createDeterministicFakeEmailProvider().diagnostics.lookup!;
    expect((await lookup(diagnosticLookupInput(scenario))).kind).toBe(kind);
  });
});

describe('separate deterministic diagnostics adapter', () => {
  test.each([
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.acceptedWithId, 'accepted'],
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.acceptedWithoutId, 'accepted'],
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.acceptedWithCost, 'accepted'],
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.rejectedSafeRetryable, 'known_rejected_safe_retryable'],
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.rejectedTerminal, 'known_rejected_terminal'],
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.timeoutBeforeAcceptance, 'acceptance_unknown'],
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.timeoutAfterAcceptance, 'acceptance_unknown'],
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.connectionLostBeforeAcceptance, 'acceptance_unknown'],
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.connectionLostAfterAcceptance, 'acceptance_unknown'],
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.malformedResponse, 'acceptance_unknown'],
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.thrownBeforeCapture, 'known_rejected_safe_retryable'],
    [FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.thrownAfterCapture, 'acceptance_unknown']
  ] as const)('normalizes %s to %s', async (scenario, kind) => {
    const provider = createDeterministicFakeEmailProvider();
    const outcome = await provider.diagnostics.submit(provider.diagnostics.prepare(
      createFakeDiagnosticSubmission({ scenario, envelope: envelope() })
    ));
    expect(outcome.kind).toBe(kind);
    expect(JSON.stringify(outcome)).not.toContain('speaker@example.test');
    expect(provider.capturedDiagnosticRequests().length).toBe(
      scenario === FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.thrownBeforeCapture ? 0 : 1
    );
    if (scenario === FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.acceptedWithCost) {
      expect(outcome).toMatchObject({ cost: { minorUnits: 12, currency: 'USD' } });
    }
  });
});

describe('revision-bound setup readiness', () => {
  test.each([
    [FAKE_PROVIDER_SCENARIO_KEYS.readiness.ready, 'passed', 'ready'],
    [FAKE_PROVIDER_SCENARIO_KEYS.readiness.degraded, 'passed', 'degraded'],
    [FAKE_PROVIDER_SCENARIO_KEYS.readiness.knownFailed, 'known_failed', undefined],
    [FAKE_PROVIDER_SCENARIO_KEYS.readiness.timeout, 'acceptance_unknown', undefined],
    [FAKE_PROVIDER_SCENARIO_KEYS.readiness.connectionLost, 'acceptance_unknown', undefined],
    [FAKE_PROVIDER_SCENARIO_KEYS.readiness.malformedResponse, 'acceptance_unknown', undefined],
    [FAKE_PROVIDER_SCENARIO_KEYS.readiness.thrown, 'acceptance_unknown', undefined]
  ] as const)('normalizes readiness %s', async (scenario, kind, readiness) => {
    const setup = createDeterministicFakeEmailProvider().setup;
    const outcome = await setup.checkReadiness(readinessInput(scenario));
    expect(outcome.kind).toBe(kind);
    if (readiness !== undefined) expect(outcome).toMatchObject({ readiness });
  });

  test('fails inbound readiness closed as not enabled', async () => {
    const setup = createDeterministicFakeEmailProvider().setup;
    const outcome = await setup.checkReadiness(readinessInput(
      FAKE_PROVIDER_SCENARIO_KEYS.readiness.ready,
      'inbound_replies'
    ));
    expect(outcome).toMatchObject({
      kind: 'known_failed',
      code: 'readiness.inbound_not_enabled'
    });
    expect(setup.manifest.capabilities.inboundReplies).toBe(false);
    expect(setup.manifest.capabilityStatus.inbound_replies).toBe('not_enabled');
  });

  test('refuses a readiness request citing another manifest revision', async () => {
    const setup = createDeterministicFakeEmailProvider().setup;
    await expect(setup.checkReadiness({
      ...readinessInput(FAKE_PROVIDER_SCENARIO_KEYS.readiness.ready),
      manifestDigestSha256: 'b'.repeat(64)
    })).rejects.toThrow('exact adapter manifest');
  });
});

function candidate(
  revisionId: string,
  pointerRole?: 'current'
): CallbackVerifierCandidate<typeof FAKE_CALLBACK_VERIFIER_CONTEXT> & { pointerRole: 'current' };
function candidate(
  revisionId: string,
  pointerRole: 'unexpired_previous'
): CallbackVerifierCandidate<typeof FAKE_CALLBACK_VERIFIER_CONTEXT> & {
  pointerRole: 'unexpired_previous';
  eligibilityCeiling: number;
};
function candidate(
  revisionId: string,
  pointerRole: 'current' | 'unexpired_previous' = 'current'
): CallbackVerifierCandidate<typeof FAKE_CALLBACK_VERIFIER_CONTEXT> {
  const base = {
    connectionId: 'connection_fake',
    callbackVerifierRevisionId: revisionId,
    verifierKey: FAKE_CALLBACK_VERIFIER_KEY,
    verifierVersion: FAKE_CALLBACK_VERIFIER_VERSION,
    verificationContractVersion: FAKE_CALLBACK_VERIFICATION_CONTRACT_VERSION,
    keyIdMode: 'absent' as const,
    configDigestSha256: digest,
    opaqueContext: FAKE_CALLBACK_VERIFIER_CONTEXT
  };
  return pointerRole === 'current'
    ? { ...base, pointerRole }
    : { ...base, pointerRole, eligibilityCeiling: 500 };
}

function activeCandidates(
  currentRevision: string,
  previousRevision?: string
): CallbackVerifierCandidateSet<typeof FAKE_CALLBACK_VERIFIER_CONTEXT> {
  return {
    contractVersion: 1,
    connectionId: 'connection_fake',
    verifierPointerVersion: 1,
    resolvedAtDatabaseTime: 100,
    pointerState: 'active',
    current: candidate(currentRevision),
    ...(previousRevision === undefined
      ? {}
      : { previous: candidate(previousRevision, 'unexpired_previous') })
  };
}

function callback(
  acceptedVerifierRevisionIds: readonly string[],
  normalizedEvidenceClass:
    | 'delivered'
    | 'delayed'
    | 'bounced'
    | 'complained'
    | 'suppressed' = 'delivered'
) {
  return createFakeProviderCallbackFixture({
    providerConnectionId: 'connection_fake',
    ingressCorrelationId: 'corr1_callbackfixture1',
    providerEventId: 'provider_event_1',
    normalizedEvidenceClass,
    signatureTimestamp: 100,
    replayWindowExpiresAt: 500,
    verifiedAt: 110,
    identity: { kind: 'both', providerMessageId: 'provider-message-1', externalDeliveryKey: 'delivery_1' },
    acceptedVerifierRevisionIds
  });
}

describe('outbound callback verifier registry', () => {
  test('resolves exactly one current or unexpired previous verifier', async () => {
    const registry = createDeterministicFakeEmailProvider().callbackRegistry;
    const current = await registry.resolve(callback(['verifier_current']), activeCandidates(
      'verifier_current',
      'verifier_previous'
    ));
    const previous = await registry.resolve(callback(['verifier_previous']), activeCandidates(
      'verifier_current',
      'verifier_previous'
    ));
    expect(current).toMatchObject({ kind: 'exactly_one', callbackVerifierRevisionId: 'verifier_current' });
    expect(previous).toMatchObject({ kind: 'exactly_one', callbackVerifierRevisionId: 'verifier_previous' });
  });

  test('normalizes zero and two verifier successes to none and ambiguous', async () => {
    const registry = createDeterministicFakeEmailProvider().callbackRegistry;
    const candidates = activeCandidates('verifier_current', 'verifier_previous');
    expect(await registry.resolve(callback([]), candidates)).toMatchObject({ kind: 'none' });
    expect(await registry.resolve(
      callback(['verifier_current', 'verifier_previous']),
      candidates
    )).toMatchObject({ kind: 'ambiguous' });
  });

  test('empty, disabled, and expired draining sets never verify', async () => {
    const registry = createDeterministicFakeEmailProvider().callbackRegistry;
    const disabled: CallbackVerifierCandidateSet<typeof FAKE_CALLBACK_VERIFIER_CONTEXT> = {
      contractVersion: 1,
      connectionId: 'connection_fake',
      verifierPointerVersion: 1,
      resolvedAtDatabaseTime: 100,
      pointerState: 'disabled'
    };
    const expiredDraining: CallbackVerifierCandidateSet<typeof FAKE_CALLBACK_VERIFIER_CONTEXT> = {
      contractVersion: 1,
      connectionId: 'connection_fake',
      verifierPointerVersion: 2,
      resolvedAtDatabaseTime: 500,
      pointerState: 'draining_disabled',
      currentVerificationUntil: 500,
      current: candidate('verifier_current')
    };
    expect(await registry.resolve(callback(['verifier_current']), disabled)).toMatchObject({ kind: 'none' });
    expect(await registry.resolve(callback(['verifier_current']), expiredDraining)).toMatchObject({ kind: 'none' });
  });

  test('normalization is byte-stable for the same fixture', async () => {
    const registry = createDeterministicFakeEmailProvider().callbackRegistry;
    const fixture = callback(['verifier_current']);
    const first = await registry.resolve(fixture, activeCandidates('verifier_current'));
    const second = await registry.resolve(fixture, activeCandidates('verifier_current'));
    expect(first).toEqual(second);
    expect(first.kind === 'exactly_one' && first.verified.canonicalDigestSha256)
      .toBe(second.kind === 'exactly_one' ? second.verified.canonicalDigestSha256 : false);
  });

  test.each([
    'delivered',
    'delayed',
    'bounced',
    'complained',
    'suppressed'
  ] as const)('normalizes the outbound %s observation fixture', async (eventClass) => {
    const registry = createDeterministicFakeEmailProvider().callbackRegistry;
    const outcome = await registry.resolve(
      callback(['verifier_current'], eventClass),
      activeCandidates('verifier_current')
    );
    expect(outcome.kind).toBe('exactly_one');
    if (outcome.kind === 'exactly_one') {
      expect(outcome.verified.normalizedEvidenceClass).toBe(eventClass);
      expect(JSON.stringify(outcome)).not.toContain('rawPayloadBytes');
      expect(JSON.stringify(outcome)).not.toContain('signatureEnvelopeBytes');
    }
  });

  test('uses only whichever draining verifier remains inside its exclusive deadline', async () => {
    const registry = createDeterministicFakeEmailProvider().callbackRegistry;
    const previousOnly: CallbackVerifierCandidateSet<typeof FAKE_CALLBACK_VERIFIER_CONTEXT> = {
      contractVersion: 1,
      connectionId: 'connection_fake',
      verifierPointerVersion: 3,
      resolvedAtDatabaseTime: 100,
      pointerState: 'draining_disabled',
      currentVerificationUntil: 100,
      current: candidate('verifier_current'),
      previous: candidate('verifier_previous', 'unexpired_previous')
    };
    const currentOnly: CallbackVerifierCandidateSet<typeof FAKE_CALLBACK_VERIFIER_CONTEXT> = {
      ...previousOnly,
      currentVerificationUntil: 500,
      previous: {
        ...candidate('verifier_previous', 'unexpired_previous'),
        eligibilityCeiling: 100
      }
    };
    expect(await registry.resolve(callback(['verifier_previous']), previousOnly)).toMatchObject({
      kind: 'exactly_one',
      callbackVerifierRevisionId: 'verifier_previous'
    });
    expect(await registry.resolve(callback(['verifier_current']), currentOnly)).toMatchObject({
      kind: 'exactly_one',
      callbackVerifierRevisionId: 'verifier_current'
    });
  });

  test('fails closed when an exact verifier implementation is missing or duplicated', async () => {
    const provider = createDeterministicFakeEmailProvider();
    const evidenceFactory = (
      code:
        | 'callback.no_candidate'
        | 'callback.verifier_unavailable'
        | 'callback.none_verified'
        | 'callback.multiple_verified',
      correlationId: string
    ) => createSafeEvidence(FAKE_SAFE_EVIDENCE_CATALOG, { code, correlationId });
    const missing = createEmailCallbackVerifierRegistry({
      implementations: [],
      evidence: evidenceFactory
    });
    const duplicate = createEmailCallbackVerifierRegistry({
      implementations: [provider.callbackVerifier, provider.callbackVerifier],
      evidence: evidenceFactory
    });
    const fixture = callback(['verifier_current']);
    const candidates = activeCandidates('verifier_current');
    expect(await missing.resolve(fixture, candidates)).toMatchObject({ kind: 'none' });
    expect(await duplicate.resolve(fixture, candidates)).toMatchObject({ kind: 'none' });
  });

  test('rejects a callback whose raw bytes no longer match its payload digest', async () => {
    const registry = createDeterministicFakeEmailProvider().callbackRegistry;
    const fixture = callback(['verifier_current']);
    const tampered = {
      ...fixture,
      rawPayloadBytes: new TextEncoder().encode('{"changed":true}'),
      payloadByteLength: new TextEncoder().encode('{"changed":true}').byteLength
    };
    await expect(registry.resolve(tampered, activeCandidates('verifier_current')))
      .rejects.toThrow('payload digest');
  });
});

describe('safe captured request projection', () => {
  test('captures only opaque identities and digests, never envelope content', async () => {
    const provider = createDeterministicFakeEmailProvider();
    const mail = envelope();
    const submission = createFakeOrdinarySubmission({
      scenario: FAKE_PROVIDER_SCENARIO_KEYS.ordinary.acceptedWithId,
      envelope: mail
    });
    const prepared = provider.delivery.prepare(submission);
    await provider.delivery.submit(prepared);
    const capture = provider.capturedOrdinaryRequests()[0]!;
    expect(capture.reviewedEnvelopeDigestSha256).toBe(
      computeReviewedEmailEnvelopeDigestSha256(mail)
    );
    expect(JSON.stringify(capture)).not.toContain(mail.to.address);
    expect(JSON.stringify(capture)).not.toContain(mail.textBody);
  });
});
