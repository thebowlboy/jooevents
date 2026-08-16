import {
	DECISION_DECIDE_ROWS_MAX,
	OPERATION_HISTORY_SCHEMA_REFS,
	formatDateRange,
	operationHistoryListInputSchema,
	operationHistoryListResultSchema,
	startOfZonedWeek,
	type DecisionStateSnapshotDto,
	type OperationHistoryEntry,
	type OperationHistoryListInput,
	type OperationHistoryPage,
	type StructuredOutcome
} from '@jooevents/contracts';
import type { z } from 'zod';
import type { EventProgramPort } from './event-program/port';
import type { SubmissionTriagePageView } from './mappers/submission-triage';
import type {
	DecisionsLiveClient,
	DecisionsLiveReadResult
} from './operations/decisions-live';
import type {
	EngagementsLiveClient,
	EngagementsLiveReadResult
} from './operations/engagements-live';
import {
	resolveOperatorHttpBinding,
	type OperatorHttpBindingUnavailableReason
} from './operations/operator-http-binding';
import type {
	SubmissionTriageLiveClient,
	SubmissionTriageLiveReadResult
} from './operations/submission-triage-live';
import { requestJson, type ApiResult, type SafeApiError } from './client';
import type {
	PulseDecisionBreakdown,
	PulseFunnelWeek,
	PulseHero,
	PulseHeroFigure,
	PulsePagePort,
	PulsePageReadResult,
	PulsePageSummary,
	PulseSeries,
	PulseSeriesKey,
	PulseTrackFill,
	PulseTrackRow,
	PulseWeek
} from './pulse-page-port';
import type { SessionCatalogCorePort, SessionCatalogReadResult } from './session-catalog-port';
import type { DecisionState, EventInfo } from './types';
import type { ProgramVocabularySnapshotView } from './view-models/program-vocabulary';
import type { SessionCatalogView } from './view-models/session';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 14;
const VISIBLE_WEEKS = 12;
const HISTORY_PAGE_SIZE = 100;
const HISTORY_PAGE_LIMIT = 10_000;

export const PULSE_HISTORY_OPERATION = Object.freeze({
	name: 'operation.history.list',
	version: 1,
	effect: 'read',
	method: 'GET',
	input: 'query',
	idempotencyRequired: false,
	path: '/api/workspace/history',
	...OPERATION_HISTORY_SCHEMA_REFS.list
} as const);

export interface PulseHistoryRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET';
	readonly signal?: AbortSignal;
}

export type PulseHistoryRequester = (
	input: PulseHistoryRequestInput
) => Promise<ApiResult<unknown>>;

type PulseHistoryReadResult =
	| { readonly kind: 'success'; readonly data: readonly OperationHistoryEntry[] }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly reason: OperatorHttpBindingUnavailableReason };

export interface PulseHistoryReadPort {
	listEvent(options?: { readonly signal?: AbortSignal }): Promise<PulseHistoryReadResult>;
}

function defaultHistoryRequester(input: PulseHistoryRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

function historyPath(path: string, input: OperationHistoryListInput): string {
	const query = new URLSearchParams({ view: input.view, limit: String(input.limit) });
	if (input.beforeOccurredAt !== undefined && input.beforeId !== undefined) {
		query.set('beforeOccurredAt', input.beforeOccurredAt);
		query.set('beforeId', input.beforeId);
	}
	return `${path}?${query.toString()}`;
}

/** Registered, paginated safe-history reader used only for Pulse flow instants. */
export function createPulseHistoryLivePort(input: {
	readonly manifest: unknown;
	readonly request?: PulseHistoryRequester;
}): PulseHistoryReadPort {
	const resolved = resolveOperatorHttpBinding({
		manifest: input.manifest,
		expected: PULSE_HISTORY_OPERATION
	});
	const binding = resolved.kind === 'available' && resolved.path !== PULSE_HISTORY_OPERATION.path
		? { kind: 'unavailable' as const, reason: 'operation_contract_mismatch' as const }
		: resolved;
	const request = input.request ?? defaultHistoryRequester;

	return Object.freeze({
		async listEvent(options: { readonly signal?: AbortSignal } = {}) {
			if (binding.kind === 'unavailable') {
				return { kind: 'unavailable' as const, reason: binding.reason };
			}
			const entries: OperationHistoryEntry[] = [];
			let cursor: OperationHistoryPage['next'];
			for (;;) {
				const businessInput = operationHistoryListInputSchema.parse({
					view: 'event',
					limit: HISTORY_PAGE_SIZE,
					...(cursor ? {
						beforeOccurredAt: cursor.occurredAt,
						beforeId: cursor.id
					} : {})
				});
				const response = await request({
					path: historyPath(binding.path, businessInput),
					method: 'GET',
					schema: operationHistoryListResultSchema,
					...(options.signal ? { signal: options.signal } : {})
				});
				if (response.kind === 'error') {
					return { kind: 'transport_error' as const, error: response.error };
				}
				const parsed = operationHistoryListResultSchema.safeParse(response.data);
				if (!parsed.success) {
					return {
						kind: 'transport_error' as const,
						error: { code: 'invalid_contract', retryable: true }
					};
				}
				if (parsed.data.kind === 'outcome') return parsed.data;
				if (parsed.data.data.scope !== 'event') {
					return {
						kind: 'transport_error' as const,
						error: { code: 'invalid_contract', retryable: true }
					};
				}
				entries.push(...parsed.data.data.entries);
				const next = parsed.data.data.next;
				if (next === undefined) {
					return { kind: 'success' as const, data: Object.freeze(entries) };
				}
				if ((cursor && next.occurredAt === cursor.occurredAt && next.id === cursor.id)
					|| entries.length >= HISTORY_PAGE_LIMIT) {
					return {
						kind: 'transport_error' as const,
						error: { code: 'invalid_contract', retryable: true }
					};
				}
				cursor = next;
			}
		}
	});
}

type EventRead = EventProgramPort['event']['read'];
type VocabularyRead = EventProgramPort['vocabulary']['read'];

export interface LivePulsePageSources {
	readonly event: { readonly read: EventRead };
	readonly vocabulary: { readonly read: VocabularyRead };
	readonly triage: Pick<SubmissionTriageLiveClient, 'list'>;
	readonly decisions: Pick<DecisionsLiveClient, 'readState'>;
	readonly engagements: Pick<EngagementsLiveClient, 'readSnapshot'>;
	readonly sessions: Pick<SessionCatalogCorePort, 'readCatalog'>;
	readonly history: PulseHistoryReadPort;
}

type ReadFailure =
	| Exclude<Awaited<ReturnType<EventRead>>, { readonly kind: 'success' }>
	| Exclude<Awaited<ReturnType<VocabularyRead>>, { readonly kind: 'success' }>
	| Exclude<SubmissionTriageLiveReadResult<SubmissionTriagePageView>, { readonly kind: 'success' }>
	| Exclude<DecisionsLiveReadResult<DecisionStateSnapshotDto>, { readonly kind: 'success' }>
	| Exclude<EngagementsLiveReadResult<unknown>, { readonly kind: 'success' }>
	| Exclude<SessionCatalogReadResult, { readonly kind: 'success' }>
	| Exclude<PulseHistoryReadResult, { readonly kind: 'success' }>;

function readFailure(result: ReadFailure): Exclude<PulsePageReadResult, { readonly kind: 'success' }> {
	if (result.kind === 'transport_error') {
		return {
			kind: 'transport_error',
			retryable: result.error.retryable,
			...(result.error.correlationId ? { correlationId: result.error.correlationId } : {})
		};
	}
	if (result.kind === 'outcome') {
		return {
			kind: 'unavailable',
			message: result.outcome.class === 'access_denied'
				? 'You no longer have permission to view the event pulse.'
				: 'The event pulse could not be loaded.',
			...(result.correlationId ? { correlationId: result.correlationId } : {})
		};
	}
	return { kind: 'unavailable', message: 'Pulse is not available in this live workspace.' };
}

function incompletePopulation(): Exclude<PulsePageReadResult, { readonly kind: 'success' }> {
	return {
		kind: 'unavailable',
		message: 'The complete event pulse is not available in this live workspace.'
	};
}

function emptySummary(): PulsePageSummary {
	return Object.freeze({
		event: null,
		hero: Object.freeze({ figures: Object.freeze([]) }),
		series: Object.freeze([]),
		breakdown: Object.freeze({ total: 0, rows: Object.freeze([]) }),
		tracks: Object.freeze({ rows: Object.freeze([]) })
	});
}

function eventInfo(event: Awaited<ReturnType<EventRead>> & { readonly kind: 'success' }): EventInfo | null {
	if (event.data.kind === 'no_event') return null;
	return Object.freeze({
		id: event.data.event.id,
		name: event.data.event.name,
		dates: formatDateRange(event.data.event.startDate, event.data.event.endDate),
		location: '',
		timezone: event.data.event.timezone,
		phase: '',
		today: ''
	});
}

function weekStarts(now: number, timezone: string): readonly number[] {
	const current = startOfZonedWeek(now, timezone);
	if (current === null) return Object.freeze([]);
	const starts: number[] = [];
	for (let back = VISIBLE_WEEKS - 1; back >= 0; back -= 1) {
		const probe = current - back * 7 * DAY_MS + 12 * 3_600_000;
		starts.push(startOfZonedWeek(probe, timezone) ?? probe - 12 * 3_600_000);
	}
	return Object.freeze(starts);
}

function weeklyCounts(
	instants: readonly number[],
	starts: readonly number[],
	timezone: string
): readonly number[] {
	const positions = new Map(starts.map((start, index) => [start, index]));
	const counts = starts.map(() => 0);
	for (const instant of instants) {
		const start = startOfZonedWeek(instant, timezone);
		const index = start === null ? undefined : positions.get(start);
		if (index !== undefined) counts[index] = (counts[index] ?? 0) + 1;
	}
	return Object.freeze(counts);
}

function buildSeries(input: {
	readonly key: PulseSeriesKey;
	readonly instants: readonly number[];
	readonly starts: readonly number[];
	readonly timezone: string;
	readonly now: number;
	readonly totalNote: string;
	readonly absence: string;
}): PulseSeries {
	const labels: Readonly<Record<PulseSeriesKey, string>> = Object.freeze({
		proposals: 'Proposals received',
		reviews: 'Reviews committed',
		decisions: 'Decisions made'
	});
	if (input.instants.length === 0) {
		return Object.freeze({
			key: input.key,
			label: labels[input.key],
			total: 0,
			totalNote: input.totalNote,
			windowDays: WINDOW_DAYS,
			windowCount: 0,
			weeks: Object.freeze([]),
			absence: input.absence
		});
	}
	const counts = weeklyCounts(input.instants, input.starts, input.timezone);
	const weeks: readonly PulseWeek[] = Object.freeze(input.starts.map((start, index) =>
		Object.freeze({ startsAt: new Date(start).toISOString(), count: counts[index] ?? 0 })
	));
	const floor = input.now - WINDOW_DAYS * DAY_MS;
	return Object.freeze({
		key: input.key,
		label: labels[input.key],
		total: input.instants.length,
		totalNote: input.totalNote,
		windowDays: WINDOW_DAYS,
		windowCount: input.instants.filter((instant) => instant >= floor && instant <= input.now).length,
		weeks
	});
}

function cumulative(counts: readonly number[], total: number): readonly number[] {
	let running = total - counts.reduce((sum, count) => sum + count, 0);
	return Object.freeze(counts.map((count) => (running += count)));
}

function buildHero(input: {
	readonly starts: readonly number[];
	readonly timezone: string;
	readonly proposals: readonly number[];
	readonly decisions: readonly number[];
	readonly accepted: readonly number[];
	readonly reviews: number;
	readonly speakers: number;
}): PulseHero {
	if (input.proposals.length === 0) {
		return Object.freeze({
			figures: Object.freeze([]),
			absence: 'The story appears here as proposals arrive.'
		});
	}
	const figures: PulseHeroFigure[] = [
		Object.freeze({ label: 'Proposals', value: String(input.proposals.length) })
	];
	if (input.reviews > 0) figures.push(Object.freeze({ label: 'Reviews', value: String(input.reviews) }));
	if (input.decisions.length > 0) {
		figures.push(Object.freeze({ label: 'Decided', value: String(input.decisions.length) }));
		figures.push(Object.freeze({ label: 'Accepted', value: String(input.accepted.length) }));
	}
	if (input.speakers > 0) figures.push(Object.freeze({ label: 'Speakers', value: String(input.speakers) }));

	const receivedWeekly = weeklyCounts(input.proposals, input.starts, input.timezone);
	const decidedWeekly = weeklyCounts(input.decisions, input.starts, input.timezone);
	const acceptedWeekly = weeklyCounts(input.accepted, input.starts, input.timezone);
	const received = cumulative(receivedWeekly, input.proposals.length);
	const decided = cumulative(decidedWeekly, input.decisions.length);
	const accepted = cumulative(acceptedWeekly, input.accepted.length);
	const funnel: readonly PulseFunnelWeek[] = Object.freeze(input.starts.map((start, index) =>
		Object.freeze({
			startsAt: new Date(start).toISOString(),
			received: received[index] ?? 0,
			...(input.decisions.length > 0 ? { decided: decided[index] ?? 0 } : {}),
			...(input.decisions.length > 0 ? { accepted: accepted[index] ?? 0 } : {})
		})
	));
	return Object.freeze({ figures: Object.freeze(figures), funnel });
}

function custodyNote(
	rows: readonly SubmissionTriagePageView['rows'][number][],
	decisions: ReadonlyMap<string, DecisionState>
): string | undefined {
	const waiting = rows.filter((row) => decisions.get(row.source.id) === 'undecided');
	if (waiting.length === 0) return undefined;
	const counts = { inbox: 0, late: 0, set_aside: 0, discarded: 0 };
	for (const row of waiting) counts[row.visibleTray] += 1;
	const parts: string[] = [];
	if (counts.inbox > 0) parts.push(`${counts.inbox} in the inbox`);
	if (counts.late > 0) parts.push(`${counts.late} late`);
	if (counts.set_aside > 0) parts.push(`${counts.set_aside} set aside`);
	if (counts.discarded > 0) parts.push(`${counts.discarded} discarded`);
	return `Of the ${waiting.length} waiting: ${parts.join(', ')}.`;
}

function breakdown(
	rows: readonly SubmissionTriagePageView['rows'][number][],
	decisions: ReadonlyMap<string, DecisionState>
): PulseDecisionBreakdown {
	if (rows.length === 0) {
		return Object.freeze({
			total: 0,
			rows: Object.freeze([]),
			absence: 'The spread of answers appears here once proposals arrive.'
		});
	}
	const order: readonly DecisionState[] = ['accepted', 'waitlisted', 'declined', 'withdrawn', 'undecided'];
	const counts = new Map<DecisionState, number>(order.map((state) => [state, 0]));
	for (const row of rows) {
		const state = decisions.get(row.source.id) ?? 'undecided';
		counts.set(state, (counts.get(state) ?? 0) + 1);
	}
	const decisionRows = order.flatMap((state) => {
		const count = counts.get(state) ?? 0;
		return count === 0 ? [] : [Object.freeze({ state, count })];
	});
	if (counts.get('undecided') === rows.length) {
		return Object.freeze({
			total: rows.length,
			rows: Object.freeze([]),
			absence: `All ${rows.length} proposals are waiting for your answer.`
		});
	}
	const note = custodyNote(rows, decisions);
	return Object.freeze({
		total: rows.length,
		rows: Object.freeze(decisionRows),
		...(note ? { note } : {})
	});
}

const GENERAL_POOL = 'general_pool';

function trackFill(input: {
	readonly rows: readonly SubmissionTriagePageView['rows'][number][];
	readonly decisionRows: readonly DecisionStateSnapshotDto['rows'][number][];
	readonly vocabulary: ProgramVocabularySnapshotView;
	readonly sessions: SessionCatalogView;
	readonly engagements: Awaited<ReturnType<EngagementsLiveClient['readSnapshot']>> & { readonly kind: 'success' };
}): PulseTrackFill | null {
	const sessionById = new Map(input.sessions.sessions.map((session) => [session.id, session]));
	const counts = new Map<string, { name: string; proposals: number; accepted: number; speakers: number }>();
	for (const track of input.vocabulary.tracks) {
		counts.set(track.id, { name: track.name, proposals: 0, accepted: 0, speakers: 0 });
	}
	const ensure = (id: string, name: string) => {
		const found = counts.get(id);
		if (found) return found;
		const created = { name, proposals: 0, accepted: 0, speakers: 0 };
		counts.set(id, created);
		return created;
	};
	const general = () => ensure(GENERAL_POOL, 'General pool');
	for (const row of input.rows) {
		const target = row.source.track;
		(target ? ensure(target.id, target.label) : general()).proposals += 1;
	}
	for (const row of input.decisionRows) {
		if (row.head?.state !== 'accepted') continue;
		const session = row.origin ? sessionById.get(row.origin.sessionId) : undefined;
		if (row.origin && !session) return null;
		const track = session?.programTarget.track;
		(track ? ensure(track.id, track.name) : general()).accepted += 1;
	}
	const activeEngagements = input.engagements.data.engagements.filter(
		(engagement) => engagement.state !== 'declined' && engagement.state !== 'cancelled'
	);
	for (const engagement of activeEngagements) {
		const session = sessionById.get(engagement.sessionId);
		if (!session) return null;
		const track = session.programTarget.track;
		(track ? ensure(track.id, track.name) : general()).speakers += 1;
	}
	const acceptedTotal = input.decisionRows.filter((row) => row.head?.state === 'accepted').length;
	if (acceptedTotal === 0) {
		return Object.freeze({
			rows: Object.freeze([]),
			absence: 'Each track fills here as proposals are accepted.'
		});
	}
	const orderedIds = [
		...input.vocabulary.tracks.map((track) => track.id),
		...([...counts.keys()].filter((id) => !input.vocabulary.tracks.some((track) => track.id === id)))
	];
	const rows: readonly PulseTrackRow[] = Object.freeze(orderedIds.map((id) => {
		const count = counts.get(id)!;
		return Object.freeze({ id, ...count });
	}));
	const speakers = activeEngagements.length;
	return Object.freeze({
		rows,
		...(speakers > 0
			? { rosterLine: `${speakers} ${speakers === 1 ? 'speaker is' : 'speakers are'} on the roster.` }
			: {})
	});
}

function parseInstants(values: readonly string[]): readonly number[] {
	const parsed = values.map((value) => Date.parse(value));
	return parsed.every(Number.isFinite) ? Object.freeze(parsed) : Object.freeze([]);
}

async function readDecisions(
	source: Pick<DecisionsLiveClient, 'readState'>,
	ids: readonly string[],
	signal?: AbortSignal
): Promise<DecisionsLiveReadResult<DecisionStateSnapshotDto>> {
	const rows: DecisionStateSnapshotDto['rows'][number][] = [];
	for (let index = 0; index < ids.length; index += DECISION_DECIDE_ROWS_MAX) {
		const result = await source.readState(
			ids.slice(index, index + DECISION_DECIDE_ROWS_MAX),
			signal ? { signal } : {}
		);
		if (result.kind !== 'success') return result;
		rows.push(...result.data.rows);
	}
	return {
		kind: 'success',
		data: { schemaVersion: 1, rows: [...rows] },
		correlationId: ''
	};
}

/** Live Pulse projection assembled only from registered, permission-checked reads. */
export function createLivePulsePagePort(input: {
	readonly sources: LivePulsePageSources;
	readonly now?: () => number;
}): PulsePagePort {
	let snapshot: PulsePageSummary | null = null;
	const now = input.now ?? Date.now;
	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),
		snapshot: () => snapshot,
		async read(options = {}) {
			const eventResult = await input.sources.event.read(options);
			if (eventResult.kind !== 'success') return readFailure(eventResult);
			const event = eventInfo(eventResult);
			if (event === null) {
				snapshot = emptySummary();
				return { kind: 'success' as const, data: snapshot };
			}

			const [triageResult, vocabularyResult, sessionResult, engagementResult, historyResult] =
				await Promise.all([
					input.sources.triage.list({}, options),
					input.sources.vocabulary.read(options),
					input.sources.sessions.readCatalog(options),
					input.sources.engagements.readSnapshot(options),
					input.sources.history.listEvent(options)
				]);
			for (const result of [triageResult, vocabularyResult, sessionResult, engagementResult, historyResult]) {
				if (result.kind !== 'success') return readFailure(result as ReadFailure);
			}
			if (triageResult.kind !== 'success' || vocabularyResult.kind !== 'success'
				|| sessionResult.kind !== 'success' || engagementResult.kind !== 'success'
				|| historyResult.kind !== 'success') return incompletePopulation();

			const expectedPopulation = Object.values(triageResult.data.trayTotals)
				.reduce((sum, count) => sum + count, 0);
			if (expectedPopulation !== triageResult.data.rows.length) return incompletePopulation();
			const submissionIds = triageResult.data.rows.map((row) => row.source.id);
			const decisionResult = submissionIds.length === 0
				? { kind: 'success' as const, data: { schemaVersion: 1 as const, rows: [] }, correlationId: '' }
				: await readDecisions(input.sources.decisions, submissionIds, options.signal);
			if (decisionResult.kind !== 'success') return readFailure(decisionResult);
			if (decisionResult.data.rows.length !== submissionIds.length
				|| new Set(decisionResult.data.rows.map((row) => row.submissionId)).size !== submissionIds.length) {
				return incompletePopulation();
			}

			const decisionStates = new Map<string, DecisionState>(decisionResult.data.rows.map((row) => [
				row.submissionId,
				row.head?.state ?? 'undecided'
			]));
			const proposalInstants = parseInstants(triageResult.data.rows.map((row) => row.source.submittedAt));
			const currentDecisionHeads = decisionResult.data.rows.flatMap((row) => row.head ? [row.head] : []);
			// Version one is the first transition out of undecided, so its head
			// instant is also the product-defined decision-flow instant. A later
			// head does not expose that first instant; refuse the aggregate instead
			// of quietly charting the amendment as though it were the first answer.
			if (currentDecisionHeads.some((head) => head.version !== 1)) return incompletePopulation();
			const decisionInstants = parseInstants(currentDecisionHeads.map((head) => head.decidedAt));
			const acceptedInstants = parseInstants(currentDecisionHeads
				.filter((head) => head.state === 'accepted').map((head) => head.decidedAt));
			const reviewInstants = parseInstants(historyResult.data
				.filter((entry) => entry.operation.name === 'review.evaluation.change'
					&& entry.operation.version === 1 && entry.summary === 'Submitted a review')
				.map((entry) => entry.occurredAt));
			if (proposalInstants.length !== triageResult.data.rows.length
				|| decisionInstants.length !== currentDecisionHeads.length) return incompletePopulation();
			const currentNow = now();
			const starts = weekStarts(currentNow, event.timezone);
			if (starts.length !== VISIBLE_WEEKS) return incompletePopulation();
			const tracks = trackFill({
				rows: triageResult.data.rows,
				decisionRows: decisionResult.data.rows,
				vocabulary: vocabularyResult.data,
				sessions: sessionResult.data,
				engagements: engagementResult
			});
			if (tracks === null) return incompletePopulation();
			const activeSpeakers = engagementResult.data.engagements.filter(
				(engagement) => engagement.state !== 'declined' && engagement.state !== 'cancelled'
			).length;
			const series: readonly PulseSeries[] = Object.freeze([
				buildSeries({ key: 'proposals', instants: proposalInstants, starts,
					timezone: event.timezone, now: currentNow, totalNote: 'since the CFP opened',
					absence: 'No proposals have arrived yet. Arrivals chart here week by week once the CFP opens.' }),
				buildSeries({ key: 'reviews', instants: reviewInstants, starts,
					timezone: event.timezone, now: currentNow, totalNote: 'committed for this event',
					absence: 'No reviews have been committed yet. Committed reviews chart here once the first one is submitted.' }),
				buildSeries({ key: 'decisions', instants: decisionInstants, starts,
					timezone: event.timezone, now: currentNow, totalNote: `of ${proposalInstants.length} proposals`,
					absence: 'No proposals have been decided. Decisions chart here once the first one is made.' })
			]);
			snapshot = Object.freeze({
				event,
				hero: buildHero({ starts, timezone: event.timezone, proposals: proposalInstants,
					decisions: decisionInstants, accepted: acceptedInstants,
					reviews: reviewInstants.length, speakers: activeSpeakers }),
				series,
				breakdown: breakdown(triageResult.data.rows, decisionStates),
				tracks
			});
			return { kind: 'success' as const, data: snapshot };
		}
	} satisfies PulsePagePort);
}
