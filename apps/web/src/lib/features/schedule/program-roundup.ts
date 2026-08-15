/**
 * The round-up lens: what still stands between this program and done.
 *
 * A program item is finished when three independent questions answer yes —
 * decided (`programmed`), placed (holds a slot), peopled (non-empty roster).
 * Every predicate here is a pure projection over state the schedule already
 * holds; readiness is never stored, so it can never disagree with the data.
 *
 * This is the client mirror of the counts the workspace summary reports; the
 * grouping below partitions the pool so every session renders exactly once,
 * with any second gap named on the row rather than by a second row.
 */

import type { ScheduleState, SessionItem, Submission } from '$lib/api/types';

export type RoundupTray = 'needs-track' | 'unplaced' | 'needs-speakers' | 'undecided-in-place';

/** The Program panel's partition: each session appears in exactly one group. */
export type ProgramGroup = RoundupTray | 'collecting' | 'drafts';

export interface ProgramGroupRow {
	session: SessionItem;
	placed: boolean;
	/** Every tray predicate the row satisfies — the group plus any second gap. */
	trays: RoundupTray[];
	/** Open proposals aimed at this session (undecided, still recoverable). */
	proposalCount: number;
}

export const trayLabel: Record<RoundupTray, string> = {
	'needs-track': 'Needs track',
	unplaced: 'Unplaced',
	'needs-speakers': 'Needs speakers',
	'undecided-in-place': 'Held slots awaiting decisions'
};

export function isRoundupTray(value: string | null): value is RoundupTray {
	return value === 'needs-track' || value === 'unplaced' || value === 'needs-speakers' || value === 'undecided-in-place';
}

const placedIds = (schedule: ScheduleState) =>
	new Set(schedule.placements.map((placement) => placement.sessionId));

/**
 * Open proposals per target session. Discarded submissions stay recoverable
 * (P2) but are not pending work; every other undecided proposal is.
 */
export function proposalCounts(submissions: readonly Submission[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const submission of submissions) {
		if (!submission.targetSessionId) continue;
		if (submission.decision !== 'undecided' || submission.tray === 'discarded') continue;
		counts.set(submission.targetSessionId, (counts.get(submission.targetSessionId) ?? 0) + 1);
	}
	return counts;
}

export function traysOf(
	session: SessionItem,
	placed: boolean,
	eventUsesTracks = false
): RoundupTray[] {
	const trays: RoundupTray[] = [];
	if (eventUsesTracks && session.state !== 'draft' && session.trackId === '') trays.push('needs-track');
	if (session.state === 'programmed' && !placed) trays.push('unplaced');
	if (session.state === 'programmed' && session.speakers.length === 0) trays.push('needs-speakers');
	if (session.state === 'collecting' && placed) trays.push('undecided-in-place');
	return trays;
}

/**
 * The tray totals the summary reports — each count's denominator is its own
 * row set, rendered in the Program panel.
 */
export function roundupCounts(schedule: ScheduleState, eventUsesTracks = false): Record<RoundupTray, number> {
	const placed = placedIds(schedule);
	const counts: Record<RoundupTray, number> = {
		'needs-track': 0,
		unplaced: 0,
		'needs-speakers': 0,
		'undecided-in-place': 0
	};
	for (const session of schedule.sessions) {
		for (const tray of traysOf(session, placed.has(session.id), eventUsesTracks)) counts[tray] += 1;
	}
	return counts;
}

/**
 * Which single group a session renders under. Unplaced outranks the roster
 * gap — a session cannot be attended before it exists in time, and the row
 * still carries its "No speakers yet" mark — and a placed programmed session
 * with people is finished, so it appears on the grid alone, not here.
 */
export function groupOf(session: SessionItem, placed: boolean, eventUsesTracks = false): ProgramGroup | null {
	if (session.state === 'draft') return 'drafts';
	if (eventUsesTracks && session.trackId === '') return 'needs-track';
	if (session.state === 'collecting') return placed ? 'undecided-in-place' : 'collecting';
	if (!placed) return 'unplaced';
	if (session.speakers.length === 0) return 'needs-speakers';
	return null;
}

export interface ProgramGrouping {
	order: ProgramGroup[];
	groups: Map<ProgramGroup, ProgramGroupRow[]>;
	/** Sessions the panel lists at all — everything not finished-and-placed. */
	total: number;
}

const GROUP_ORDER: ProgramGroup[] = [
	'needs-track',
	'unplaced',
	'needs-speakers',
	'undecided-in-place',
	'collecting',
	'drafts'
];

export const groupHeading: Record<ProgramGroup, string> = {
	'needs-track': 'Needs track',
	unplaced: 'Unplaced',
	'needs-speakers': 'Needs speakers',
	'undecided-in-place': 'Held slots awaiting decisions',
	collecting: 'Collecting proposals',
	drafts: 'Drafts'
};

export function programGrouping(
	schedule: ScheduleState,
	proposals: ReadonlyMap<string, number>,
	eventUsesTracks = false
): ProgramGrouping {
	const placed = placedIds(schedule);
	const groups = new Map<ProgramGroup, ProgramGroupRow[]>();
	let total = 0;
	for (const session of schedule.sessions) {
		const isPlaced = placed.has(session.id);
		const group = groupOf(session, isPlaced, eventUsesTracks);
		if (!group) continue;
		const row: ProgramGroupRow = {
			session,
			placed: isPlaced,
			trays: traysOf(session, isPlaced, eventUsesTracks),
			proposalCount: proposals.get(session.id) ?? 0
		};
		const rows = groups.get(group);
		if (rows) rows.push(row);
		else groups.set(group, [row]);
		total += 1;
	}
	return { order: GROUP_ORDER.filter((group) => groups.has(group)), groups, total };
}
