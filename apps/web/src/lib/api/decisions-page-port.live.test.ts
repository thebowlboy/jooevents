import { describe, expect, test } from 'bun:test';
import type { DecisionStateRowDto } from '@jooevents/contracts';
import type { CommunicationsAuthoringPort } from './communications-authoring-port';
import type { CommunicationsReadinessPagePort } from './communications-readiness-page-port';
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
	readonly keys?: string[];
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
		async decide(decideInput, idempotencyKey) {
			input.decided?.push(decideInput);
			input.keys?.push(idempotencyKey);
			return input.result ?? {
				kind: 'success',
				data: {
					action: 'decide',
					rows: [],
					sessions: []
				},
				receipt: { id: id(62), operationName: 'decision.decide', operationVersion: 1 },
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
		async changeRound() {
			throw new Error('unexpected draft');
		},
		async stepBack() {
			throw new Error('unexpected draft');
		},
		async changeEvaluation() {
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

type CommunicationsInput = Parameters<typeof createLiveDecisionsPagePort>[0]['communications'];

const definitionRef = (key: string) => ({
	reference: { key, version: 1 },
	definitionDigestSha256: digest('e')
});
const purposeRevision = Object.freeze({
	purposeId: id(70),
	purposeKey: 'decision_notification',
	revisionId: id(71),
	revisionNumber: 1,
	digestSha256: digest('a')
});
const templateRow = (key: string, name: string) => ({
	schemaVersion: 1 as const,
	revision: {
		templateId: id(72),
		templateRevisionId: id(73),
		revisionNumber: 1,
		digestSha256: digest('b')
	},
	key,
	name,
	purposeRevision,
	channel: 'email' as const,
	lifecycle: 'active' as const,
	bodyMode: 'composed' as const,
	subjectPreview: 'Your submission decision'
});
const audienceOption = (recipeId: string, label: string) => ({
	schemaVersion: 1 as const,
	optionId: id(74),
	optionVersion: 1,
	optionDigestSha256: digest('c'),
	label,
	recipientEstimate: { knowledge: 'unknown' as const, reasonCode: 'audience.resolved_at_preview' },
	audienceDraft: {
		schemaVersion: 1 as const,
		binding: 'current_snapshot' as const,
		purposeRevision,
		source: {
			kind: 'registered_query' as const,
			recipeId,
			recipeVersion: 1,
			recipeDigestSha256: digest('d'),
			sourceDefinition: definitionRef('audience-source.communication.decision-set.accepted')
		}
	}
});
const previewSummary = (audienceSpecId: string, draftId: string, draftVersion: number) => ({
	schemaVersion: 1 as const,
	identity: {
		audienceSpecId,
		draftId,
		draftVersion,
		previewGeneration: 1,
		previewDigestProfile: 'communication.preview.sha256',
		previewDigestVersion: 1,
		previewDigestSha256: digest('f')
	},
	purposeRevision,
	counts: {
		visibleCandidateCount: 2,
		includedCount: 1,
		excludedCount: 1,
		blockedCount: 0
	},
	membershipDigestSha256: digest('1'),
	evidenceDigestSha256: digest('2'),
	reasonCodes: [],
	sourceVersions: [
		{ sourceKey: 'decision-set.accepted', sourceVersion: 2, digestSha256: digest('3') }
	],
	renderer: definitionRef('renderer.communication.plain-text'),
	mergeRegistry: definitionRef('merge-registry.communication.plain-text')
});
const payloadRef = (kind: 'message_content' | 'message_audience_draft', seed: number) => ({
	payloadRefId: id(seed),
	payloadRefVersion: 1,
	payloadKind: kind,
	schemaKey: `schema.communication.${kind}`,
	schemaVersion: 1,
	classification: 'organizer_communication'
});
const recipientRows = [
	{
		recipientResolutionId: id(80),
		safeLabel: 'Ada Lovelace',
		channel: { disclosure: 'masked' as const, maskedValue: 'a•••@example.test' },
		mergeFallbackFieldKeys: [],
		state: 'included' as const,
		releaseId: id(81),
		releaseDigestSha256: digest('4')
	},
	{
		recipientResolutionId: id(82),
		safeLabel: 'Grace Hopper',
		channel: { disclosure: 'absent' as const, reasonCode: 'address.no_eligible' },
		mergeFallbackFieldKeys: [],
		state: 'excluded' as const,
		reasonCode: 'address.no_eligible'
	}
];

/**
 * One committed batch as the delivery-history projection serves it. The
 * default is this composition's own ledger truth: every delivery registered,
 * none accepted, the batch terminally failed with the reason the provider
 * attempt itself recorded.
 */
const historyRow = (
	messageRefId: string,
	counts: { accepted: number; knownFailed: number },
	reasonCode?: string
) => ({
	schemaVersion: 1 as const,
	visibility: 'organizer_non_security' as const,
	historyItemId: id(85),
	messageRefId,
	purposeRevision,
	subject: 'Your submission decision',
	audienceLabel: 'Accepted submissions',
	state: counts.accepted > 0 ? ('accepted' as const) : ('known_failed' as const),
	...(reasonCode === undefined ? {} : { stateReasonCode: reasonCode }),
	actor: { kind: 'human' as const, displayLabel: 'Workspace operator' },
	cause: { summary: 'Committed from an adopted, reviewed decision-notification preview.' },
	counts: {
		audience: { knowledge: 'known' as const, value: counts.accepted + counts.knownFailed },
		materialized: { knowledge: 'known' as const, value: counts.accepted + counts.knownFailed },
		accepted: { knowledge: 'known' as const, value: counts.accepted },
		delivered: { knowledge: 'not_supported' as const },
		acceptanceUnknown: { knowledge: 'known' as const, value: 0 },
		knownFailed: { knowledge: 'known' as const, value: counts.knownFailed }
	},
	authorizedAt: '2026-08-13T11:05:00.000Z',
	availableActions: []
});

/**
 * Scripted fake of the mounted communication send lane. Every unexpected call
 * throws so a test states exactly which operations the loop is allowed to
 * use; calls are recorded for order and payload assertions.
 */
function fakeCommunications(overrides: Partial<CommunicationsInput> = {}): {
	readonly port: CommunicationsInput;
	readonly calls: { name: string; input: unknown }[];
} {
	const calls: { name: string; input: unknown }[] = [];
	let draftVersion = 1;
	const base: CommunicationsInput = {
		source: { kind: 'live' },
		async listTemplates(request) {
			calls.push({ name: 'listTemplates', input: request });
			return {
				kind: 'success',
				data: {
					schemaVersion: 1,
					rows: [templateRow('decision.accepted', 'Acceptance notice')],
					page: { hasMore: false }
				},
				correlationId
			} as never;
		},
		async listAudienceOptions(request) {
			calls.push({ name: 'listAudienceOptions', input: request });
			return {
				kind: 'success',
				data: {
					schemaVersion: 1,
					rows: [
						audienceOption('recipe.communication.decision-set.accepted', 'Accepted submissions')
					],
					page: { hasMore: false }
				},
				correlationId
			} as never;
		},
		async storeAuthoringPayload(payload) {
			calls.push({ name: 'storeAuthoringPayload', input: payload });
			const kind = (payload as { payloadKind: 'message_content' | 'message_audience_draft' })
				.payloadKind;
			return {
				kind: 'success',
				data: payloadRef(kind, kind === 'message_content' ? 90 : 91),
				receipt: { id: id(92), operationName: 'store_communication_authoring_payload', operationVersion: 1 },
				correlationId
			} as never;
		},
		async createDraft(request) {
			calls.push({ name: 'createDraft', input: request });
			return {
				kind: 'success',
				data: { draftId: id(93), version: 1 },
				receipt: { id: id(94), operationName: 'create_message_draft', operationVersion: 1 },
				correlationId
			} as never;
		},
		async reviseDraft(request) {
			calls.push({ name: 'reviseDraft', input: request });
			draftVersion += 1;
			return {
				kind: 'success',
				data: { draftId: id(93), version: draftVersion },
				receipt: { id: id(95), operationName: 'revise_message_batch', operationVersion: 1 },
				correlationId
			} as never;
		},
		async prepareBatchPreview(request) {
			calls.push({ name: 'prepareBatchPreview', input: request });
			const parsed = request as { draftId: string; expectedDraftVersion: number };
			return {
				kind: 'success',
				data: {
					schemaVersion: 1,
					draftId: parsed.draftId,
					draftVersion: parsed.expectedDraftVersion,
					state: 'prepared'
				},
				correlationId
			} as never;
		},
		async adoptBatchPreview(request) {
			calls.push({ name: 'adoptBatchPreview', input: request });
			const parsed = request as { draftId: string; expectedDraftVersion: number };
			return {
				kind: 'success',
				data: previewSummary(
					`audience-${parsed.expectedDraftVersion}`,
					parsed.draftId,
					parsed.expectedDraftVersion
				),
				receipt: { id: id(96), operationName: 'preview_message_batch', operationVersion: 1 },
				correlationId
			} as never;
		},
		async listPreviewRecipients(request) {
			calls.push({ name: 'listPreviewRecipients', input: request });
			return {
				kind: 'success',
				data: {
					schemaVersion: 1,
					identity: (request as { audienceSpecId: string }) as never,
					rows: recipientRows,
					page: { hasMore: false }
				},
				correlationId
			} as never;
		},
		async sendMessages(request) {
			calls.push({ name: 'sendMessages', input: request });
			const parsed = request as { batchId: string };
			return {
				kind: 'success',
				data: {
					schemaVersion: 1,
					batchId: parsed.batchId,
					dispatchGeneration: 1,
					releaseCount: 1,
					deliveryCount: 1
				},
				receipt: { id: id(98), operationName: 'send_messages', operationVersion: 1 },
				correlationId
			} as never;
		},
		async getDeliveryHistory(request) {
			calls.push({ name: 'getDeliveryHistory', input: request });
			const parsed = request as { messageRefId: string };
			return {
				kind: 'success',
				data: {
					schemaVersion: 1,
					visibility: 'organizer_non_security',
					rows: [historyRow(
						parsed.messageRefId,
						{ accepted: 0, knownFailed: 1 },
						'delivery.rejected_terminal'
					)],
					page: { hasMore: false }
				},
				correlationId
			} as never;
		},
		...overrides
	};
	return { port: base, calls };
}

const readyReadiness: Pick<CommunicationsReadinessPagePort, 'read'> = {
	async read() {
		return {
			kind: 'success',
			data: {
				schemaVersion: 1,
				outbound: { state: 'unknown', nextStepCode: 'provider.connect' },
				callbacks: { state: 'not_supported' },
				inbound: { state: 'not_enabled' }
			},
			correlationId
		} as never;
	}
};

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
		communications: fakeCommunications().port,
		readiness: readyReadiness,
		newIdempotencyKey: () => 'je.test.decisions.key',
		...overrides
	});
}

describe('live tuned Decisions page port', () => {
	test('decides with per-row guards read fresh from the Decision spine', async () => {
		const decided: unknown[] = [];
		const keys: string[] = [];
		const port = composePort({
			decisions: fakeDecisions({
				heads: [{ submissionId: id(22), head: decidedHead(id(22)), origin: null }],
				decided, keys
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
		expect(keys).toEqual(['je.test.decisions.key']);
	});

	test('carries an explicit track into accept-spawn graduation', async () => {
		const decided: unknown[] = [];
		const port = composePort({ decisions: fakeDecisions({ decided }) });
		await port.decisions.decide([id(21)], 'accepted', { [id(21)]: id(31) });
		expect(decided).toEqual([{
			action: 'decide',
			decisions: [{
				submissionId: id(21),
				state: 'accepted',
				expectedDecisionVersion: null,
				expectedDecisionDigestSha256: null,
				graduation: { kind: 'spawn', trackId: id(31) }
			}]
		}]);
	});

	test('refuses the verdicts no organizer authoring path exists for', async () => {
		const decided: unknown[] = [];
		const port = composePort({ decisions: fakeDecisions({ decided }) });
		await expect(port.decisions.decide([id(21)], 'undecided')).rejects.toMatchObject({
			name: 'DecisionsPageLiveError',
			code: 'decision_undecided_unavailable'
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

	test('reviews and sends decision notifications through the mounted send lane', async () => {
		const communications = fakeCommunications();
		const port = composePort({
			decisions: fakeDecisions({
				heads: [{
					schemaVersion: 1,
					submissionId: id(21),
					head: { ...decidedHead(id(21)), state: 'accepted' }
				} as never]
			}),
			communications: communications.port
		});

		const review = await port.decisions.reviewNotification([id(21)]);
		expect(review).toMatchObject({
			templateLabel: 'Acceptance notice @ revision 1',
			audienceLabel: 'Accepted submissions',
			binding: 'current_snapshot',
			sender: 'No outbound provider activated — deliveries will be recorded, not delivered',
			irreversibleNote: 'Email cannot be recalled after the provider accepts it.'
		});
		// Recipients are the audience truth: the disclosed label, the masked
		// or absent address as served, and the exclusion reason kept as a row.
		expect(review.recipients).toEqual([
			{ name: 'Ada Lovelace', email: 'a•••@example.test', state: 'included' },
			{ name: 'Grace Hopper', email: '', state: 'excluded', reason: 'address.no_eligible' }
		]);
		// The review adopted one preview per notifiable outcome through the
		// real lane: content + audience payloads, draft, prepare, adopt, rows.
		expect(communications.calls.map((call) => call.name)).toEqual([
			'listTemplates', 'listAudienceOptions', 'storeAuthoringPayload',
			'storeAuthoringPayload', 'createDraft', 'prepareBatchPreview',
			'adoptBatchPreview', 'listPreviewRecipients'
		]);

		// An edited subject re-authors the reviewed content and re-adopts, so
		// the sent bytes always carry the operator's final subject. What the
		// send did is then the ledger's own answer, read back through the
		// history projection: the release committed, nothing was accepted.
		const sent = await port.decisions.notify([id(21)], 'You are in!');
		expect(sent).toEqual({
			committed: 1,
			sent: 0,
			note: '1 delivery recorded, none delivered: the outbound lane rejected them outright. Result not sent stays until an activated provider accepts their delivery.'
		});
		const afterReview = communications.calls.slice(8).map((call) => call.name);
		expect(afterReview).toEqual([
			'storeAuthoringPayload', 'reviseDraft', 'prepareBatchPreview',
			'adoptBatchPreview', 'sendMessages', 'getDeliveryHistory'
		]);
		// The state is read for the batch that was just committed, by its id.
		expect(communications.calls.at(-1)!.input).toEqual({
			messageRefId: (communications.calls.at(-2)!.input as { batchId: string }).batchId
		});
		const sendCall = communications.calls.at(-2)!.input as {
			audienceSpecId: string;
			subject: string;
			audienceLabel: string;
		};
		expect(sendCall.subject).toBe('You are in!');
		expect(sendCall.audienceLabel).toBe('Accepted submissions');
		// The re-adopted preview (draft version 2) is what the send pins.
		expect(sendCall.audienceSpecId).toBe('audience-2');

		// One-shot review: a second send without reopening the dialog refuses.
		await expect(port.decisions.notify([id(21)], 'You are in!')).rejects.toMatchObject({
			code: 'decision_notification_review_required',
			retryable: false
		});
	});

	test('states an accepted send as sent, and an unreadable delivery state as unknown', async () => {
		const accepted = fakeCommunications({
			async getDeliveryHistory(request) {
				const parsed = request as { messageRefId: string };
				return {
					kind: 'success',
					data: {
						schemaVersion: 1,
						visibility: 'organizer_non_security',
						rows: [historyRow(parsed.messageRefId, { accepted: 1, knownFailed: 0 })],
						page: { hasMore: false }
					},
					correlationId
				} as never;
			}
		});
		const heads = [{
			schemaVersion: 1,
			submissionId: id(21),
			head: { ...decidedHead(id(21)), state: 'accepted' }
		} as never];
		const acceptedPort = composePort({
			decisions: fakeDecisions({ heads }),
			communications: accepted.port
		});
		await acceptedPort.decisions.reviewNotification([id(21)]);
		expect(await acceptedPort.decisions.notify([id(21)], 'Your submission decision')).toEqual({
			committed: 1,
			sent: 1,
			note: 'Every message was accepted by the outbound provider; Result not sent clears as that delivery evidence lands.'
		});

		// A refused history read is not a failed send: the commit stands and
		// the delivery state is stated as unread, never as a success.
		const unread = fakeCommunications({
			async getDeliveryHistory() {
				return {
					kind: 'unavailable',
					operation: 'get_delivery_history',
					reason: 'operation_not_mounted'
				} as never;
			}
		});
		const unreadPort = composePort({
			decisions: fakeDecisions({ heads }),
			communications: unread.port
		});
		await unreadPort.decisions.reviewNotification([id(21)]);
		expect(await unreadPort.decisions.notify([id(21)], 'Your submission decision')).toEqual({
			committed: 1,
			sent: null,
			note: 'The release is committed. Its delivery state could not be read here, so nothing about delivery is claimed and Result not sent stays until delivery evidence lands.'
		});
	});

	test('a drifted preview surfaces the typed audience-changed refusal and sends nothing', async () => {
		const communications = fakeCommunications({
			async sendMessages() {
				return {
					kind: 'outcome',
					outcome: {
						class: 'stale_revision',
						kind: 'communication.preview_changed',
						retryable: false,
						subjects: [],
						detail: { includedCount: 1 },
						detailSchemaVersion: 1
					},
					terminal: false,
					correlationId
				} as never;
			}
		});
		const port = composePort({
			decisions: fakeDecisions({
				heads: [{
					schemaVersion: 1,
					submissionId: id(21),
					head: { ...decidedHead(id(21)), state: 'accepted' }
				} as never]
			}),
			communications: communications.port
		});
		await port.decisions.reviewNotification([id(21)]);
		const failure = await port.decisions
			.notify([id(21)], 'Your submission decision')
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(DecisionsPageLiveError);
		expect((failure as DecisionsPageLiveError).code).toBe('communication.preview_changed');
		expect((failure as DecisionsPageLiveError).retryable).toBe(false);
		expect((failure as DecisionsPageLiveError).message).toContain('Reopen the notification dialog');
	});

	test('review refuses typed when no selected decision has a notifiable outcome', async () => {
		const port = composePort({
			decisions: fakeDecisions({
				heads: [{
					schemaVersion: 1,
					submissionId: id(21),
					head: decidedHead(id(21))
				} as never]
			})
		});
		await expect(port.decisions.reviewNotification([id(21)])).rejects.toMatchObject({
			code: 'decision_notification_no_notifiable_outcome',
			retryable: false
		});
		// Sending without a fresh review refuses regardless.
		await expect(port.decisions.notify([id(21)], 'Subject')).rejects.toMatchObject({
			code: 'decision_notification_review_required'
		});
	});

	test('serves the honest email readiness: no provider, outbound not ready', async () => {
		const port = composePort();
		expect(await port.communications.readiness()).toEqual({
			provider: 'No outbound provider activated',
			outbound: 'unknown',
			callbacks: 'not_applicable',
			inbound: 'not_applicable'
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
