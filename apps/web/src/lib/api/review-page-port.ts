import type {
	AccoladeDef,
	AccoladeKey,
	ComparableCard,
	Format,
	MutationOutcome,
	MyReviewItem,
	ReviewPlan,
	ReviewRoundSetup,
	ScheduleState,
	ScopeRef,
	ScoreStanding,
	SpeakerProfile,
	Submission,
	Track
} from './types';

/** The authority projection the tuned Review surface renders under. */
export type ReviewPageViewer =
	| { readonly kind: 'organizer' }
	| { readonly kind: 'reviewer'; readonly reviewerId: string };

/**
 * The factual capabilities consumed by the tuned Review surface.
 *
 * Keeping this boundary independent from the workspace sample gateway lets the
 * same presentation consume either the resettable fixture or a coherently
 * joined live Review projection. A live composition is eligible only when it
 * can provide every capability below without filling unknown facts.
 */
export interface ReviewPagePort {
	readonly viewer: ReviewPageViewer;
	readonly workspace: {
		/** Synchronous loading-shape evidence; null means it has not been read yet. */
		reviewPlanExpectedSnapshot(): boolean | null;
	};
	readonly vocab: {
		tracks(): Promise<Track[]>;
		formats(): Promise<Format[]>;
	};
	readonly submissions: {
		get(id: string): Promise<Submission | null>;
	};
	readonly review: {
		plans(): Promise<ReviewPlan[]>;
		roundSetup(): Promise<ReviewRoundSetup>;
		openRound(input: { deadlineIso: string; anonymized: boolean }): Promise<ReviewPlan>;
		discardRound(planId: string): Promise<MutationOutcome>;
		myQueue(): Promise<MyReviewItem[]>;
		saveReview(submissionId: string, score: number, comment: string): Promise<void>;
		commitReview(submissionId: string): Promise<MyReviewItem | null>;
		standing(submissionId: string): Promise<ScoreStanding | null>;
		standings(submissionIds: string[]): Promise<Record<string, ScoreStanding>>;
		amend(submissionId: string, score: number, comment: string): Promise<MyReviewItem | null>;
		revertAmend(submissionId: string): Promise<MyReviewItem | null>;
		comparables(submissionId: string, slice: 'track' | 'all'): Promise<ComparableCard[]>;
		accoladeDefs(): Promise<AccoladeDef[]>;
		pinAccolade(submissionId: string, key: AccoladeKey): Promise<MutationOutcome>;
		unpinAccolade(submissionId: string, key: AccoladeKey): Promise<MutationOutcome>;
		myScope(reviewerId: string): Promise<ScopeRef[]>;
		stepBack(submissionId: string, reviewerId: string): Promise<MutationOutcome>;
	};
	readonly speakers: {
		profile(email: string): Promise<SpeakerProfile | null>;
	};
	readonly tasks: {
		remind(reviewerIds: string[], subject: string): Promise<unknown>;
	};
	readonly schedule: {
		state(): Promise<ScheduleState>;
	};
}
