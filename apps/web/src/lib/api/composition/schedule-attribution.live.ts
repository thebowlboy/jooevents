import type {
	ScheduleAttributionReadResult,
	ScheduleAttributionSource,
	ScheduleAttributionSubmission
} from '../schedule-page-port.live';
import {
	createScheduleTriagePopulationSource,
	type DecisionStateReader,
	type ScheduleTriagePopulationSource,
	type SubmissionTriageListReader
} from './schedule-page-population.live';

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
 * Joins the complete triage population to Decision heads and immutable origin
 * links for the Schedule speaker drawer. The list endpoint is capped at 500,
 * so this source proves that its unfiltered page is the whole population from
 * the server-owned tray totals. It refuses a truncated page instead of
 * presenting a partial origin list or a false "nothing to attach" state.
 *
 * When composed over the same {@link ScheduleTriagePopulationSource} as the
 * proposal-count fold, both reads share one list and one set of Decision
 * chunks.
 */
export function createLiveScheduleAttributionSource(
	input:
		| ScheduleTriagePopulationSource
		| {
				readonly list: SubmissionTriageListReader;
				readonly decisions: { readonly readState: DecisionStateReader };
		  }
): ScheduleAttributionSource {
	const population = asPopulation(input);
	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),

		async read(): Promise<ScheduleAttributionReadResult> {
			const result = await population.read();
			if (result.kind === 'empty') {
				return { kind: 'success', data: Object.freeze([]) };
			}
			if (result.kind === 'truncated') {
				return { kind: 'unavailable', reason: 'schedule_attribution_population_truncated' };
			}
			if (result.kind === 'incomplete') {
				return { kind: 'unavailable', reason: result.reason };
			}
			if (result.kind === 'outcome') {
				return { kind: 'outcome', outcome: result.outcome, correlationId: result.correlationId };
			}
			if (result.kind === 'transport_error') return { kind: 'transport_error', error: result.error };
			if (result.kind === 'unavailable') return { kind: 'unavailable', reason: result.reason };
			if (result.kind !== 'success') return { kind: 'unavailable', reason: 'schedule_attribution_population_truncated' };

			const rows: ScheduleAttributionSubmission[] = [];
			for (const row of result.data.rows) {
				const source = row.source.source === 'public_form'
					? 'cfp' as const
					: row.source.source === 'direct_entry' || row.source.source === 'import'
						? row.source.source
						: null;
				if (source === null) {
					return { kind: 'unavailable', reason: 'schedule_attribution_source_unsupported' };
				}
				const state = result.data.decisions.get(row.source.id);
				rows.push(Object.freeze({
					id: row.source.id,
					title: row.source.title,
					primaryParticipantName: row.source.primaryParticipantName ?? '',
					source,
					decision: state?.head?.state ?? null,
					origin: state?.origin === undefined || state.origin === null
						? null
						: Object.freeze({ sessionId: state.origin.sessionId, kind: state.origin.kind })
				}));
			}
			return { kind: 'success', data: Object.freeze(rows) };
		}
	} satisfies ScheduleAttributionSource);
}
