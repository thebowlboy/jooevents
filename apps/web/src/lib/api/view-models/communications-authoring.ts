import type {
	organizerCommunicationAudienceOptionPageSchema,
	OrganizerCommunicationAuthoringPayloadRef,
	OrganizerCommunicationDraftMutationResult,
	OrganizerCommunicationDraftProjection,
	organizerCommunicationDraftPageSchema,
	OrganizerCommunicationHistoryPage,
	OrganizerCommunicationPurposeDetail,
	organizerCommunicationPurposePageSchema,
	OrganizerCommunicationPurposeRevisionRef,
	OrganizerMessageBatchPreviewDetail,
	organizerMessagePreviewRecipientPageSchema,
	OrganizerMessagePreviewIdentity,
	organizerMessagePreviewSummarySchema,
	OrganizerMessageTemplateDetail,
	organizerMessageTemplatePageSchema,
	OrganizerMessageTemplateRevisionRef,
	OrganizerPrepareMessagePreviewResult,
	OrganizerSendMessagesResult
} from '@jooevents/contracts';
import type { z } from 'zod';

/** Browser-owned immutable copies of canonical organizer communication projections. */
export type CommunicationView<T> =
	T extends string | number | boolean | bigint | symbol | null | undefined
		? T
		: T extends (...args: never[]) => unknown
		? T
		: T extends readonly (infer Item)[]
			? readonly CommunicationView<Item>[]
			: T extends object
				? { readonly [Key in keyof T]: CommunicationView<T[Key]> }
				: T;

export type CommunicationPurposeRevisionRefView =
	CommunicationView<OrganizerCommunicationPurposeRevisionRef>;
export type MessageTemplateRevisionRefView =
	CommunicationView<OrganizerMessageTemplateRevisionRef>;

export type CommunicationPurposePageView = CommunicationView<
	z.infer<typeof organizerCommunicationPurposePageSchema>
>;
export type CommunicationPurposeDetailView =
	CommunicationView<OrganizerCommunicationPurposeDetail>;

export type MessageTemplatePageView = CommunicationView<
	z.infer<typeof organizerMessageTemplatePageSchema>
>;
export type MessageTemplateDetailView = CommunicationView<OrganizerMessageTemplateDetail>;

export type CommunicationAudienceOptionPageView = CommunicationView<
	z.infer<typeof organizerCommunicationAudienceOptionPageSchema>
>;

/** Keeps `uninitialized` and `ready` distinct, including the registered empty refs. */
export type CommunicationDraftPageView = CommunicationView<
	z.infer<typeof organizerCommunicationDraftPageSchema>
>;
export type CommunicationDraftView = CommunicationView<OrganizerCommunicationDraftProjection>;

/** Receipt-safe result of create, revise, or discard. Editable values require the next read. */
export type CommunicationDraftMutationView =
	CommunicationView<OrganizerCommunicationDraftMutationResult>;

/** Opaque classified reference only; authoring payload bytes never enter mutation receipts. */
export type CommunicationAuthoringPayloadRefView =
	CommunicationView<OrganizerCommunicationAuthoringPayloadRef>;

/** The complete preview tuple is one value and is never reduced to an audience or membership id. */
export type MessagePreviewIdentityView = CommunicationView<OrganizerMessagePreviewIdentity>;
export type MessageBatchPreviewDetailView =
	CommunicationView<OrganizerMessageBatchPreviewDetail>;
export type MessagePreviewRecipientPageView = CommunicationView<
	z.infer<typeof organizerMessagePreviewRecipientPageSchema>
>;

/** Step-one acknowledgment of the two-step adoption lane; nothing durable yet. */
export type MessagePreviewPrepareView = CommunicationView<OrganizerPrepareMessagePreviewResult>;
/** The adopted, immutable reviewed preview summary the send commit later pins. */
export type MessagePreviewSummaryView = CommunicationView<
	z.infer<typeof organizerMessagePreviewSummarySchema>
>;
/** Receipt-safe send commit result: counts and identity only, never an address. */
export type SendMessagesResultView = CommunicationView<OrganizerSendMessagesResult>;
/** Per-batch delivery history with live ledger-derived state counts. */
export type CommunicationDeliveryHistoryPageView =
	CommunicationView<OrganizerCommunicationHistoryPage>;
