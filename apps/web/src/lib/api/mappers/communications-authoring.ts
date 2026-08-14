import type {
	organizerCommunicationAudienceOptionPageSchema,
	OrganizerCommunicationAuthoringPayloadRef,
	OrganizerCommunicationDraftMutationResult,
	OrganizerCommunicationDraftProjection,
	organizerCommunicationDraftPageSchema,
	OrganizerCommunicationHistoryPage,
	OrganizerCommunicationPurposeDetail,
	organizerCommunicationPurposePageSchema,
	OrganizerMessageBatchPreviewDetail,
	organizerMessagePreviewRecipientPageSchema,
	OrganizerMessagePreviewIdentity,
	organizerMessagePreviewSummarySchema,
	OrganizerMessageTemplateDetail,
	organizerMessageTemplatePageSchema,
	OrganizerPrepareMessagePreviewResult,
	OrganizerSendMessagesResult
} from '@jooevents/contracts';
import type { z } from 'zod';
import type {
	CommunicationAudienceOptionPageView,
	CommunicationAuthoringPayloadRefView,
	CommunicationDeliveryHistoryPageView,
	CommunicationDraftMutationView,
	CommunicationDraftPageView,
	CommunicationDraftView,
	CommunicationPurposeDetailView,
	CommunicationPurposePageView,
	CommunicationView,
	MessageBatchPreviewDetailView,
	MessagePreviewIdentityView,
	MessagePreviewPrepareView,
	MessagePreviewRecipientPageView,
	MessagePreviewSummaryView,
	MessageTemplateDetailView,
	MessageTemplatePageView,
	SendMessagesResultView
} from '../view-models/communications-authoring';

type PurposePage = z.infer<typeof organizerCommunicationPurposePageSchema>;
type TemplatePage = z.infer<typeof organizerMessageTemplatePageSchema>;
type AudienceOptionPage = z.infer<typeof organizerCommunicationAudienceOptionPageSchema>;
type DraftPage = z.infer<typeof organizerCommunicationDraftPageSchema>;
type PreviewRecipientPage = z.infer<typeof organizerMessagePreviewRecipientPageSchema>;
type PreviewSummary = z.infer<typeof organizerMessagePreviewSummarySchema>;

function freezeJson(value: unknown): void {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
	for (const child of Object.values(value)) freezeJson(child);
	Object.freeze(value);
}

/**
 * Contract additions are preserved automatically: the browser copy is exhaustive by
 * type and by value, while severing mutable wire-object aliases before feature code sees it.
 */
function immutableCopy<Value>(value: Value): CommunicationView<Value> {
	const copy = structuredClone(value);
	freezeJson(copy);
	return copy as CommunicationView<Value>;
}

export function mapCommunicationPurposePage(value: PurposePage): CommunicationPurposePageView {
	return immutableCopy(value);
}

export function mapCommunicationPurposeDetail(
	value: OrganizerCommunicationPurposeDetail
): CommunicationPurposeDetailView {
	return immutableCopy(value);
}

export function mapMessageTemplatePage(value: TemplatePage): MessageTemplatePageView {
	return immutableCopy(value);
}

export function mapMessageTemplateDetail(
	value: OrganizerMessageTemplateDetail
): MessageTemplateDetailView {
	return immutableCopy(value);
}

export function mapCommunicationAudienceOptionPage(
	value: AudienceOptionPage
): CommunicationAudienceOptionPageView {
	return immutableCopy(value);
}

export function mapCommunicationDraftPage(value: DraftPage): CommunicationDraftPageView {
	return immutableCopy(value);
}

export function mapCommunicationDraft(
	value: OrganizerCommunicationDraftProjection
): CommunicationDraftView {
	return immutableCopy(value);
}

export function mapCommunicationAuthoringPayloadRef(
	value: OrganizerCommunicationAuthoringPayloadRef
): CommunicationAuthoringPayloadRefView {
	return immutableCopy(value);
}

export function mapCommunicationDraftMutation(
	value: OrganizerCommunicationDraftMutationResult
): CommunicationDraftMutationView {
	return immutableCopy(value);
}

export function mapMessagePreviewIdentity(
	value: OrganizerMessagePreviewIdentity
): MessagePreviewIdentityView {
	return immutableCopy(value);
}

export function mapMessageBatchPreviewDetail(
	value: OrganizerMessageBatchPreviewDetail
): MessageBatchPreviewDetailView {
	return immutableCopy(value);
}

export function mapMessagePreviewRecipientPage(
	value: PreviewRecipientPage
): MessagePreviewRecipientPageView {
	return immutableCopy(value);
}

export function mapMessagePreviewPrepare(
	value: OrganizerPrepareMessagePreviewResult
): MessagePreviewPrepareView {
	return immutableCopy(value);
}

export function mapMessagePreviewSummary(value: PreviewSummary): MessagePreviewSummaryView {
	return immutableCopy(value);
}

export function mapSendMessagesResult(value: OrganizerSendMessagesResult): SendMessagesResultView {
	return immutableCopy(value);
}

export function mapCommunicationDeliveryHistoryPage(
	value: OrganizerCommunicationHistoryPage
): CommunicationDeliveryHistoryPageView {
	return immutableCopy(value);
}
