import {
  ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID,
  ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID,
  organizerCommunicationDraftProvenanceSchema,
  organizerCommunicationOpaqueIdSchema,
  organizerCommunicationPurposeRevisionRefSchema,
  organizerCreateCommunicationDraftInputSchema,
  organizerDiscardCommunicationDraftInputSchema,
  organizerMessageAudiencePayloadRefSchema,
  organizerMessageContentPayloadRefSchema,
  organizerMessageTemplateRevisionRefSchema,
  organizerReviseCommunicationDraftInputSchema,
  type OrganizerCommunicationDraftProvenance,
  type OrganizerCommunicationPurposeRevisionRef,
  type OrganizerMessageTemplateRevisionRef
} from '@jooevents/contracts/communications/organizer';
import { parseInstant, type Instant } from '@jooevents/kernel';

export type OrganizerStoredDraftAuthoring =
  | {
      readonly state: 'uninitialized';
      readonly contentRefId: typeof ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID;
      readonly audienceRefId: typeof ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID;
    }
  | {
      readonly state: 'ready';
      readonly contentPayload: ReturnType<typeof organizerMessageContentPayloadRefSchema.parse>;
      readonly audiencePayload: ReturnType<typeof organizerMessageAudiencePayloadRefSchema.parse>;
    };

export interface OrganizerMessageDraftRecord {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly ownerKey: string;
  readonly draftId: string;
  readonly version: number;
  readonly state: 'active' | 'proposed' | 'discarded';
  readonly channel: 'email';
  readonly purposeRevision: OrganizerCommunicationPurposeRevisionRef;
  readonly templateRevision?: OrganizerMessageTemplateRevisionRef;
  readonly authoring: OrganizerStoredDraftAuthoring;
  readonly provenance: OrganizerCommunicationDraftProvenance;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly discardReasonCode?: string;
}

export type OrganizerMessageDraftErrorCode =
  | 'invalid_input'
  | 'stale_revision'
  | 'draft_not_active';

export class OrganizerMessageDraftError extends Error {
  constructor(readonly code: OrganizerMessageDraftErrorCode) {
    super(code);
    this.name = 'OrganizerMessageDraftError';
  }
}

function canonicalIdentity(value: unknown): string {
  try {
    return organizerCommunicationOpaqueIdSchema.parse(value);
  } catch {
    throw new OrganizerMessageDraftError('invalid_input');
  }
}

function canonicalInstant(value: unknown): Instant {
  try {
    return parseInstant(value);
  } catch {
    throw new OrganizerMessageDraftError('invalid_input');
  }
}

function freezeRecord(record: OrganizerMessageDraftRecord): OrganizerMessageDraftRecord {
  return Object.freeze({
    ...record,
    purposeRevision: Object.freeze({ ...record.purposeRevision }),
    ...(record.templateRevision === undefined
      ? {}
      : { templateRevision: Object.freeze({ ...record.templateRevision }) }),
    authoring: Object.freeze({ ...record.authoring }),
    provenance: Object.freeze({ ...record.provenance })
  });
}

export function createOrganizerMessageDraft(input: {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly ownerKey: string;
  readonly draftId: string;
  readonly businessInput: unknown;
  readonly provenance: unknown;
  readonly now: unknown;
}): OrganizerMessageDraftRecord {
  let businessInput: ReturnType<typeof organizerCreateCommunicationDraftInputSchema.parse>;
  let provenance: OrganizerCommunicationDraftProvenance;
  try {
    businessInput = organizerCreateCommunicationDraftInputSchema.parse(input.businessInput);
    provenance = organizerCommunicationDraftProvenanceSchema.parse(input.provenance);
  } catch {
    throw new OrganizerMessageDraftError('invalid_input');
  }
  const now = canonicalInstant(input.now);
  const authoring: OrganizerStoredDraftAuthoring = businessInput.initial.kind === 'registered_empty_refs'
    ? Object.freeze({
        state: 'uninitialized',
        contentRefId: businessInput.initial.contentRefId,
        audienceRefId: businessInput.initial.audienceRefId
      })
    : Object.freeze({
        state: 'ready',
        contentPayload: organizerMessageContentPayloadRefSchema.parse(
          businessInput.initial.contentPayload
        ),
        audiencePayload: organizerMessageAudiencePayloadRefSchema.parse(
          businessInput.initial.audiencePayload
        )
      });
  return freezeRecord({
    workspaceId: canonicalIdentity(input.workspaceId),
    eventId: canonicalIdentity(input.eventId),
    ownerKey: canonicalIdentity(input.ownerKey),
    draftId: canonicalIdentity(input.draftId),
    version: 1,
    state: 'active',
    channel: 'email',
    purposeRevision: organizerCommunicationPurposeRevisionRefSchema.parse(
      businessInput.purposeRevision
    ),
    ...(businessInput.templateRevision === undefined
      ? {}
      : {
          templateRevision: organizerMessageTemplateRevisionRefSchema.parse(
            businessInput.templateRevision
          )
        }),
    authoring,
    provenance,
    createdAt: now,
    updatedAt: now
  });
}

export function reviseOrganizerMessageDraft(input: {
  readonly current: OrganizerMessageDraftRecord;
  readonly businessInput: unknown;
  readonly now: unknown;
}): OrganizerMessageDraftRecord {
  let businessInput: ReturnType<typeof organizerReviseCommunicationDraftInputSchema.parse>;
  try {
    businessInput = organizerReviseCommunicationDraftInputSchema.parse(input.businessInput);
  } catch {
    throw new OrganizerMessageDraftError('invalid_input');
  }
  if (businessInput.draftId !== input.current.draftId
      || businessInput.expectedVersion !== input.current.version) {
    throw new OrganizerMessageDraftError('stale_revision');
  }
  if (input.current.state !== 'active') {
    throw new OrganizerMessageDraftError('draft_not_active');
  }
  return freezeRecord({
    ...input.current,
    version: input.current.version + 1,
    authoring: Object.freeze({
      state: 'ready',
      contentPayload: organizerMessageContentPayloadRefSchema.parse(businessInput.contentPayload),
      audiencePayload: organizerMessageAudiencePayloadRefSchema.parse(businessInput.audiencePayload)
    }),
    updatedAt: canonicalInstant(input.now)
  });
}

export function discardOrganizerMessageDraft(input: {
  readonly current: OrganizerMessageDraftRecord;
  readonly businessInput: unknown;
  readonly now: unknown;
}): OrganizerMessageDraftRecord {
  let businessInput: ReturnType<typeof organizerDiscardCommunicationDraftInputSchema.parse>;
  try {
    businessInput = organizerDiscardCommunicationDraftInputSchema.parse(input.businessInput);
  } catch {
    throw new OrganizerMessageDraftError('invalid_input');
  }
  if (businessInput.draftId !== input.current.draftId
      || businessInput.expectedVersion !== input.current.version) {
    throw new OrganizerMessageDraftError('stale_revision');
  }
  if (input.current.state !== 'active') {
    throw new OrganizerMessageDraftError('draft_not_active');
  }
  return freezeRecord({
    ...input.current,
    version: input.current.version + 1,
    state: 'discarded',
    discardReasonCode: businessInput.reasonCode,
    updatedAt: canonicalInstant(input.now)
  });
}
