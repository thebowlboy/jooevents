import {
  createClassifiedPayloadProfileRef,
  type ClassifiedPayloadProfiles
} from '@jooevents/application';
import type { SynchronousClassifiedPayloadBinding } from
  '@jooevents/application/synchronous-classified-payload-store';
import type { CommunicationMessageRelease } from '@jooevents/communications';
import { canonicalJsonText } from '@jooevents/kernel';

export function communicationMessageReleaseEnvelopeProfiles(): ClassifiedPayloadProfiles {
  return Object.freeze({
    classification: createClassifiedPayloadProfileRef(
      'classification', 'classification.communication.message-release.envelope', 1
    ),
    schema: createClassifiedPayloadProfileRef(
      'schema', 'schema.communication.message-release.envelope', 1
    ),
    content: createClassifiedPayloadProfileRef(
      'content', 'content.communication.message-release.envelope', 1
    ),
    integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
    descriptorAuth: createClassifiedPayloadProfileRef(
      'descriptor_auth', 'descriptor_auth.communication.message-release', 1
    )
  });
}

export function communicationMessageReleaseEnvelopeBinding(release: Pick<
  CommunicationMessageRelease,
  'workspaceId' | 'eventId' | 'batchId' | 'releaseId'
>): SynchronousClassifiedPayloadBinding {
  return Object.freeze({
    profiles: communicationMessageReleaseEnvelopeProfiles(),
    scopeBinding: canonicalJsonText({
      workspaceId: release.workspaceId,
      eventId: release.eventId,
      batchId: release.batchId,
      releaseId: release.releaseId
    }),
    contentType: 'application/json'
  });
}

export const COMMUNICATION_MESSAGE_RELEASE_ENVELOPE_PURPOSE =
  'communication.message-release.envelope';
