import type { OverviewCreateEventInput } from './overview-page-port';
import type {
	AccountInfo,
	MutationOutcome,
	NavCounts,
	WorkspaceEventOption,
	WorkspaceSummary
} from './types';
import type { WorkspaceNavigationViewer } from '$lib/features/workspace/navigation';

export type WorkspaceShellSummary = Pick<
	WorkspaceSummary,
	'event' | 'lockedAreas' | 'navCounts'
>;

export type WorkspaceShellSummaryResult =
	| { readonly kind: 'success'; readonly data: WorkspaceShellSummary }
	| { readonly kind: 'unavailable'; readonly message: string };

export interface WorkspaceShellEventCollectionPort {
	list(): Promise<readonly WorkspaceEventOption[]>;
	switchEvent(id: string): Promise<MutationOutcome>;
	/** Present only when this composition can create another Event. */
	createEvent?: (input: OverviewCreateEventInput) => Promise<MutationOutcome>;
}

export interface WorkspaceShellAccountPort {
	current(): Promise<AccountInfo>;
	signOut(): Promise<{ readonly ok: boolean; readonly correlationId?: string }>;
	emailChange?: {
		request(newEmail: string): Promise<MutationOutcome>;
		resend(): Promise<MutationOutcome>;
		cancel(): Promise<MutationOutcome>;
	};
}

export type WorkspaceShellSource =
	| {
			readonly kind: 'sample';
			readonly scenario: {
				readonly key: string;
				readonly name: string;
				readonly description: string;
			};
	  }
	| { readonly kind: 'live' };

/**
 * The tuned workspace chrome's source-neutral boundary. A composition may omit
 * event collection or email-change capabilities; the shell then explains or
 * withholds those controls instead of borrowing behavior from another source.
 */
export interface WorkspaceShellPort {
	readonly source: WorkspaceShellSource;
	readonly viewer: WorkspaceNavigationViewer;
	readonly summary: {
		snapshot(): WorkspaceShellSummary | null;
		read(): Promise<WorkspaceShellSummaryResult>;
	};
	readonly account: WorkspaceShellAccountPort;
	readonly events?: WorkspaceShellEventCollectionPort;
	/** The first-Event action may exist even when multi-Event collection does not. */
	readonly createFirstEvent?: (input: OverviewCreateEventInput) => Promise<MutationOutcome>;
}

export function cloneWorkspaceShellSummary(summary: WorkspaceShellSummary): WorkspaceShellSummary {
	return {
		event: summary.event ? { ...summary.event } : null,
		lockedAreas: [...summary.lockedAreas],
		navCounts: cloneNavCounts(summary.navCounts)
	};
}

function cloneNavCounts(counts: NavCounts): NavCounts {
	return {
		...(counts.submissions ? { submissions: counts.submissions } : {}),
		...(counts.review ? { review: counts.review } : {}),
		...(counts.decisions ? { decisions: { ...counts.decisions } } : {}),
		...(counts.speakers ? { speakers: counts.speakers } : {}),
		...(counts.reviewers ? { reviewers: counts.reviewers } : {}),
		...(counts.tasks ? { tasks: { ...counts.tasks } } : {}),
		...(counts.schedule ? { schedule: { ...counts.schedule } } : {}),
		...(counts.messages ? { messages: counts.messages } : {}),
		...(counts.templates ? { templates: counts.templates } : {})
	};
}
