import {
  ImmutableClassifiedPayloadRecordCodec,
  type ImmutableClassifiedPayloadRecordCodecOptions
} from '@jooevents/application/immutable-classified-payload-record';
import {
  CommunicationMessageReleaseError,
  parseCommunicationMessageRelease,
  type OutboundEmailEnvelopeResolver
} from '@jooevents/communications';
import { createPayloadRef, parsePayloadRefId } from '@jooevents/kernel';
import {
  COMMUNICATION_MESSAGE_RELEASE_ENVELOPE_PURPOSE,
  communicationMessageReleaseEnvelopeBinding
} from '@jooevents/persistence/communication-message-release-classification';
import { readD1ClassifiedPayloadRecords } from './d1-classified-payload-store';

interface ReleaseRow {
  readonly release_id: string;
  readonly workspace_id: string;
  readonly event_id: string;
  readonly batch_id: string;
  readonly recipient_ref_id: string;
  readonly person_ref_id: string;
  readonly contact_ref_id: string;
  readonly template_revision_ref_id: string;
  readonly content_ref_id: string;
  readonly purpose_key: string;
  readonly reviewed_message_digest_sha256: string;
  readonly reviewed_envelope_digest_sha256: string;
  readonly envelope_payload_ref_id: string;
  readonly envelope_byte_size: number;
  readonly envelope_digest_sha256: string;
  readonly created_at: string;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  ));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Opens one immutable, encrypted reviewed release from D1 for provider dispatch. */
export function createD1OutboundEmailEnvelopeResolver(input: {
  readonly database: D1Database;
  readonly classifiedPayload: ImmutableClassifiedPayloadRecordCodecOptions;
}): OutboundEmailEnvelopeResolver {
  return Object.freeze({
    async resolve({ releaseId, recipientRefId, templateRevisionRefId, contentRefId }:
      Parameters<OutboundEmailEnvelopeResolver['resolve']>[0]) {
      const session = input.database.withSession('first-primary');
      const row = await session.prepare(`SELECT
        release_id,workspace_id,event_id,batch_id,recipient_ref_id,person_ref_id,
        contact_ref_id,template_revision_ref_id,content_ref_id,purpose_key,
        reviewed_message_digest_sha256,reviewed_envelope_digest_sha256,
        envelope_payload_ref_id,envelope_byte_size,envelope_digest_sha256,created_at
        FROM communication_message_releases WHERE release_id = ? LIMIT 2`
      ).bind(releaseId).first<ReleaseRow>();
      if (!row) throw new CommunicationMessageReleaseError('release_not_found');
      if (row.recipient_ref_id !== recipientRefId
          || row.template_revision_ref_id !== templateRevisionRefId
          || row.content_ref_id !== contentRefId) {
        throw new CommunicationMessageReleaseError('release_binding_mismatch');
      }
      const payloadRefId = parsePayloadRefId(row.envelope_payload_ref_id);
      const records = await readD1ClassifiedPayloadRecords(session, [payloadRefId]);
      if (records.length !== 1) throw new CommunicationMessageReleaseError('invalid_release');
      const codec = new ImmutableClassifiedPayloadRecordCodec(input.classifiedPayload);
      let bytes: Uint8Array | undefined;
      try {
        bytes = codec.read(records[0]!, {
          payloadRef: createPayloadRef(payloadRefId),
          expectedBinding: communicationMessageReleaseEnvelopeBinding({
            workspaceId: row.workspace_id,
            eventId: row.event_id,
            batchId: row.batch_id,
            releaseId: row.release_id
          }),
          purpose: COMMUNICATION_MESSAGE_RELEASE_ENVELOPE_PURPOSE
        });
        if (bytes.byteLength !== row.envelope_byte_size
            || await sha256(bytes) !== row.envelope_digest_sha256) {
          throw new CommunicationMessageReleaseError('invalid_release');
        }
        const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        return parseCommunicationMessageRelease({
          contractVersion: 1,
          workspaceId: row.workspace_id,
          eventId: row.event_id,
          releaseId: row.release_id,
          batchId: row.batch_id,
          recipientRefId: row.recipient_ref_id,
          personRefId: row.person_ref_id,
          contactRefId: row.contact_ref_id,
          templateRevisionRefId: row.template_revision_ref_id,
          contentRefId: row.content_ref_id,
          purposeKey: row.purpose_key,
          reviewedMessageDigestSha256: row.reviewed_message_digest_sha256,
          reviewedEnvelopeDigestSha256: row.reviewed_envelope_digest_sha256,
          envelope,
          createdAt: row.created_at
        }).envelope;
      } catch (error) {
        if (error instanceof CommunicationMessageReleaseError) throw error;
        throw new CommunicationMessageReleaseError('invalid_release');
      } finally {
        bytes?.fill(0);
      }
    }
  });
}
