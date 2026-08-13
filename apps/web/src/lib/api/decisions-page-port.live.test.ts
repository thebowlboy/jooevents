import { describe, expect, test } from 'bun:test';
import type { DecisionStateRowDto } from '@jooevents/contracts';
import {
	createLiveDecisionsPagePort,
	DecisionsPageLiveError
} from './decisions-page-port.live';
import type {
	DecisionsLiveClient,
	DecisionsLiveDecideResult
} from './operations/decisions-live';
import type { ReviewCorePort } from './review-core-port';
import type { ReviewSnapshotView } from './view-models/review';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import type { ScheduleState } from './types';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const correlationId = id(900);
const workspaceId = id(1);
const eventId = id(2);

function decidedHead(submissionId: string) {
	return {
		schemaVersion: 1 as const,
		scope: { workspaceId, eventId },
		submissionId,
		state: 'waitlisted' as const,
		version: 4,
		digestSha256: digest('c'),
		decidedByUserId: id(31),
		decidedAt: '2026-08-13T11:00:00.000Z'
	};
}

function fakeDecisions(input: {
	readonly heads?: readonly DecisionStateRowDto[];
	readonly decided?: unknown[];
	readonly result?: DecisionsLiveDecideResult;
}): DecisionsLiveClient {
	return {
		async readState(submissionIds) {
			return {
				kind: 'success',
				data: {
					schemaVersion: 1,
					rows: submissionIds.map((submissionId) =>
						input.heads?.find((row) => row.submissionId === submissionId)
							?? { submissionId, head: null, origin: null })
				},
				correlationId
			};
		},
		async decide(decideInput) {
			input.decided?.push(decideInput);
			return input.result ?? {
				kind: 'success',
				data: {
					changesetId: id(60),
					revisionId: id(61),
					revisionDigest: digest('b'),
					committedHeadVersion: 2,
					safeDiff: { action: 'decide', rows: [] } as never
				},
				receipt: { id: id(62), operationName: 'changeset.commit', operationVersion: 1 },
				correlationId
			};
		}
	};
}

function reviewCore(snapshot: Partial<ReviewSnapshotView> = {}): ReviewCorePort {
	const served: ReviewSnapshotView = {
		schemaVersion: 1,
		viewer: { kind: 'organizer' },
		plans: [],
		standings: {},
		...snapshot
	} as ReviewSnapshotView;
	return {
		source: { kind: 'live' },
		async readSnapshot() {
			return { kind: 'success', data: served, correlationId };
		},
		async readRoundSetup() {
			throw new Error('unexpected round setup read');
		},
		async draftRoundChange() {
			throw new Error('unexpected draft');
		},
		async draftStepBack() {
			throw new Error('unexpected draft');
		},
		async draftEvaluationChange() {
			throw new Error('unexpected draft');
		},
		async saveEvaluationDraft() {
			throw new Error('unexpected save');
		}
	};
}

const vocabulary: Pick<ProgramVocabularySettingsPort, 'source' | 'tracks'> = {
	source: { kind: 'live' },
	async tracks() {
		return [];
	}
} as never;

function composePort(overrides: Partial<Parameters<typeof createLiveDecisionsPagePort>[0]> = {}) {
	return createLiveDecisionsPagePort({
		decisions: fakeDecisions({}),
		review: reviewCore(),
		vocabulary,
		settings: { get: async () => null },
		schedule: {
			state: async () => ({
				days: [], rooms: [], dayStart: '00:00', slotMinutes: 30, slotsPerDay: 0,
				sessions: [], placements: [], breaks: [], published: false
			}) satisfies ScheduleState as ScheduleState
		},
		submissions: { list: async () => ({ rows: [], trayTotals: { inbox: 0, 'set-aside': 0, late: 0, discarded: 0 } }) },
		newIdempotencyKey: () => 'je.test.decisions.key',
		...overrides
	});
}

describe('live tuned Decisions page port', () => {
	test('decides with per-row guards read fresh from the Decision spine', async () => {
		const decided: unknown[] = [];
		const port = composePort({
			decisions: fakeDecisions({
				heads: [{ submissionId: id(22), head: decidedHead(id(22)), origin: null }],
				decided
			})
		});
		await port.decisions.decide([id(21), id(22)], 'accepted');
		expect(decided).toEqual([{
			action: 'decide',
			decisions: [
				{
					submissionId: id(21),
					state: 'accepted',
					expectedDecisionVersion: null,
					expectedDecisionDigestSha256: null
				},
				{
					submissionId: id(22),
					state: 'accepted',
					expectedDecisionVersion: 4,
					expectedDecisionDigestSha256: digest('c')
				}
			]
		}]);
	});

	test('refuses the verdicts no organizer authoring path exists for', async () => {
		const decided: unknown[] = [];
		const port = composePort({ decisions: fakeDecisions({ decided }) });
		await expect(port.decisions.decide([id(21)], 'undecided')).rejects.toMatchObject({
			name: 'DecisionsPageLiveError',
			code: 'decision_undo_to_undecided'
		});
		await expect(port.decisions.decide([id(21)], 'withdrawn')).rejects.toMatchObject({
			code: 'decision_withdrawn_authoring'
		});
		expect(decided).toEqual([]);
	});

	test('surfaces the typed target_unavailable refusal as the recorded re-offer', async () => {
		const port = composePort({
			decisions: fakeDecisions({
				result: {
					kind: 'outcome',
					outcome: {
						class: 'conflict',
						kind: 'decision.target_unavailable',
						retryable: false,
						subjects: [],
						detail: { reason: 'target_graduated', exits: ['retarget', 'spawn'] },
						detailSchemaVersion: 1
					},
					terminal: false,
					correlationId
				}
			})
		});
		const failure = await port.decisions.decide([id(21)], 'accepted').catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(DecisionsPageLiveError);
		expect((failure as DecisionsPageLiveError).code).toBe('decision.target_unavailable');
		expect((failure as DecisionsPageLiveError).message).toBe(
			'The session this proposal targeted has already graduated into the program. Re-target it at another collecting session, or accept it as a new session in the program pool.'
		);
		// The identical accept refuses identically: the surface renders the two
		// decided exits, never a retry affordance.
		expect((failure as DecisionsPageLiveError).retryable).toBe(false);
	});

	test('notification affordances stay typed refusals — decisions recorded, nothing sent', async () => {
		const port = composePort();
		await expect(port.decisions.reviewNotification([id(21)])).rejects.toMatchObject({
			code: 'decision_notification_review',
			// An unmounted capability cannot appear on retry; the surface renders
			// the refusal terminally instead of a loading or retry treatment.
			retryable: false
		});
		await expect(port.decisions.notify([id(21)], 'Subject')).rejects.toMatchObject({
			code: 'decision_notification_send'
		});
		await expect(port.communications.readiness()).rejects.toMatchObject({
			code: 'decision_notification_review'
		});
	});

	test('serves aggregates only: per-review evidence refuses, absences stay typed', async () => {
		const port = composePort();
		await expect(port.review.forSubmission(id(21))).rejects.toMatchObject({
			code: 'decision_review_evidence',
			retryable: false
		});
		expect(await port.review.myQueue()).toEqual([]);
		expect(await port.review.accoladeDefs()).toEqual([]);
		expect(await port.review.plans()).toEqual([]);
		expect(await port.templates.list()).toEqual({ messages: [] });
		expect(await port.speakers.profile('a@example.test')).toBeNull();
		expect(await port.settings.get()).toBeNull();
		expect(port.workspace.decisionAttentionExpectedSnapshot()).toBeNull();
	});
});
