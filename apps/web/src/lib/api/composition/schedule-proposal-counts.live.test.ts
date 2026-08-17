import { describe, expect, test } from 'bun:test';
import {
	submissionTriageListSchema,
	type SubmissionTriageListDto
} from '@jooevents/contracts/submission-triage';
import { mapSubmissionTriageList } from '../mappers/submission-triage';
import type { SubmissionTriageLiveReadResult } from '../operations/submission-triage-live';
import type { SubmissionTriagePageView } from '../mappers/submission-triage';
import {
	createLiveScheduleProposalCountsSource,
	type DecisionStateReader
} from './schedule-proposal-counts.live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const workspaceId = id(1);
const eventId = id(2);
const formId = id(3);
const formVersionId = id(4);
const correlationId = id(900);

const sessionA = id(70);
const sessionB = id(71);

type RowState = 'inbox' | 'set_aside' | 'spam';

/**
 * One canonical triage projection, coherent under the contract's own
 * superRefines (evidence cross-binding and visible-tray derivation).
 */
function row(input: {
	readonly value: number;
	readonly state: RowState;
	readonly sessionId?: string;
	readonly late?: boolean;
}) {
	const submissionId = id(input.value);
	const submittedAt = input.late ? '2026-08-13T10:01:00.000Z' : '2026-08-13T09:00:00.000Z';
	return {
		schemaVersion: 1,
		source: {
			schemaVersion: 1,
			scope: { workspaceId, eventId },
			source: 'public_form',
			summary: {
				schemaVersion: 1,
				id: submissionId,
				formId,
				formVersionId,
				target: input.sessionId
					? { kind: 'session', sessionId: input.sessionId }
					: { kind: 'general_pool' },
				title: 'A durable proposal',
				primaryParticipantName: 'Avery Stone',
				submittedAt
			},
			detail: {
				schemaVersion: 1,
				submissionId,
				formId,
				formVersionId,
				submittedAt,
				participantCount: 1,
				answers: [
					{ kind: 'textarea', fieldId: id(5), fieldLabel: 'Abstract', value: 'Practical systems.' }
				],
				affirmedConsentFieldIds: []
			},
			abstract: 'Practical systems.',
			track: null,
			format: null
		},
		triage: {
			schemaVersion: 1,
			scope: { workspaceId, eventId },
			submissionId,
			version: 4,
			state: input.state,
			setAsideAttribution:
				input.state === 'set_aside'
					? {
							kind: 'manual',
							principalKey: 'opaque:principal',
							invocationId: id(30),
							surface: 'operator_http'
						}
					: null,
			updatedAt: '2026-08-13T10:02:00.000Z'
		},
		arrival: {
			schemaVersion: 1,
			id: id(input.value + 400),
			scope: { workspaceId, eventId },
			submissionId,
			formId,
			formVersionId,
			source: 'public_form',
			submittedAt,
			classification: input.late ? 'late' : 'on_time',
			closeEvidence: input.late
				? {
						closeAt: '2026-08-13T10:00:00.000Z',
						policy: {
							reference: { key: 'intake.soft_close', version: 1 },
							definitionDigestSha256: digest('d')
						}
					}
				: null,
			recordedAt: submittedAt
		},
		visibleTray:
			input.state === 'spam'
				? 'spam'
				: input.state === 'set_aside'
					? 'set_aside'
					: input.late
						? 'late'
						: 'inbox'
	};
}

function page(
	rows: ReturnType<typeof row>[],
	trayTotals: { inbox: number; set_aside: number; late: number; spam: number }
): SubmissionTriagePageView {
	const parsed: SubmissionTriageListDto = submissionTriageListSchema.parse({
		schemaVersion: 1,
		queryGuard: {
			schemaVersion: 1,
			scope: { workspaceId, eventId },
			version: 7,
			digestSha256: digest('a')
		},
		rows,
		trayTotals,
		search: null
	});
	return mapSubmissionTriageList(parsed);
}

/**
 * Decision-state reader over a fixed decided-id set. The default serves every
 * asked id as undecided (`head: null`), which is the live spine's answer for
 * submissions no decide has ever touched.
 */
function decisionReader(
	decidedIds: readonly string[] = [],
	asked: string[][] = []
): DecisionStateReader {
	return async (submissionIds) => {
		asked.push([...submissionIds]);
		return {
			kind: 'success',
			data: {
				schemaVersion: 1,
				rows: submissionIds.map((submissionId) => ({
					submissionId,
					head: decidedIds.includes(submissionId)
						? {
								schemaVersion: 1,
								scope: { workspaceId, eventId },
								submissionId,
								state: 'accepted' as const,
								version: 1,
								digestSha256: digest('b'),
								decidedByUserId: id(31),
								decidedAt: '2026-08-13T11:00:00.000Z'
							}
						: null,
					origin: null
				}))
			},
			correlationId
		};
	};
}

function sourceOver(
	result: SubmissionTriageLiveReadResult<SubmissionTriagePageView>,
	readState: DecisionStateReader = decisionReader()
): { readonly source: ReturnType<typeof createLiveScheduleProposalCountsSource>; readonly queries: unknown[] } {
	const queries: unknown[] = [];
	const source = createLiveScheduleProposalCountsSource({
		list: async (query) => {
			queries.push(query);
			return result;
		},
		decisions: { readState }
	});
	return { source, queries };
}

describe('live schedule proposal-counts source', () => {
	test('declares a live source for the frozen schedule factory gate', () => {
		const { source } = sourceOver({
			kind: 'unavailable',
			operation: 'list',
			reason: 'operation_not_registered'
		});
		expect(source.source).toEqual({ kind: 'live' });
	});

	test('folds a proven-complete population into exact per-session counts', async () => {
		const rows = [
			// Two open proposals target session A, in different visible trays.
			row({ value: 21, state: 'inbox', sessionId: sessionA }),
			row({ value: 22, state: 'set_aside', sessionId: sessionA }),
			// A late arrival still in the inbox state counts: late is not spam.
			row({ value: 23, state: 'inbox', sessionId: sessionA, late: true }),
			// Session B's only proposal is spam (recoverable) — not open.
			row({ value: 24, state: 'spam', sessionId: sessionB }),
			// General-pool submissions target no session.
			row({ value: 25, state: 'inbox' })
		];
		const { source, queries } = sourceOver({
			kind: 'success',
			data: page(rows, { inbox: 2, set_aside: 1, late: 1, spam: 1 }),
			correlationId
		});

		const result = await source.readOpenProposalCounts();
		expect(result).toEqual({ kind: 'success', data: { [sessionA]: 3 } });
		// Session B gains no key: with a whole population, absence is the true
		// claim "no open proposals", which the tuned page renders as zero.
		expect(result.kind === 'success' && sessionB in result.data).toBe(false);
		// The completeness proof requires the unfiltered scope.
		expect(queries).toEqual([{}]);
	});

	test('excludes decided submissions from the open counts over the same proven population', async () => {
		const rows = [
			row({ value: 21, state: 'inbox', sessionId: sessionA }),
			row({ value: 22, state: 'set_aside', sessionId: sessionA }),
			// Spam rows never reach the decision read: not open regardless.
			row({ value: 24, state: 'spam', sessionId: sessionB })
		];
		const asked: string[][] = [];
		const { source } = sourceOver(
			{
				kind: 'success',
				data: page(rows, { inbox: 1, set_aside: 1, late: 0, spam: 1 }),
				correlationId
			},
			decisionReader([id(22)], asked)
		);
		expect(await source.readOpenProposalCounts()).toEqual({
			kind: 'success',
			data: { [sessionA]: 1 }
		});
		// Exactly the session-targeting, non-spam candidates were read.
		expect(asked).toEqual([[id(21), id(22)]]);
	});

	test('a failed decision read makes the count unavailable, never a decided-inclusive number', async () => {
		const rows = [row({ value: 21, state: 'inbox', sessionId: sessionA })];
		const { source } = sourceOver(
			{
				kind: 'success',
				data: page(rows, { inbox: 1, set_aside: 0, late: 0, spam: 0 }),
				correlationId
			},
			async () => ({
				kind: 'unavailable',
				operation: 'read',
				reason: 'operation_not_registered'
			})
		);
		expect(await source.readOpenProposalCounts()).toEqual({
			kind: 'unavailable',
			reason: 'operation_not_registered'
		});
	});

	test('refuses a truncated population instead of serving a row-window count', async () => {
		const rows = [row({ value: 21, state: 'inbox', sessionId: sessionA })];
		// Tray totals larger than the returned page: the population kept rows the
		// window did not serve, so no fold over the window may claim a total.
		const { source } = sourceOver({
			kind: 'success',
			data: page(rows, { inbox: 2, set_aside: 0, late: 0, spam: 0 }),
			correlationId
		});

		expect(await source.readOpenProposalCounts()).toEqual({
			kind: 'unavailable',
			reason: 'proposal_count_population_truncated'
		});
	});

	test('serves the uninitialized triage spine as the proven-empty population', async () => {
		// Triage initialization is transactional with every submission
		// acceptance, so `not_initialized` states no submission has ever been
		// accepted: the counts are exactly zero for every session.
		const { source } = sourceOver({
			kind: 'outcome',
			outcome: {
				class: 'conflict',
				kind: 'submission_triage.not_initialized',
				retryable: false,
				subjects: [],
				detail: null,
				detailSchemaVersion: 1
			},
			correlationId
		});
		expect(await source.readOpenProposalCounts()).toEqual({ kind: 'success', data: {} });
	});

	test('forwards canonical outcome, transport, and unavailable results unchanged', async () => {
		const outcome = {
			class: 'conflict' as const,
			kind: 'submission_triage.event_required',
			retryable: false,
			subjects: [],
			detail: null,
			detailSchemaVersion: 1
		};
		const { source: outcomeSource } = sourceOver({ kind: 'outcome', outcome, correlationId });
		expect(await outcomeSource.readOpenProposalCounts()).toEqual({
			kind: 'outcome',
			outcome,
			correlationId
		});

		const { source: transportSource } = sourceOver({
			kind: 'transport_error',
			error: { code: 'network_unavailable', retryable: true }
		});
		expect(await transportSource.readOpenProposalCounts()).toEqual({
			kind: 'transport_error',
			error: { code: 'network_unavailable', retryable: true }
		});

		const { source: unavailableSource } = sourceOver({
			kind: 'unavailable',
			operation: 'list',
			reason: 'operation_not_registered'
		});
		expect(await unavailableSource.readOpenProposalCounts()).toEqual({
			kind: 'unavailable',
			reason: 'operation_not_registered'
		});
	});
});
