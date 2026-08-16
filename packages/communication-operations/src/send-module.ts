import { createHash } from 'node:crypto';
import {
  providerOpaqueIdSchema,
  providerPositiveVersionSchema,
  providerSha256Schema,
  providerStableKeySchema,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  organizerCommunicationPurposeRevisionRefSchema,
  organizerMessagePreviewIdentitySchema,
  organizerMessagePreviewSourceVersionSchema,
  organizerMessageTemplateRevisionRefSchema
} from '@jooevents/contracts/communications/organizer';
import { parseContractVersion, encodeCanonicalJson } from '@jooevents/kernel';
import type { VersionedAccessPolicyRef } from '@jooevents/identity-access';
import { z } from 'zod';

/**
 * The send wave is one consequential, owner-native reviewed release batch.
 * `send_messages` commits the exact adopted preview and its delivery effects
 * in one atomic domain transaction.
 */
export const SEND_MESSAGES_OPERATION = Object.freeze({ name: 'send_messages', version: 1 });

/** Hard batch ceiling shared with the audience contract (BLOCKED-12). */
export const SEND_MESSAGES_RECIPIENT_LIMIT = 10_000;

export const SEND_MESSAGES_DRAFT_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.communication.send-messages.draft',
  version: parseContractVersion(1)
});

export const SEND_MESSAGES_APPROVAL_POLICY = (() => {
  const reference = Object.freeze({ key: 'policy.communication.send-messages.bounded', version: 1 });
  const definition = Object.freeze({ reference, requirement: 'none' as const });
  return Object.freeze({
    ...definition,
    definitionDigestSha256: createHash('sha256')
      .update(encodeCanonicalJson(definition))
      .digest('hex')
  });
})();

function sortedUniqueIssues(
  values: readonly string[],
  context: z.core.$RefinementCtx,
  path: readonly (string | number)[],
  message: string
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) {
      context.addIssue({ code: 'custom', path: [...path, index], message });
    }
  }
}

/**
 * One recipient's reviewed release specification. It carries opaque references
 * and reviewed digests only — never an address value; the classified envelope
 * lives solely in the immutable release store this plan commits beside.
 */
export const sendMessagesReleaseSpecSchema = z.strictObject({
  releaseId: providerOpaqueIdSchema,
  deliveryId: providerOpaqueIdSchema,
  recipientRefId: providerOpaqueIdSchema,
  personRefId: providerOpaqueIdSchema,
  contactRefId: providerOpaqueIdSchema,
  templateRevisionRefId: providerOpaqueIdSchema,
  contentRefId: providerOpaqueIdSchema,
  reviewedMessageDigestSha256: providerSha256Schema,
  reviewedEnvelopeDigestSha256: providerSha256Schema,
  providerConnectionRevisionId: providerOpaqueIdSchema,
  externalDeliveryKey: providerOpaqueIdSchema,
  senderProfileRevisionId: providerOpaqueIdSchema,
  senderPresentationContractKey: providerStableKeySchema,
  senderPresentationContractVersion: providerPositiveVersionSchema,
  senderPresentationDigestSha256: providerSha256Schema,
  channelAddressId: providerOpaqueIdSchema,
  channelAddressVersion: providerPositiveVersionSchema,
  addressLookupFingerprintProfile: providerStableKeySchema,
  addressLookupFingerprintVersion: providerPositiveVersionSchema,
  addressLookupFingerprintSha256: providerSha256Schema
});

export const sendMessagesScopeSchema = z.strictObject({
  workspaceId: z.uuid().refine((value) => value === value.toLowerCase()),
  eventId: z.uuid().refine((value) => value === value.toLowerCase())
});

const canonicalSingleLine = z.string().max(998).refine((value) => {
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  return normalized.length > 0 && normalized === value
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
});

const releaseArraySchema = z.array(sendMessagesReleaseSpecSchema)
  .min(1)
  .max(SEND_MESSAGES_RECIPIENT_LIMIT);

/**
 * The reviewed batch the organizer sends. It pins the exact preview identity
 * plus the membership and evidence digests and source versions the adopted
 * preview's stored summary attested. The reviewed send batch validates all of
 * it at commit: a pin that never belonged to the adopted preview refuses as
 * `preview_changed` at planning, and a re-decide (or any other domain drift
 * after adoption) refuses the commit with the typed
 * `stale_revision`/`communication.preview_changed` outcome via the live
 * currency recomputation — never by comparing the plan against itself.
 */
export const sendMessagesAuthorInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.literal('send'),
  scope: sendMessagesScopeSchema,
  batchId: providerOpaqueIdSchema,
  purposeRevision: organizerCommunicationPurposeRevisionRefSchema,
  templateRevision: organizerMessageTemplateRevisionRefSchema.optional(),
  subject: canonicalSingleLine,
  audienceLabel: canonicalSingleLine,
  preview: z.strictObject({
    identity: organizerMessagePreviewIdentitySchema,
    membershipDigestSha256: providerSha256Schema,
    evidenceDigestSha256: providerSha256Schema,
    sourceVersions: z.array(organizerMessagePreviewSourceVersionSchema).max(100)
  }),
  releases: releaseArraySchema,
  requestedAt: z.iso.datetime({ offset: true })
}).superRefine((input, context) => {
  sortedUniqueIssues(
    input.releases.map((release) => release.releaseId),
    context, ['releases'],
    'Release specs must be unique and canonically ordered by release id.'
  );
  const deliveryIds = [...input.releases.map((release) => release.deliveryId)].sort();
  if (new Set(deliveryIds).size !== deliveryIds.length) {
    context.addIssue({ code: 'custom', path: ['releases'], message: 'Delivery ids must be unique.' });
  }
  const recipients = [...input.releases.map((release) => release.recipientRefId)].sort();
  if (new Set(recipients).size !== recipients.length) {
    context.addIssue({
      code: 'custom', path: ['releases'], message: 'Recipient references must be unique.'
    });
  }
  sortedUniqueIssues(
    input.preview.sourceVersions.map((source) => source.sourceKey),
    context, ['preview', 'sourceVersions'],
    'Preview source versions must be unique and canonically ordered.'
  );
});

export const sendMessagesPlanSchema = sendMessagesAuthorInputSchema;

/** Deterministic diff surface: counts and identity only, never an address. */
export const sendMessagesSafeDiffSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.literal('send'),
  batchId: providerOpaqueIdSchema,
  subject: canonicalSingleLine,
  audienceLabel: canonicalSingleLine,
  purposeRevision: organizerCommunicationPurposeRevisionRefSchema,
  templateRevision: organizerMessageTemplateRevisionRefSchema.optional(),
  previewIdentity: organizerMessagePreviewIdentitySchema,
  includedCount: z.number().int().positive().max(SEND_MESSAGES_RECIPIENT_LIMIT),
  irreversibleExternalEffectCount: z.number().int().positive().max(SEND_MESSAGES_RECIPIENT_LIMIT)
}).superRefine((diff, context) => {
  if (diff.includedCount !== diff.irreversibleExternalEffectCount) {
    context.addIssue({
      code: 'custom',
      path: ['irreversibleExternalEffectCount'],
      message: 'Every included recipient is one irreversible external effect.'
    });
  }
});

export const sendMessagesResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  batchId: providerOpaqueIdSchema,
  dispatchGeneration: z.literal(1),
  releaseCount: z.number().int().positive().max(SEND_MESSAGES_RECIPIENT_LIMIT),
  deliveryIds: z.array(providerOpaqueIdSchema).min(1).max(SEND_MESSAGES_RECIPIENT_LIMIT)
}).superRefine((result, context) => {
  if (result.deliveryIds.length !== result.releaseCount) {
    context.addIssue({
      code: 'custom', path: ['deliveryIds'], message: 'Every release registers one delivery.'
    });
  }
  sortedUniqueIssues(result.deliveryIds, context, ['deliveryIds'],
    'Delivery ids must be unique and canonically ordered.');
});

export type SendMessagesReleaseSpec = z.infer<typeof sendMessagesReleaseSpecSchema>;
export type SendMessagesAuthorInput = z.infer<typeof sendMessagesAuthorInputSchema>;
export type SendMessagesPlan = z.infer<typeof sendMessagesPlanSchema>;
export type SendMessagesSafeDiff = z.infer<typeof sendMessagesSafeDiffSchema>;
export type SendMessagesResult = z.infer<typeof sendMessagesResultSchema>;

/** Guard identity binding a send plan to the exact reviewed preview. */
export function sendMessagesPreviewGuardId(audienceSpecId: string): string {
  return `communication_preview:${providerOpaqueIdSchema.parse(audienceSpecId)}`;
}

export function sendMessagesSafeDiff(plan: SendMessagesPlan): SendMessagesSafeDiff {
  const parsed = sendMessagesPlanSchema.parse(plan);
  return sendMessagesSafeDiffSchema.parse({
    schemaVersion: 1,
    action: 'send',
    batchId: parsed.batchId,
    subject: parsed.subject,
    audienceLabel: parsed.audienceLabel,
    purposeRevision: parsed.purposeRevision,
    ...(parsed.templateRevision === undefined
      ? {}
      : { templateRevision: parsed.templateRevision }),
    previewIdentity: parsed.preview.identity,
    includedCount: parsed.releases.length,
    irreversibleExternalEffectCount: parsed.releases.length
  });
}

export function sendMessagesResult(plan: SendMessagesPlan): SendMessagesResult {
  const parsed = sendMessagesPlanSchema.parse(plan);
  return sendMessagesResultSchema.parse({
    schemaVersion: 1,
    batchId: parsed.batchId,
    dispatchGeneration: 1,
    releaseCount: parsed.releases.length,
    deliveryIds: [...parsed.releases.map((release) => release.deliveryId)].sort()
  });
}

export function sendMessagesPlanDigest(plan: unknown): string {
  return createHash('sha256')
    .update(encodeCanonicalJson(sendMessagesPlanSchema.parse(plan)))
    .digest('hex');
}

const ref = (key: string): VersionedDefinitionRef => Object.freeze({ key, version: 1 });

export const SEND_MESSAGES_SCHEMA_REFS = Object.freeze({
  authorInput: ref('communication.send_messages.author_input'),
  plan: ref('communication.send_messages.plan'),
  diff: ref('communication.send_messages.safe_diff'),
  result: ref('communication.send_messages.result')
});
