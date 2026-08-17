import {
  createClassifiedPayloadProfileRef,
  type ClassifiedPayloadProfiles
} from '@jooevents/application';
import type { SynchronousClassifiedPayloadBinding } from '@jooevents/application/synchronous-classified-payload-store';
import {
  ORGANIZER_AUTHORING_PAYLOAD_PROFILES,
  type OrganizerAuthoringPayloadKind
} from '@jooevents/communications';
import { canonicalJsonText, parseEventId, parseWorkspaceId } from '@jooevents/kernel';

export interface CommunicationAuthoringClassifiedPayloadScope {
  readonly workspaceId: string;
  readonly eventId: string;
}

function profiles(kind: OrganizerAuthoringPayloadKind): ClassifiedPayloadProfiles {
  const profile = ORGANIZER_AUTHORING_PAYLOAD_PROFILES[kind];
  return Object.freeze({
    classification: createClassifiedPayloadProfileRef(
      'classification',
      `classification.${profile.classification}`,
      1
    ),
    schema: createClassifiedPayloadProfileRef('schema', `schema.${profile.schemaKey}`, 1),
    content: createClassifiedPayloadProfileRef('content', `content.${kind}`, 1),
    integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
    descriptorAuth: createClassifiedPayloadProfileRef(
      'descriptor_auth',
      'descriptor_auth.communication.authoring',
      1
    )
  });
}

/** Exact descriptor binding shared by retained SQLite and Worker/D1 authoring stores. */
export function createCommunicationAuthoringClassifiedPayloadBinding(input: {
  readonly scope: CommunicationAuthoringClassifiedPayloadScope;
  readonly ownerKey: string;
  readonly kind: OrganizerAuthoringPayloadKind;
}): SynchronousClassifiedPayloadBinding {
  return Object.freeze({
    profiles: profiles(input.kind),
    scopeBinding: canonicalJsonText({
      eventId: parseEventId(input.scope.eventId),
      ownerKey: input.ownerKey,
      workspaceId: parseWorkspaceId(input.scope.workspaceId)
    }),
    contentType: ORGANIZER_AUTHORING_PAYLOAD_PROFILES[input.kind].contentType
  });
}

export function communicationAuthoringClassifiedPayloadPurpose(
  kind: OrganizerAuthoringPayloadKind
): string {
  return `communication.authoring.${kind}`;
}
