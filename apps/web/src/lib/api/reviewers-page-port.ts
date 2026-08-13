import type {
	Format,
	MutationOutcome,
	Reviewer,
	ReviewerInviteLine,
	ReviewerRoster,
	ScheduleState,
	ScopeRef,
	Track
} from './types';

/** Factual capabilities consumed by the tuned reviewer roster and scope editor. */
export interface ReviewersPagePort {
	readonly reviewers: {
		list(): Promise<ReviewerRoster>;
		invite(
			entries: { readonly email: string; readonly name?: string }[],
			scope?: ScopeRef[]
		): Promise<ReviewerInviteLine[]>;
		setScope(id: string, scope: ScopeRef[]): Promise<MutationOutcome>;
		restoreScope(id: string, scope: ScopeRef[]): Promise<void>;
		remove(id: string): Promise<MutationOutcome>;
		restore(reviewer: Reviewer, index: number): Promise<void>;
	};
	readonly vocab: {
		tracks(): Promise<Track[]>;
		formats(): Promise<Format[]>;
	};
	readonly schedule: {
		state(): Promise<ScheduleState>;
	};
}
