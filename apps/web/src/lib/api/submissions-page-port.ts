import type {
	DirectEntryInput,
	Format,
	ReviewRoundStatus,
	ScoreStanding,
	SpeakerProfile,
	Submission,
	SubmissionOrigin,
	SubmissionPage,
	SubmissionQuery,
	Track,
	TrayKey
} from './types';

export interface SubmissionTrayRestoreEntry {
	readonly id: string;
	readonly tray: TrayKey;
	readonly setAsideBy?: string;
}

export interface SubmissionsPagePort {
	readonly source: { readonly kind: 'sample' } | { readonly kind: 'live' };
	readonly submissions: {
		list(query?: SubmissionQuery): Promise<SubmissionPage>;
		addDirectEntry(input: DirectEntryInput): Promise<Submission>;
		removeDirectEntry(id: string): Promise<void>;
		setAside(ids: readonly string[]): Promise<void>;
		returnToInbox(ids: readonly string[]): Promise<void>;
		discard(ids: readonly string[]): Promise<void>;
		restore(ids: readonly string[]): Promise<void>;
		restoreTray(entries: readonly SubmissionTrayRestoreEntry[]): Promise<void>;
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

