import {
	ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS,
	operationHttpIdempotencyKeySchema,
	organizerCommunicationAttentionListInputSchema,
	organizerCommunicationAttentionPageOperationResultSchema,
	organizerCommunicationAudienceOptionListInputSchema,
	organizerCommunicationAudienceOptionPageOperationResultSchema,
	organizerCommunicationAuthoringPayloadOperationResultSchema,
	organizerCommunicationDraftGetInputSchema,
	organizerCommunicationDraftListInputSchema,
	organizerCommunicationDraftMutationOperationResultSchema,
	organizerCommunicationDraftOperationResultSchema,
	organizerCommunicationDraftPageOperationResultSchema,
	organizerCommunicationHistoryListInputSchema,
	organizerCommunicationHistoryPageOperationResultSchema,
	organizerCommunicationThreadGetInputSchema,
	organizerCommunicationThreadPageOperationResultSchema,
	organizerCommunicationTimelineGetInputSchema,
	organizerCommunicationTimelinePageOperationResultSchema,
	organizerCommunicationPurposeDetailOperationResultSchema,
	organizerCommunicationPurposeGetInputSchema,
	organizerCommunicationPurposeListInputSchema,
	organizerCommunicationPurposePageOperationResultSchema,
	organizerCreateCommunicationDraftInputSchema,
	organizerCreateMessageTemplateInputSchema,
	organizerDiscardCommunicationDraftInputSchema,
	organizerMessageBatchPreviewDetailOperationResultSchema,
	organizerMessageBatchPreviewGetInputSchema,
	organizerMessagePreviewRecipientListInputSchema,
	organizerMessagePreviewRecipientPageOperationResultSchema,
	organizerMessageTemplateDetailOperationResultSchema,
	organizerMessageTemplateGetInputSchema,
	organizerMessageTemplateListInputSchema,
	organizerMessageTemplatePageOperationResultSchema,
	organizerMessageTemplateMutationOperationResultSchema,
	organizerPrepareMessagePreviewOperationResultSchema,
	organizerPreviewMessageBatchInputSchema,
	organizerPreviewMessageBatchOperationResultSchema,
	organizerRetryMessageDeliveryInputSchema,
	organizerRetryMessageDeliveryOperationResultSchema,
	organizerReviseCommunicationDraftInputSchema,
	organizerSendMessagesInputSchema,
	organizerSendMessagesOperationResultSchema,
	organizerStoreAuthoringPayloadInputSchema,
	type OperationReceiptRef,
	type StructuredOutcome
} from '@jooevents/contracts';
import type { z } from 'zod';
import type {
	CommunicationAuthoringOperation,
	CommunicationEffectResult,
	CommunicationReadResult,
	CommunicationsAuthoringPort,
	CommunicationUnavailableResult
} from '../communications-authoring-port';
import { requestJson, type ApiResult } from '../client';
import {
	mapCommunicationAudienceOptionPage,
	mapCommunicationAttentionPage,
	mapCommunicationAuthoringPayloadRef,
	mapCommunicationDeliveryHistoryPage,
	mapCommunicationDraft,
	mapCommunicationDraftMutation,
	mapCommunicationDraftPage,
	mapCommunicationPurposeDetail,
	mapCommunicationPurposePage,
	mapCommunicationThreadPage,
	mapCommunicationTimelinePage,
	mapMessageBatchPreviewDetail,
	mapMessagePreviewPrepare,
	mapMessagePreviewRecipientPage,
	mapMessagePreviewSummary,
	mapMessageTemplateDetail,
	mapMessageTemplateMutation,
	mapMessageTemplatePage,
	mapRetryMessageDeliveryResult,
	mapSendMessagesResult
} from '../mappers/communications-authoring';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution
} from './operator-http-binding';

export const COMMUNICATIONS_AUTHORING_OPERATIONS = Object.freeze({
	listPurposes: {
		name: 'list_communication_purposes', version: 1,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.listPurposes
	},
	getPurpose: {
		name: 'get_communication_purpose', version: 1,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.getPurpose
	},
	listTemplates: {
		name: 'list_message_templates', version: 1,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.listTemplates
	},
	getTemplate: {
		name: 'get_message_template', version: 1,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.getTemplate
	},
	listDrafts: {
		name: 'list_message_drafts', version: 1,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.listDrafts
	},
	getDraft: {
		name: 'get_message_draft', version: 1,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.getDraft
	},
	storeAuthoringPayload: {
		name: 'store_communication_authoring_payload', version: 1,
		effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.storeAuthoringPayload
	},
	createTemplate: {
		name: 'message_template.create', version: 1,
		effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.createTemplate
	},
	createDraft: {
		name: 'create_message_draft', version: 1,
		effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.createDraft
	},
	reviseDraft: {
		name: 'revise_message_batch', version: 1,
		effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.reviseDraft
	},
	discardDraft: {
		name: 'discard_message_draft', version: 1,
		effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.discardDraft
	},
	listAudienceOptions: {
		name: 'list_audience_options', version: 1,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.listAudienceOptions
	},
	getPreview: {
		name: 'get_message_batch_preview', version: 1,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.getPreview
	},
	listPreviewRecipients: {
		name: 'list_message_preview_recipients', version: 1,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.listPreviewRecipients
	},
	prepareBatchPreview: {
		name: 'prepare_message_batch_preview', version: 1,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.prepareBatchPreview
	},
	adoptBatchPreview: {
		name: 'preview_message_batch', version: 1,
		effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.previewBatch
	},
	sendMessages: {
		name: 'send_messages', version: 1,
		effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.sendMessages
	},
	retryDelivery: {
		name: 'retry_message_delivery', version: 1,
		effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.retryDelivery
	},
	getDeliveryHistory: {
		name: 'get_delivery_history', version: 1,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.getHistory
	},
	listAttentionItems: {
		name: 'list_message_attention_items', version: 1,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.listAttention
	},
	getPersonThread: {
		name: 'get_person_thread', version: 1,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.getThread
	},
	getDeliveryTimeline: {
		name: 'get_delivery_timeline', version: 1,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.getTimeline
	}
} as const satisfies Readonly<Record<string, ExpectedOperatorHttpOperation>>);

type BindingKey = keyof typeof COMMUNICATIONS_AUTHORING_OPERATIONS;
type Bindings = Readonly<Record<BindingKey, OperatorHttpBindingResolution>>;

export interface CommunicationsAuthoringRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

export type CommunicationsAuthoringRequester = (
	input: CommunicationsAuthoringRequestInput
) => Promise<ApiResult<unknown>>;

type ReadWireResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string };

type EffectWireResult<Data> =
	| {
			readonly kind: 'success';
			readonly data: Data;
			readonly receipt: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'outcome';
			readonly outcome: StructuredOutcome;
			readonly terminal: true;
			readonly receipt: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'outcome';
			readonly outcome: StructuredOutcome;
			readonly terminal: false;
			readonly correlationId: string;
	  };

function defaultRequester(input: CommunicationsAuthoringRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

function invalidRequest() {
	return { kind: 'transport_error' as const, error: { code: 'invalid_request', retryable: false } };
}

function invalidContract() {
	return { kind: 'transport_error' as const, error: { code: 'invalid_contract', retryable: true } };
}

function unavailable(
	operation: CommunicationAuthoringOperation,
	binding: Extract<OperatorHttpBindingResolution, { readonly kind: 'unavailable' }>
): CommunicationUnavailableResult {
	return { kind: 'unavailable', operation, reason: binding.reason };
}

function resolveBindings(manifest: unknown): Bindings {
	return Object.freeze(Object.fromEntries(
		Object.entries(COMMUNICATIONS_AUTHORING_OPERATIONS).map(([key, expected]) => [
			key,
			resolveOperatorHttpBinding({ manifest, expected })
		])
	) as unknown as Bindings);
}

function queryPath(path: string, input: object): string {
	const query = new URLSearchParams();
	const append = (key: string, value: unknown) => {
		if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
			throw new TypeError(`Unsupported operator query value for ${key}.`);
		}
		query.append(key, String(value));
	};
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const item of value) append(key, item);
			continue;
		}
		append(key, value);
	}
	const encoded = query.toString();
	return encoded.length === 0 ? path : `${path}?${encoded}`;
}

function receiptMatches(
	receipt: OperationReceiptRef,
	operation: { readonly name: string; readonly version: number }
): boolean {
	return receipt.operationName === operation.name && receipt.operationVersion === operation.version;
}

async function requestRead<WireData, ViewData>(input: {
	readonly binding: OperatorHttpBindingResolution;
	readonly operation: CommunicationAuthoringOperation;
	readonly query: object;
	readonly request: CommunicationsAuthoringRequester;
	readonly resultSchema: z.ZodType;
	readonly map: (value: WireData) => ViewData;
	readonly guard?: (value: WireData) => boolean;
	readonly signal?: AbortSignal;
}): Promise<CommunicationReadResult<ViewData>> {
	if (input.binding.kind === 'unavailable') return unavailable(input.operation, input.binding);
	let path: string;
	try {
		path = queryPath(input.binding.path, input.query);
	} catch {
		return invalidRequest();
	}
	const transport = await input.request({
		path,
		method: 'GET',
		schema: input.resultSchema,
		...(input.signal ? { signal: input.signal } : {})
	});
	if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
	const parsed = input.resultSchema.safeParse(transport.data);
	if (!parsed.success) return invalidContract();
	const result = parsed.data as ReadWireResult<WireData>;
	if (result.kind === 'outcome') return result;
	if (input.guard && !input.guard(result.data)) return invalidContract();
	try {
		return { kind: 'success', data: input.map(result.data), correlationId: result.correlationId };
	} catch {
		return invalidContract();
	}
}

async function requestEffect<WireData, ViewData>(input: {
	readonly binding: OperatorHttpBindingResolution;
	readonly operation: CommunicationAuthoringOperation;
	readonly operationIdentity: { readonly name: string; readonly version: number };
	readonly body: object;
	readonly idempotencyKey: string;
	readonly request: CommunicationsAuthoringRequester;
	readonly resultSchema: z.ZodType;
	readonly map: (value: WireData) => ViewData;
	readonly guard?: (value: WireData) => boolean;
	readonly signal?: AbortSignal;
}): Promise<CommunicationEffectResult<ViewData>> {
	if (input.binding.kind === 'unavailable') return unavailable(input.operation, input.binding);
	const key = operationHttpIdempotencyKeySchema.safeParse(input.idempotencyKey);
	if (!key.success) return invalidRequest();
	const transport = await input.request({
		path: input.binding.path,
		method: 'POST',
		body: input.body,
		idempotencyKey: key.data,
		schema: input.resultSchema,
		...(input.signal ? { signal: input.signal } : {})
	});
	if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
	const parsed = input.resultSchema.safeParse(transport.data);
	if (!parsed.success) return invalidContract();
	const result = parsed.data as EffectWireResult<WireData>;
	if (result.kind === 'outcome') {
		if (result.terminal && !receiptMatches(result.receipt, input.operationIdentity)) {
			return invalidContract();
		}
		return result;
	}
	if (!receiptMatches(result.receipt, input.operationIdentity)
		|| (input.guard && !input.guard(result.data))) {
		return invalidContract();
	}
	try {
		return {
			kind: 'success',
			data: input.map(result.data),
			receipt: result.receipt,
			correlationId: result.correlationId
		};
	} catch {
		return invalidContract();
	}
}

function samePreviewIdentity(
	left: {
		readonly audienceSpecId: string;
		readonly draftId: string;
		readonly draftVersion: number;
		readonly previewGeneration: number;
		readonly previewDigestProfile: string;
		readonly previewDigestVersion: number;
		readonly previewDigestSha256: string;
	},
	right: typeof left
): boolean {
	return left.audienceSpecId === right.audienceSpecId
		&& left.draftId === right.draftId
		&& left.draftVersion === right.draftVersion
		&& left.previewGeneration === right.previewGeneration
		&& left.previewDigestProfile === right.previewDigestProfile
		&& left.previewDigestVersion === right.previewDigestVersion
		&& left.previewDigestSha256 === right.previewDigestSha256;
}

function samePayloadRef(
	left: {
		readonly payloadRefId: string;
		readonly payloadRefVersion: number;
		readonly payloadKind: string;
		readonly schemaKey: string;
		readonly schemaVersion: number;
		readonly classification: string;
	},
	right: typeof left
): boolean {
	return left.payloadRefId === right.payloadRefId
		&& left.payloadRefVersion === right.payloadRefVersion
		&& left.payloadKind === right.payloadKind
		&& left.schemaKey === right.schemaKey
		&& left.schemaVersion === right.schemaVersion
		&& left.classification === right.classification;
}

/** Pure-live only: all paths and schema identities come from one browser-safe manifest. */
export function createCommunicationsAuthoringLivePort(input: {
	readonly manifest: unknown;
	readonly request?: CommunicationsAuthoringRequester;
}): CommunicationsAuthoringPort {
	const bindings = resolveBindings(input.manifest);
	const request = input.request ?? defaultRequester;

	const port: CommunicationsAuthoringPort = {
		source: Object.freeze({ kind: 'live' as const }),

		listPurposes(raw = {}, options = {}) {
			const parsed = organizerCommunicationPurposeListInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			return requestRead({
				binding: bindings.listPurposes,
				operation: 'list_communication_purposes',
				query: parsed.data,
				request,
				resultSchema: organizerCommunicationPurposePageOperationResultSchema,
				map: mapCommunicationPurposePage,
				guard: (page) => page.rows.every((row) =>
					(parsed.data.channel === undefined || row.channel === parsed.data.channel)
					&& (parsed.data.lifecycle === undefined || row.lifecycle === parsed.data.lifecycle)),
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		getPurpose(raw, options = {}) {
			const parsed = organizerCommunicationPurposeGetInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			return requestRead({
				binding: bindings.getPurpose,
				operation: 'get_communication_purpose',
				query: parsed.data,
				request,
				resultSchema: organizerCommunicationPurposeDetailOperationResultSchema,
				map: mapCommunicationPurposeDetail,
				guard: (purpose) => purpose.revision.purposeId === parsed.data.purposeId
					&& (parsed.data.revisionNumber === undefined
						|| purpose.revision.revisionNumber === parsed.data.revisionNumber),
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		listTemplates(raw = {}, options = {}) {
			const parsed = organizerMessageTemplateListInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			return requestRead({
				binding: bindings.listTemplates,
				operation: 'list_message_templates',
				query: parsed.data,
				request,
				resultSchema: organizerMessageTemplatePageOperationResultSchema,
				map: mapMessageTemplatePage,
				guard: (page) => page.rows.every((row) =>
					(parsed.data.purposeId === undefined
						|| row.purposeRevision.purposeId === parsed.data.purposeId)
					&& (parsed.data.lifecycle === undefined || row.lifecycle === parsed.data.lifecycle)
					&& (parsed.data.channel === undefined || row.channel === parsed.data.channel)),
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		getTemplate(raw, options = {}) {
			const parsed = organizerMessageTemplateGetInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			return requestRead({
				binding: bindings.getTemplate,
				operation: 'get_message_template',
				query: parsed.data,
				request,
				resultSchema: organizerMessageTemplateDetailOperationResultSchema,
				map: mapMessageTemplateDetail,
				guard: (template) => template.revision.templateId === parsed.data.templateId
					&& (parsed.data.revisionNumber === undefined
						|| template.revision.revisionNumber === parsed.data.revisionNumber),
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		listDrafts(raw = {}, options = {}) {
			const parsed = organizerCommunicationDraftListInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			return requestRead({
				binding: bindings.listDrafts,
				operation: 'list_message_drafts',
				query: parsed.data,
				request,
				resultSchema: organizerCommunicationDraftPageOperationResultSchema,
				map: mapCommunicationDraftPage,
				guard: (page) => page.rows.every((row) =>
					parsed.data.state === undefined || row.state === parsed.data.state),
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		getDraft(raw, options = {}) {
			const parsed = organizerCommunicationDraftGetInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			return requestRead({
				binding: bindings.getDraft,
				operation: 'get_message_draft',
				query: parsed.data,
				request,
				resultSchema: organizerCommunicationDraftOperationResultSchema,
				map: mapCommunicationDraft,
				guard: (draft) => draft.draftId === parsed.data.draftId
					&& (parsed.data.expectedVersion === undefined
						|| draft.version === parsed.data.expectedVersion),
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		storeAuthoringPayload(payload, idempotencyKey, options = {}) {
			const parsed = organizerStoreAuthoringPayloadInputSchema.safeParse({ payload });
			if (!parsed.success) return Promise.resolve(invalidRequest());
			const operation = COMMUNICATIONS_AUTHORING_OPERATIONS.storeAuthoringPayload;
			return requestEffect({
				binding: bindings.storeAuthoringPayload,
				operation: operation.name,
				operationIdentity: operation,
				body: parsed.data,
				idempotencyKey,
				request,
				resultSchema: organizerCommunicationAuthoringPayloadOperationResultSchema,
				map: mapCommunicationAuthoringPayloadRef,
				guard: (ref) => ref.payloadKind === parsed.data.payload.payloadKind,
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		createTemplate(raw, idempotencyKey, options = {}) {
			const parsed = organizerCreateMessageTemplateInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			const operation = COMMUNICATIONS_AUTHORING_OPERATIONS.createTemplate;
			return requestEffect({
				binding: bindings.createTemplate,
				operation: operation.name,
				operationIdentity: operation,
				body: parsed.data,
				idempotencyKey,
				request,
				resultSchema: organizerMessageTemplateMutationOperationResultSchema,
				map: mapMessageTemplateMutation,
				guard: (template) => template.key === parsed.data.templateKey
					&& template.name === parsed.data.templateName
					&& template.revision.revisionNumber === 1,
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		createDraft(raw, idempotencyKey, options = {}) {
			const parsed = organizerCreateCommunicationDraftInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			const operation = COMMUNICATIONS_AUTHORING_OPERATIONS.createDraft;
			return requestEffect({
				binding: bindings.createDraft,
				operation: operation.name,
				operationIdentity: operation,
				body: parsed.data,
				idempotencyKey,
				request,
				resultSchema: organizerCommunicationDraftMutationOperationResultSchema,
				map: mapCommunicationDraftMutation,
				guard: (draft) => draft.state === 'active' && (
					parsed.data.initial.kind === 'registered_empty_refs'
						? draft.authoring.state === 'uninitialized'
							&& draft.authoring.contentRefId === parsed.data.initial.contentRefId
							&& draft.authoring.audienceRefId === parsed.data.initial.audienceRefId
						: draft.authoring.state === 'ready'
							&& samePayloadRef(draft.authoring.contentPayload, parsed.data.initial.contentPayload)
							&& samePayloadRef(draft.authoring.audiencePayload, parsed.data.initial.audiencePayload)
				),
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		reviseDraft(raw, idempotencyKey, options = {}) {
			const parsed = organizerReviseCommunicationDraftInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			const operation = COMMUNICATIONS_AUTHORING_OPERATIONS.reviseDraft;
			return requestEffect({
				binding: bindings.reviseDraft,
				operation: operation.name,
				operationIdentity: operation,
				body: parsed.data,
				idempotencyKey,
				request,
				resultSchema: organizerCommunicationDraftMutationOperationResultSchema,
				map: mapCommunicationDraftMutation,
				guard: (draft) => draft.draftId === parsed.data.draftId
					&& draft.version === parsed.data.expectedVersion + 1
					&& draft.state === 'active'
					&& draft.authoring.state === 'ready'
					&& samePayloadRef(draft.authoring.contentPayload, parsed.data.contentPayload)
					&& samePayloadRef(draft.authoring.audiencePayload, parsed.data.audiencePayload),
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		discardDraft(raw, idempotencyKey, options = {}) {
			const parsed = organizerDiscardCommunicationDraftInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			const operation = COMMUNICATIONS_AUTHORING_OPERATIONS.discardDraft;
			return requestEffect({
				binding: bindings.discardDraft,
				operation: operation.name,
				operationIdentity: operation,
				body: parsed.data,
				idempotencyKey,
				request,
				resultSchema: organizerCommunicationDraftMutationOperationResultSchema,
				map: mapCommunicationDraftMutation,
				guard: (draft) => draft.draftId === parsed.data.draftId
					&& draft.version === parsed.data.expectedVersion + 1
					&& draft.state === 'discarded',
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		listAudienceOptions(raw = {}, options = {}) {
			const parsed = organizerCommunicationAudienceOptionListInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			return requestRead({
				binding: bindings.listAudienceOptions,
				operation: 'list_audience_options',
				query: parsed.data,
				request,
				resultSchema: organizerCommunicationAudienceOptionPageOperationResultSchema,
				map: mapCommunicationAudienceOptionPage,
				guard: (page) => page.rows.every((row) => parsed.data.purposeId === undefined
					|| row.audienceDraft.purposeRevision.purposeId === parsed.data.purposeId),
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		getPreview(raw, options = {}) {
			const parsed = organizerMessageBatchPreviewGetInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			return requestRead({
				binding: bindings.getPreview,
				operation: 'get_message_batch_preview',
				query: parsed.data,
				request,
				resultSchema: organizerMessageBatchPreviewDetailOperationResultSchema,
				map: mapMessageBatchPreviewDetail,
				guard: (preview) => samePreviewIdentity(preview.summary.identity, parsed.data)
					&& (parsed.data.selectedRecipientResolutionId === undefined
						? preview.selected.kind === 'none'
						: preview.selected.kind === 'rendered_email'
							&& preview.selected.render.recipientResolutionId
								=== parsed.data.selectedRecipientResolutionId),
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		listPreviewRecipients(raw, options = {}) {
			const parsed = organizerMessagePreviewRecipientListInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			return requestRead({
				binding: bindings.listPreviewRecipients,
				operation: 'list_message_preview_recipients',
				query: parsed.data,
				request,
				resultSchema: organizerMessagePreviewRecipientPageOperationResultSchema,
				map: mapMessagePreviewRecipientPage,
				guard: (page) => samePreviewIdentity(page.identity, parsed.data)
					&& page.rows.every((row) =>
						(parsed.data.state === undefined || row.state === parsed.data.state)
						&& (parsed.data.reasonCode === undefined
							|| ('reasonCode' in row && row.reasonCode === parsed.data.reasonCode))),
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		prepareBatchPreview(raw, options = {}) {
			const parsed = organizerPreviewMessageBatchInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			return requestRead({
				binding: bindings.prepareBatchPreview,
				operation: 'prepare_message_batch_preview',
				query: parsed.data,
				request,
				resultSchema: organizerPrepareMessagePreviewOperationResultSchema,
				map: mapMessagePreviewPrepare,
				guard: (prepared) => prepared.state === 'prepared'
					&& prepared.draftId === parsed.data.draftId
					&& prepared.draftVersion === parsed.data.expectedDraftVersion,
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		adoptBatchPreview(raw, idempotencyKey, options = {}) {
			const parsed = organizerPreviewMessageBatchInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			const operation = COMMUNICATIONS_AUTHORING_OPERATIONS.adoptBatchPreview;
			return requestEffect({
				binding: bindings.adoptBatchPreview,
				operation: operation.name,
				operationIdentity: operation,
				body: parsed.data,
				idempotencyKey,
				request,
				resultSchema: organizerPreviewMessageBatchOperationResultSchema,
				map: mapMessagePreviewSummary,
				guard: (summary) => summary.identity.draftId === parsed.data.draftId
					&& summary.identity.draftVersion === parsed.data.expectedDraftVersion,
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		sendMessages(raw, idempotencyKey, options = {}) {
			const parsed = organizerSendMessagesInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			const operation = COMMUNICATIONS_AUTHORING_OPERATIONS.sendMessages;
			return requestEffect({
				binding: bindings.sendMessages,
				operation: operation.name,
				operationIdentity: operation,
				body: parsed.data,
				idempotencyKey,
				request,
				resultSchema: organizerSendMessagesOperationResultSchema,
				map: mapSendMessagesResult,
				guard: (result) => result.batchId === parsed.data.batchId
					&& result.dispatchGeneration === 1,
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		retryDelivery(raw, idempotencyKey, options = {}) {
			const parsed = organizerRetryMessageDeliveryInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			const operation = COMMUNICATIONS_AUTHORING_OPERATIONS.retryDelivery;
			return requestEffect({
				binding: bindings.retryDelivery,
				operation: operation.name,
				operationIdentity: operation,
				body: parsed.data,
				idempotencyKey,
				request,
				resultSchema: organizerRetryMessageDeliveryOperationResultSchema,
				map: mapRetryMessageDeliveryResult,
				guard: (result) => result.deliveryId === parsed.data.deliveryId,
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		getDeliveryHistory(raw = {}, options = {}) {
			const parsed = organizerCommunicationHistoryListInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			return requestRead({
				binding: bindings.getDeliveryHistory,
				operation: 'get_delivery_history',
				query: parsed.data,
				request,
				resultSchema: organizerCommunicationHistoryPageOperationResultSchema,
				map: mapCommunicationDeliveryHistoryPage,
				guard: (page) => page.rows.every((row) =>
					(parsed.data.state === undefined || row.state === parsed.data.state)
					&& (parsed.data.messageRefId === undefined
						|| row.messageRefId === parsed.data.messageRefId)),
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		listAttentionItems(raw = {}, options = {}) {
			const parsed = organizerCommunicationAttentionListInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			return requestRead({
				binding: bindings.listAttentionItems,
				operation: 'list_message_attention_items',
				query: parsed.data,
				request,
				resultSchema: organizerCommunicationAttentionPageOperationResultSchema,
				map: mapCommunicationAttentionPage,
				guard: (page) => page.rows.every((row) =>
					(parsed.data.severity === undefined || row.severity === parsed.data.severity)
					&& (parsed.data.reasonCode === undefined || row.reasonCode === parsed.data.reasonCode)),
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		getPersonThread(raw, options = {}) {
			const parsed = organizerCommunicationThreadGetInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			return requestRead({
				binding: bindings.getPersonThread,
				operation: 'get_person_thread',
				query: parsed.data,
				request,
				resultSchema: organizerCommunicationThreadPageOperationResultSchema,
				map: mapCommunicationThreadPage,
				guard: (page) => page.personRefId === parsed.data.personRefId,
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		getDeliveryTimeline(raw, options = {}) {
			const parsed = organizerCommunicationTimelineGetInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			return requestRead({
				binding: bindings.getDeliveryTimeline,
				operation: 'get_delivery_timeline',
				query: parsed.data,
				request,
				resultSchema: organizerCommunicationTimelinePageOperationResultSchema,
				map: mapCommunicationTimelinePage,
				guard: (page) => page.deliveryId === parsed.data.deliveryId,
				...(options.signal ? { signal: options.signal } : {})
			});
		}
	};
	return Object.freeze(port);
}
