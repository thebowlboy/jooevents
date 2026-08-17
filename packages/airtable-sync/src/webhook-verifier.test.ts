import { describe, expect, test } from 'bun:test';
import { parseAirtableBaseId, parseAirtableWebhookId } from '@jooevents/airtable';
import {
  parseInstant,
  parseSourceConnectionId,
  parseVerifierRevisionId
} from '@jooevents/kernel';
import { createAirtableWebhookVerifier } from './webhook-verifier';

const connectionId = parseSourceConnectionId('018f0f64-4d6c-7b2f-8a1e-1234567890ab');
const baseId = parseAirtableBaseId('app00000000000001');
const webhookId = parseAirtableWebhookId('ach00000000000001');
const secret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const body = new TextEncoder().encode(JSON.stringify({
  base: { id: baseId },
  webhook: { id: webhookId },
  timestamp: '2026-08-17T00:00:00.000Z'
}));

async function mac(bytes = body, keyBytes = secret): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
  return `hmac-sha256=${Array.from(signed, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function verifier() {
  return createAirtableWebhookVerifier({
    revisionId: parseVerifierRevisionId('018f0f64-4d6c-7b2f-8a1e-1234567890e1'),
    registrations: {
      async resolve(candidate) {
        return candidate === connectionId ? {
          baseId,
          webhookId,
          maximumNotificationAgeMs: 2 * 24 * 60 * 60 * 1_000,
          async withMacSecret(use) { return use(secret); }
        } : undefined;
      }
    }
  });
}

describe('Airtable verified webhook ingress', () => {
  test('authenticates the exact raw bytes and retains only normalized notification identity', async () => {
    const result = await verifier().verify({
      rawEnvelope: body,
      protocolEvidence: { contentMac: await mac() },
      receivedAt: parseInstant('2026-08-17T00:00:01.000Z'),
      sourceConnectionId: connectionId
    });
    expect(result.kind).toBe('verified');
    if (result.kind === 'verified') {
      const retained = new TextDecoder().decode(result.normalizedRetainedContent);
      expect(retained).toBe(JSON.stringify({
        baseId, timestamp: '2026-08-17T00:00:00.000Z', webhookId
      }));
      expect(retained).not.toContain('hmac-sha256');
    }
  });

  test('rejects byte changes, substituted resources, stale notifications, and extra evidence', async () => {
    const changed = Uint8Array.from(body);
    const changedIndex = changed.length - 2;
    changed[changedIndex] = (changed[changedIndex] ?? 0) ^ 1;
    expect(await verifier().verify({
      rawEnvelope: changed,
      protocolEvidence: { contentMac: await mac() },
      receivedAt: parseInstant('2026-08-17T00:00:01.000Z'),
      sourceConnectionId: connectionId
    })).toEqual({ kind: 'rejected', reason: 'malformed_envelope' });
    expect(await verifier().verify({
      rawEnvelope: body,
      protocolEvidence: { contentMac: await mac(), callbackRef: 'leak' },
      receivedAt: parseInstant('2026-08-17T00:00:01.000Z'),
      sourceConnectionId: connectionId
    })).toEqual({ kind: 'rejected', reason: 'ambiguous_evidence' });
    expect(await verifier().verify({
      rawEnvelope: body,
      protocolEvidence: { contentMac: await mac() },
      receivedAt: parseInstant('2026-08-20T00:00:01.000Z'),
      sourceConnectionId: connectionId
    })).toEqual({ kind: 'rejected', reason: 'replay_window' });

    const substituted = new TextEncoder().encode(JSON.stringify({
      base: { id: 'app00000000000002' }, webhook: { id: webhookId },
      timestamp: '2026-08-17T00:00:00.000Z'
    }));
    expect(await verifier().verify({
      rawEnvelope: substituted,
      protocolEvidence: { contentMac: await mac(substituted) },
      receivedAt: parseInstant('2026-08-17T00:00:01.000Z'),
      sourceConnectionId: connectionId
    })).toEqual({ kind: 'rejected', reason: 'invalid_authenticity' });
  });
});
