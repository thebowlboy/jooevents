import type {
	WorkspaceOverviewArea,
	WorkspaceOverviewHistoryActor,
	WorkspaceOverviewHistoryDomain,
	WorkspaceOverviewHistoryThread,
	WorkspaceOverviewProjection
} from '@jooevents/contracts/workspace-overview';
import type { CommunicationsReadinessPagePort } from './communications-readiness-page-port';
import type { EventProgramPort } from './event-program/port';
import type { DeadlineCatalogLivePort } from './operations/deadline-catalog-live';
import type { TaskLiveClient } from './operations/tasks-live';
import type { WorkspaceOverviewPort } from './operations/workspace-overview-live';
import { EMAIL_READINESS_CURRENCY_REASON_CODES, formatDateRange } from '@jooevents/contracts';
import type {
	ActivityItem,
	AreaKey,
	AttentionItem,
	DeadlineItem,
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
import { pipelineStageMeta } from './pipeline-stages';

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
 * Stage order and names come from the one pipeline model, so a lane cannot
 * spell its label differently from the rail drawn above it.
 */
const stageDefinitions = pipelineStageMeta.map(({ key, label }) => ({ key, label }));

type StageKey = (typeof pipelineStageMeta)[number]['key'];

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
const stageUnlock = new Map(pipelineStageMeta.map((stage) => [stage.key, stage.unlock]));
const UNLOCK = Object.freeze({
	collect: stageUnlock.get('collect')!,
	triage: stageUnlock.get('triage')!,
	reviewRound: stageUnlock.get('review')!,
	// The round exists but nobody holds anything yet — a second, narrower lock
	// the shared model's one not-started sentence cannot carry.
	reviewAssignment: 'Reviewers start once submissions are assigned to them.',
	decide: stageUnlock.get('decide')!,
	speakers: stageUnlock.get('speakers')!,
	schedule: stageUnlock.get('schedule')!,
	comms: stageUnlock.get('comms')!
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
	// A running lane's figure is said once: the headline leads and the sentence
	// finishes it — "3" + "of 20 submissions are in the inbox" — never the same
	// number as a figure and again inside its own sentence.
	collect: ({ forms }) => {
		if (forms.kind !== 'exact') return null;
		if (forms.open > 0) {
			return running(
				String(forms.open),
				`${plural(forms.open, 'form is', 'forms are')} open to submissions`
			);
		}
		if (forms.closed > 0) {
			return running(
				String(forms.closed),
				`${plural(forms.closed, 'form is', 'forms are')} closed, none open`
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
			`of ${triage.arrived} submissions ${plural(waiting, 'is', 'are')} in the inbox`
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
			`of ${reviews.assignments} ${plural(reviews.assignments, 'review is', 'reviews are')} in`
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
			`of ${population} submissions ${plural(decisions.undecided, 'is', 'are')} waiting for your answer`
		);
	},
	speakers: ({ engagements }) => {
		if (engagements.kind !== 'exact') return null;
		if (engagements.total === 0) return held(UNLOCK.speakers);
		return running(
			String(engagements.confirmed),
			`of ${engagements.total} ${plural(engagements.total, 'speaker has', 'speakers have')} confirmed`
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
			`of ${sessions.total} sessions ${plural(sessions.placed, 'has', 'have')} a time and a room`
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
			`of ${communications.recipients} messages ${plural(communications.sent, 'has', 'have')} been sent`
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

const deadlineLabel = Object.freeze({
	cfp_close: 'CFP closes',
	review_due: 'Reviews due',
	task_due: 'Task due'
});

interface DeadlineRead {
	readonly items: DeadlineItem[];
	readonly available: boolean;
}

async function readDeadlines(
	deadlines: Pick<DeadlineCatalogLivePort, 'read'> | undefined,
	tasks: Pick<TaskLiveClient, 'readBoard'> | undefined,
	options: { readonly signal?: AbortSignal }
): Promise<DeadlineRead> {
	if (deadlines === undefined) return { items: [], available: false };
	try {
		const [result, taskResult] = await Promise.all([
			deadlines.read(options),
			tasks?.readBoard(options).catch(() => null) ?? null
		]);
		if (result.kind !== 'success') return { items: [], available: false };
		const taskLabels = new Map<string, string>();
		if (taskResult?.kind === 'success') {
			for (const definition of taskResult.data.definitions) {
				taskLabels.set(
					definition.current.deadline.reference.id,
					definition.current.name
				);
			}
		}
		return {
			available: true,
			items: result.data.deadlines
				.filter((deadline) => deadline.status === 'active')
				.map((deadline) => ({
					label: deadline.kind === 'task_due'
						? (taskLabels.get(deadline.id) ?? deadlineLabel.task_due)
						: deadlineLabel[deadline.kind],
					displayDate: deadline.displayDate,
					effectiveAt: deadline.effectiveAt
				}))
				.sort((left, right) => left.effectiveAt.localeCompare(right.effectiveAt))
		};
	} catch {
		return { items: [], available: false };
	}
}

function lockedAreas(projection: WorkspaceOverviewProjection): AreaKey[] {
	return projection.areas
		.filter((entry) => entry.status === 'locked')
		.map((entry) => entry.area as AreaKey);
}

/**
 * The one live attention row this port derives itself: email setup. The
 * readiness read is workspace truth the overview projection does not carry
 * yet, and its absence — a failed or missing read — yields no row rather than
 * a fabricated calm. Severity stays `soon` for now: escalating to `now`
 * belongs to a blocked-send count this surface cannot read yet.
 */
interface AttentionRead {
	readonly items: AttentionItem[];
	readonly checked: boolean;
}

async function emailSetupAttention(
	readiness: Pick<CommunicationsReadinessPagePort, 'read'> | undefined,
	options: { readonly signal?: AbortSignal }
): Promise<AttentionRead> {
	if (readiness === undefined) return { items: [], checked: false };
	try {
		const result = await readiness.read(options);
		if (result.kind !== 'success') return { items: [], checked: false };
		const outbound = result.data.outbound;
		if (outbound.state === 'ready') return { items: [], checked: true };
		// Passed readiness evidence expires within minutes by design, so a
		// healthy configured install spends most of its life at "expired" or
		// "not checked yet". That is evidence currency, not a setup defect, and
		// a permanent row would teach people to ignore this panel; the
		// Communications and Settings surfaces still show it. The set is the
		// contract's, shared with the Settings panel making the same call.
		if (
			outbound.state === 'action_required'
			&& (EMAIL_READINESS_CURRENCY_REASON_CODES as readonly string[]).includes(outbound.reasonCode)
		) {
			return { items: [], checked: true };
		}
		// Two different facts, two different sentences: no provider at all
		// (`unknown`) versus a configured provider that is not ready to send.
		// One title for both had this row claiming "not set up" while the
		// Settings panel said the connection exists — two diagnoses of one fact.
		const configured = outbound.state !== 'unknown';
		return { checked: true, items: [{
			id: 'email-setup',
			severity: 'soon',
			area: 'settings',
			title: configured ? 'Email sending needs attention' : 'Email is not set up',
			detail: configured
				? 'An email provider is connected but not ready to send. Sign-in links, invitations, and decisions wait until it is.'
				: 'Sign-in links, invitations, and decisions cannot be emailed until outbound email is configured and verified.',
			action: configured ? 'Open email settings' : 'Finish email setup',
			href: '/app/settings/email'
		}] };
	} catch {
		return { items: [], checked: false };
	}
}

/**
 * Attention facts already present in the canonical Overview projection. These
 * are counts of the exact queues the destination opens, not guesses from a
 * neighbouring total.
 */
function workflowAttention(projection: WorkspaceOverviewProjection): AttentionRead {
	const items: AttentionItem[] = [];
	let checked = false;
	if (areaStatus(projection, 'submissions') !== 'unavailable'
		&& projection.metrics.triage.kind === 'exact') {
		checked = true;
		const waiting = projection.metrics.triage.arrived - projection.metrics.triage.sorted;
		if (waiting > 0) {
			items.push({
				id: 'submissions-inbox',
				severity: 'soon',
				area: 'submissions',
				title: `${waiting} ${plural(waiting, 'submission needs', 'submissions need')} triage`,
				detail: `${plural(waiting, 'It has', 'They have')} arrived but ${plural(waiting, 'has', 'have')} not been sorted yet.`,
				action: 'Open submissions'
			});
		}
	}
	if (areaStatus(projection, 'decisions') !== 'unavailable'
		&& projection.metrics.decisions.kind === 'exact') {
		checked = true;
		const waiting = projection.metrics.decisions.undecided;
		if (waiting > 0) {
			items.push({
				id: 'undecided-submissions',
				severity: 'soon',
				area: 'decisions',
				title: `${waiting} ${plural(waiting, 'submission is', 'submissions are')} waiting for your answer`,
				detail: `${plural(waiting, 'It has', 'They have')} not received an accept or reject decision yet.`,
				action: 'Open decision board'
			});
		}
	}
	const attention = projection.metrics.attention;
	if (attention?.kind === 'exact') {
		checked = true;
		if (attention.resultsNotSent > 0) {
			const count = attention.resultsNotSent;
			items.push({
				id: 'decision-results-not-sent', severity: 'now', area: 'decisions',
				title: `${count} ${plural(count, 'result has', 'results have')} not been sent`,
				detail: `${plural(count, 'Its', 'Their')} current accept or decline decision has no provider-accepted notification.`,
				action: 'Send results'
			});
		}
		if (attention.overdueSpeakerTasks > 0) {
			const count = attention.overdueSpeakerTasks;
			items.push({
				id: 'overdue-speaker-tasks', severity: 'now', area: 'tasks',
				title: `${count} speaker ${plural(count, 'task is', 'tasks are')} overdue`,
				detail: `${plural(count, 'It is', 'They are')} still waiting for completion or organizer review after the effective due time.`,
				action: 'Open tasks'
			});
		}
		if (attention.uncoveredReviews > 0) {
			const count = attention.uncoveredReviews;
			items.push({
				id: 'uncovered-reviews', severity: 'now', area: 'review',
				title: `${count} ${plural(count, 'review needs', 'reviews need')} coverage`,
				detail: `${plural(count, 'A reviewer has', 'Reviewers have')} stepped back and ${plural(count, 'the vacancy has', 'those vacancies have')} not been resolved.`,
				action: 'Resolve coverage'
			});
		}
		if (attention.sessionsAwaitingPlacement > 0) {
			const count = attention.sessionsAwaitingPlacement;
			items.push({
				id: 'sessions-awaiting-placement', severity: 'soon', area: 'schedule',
				title: `${count} ${plural(count, 'session is', 'sessions are')} awaiting placement`,
				detail: `${plural(count, 'It has', 'They have')} no current time-and-room occurrence.`,
				action: 'Open schedule'
			});
		}
		if (attention.sessionsMissingSpeakers > 0) {
			const count = attention.sessionsMissingSpeakers;
			items.push({
				id: 'sessions-missing-speakers', severity: 'soon', area: 'schedule',
				title: `${count} ${plural(count, 'session is', 'sessions are')} missing speakers`,
				detail: `${plural(count, 'Its', 'Their')} current Session roster has no participants.`,
				action: 'Add speakers'
			});
		}
		if (attention.failedDeliveries > 0) {
			const count = attention.failedDeliveries;
			items.push({
				id: 'failed-deliveries', severity: 'now', area: 'messages',
				title: `${count} message ${plural(count, 'delivery needs', 'deliveries need')} attention`,
				detail: `${plural(count, 'It has', 'They have')} current provider or delivery evidence recording a known failure.`,
				action: 'Open messages'
			});
		}
	}
	return { items, checked };
}

function mapLiveSummary(
	projection: WorkspaceOverviewProjection,
	attention: AttentionRead,
	deadlines: DeadlineRead
): OverviewPageSummary {
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
		attention: attention.items,
		pipeline: pipelineStages(projection),
		deadlines: deadlines.items,
		activity,
		trays: [],
		sections: {
			// A checked source can prove the bounded calm rendered by the panel;
			// without one, absence of rows remains an absence of measurement.
			attention: attention.checked ? overviewAvailable : unavailableAttention,
			// The lanes now state their own truth, so the section carries no
			// apology of its own.
			pipeline: overviewAvailable,
			deadlines: deadlines.available ? overviewAvailable : deadlinesSection(projection),
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
	readonly readiness?: Pick<CommunicationsReadinessPagePort, 'read'>;
	readonly deadlines?: Pick<DeadlineCatalogLivePort, 'read'>;
	readonly tasks?: Pick<TaskLiveClient, 'readBoard'>;
}): OverviewPagePort {
	let snapshot: OverviewPageSummary | null = null;
	let eventSetVersion: number | null = null;
	const port: OverviewPagePort = {
		source: Object.freeze({ kind: 'live' as const }),
		snapshot: () => snapshot,
		async read(options = {}) {
			const [result, emailAttention, deadlines] = await Promise.all([
				input.overview.read(options),
				emailSetupAttention(input.readiness, options),
				readDeadlines(input.deadlines, input.tasks, options)
			]);
			if (result.kind !== 'success') return readUnavailable(result);
			eventSetVersion = result.data.event.eventSetVersion;
			const workflow = workflowAttention(result.data);
			snapshot = mapLiveSummary(result.data, {
				checked: workflow.checked || emailAttention.checked,
				items: [...workflow.items, ...emailAttention.items]
			}, deadlines);
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
