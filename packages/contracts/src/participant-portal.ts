import { z } from 'zod';

/**
 * Participant-lane contracts: what a person who submitted talks may be shown
 * about their own world, and the results of the email sign-in-link operations
 * that let them in.
 *
 * Draft until an operation serves them: these shapes carry no deprecation
 * promise while no transport binds them.
 *
 * Two rules bind every schema here. Decision state is *communicated* state —
 * the field says what the participant has been told, never what an organizer
 * has decided and not yet sent. And nothing organizer-internal (trays, review
 * identities, scores, notes) has a representation in this lane at all.
 */

const portalIdSchema = z.string().min(1);
const instantSchema = z.iso.datetime({ offset: true });

export const portalParticipantSchema = z.strictObject({
  id: portalIdSchema,
  displayName: z.string().min(1),
  email: z.email()
});

export const portalEventSchema = z.strictObject({
  id: portalIdSchema,
  name: z.string().min(1),
  timezone: z.string().min(1),
  cfpClosesAt: instantSchema,
  /** `soft` accepts a late arrival and labels it; `hard` stops it. */
  closePolicy: z.enum(['soft', 'hard'])
});

/**
 * Server-owned participant access state. `expired` is a resolved server answer
 * — a link that no longer proves anything — not a browser-side guess, and the
 * lane has no counterpart to the operator context's provisioning states.
 */
export const participantContextSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('anonymous') }),
  z.strictObject({
    state: z.literal('active'),
    participant: portalParticipantSchema,
    event: portalEventSchema
  }),
  z.strictObject({ state: z.literal('expired') })
]);

export const portalSubmissionStatusSchema = z.enum([
  'submitted',
  'in_review',
  'accepted',
  'declined',
  'waitlisted',
  'withdrawn'
]);

/** One pinned question and the answer as it was submitted. */
export const portalAnswerSchema = z.strictObject({
  fieldId: portalIdSchema,
  label: z.string().min(1),
  value: z.string()
});

/** Where the submitter said the talk belongs, as the form offered it. */
export const portalSubmissionTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('new_session') }),
  z.strictObject({
    kind: z.literal('collecting_session'),
    sessionId: portalIdSchema,
    name: z.string().min(1)
  })
]);

export const portalSpeakerSchema = z.strictObject({
  participantId: portalIdSchema,
  displayName: z.string().min(1)
});

/**
 * Shared authority over a co-presented submission. `any_participant_acts` is
 * the only served policy: one listed speaker's action binds the group and the
 * others are informed of it.
 */
export const portalSpeakerAuthoritySchema = z.enum(['any_participant_acts']);

export const portalAppealSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unavailable') }),
  z.strictObject({ kind: z.literal('available') }),
  z.strictObject({
    kind: z.literal('submitted'),
    submittedAt: instantSchema,
    reason: z.string().min(1)
  })
]);

/**
 * One appended entry of the participant's own history, in the shared timeline
 * envelope. The actor is a kind rather than a person: organizer and reviewer
 * identities are never projected into this lane, and nothing here is ever
 * rewritten — a correction arrives as a later entry.
 */
export const portalTimelineEventSchema = z.strictObject({
  id: portalIdSchema,
  occurredAt: instantSchema,
  actor: z.enum(['you', 'organizers']),
  kind: z.enum([
    'submitted',
    'edited',
    'withdrawn',
    'status_communicated',
    'appeal_submitted',
    'engagement_invited',
    'engagement_responded',
    'task_completed'
  ]),
  summary: z.string().min(1)
});

export const portalSubmissionSchema = z.strictObject({
  id: portalIdSchema,
  title: z.string().min(1),
  formVersion: z.number().int().positive(),
  answers: z.array(portalAnswerSchema),
  target: portalSubmissionTargetSchema,
  status: portalSubmissionStatusSchema,
  /** When the participant was told the current status; null while untold. */
  statusNotifiedAt: instantSchema.nullable(),
  submittedAt: instantSchema,
  editableUntilClose: z.boolean(),
  late: z.boolean(),
  speakers: z.array(portalSpeakerSchema).min(1),
  speakerAuthority: portalSpeakerAuthoritySchema,
  appeal: portalAppealSchema,
  timeline: z.array(portalTimelineEventSchema)
});

/** Who confirmed, kept attributable — a confirmation is never anonymous. */
export const portalEngagementConfirmationSchema = z.discriminatedUnion('by', [
  z.strictObject({ by: z.literal('you'), at: instantSchema }),
  z.strictObject({ by: z.literal('co_speaker'), at: instantSchema, displayName: z.string().min(1) }),
  z.strictObject({ by: z.literal('organizer'), at: instantSchema, displayName: z.string().min(1) })
]);

export const portalEngagementSchema = z.strictObject({
  id: portalIdSchema,
  sessionId: portalIdSchema,
  sessionTitle: z.string().min(1),
  submissionId: portalIdSchema.nullable(),
  status: z.enum(['invited', 'confirmed', 'declined', 'cancelled']),
  invitedAt: instantSchema,
  respondBy: instantSchema.nullable(),
  confirmation: portalEngagementConfirmationSchema.nullable(),
  speakers: z.array(portalSpeakerSchema).min(1)
});

export const portalTaskCompletionSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('acknowledge') }),
  z.strictObject({
    mode: z.literal('upload'),
    acceptedTypes: z.array(z.string().min(1)).min(1),
    receivedFileId: portalIdSchema.nullable()
  }),
  z.strictObject({ mode: z.literal('form_fill'), formId: portalIdSchema }),
  z.strictObject({ mode: z.literal('external'), url: z.url() })
]);

export const portalTaskStateSchema = z.enum(['todo', 'received_pending_check', 'complete', 'late']);

export const portalTaskSchema = z.strictObject({
  id: portalIdSchema,
  title: z.string().min(1),
  required: z.boolean(),
  completion: portalTaskCompletionSchema,
  state: portalTaskStateSchema,
  dueAt: instantSchema.nullable(),
  /** The deadline's own zone, carried so a due date can be shown where it was set. */
  timezone: z.string().min(1),
  closePolicy: z.enum(['soft', 'hard']),
  sessionId: portalIdSchema.nullable()
});

export const portalFileSchema = z.strictObject({
  id: portalIdSchema,
  name: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  uploadedAt: instantSchema,
  taskId: portalIdSchema.nullable()
});

export const portalResourceSchema = z.strictObject({
  id: portalIdSchema,
  title: z.string().min(1),
  kind: z.enum(['link', 'document']),
  url: z.url(),
  detail: z.string().min(1).nullable()
});

export const portalProfileFieldAccessSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('editable') }),
  z.strictObject({
    kind: z.literal('locked'),
    reason: z.enum(['organizer_managed', 'verified_identity', 'locked_after_acceptance']),
    changeRequested: z.boolean()
  })
]);

export const portalProfileFieldSchema = z.strictObject({
  id: portalIdSchema,
  label: z.string().min(1),
  value: z.string(),
  kind: z.enum(['text', 'long_text', 'email', 'url']),
  access: portalProfileFieldAccessSchema
});

export const portalProfileSchema = z.strictObject({
  fields: z.array(portalProfileFieldSchema)
});

export const portalSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  participant: portalParticipantSchema,
  event: portalEventSchema,
  submissions: z.array(portalSubmissionSchema),
  engagements: z.array(portalEngagementSchema),
  tasks: z.array(portalTaskSchema),
  files: z.array(portalFileSchema),
  resources: z.array(portalResourceSchema),
  profile: portalProfileSchema
});

/**
 * The acknowledgement of a sign-in-link request. It has one shape on purpose:
 * a caller cannot learn from it whether the address is known.
 */
export const signInLinkRequestResultSchema = z.strictObject({
  outcome: z.literal('link_requested')
});

/** What consuming a link produced. Every failure is named rather than generic. */
export const signInLinkCallbackResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('signed_in') }),
  z.strictObject({ outcome: z.literal('link_expired') }),
  z.strictObject({ outcome: z.literal('link_used') }),
  z.strictObject({ outcome: z.literal('link_invalid') })
]);

export type PortalParticipantDto = z.infer<typeof portalParticipantSchema>;
export type PortalEventDto = z.infer<typeof portalEventSchema>;
export type ParticipantContext = z.infer<typeof participantContextSchema>;
export type PortalSubmissionStatus = z.infer<typeof portalSubmissionStatusSchema>;
export type PortalAnswerDto = z.infer<typeof portalAnswerSchema>;
export type PortalSubmissionTargetDto = z.infer<typeof portalSubmissionTargetSchema>;
export type PortalSpeakerDto = z.infer<typeof portalSpeakerSchema>;
export type PortalSpeakerAuthority = z.infer<typeof portalSpeakerAuthoritySchema>;
export type PortalAppealDto = z.infer<typeof portalAppealSchema>;
export type PortalTimelineEventDto = z.infer<typeof portalTimelineEventSchema>;
export type PortalSubmissionDto = z.infer<typeof portalSubmissionSchema>;
export type PortalEngagementConfirmationDto = z.infer<typeof portalEngagementConfirmationSchema>;
export type PortalEngagementDto = z.infer<typeof portalEngagementSchema>;
export type PortalTaskCompletionDto = z.infer<typeof portalTaskCompletionSchema>;
export type PortalTaskState = z.infer<typeof portalTaskStateSchema>;
export type PortalTaskDto = z.infer<typeof portalTaskSchema>;
export type PortalFileDto = z.infer<typeof portalFileSchema>;
export type PortalResourceDto = z.infer<typeof portalResourceSchema>;
export type PortalProfileFieldAccessDto = z.infer<typeof portalProfileFieldAccessSchema>;
export type PortalProfileFieldDto = z.infer<typeof portalProfileFieldSchema>;
export type PortalProfileDto = z.infer<typeof portalProfileSchema>;
export type PortalSnapshotDto = z.infer<typeof portalSnapshotSchema>;
export type SignInLinkRequestResult = z.infer<typeof signInLinkRequestResultSchema>;
export type SignInLinkCallbackResult = z.infer<typeof signInLinkCallbackResultSchema>;
