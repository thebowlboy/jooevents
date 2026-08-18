import type {
	AnyTemplate,
	AudienceOption,
	AudiencePreview,
	CommunicationAttentionItem,
	CommunicationDeliveryTimeline,
	CommunicationMessage,
	CommunicationThread,
	EmailReadiness,
	EventTheme,
	MessageTemplate,
	SpeakerProfile,
	MutationOutcome
} from './types';

/** Factual capabilities consumed by the tuned organizer Communications surface. */
export interface CommunicationsPagePort {
	readonly source: { readonly kind: 'sample' | 'live' };
	readonly communications: {
		list(): Promise<CommunicationMessage[]>;
		readiness(): Promise<EmailReadiness>;
		attention(): Promise<CommunicationAttentionItem[]>;
		thread(personId: string): Promise<CommunicationThread | null>;
		timeline(messageId: string): Promise<CommunicationDeliveryTimeline | null>;
		/** The exact one-recipient artifact that the controlled resend will submit. */
		previewResend(messageId: string, safeLabel: string): Promise<import('./types').RenderedEmailPreview>;
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
			/**
			 * The one-off body, when the compose started blank. Frozen onto the
			 * message so the review renders what will actually be sent; a compose
			 * that named a stored template sends that instead and passes none.
			 */
			document?: MessageTemplate;
		}): Promise<CommunicationMessage>;
		/** Rebuilds the current frozen review for a previously saved live draft. */
		reviewDraft?(id: string): Promise<CommunicationMessage>;
		send(id: string): Promise<MutationOutcome>;
		/** Server-rendered copy for a live adopted preview. */
		previewRecipient?(recipientResolutionId: string): Promise<import('./types').RenderedEmailPreview>;
		resendBounced(id: string, email: string, correctedEmail: string): Promise<MutationOutcome>;
	};
	/**
	 * The composer's own template surface. It is declared here rather than by
	 * widening `TemplatesPagePort` on purpose: that port is implemented
	 * member-by-member by the live templates adapter, and requiring `create`
	 * there would break a lane this pass does not own. The sample workspace
	 * satisfies both from one namespace.
	 */
	readonly templates: {
		list(): Promise<{ readonly messages: MessageTemplate[] }>;
		/**
		 * Mints a hand-made template from one of the offered kinds and stores it
		 * where the picker reads, so a template made here is the same kind of
		 * record as a starter rather than a composer-only draft.
		 */
		create(input: { name: string; kind: string }): Promise<MessageTemplate>;
		/**
		 * Commits one edited unit as the template's next revision — the same
		 * organizer-lane write the Templates editor makes, so a change made from
		 * the composer lands in the one history.
		 */
		commitInline(id: string, next: AnyTemplate, note: string): Promise<MutationOutcome>;
	};
	readonly theme: {
		get(): Promise<EventTheme>;
	};
	/**
	 * The individual-disclosure door behind a name in the audience preview.
	 * Optional: a composition that cannot serve profiles renders the names as
	 * plain text, which is the same list minus one door — never a broken one.
	 */
	readonly speakers?: {
		/**
		 * Keyed by roster id, not address: the audience preview deliberately
		 * carries no addresses, so the surface asks with the opaque id it does
		 * hold and the composition resolves the person.
		 */
		profileById(speakerId: string): Promise<SpeakerProfile | null>;
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
