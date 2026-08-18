import type {
	operationHttpIdempotencyKeySchema,
	OperationReceiptRef,
	organizerCommunicationAudienceOptionListInputSchema,
	organizerCommunicationAttentionListInputSchema,
	OrganizerCommunicationAuthoringPayloadInput,
	organizerCommunicationDraftGetInputSchema,
	organizerCommunicationDraftListInputSchema,
	organizerCommunicationHistoryListInputSchema,
	organizerCommunicationThreadGetInputSchema,
	organizerCommunicationTimelineGetInputSchema,
	organizerCommunicationPurposeGetInputSchema,
	organizerCommunicationPurposeListInputSchema,
	organizerCreateCommunicationDraftInputSchema,
	organizerCreateMessageTemplateInputSchema,
	organizerDiscardCommunicationDraftInputSchema,
	organizerMessageBatchPreviewGetInputSchema,
	organizerMessagePreviewRecipientListInputSchema,
	organizerMessageTemplateGetInputSchema,
	organizerMessageTemplateListInputSchema,
	organizerPreviewMessageBatchInputSchema,
	organizerRetryMessageDeliveryInputSchema,
	organizerReviseCommunicationDraftInputSchema,
	organizerSendMessagesInputSchema,
	StructuredOutcome
} from '@jooevents/contracts';
import type { z } from 'zod';
import type { SafeApiError } from './client';
import type { OperatorHttpBindingUnavailableReason } from './operations/operator-http-binding';
import type {
	CommunicationAudienceOptionPageView,
	CommunicationAttentionPageView,
	CommunicationAuthoringPayloadRefView,
	CommunicationDeliveryHistoryPageView,
	CommunicationDraftMutationView,
	CommunicationDraftPageView,
	CommunicationDraftView,
	CommunicationPurposeDetailView,
	CommunicationPurposePageView,
	CommunicationThreadPageView,
	CommunicationTimelinePageView,
	MessageBatchPreviewDetailView,
	MessagePreviewPrepareView,
	MessagePreviewRecipientPageView,
	MessagePreviewSummaryView,
	MessageTemplateDetailView,
	MessageTemplateMutationView,
	MessageTemplatePageView,
	RetryMessageDeliveryResultView,
	SendMessagesResultView
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
export type MessagePreviewPrepareRequest = z.input<
	typeof organizerPreviewMessageBatchInputSchema
>;
export type SendMessagesRequest = z.input<typeof organizerSendMessagesInputSchema>;
export type RetryMessageDeliveryRequest = z.input<typeof organizerRetryMessageDeliveryInputSchema>;
export type DeliveryHistoryListRequest = z.input<
	typeof organizerCommunicationHistoryListInputSchema
>;
export type CommunicationAttentionListRequest = z.input<
	typeof organizerCommunicationAttentionListInputSchema
>;
export type CommunicationThreadGetRequest = z.input<typeof organizerCommunicationThreadGetInputSchema>;
export type CommunicationTimelineGetRequest = z.input<typeof organizerCommunicationTimelineGetInputSchema>;
export type CommunicationDraftCreateRequest = z.input<
	typeof organizerCreateCommunicationDraftInputSchema
>;
export type MessageTemplateCreateRequest = z.input<typeof organizerCreateMessageTemplateInputSchema>;
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
	| 'message_template.create'
	| 'create_message_draft'
	| 'revise_message_batch'
	| 'discard_message_draft'
	| 'list_audience_options'
	| 'get_message_batch_preview'
	| 'list_message_preview_recipients'
	| 'prepare_message_batch_preview'
	| 'preview_message_batch'
	| 'send_messages'
	| 'retry_message_delivery'
	| 'get_delivery_history'
	| 'list_message_attention_items'
	| 'get_person_thread'
	| 'get_delivery_timeline';

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
	createTemplate(
		input: MessageTemplateCreateRequest,
		idempotencyKey: CommunicationIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationEffectResult<MessageTemplateMutationView>>;
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

	/**
	 * The two-step preview adoption lane: the compute-only prepare read runs
	 * the asynchronous audience resolution server-side against the exact draft
	 * revision, then the adopt effect makes that preparation the immutable,
	 * reviewed preview inside one unit of work — re-verifying draft version
	 * and audience guard state before anything is written.
	 */
	prepareBatchPreview(
		input: MessagePreviewPrepareRequest,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationReadResult<MessagePreviewPrepareView>>;
	adoptBatchPreview(
		input: MessagePreviewPrepareRequest,
		idempotencyKey: CommunicationIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationEffectResult<MessagePreviewSummaryView>>;
	/**
	 * Commits one adopted, reviewed preview as an irreversible release batch.
	 * A preview whose evidence no longer reproduces from current domain state
	 * refuses typed (`stale_revision`/`communication.preview_changed`) instead
	 * of sending; nothing is ever pretended sent.
	 */
	sendMessages(
		input: SendMessagesRequest,
		idempotencyKey: CommunicationIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationEffectResult<SendMessagesResultView>>;
	retryDelivery(
		input: RetryMessageDeliveryRequest,
		idempotencyKey: CommunicationIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationEffectResult<RetryMessageDeliveryResultView>>;
	/**
	 * Per-batch send evidence with live per-recipient delivery-state counts
	 * recomputed from the outbound ledger on every read — never a fire-once
	 * flag, and never an address.
	 */
	getDeliveryHistory(
		input?: DeliveryHistoryListRequest,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationReadResult<CommunicationDeliveryHistoryPageView>>;
	listAttentionItems(
		input?: CommunicationAttentionListRequest,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationReadResult<CommunicationAttentionPageView>>;
	getPersonThread(
		input: CommunicationThreadGetRequest,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationReadResult<CommunicationThreadPageView>>;
	getDeliveryTimeline(
		input: CommunicationTimelineGetRequest,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationReadResult<CommunicationTimelinePageView>>;
}
