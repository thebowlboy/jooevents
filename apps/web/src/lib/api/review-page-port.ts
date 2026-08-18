import type {
	AccoladeDef,
	AccoladeKey,
	ComparableCard,
	Format,
	MutationOutcome,
	MyReviewItem,
	ReviewPlan,
	ReviewRoundSetup,
	ReviewSubmissionDisplay,
	ScheduleState,
	ScopeRef,
	ScoreStanding,
	SpeakerProfile,
	Track
} from './types';

/** The authority projection the tuned Review surface renders under. */
export type ReviewPageViewer =
	| { readonly kind: 'organizer' }
	| { readonly kind: 'reviewer'; readonly reviewerId: string };

/** How far committed review has gone on one submission in the results view. */
export type ReviewResultStatus = 'unscored' | 'in_review' | 'scored';

/** One authorized scoring criterion the export may name. */
export interface ReviewResultCriterion {
	readonly key: string;
	readonly label: string;
	readonly value: number;
}

/**
 * One organizer result row. Standing and criterion values come from the same
 * authorized read; reviewer identity never belongs here.
 */
export interface ReviewResultRow {
	readonly submissionId: string;
	readonly title: string;
	readonly trackId?: string;
	readonly status: ReviewResultStatus;
	readonly reviews: number;
	readonly standing: ScoreStanding | null;
	readonly criteria: readonly ReviewResultCriterion[];
}

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
		get(id: string): Promise<ReviewSubmissionDisplay | null>;
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
		/** Organizer results over the current round, sorted by aggregate score. */
		results(): Promise<ReviewResultRow[]>;
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
		profiles?(requests: readonly {
			readonly key: string;
			readonly personId?: string;
			readonly email: string;
			readonly submissionCount: number;
		}[]): Promise<Record<string, SpeakerProfile | null>>;
	};
	readonly tasks: {
		remind(reviewerIds: string[], subject: string): Promise<unknown>;
	};
	readonly schedule: {
		state(): Promise<ScheduleState>;
	};
}
