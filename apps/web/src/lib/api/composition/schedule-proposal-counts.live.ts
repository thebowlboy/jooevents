import type { DecisionStateSnapshotDto } from '@jooevents/contracts';
import type { SubmissionTriageListInput } from '@jooevents/contracts/submission-triage';
import type { DecisionsLiveReadResult } from '../operations/decisions-live';
import type { SubmissionTriageLiveReadResult } from '../operations/submission-triage-live';
import type { SubmissionTriagePageView } from '../mappers/submission-triage';
import type {
	ScheduleProposalCountsReadResult,
	ScheduleProposalCountsSource
} from '../schedule-page-port.live';

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

/**
 * Whole-population open-proposal totals per target session, derived from the
 * canonical submission triage list (`submission.triage.list`).
 *
 * The tuned Schedule page prints an absent key as the positive fact
 * "no proposals yet", so this source may answer only when the served page is
 * provably the whole submission population. The triage list serves at most
 * 500 rows, but its `trayTotals` are whole-population truth by contract
 * (`submissionTriageListSchema`): when the tray totals sum to exactly the
 * number of returned rows, the unfiltered page *is* the population, and the
 * fold below yields exact counts. When the sum exceeds the returned rows the
 * population was truncated, and this source returns its typed unavailable
 * result instead — the schedule page port already treats anything but a
 * counted success as a failed load, never as zero.
 *
 * What counts as an open proposal: the tuned page's established meaning
 * (fixed by the sample gateway it was built against) is "undecided,
 * non-spam submissions targeting this session". The Decision spine now
 * serves head state, so the fold additionally excludes decided submissions —
 * and that exclusion stays provably whole-population, because it reads the
 * decision heads of exactly the session-targeting rows the already-proven
 * whole population contains (chunked at the wire's 100-id bound). A failed
 * decision read makes the whole count unavailable rather than silently
 * counting decided rows as open.
 *
 * Targets other than `kind: 'session'` (general pool, category) are not
 * session proposals and contribute to no count.
 */
export function createLiveScheduleProposalCountsSource(input: {
	readonly list: SubmissionTriageListReader;
	readonly decisions: { readonly readState: DecisionStateReader };
}): ScheduleProposalCountsSource {
	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),

		async readOpenProposalCounts(): Promise<ScheduleProposalCountsReadResult> {
			// Unfiltered on purpose: tray totals and rows must describe the same
			// whole scope for the completeness proof below to be sound.
			const result = await input.list({});
			if (result.kind === 'outcome') {
				// `submission_triage.not_initialized` is itself a whole-population
				// fact, not a failure: the triage spine is initialized inside the
				// same transaction as every submission acceptance
				// (intake-public-mutation-effect-domain), so an uninitialized spine
				// canonically states that no submission has ever been accepted for
				// this event. The fold over that empty population is the empty
				// record — the positive claim "no open proposals target any
				// session" — served here exactly as an empty rows/totals page
				// would be. Every other outcome stays a forwarded failure.
				if (result.outcome.kind === 'submission_triage.not_initialized') {
					return { kind: 'success', data: Object.freeze({}) };
				}
				return { kind: 'outcome', outcome: result.outcome, correlationId: result.correlationId };
			}
			if (result.kind === 'transport_error') {
				return { kind: 'transport_error', error: result.error };
			}
			if (result.kind === 'unavailable') {
				return { kind: 'unavailable', reason: result.reason };
			}
			const totals = result.data.trayTotals;
			const population = totals.inbox + totals.set_aside + totals.late + totals.spam;
			if (population !== result.data.rows.length) {
				// The page window is smaller than the population, so a fold over it
				// would be exactly the row-window count the contract forbids.
				return { kind: 'unavailable', reason: 'proposal_count_population_truncated' };
			}
			const candidates: { readonly submissionId: string; readonly sessionId: string }[] = [];
			for (const row of result.data.rows) {
				if (row.visibleTray === 'spam') continue;
				const target = row.source.target;
				if (target.kind !== 'session') continue;
				candidates.push({ submissionId: row.source.id, sessionId: target.sessionId });
			}
			// Decided submissions are no longer open proposals. The head reads
			// cover exactly the candidate ids of the proven whole population, so
			// the exclusion keeps the fold whole-population by construction.
			const decided = new Set<string>();
			for (let index = 0; index < candidates.length; index += DECISION_READ_CHUNK) {
				const chunk = candidates.slice(index, index + DECISION_READ_CHUNK);
				const state = await input.decisions.readState(chunk.map((row) => row.submissionId));
				if (state.kind === 'outcome') {
					return {
						kind: 'outcome', outcome: state.outcome, correlationId: state.correlationId
					};
				}
				if (state.kind === 'transport_error') {
					return { kind: 'transport_error', error: state.error };
				}
				if (state.kind === 'unavailable') {
					return { kind: 'unavailable', reason: state.reason };
				}
				for (const row of state.data.rows) {
					if (row.head !== null) decided.add(row.submissionId);
				}
			}
			const counts: Record<string, number> = {};
			for (const candidate of candidates) {
				if (decided.has(candidate.submissionId)) continue;
				counts[candidate.sessionId] = (counts[candidate.sessionId] ?? 0) + 1;
			}
			return { kind: 'success', data: Object.freeze(counts) };
		}
	} satisfies ScheduleProposalCountsSource);
}
