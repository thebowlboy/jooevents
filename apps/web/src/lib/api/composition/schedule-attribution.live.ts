import type { DecisionStateSnapshotDto } from '@jooevents/contracts';
import type { SubmissionTriageListInput } from '@jooevents/contracts/submission-triage';
import type { SubmissionTriagePageView } from '../mappers/submission-triage';
import type { DecisionsLiveReadResult } from '../operations/decisions-live';
import type { SubmissionTriageLiveReadResult } from '../operations/submission-triage-live';
import type {
	ScheduleAttributionReadResult,
	ScheduleAttributionSource,
	ScheduleAttributionSubmission
} from '../schedule-page-port.live';

type TriageListReader = (
	query: SubmissionTriageListInput,
	options?: { readonly signal?: AbortSignal }
) => Promise<SubmissionTriageLiveReadResult<SubmissionTriagePageView>>;

type DecisionStateReader = (
	submissionIds: readonly string[],
	options?: { readonly signal?: AbortSignal }
) => Promise<DecisionsLiveReadResult<DecisionStateSnapshotDto>>;

const DECISION_READ_CHUNK = 100;

function forwarded(
	result: Exclude<
		SubmissionTriageLiveReadResult<SubmissionTriagePageView>
		| DecisionsLiveReadResult<DecisionStateSnapshotDto>,
		{ readonly kind: 'success' }
	>
): Exclude<ScheduleAttributionReadResult, { readonly kind: 'success' }> {
	if (result.kind === 'outcome') {
		return { kind: 'outcome', outcome: result.outcome, correlationId: result.correlationId };
	}
	if (result.kind === 'transport_error') return { kind: 'transport_error', error: result.error };
	return { kind: 'unavailable', reason: result.reason };
}

/**
 * Joins the complete triage population to Decision heads and immutable origin
 * links for the Schedule speaker drawer. The list endpoint is capped at 500,
 * so this source proves that its unfiltered page is the whole population from
 * the server-owned tray totals. It refuses a truncated page instead of
 * presenting a partial origin list or a false "nothing to attach" state.
 */
export function createLiveScheduleAttributionSource(input: {
	readonly list: TriageListReader;
	readonly decisions: { readonly readState: DecisionStateReader };
}): ScheduleAttributionSource {
	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),

		async read(): Promise<ScheduleAttributionReadResult> {
			const listed = await input.list({});
			if (listed.kind === 'outcome'
				&& listed.outcome.kind === 'submission_triage.not_initialized') {
				return { kind: 'success', data: Object.freeze([]) };
			}
			if (listed.kind !== 'success') return forwarded(listed);

			const totals = listed.data.trayTotals;
			const population = totals.inbox + totals.set_aside + totals.late + totals.spam;
			if (population !== listed.data.rows.length) {
				return { kind: 'unavailable', reason: 'schedule_attribution_population_truncated' };
			}

			const decisions = new Map<string, DecisionStateSnapshotDto['rows'][number]>();
			const ids = listed.data.rows.map((row) => row.source.id);
			for (let index = 0; index < ids.length; index += DECISION_READ_CHUNK) {
				const chunk = ids.slice(index, index + DECISION_READ_CHUNK);
				const state = await input.decisions.readState(chunk);
				if (state.kind !== 'success') return forwarded(state);
				const expected = new Set(chunk);
				for (const row of state.data.rows) {
					if (!expected.has(row.submissionId) || decisions.has(row.submissionId)) {
						return { kind: 'unavailable', reason: 'schedule_attribution_decision_projection_incomplete' };
					}
					decisions.set(row.submissionId, row);
				}
				if (state.data.rows.length !== chunk.length) {
					return { kind: 'unavailable', reason: 'schedule_attribution_decision_projection_incomplete' };
				}
			}

			const rows: ScheduleAttributionSubmission[] = [];
			for (const row of listed.data.rows) {
				const source = row.source.source === 'public_form'
					? 'cfp' as const
					: row.source.source === 'direct_entry' || row.source.source === 'import'
						? row.source.source
						: null;
				if (source === null) {
					return { kind: 'unavailable', reason: 'schedule_attribution_source_unsupported' };
				}
				const state = decisions.get(row.source.id);
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
