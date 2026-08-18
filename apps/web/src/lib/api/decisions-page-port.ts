import type {
	AccoladeDef,
	DecisionState,
	EmailReadiness,
	EventTheme,
	MessageReview,
	MessageTemplate,
	MyReviewItem,
	NotificationDispatch,
	RenderedEmailPreview,
	ReviewPlan,
	ScheduleState,
	ScoreStanding,
	SpeakerProfile,
	Submission,
	SubmissionPage,
	SubmissionReview,
	Track
} from './types';

/**
 * Factual capabilities consumed by the tuned Decisions surface.
 *
 * Decisions is an aggregate presentation: candidate Intake facts, review
 * evidence, program vocabulary, acceptance routing, and an outbound-message
 * review all remain owned by their respective application operations. A live
 * composition must join those projections rather than inventing a monolithic
 * Decisions record or filling absent evidence with sample values.
 */
export interface DecisionsPagePort {
	readonly workspace: {
		/** Synchronous loading-shape evidence; null means it has not been read yet. */
		decisionAttentionExpectedSnapshot(): boolean | null;
	};
	readonly submissions: {
		list(query: { readonly tray: 'inbox' | 'late' }): Promise<SubmissionPage>;
	};
	readonly review: {
		standings(submissionIds: string[]): Promise<Record<string, ScoreStanding>>;
		myQueue(): Promise<MyReviewItem[]>;
		accoladeDefs(): Promise<AccoladeDef[]>;
		plans(): Promise<ReviewPlan[]>;
		forSubmission(submissionId: string): Promise<SubmissionReview[]>;
	};
	readonly vocab: {
		tracks(): Promise<Track[]>;
	};
	readonly settings: {
		get(): Promise<{ readonly name: string } | null>;
	};
	readonly templates: {
		list(): Promise<{ readonly messages: MessageTemplate[] }>;
	};
	readonly speakers: {
		profile(email: string): Promise<SpeakerProfile | null>;
	};
	readonly schedule: {
		state(): Promise<ScheduleState>;
	};
	readonly decisions: {
		decide(
			ids: string[],
			decision: DecisionState,
			trackIdsBySubmission?: Readonly<Record<string, string>>
		): Promise<void>;
		reviewNotification(ids: string[]): Promise<MessageReview>;
		/**
		 * Commits the reviewed notifications and states what that commit did.
		 * The result is the surface's only source for the send's outcome: what
		 * a provider accepted is a fact only the sending port holds, so the
		 * page renders this record rather than echoing the count it asked for.
		 */
		notify(ids: string[], subject: string): Promise<NotificationDispatch>;
		/**
		 * One recipient's email as the sending lane rendered it, for the send
		 * ceremony to show before anything leaves. Optional because a composition
		 * whose body is a stored template renders it in the browser instead and
		 * has nothing server-side to ask for; a composition that offers neither
		 * cannot state what it sends, which is the defect this member exists to
		 * remove.
		 */
		previewRecipient?(recipientResolutionId: string): Promise<RenderedEmailPreview>;
	};
	readonly communications: {
		readiness(): Promise<EmailReadiness>;
	};
	/**
	 * The event brand the rendered preview is drawn in. Optional: a composition
	 * that cannot supply it falls back to whatever body evidence it does have,
	 * rather than the ceremony losing its preview entirely.
	 */
	readonly theme?: {
		get(): Promise<EventTheme>;
	};
}
