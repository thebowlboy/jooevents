import {
  SUBMISSION_CONFIRMATION_STANDING_POLICY,
  SUBMISSION_CONFIRMATION_TEMPLATE_REVISION_REF_ID
} from '@jooevents/communications';
import { organizerCommunicationPurposeRevisionRefSchema } from '@jooevents/contracts';
import { z } from 'zod';

/** Runtime-neutral retained plan shape shared by SQLite and D1 history projections. */
export const submissionConfirmationReleasePlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('submission_confirmation'),
  scope: z.strictObject({ workspaceId: z.uuid(), eventId: z.uuid() }),
  batchId: z.string().min(1).max(256),
  submissionId: z.uuid(),
  causationFactId: z.string().min(1).max(256),
  intakeReceiptId: z.string().min(1).max(256),
  purposeRevision: organizerCommunicationPurposeRevisionRefSchema,
  policy: z.strictObject({
    key: z.literal(SUBMISSION_CONFIRMATION_STANDING_POLICY.key),
    version: z.literal(SUBMISSION_CONFIRMATION_STANDING_POLICY.version),
    digestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    authorizedAt: z.iso.datetime({ offset: true }),
    authorizationExpiresAt: z.iso.datetime({ offset: true }),
    maximumRegistrationsPerSubmission: z.literal(1)
  }),
  templateRevisionRefId: z.literal(SUBMISSION_CONFIRMATION_TEMPLATE_REVISION_REF_ID),
  subject: z.string().min(1).max(998),
  audienceLabel: z.string().min(1).max(200),
  release: z.strictObject({
    releaseId: z.string().min(1).max(256),
    deliveryId: z.string().min(1).max(256),
    recipientRefId: z.string().min(1).max(256),
    personRefId: z.string().min(1).max(256),
    contactRefId: z.string().min(1).max(256)
  })
});

export type SubmissionConfirmationReleasePlan =
  z.infer<typeof submissionConfirmationReleasePlanSchema>;

export function parseSubmissionConfirmationReleasePlan(
  value: unknown
): SubmissionConfirmationReleasePlan {
  return submissionConfirmationReleasePlanSchema.parse(value);
}
