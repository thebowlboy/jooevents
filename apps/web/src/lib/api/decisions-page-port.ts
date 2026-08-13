import type {
	AccoladeDef,
	DecisionState,
	EmailReadiness,
	MessageReview,
	MessageTemplate,
	MyReviewItem,
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
		decide(ids: string[], decision: DecisionState): Promise<void>;
		reviewNotification(ids: string[]): Promise<MessageReview>;
		notify(ids: string[], subject: string): Promise<unknown>;
	};
	readonly communications: {
		readiness(): Promise<EmailReadiness>;
	};
}
