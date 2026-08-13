import { describe, expect, test } from 'bun:test';
import {
  computeReviewedEmailEnvelopeDigestSha256,
  parseEmailAddress,
  type ImmutableEmailDiagnosticSubmission,
  type ImmutableEmailEnvelope,
  type ImmutableEmailSubmission,
  type PreparedEmailSubmission
} from '@jooevents/communications';
import {
  CLOUDFLARE_EMAIL_DIAGNOSTIC_FIXTURE_KEY,
  CLOUDFLARE_EMAIL_READINESS_EXTERNAL_CHECK_KEY,
  CLOUDFLARE_REST_EMAIL_SETUP_MANIFEST,
  CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST,
  createCloudflareRestEmailProvider,
  createCloudflareWorkersEmailProvider,
  type CloudflareApiTokenLease,
  type CloudflareEmailSendingBinding,
  type CloudflareFetch,
  type CloudflareRestEmailMessage,
  type CloudflareWorkersEmailMessage
} from './index';

const shaA = 'a'.repeat(64);

function envelope(overrides: Partial<ImmutableEmailEnvelope> = {}): ImmutableEmailEnvelope {
  return {
    contractVersion: 1,
    from: {
      address: parseEmailAddress('organizer@example.test'),
      displayName: 'Organizer'
    },
    to: { address: parseEmailAddress('speaker@example.test') },
    replyTo: {
      address: parseEmailAddress('reply@example.test'),
      displayName: 'Replies'
    },
    subject: 'Submission update',
    textBody: 'A bounded message body.',
    htmlBody: '<p>A bounded message body.</p>',
    headers: [{ name: 'X-Event-Key', value: 'event_1' }],
    ...overrides
  };
}

function ordinary(
  overrides: Partial<ImmutableEmailSubmission> = {}
): ImmutableEmailSubmission {
  const immutableEnvelope = overrides.envelope ?? envelope();
  return {
    contractVersion: 1,
    deliveryAttemptId: 'delivery_attempt_1',
    providerConnectionRevisionId: 'provider_revision_1',
    externalDeliveryKey: 'delivery_external_1',
    senderProfileRevisionId: 'sender_revision_1',
    senderPresentationContractKey: 'sender.presentation',
    senderPresentationContractVersion: 1,
    senderPresentationDigestSha256: shaA,
    channelAddressId: 'channel_address_1',
    channelAddressVersion: 1,
    addressLookupFingerprintProfile: 'address.lookup',
    addressLookupFingerprintVersion: 1,
    addressLookupFingerprintSha256: shaA,
    reviewedEnvelopeDigestSha256:
      computeReviewedEmailEnvelopeDigestSha256(immutableEnvelope),
    envelope: immutableEnvelope,
    ...overrides
  };
}

function diagnostic(
  overrides: Partial<ImmutableEmailDiagnosticSubmission> = {}
): ImmutableEmailDiagnosticSubmission {
  const immutableEnvelope = overrides.envelope ?? envelope();
  return {
    contractVersion: 1,
    diagnosticAttemptId: 'diagnostic_attempt_1',
    providerConnectionRevisionId: 'provider_revision_1',
    externalDiagnosticKey: 'diagnostic_external_1',
    fixtureKey: CLOUDFLARE_EMAIL_DIAGNOSTIC_FIXTURE_KEY,
    fixtureVersion: 1,
    senderProfileRevisionId: 'sender_revision_1',
    senderPresentationContractKey: 'sender.presentation',
    senderPresentationContractVersion: 1,
    senderPresentationDigestSha256: shaA,
    recipientFingerprintProfile: 'diagnostic.recipient',
    recipientFingerprintVersion: 1,
    recipientFingerprintSha256: shaA,
    reviewedEnvelopeDigestSha256:
      computeReviewedEmailEnvelopeDigestSha256(immutableEnvelope),
    validUntil: 1_900_000_000_000,
    maximumCostMinorUnits: 1,
    currency: 'USD',
    envelope: immutableEnvelope,
    ...overrides
  };
}

function workersBinding(
  send: (message: CloudflareWorkersEmailMessage) => Promise<Readonly<{ messageId: string }>>
): CloudflareEmailSendingBinding {
  return Object.freeze({ send });
}

function tokenLease(apiToken: string): CloudflareApiTokenLease {
  return Object.freeze({
    async withApiToken<Result>(use: (token: string) => Promise<Result>): Promise<Result> {
      return use(apiToken);
    }
  });
}

function responseBody(
  disposition: 'delivered' | 'permanent_bounces' | 'queued' = 'delivered',
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    success: true,
    errors: [],
    messages: [],
    result: {
      delivered: disposition === 'delivered' ? ['speaker@example.test'] : [],
      permanent_bounces:
        disposition === 'permanent_bounces' ? ['speaker@example.test'] : [],
      queued: disposition === 'queued' ? ['speaker@example.test'] : [],
      message_id: 'cloudflare_message_1',
      ...overrides
    }
  };
}

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

function restProvider(fetch: CloudflareFetch, apiToken = 'test-token-fragment') {
  return createCloudflareRestEmailProvider({
    accountId: 'account_123',
    tokenLease: tokenLease(apiToken),
    fetch
  });
}

function readinessInput(
  manifest:
    | typeof CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST
    | typeof CLOUDFLARE_REST_EMAIL_SETUP_MANIFEST,
  capability:
    | 'transactional_outbound'
    | 'delivery_callbacks'
    | 'suppression_callbacks'
    | 'inbound_replies' = 'transactional_outbound'
) {
  return {
    contractVersion: 1 as const,
    connectionId: 'connection_cloudflare_1',
    connectionRevisionId: 'connection_revision_cloudflare_1',
    connectionConfigDigestSha256: shaA,
    capability,
    readinessCheckId: 'readiness_check_1',
    checkKey: 'cloudflare.transactional_outbound',
    manifestKey: manifest.manifestKey,
    manifestVersion: manifest.manifestVersion,
    manifestDigestSha256: manifest.manifestDigestSha256,
    adapterKey: manifest.adapterKey,
    adapterVersion: manifest.adapterVersion,
    externalCheckKey: CLOUDFLARE_EMAIL_READINESS_EXTERNAL_CHECK_KEY,
    requestDigestSha256: shaA,
    requestedValidUntil: 1_900_000_000_000,
    observationSchemaVersion: 1,
    normalizerVersion: 1
  };
}

describe('Cloudflare Email Sending package boundary', () => {
  test('advertises only outbound submission and explicitly disables inbound', () => {
    for (const manifest of [
      CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST,
      CLOUDFLARE_REST_EMAIL_SETUP_MANIFEST
    ]) {
      expect(manifest.capabilities).toEqual({
        idempotency: 'none',
        reconciliation: 'none',
        callbacks: [],
        inboundReplies: false
      });
      expect(manifest.capabilityStatus).toEqual({
        transactional_outbound: 'supported',
        delivery_callbacks: 'not_supported',
        suppression_callbacks: 'not_supported',
        inbound_replies: 'not_enabled'
      });
      expect(manifest.callbacks).toEqual({ kind: 'disabled' });
    }
    const provider = createCloudflareWorkersEmailProvider({
      binding: workersBinding(async () => ({ messageId: 'message_1' }))
    });
    expect(Object.keys(provider).sort()).toEqual(['delivery', 'diagnostics', 'setup']);
    expect('lookup' in provider.delivery).toBe(false);
    expect('lookup' in provider.diagnostics).toBe(false);
    expect('callbackVerifier' in provider).toBe(false);
  });

  test('binds prepared requests to the exact adapter instance before transport I/O', async () => {
    let workersCalls = 0;
    let restCalls = 0;
    const workers = createCloudflareWorkersEmailProvider({
      binding: workersBinding(async () => {
        workersCalls += 1;
        return { messageId: 'message_1' };
      })
    });
    const rest = restProvider(async () => {
      restCalls += 1;
      return jsonResponse(responseBody());
    });
    const prepared = workers.delivery.prepare(ordinary());
    const spread = { ...prepared } as PreparedEmailSubmission<typeof prepared.opaque>;
    await expect(workers.delivery.submit(spread)).rejects.toThrow('not authenticated');
    await expect(rest.delivery.submit(prepared as never)).rejects.toThrow('not authenticated');
    expect(workersCalls).toBe(0);
    expect(restCalls).toBe(0);
  });

  test('rejects provider-incompatible message size and headers during pure prepare', () => {
    const provider = createCloudflareWorkersEmailProvider({
      binding: workersBinding(async () => ({ messageId: 'message_1' }))
    });
    const oversizedEnvelope = envelope({ textBody: 'x'.repeat(3_900_000) });
    expect(() => provider.delivery.prepare(ordinary({ envelope: oversizedEnvelope })))
      .toThrow('message-size');

    const invalidHeaderEnvelope = envelope({
      headers: [{ name: 'X-Large', value: 'x'.repeat(2_049) }]
    });
    expect(() => provider.delivery.prepare(ordinary({ envelope: invalidHeaderEnvelope })))
      .toThrow('header value');

    const unsupportedHeaderEnvelope = envelope({
      headers: [{ name: 'Authentication-Results', value: 'safe-value' }]
    });
    expect(() => provider.delivery.prepare(ordinary({ envelope: unsupportedHeaderEnvelope })))
      .toThrow('not supported');
  });
});

describe('Cloudflare Workers binding transport', () => {
  test('maps the reviewed envelope to the structured binding and accepts a valid ID', async () => {
    let captured: CloudflareWorkersEmailMessage | undefined;
    const provider = createCloudflareWorkersEmailProvider({
      binding: workersBinding(async (message) => {
        captured = message;
        return { messageId: 'workers_message_1' };
      })
    });
    const outcome = await provider.delivery.submit(provider.delivery.prepare(ordinary()));
    expect(outcome).toMatchObject({
      contractVersion: 1,
      kind: 'accepted',
      providerMessageId: 'workers_message_1'
    });
    expect(captured).toEqual({
      to: 'speaker@example.test',
      from: { email: 'organizer@example.test', name: 'Organizer' },
      subject: 'Submission update',
      html: '<p>A bounded message body.</p>',
      text: 'A bounded message body.',
      replyTo: { email: 'reply@example.test', name: 'Replies' },
      headers: { 'X-Event-Key': 'event_1' }
    });
    expect(JSON.stringify(captured)).not.toContain('delivery_external_1');
  });

  test.each([
    ['E_RATE_LIMIT_EXCEEDED', 'known_rejected', 'safe_retryable'],
    ['E_DAILY_LIMIT_EXCEEDED', 'known_rejected', 'safe_retryable'],
    ['E_SENDER_NOT_VERIFIED', 'known_rejected', 'terminal'],
    ['E_RECIPIENT_SUPPRESSED', 'known_rejected', 'terminal'],
    ['E_DELIVERY_FAILED', 'known_rejected', 'terminal'],
    ['E_VALIDATION_ERROR', 'known_rejected', 'terminal']
  ] as const)('normalizes %s without provider text', async (code, kind, retryClass) => {
    const rawProviderText = ['raw', 'provider', 'detail'].join('_');
    const provider = createCloudflareWorkersEmailProvider({
      binding: workersBinding(async () => {
        throw Object.assign(new Error(rawProviderText), {
          code,
          providerPayload: { secret: rawProviderText }
        });
      })
    });
    const outcome = await provider.delivery.submit(provider.delivery.prepare(ordinary()));
    expect(outcome).toMatchObject({ kind, retryClass });
    expect(JSON.stringify(outcome)).not.toContain(rawProviderText);
    expect(JSON.stringify(outcome)).not.toContain('providerPayload');
  });

  test.each([
    ['E_INTERNAL_SERVER_ERROR', 'connection_lost'],
    ['E_UNKNOWN_CODE', 'connection_lost']
  ] as const)('keeps %s acceptance ambiguous', async (code, reason) => {
    const provider = createCloudflareWorkersEmailProvider({
      binding: workersBinding(async () => {
        throw Object.assign(new Error('not exported'), { code });
      })
    });
    expect(await provider.delivery.submit(provider.delivery.prepare(ordinary())))
      .toMatchObject({ kind: 'acceptance_unknown', reason });
  });

  test('normalizes timeout and malformed successful results as ambiguity', async () => {
    const timeout = new Error('not exported');
    timeout.name = 'AbortError';
    const timedOut = createCloudflareWorkersEmailProvider({
      binding: workersBinding(async () => { throw timeout; })
    });
    expect(await timedOut.delivery.submit(timedOut.delivery.prepare(ordinary())))
      .toMatchObject({ kind: 'acceptance_unknown', reason: 'timeout' });

    const malformed = createCloudflareWorkersEmailProvider({
      binding: workersBinding(async () => ({ messageId: '' }))
    });
    expect(await malformed.delivery.submit(malformed.delivery.prepare(ordinary())))
      .toMatchObject({ kind: 'acceptance_unknown', reason: 'malformed_response' });
  });

  test('uses the separate diagnostic port and fixed fixture', async () => {
    const provider = createCloudflareWorkersEmailProvider({
      binding: workersBinding(async () => ({ messageId: 'diagnostic_message_1' }))
    });
    expect(await provider.diagnostics.submit(provider.diagnostics.prepare(diagnostic())))
      .toMatchObject({ kind: 'accepted', providerMessageId: 'diagnostic_message_1' });
    expect(() => provider.diagnostics.prepare(diagnostic({ fixtureKey: 'unknown.fixture' })))
      .toThrow('unknown fixture');
  });
});

describe('Cloudflare REST transport', () => {
  test.each([
    ['delivered', 'accepted_delivered'],
    ['permanent_bounces', 'accepted_permanent_bounce'],
    ['queued', 'accepted_queued']
  ] as const)('accepts a valid %s disposition with one provider ID', async (
    disposition,
    evidenceDisposition
  ) => {
    const provider = restProvider(async () => jsonResponse(responseBody(disposition)));
    const outcome = await provider.delivery.submit(provider.delivery.prepare(ordinary()));
    expect(outcome).toMatchObject({
      kind: 'accepted',
      providerMessageId: 'cloudflare_message_1'
    });
    expect(outcome.evidence.registeredFacts).toContainEqual(expect.objectContaining({
      factKey: 'cloudflare.observation',
      enumValue: evidenceDisposition
    }));
  });

  test('uses the fixed endpoint, injected token lease, and REST field names', async () => {
    const runtimeToken = ['runtime', 'token', 'fixture'].join('-');
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const provider = restProvider(async (request, init) => {
      capturedUrl = String(request);
      capturedInit = init;
      return jsonResponse(responseBody());
    }, runtimeToken);
    const outcome = await provider.delivery.submit(provider.delivery.prepare(ordinary()));
    expect(capturedUrl).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account_123/email/sending/send'
    );
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>).Authorization)
      .toBe(`Bearer ${runtimeToken}`);
    const payload = JSON.parse(String(capturedInit?.body)) as CloudflareRestEmailMessage;
    expect(payload).toMatchObject({
      to: 'speaker@example.test',
      from: { address: 'organizer@example.test', name: 'Organizer' },
      reply_to: { address: 'reply@example.test', name: 'Replies' }
    });
    expect(JSON.stringify(payload)).not.toContain('delivery_external_1');
    expect(JSON.stringify(outcome)).not.toContain(runtimeToken);
    expect(JSON.stringify(outcome)).not.toContain('speaker@example.test');
  });

  test.each([
    [400, 'known_rejected', 'terminal'],
    [401, 'known_rejected', 'terminal'],
    [403, 'known_rejected', 'terminal'],
    [404, 'known_rejected', 'terminal'],
    [429, 'known_rejected', 'safe_retryable'],
    [500, 'acceptance_unknown', undefined],
    [503, 'acceptance_unknown', undefined]
  ] as const)('normalizes HTTP %s conservatively', async (status, kind, retryClass) => {
    const rawProviderText = ['provider', 'native', 'error'].join('-');
    const provider = restProvider(async () => jsonResponse({
      success: false,
      errors: [{ code: 10_001, message: rawProviderText }],
      messages: [],
      result: null
    }, status));
    const outcome = await provider.delivery.submit(provider.delivery.prepare(ordinary()));
    expect(outcome.kind).toBe(kind);
    if (retryClass !== undefined) expect(outcome).toMatchObject({ retryClass });
    expect(JSON.stringify(outcome)).not.toContain(rawProviderText);
    expect(JSON.stringify(outcome)).not.toContain('10001');
  });

  test('does not claim a request was sent when the secret lease is unavailable', async () => {
    let fetchCalls = 0;
    const tokenLeaseFailure = ['secret', 'store', 'detail'].join('-');
    const provider = createCloudflareRestEmailProvider({
      accountId: 'account_123',
      tokenLease: {
        async withApiToken<Result>(
          _use: (apiToken: string) => Promise<Result>
        ): Promise<Result> {
          throw new Error(tokenLeaseFailure);
        }
      },
      fetch: async () => {
        fetchCalls += 1;
        return jsonResponse(responseBody());
      }
    });
    const outcome = await provider.delivery.submit(provider.delivery.prepare(ordinary()));
    expect(outcome).toMatchObject({ kind: 'known_rejected', retryClass: 'safe_retryable' });
    expect(outcome.evidence.registeredFacts).toContainEqual(expect.objectContaining({
      factKey: 'cloudflare.request_dispatched',
      booleanValue: false
    }));
    expect(fetchCalls).toBe(0);
    expect(JSON.stringify(outcome)).not.toContain(tokenLeaseFailure);
  });

  test.each([
    ['AbortError', 'timeout'],
    ['NetworkError', 'connection_lost']
  ] as const)('normalizes a lost %s response as acceptance unknown', async (name, reason) => {
    const provider = restProvider(async () => {
      const error = new Error('network detail must not cross');
      error.name = name;
      throw error;
    });
    const outcome = await provider.delivery.submit(provider.delivery.prepare(ordinary()));
    expect(outcome).toMatchObject({ kind: 'acceptance_unknown', reason });
    expect(JSON.stringify(outcome)).not.toContain('network detail');
  });

  test.each([
    ['not-json', undefined],
    [JSON.stringify({ success: true, result: {} }), undefined],
    [JSON.stringify(responseBody('delivered', { message_id: '' })), undefined],
    [JSON.stringify(responseBody('delivered', { queued: ['speaker@example.test'] })), undefined]
  ])('rejects malformed 2xx response %s as acceptance unknown', async (body) => {
    const provider = restProvider(async () => new Response(body, { status: 200 }));
    expect(await provider.delivery.submit(provider.delivery.prepare(ordinary())))
      .toMatchObject({ kind: 'acceptance_unknown', reason: 'malformed_response' });
  });

  test('bounds response bytes before parsing', async () => {
    const provider = restProvider(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Length': '70000' }
    }));
    expect(await provider.delivery.submit(provider.delivery.prepare(ordinary())))
      .toMatchObject({ kind: 'acceptance_unknown', reason: 'malformed_response' });
  });

  test('normalizes REST diagnostic rejection through the diagnostic grammar', async () => {
    const provider = restProvider(async () => jsonResponse({ success: false }, 429));
    expect(await provider.diagnostics.submit(provider.diagnostics.prepare(diagnostic())))
      .toMatchObject({ kind: 'known_rejected_safe_retryable' });
  });
});

describe('Cloudflare setup readiness', () => {
  test('fails closed without a readiness probe and rejects unsupported/inbound capabilities', async () => {
    const provider = createCloudflareWorkersEmailProvider({
      binding: workersBinding(async () => ({ messageId: 'message_1' }))
    });
    expect(await provider.setup.checkReadiness(
      readinessInput(CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST)
    )).toMatchObject({
      kind: 'known_failed',
      code: 'cloudflare.email.readiness.not_verified'
    });
    expect(await provider.setup.checkReadiness(
      readinessInput(CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST, 'delivery_callbacks')
    )).toMatchObject({
      kind: 'known_failed',
      code: 'cloudflare.email.readiness.not_supported'
    });
    expect(await provider.setup.checkReadiness(
      readinessInput(CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST, 'inbound_replies')
    )).toMatchObject({
      kind: 'known_failed',
      code: 'cloudflare.email.readiness.inbound_not_enabled'
    });
  });

  test('normalizes an injected closed readiness result and clamps its validity', async () => {
    const provider = createCloudflareWorkersEmailProvider({
      binding: workersBinding(async () => ({ messageId: 'message_1' })),
      readinessProbe: {
        async check() {
          return {
            kind: 'passed',
            readiness: 'ready',
            validUntil: 1_999_000_000_000
          };
        }
      }
    });
    expect(await provider.setup.checkReadiness(
      readinessInput(CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST)
    )).toMatchObject({
      kind: 'passed',
      readiness: 'ready',
      validUntil: 1_900_000_000_000
    });
  });

  test('normalizes a thrown readiness timeout without exception text', async () => {
    const rawText = ['readiness', 'secret', 'detail'].join('-');
    const provider = createCloudflareWorkersEmailProvider({
      binding: workersBinding(async () => ({ messageId: 'message_1' })),
      readinessProbe: {
        async check() {
          const error = new Error(rawText);
          error.name = 'TimeoutError';
          throw error;
        }
      }
    });
    const outcome = await provider.setup.checkReadiness(
      readinessInput(CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST)
    );
    expect(outcome).toMatchObject({ kind: 'acceptance_unknown', reason: 'timeout' });
    expect(JSON.stringify(outcome)).not.toContain(rawText);
  });
});
