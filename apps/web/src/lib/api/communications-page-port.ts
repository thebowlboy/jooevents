import type {
	AudienceOption,
	AudiencePreview,
	CommunicationAttentionItem,
	CommunicationMessage,
	CommunicationThread,
	EmailReadiness,
	EventTheme,
	MessageTemplate,
	MutationOutcome
} from './types';

/** Factual capabilities consumed by the tuned organizer Communications surface. */
export interface CommunicationsPagePort {
	readonly communications: {
		list(): Promise<CommunicationMessage[]>;
		readiness(): Promise<EmailReadiness>;
		attention(): Promise<CommunicationAttentionItem[]>;
		thread(personId: string): Promise<CommunicationThread | null>;
		audiences(personId?: string): Promise<AudienceOption[]>;
		/**
		 * What a combination of audiences comes to, before anything is drafted:
		 * the deduplicated people, how many are reached, and how many of them more
		 * than one selected group claimed. A pick-time read — the authoritative
		 * check stays the review — so it discloses names and states, never
		 * addresses.
		 */
		previewRecipients(audienceIds: readonly string[]): Promise<AudiencePreview>;
		compose(input: {
			subject: string;
			/**
			 * The selected audiences, in the order they were picked. They union:
			 * a person in two of them is written once, and the first group to
			 * claim them owns the copy they receive.
			 */
			audienceIds: readonly string[];
			templateId?: string;
		}): Promise<CommunicationMessage>;
		send(id: string): Promise<MutationOutcome>;
		resendBounced(id: string, email: string, correctedEmail: string): Promise<MutationOutcome>;
	};
	readonly templates: {
		list(): Promise<{ readonly messages: MessageTemplate[] }>;
	};
	readonly theme: {
		get(): Promise<EventTheme>;
	};
	readonly workspace: {
		summary(): Promise<{
			readonly event: null | {
				readonly name: string;
				readonly dates: string;
				readonly location: string;
			};
		}>;
	};
}
