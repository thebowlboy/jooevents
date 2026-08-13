import type {
	DirectEntryInput,
	Format,
	ScoreStanding,
	SpeakerProfile,
	Submission,
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
	};
	readonly vocab: {
		tracks(): Promise<Track[]>;
		formats(): Promise<Format[]>;
		addTrack(name: string): Promise<Track>;
		addFormat(name: string): Promise<Format>;
	};
	readonly schedule: {
		collectingSessions(): Promise<readonly { readonly id: string; readonly title: string }[]>;
	};
}

