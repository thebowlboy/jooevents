import {
  CALENDAR_NOTICE_PURPOSE_KEY,
  CALENDAR_NOTICE_STANDING_POLICY,
  CALENDAR_NOTICE_TEMPLATE_REVISION_REF_ID
} from '@jooevents/communications';
import { organizerCommunicationPurposeRevisionRefSchema } from '@jooevents/contracts';
import { z } from 'zod';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const calendarNoticeReleasePlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('calendar_notice'),
  scope: z.strictObject({ workspaceId: z.uuid(), eventId: z.uuid() }),
  batchId: z.string().min(1).max(256),
  generationId: z.uuid(),
  generationNumber: z.number().int().positive(),
  personId: z.uuid(),
  purposeRevision: organizerCommunicationPurposeRevisionRefSchema,
  policy: z.strictObject({
    key: z.literal(CALENDAR_NOTICE_STANDING_POLICY.key),
    version: z.literal(CALENDAR_NOTICE_STANDING_POLICY.version),
    authorizedAt: z.iso.datetime({ offset: true }),
    switchDefault: z.literal('off')
  }),
  templateRevisionRefId: z.literal(CALENDAR_NOTICE_TEMPLATE_REVISION_REF_ID),
  purposeKey: z.literal(CALENDAR_NOTICE_PURPOSE_KEY),
  mode: z.enum(['invite_primary', 'feed_primary']),
  noOp: z.boolean(),
  artifacts: z.array(z.strictObject({
    method: z.enum(['REQUEST', 'CANCEL']),
    contentBytesRef: z.uuid(),
    byteLength: z.number().int().nonnegative(),
    contentSha256: sha256,
    sequences: z.array(z.strictObject({
      commitmentId: z.uuid(),
      uid: z.string().min(1).max(512),
      sequence: z.number().int().nonnegative()
    })).min(1)
  })).max(2),
  release: z.strictObject({
    releaseId: z.uuid(),
    deliveryId: z.uuid().nullable(),
    recipientRefId: z.string().min(1).max(256),
    personRefId: z.uuid(),
    contactRefId: z.string().min(1).max(256).nullable()
  })
}).superRefine((plan, context) => {
  if (plan.noOp !== (plan.release.deliveryId === null)) {
    context.addIssue({ code: 'custom', path: ['noOp'], message: 'No-op plan binding is invalid.' });
  }
  if (plan.mode === 'feed_primary' && plan.artifacts.length !== 0) {
    context.addIssue({ code: 'custom', path: ['artifacts'], message: 'Feed-primary releases are plain email.' });
  }
});

export type CalendarNoticeReleasePlan = z.infer<typeof calendarNoticeReleasePlanSchema>;

export function parseCalendarNoticeReleasePlan(value: unknown): CalendarNoticeReleasePlan {
  return calendarNoticeReleasePlanSchema.parse(value);
}
