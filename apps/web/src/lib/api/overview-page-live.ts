import type {
	WorkspaceOverviewHistoryActor,
	WorkspaceOverviewHistoryDomain,
	WorkspaceOverviewHistoryThread,
	WorkspaceOverviewProjection
} from '@jooevents/contracts/workspace-overview';
import type { EventProgramPort } from './event-program/port';
import type { WorkspaceOverviewPort } from './operations/workspace-overview-live';
import type {
	ActivityItem,
	AreaKey,
	EventInfo,
	MutationOutcome,
	StatItem
} from './types';
import {
	overviewAvailable,
	type OverviewPagePort,
	type OverviewPageSummary,
	type OverviewPipelineStage,
	type OverviewSectionAvailability
} from './overview-page-port';

const unavailableAttention = Object.freeze({
	kind: 'unavailable' as const,
	message: 'Attention signals are not available yet.'
});
const unavailablePipeline = Object.freeze({
	kind: 'unavailable' as const,
	message: 'Event-stage progress is not available yet.'
});
const unavailableDeadlines = Object.freeze({
	kind: 'unavailable' as const,
	message: 'Event deadlines are not available yet.'
});
const unavailableTrays = Object.freeze({
	kind: 'unavailable' as const,
	message: 'Holding-place counts are not available yet.'
});

const stageDefinitions = Object.freeze([
	{ key: 'collect', label: 'Collect' },
	{ key: 'triage', label: 'Triage' },
	{ key: 'review', label: 'Review' },
	{ key: 'decide', label: 'Decide' },
	{ key: 'speakers', label: 'Speakers' },
	{ key: 'schedule', label: 'Schedule' },
	{ key: 'comms', label: 'Comms' }
] as const);

const domainLabel: Record<WorkspaceOverviewHistoryDomain, string> = {
	event: 'event setup',
	field_registry: 'collected fields',
	forms: 'forms',
	program_vocabulary: 'program vocabulary',
	submission_triage: 'submission triage',
	workspace_team: 'the workspace team'
};

const actorLabel: Record<WorkspaceOverviewHistoryActor, string> = {
	person: 'An organizer',
	agent: 'An agent',
	participant: 'A participant',
	system: 'JooEvents',
	integration: 'An integration'
};

function metricUnavailableReason(): string {
	return 'This number is not available yet.';
}

function eventInfo(projection: WorkspaceOverviewProjection['event']): EventInfo | null {
	if (projection.kind === 'no_event') return null;
	return {
		id: projection.event.id,
		name: projection.event.name,
		dates: projection.event.startDate === projection.event.endDate
			? projection.event.startDate
			: `${projection.event.startDate} – ${projection.event.endDate}`,
		location: '',
		timezone: projection.event.timezone,
		phase: '',
		today: ''
	};
}

function stats(projection: WorkspaceOverviewProjection): StatItem[] {
	const forms = projection.metrics.forms;
	const submissions = projection.metrics.submissions;
	const vocabulary = projection.metrics.programVocabulary;
	const changesets = projection.metrics.changesets;
	return [
		forms.kind === 'exact'
			? {
					label: 'Forms',
					value: String(forms.total),
					sub: `${forms.open} open · ${forms.draft} draft · ${forms.closed} closed`
				}
			: { label: 'Forms', value: '—', sub: metricUnavailableReason() },
		submissions.kind === 'exact'
			? {
					label: 'Submissions',
					value: String(submissions.total),
					sub: submissions.total === 1 ? '1 recorded submission' : `${submissions.total} recorded submissions`
				}
			: { label: 'Submissions', value: '—', sub: metricUnavailableReason() },
		vocabulary.kind === 'exact'
			? (() => {
					const total = vocabulary.rooms.total + vocabulary.tracks.total + vocabulary.formats.total;
					const active = vocabulary.rooms.active + vocabulary.tracks.active + vocabulary.formats.active;
					const retired = vocabulary.rooms.retired + vocabulary.tracks.retired + vocabulary.formats.retired;
					return {
						label: 'Program vocabulary',
						value: String(total),
						sub: `${active} active · ${retired} retired`
					};
				})()
			: { label: 'Program vocabulary', value: '—', sub: metricUnavailableReason() },
		changesets.kind === 'exact'
			? {
					label: 'Changes',
					value: String(changesets.total),
					sub: `${changesets.committed} committed · ${changesets.draft + changesets.proposed} in progress`
				}
			: { label: 'Changes', value: '—', sub: metricUnavailableReason() }
	];
}

function unavailableStages(): OverviewPipelineStage[] {
	return stageDefinitions.map((stage) => ({
		...stage,
		headline: '—',
		sub: unavailablePipeline.message,
		state: 'unavailable' as const,
		availability: unavailablePipeline
	}));
}

function elapsedLabel(occurredAt: string, nowMs: number): string {
	const elapsed = Math.max(0, nowMs - Date.parse(occurredAt));
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} hr ago`;
	const days = Math.floor(hours / 24);
	return days === 1 ? '1 day ago' : `${days} days ago`;
}

function activityText(thread: WorkspaceOverviewHistoryThread): string {
	const subject = domainLabel[thread.domain];
	if (thread.root.kind === 'operation') return `recorded activity in ${subject}`;
	switch (thread.root.status) {
		case 'draft': return `prepared changes to ${subject}`;
		case 'proposed': return `submitted changes to ${subject}`;
		case 'committed': return `committed changes to ${subject}`;
		case 'discarded': return `discarded a change draft for ${subject}`;
	}
}

function historyActivity(
	threads: readonly WorkspaceOverviewHistoryThread[],
	nowMs: number
): ActivityItem[] {
	return threads.map((thread) => {
		const primaryActor = thread.actors[0] ?? 'system';
		return {
			id: thread.id,
			actor: thread.actors.includes('agent') ? 'agent' as const : 'person' as const,
			name: thread.actors.length === 1 ? actorLabel[primaryActor] : 'Workspace collaborators',
			text: activityText(thread),
			time: elapsedLabel(thread.lastOccurredAt, nowMs)
		};
	});
}

function lockedAreas(projection: WorkspaceOverviewProjection): AreaKey[] {
	return projection.areas
		.filter((entry) => entry.status === 'locked')
		.map((entry) => entry.area as AreaKey);
}

function mapLiveSummary(projection: WorkspaceOverviewProjection, nowMs: number): OverviewPageSummary {
	const submissions = projection.metrics.submissions;
	const activity = historyActivity(projection.history.threads, nowMs);
	return {
		event: eventInfo(projection.event),
		lockedAreas: lockedAreas(projection),
		navCounts: submissions.kind === 'exact' ? { submissions: String(submissions.total) } : {},
		stats: stats(projection),
		attention: [],
		pipeline: unavailableStages(),
		deadlines: [],
		activity,
		trays: [],
		sections: {
			attention: unavailableAttention,
			pipeline: unavailablePipeline,
			deadlines: unavailableDeadlines,
			activity: overviewAvailable,
			trays: unavailableTrays
		}
	};
}

function readUnavailable(result: Exclude<Awaited<ReturnType<WorkspaceOverviewPort['read']>>, {
	readonly kind: 'success';
}>): Exclude<Awaited<ReturnType<OverviewPagePort['read']>>, { readonly kind: 'success' }> {
	if (result.kind === 'transport_error') {
		return {
			kind: 'transport_error',
			retryable: result.error.retryable,
			...(result.error.correlationId ? { correlationId: result.error.correlationId } : {})
		};
	}
	if (result.kind === 'unavailable') {
		return { kind: 'unavailable', message: 'Overview is not available in this workspace.' };
	}
	return {
		kind: 'unavailable',
		message: result.outcome.class === 'access_denied'
			? 'You no longer have permission to view this workspace.'
			: 'The workspace overview could not be loaded.',
		correlationId: result.correlationId
	};
}

function createFailure(
	result: Exclude<Awaited<ReturnType<EventProgramPort['event']['create']>>, { readonly kind: 'success' }>
): MutationOutcome {
	if (result.kind === 'unavailable') {
		return { ok: false, reason: 'Event setup is not available in this workspace.' };
	}
	if (result.kind === 'transport_error') {
		return {
			ok: false,
			reason: result.error.retryable
				? 'JooEvents could not be reached. Try again when the connection is back.'
				: 'Event setup could not be completed.'
		};
	}
	if (result.outcome.class === 'stale_revision') {
		return { ok: false, reason: 'This workspace changed. Reload before trying again.' };
	}
	if (result.outcome.class === 'access_denied') {
		return { ok: false, reason: 'You no longer have permission to create an event.' };
	}
	return { ok: false, reason: 'JooEvents could not create this event.' };
}

export function createLiveOverviewPagePort(input: {
	readonly overview: WorkspaceOverviewPort;
	readonly event: EventProgramPort['event'];
	readonly now?: () => number;
}): OverviewPagePort {
	let snapshot: OverviewPageSummary | null = null;
	let eventSetVersion: number | null = null;
	const now = input.now ?? Date.now;
	const port: OverviewPagePort = {
		source: Object.freeze({ kind: 'live' as const }),
		snapshot: () => snapshot,
		async read(options = {}) {
			const result = await input.overview.read(options);
			if (result.kind !== 'success') return readUnavailable(result);
			eventSetVersion = result.data.event.eventSetVersion;
			snapshot = mapLiveSummary(result.data, now());
			return { kind: 'success' as const, data: snapshot };
		},
		async createEvent(event) {
			if (eventSetVersion === null) {
				return { ok: false, reason: 'Reload the overview before creating an event.' };
			}
			const result = await input.event.create({
				expectedEventSetVersion: eventSetVersion,
				name: event.name,
				timezone: event.timezone,
				startDate: event.startDate,
				endDate: event.endDate
			}, { idempotencyKey: event.idempotencyKey });
			const outcome: MutationOutcome = result.kind === 'success'
				? { ok: true }
				: createFailure(result);
			return outcome;
		}
	};
	return Object.freeze(port);
}
