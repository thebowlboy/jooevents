import type {
	operationHttpIdempotencyKeySchema,
	OperationReceiptRef,
	organizerCommunicationAudienceOptionListInputSchema,
	OrganizerCommunicationAuthoringPayloadInput,
	organizerCommunicationDraftGetInputSchema,
	organizerCommunicationDraftListInputSchema,
	organizerCommunicationPurposeGetInputSchema,
	organizerCommunicationPurposeListInputSchema,
	organizerCreateCommunicationDraftInputSchema,
	organizerDiscardCommunicationDraftInputSchema,
	organizerMessageBatchPreviewGetInputSchema,
	organizerMessagePreviewRecipientListInputSchema,
	organizerMessageTemplateGetInputSchema,
	organizerMessageTemplateListInputSchema,
	organizerReviseCommunicationDraftInputSchema,
	StructuredOutcome
} from '@jooevents/contracts';
import type { z } from 'zod';
import type { SafeApiError } from './client';
import type { OperatorHttpBindingUnavailableReason } from './operations/operator-http-binding';
import type {
	CommunicationAudienceOptionPageView,
	CommunicationAuthoringPayloadRefView,
	CommunicationDraftMutationView,
	CommunicationDraftPageView,
	CommunicationDraftView,
	CommunicationPurposeDetailView,
	CommunicationPurposePageView,
	MessageBatchPreviewDetailView,
	MessagePreviewRecipientPageView,
	MessageTemplateDetailView,
	MessageTemplatePageView
} from './view-models/communications-authoring';

export type CommunicationPurposeListRequest = z.input<
	typeof organizerCommunicationPurposeListInputSchema
>;
export type CommunicationPurposeGetRequest = z.input<
	typeof organizerCommunicationPurposeGetInputSchema
>;
export type MessageTemplateListRequest = z.input<typeof organizerMessageTemplateListInputSchema>;
export type MessageTemplateGetRequest = z.input<typeof organizerMessageTemplateGetInputSchema>;
export type CommunicationDraftListRequest = z.input<typeof organizerCommunicationDraftListInputSchema>;
export type CommunicationDraftGetRequest = z.input<typeof organizerCommunicationDraftGetInputSchema>;
export type CommunicationAudienceOptionListRequest = z.input<
	typeof organizerCommunicationAudienceOptionListInputSchema
>;
export type MessageBatchPreviewGetRequest = z.input<
	typeof organizerMessageBatchPreviewGetInputSchema
>;
export type MessagePreviewRecipientListRequest = z.input<
	typeof organizerMessagePreviewRecipientListInputSchema
>;
export type CommunicationDraftCreateRequest = z.input<
	typeof organizerCreateCommunicationDraftInputSchema
>;
export type CommunicationDraftReviseRequest = z.input<
	typeof organizerReviseCommunicationDraftInputSchema
>;
export type CommunicationDraftDiscardRequest = z.input<
	typeof organizerDiscardCommunicationDraftInputSchema
>;
export type CommunicationIdempotencyKey = z.input<typeof operationHttpIdempotencyKeySchema>;

export type CommunicationAuthoringOperation =
	| 'list_communication_purposes'
	| 'get_communication_purpose'
	| 'list_message_templates'
	| 'get_message_template'
	| 'list_message_drafts'
	| 'get_message_draft'
	| 'store_communication_authoring_payload'
	| 'create_message_draft'
	| 'revise_message_batch'
	| 'discard_message_draft'
	| 'list_audience_options'
	| 'get_message_batch_preview'
	| 'list_message_preview_recipients';

export type CommunicationUnavailableResult = {
	readonly kind: 'unavailable';
	readonly operation: CommunicationAuthoringOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};

export type CommunicationReadResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| CommunicationUnavailableResult;

export type CommunicationEffectResult<Data> =
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
	  }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| CommunicationUnavailableResult;

export interface CommunicationsAuthoringPort {
	readonly source: { readonly kind: 'live' };

	listPurposes(
		input?: CommunicationPurposeListRequest,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationReadResult<CommunicationPurposePageView>>;
	getPurpose(
		input: CommunicationPurposeGetRequest,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationReadResult<CommunicationPurposeDetailView>>;
	listTemplates(
		input?: MessageTemplateListRequest,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationReadResult<MessageTemplatePageView>>;
	getTemplate(
		input: MessageTemplateGetRequest,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationReadResult<MessageTemplateDetailView>>;
	listDrafts(
		input?: CommunicationDraftListRequest,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationReadResult<CommunicationDraftPageView>>;
	getDraft(
		input: CommunicationDraftGetRequest,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationReadResult<CommunicationDraftView>>;

	storeAuthoringPayload(
		payload: OrganizerCommunicationAuthoringPayloadInput,
		idempotencyKey: CommunicationIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationEffectResult<CommunicationAuthoringPayloadRefView>>;
	createDraft(
		input: CommunicationDraftCreateRequest,
		idempotencyKey: CommunicationIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationEffectResult<CommunicationDraftMutationView>>;
	reviseDraft(
		input: CommunicationDraftReviseRequest,
		idempotencyKey: CommunicationIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationEffectResult<CommunicationDraftMutationView>>;
	discardDraft(
		input: CommunicationDraftDiscardRequest,
		idempotencyKey: CommunicationIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationEffectResult<CommunicationDraftMutationView>>;

	listAudienceOptions(
		input?: CommunicationAudienceOptionListRequest,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationReadResult<CommunicationAudienceOptionPageView>>;
	getPreview(
		input: MessageBatchPreviewGetRequest,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationReadResult<MessageBatchPreviewDetailView>>;
	listPreviewRecipients(
		input: MessagePreviewRecipientListRequest,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationReadResult<MessagePreviewRecipientPageView>>;
}
