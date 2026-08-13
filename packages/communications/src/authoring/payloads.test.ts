import { describe, expect, test } from 'bun:test';
import {
  ORGANIZER_AUTHORING_PAYLOAD_MAXIMUM_BYTES,
  OrganizerAuthoringPayloadError,
  canonicalizeOrganizerAuthoringPayload,
  createOrganizerAuthoringPayloadRef
} from './payloads';

describe('organizer authoring payload canonicalization', () => {
  test('normalizes once and produces stable canonical bytes and metadata', () => {
    const first = canonicalizeOrganizerAuthoringPayload({
      payloadKind: 'message_content',
      schemaVersion: 1,
      value: {
        kind: 'email/v1',
        subject: '  Arrival   details ',
        body: { kind: 'plain_text/v1', text: 'Hello\r\nworld' }
      }
    });
    const second = canonicalizeOrganizerAuthoringPayload({
      schemaVersion: 1,
      value: {
        body: { text: 'Hello\nworld', kind: 'plain_text/v1' },
        subject: 'Arrival details',
        kind: 'email/v1'
      },
      payloadKind: 'message_content'
    });

    expect(new TextDecoder().decode(first.bytes)).toBe(
      '{"payloadKind":"message_content","schemaVersion":1,"value":{"body":{"kind":"plain_text/v1","text":"Hello\\nworld"},"kind":"email/v1","subject":"Arrival details"}}'
    );
    expect(first.digestSha256).toBe(second.digestSha256);
    expect(first.profile).toEqual({
      payloadKind: 'message_content',
      schemaKey: 'je.communication.message-content',
      schemaVersion: 1,
      classification: 'communication.authoring.message',
      contentType: 'application/vnd.jooevents.communication-message-content+json'
    });
  });

  test('returns an opaque browser ref without exposing internal digest or size', () => {
    const canonical = canonicalizeOrganizerAuthoringPayload({
      payloadKind: 'message_content',
      schemaVersion: 1,
      value: { kind: 'email/v1', subject: 'Hello', body: { kind: 'plain_text/v1', text: '' } }
    });
    const ref = createOrganizerAuthoringPayloadRef({ payloadRefId: 'payload-message-1', canonical });
    expect(ref).toEqual({
      payloadRefId: 'payload-message-1',
      payloadRefVersion: 1,
      payloadKind: 'message_content',
      schemaKey: 'je.communication.message-content',
      schemaVersion: 1,
      classification: 'communication.authoring.message'
    });
    expect('digestSha256' in ref).toBe(false);
    expect('canonicalByteLength' in ref).toBe(false);
  });

  test('rejects unknown shapes, controls, and canonical byte overflow', () => {
    expect(() => canonicalizeOrganizerAuthoringPayload({
      payloadKind: 'message_content',
      schemaVersion: 1,
      value: {
        kind: 'email/v1', subject: 'Hello\u0000',
        body: { kind: 'plain_text/v1', text: '' }
      }
    })).toThrow(OrganizerAuthoringPayloadError);
    expect(() => canonicalizeOrganizerAuthoringPayload({
      payloadKind: 'message_content', schemaVersion: 1,
      value: { kind: 'email/v1', subject: 'Hello', body: { kind: 'plain_text/v1', text: '' } },
      storageKey: 'caller-selected'
    })).toThrow(OrganizerAuthoringPayloadError);

    const multibyte = '界'.repeat(Math.floor(ORGANIZER_AUTHORING_PAYLOAD_MAXIMUM_BYTES / 3));
    expect(() => canonicalizeOrganizerAuthoringPayload({
      payloadKind: 'template_content', schemaVersion: 1,
      value: {
        kind: 'email/v1', subject: [], plainTextPolicy: 'derive_v1', attachmentSlotKeys: [],
        body: { mode: 'open_canvas', inertSource: multibyte, parameterKeys: [], complianceAnchors: [],
          sanitizerContract: { reference: { key: 'sanitizer.pending', version: 1 },
            definitionDigestSha256: 'a'.repeat(64) } }
      }
    })).toThrow(OrganizerAuthoringPayloadError);
  });
});
