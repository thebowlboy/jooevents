import type {
	DirectEntryInput,
	Format,
	ReviewRoundStatus,
	ScoreStanding,
	SpeakerProfile,
	Submission,
	SubmissionArrivals,
	SubmissionOrigin,
	SubmissionPage,
	SubmissionQuery,
	Track
} from './types';

/**
 * The arrival pulse as the submissions head states it: the measured pulse and
 * the event zone its calendar windows are claims about. One read, both facts —
 * a pulse without its zone cannot say whose midnight "today" means.
 */
export interface SubmissionArrivalsView {
	readonly arrivals: SubmissionArrivals;
	readonly timezone: string;
}

export interface SubmissionsPagePort {
	readonly source: { readonly kind: 'sample' } | { readonly kind: 'live' };
	readonly submissions: {
		list(query?: SubmissionQuery): Promise<SubmissionPage>;
		addDirectEntry(input: DirectEntryInput): Promise<Submission>;
		setAside(ids: readonly string[]): Promise<void>;
		returnToInbox(ids: readonly string[]): Promise<void>;
		markSpam(ids: readonly string[]): Promise<void>;
		notSpam(ids: readonly string[]): Promise<void>;
	};
	readonly speakers: {
		profile(email: string): Promise<SpeakerProfile | null>;
	};
	readonly review: {
		standings(submissionIds: readonly string[]): Promise<Record<string, ScoreStanding>>;
		/**
		 * The newest round's standing — the station groups' one review fact.
		 * Null while no round has ever been opened.
		 */
		round(): Promise<ReviewRoundStatus | null>;
	};
	readonly arrivals: {
		/**
		 * What is new, over a named window chosen from this operator's own
		 * rotation — the head's "is there anything to look at" answer, sharing
		 * the Overview tile's engine so the two surfaces cannot disagree about
		 * which day it is. Null where the source cannot measure it (no event
		 * zone, or a live workspace that does not yet record visits); the head
		 * then simply says nothing about newness rather than guessing.
		 */
		pulse(): Promise<SubmissionArrivalsView | null>;
	};
	readonly visits: {
		/**
		 * When this operator last entered this surface before the current
		 * visit — the New mark's since-your-last-visit arm. Read once at page
		 * entry and held for the visit, so nothing fades mid-look. Null on a
		 * first-ever visit. Only a human page entry ever rotates the underlying
		 * row; agent and MCP reads never count as the operator having seen
		 * anything.
		 */
		previous(): Promise<string | null>;
	};
	readonly vocab: {
		tracks(): Promise<Track[]>;
		formats(): Promise<Format[]>;
		addTrack(name: string): Promise<Track>;
		addFormat(name: string): Promise<Format>;
	};
	readonly schedule: {
		collectingSessions(): Promise<readonly { readonly id: string; readonly title: string }[]>;
		/**
		 * Where an accepted submission went — the session it became (spawn) or
		 * joined (attach), for the expansion's “where it landed” door. Null for
		 * rows that never graduated or whose graduation was reversed.
		 */
		originOf(submissionId: string): Promise<SubmissionOrigin | null>;
	};
	readonly forms: {
		/**
		 * How many forms are currently taking submissions. The empty inbox's
		 * one question — is a call for proposals open at all? — as a number, so
		 * the surface never hauls whole form summaries through this boundary.
		 */
		openCount(): Promise<number>;
	};
}
