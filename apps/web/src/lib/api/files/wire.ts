import {
	createEffectfulOperationResultSchema,
	createReadOperationResultSchema,
	createSafeSchemaManifestRef,
	type SafeSchemaManifestRef
} from '@jooevents/contracts';
import {
	deadlineListReadResultSchema,
	deadlineReferencePinSchema,
	DEADLINE_OPERATION_SCHEMA_REFS
} from '@jooevents/contracts/deadlines';
import {
	FILES_OPERATION_SCHEMA_REFS,
	fileAssetSchema,
	fileAttachInputSchema,
	fileAttachmentSchema,
	fileDetachInputSchema,
	fileLinkAttachInputSchema,
	fileRequestCreateInputSchema,
	fileRequestFulfillInputSchema,
	fileRequestSchema,
	fileRequestWithdrawInputSchema,
	fileUploadConfirmInputSchema,
	fileUploadIntentRegisterInputSchema,
	fileUploadIntentSchema,
	organizerFileOverviewSchema,
	portalEngagementFilesSchema,
	resourceShareCreateInputSchema,
	resourceShareRevokeInputSchema,
	resourceShareSchema
} from '@jooevents/contracts/files';
import { z } from 'zod';

/**
 * The exact wire identities of the files vertical, restated from the published
 * contracts so the browser matches the served manifest byte for byte. Schema
 * refs are recomputed here with `createSafeSchemaManifestRef` over the same
 * contract schemas the server registers, so a digest can only agree when the
 * two sides genuinely share one contract — a drifted registration reads as
 * `operation_contract_mismatch`, never as a guessed path.
 *
 * Two non-operation wire conventions also live here, because the byte lane of
 * the D2 two-phase upload and the inert download route are HTTP routes, not
 * registry operations:
 *
 * - upload bytes: `PUT {lane files prefix}/uploads/{intentId}/bytes`, raw
 *   body, allowlisted content type, no idempotency header (the intent id is
 *   the idempotency anchor);
 * - asset download: `GET {lane files prefix}/assets/{assetId}/download`,
 *   served inert (`Content-Disposition: attachment` + nosniff) by the server.
 *
 * The lane files prefix is derived from the manifest-resolved
 * `file.upload.intent` binding path, never hardcoded, so the one address book
 * stays the served manifest.
 */

export const FILES_COMMAND_ACTIONS = [
	'upload.intent',
	'upload.confirm',
	'attachment.attach',
	'attachment.link',
	'attachment.detach',
	'share.create',
	'share.revoke',
	'request.create',
	'request.withdraw',
	'request.fulfill'
] as const;
export type FilesCommandAction = (typeof FILES_COMMAND_ACTIONS)[number];
export const filesCommandActionSchema = z.enum(FILES_COMMAND_ACTIONS);

/** The subset the participant portal lane serves (D8: authenticated portal lane). */
export const FILES_PORTAL_COMMAND_ACTIONS = [
	'upload.intent',
	'upload.confirm',
	'attachment.attach',
	'attachment.link',
	'request.fulfill'
] as const satisfies readonly FilesCommandAction[];
export type FilesPortalCommandAction = (typeof FILES_PORTAL_COMMAND_ACTIONS)[number];

/** Every domain refusal a files command may surface, mirrored from the command catalog. */
export const filesCommandRefusalCodeSchema = z.enum([
	'content_type_refused', 'video_refused_use_link', 'file_too_large',
	'event_quota_exceeded', 'display_filename_invalid', 'intent_id_collision',
	'intent_not_pending', 'intent_expired', 'byte_cap_exceeded', 'empty_stream',
	'image_reencoder_unavailable', 'image_decode_failed', 'image_reencode_invalid',
	'intent_not_stored', 'hash_mismatch', 'asset_id_collision',
	'attachment_id_collision', 'subject_missing', 'asset_missing',
	'asset_not_available', 'asset_blocked', 'attachment_missing',
	'already_detached', 'stale_attachment', 'share_id_collision', 'track_missing',
	'engagement_missing', 'stale_share', 'already_revoked', 'share_missing',
	'request_id_collision', 'engagement_cancelled', 'deadline_unavailable',
	'request_missing', 'request_not_open', 'stale_request', 'attachment_detached',
	'attachment_subject_mismatch', 'portal_not_related'
]);
export type FilesCommandRefusalCode = z.infer<typeof filesCommandRefusalCodeSchema>;

export const filesCommandRefusalDetailSchema = z.strictObject({
	action: filesCommandActionSchema,
	code: filesCommandRefusalCodeSchema
});

/**
 * Command result payloads, field-for-field as the operation modules register
 * them. Declaration order matters: the manifest digest is computed over the
 * schema's canonical JSON Schema, and `required` preserves declaration order.
 */
const filesCommandDataSchemas = Object.freeze({
	'upload.intent': z.strictObject({
		action: z.literal('upload.intent'),
		intent: fileUploadIntentSchema,
		idempotent: z.boolean()
	}),
	'upload.confirm': z.strictObject({
		action: z.literal('upload.confirm'),
		asset: fileAssetSchema,
		idempotent: z.boolean()
	}),
	'attachment.attach': z.strictObject({
		action: z.literal('attachment.attach'),
		attachment: fileAttachmentSchema,
		idempotent: z.boolean()
	}),
	'attachment.link': z.strictObject({
		action: z.literal('attachment.link'),
		attachment: fileAttachmentSchema,
		idempotent: z.boolean()
	}),
	'attachment.detach': z.strictObject({
		action: z.literal('attachment.detach'),
		attachment: fileAttachmentSchema
	}),
	'share.create': z.strictObject({
		action: z.literal('share.create'),
		share: resourceShareSchema,
		idempotent: z.boolean()
	}),
	'share.revoke': z.strictObject({
		action: z.literal('share.revoke'),
		share: resourceShareSchema
	}),
	'request.create': z.strictObject({
		action: z.literal('request.create'),
		request: fileRequestSchema,
		deadline: deadlineReferencePinSchema.nullable(),
		idempotent: z.boolean()
	}),
	'request.withdraw': z.strictObject({
		action: z.literal('request.withdraw'),
		request: fileRequestSchema
	}),
	'request.fulfill': z.strictObject({
		action: z.literal('request.fulfill'),
		request: fileRequestSchema
	})
} as const satisfies Record<FilesCommandAction, z.ZodType>);

const filesCommandInputSchemas = Object.freeze({
	'upload.intent': fileUploadIntentRegisterInputSchema,
	'upload.confirm': fileUploadConfirmInputSchema,
	'attachment.attach': fileAttachInputSchema,
	'attachment.link': fileLinkAttachInputSchema,
	'attachment.detach': fileDetachInputSchema,
	'share.create': resourceShareCreateInputSchema,
	'share.revoke': resourceShareRevokeInputSchema,
	'request.create': fileRequestCreateInputSchema,
	'request.withdraw': fileRequestWithdrawInputSchema,
	'request.fulfill': fileRequestFulfillInputSchema
} as const satisfies Record<FilesCommandAction, z.ZodType>);

export function filesCommandInputSchema(action: FilesCommandAction): z.ZodType {
	return filesCommandInputSchemas[action];
}

/** The typed success payload one command answers with. */
export type FilesCommandData<Action extends FilesCommandAction> =
	z.infer<(typeof filesCommandDataSchemas)[Action]>;

/** The full effectful wire envelope one files command answers with. */
export function filesCommandWireResultSchema(action: FilesCommandAction) {
	return createEffectfulOperationResultSchema(filesCommandDataSchemas[action]);
}

export type FilesLane = 'operator' | 'portal';

const LANE_MODULE_IDS = Object.freeze({
	operator: 'files.command-operations',
	portal: 'files.portal-command-operations'
} as const satisfies Record<FilesLane, string>);

export interface ExpectedFilesHttpOperation {
	readonly name: string;
	readonly version: number;
	readonly effect: 'read' | 'commit';
	readonly method: 'GET' | 'POST';
	readonly input: 'query' | 'body';
	readonly idempotencyRequired: boolean;
	readonly inputSchema: SafeSchemaManifestRef;
	readonly resultSchema: SafeSchemaManifestRef;
}

function commandExpectation(
	lane: FilesLane,
	action: FilesCommandAction
): ExpectedFilesHttpOperation {
	const prefix = `${LANE_MODULE_IDS[lane]}.${action}`;
	return Object.freeze({
		name: `file.${action}`,
		version: 1,
		effect: 'commit',
		method: 'POST',
		input: 'body',
		idempotencyRequired: true,
		inputSchema: createSafeSchemaManifestRef(
			`schema.${prefix}.input`,
			filesCommandInputSchemas[action]
		),
		resultSchema: createSafeSchemaManifestRef(
			`schema.${prefix}.projected-result`,
			filesCommandWireResultSchema(action)
		)
	});
}

function laneExpectations<Action extends FilesCommandAction>(
	lane: FilesLane,
	actions: readonly Action[]
): Readonly<Record<Action, ExpectedFilesHttpOperation>> {
	return Object.freeze(Object.fromEntries(
		actions.map((action) => [action, commandExpectation(lane, action)])
	) as Record<Action, ExpectedFilesHttpOperation>);
}

/** All ten operator-lane commands, keyed by action. */
export const FILES_OPERATOR_COMMAND_EXPECTATIONS = laneExpectations(
	'operator',
	FILES_COMMAND_ACTIONS
);

/** The five portal-lane commands, keyed by action. */
export const FILES_PORTAL_COMMAND_EXPECTATIONS = laneExpectations(
	'portal',
	FILES_PORTAL_COMMAND_ACTIONS
);

/** Organizer whole-event files read (`file.overview.read@1`). */
export const FILES_ORGANIZER_OVERVIEW_EXPECTATION: ExpectedFilesHttpOperation = Object.freeze({
	name: 'file.overview.read',
	version: 1,
	effect: 'read',
	method: 'GET',
	input: 'query',
	idempotencyRequired: false,
	inputSchema: FILES_OPERATION_SCHEMA_REFS.organizerOverview.inputSchema,
	resultSchema: FILES_OPERATION_SCHEMA_REFS.organizerOverview.resultSchema
});

/** Portal one-engagement files read (`file.portal.engagement-files.read@1`). */
export const FILES_PORTAL_ENGAGEMENT_FILES_EXPECTATION: ExpectedFilesHttpOperation = Object.freeze({
	name: 'file.portal.engagement-files.read',
	version: 1,
	effect: 'read',
	method: 'GET',
	input: 'query',
	idempotencyRequired: false,
	inputSchema: FILES_OPERATION_SCHEMA_REFS.portalEngagementFiles.inputSchema,
	resultSchema: FILES_OPERATION_SCHEMA_REFS.portalEngagementFiles.resultSchema
});

/**
 * The existing deadline catalog read: the request composer's "by when" is a
 * reference into this catalog (D9 rides the deadline machinery, never private
 * deadline physics).
 */
export const DEADLINE_CATALOG_READ_EXPECTATION: ExpectedFilesHttpOperation = Object.freeze({
	name: 'deadline.catalog.read',
	version: 1,
	effect: 'read',
	method: 'GET',
	input: 'query',
	idempotencyRequired: false,
	inputSchema: DEADLINE_OPERATION_SCHEMA_REFS.catalogRead.inputSchema,
	resultSchema: DEADLINE_OPERATION_SCHEMA_REFS.catalogRead.resultSchema
});

/**
 * Wire envelopes the read paths answer with. The files read module registers
 * its bare projection schema as the binding result identity; the HTTP layer
 * serves it inside the standard read envelope, exactly like every other read.
 */
export const organizerFileOverviewWireSchema =
	createReadOperationResultSchema(organizerFileOverviewSchema);
export const portalEngagementFilesWireSchema =
	createReadOperationResultSchema(portalEngagementFilesSchema);
export const deadlineCatalogWireSchema = deadlineListReadResultSchema;

const UPLOAD_INTENT_PATH_SUFFIX = '/uploads/intent';
const CANONICAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The lane's files prefix, read off the resolved `file.upload.intent` binding
 * path. `null` when the served path does not carry the documented shape — the
 * caller treats that exactly like an unavailable binding.
 */
export function filesLanePrefix(uploadIntentPath: string): string | null {
	if (!uploadIntentPath.endsWith(UPLOAD_INTENT_PATH_SUFFIX)) return null;
	const prefix = uploadIntentPath.slice(0, -UPLOAD_INTENT_PATH_SUFFIX.length);
	return prefix.startsWith('/api/') ? prefix : null;
}

/** Where the admitted intent's bytes stream to (`PUT`, raw body). */
export function uploadBytesPath(lanePrefix: string, intentId: string): string | null {
	if (!CANONICAL_ID.test(intentId)) return null;
	return `${lanePrefix}/uploads/${intentId}/bytes`;
}

/** The inert download route for one confirmed asset. */
export function assetDownloadPath(lanePrefix: string, assetId: string): string | null {
	if (!CANONICAL_ID.test(assetId)) return null;
	return `${lanePrefix}/download/${assetId}`;
}

/**
 * The portal lane serves engagement material only, and the server's transport
 * translator for this read accepts the one flat parameter it needs.
 */
export function portalEngagementFilesQuery(engagementId: string): string | null {
	if (!CANONICAL_ID.test(engagementId)) return null;
	const query = new URLSearchParams();
	query.set('engagementId', engagementId);
	return query.toString();
}

/** Fresh per-attempt idempotency key for one files command. */
export function filesIdempotencyKey(action: FilesCommandAction): string {
	return `je.files.${action}.${globalThis.crypto.randomUUID()}`;
}

/** Canonical lowercase v4 ids for intent/asset/attachment/share/request minting. */
export function newFilesRecordId(): string {
	return globalThis.crypto.randomUUID().toLowerCase();
}
