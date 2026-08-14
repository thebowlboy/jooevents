import {
  providerOpaqueIdSchema,
  providerPositiveVersionSchema,
  providerSha256Schema,
  providerStableKeySchema
} from '@jooevents/contracts';
import { canonicalJsonText, parseEventId, parseInstant, parseWorkspaceId } from '@jooevents/kernel';
import { z } from 'zod';
import type { OutboundEmailEnvelopeResolver } from '../delivery/worker';
import {
  computeReviewedEmailEnvelopeDigestSha256,
  parseEmailAddress,
  type ImmutableEmailEnvelope
} from '../providers/port';

const emailAddressSchema = z.string().transform((value, context) => {
  try {
    return parseEmailAddress(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Expected a bounded email address.' });
    return z.NEVER;
  }
});

const envelopeSchema: z.ZodType<ImmutableEmailEnvelope> = z.strictObject({
  contractVersion: z.literal(1),
  from: z.strictObject({
    address: emailAddressSchema,
    displayName: z.string().min(1).max(200).optional()
  }),
  to: z.strictObject({ address: emailAddressSchema }),
  replyTo: z.strictObject({
    address: emailAddressSchema,
    displayName: z.string().min(1).max(200).optional()
  }).optional(),
  subject: z.string().min(1).max(998),
  textBody: z.string().max(26_214_400),
  htmlBody: z.string().max(26_214_400).optional(),
  headers: z.array(z.strictObject({
    name: z.string().min(1).max(64),
    value: z.string().max(16_384)
  })).max(128)
}) as z.ZodType<ImmutableEmailEnvelope>;

/**
 * One immutable reviewed release per recipient. It is keyed by its opaque
 * `releaseId` and pinned by the reviewed message/envelope digests the worker
 * revalidates before every provider attempt. This identity is distinct from the
 * preview HMAC release tokens: a stored release binds exact reviewed bytes, not
 * a preview projection, so `reviewed_envelope_changed` revalidation compares
 * against these stored digests and nothing else.
 */
export const communicationMessageReleaseSchema = z.strictObject({
  contractVersion: z.literal(1),
  workspaceId: z.string().transform((value, context) => {
    try {
      return parseWorkspaceId(value) as string;
    } catch {
      context.addIssue({ code: 'custom', message: 'Expected a workspace id.' });
      return z.NEVER;
    }
  }),
  eventId: z.string().transform((value, context) => {
    try {
      return parseEventId(value) as string;
    } catch {
      context.addIssue({ code: 'custom', message: 'Expected an event id.' });
      return z.NEVER;
    }
  }),
  releaseId: providerOpaqueIdSchema,
  batchId: providerOpaqueIdSchema,
  recipientRefId: providerOpaqueIdSchema,
  personRefId: providerOpaqueIdSchema,
  contactRefId: providerOpaqueIdSchema,
  templateRevisionRefId: providerOpaqueIdSchema,
  contentRefId: providerOpaqueIdSchema,
  purposeKey: providerStableKeySchema,
  reviewedMessageDigestSha256: providerSha256Schema,
  reviewedEnvelopeDigestSha256: providerSha256Schema,
  envelope: envelopeSchema,
  createdAt: z.string().transform((value, context) => {
    try {
      return parseInstant(value) as string;
    } catch {
      context.addIssue({ code: 'custom', message: 'Expected a canonical instant.' });
      return z.NEVER;
    }
  })
}).superRefine((release, context) => {
  if (computeReviewedEmailEnvelopeDigestSha256(release.envelope)
      !== release.reviewedEnvelopeDigestSha256) {
    context.addIssue({
      code: 'custom',
      path: ['reviewedEnvelopeDigestSha256'],
      message: 'Reviewed envelope digest must match the immutable envelope bytes.'
    });
  }
});

export type CommunicationMessageRelease = z.infer<typeof communicationMessageReleaseSchema>;

export type CommunicationMessageReleaseErrorCode =
  | 'invalid_release'
  | 'release_conflict'
  | 'release_not_found'
  | 'release_binding_mismatch';

export class CommunicationMessageReleaseError extends Error {
  constructor(readonly code: CommunicationMessageReleaseErrorCode) {
    super(code);
    this.name = 'CommunicationMessageReleaseError';
  }
}

/** Append-only store: a release is written once and never updated or deleted. */
export interface CommunicationMessageReleaseStore {
  put(release: CommunicationMessageRelease): void;
  read(releaseId: string): CommunicationMessageRelease | undefined;
}

function deepFreezeRelease(release: CommunicationMessageRelease): CommunicationMessageRelease {
  return Object.freeze({
    ...release,
    envelope: Object.freeze({
      ...release.envelope,
      from: Object.freeze({ ...release.envelope.from }),
      to: Object.freeze({ ...release.envelope.to }),
      ...(release.envelope.replyTo === undefined
        ? {}
        : { replyTo: Object.freeze({ ...release.envelope.replyTo }) }),
      headers: Object.freeze(release.envelope.headers.map((header) => Object.freeze({ ...header })))
    })
  });
}

export function parseCommunicationMessageRelease(value: unknown): CommunicationMessageRelease {
  try {
    return deepFreezeRelease(communicationMessageReleaseSchema.parse(value));
  } catch {
    throw new CommunicationMessageReleaseError('invalid_release');
  }
}

/** Deterministic in-memory store used by package tests and disposable runtimes. */
export function createInMemoryCommunicationMessageReleaseStore(): CommunicationMessageReleaseStore {
  const releases = new Map<string, CommunicationMessageRelease>();
  return Object.freeze({
    put(candidate: CommunicationMessageRelease): void {
      const release = parseCommunicationMessageRelease(candidate);
      const existing = releases.get(release.releaseId);
      if (existing !== undefined) {
        if (canonicalJsonText(existing) !== canonicalJsonText(release)) {
          throw new CommunicationMessageReleaseError('release_conflict');
        }
        return;
      }
      releases.set(release.releaseId, release);
    },
    read(releaseId: string): CommunicationMessageRelease | undefined {
      return releases.get(providerOpaqueIdSchema.parse(releaseId));
    }
  });
}

export const communicationSenderPresentationSchema = z.strictObject({
  fromAddress: emailAddressSchema,
  fromDisplayName: z.string().min(1).max(200).optional(),
  replyToAddress: emailAddressSchema.optional(),
  senderProfileRevisionId: providerOpaqueIdSchema,
  senderPresentationContractKey: providerStableKeySchema,
  senderPresentationContractVersion: providerPositiveVersionSchema,
  senderPresentationDigestSha256: providerSha256Schema
});

export type CommunicationSenderPresentation = z.infer<
  typeof communicationSenderPresentationSchema
>;

/**
 * Builds the immutable per-recipient release from an already-reviewed render.
 * The reviewed message digest is the render's output digest; the reviewed
 * envelope digest is computed here from the exact envelope bytes the worker
 * will later re-derive, so revalidation is byte-honest end to end.
 */
export function buildCommunicationMessageRelease(input: {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly releaseId: string;
  readonly batchId: string;
  readonly recipientRefId: string;
  readonly personRefId: string;
  readonly contactRefId: string;
  readonly templateRevisionRefId: string;
  readonly contentRefId: string;
  readonly purposeKey: string;
  readonly reviewedMessageDigestSha256: string;
  readonly sender: z.input<typeof communicationSenderPresentationSchema>;
  readonly toAddress: string;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody?: string;
  readonly createdAt: string;
}): CommunicationMessageRelease {
  const sender = communicationSenderPresentationSchema.parse(input.sender);
  const envelope: ImmutableEmailEnvelope = Object.freeze({
    contractVersion: 1,
    from: Object.freeze({
      address: sender.fromAddress,
      ...(sender.fromDisplayName === undefined ? {} : { displayName: sender.fromDisplayName })
    }),
    to: Object.freeze({ address: parseEmailAddress(input.toAddress) }),
    ...(sender.replyToAddress === undefined
      ? {}
      : { replyTo: Object.freeze({ address: sender.replyToAddress }) }),
    subject: input.subject,
    textBody: input.textBody,
    ...(input.htmlBody === undefined ? {} : { htmlBody: input.htmlBody }),
    headers: Object.freeze([])
  });
  return parseCommunicationMessageRelease({
    contractVersion: 1,
    workspaceId: input.workspaceId,
    eventId: input.eventId,
    releaseId: input.releaseId,
    batchId: input.batchId,
    recipientRefId: input.recipientRefId,
    personRefId: input.personRefId,
    contactRefId: input.contactRefId,
    templateRevisionRefId: input.templateRevisionRefId,
    contentRefId: input.contentRefId,
    purposeKey: input.purposeKey,
    reviewedMessageDigestSha256: providerSha256Schema.parse(input.reviewedMessageDigestSha256),
    reviewedEnvelopeDigestSha256: computeReviewedEmailEnvelopeDigestSha256(envelope),
    envelope,
    createdAt: input.createdAt
  });
}

/**
 * The worker-facing envelope resolver over the immutable release store. Every
 * dispatch re-reads the stored release and refuses on any binding drift; the
 * worker then independently recomputes the reviewed envelope digest, so a
 * changed envelope can never reach a provider.
 */
export function createReleaseStoreOutboundEmailEnvelopeResolver(input: {
  readonly releases: Pick<CommunicationMessageReleaseStore, 'read'>;
}): OutboundEmailEnvelopeResolver {
  return Object.freeze({
    resolve({ releaseId, recipientRefId, templateRevisionRefId, contentRefId }:
      Parameters<OutboundEmailEnvelopeResolver['resolve']>[0]) {
      const release = input.releases.read(releaseId);
      if (release === undefined) {
        throw new CommunicationMessageReleaseError('release_not_found');
      }
      if (release.recipientRefId !== recipientRefId
          || release.templateRevisionRefId !== templateRevisionRefId
          || release.contentRefId !== contentRefId) {
        throw new CommunicationMessageReleaseError('release_binding_mismatch');
      }
      return release.envelope;
    }
  });
}
