import { z } from 'zod';
import {
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema
} from './operations';

const APPLICATION_UUID_INPUT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPLICATION_UUID_CANONICAL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const canonicalInstantSchema = z.iso.datetime({ offset: true }).refine(
  (value) => value.endsWith('Z') && value.includes('.'),
  'instant must use canonical UTC millisecond form'
);
const canonicalText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value.normalize('NFC').trim().replace(/\s+/gu, ' ') === value);

export const fileIdInputSchema = z.string()
  .regex(APPLICATION_UUID_INPUT)
  .overwrite((value) => value.toLowerCase());
export const fileIdSchema = z.string().regex(APPLICATION_UUID_CANONICAL);
export const fileScopeSchema = z.strictObject({
  workspaceId: fileIdSchema,
  eventId: fileIdSchema
});
export const fileVersionSchema = z.number().int().positive().safe();
export const fileSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** D3: the closed v1 content-type allowlist. Video is deliberately link-attach only. */
export const FILE_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.apple.keynote',
  'application/zip'
] as const;
export const fileContentTypeSchema = z.enum(FILE_CONTENT_TYPES);

/** Image members of the allowlist; these are re-encoded on ingest, never stored verbatim. */
export const FILE_IMAGE_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp'
] as const;

/**
 * Types the inert download source must never yield, independent of any stored
 * value. The allowlist already excludes them; this list is the explicit
 * conformance floor for the serving boundary.
 */
export const INERT_DOWNLOAD_FORBIDDEN_CONTENT_TYPES = [
  'text/html',
  'image/svg+xml',
  'application/javascript'
] as const;

/**
 * A display filename is presentation-only. It never selects a storage path:
 * no path separators, control characters, or leading/trailing dots or spaces.
 */
export const fileDisplayFilenameSchema = z.string().min(1).max(200)
  .refine((value) =>
    value.normalize('NFC') === value
    && !/[\u0000-\u001f\u007f\/\\:]/u.test(value)
    && value.trim() === value
    && !value.startsWith('.')
    && !value.endsWith('.'),
  'display filename must be sanitized presentation text');

/** Both authenticated lanes may own bytes; there is no anonymous uploader (D8). */
export const fileUploaderPrincipalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('operator_user'), userId: fileIdSchema }),
  z.strictObject({ kind: z.literal('participant'), participantIdentityId: fileIdSchema })
]);

export const filePurposeSchema = z.enum([
  'engagement_material',
  'submission_material',
  'session_material',
  'resource_share_material',
  'request_fulfillment'
]);

/** D5 lifecycle. Serving stays inert in every state; `available` only gates visibility. */
export const fileLifecycleStateSchema = z.enum([
  'uploaded',
  'pending_scan',
  'available',
  'blocked'
]);

export const fileScanVerdictSchema = z.enum(['pending', 'released', 'blocked']);
export const fileScanStateSchema = z.strictObject({
  provider: z.string().min(1).max(64),
  verdict: fileScanVerdictSchema,
  checkedAt: canonicalInstantSchema.nullable()
});

export const fileUploadIntentStateSchema = z.enum([
  'pending',
  'stored',
  'confirmed',
  'discarded'
]);

/**
 * Phase one of the D2 two-phase upload: the admitted intent. Registration is
 * where caps and the type gate bite; streaming and confirmation may only
 * narrow, never widen, what was admitted here.
 */
export const fileUploadIntentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: fileIdSchema,
  scope: fileScopeSchema,
  uploader: fileUploaderPrincipalSchema,
  purpose: filePurposeSchema,
  displayFilename: fileDisplayFilenameSchema,
  contentType: fileContentTypeSchema,
  declaredByteSize: z.number().int().positive().safe(),
  /** The exact per-file cap admitted for this intent (lane-dependent, D4). */
  maximumByteSize: z.number().int().positive().safe(),
  storageProvider: z.string().min(1).max(64),
  storageKey: z.string().min(1).max(512),
  state: fileUploadIntentStateSchema,
  /** Present exactly once bytes were streamed and hashed inline. */
  storedByteSize: z.number().int().positive().safe().nullable(),
  storedSha256: fileSha256Schema.nullable(),
  createdAt: canonicalInstantSchema,
  expiresAt: canonicalInstantSchema
}).superRefine((intent, context) => {
  const stored = intent.state === 'stored' || intent.state === 'confirmed';
  const hasEvidence = intent.storedByteSize !== null && intent.storedSha256 !== null;
  const evidenceCoherent = (intent.storedByteSize !== null) === (intent.storedSha256 !== null);
  // A discarded intent may carry stream evidence (discard-after-stream) or not.
  if (!evidenceCoherent
      || (stored && !hasEvidence)
      || (intent.state === 'pending' && hasEvidence)) {
    context.addIssue({
      code: 'custom',
      message: 'stream evidence must match the intent state'
    });
  }
});

export const fileAssetSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: fileIdSchema,
  scope: fileScopeSchema,
  uploader: fileUploaderPrincipalSchema,
  purpose: filePurposeSchema,
  displayFilename: fileDisplayFilenameSchema,
  contentType: fileContentTypeSchema,
  byteSize: z.number().int().positive().safe(),
  sha256: fileSha256Schema,
  storageProvider: z.string().min(1).max(64),
  storageKey: z.string().min(1).max(512),
  lifecycle: fileLifecycleStateSchema,
  scan: fileScanStateSchema,
  version: fileVersionSchema,
  createdAt: canonicalInstantSchema,
  updatedAt: canonicalInstantSchema
}).superRefine((asset, context) => {
  if ((asset.lifecycle === 'blocked') !== (asset.scan.verdict === 'blocked')) {
    context.addIssue({
      code: 'custom',
      message: 'a blocked asset and a blocked scan verdict imply each other'
    });
  }
  if (asset.lifecycle === 'available' && asset.scan.verdict === 'pending') {
    context.addIssue({
      code: 'custom',
      message: 'an available asset cannot still be scan-pending'
    });
  }
});

export const fileAttachmentSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('engagement'), engagementId: fileIdSchema }),
  z.strictObject({ kind: z.literal('submission'), submissionId: fileIdSchema }),
  z.strictObject({ kind: z.literal('session'), sessionId: fileIdSchema }),
  z.strictObject({ kind: z.literal('resource_share'), resourceShareId: fileIdSchema })
]);

export const fileLinkProviderSchema = z.enum(['drive', 'dropbox', 'url']);

/** D6: a typed link. The server never fetches it — there is zero SSRF surface. */
export const fileLinkSchema = z.strictObject({
  provider: fileLinkProviderSchema,
  label: canonicalText(200),
  url: z.url().max(2048).refine(
    (value) => value.startsWith('https://'),
    'link attachments must use https'
  )
});

export const fileAttachmentContentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('asset'), assetId: fileIdSchema }),
  z.strictObject({ kind: z.literal('link'), link: fileLinkSchema })
]);

export const fileAttachmentStateSchema = z.enum(['attached', 'detached']);

export const fileAttachmentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: fileIdSchema,
  scope: fileScopeSchema,
  subject: fileAttachmentSubjectSchema,
  content: fileAttachmentContentSchema,
  attachedBy: fileUploaderPrincipalSchema,
  state: fileAttachmentStateSchema,
  version: fileVersionSchema,
  attachedAt: canonicalInstantSchema,
  detachedAt: canonicalInstantSchema.nullable()
}).superRefine((attachment, context) => {
  if ((attachment.state === 'detached') !== (attachment.detachedAt !== null)) {
    context.addIssue({
      code: 'custom',
      message: 'exactly a detached attachment carries its detachment instant'
    });
  }
});

export const resourceShareAudienceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all_confirmed') }),
  z.strictObject({ kind: z.literal('track'), trackId: fileIdSchema }),
  z.strictObject({ kind: z.literal('engagement'), engagementId: fileIdSchema })
]);

export const resourceShareStateSchema = z.enum(['active', 'revoked']);

export const resourceShareSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: fileIdSchema,
  scope: fileScopeSchema,
  title: canonicalText(200),
  audience: resourceShareAudienceSchema,
  createdByUserId: fileIdSchema,
  state: resourceShareStateSchema,
  version: fileVersionSchema,
  createdAt: canonicalInstantSchema,
  revokedAt: canonicalInstantSchema.nullable()
}).superRefine((share, context) => {
  if ((share.state === 'revoked') !== (share.revokedAt !== null)) {
    context.addIssue({
      code: 'custom',
      message: 'exactly a revoked share carries its revocation instant'
    });
  }
});

export const fileRequestStateSchema = z.enum(['open', 'fulfilled', 'withdrawn']);

/**
 * D9: the typed ask. The "by when" is a reference into the existing deadline
 * catalog — file requests never own private deadline physics; projections
 * resolve the referenced deadline to a current pin exactly like intake forms.
 */
export const fileRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: fileIdSchema,
  scope: fileScopeSchema,
  engagementId: fileIdSchema,
  what: canonicalText(200),
  instructions: canonicalText(2000).nullable(),
  deadlineId: fileIdSchema.nullable(),
  state: fileRequestStateSchema,
  fulfillingAttachmentId: fileIdSchema.nullable(),
  createdByUserId: fileIdSchema,
  version: fileVersionSchema,
  createdAt: canonicalInstantSchema,
  updatedAt: canonicalInstantSchema
}).superRefine((request, context) => {
  if ((request.state === 'fulfilled') !== (request.fulfillingAttachmentId !== null)) {
    context.addIssue({
      code: 'custom',
      message: 'exactly a fulfilled request carries its fulfilling attachment backlink'
    });
  }
});

/** D4 caps as one configurable limits object; the recommended values are defaults only. */
export const fileUploadLimitsSchema = z.strictObject({
  maxUploadBytesSpeaker: z.number().int().positive().safe(),
  maxUploadBytesOrganizer: z.number().int().positive().safe(),
  maxTotalBytesPerSpeakerPerEvent: z.number().int().positive().safe()
});

/** Signal payloads: the same `{ kind, version, payload }` fact envelope deadlines emit. */
export const fileRequestChangedFactPayloadSchema = z.strictObject({
  action: z.enum(['create', 'withdraw', 'fulfill']),
  requestId: fileIdSchema,
  engagementId: fileIdSchema,
  state: fileRequestStateSchema,
  version: fileVersionSchema,
  deadlineId: fileIdSchema.nullable()
});

export const fileAttachmentChangedFactPayloadSchema = z.strictObject({
  action: z.enum(['attach', 'link_attach', 'detach']),
  attachmentId: fileIdSchema,
  subject: fileAttachmentSubjectSchema,
  assetId: fileIdSchema.nullable(),
  version: fileVersionSchema
});

export const fileAssetChangedFactPayloadSchema = z.strictObject({
  action: z.enum(['confirm', 'scan_release', 'scan_block', 'orphan_collect']),
  assetId: fileIdSchema,
  lifecycle: fileLifecycleStateSchema,
  version: fileVersionSchema
});

export const resourceShareChangedFactPayloadSchema = z.strictObject({
  action: z.enum(['create', 'revoke']),
  resourceShareId: fileIdSchema,
  state: resourceShareStateSchema,
  version: fileVersionSchema
});

/** Operation inputs. */
export const fileUploadIntentRegisterInputSchema = z.strictObject({
  intentId: fileIdInputSchema,
  purpose: filePurposeSchema,
  displayFilename: z.string().min(1).max(400),
  contentType: fileContentTypeSchema,
  declaredByteSize: z.number().int().positive().safe()
});

export const fileUploadConfirmInputSchema = z.strictObject({
  intentId: fileIdInputSchema,
  assetId: fileIdInputSchema,
  sha256: fileSha256Schema
});

export const fileAttachInputSchema = z.strictObject({
  attachmentId: fileIdInputSchema,
  subject: fileAttachmentSubjectSchema,
  assetId: fileIdInputSchema
});

export const fileLinkAttachInputSchema = z.strictObject({
  attachmentId: fileIdInputSchema,
  subject: fileAttachmentSubjectSchema,
  link: fileLinkSchema
});

export const fileDetachInputSchema = z.strictObject({
  attachmentId: fileIdInputSchema,
  expectedVersion: fileVersionSchema
});

export const resourceShareCreateInputSchema = z.strictObject({
  resourceShareId: fileIdInputSchema,
  title: canonicalText(200),
  audience: resourceShareAudienceSchema
});

export const resourceShareRevokeInputSchema = z.strictObject({
  resourceShareId: fileIdInputSchema,
  expectedVersion: fileVersionSchema
});

export const fileRequestCreateInputSchema = z.strictObject({
  requestId: fileIdInputSchema,
  engagementId: fileIdInputSchema,
  what: canonicalText(200),
  instructions: canonicalText(2000).nullable(),
  deadlineId: fileIdInputSchema.nullable()
});

export const fileRequestWithdrawInputSchema = z.strictObject({
  requestId: fileIdInputSchema,
  expectedVersion: fileVersionSchema
});

export const fileRequestFulfillInputSchema = z.strictObject({
  requestId: fileIdInputSchema,
  attachmentId: fileIdInputSchema,
  expectedVersion: fileVersionSchema
});

export const filesEmptyReadInputSchema = z.strictObject({}).optional().default({});
export const fileSubjectReadInputSchema = z.strictObject({
  subject: fileAttachmentSubjectSchema
});

/** One attachment joined with its asset head (null exactly for link attachments). */
export const fileAttachmentViewSchema = z.strictObject({
  attachment: fileAttachmentSchema,
  asset: fileAssetSchema.nullable()
}).superRefine((view, context) => {
  const content = view.attachment.content;
  if (content.kind === 'asset' && view.asset?.id !== content.assetId) {
    context.addIssue({ code: 'custom', message: 'asset attachment view must join its exact asset' });
  }
  if (content.kind === 'link' && view.asset !== null) {
    context.addIssue({ code: 'custom', message: 'link attachment carries no asset' });
  }
});

export const organizerFileOverviewSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: fileScopeSchema,
  attachments: z.array(fileAttachmentViewSchema).max(10_000),
  shares: z.array(resourceShareSchema).max(1_000),
  requests: z.array(fileRequestSchema).max(10_000)
});

/**
 * The portal projection is scoped by construction: it may only carry material
 * for the engagements a participant's current relationship lists.
 */
export const portalEngagementFilesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  engagementId: fileIdSchema,
  attachments: z.array(fileAttachmentViewSchema).max(1_000),
  requests: z.array(fileRequestSchema).max(1_000)
});

/**
 * Full projected read-result envelopes: the transport serves the closed
 * success/outcome result record (with its correlation id), so the projected
 * schema each binding declares must admit the envelope, not the bare data.
 */
export const organizerFileOverviewReadResultSchema =
  createReadOperationResultSchema(organizerFileOverviewSchema);
export const portalEngagementFilesReadResultSchema =
  createReadOperationResultSchema(portalEngagementFilesSchema);

export const FILES_OPERATION_SCHEMA_REFS = Object.freeze({
  organizerOverview: createOperationSchemaManifestRefs({
    inputKey: 'schema.file.overview.input',
    inputSchema: filesEmptyReadInputSchema,
    resultKey: 'schema.file.overview.result',
    resultSchema: organizerFileOverviewReadResultSchema
  }),
  portalEngagementFiles: createOperationSchemaManifestRefs({
    inputKey: 'schema.file.portal-engagement.input',
    inputSchema: fileSubjectReadInputSchema,
    resultKey: 'schema.file.portal-engagement.result',
    resultSchema: portalEngagementFilesReadResultSchema
  })
});

export type FileScopeDto = z.infer<typeof fileScopeSchema>;
export type FileContentType = z.infer<typeof fileContentTypeSchema>;
export type FileUploaderPrincipalDto = z.infer<typeof fileUploaderPrincipalSchema>;
export type FilePurpose = z.infer<typeof filePurposeSchema>;
export type FileLifecycleState = z.infer<typeof fileLifecycleStateSchema>;
export type FileScanVerdict = z.infer<typeof fileScanVerdictSchema>;
export type FileScanStateDto = z.infer<typeof fileScanStateSchema>;
export type FileUploadIntentState = z.infer<typeof fileUploadIntentStateSchema>;
export type FileUploadIntentDto = z.infer<typeof fileUploadIntentSchema>;
export type FileAssetDto = z.infer<typeof fileAssetSchema>;
export type FileAttachmentSubjectDto = z.infer<typeof fileAttachmentSubjectSchema>;
export type FileLinkProvider = z.infer<typeof fileLinkProviderSchema>;
export type FileLinkDto = z.infer<typeof fileLinkSchema>;
export type FileAttachmentContentDto = z.infer<typeof fileAttachmentContentSchema>;
export type FileAttachmentState = z.infer<typeof fileAttachmentStateSchema>;
export type FileAttachmentDto = z.infer<typeof fileAttachmentSchema>;
export type ResourceShareAudienceDto = z.infer<typeof resourceShareAudienceSchema>;
export type ResourceShareState = z.infer<typeof resourceShareStateSchema>;
export type ResourceShareDto = z.infer<typeof resourceShareSchema>;
export type FileRequestState = z.infer<typeof fileRequestStateSchema>;
export type FileRequestDto = z.infer<typeof fileRequestSchema>;
export type FileUploadLimitsDto = z.infer<typeof fileUploadLimitsSchema>;
export type FileRequestChangedFactPayload = z.infer<typeof fileRequestChangedFactPayloadSchema>;
export type FileAttachmentChangedFactPayload =
  z.infer<typeof fileAttachmentChangedFactPayloadSchema>;
export type FileAssetChangedFactPayload = z.infer<typeof fileAssetChangedFactPayloadSchema>;
export type ResourceShareChangedFactPayload =
  z.infer<typeof resourceShareChangedFactPayloadSchema>;
export type FileUploadIntentRegisterInput = z.infer<typeof fileUploadIntentRegisterInputSchema>;
export type FileUploadConfirmInput = z.infer<typeof fileUploadConfirmInputSchema>;
export type FileAttachInput = z.infer<typeof fileAttachInputSchema>;
export type FileLinkAttachInput = z.infer<typeof fileLinkAttachInputSchema>;
export type FileDetachInput = z.infer<typeof fileDetachInputSchema>;
export type ResourceShareCreateInput = z.infer<typeof resourceShareCreateInputSchema>;
export type ResourceShareRevokeInput = z.infer<typeof resourceShareRevokeInputSchema>;
export type FileRequestCreateInput = z.infer<typeof fileRequestCreateInputSchema>;
export type FileRequestWithdrawInput = z.infer<typeof fileRequestWithdrawInputSchema>;
export type FileRequestFulfillInput = z.infer<typeof fileRequestFulfillInputSchema>;
export type FileAttachmentViewDto = z.infer<typeof fileAttachmentViewSchema>;
export type OrganizerFileOverviewDto = z.infer<typeof organizerFileOverviewSchema>;
export type PortalEngagementFilesDto = z.infer<typeof portalEngagementFilesSchema>;
