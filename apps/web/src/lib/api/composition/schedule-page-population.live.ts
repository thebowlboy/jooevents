import type { DecisionStateSnapshotDto } from '@jooevents/contracts';
import type { SubmissionTriageListInput } from '@jooevents/contracts/submission-triage';
import type { SubmissionTriagePageView, SubmissionTriageRowView } from '../mappers/submission-triage';
import type { DecisionsLiveReadResult } from '../operations/decisions-live';
import type { SubmissionTriageLiveReadResult } from '../operations/submission-triage-live';

/** The one triage read this source performs, injectable for tests. */
export type SubmissionTriageListReader = (
	query: SubmissionTriageListInput,
	options?: { readonly signal?: AbortSignal }
) => Promise<SubmissionTriageLiveReadResult<SubmissionTriagePageView>>;

/** The Decision spine's state read, at most 100 submission ids per request. */
export type DecisionStateReader = (
	submissionIds: readonly string[],
	options?: { readonly signal?: AbortSignal }
) => Promise<DecisionsLiveReadResult<DecisionStateSnapshotDto>>;

const DECISION_READ_CHUNK = 100;

export type ScheduleTriagePopulation = {
	readonly rows: readonly SubmissionTriageRowView[];
	readonly decisions: ReadonlyMap<string, DecisionStateSnapshotDto['rows'][number]>;
};

export type ScheduleTriagePopulationReadResult =
	| { readonly kind: 'success'; readonly data: ScheduleTriagePopulation }
	| { readonly kind: 'empty' }
	| { readonly kind: 'truncated' }
	| { readonly kind: 'incomplete'; readonly reason: 'schedule_attribution_decision_projection_incomplete' }
	| Extract<
			SubmissionTriageLiveReadResult<SubmissionTriagePageView>
			| DecisionsLiveReadResult<DecisionStateSnapshotDto>,
			{ readonly kind: 'outcome' } | { readonly kind: 'transport_error' } | { readonly kind: 'unavailable' }
	  >;

export interface ScheduleTriagePopulationSource {
	readonly source: { readonly kind: 'live' };
	read(): Promise<ScheduleTriagePopulationReadResult>;
}

/**
 * One whole-population triage list plus the Decision heads for every returned
 * row. Proposal counts and session attribution both fold this same payload, so
 * the schedule page pays for the list and the chunked decision reads once.
 *
 * Concurrent callers join the in-flight read. Chunks at the wire's 100-id bound
 * run together rather than one after another.
 */
export function createScheduleTriagePopulationSource(input: {
	readonly list: SubmissionTriageListReader;
	readonly decisions: { readonly readState: DecisionStateReader };
}): ScheduleTriagePopulationSource {
	let inflight: Promise<ScheduleTriagePopulationReadResult> | null = null;

	async function load(): Promise<ScheduleTriagePopulationReadResult> {
		const listed = await input.list({});
		if (listed.kind === 'outcome' && listed.outcome.kind === 'submission_triage.not_initialized') {
			return { kind: 'empty' };
		}
		if (listed.kind !== 'success') return listed;

		const totals = listed.data.trayTotals;
		const population = totals.inbox + totals.set_aside + totals.late + totals.spam;
		if (population !== listed.data.rows.length) return { kind: 'truncated' };

		const ids = listed.data.rows.map((row) => row.source.id);
		const decisions = new Map<string, DecisionStateSnapshotDto['rows'][number]>();
		const chunks: string[][] = [];
		for (let index = 0; index < ids.length; index += DECISION_READ_CHUNK) {
			chunks.push(ids.slice(index, index + DECISION_READ_CHUNK));
		}
		const states = await Promise.all(chunks.map((chunk) => input.decisions.readState(chunk)));
		for (let index = 0; index < states.length; index += 1) {
			const state = states[index]!;
			const chunk = chunks[index]!;
			if (state.kind !== 'success') return state;
			const expected = new Set(chunk);
			for (const row of state.data.rows) {
				if (!expected.has(row.submissionId) || decisions.has(row.submissionId)) {
					return { kind: 'incomplete', reason: 'schedule_attribution_decision_projection_incomplete' };
				}
				decisions.set(row.submissionId, row);
			}
			if (state.data.rows.length !== chunk.length) {
				return { kind: 'incomplete', reason: 'schedule_attribution_decision_projection_incomplete' };
			}
		}

		return {
			kind: 'success',
			data: Object.freeze({
				rows: listed.data.rows,
				decisions
			})
		};
	}

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),
		read() {
			if (inflight) return inflight;
			const run = load().finally(() => {
				if (inflight === run) inflight = null;
			});
			inflight = run;
			return run;
		}
	});
}
