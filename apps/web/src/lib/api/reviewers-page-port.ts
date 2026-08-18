import type { ReminderPreview } from './tasks-page-port';
import type {
	EventTheme,
	Format,
	MutationOutcome,
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
		assignReplacement(input: {
			assignmentId: string;
			expectedAssignmentVersion: number;
			reviewerId: string;
		}): Promise<MutationOutcome>;
		acceptCoverage(input: {
			assignmentId: string;
			expectedAssignmentVersion: number;
		}): Promise<MutationOutcome>;
		remove(id: string): Promise<MutationOutcome>;
		restore(id: string): Promise<void>;
	};
	readonly vocab: {
		tracks(): Promise<Track[]>;
		formats(): Promise<Format[]>;
	};
	readonly schedule: {
		state(): Promise<ScheduleState>;
	};
	readonly tasks: {
		/**
		 * Whether this composition owns a reviewer-recipient send path. The
		 * absence is a served fact so the page can remove dead send controls before
		 * a person prepares a batch that cannot commit.
		 */
		readonly reminderAvailability:
			| { readonly kind: 'available' }
			| { readonly kind: 'unavailable'; readonly reason: string };
		remind(reviewerIds: string[], subject: string): Promise<unknown>;
		/**
		 * What a reminder actually sends, so the ceremony can show it first.
		 * Reviewer reminders ride the speaker-task reminder lane, so this is that
		 * lane's own copy — which is why the ceremony states whose words they are
		 * rather than implying they were written for reviewers.
		 *
		 * Optional: a composition that cannot answer shows no body, which is a
		 * visible gap rather than a false promise.
		 */
		reminderPreview?(): Promise<ReminderPreview>;
	};
	/** The event brand the rendered reminder is drawn in, where one is served. */
	readonly theme?: {
		get(): Promise<EventTheme>;
	};
}
