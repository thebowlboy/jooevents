import { describe, expect, test } from 'bun:test';
import type {
	PortalEngagementDto,
	PortalSnapshotDto,
	StructuredOutcome
} from '@jooevents/contracts';
import type { PortalApi } from './gateway';
import type { PortalRefusalReason } from './view-models';
import {
	createLivePortalApi,
	livePortalSource,
	PortalPageLiveError,
	type LivePortalApi,
	type LivePortalRefusalReason
} from './portal-page-port.live';
import type {
	PortalLiveReadResult,
	PortalLiveRespondResult,
	PortalOperationsLiveClient
} from './live/operations-client';

// ---------------------------------------------------------------------------
// Frozen-port conformance, proven at the type level. The sample-derived
// `PortalApi` is the behavioral spec; the live port restates it structurally
// so the pure-live composition never imports a sample module. These proofs
// hold before and after the port's own refusal vocabulary adopts the two live
// members.
// ---------------------------------------------------------------------------

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const sameMethodNames: Mutual<keyof PortalApi, keyof LivePortalApi> = true;
void sameMethodNames;

/** Every frozen-port fulfilment (the sample api itself) fits the live shape. */
const frozenFitsLive: PortalApi extends LivePortalApi ? true : false = true;
void frozenFitsLive;

type InputsOf<Api> = {
	[K in keyof Api]: Api[K] extends (...args: infer A) => unknown ? A : never;
};
const sameInputs: Mutual<InputsOf<PortalApi>, InputsOf<LivePortalApi>> = true;
void sameInputs;

/** The one divergence is the documented live refusal vocabulary, nothing else. */
const refusalDeltaIsExactlyTheLiveWords: [
	Exclude<LivePortalRefusalReason, PortalRefusalReason>
] extends ['portal_not_served' | 'request_unconfirmed']
	? true
	: false = true;
void refusalDeltaIsExactlyTheLiveWords;
const frozenReasonsAllServe: PortalRefusalReason extends LivePortalRefusalReason ? true : false =
	true;
void frozenReasonsAllServe;

type SuccessData<Api, K extends keyof Api> = Api[K] extends (
	...args: never[]
) => Promise<infer R>
	? Extract<R, { readonly ok: true }> extends { readonly data: infer Data }
		? Data
		: never
	: never;

const sameReadReturns: Mutual<
	[
		Awaited<ReturnType<PortalApi['snapshot']>>,
		Awaited<ReturnType<PortalApi['submission']>>
	],
	[
		Awaited<ReturnType<LivePortalApi['snapshot']>>,
		Awaited<ReturnType<LivePortalApi['submission']>>
	]
> = true;
void sameReadReturns;

const sameSuccessPayloads: Mutual<
	[
		SuccessData<PortalApi, 'editAnswers'>,
		SuccessData<PortalApi, 'withdrawSubmission'>,
		SuccessData<PortalApi, 'appealDecision'>,
		SuccessData<PortalApi, 'respondToEngagement'>,
		SuccessData<PortalApi, 'completeTask'>,
		SuccessData<PortalApi, 'saveProfileField'>,
		SuccessData<PortalApi, 'requestProfileChange'>
	],
	[
		SuccessData<LivePortalApi, 'editAnswers'>,
		SuccessData<LivePortalApi, 'withdrawSubmission'>,
		SuccessData<LivePortalApi, 'appealDecision'>,
		SuccessData<LivePortalApi, 'respondToEngagement'>,
		SuccessData<LivePortalApi, 'completeTask'>,
		SuccessData<LivePortalApi, 'saveProfileField'>,
		SuccessData<LivePortalApi, 'requestProfileChange'>
	]
> = true;
void sameSuccessPayloads;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const correlationId = id(900);

const personId = id(20);
const coSpeakerPersonId = id(21);
const engagementId = id(40);
const submissionId = id(30);

/** A moment inside the fixture event's CFP window. */
const NOW = Date.parse('2026-08-14T12:00:00.000Z');

function snapshotDto(): PortalSnapshotDto {
	return {
		schemaVersion: 1,
		participant: { id: personId, displayName: 'Maya Kern', email: 'maya@example.test' },
		event: {
			id: id(2),
			name: 'JooConf 2026',
			timezone: 'Europe/Helsinki',
			cfpClosesAt: '2026-09-01T12:00:00.000Z',
			closePolicy: 'soft'
		},
		submissions: [
			{
				id: submissionId,
				title: 'Signals in practice',
				formVersion: 1,
				answers: [{ fieldId: id(60), label: 'Abstract', value: 'On signals.' }],
				target: { kind: 'new_session' },
				status: 'submitted',
				statusNotifiedAt: null,
				submittedAt: '2026-08-01T08:00:00.000Z',
				editableUntilClose: true,
				late: false,
				speakers: [
					{ participantId: personId, displayName: 'Maya Kern' },
					{ participantId: coSpeakerPersonId, displayName: 'Ana Ruiz' }
				],
				speakerAuthority: 'any_participant_acts',
				appeal: { kind: 'unavailable' },
				timeline: [
					{
						id: id(70),
						occurredAt: '2026-08-01T08:00:00.000Z',
						actor: 'you',
						kind: 'submitted',
						summary: 'You submitted this.'
					}
				]
			}
		],
		engagements: [invitedEngagementDto()],
		tasks: [],
		files: [
			{
				id: id(80),
				name: 'slides.pdf',
				sizeBytes: 1024,
				version: 1,
				uploadedAt: '2026-08-02T08:00:00.000Z',
				taskId: null
			}
		],
		resources: [],
		profile: {
			fields: [
				{
					id: id(85),
					label: 'Display name',
					value: 'Maya Kern',
					kind: 'text',
					access: { kind: 'locked', reason: 'organizer_managed', changeRequested: false }
				}
			]
		}
	};
}

function invitedEngagementDto(): PortalEngagementDto {
	return {
		id: engagementId,
		sessionId: id(10),
		sessionTitle: 'Signals in practice',
		submissionId,
		status: 'invited',
		invitedAt: '2026-08-01T09:00:00.000Z',
		respondBy: null,
		confirmation: null,
		speakers: [
			{ participantId: personId, displayName: 'Maya Kern' },
			{ participantId: coSpeakerPersonId, displayName: 'Ana Ruiz' }
		]
	};
}

function confirmedEngagementDto(): PortalEngagementDto {
	return {
		...invitedEngagementDto(),
		status: 'confirmed',
		confirmation: { by: 'you', at: '2026-08-14T12:00:01.000Z' }
	};
}

function refusal(kind: string, klass: StructuredOutcome['class']): StructuredOutcome {
	return {
		class: klass,
		kind,
		retryable: false,
		subjects: [],
		detail: null,
		detailSchemaVersion: 1
	};
}

function stubOperations(handlers: {
	readonly snapshot?: () => PortalLiveReadResult<PortalSnapshotDto>;
	readonly respond?: (input: {
		readonly engagementId: string;
		readonly response: 'confirm' | 'decline';
	}) => PortalLiveRespondResult;
}) {
	const calls = { snapshot: 0, respond: 0 };
	const respondKeys: string[] = [];
	const client: PortalOperationsLiveClient = {
		async readSnapshot() {
			calls.snapshot += 1;
			return (
				handlers.snapshot?.()
				?? { kind: 'success', data: snapshotDto(), correlationId }
			);
		},
		async respondToEngagement(input, idempotencyKey) {
			calls.respond += 1;
			respondKeys.push(idempotencyKey);
			return (
				handlers.respond?.(input)
				?? {
					kind: 'outcome',
					outcome: refusal('portal.unknown_record', 'access_denied'),
					terminal: true,
					receipt: {
						id: id(100),
						operationName: 'portal.engagement.respond',
						operationVersion: 1
					},
					correlationId
				}
			);
		}
	};
	return { client, calls, respondKeys };
}

function liveApi(handlers: Parameters<typeof stubOperations>[0] = {}) {
	const stub = stubOperations(handlers);
	const api = createLivePortalApi({ operations: stub.client, now: () => NOW });
	return { api, ...stub };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('live portal page port — snapshot', () => {
	test('projects the served world exactly, with the honestly empty task list', async () => {
		const { api } = liveApi();
		const snapshot = await api.snapshot();
		expect(snapshot.participant).toEqual({
			id: personId,
			displayName: 'Maya Kern',
			email: 'maya@example.test'
		});
		expect(snapshot.event.cfpOpen).toBe(true);
		expect(snapshot.tasks).toEqual([]);
		expect(snapshot.files).toHaveLength(1);
		const submission = snapshot.submissions[0]!;
		expect(submission.editability).toEqual({
			kind: 'open',
			closesAt: '2026-09-01T12:00:00.000Z'
		});
		expect(submission.sharedAuthority).toBe(true);
		expect(submission.speakers.map((speaker) => [speaker.displayName, speaker.isYou]))
			.toEqual([
				['Maya Kern', true],
				['Ana Ruiz', false]
			]);
		const engagement = snapshot.engagements[0]!;
		expect(engagement.awaitingYou).toBe(true);
		expect(engagement.sharedAuthority).toBe(true);
	});

	test('submission() answers from the same world, null for a record outside it', async () => {
		const { api } = liveApi();
		expect((await api.submission(submissionId))?.title).toBe('Signals in practice');
		expect(await api.submission(id(31))).toBeNull();
	});

	test('a transport failure throws the reviewed retryable read error', async () => {
		const { api } = liveApi({
			snapshot: () => ({
				kind: 'transport_error',
				error: { code: 'network_unavailable', retryable: true }
			})
		});
		expect(api.snapshot()).rejects.toMatchObject({
			name: 'PortalPageLiveError',
			code: 'network_unavailable',
			retryable: true
		});
	});

	test('an unserved operation throws terminal — a retry cannot mount it', async () => {
		const { api } = liveApi({
			snapshot: () => ({
				kind: 'unavailable',
				operation: 'snapshot',
				reason: 'operation_not_registered'
			})
		});
		expect(api.snapshot()).rejects.toMatchObject({
			code: 'operation_not_registered',
			retryable: false
		});
	});

	test('lost authority throws terminal with its own sentence, never a fabricated world', async () => {
		const { api } = liveApi({
			snapshot: () => ({
				kind: 'outcome',
				outcome: refusal('authority.revoked', 'access_denied'),
				correlationId
			})
		});
		expect(api.snapshot()).rejects.toMatchObject({
			code: 'authority.revoked',
			retryable: false
		});
	});

	test('read failures are PortalPageLiveError instances with reviewed copy', async () => {
		const { api } = liveApi({
			snapshot: () => ({
				kind: 'transport_error',
				error: { code: 'request_timeout', retryable: true }
			})
		});
		try {
			await api.snapshot();
			throw new Error('expected the read to throw');
		} catch (error) {
			expect(error).toBeInstanceOf(PortalPageLiveError);
			expect((error as PortalPageLiveError).message.length).toBeGreaterThan(0);
		}
	});
});

// ---------------------------------------------------------------------------
// The served act
// ---------------------------------------------------------------------------

describe('live portal page port — respondToEngagement', () => {
	test('a successful response maps to the refreshed engagement view for this viewer', async () => {
		const { api, respondKeys } = liveApi({
			respond: (input) => {
				expect(input).toEqual({ engagementId, response: 'confirm' });
				return {
					kind: 'success',
					data: confirmedEngagementDto(),
					receipt: {
						id: id(100),
						operationName: 'portal.engagement.respond',
						operationVersion: 1
					},
					correlationId
				};
			}
		});
		await api.snapshot();
		const outcome = await api.respondToEngagement({ engagementId, response: 'confirm' });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error('expected success');
		expect(outcome.data.status).toBe('confirmed');
		expect(outcome.data.confirmation).toEqual({ by: 'you', at: '2026-08-14T12:00:01.000Z' });
		expect(outcome.data.speakers.map((speaker) => [speaker.displayName, speaker.isYou]))
			.toEqual([
				['Maya Kern', true],
				['Ana Ruiz', false]
			]);
		expect(respondKeys).toHaveLength(1);
		expect(respondKeys[0]).toMatch(/^je\.portal\.respond\./);
	});

	test('every attempt carries its own fresh idempotency key', async () => {
		const { api, respondKeys } = liveApi({
			respond: () => ({
				kind: 'success',
				data: confirmedEngagementDto(),
				receipt: {
					id: id(100),
					operationName: 'portal.engagement.respond',
					operationVersion: 1
				},
				correlationId
			})
		});
		await api.snapshot();
		await api.respondToEngagement({ engagementId, response: 'confirm' });
		await api.respondToEngagement({ engagementId, response: 'confirm' });
		expect(respondKeys).toHaveLength(2);
		expect(new Set(respondKeys).size).toBe(2);
	});

	test('without a prior read it resolves the viewer once, then acts', async () => {
		const { api, calls } = liveApi({
			respond: () => ({
				kind: 'success',
				data: confirmedEngagementDto(),
				receipt: {
					id: id(100),
					operationName: 'portal.engagement.respond',
					operationVersion: 1
				},
				correlationId
			})
		});
		const outcome = await api.respondToEngagement({ engagementId, response: 'confirm' });
		expect(outcome.ok).toBe(true);
		expect(calls.snapshot).toBe(1);
		expect(calls.respond).toBe(1);
	});

	test('when no viewer can be resolved the act is not attempted and stays unconfirmed', async () => {
		const { api, calls } = liveApi({
			snapshot: () => ({
				kind: 'transport_error',
				error: { code: 'network_unavailable', retryable: true }
			})
		});
		expect(await api.respondToEngagement({ engagementId, response: 'confirm' })).toEqual({
			ok: false,
			reason: 'request_unconfirmed'
		});
		expect(calls.respond).toBe(0);
	});

	test('the lane’s uniform refusals map onto the port’s own vocabulary', async () => {
		const cases: readonly [StructuredOutcome, LivePortalRefusalReason][] = [
			[refusal('portal.unknown_record', 'access_denied'), 'unknown_record'],
			[refusal('authority.session_missing', 'access_denied'), 'unknown_record'],
			[refusal('authority.revoked', 'access_denied'), 'unknown_record'],
			[refusal('portal.engagement_not_open', 'conflict'), 'engagement_not_open']
		];
		for (const [outcome, reason] of cases) {
			const { api } = liveApi({
				respond: () => ({
					kind: 'outcome',
					outcome,
					terminal: true,
					receipt: {
						id: id(100),
						operationName: 'portal.engagement.respond',
						operationVersion: 1
					},
					correlationId
				})
			});
			await api.snapshot();
			expect(await api.respondToEngagement({ engagementId, response: 'decline' })).toEqual({
				ok: false,
				reason
			});
		}
	});

	test('a manifest-proven unserved respond act is the same typed absence as the unserved acts', async () => {
		// Every binding-resolution reason is a deterministic manifest fact —
		// zero requests sent — so the answer is the lane's typed absence, not
		// an invitation to retry against a client-known refusal. Two
		// representative reasons; the mapping branches on the kind alone.
		const reasons = ['operation_not_registered', 'operation_contract_mismatch'] as const;
		for (const reason of reasons) {
			const { api } = liveApi({
				respond: () => ({ kind: 'unavailable', operation: 'respond', reason })
			});
			await api.snapshot();
			expect(await api.respondToEngagement({ engagementId, response: 'confirm' })).toEqual({
				ok: false,
				reason: 'portal_not_served'
			});
		}
	});

	test('a failure with no trustworthy answer resolves request_unconfirmed, never a fabricated refusal', async () => {
		const outcomes: readonly PortalLiveRespondResult[] = [
			{ kind: 'transport_error', error: { code: 'network_unavailable', retryable: true } },
			{ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } },
			{
				kind: 'outcome',
				outcome: {
					class: 'conflict',
					kind: 'operation.in_progress',
					retryable: true,
					subjects: [],
					detail: null,
					detailSchemaVersion: 1
				},
				terminal: false,
				correlationId
			},
			{
				kind: 'outcome',
				outcome: refusal('operation.request_changed', 'idempotency_conflict'),
				terminal: false,
				correlationId
			}
		];
		for (const result of outcomes) {
			const { api } = liveApi({ respond: () => result });
			await api.snapshot();
			expect(await api.respondToEngagement({ engagementId, response: 'confirm' })).toEqual({
				ok: false,
				reason: 'request_unconfirmed'
			});
		}
	});
});

// ---------------------------------------------------------------------------
// Typed absences
// ---------------------------------------------------------------------------

describe('live portal page port — unserved acts stay typed absences', () => {
	test('every unserved change resolves portal_not_served without touching the transport', async () => {
		const { api, calls } = liveApi();
		const results = await Promise.all([
			api.editAnswers({ submissionId, answers: [{ fieldId: id(60), value: 'Edited.' }] }),
			api.withdrawSubmission(submissionId),
			api.appealDecision({ submissionId, reason: 'Please look again.' }),
			api.completeTask({ taskId: id(50) }),
			api.saveProfileField({ fieldId: id(85), value: 'Maya K.' }),
			api.requestProfileChange({ fieldId: id(85) })
		]);
		for (const result of results) {
			expect(result).toEqual({ ok: false, reason: 'portal_not_served' });
		}
		expect(calls.snapshot).toBe(0);
		expect(calls.respond).toBe(0);
	});
});

describe('live portal source', () => {
	test('names itself live so the shell’s sample notice never renders over real data', () => {
		expect(livePortalSource).toEqual({ kind: 'live' });
	});
});
