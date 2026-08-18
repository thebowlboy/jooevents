import type {
	ScheduleProposalCountsReadResult,
	ScheduleProposalCountsSource
} from '../schedule-page-port.live';
import {
	createScheduleTriagePopulationSource,
	type DecisionStateReader,
	type ScheduleTriagePopulationSource,
	type SubmissionTriageListReader
} from './schedule-page-population.live';

export type { DecisionStateReader, SubmissionTriageListReader };

function asPopulation(
	input:
		| ScheduleTriagePopulationSource
		| {
				readonly list: SubmissionTriageListReader;
				readonly decisions: { readonly readState: DecisionStateReader };
		  }
): ScheduleTriagePopulationSource {
	return 'read' in input ? input : createScheduleTriagePopulationSource(input);
}

/**
 * Whole-population open-proposal totals per target session, derived from the
 * shared schedule triage population (one list + chunked Decision heads).
 *
 * The tuned Schedule page prints an absent key as the positive fact
 * "no proposals yet", so this source may answer only when the served page is
 * provably the whole submission population. An empty or uninitialized spine is
 * the positive claim "no open proposals target any session".
 *
 * What counts as an open proposal: undecided, non-spam submissions targeting
 * this session. Targets other than `kind: 'session'` contribute to no count.
 */
export function createLiveScheduleProposalCountsSource(
	input:
		| ScheduleTriagePopulationSource
		| {
				readonly list: SubmissionTriageListReader;
				readonly decisions: { readonly readState: DecisionStateReader };
		  }
): ScheduleProposalCountsSource {
	const population = asPopulation(input);
	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),

		async readOpenProposalCounts(): Promise<ScheduleProposalCountsReadResult> {
			const result = await population.read();
			if (result.kind === 'empty') {
				return { kind: 'success', data: Object.freeze({}) };
			}
			if (result.kind === 'truncated') {
				return { kind: 'unavailable', reason: 'proposal_count_population_truncated' };
			}
			if (result.kind === 'incomplete') {
				return { kind: 'unavailable', reason: result.reason };
			}
			if (result.kind === 'unavailable') {
				return { kind: 'unavailable', reason: result.reason };
			}
			if (result.kind !== 'success') return result;

			const counts: Record<string, number> = {};
			for (const row of result.data.rows) {
				if (row.visibleTray === 'spam') continue;
				const target = row.source.target;
				if (target.kind !== 'session') continue;
				const state = result.data.decisions.get(row.source.id);
				if (state?.head !== null && state?.head !== undefined) continue;
				counts[target.sessionId] = (counts[target.sessionId] ?? 0) + 1;
			}
			return { kind: 'success', data: Object.freeze(counts) };
		}
	} satisfies ScheduleProposalCountsSource);
}
