import type { SafeUser } from '@jooevents/contracts';
import { signOut as signOutRequest } from './auth';
import type { OverviewPagePort } from './overview-page-port';
import {
	cloneWorkspaceShellSummary,
	type WorkspaceShellPort,
	type WorkspaceShellSummaryResult
} from './workspace-shell-port';

function unavailableMessage(result: Exclude<Awaited<ReturnType<OverviewPagePort['read']>>, {
	readonly kind: 'success';
}>): string {
	if (result.kind === 'unavailable') return result.message;
	return result.retryable
		? 'The workspace summary could not be reached. Try again when the connection is back.'
		: 'The workspace summary response was not valid.';
}

export function createLiveWorkspaceShellPort(input: {
	readonly user: SafeUser;
	readonly overview: OverviewPagePort;
}): WorkspaceShellPort {
	if (input.overview.source.kind !== 'live') throw new TypeError('live_workspace_shell_source_required');

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),
		// The currently mounted live C0 workspace is the organizer operation lane.
		// Server operations still evaluate every exact permission independently.
		viewer: Object.freeze({ kind: 'organizer' as const }),
		summary: Object.freeze({
			snapshot() {
				const snapshot = input.overview.snapshot();
				return snapshot ? cloneWorkspaceShellSummary(snapshot) : null;
			},
			async read(): Promise<WorkspaceShellSummaryResult> {
				const result = await input.overview.read();
				return result.kind === 'success'
					? { kind: 'success', data: cloneWorkspaceShellSummary(result.data) }
					: { kind: 'unavailable', message: unavailableMessage(result) };
			}
		}),
		account: Object.freeze({
			async current() {
				return {
					name: input.user.displayName,
					email: input.user.primaryEmail ?? '',
					pendingEmailChange: null
				};
			},
			async signOut() {
				const result = await signOutRequest();
				if (result.kind === 'success') return { ok: true as const };
				return {
					ok: false as const,
					...(result.error.correlationId
						? { correlationId: result.error.correlationId }
						: {})
				};
			}
		}),
		createFirstEvent: input.overview.createEvent
	});
}
