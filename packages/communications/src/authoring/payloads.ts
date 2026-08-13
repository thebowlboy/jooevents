import {
  organizerCommunicationAuthoringPayloadInputSchema,
  organizerCommunicationAuthoringPayloadRefSchema,
  type OrganizerCommunicationAuthoringPayloadInput,
  type OrganizerCommunicationAuthoringPayloadRef
} from '@jooevents/contracts/communications/organizer';
import { encodeCanonicalJson } from '@jooevents/kernel';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const ORGANIZER_AUTHORING_PAYLOAD_MAXIMUM_BYTES = 1_048_576;

export type OrganizerAuthoringPayloadKind = OrganizerCommunicationAuthoringPayloadInput['payloadKind'];

export interface OrganizerAuthoringPayloadProfile {
  readonly payloadKind: OrganizerAuthoringPayloadKind;
  readonly schemaKey: string;
  readonly schemaVersion: 1;
  readonly classification: string;
  readonly contentType: string;
}

export const ORGANIZER_AUTHORING_PAYLOAD_PROFILES: Readonly<
  Record<OrganizerAuthoringPayloadKind, OrganizerAuthoringPayloadProfile>
> = Object.freeze({
  template_content: Object.freeze({
    payloadKind: 'template_content',
    schemaKey: 'je.communication.template-content',
    schemaVersion: 1,
    classification: 'communication.authoring.template',
    contentType: 'application/vnd.jooevents.communication-template-content+json'
  }),
  template_field_bindings: Object.freeze({
    payloadKind: 'template_field_bindings',
    schemaKey: 'je.communication.template-field-bindings',
    schemaVersion: 1,
    classification: 'communication.authoring.template',
    contentType: 'application/vnd.jooevents.communication-template-field-bindings+json'
  }),
  template_field_fallback: Object.freeze({
    payloadKind: 'template_field_fallback',
    schemaKey: 'je.communication.template-field-fallback',
    schemaVersion: 1,
    classification: 'communication.authoring.template',
    contentType: 'application/vnd.jooevents.communication-template-field-fallback+json'
  }),
  message_content: Object.freeze({
    payloadKind: 'message_content',
    schemaKey: 'je.communication.message-content',
    schemaVersion: 1,
    classification: 'communication.authoring.message',
    contentType: 'application/vnd.jooevents.communication-message-content+json'
  }),
  message_audience_draft: Object.freeze({
    payloadKind: 'message_audience_draft',
    schemaKey: 'je.communication.audience-draft',
    schemaVersion: 1,
    classification: 'communication.authoring.audience',
    contentType: 'application/vnd.jooevents.communication-audience-draft+json'
  })
});

export type OrganizerAuthoringPayloadErrorCode = 'invalid_payload' | 'payload_too_large';

export class OrganizerAuthoringPayloadError extends Error {
  constructor(readonly code: OrganizerAuthoringPayloadErrorCode) {
    super(code);
    this.name = 'OrganizerAuthoringPayloadError';
  }
}

export interface CanonicalOrganizerAuthoringPayload {
  readonly payload: OrganizerCommunicationAuthoringPayloadInput;
  readonly profile: OrganizerAuthoringPayloadProfile;
  readonly bytes: Uint8Array;
  readonly digestSha256: string;
}

/** Canonicalizes only the five inert browser-authoring envelopes frozen in C0. */
export function canonicalizeOrganizerAuthoringPayload(
  candidate: unknown
): CanonicalOrganizerAuthoringPayload {
  let payload: OrganizerCommunicationAuthoringPayloadInput;
  try {
    payload = organizerCommunicationAuthoringPayloadInputSchema.parse(candidate);
  } catch {
    throw new OrganizerAuthoringPayloadError('invalid_payload');
  }
  const bytes = encodeCanonicalJson(payload);
  if (bytes.byteLength > ORGANIZER_AUTHORING_PAYLOAD_MAXIMUM_BYTES) {
    throw new OrganizerAuthoringPayloadError('payload_too_large');
  }
  return Object.freeze({
    payload,
    profile: ORGANIZER_AUTHORING_PAYLOAD_PROFILES[payload.payloadKind],
    bytes: Uint8Array.from(bytes),
    digestSha256: bytesToHex(sha256(bytes))
  });
}

export function createOrganizerAuthoringPayloadRef(input: {
  readonly payloadRefId: string;
  readonly canonical: CanonicalOrganizerAuthoringPayload;
}): OrganizerCommunicationAuthoringPayloadRef {
  try {
    return organizerCommunicationAuthoringPayloadRefSchema.parse({
      payloadRefId: input.payloadRefId,
      payloadRefVersion: 1,
      payloadKind: input.canonical.profile.payloadKind,
      schemaKey: input.canonical.profile.schemaKey,
      schemaVersion: input.canonical.profile.schemaVersion,
      classification: input.canonical.profile.classification
    });
  } catch {
    throw new OrganizerAuthoringPayloadError('invalid_payload');
  }
}

