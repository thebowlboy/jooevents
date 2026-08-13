import type {
	AudienceOption,
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
		compose(input: {
			subject: string;
			audienceId: string;
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
