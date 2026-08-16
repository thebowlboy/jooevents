import type {
	WorkspaceOverviewArea,
	WorkspaceOverviewHistoryActor,
	WorkspaceOverviewHistoryDomain,
	WorkspaceOverviewHistoryThread,
	WorkspaceOverviewProjection
} from '@jooevents/contracts/workspace-overview';
import type { EventProgramPort } from './event-program/port';
import type { WorkspaceOverviewPort } from './operations/workspace-overview-live';
import { formatDateRange } from '@jooevents/contracts';
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

/**
 * A section whose projection does not exist yet says so as a fact, in the
 * active voice, and never claims a calm it cannot prove. The absence of an
 * attention projection is not evidence that nothing is waiting, so the copy
 * states that the watch is not running rather than reassuring anyone.
 */
const unavailableAttention = Object.freeze({
	kind: 'unavailable' as const,
	message: 'JooEvents does not yet watch this event for things that need you.'
});
const unavailableDeadlines = Object.freeze({
	kind: 'unavailable' as const,
	message: "JooEvents does not yet read this event's deadlines."
});
const unavailableTrays = Object.freeze({
	kind: 'unavailable' as const,
	message: "JooEvents does not yet count this event's holding areas."
});

/**
 * Deadlines begin at a form's closing date, so an event with no form at all
 * provably has none. That is a fact about the event, not a missing capability.
 */
const lockedDeadlines = Object.freeze({
	kind: 'locked' as const,
	condition: "Deadlines start with a form's closing date."
});

/**
 * `Comms` was an abbreviation, which the design system forbids on anything a
 * person reads as a control; this lane links to the area the sidebar labels
 * Communications, and `Messages` is the name that matches its route and area
 * key inside the label column's width.
 */
const stageDefinitions = Object.freeze([
	{ key: 'collect', label: 'Collect' },
	{ key: 'triage', label: 'Triage' },
	{ key: 'review', label: 'Review' },
	{ key: 'decide', label: 'Decide' },
	{ key: 'speakers', label: 'Speakers' },
	{ key: 'schedule', label: 'Schedule' },
	{ key: 'comms', label: 'Messages' }
] as const);

type StageKey = (typeof stageDefinitions)[number]['key'];

/** The area whose availability answers for each stage's capability wiring. */
const stageArea: Record<StageKey, WorkspaceOverviewArea> = {
	collect: 'forms',
	triage: 'submissions',
	review: 'review',
	decide: 'decisions',
	speakers: 'speakers',
	schedule: 'schedule',
	comms: 'messages'
};

/**
 * The sentences a stage owes while it is provably held: what turns it on,
 * stated as a fact about the mechanism rather than as a refusal. Every one is
 * shown only against the proof recorded beside it in `stageResolvers`, so a
 * lane can never claim a lock it has not established.
 */
const UNLOCK = Object.freeze({
	collect: 'Collecting starts when you open a form.',
	triage: 'The first submission to arrive lands here.',
	reviewRound: 'Reviewing starts when you open a round.',
	reviewAssignment: 'Reviewers start once submissions are assigned to them.',
	decide: 'Submissions get their answer here, once they arrive.',
	speakers: 'Speakers appear here once you invite someone.',
	schedule: 'Scheduling starts with the first session in the programme.',
	comms: 'Messages appear here once you send your first one.'
});

function plural(count: number, singular: string, many: string): string {
	return count === 1 ? singular : many;
}

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
		// Through the one date vocabulary, not assembled here: this used to join
		// two raw ISO dates with a dash, so a live workspace showed
		// `2027-03-18 – 2027-03-20` beside a sample one showing `18–20 Mar 2027`.
		dates: formatDateRange(projection.event.startDate, projection.event.endDate),
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
	const operations = projection.metrics.operations;
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
		operations.kind === 'exact'
			? {
					label: 'Changes',
					value: String(operations.total),
					sub: operations.total === 1 ? '1 recorded change' : `${operations.total} recorded changes`
				}
			: { label: 'Changes', value: '—', sub: metricUnavailableReason() }
	];
}

/**
 * A lane whose figure genuinely does not exist. The dash is the design
 * system's one sanctioned dash — *no measurement exists*, as opposed to a
 * measurement of zero — and the reason is said once by the surface rather than
 * once per lane, because a cause shared by every row is not a row's to state.
 * The message below is the one-lane spelling; the dashboard composes the same
 * sentence over several labels when more than one lane is uncounted.
 */
function notCountedStage(
	stage: (typeof stageDefinitions)[number]
): OverviewPipelineStage {
	return {
		...stage,
		headline: '\u2014',
		sub: '',
		state: 'unavailable',
		availability: {
			kind: 'unavailable',
			message: `JooEvents does not yet count ${stage.label} on this event.`
		}
	};
}

/** What a lane resolves to once its own metric has been read. */
type StageResolution = Omit<OverviewPipelineStage, 'key' | 'label'>;

/**
 * A lane the projection can *prove* has not begun. It carries no figure at
 * all: the dash was a refusal to say, and the unlock condition is the answer,
 * so there is nothing left to refuse. The sentence lives on `availability`
 * alone so it has exactly one source.
 */
function held(condition: string): StageResolution {
	return { headline: '', sub: '', state: 'unavailable', availability: { kind: 'locked', condition } };
}

/**
 * A running lane: its own figure, and the sentence that figure came out of.
 *
 * **No lane carries a meter, and that is deliberate.** A bar's whole job is the
 * tone — green healthy, amber needs attention — and a tone is a judgment
 * against a deadline. This projection carries no deadline of any kind, so every
 * bar would be painted the same colour whatever the fraction underneath it,
 * which is the double-encoding the bar rule exists to stop. The digits carry
 * the fraction in the sentence instead, where they claim nothing about health.
 * `state: 'ok'` here means only *running, nothing detected wrong*.
 */
function running(headline: string, sub: string): StageResolution {
	return { headline, sub, state: 'ok', availability: overviewAvailable };
}

/**
 * One resolver per lane, each reading **only that stage's own unit of work**.
 * `null` means the metric could not be read at all, which is the rare honest
 * absence rather than a fact about the event.
 *
 * The rule this preserves is the one the whole surface rests on: a lane goes
 * active only when the projection carries the stage's own work, and it goes
 * locked only against a proof. Every lane now has both, so on a projection that
 * answers, no lane can render a dash at all — `null` is reserved for a metric
 * that genuinely could not be read.
 */
const stageResolvers: Record<
	StageKey,
	(metrics: WorkspaceOverviewProjection['metrics']) => StageResolution | null
> = {
	collect: ({ forms }) => {
		if (forms.kind !== 'exact') return null;
		if (forms.open > 0) {
			return running(
				String(forms.open),
				`${forms.open} ${plural(forms.open, 'form is', 'forms are')} open to submissions`
			);
		}
		if (forms.closed > 0) {
			return running(
				String(forms.closed),
				`${forms.closed} ${plural(forms.closed, 'form is', 'forms are')} closed, none open`
			);
		}
		// Never opened: only drafts, or nothing at all.
		return held(UNLOCK.collect);
	},
	triage: ({ triage }) => {
		if (triage.kind !== 'exact') return null;
		if (triage.arrived === 0) return held(UNLOCK.triage);
		// The figure is the outstanding half, matching Decide: it is the count
		// the reader meets at the destination, whose default tray is the Inbox.
		const waiting = triage.arrived - triage.sorted;
		if (waiting === 0) return running(String(waiting), 'The inbox is clear');
		return running(
			String(waiting),
			`${waiting} of ${triage.arrived} submissions ${plural(waiting, 'is', 'are')} in the inbox`
		);
	},
	review: ({ reviews }) => {
		if (reviews.kind !== 'exact') return null;
		if (reviews.rounds === 0) return held(UNLOCK.reviewRound);
		// A round is open and nobody holds anything: reviewing has still not
		// begun, and the condition that starts it is a different one.
		if (reviews.assignments === 0) return held(UNLOCK.reviewAssignment);
		return running(
			String(reviews.committed),
			`${reviews.committed} of ${reviews.assignments} ${plural(reviews.assignments, 'review is', 'reviews are')} in`
		);
	},
	decide: ({ decisions }) => {
		if (decisions.kind !== 'exact') return null;
		const population = decisions.decided + decisions.undecided;
		if (population === 0) return held(UNLOCK.decide);
		if (decisions.undecided === 0) {
			return running(String(decisions.decided), 'Every submission has an answer');
		}
		return running(
			String(decisions.undecided),
			`${decisions.undecided} of ${population} submissions ${plural(decisions.undecided, 'is', 'are')} waiting for your answer`
		);
	},
	speakers: ({ engagements }) => {
		if (engagements.kind !== 'exact') return null;
		if (engagements.total === 0) return held(UNLOCK.speakers);
		return running(
			String(engagements.confirmed),
			`${engagements.confirmed} of ${engagements.total} ${plural(engagements.total, 'speaker has', 'speakers have')} confirmed`
		);
	},
	schedule: ({ sessions }) => {
		if (sessions.kind !== 'exact') return null;
		if (sessions.total === 0) return held(UNLOCK.schedule);
		if (sessions.placed === sessions.total) {
			return running(String(sessions.placed), 'Every session has a time and a room');
		}
		return running(
			String(sessions.placed),
			`${sessions.placed} of ${sessions.total} sessions ${plural(sessions.placed, 'has', 'have')} a time and a room`
		);
	},
	comms: ({ communications }) => {
		if (communications.kind !== 'exact') return null;
		if (communications.recipients === 0) return held(UNLOCK.comms);
		// `sent` is what the provider accepted, which is not the same claim as
		// "arrived" — the delivery ledger owns that, and this lane must not
		// promise a landing it cannot see.
		if (communications.sent === communications.recipients) {
			return running(String(communications.sent), 'Every message has been sent');
		}
		return running(
			String(communications.sent),
			`${communications.sent} of ${communications.recipients} messages ${plural(communications.sent, 'has', 'have')} been sent`
		);
	}
};

function areaStatus(
	projection: WorkspaceOverviewProjection,
	area: WorkspaceOverviewArea
): WorkspaceOverviewProjection['areas'][number]['status'] | undefined {
	return projection.areas.find((entry) => entry.area === area)?.status;
}

/**
 * Stage presentation, decided in one order per lane: an unwired area first,
 * because a capability that is not mounted is never a fact about the event;
 * then the stage's own metric, which answers running-or-held; then the honest
 * absence when that metric could not be read.
 */
function pipelineStages(projection: WorkspaceOverviewProjection): OverviewPipelineStage[] {
	return stageDefinitions.map((stage) => {
		if (areaStatus(projection, stageArea[stage.key]) === 'unavailable') {
			return notCountedStage(stage);
		}
		const resolved = stageResolvers[stage.key](projection.metrics);
		return resolved ? { ...stage, ...resolved } : notCountedStage(stage);
	});
}

function activityText(thread: WorkspaceOverviewHistoryThread): string {
	const subject = domainLabel[thread.domain];
	return `recorded activity in ${subject}`;
}

function historyActivity(threads: readonly WorkspaceOverviewHistoryThread[]): ActivityItem[] {
	return threads.map((thread) => {
		const primaryActor = thread.actors[0] ?? 'system';
		return {
			id: thread.id,
			actor: thread.actors.includes('agent') ? 'agent' as const : 'person' as const,
			name: thread.actors.length === 1 ? actorLabel[primaryActor] : 'Workspace collaborators',
			text: activityText(thread),
			// The instant, not a rendering of it. This port used to spell its own
			// distance vocabulary — `8 min ago`, `6 hr ago` — a seventeenth local
			// formatter beside the one the sample feed and the portal already use.
			at: thread.lastOccurredAt
		};
	});
}

/**
 * An event with no form at all provably carries no closing date, and a closing
 * date is the first deadline this catalog can hold. Anything else is an
 * absence of measurement rather than a fact about the event.
 */
function deadlinesSection(projection: WorkspaceOverviewProjection): OverviewSectionAvailability {
	const forms = projection.metrics.forms;
	return forms.kind === 'exact' && forms.total === 0 ? lockedDeadlines : unavailableDeadlines;
}

function lockedAreas(projection: WorkspaceOverviewProjection): AreaKey[] {
	return projection.areas
		.filter((entry) => entry.status === 'locked')
		.map((entry) => entry.area as AreaKey);
}

function mapLiveSummary(projection: WorkspaceOverviewProjection): OverviewPageSummary {
	const submissions = projection.metrics.submissions;
	const activity = historyActivity(projection.history.threads);
	return {
		event: eventInfo(projection.event),
		lockedAreas: lockedAreas(projection),
		navCounts: submissions.kind === 'exact' ? { submissions: String(submissions.total) } : {},
		// The arrival window needs per-submission instants and the operator's own
		// visit rotation; the overview projection carries neither yet, so the tile
		// stays absent rather than being fabricated from a total.
		arrivals: null,
		stats: stats(projection),
		attention: [],
		pipeline: pipelineStages(projection),
		deadlines: [],
		activity,
		trays: [],
		sections: {
			attention: unavailableAttention,
			// The lanes now state their own truth, so the section carries no
			// apology of its own.
			pipeline: overviewAvailable,
			deadlines: deadlinesSection(projection),
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
}): OverviewPagePort {
	let snapshot: OverviewPageSummary | null = null;
	let eventSetVersion: number | null = null;
	const port: OverviewPagePort = {
		source: Object.freeze({ kind: 'live' as const }),
		snapshot: () => snapshot,
		async read(options = {}) {
			const result = await input.overview.read(options);
			if (result.kind !== 'success') return readUnavailable(result);
			eventSetVersion = result.data.event.eventSetVersion;
			snapshot = mapLiveSummary(result.data);
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
