import { formatDateRange, type SafeUser } from '@jooevents/contracts';
import { signOut as signOutRequest } from './auth';
import type { OverviewPagePort } from './overview-page-port';
import type {
	EventLiveClient,
	EventLiveListResult,
	EventLiveSelectResult
} from './operations/event-live';
import type { WorkspaceShellSummaryLivePort } from './operations/workspace-shell-summary-live';
import type { MutationOutcome, WorkspaceEventOption } from './types';
import { WORKSPACE_OVERVIEW_AREAS } from '@jooevents/contracts/workspace-overview';
import type { AreaKey } from './types';
import {
	cloneWorkspaceShellSummary,
	type WorkspaceShellEventCollectionPort,
	type WorkspaceShellPort,
	type WorkspaceShellSummary,
	type WorkspaceShellSummaryResult
} from './workspace-shell-port';

function summaryUnavailable(
	result: Exclude<Awaited<ReturnType<WorkspaceShellSummaryLivePort['read']>>, {
		readonly kind: 'success';
	}>
): string {
	if (result.kind === 'unavailable') return 'The workspace summary is not available in this workspace.';
	if (result.kind === 'transport_error') {
		return result.error.retryable
			? 'The workspace summary could not be reached. Try again when the connection is back.'
			: 'The workspace summary response was not valid.';
	}
	return result.outcome.class === 'access_denied'
		? 'You no longer have permission to view this workspace.'
		: 'The workspace summary could not be loaded.';
}

/**
 * With no Event, every area is locked — and that is the whole of what `locked`
 * ever meant: the area catalog's only lock reason is `event_required`. So the
 * nameplate read can state it exactly, without the metric families it would
 * otherwise have waited on.
 */
const ALL_AREAS: readonly AreaKey[] = Object.freeze(
	WORKSPACE_OVERVIEW_AREAS.filter((area) => area !== 'overview') as readonly AreaKey[]
);

function shellSummary(
	projection: Awaited<ReturnType<WorkspaceShellSummaryLivePort['read']>> & { readonly kind: 'success' },
	counts: WorkspaceShellSummary | null
): WorkspaceShellSummary {
	const event = projection.data.event;
	return {
		event: event
			? {
					id: event.id,
					name: event.name,
					// Through the one date vocabulary, exactly as the overview spells it,
					// so the nameplate never disagrees with the dashboard beneath it.
					dates: formatDateRange(event.startDate, event.endDate),
					location: '',
					timezone: event.timezone,
					phase: '',
					today: ''
				}
			: null,
		lockedAreas: event ? [] : [...ALL_AREAS],
		// Counts are the expensive half and belong to the overview read. Where one
		// has already resolved, its counts ride along for free; where none has,
		// the rail simply carries no count rather than making identity wait.
		navCounts: counts?.navCounts ?? {}
	};
}

function eventOptions(projection: EventListResultData): WorkspaceEventOption[] {
	return projection.events.map((event) => ({
		id: event.id,
		name: event.name,
		dates: formatDateRange(event.startDate, event.endDate),
		location: '',
		// Live events are not scenarios; the id is the only handle a switch needs.
		scenarioKey: '',
		current: event.id === projection.currentEventId
	}));
}

type EventListResultData = Extract<EventLiveListResult, { readonly kind: 'success' }>['data'];

function listFailure(
	result: Exclude<EventLiveListResult, { readonly kind: 'success' }>
): string {
	if (result.kind === 'unavailable') return 'The event list is not available in this workspace.';
	if (result.kind === 'transport_error') {
		return result.error.retryable
			? 'The event list could not be reached. Try again.'
			: 'The event list response was not valid.';
	}
	return result.outcome.class === 'access_denied'
		? 'You no longer have permission to see this workspace’s events.'
		: 'The event list could not be loaded.';
}

function selectFailure(
	result: Exclude<EventLiveSelectResult, { readonly kind: 'success' }>
): string {
	if (result.kind === 'unavailable') return 'Switching events is not available in this workspace.';
	if (result.kind === 'transport_error') {
		return result.error.retryable
			? 'JooEvents could not be reached. Try again when the connection is back.'
			: 'This event switch is not valid.';
	}
	if (result.outcome.class === 'stale_revision' || result.outcome.class === 'conflict') {
		return 'The workspace’s events changed while you were looking. Reload and try again.';
	}
	return result.outcome.class === 'access_denied'
		? 'You no longer have permission to open this event.'
		: 'This event could not be opened.';
}

/**
 * The shell's event collection over the live selection operations.
 *
 * `list` carries the served `currentEventId` rather than guessing from the
 * nameplate: "current" is a server-resolved fact, and two reads that disagree
 * would put a tick beside the wrong row.
 */
export function createLiveWorkspaceEventCollection(input: {
	readonly events: EventLiveClient;
	readonly createEvent?: WorkspaceShellEventCollectionPort['createEvent'];
	readonly newAttemptKey?: () => string;
}): WorkspaceShellEventCollectionPort {
	const attemptKey = input.newAttemptKey
		?? (() => `je.event.select.${globalThis.crypto.randomUUID()}`);
	return Object.freeze({
		async list(): Promise<readonly WorkspaceEventOption[]> {
			const result = await input.events.list();
			// The shell renders an unresolved collection rather than a wrong one,
			// so a failed read throws for its typed loading state to catch.
			if (result.kind !== 'success') throw new Error(listFailure(result));
			return eventOptions(result.data);
		},
		async switchEvent(id: string): Promise<MutationOutcome> {
			const listed = await input.events.list();
			if (listed.kind !== 'success') return { ok: false, reason: listFailure(listed) };
			const result = await input.events.select(
				{ eventId: id, expectedEventSetVersion: listed.data.eventSetVersion },
				{ idempotencyKey: attemptKey() }
			);
			return result.kind === 'success' ? { ok: true } : { ok: false, reason: selectFailure(result) };
		},
		...(input.createEvent ? { createEvent: input.createEvent } : {})
	});
}

export function createLiveWorkspaceShellPort(input: {
	readonly user: SafeUser;
	readonly overview: OverviewPagePort;
	/**
	 * The nameplate's own read. Optional on the same terms as `events` below:
	 * a composition that cannot serve it falls back to the overview wrapper —
	 * correct, just slower — rather than the shell inventing an identity it
	 * does not have.
	 */
	readonly shellSummary?: WorkspaceShellSummaryLivePort;
	readonly events?: WorkspaceShellEventCollectionPort;
}): WorkspaceShellPort {
	if (input.overview.source.kind !== 'live') throw new TypeError('live_workspace_shell_source_required');
	if (input.shellSummary && input.shellSummary.source.kind !== 'live') {
		throw new TypeError('live_workspace_shell_source_required');
	}
	const fastSummary = input.shellSummary;

	/** Whatever the dashboard has already fetched — never a reason to wait. */
	function knownCounts(): WorkspaceShellSummary | null {
		const snapshot = input.overview.snapshot();
		return snapshot ? cloneWorkspaceShellSummary(snapshot) : null;
	}

	/** The pre-fast-read path: identity arrives with the metrics behind it. */
	async function overviewSummary(): Promise<WorkspaceShellSummaryResult> {
		const result = await input.overview.read();
		if (result.kind === 'success') {
			return { kind: 'success', data: cloneWorkspaceShellSummary(result.data) };
		}
		return {
			kind: 'unavailable',
			message: result.kind === 'unavailable'
				? result.message
				: result.retryable
					? 'The workspace summary could not be reached. Try again when the connection is back.'
					: 'The workspace summary response was not valid.'
		};
	}

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),
		// The currently mounted live C0 workspace is the organizer operation lane.
		// Server operations still evaluate every exact permission independently.
		viewer: Object.freeze({ kind: 'organizer' as const }),
		summary: Object.freeze({
			// Still the overview's snapshot: it is the richest thing already in
			// hand, and a snapshot exists only to choose truthful first-paint
			// geometry — it never issues a request, so it costs nothing to prefer.
			snapshot: knownCounts,
			async read(): Promise<WorkspaceShellSummaryResult> {
				if (!fastSummary) return overviewSummary();
				const result = await fastSummary.read();
				return result.kind === 'success'
					? { kind: 'success', data: shellSummary(result, knownCounts()) }
					: { kind: 'unavailable', message: summaryUnavailable(result) };
			},
			// The nameplate stays fast. Badge metrics take the richer registered
			// Overview read independently and may settle after the shell is usable.
			refreshCounts: overviewSummary
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
		...(input.events ? { events: input.events } : {}),
		createFirstEvent: input.overview.createEvent
	});
}
