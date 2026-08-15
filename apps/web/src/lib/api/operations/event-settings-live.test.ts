import { describe, expect, test } from 'bun:test';
import {
	EVENT_SETTINGS_OPERATION_SCHEMA_REFS,
	committedChangesetOperationResultSchema,
	currentEventSettingsReadResultSchema,
	eventSettingsUpdateDraftOperationResultSchema,
	proposedChangesetOperationResultSchema,
	safeOperationManifestSchema,
	type EventSettingsSafeDiff,
	type EventSettingsUpdateDraftOperationResult,
	type OperationEffect,
	type SafeOperationManifest,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import { CHANGESET_REVIEW_OPERATIONS } from '../changesets/live';
import {
	createEventSettingsLiveClient,
	EVENT_SETTINGS_CURRENT_READ_OPERATION,
	EVENT_SETTINGS_UPDATE_DRAFT_OPERATION,
	type EventSettingsLiveClient,
	type EventSettingsLiveUpdateResult,
	type EventSettingsRequester
} from './event-settings-live';

/** Reads an expectation with ordinary spaces against the real non-breaking bytes. */
const span = (text: string): string =>
	text.replaceAll(' ', '\u00a0').replace(/(\d)\u2013(\d)/gu, '$1\u2060\u2013\u2060$2');

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const correlationId = id(900);
const eventId = id(1);
const changesetId = id(2);
const revisionId = id(3);
const revisionDigest = digest('a');

const before = Object.freeze({
	schemaVersion: 1 as const,
	eventId,
	eventSetVersion: 3,
	eventVersion: 4,
	name: 'JooEvents Assembly',
	timezone: 'Asia/Singapore',
	startDate: '2027-03-18',
	endDate: '2027-03-20',
	location: 'Singapore',
	venueNote: 'Use the west entrance.',
	dayStart: '09:00',
	dayEnd: '18:00',
	slotMinutes: 30 as const
});

const updateInput = Object.freeze({
	expectedEventId: eventId,
	expectedEventSetVersion: 3,
	expectedEventVersion: 4,
	name: 'JooEvents Assembly Live',
	timezone: 'Asia/Singapore',
	startDate: '2027-03-18',
	endDate: '2027-03-21',
	location: 'Suntec Convention Centre',
	venueNote: 'Registration opens on Level 2.',
	dayStart: '08:30',
	dayEnd: '17:30',
	slotMinutes: 30 as const
});

const after = Object.freeze({
	schemaVersion: 1 as const,
	eventId,
	eventSetVersion: 3,
	eventVersion: 5,
	name: updateInput.name,
	timezone: updateInput.timezone,
	startDate: updateInput.startDate,
	endDate: updateInput.endDate,
	location: updateInput.location,
	venueNote: updateInput.venueNote,
	dayStart: updateInput.dayStart,
	dayEnd: updateInput.dayEnd,
	slotMinutes: updateInput.slotMinutes
});

const safeDiff: EventSettingsSafeDiff = Object.freeze({
	action: 'update',
	before,
	after,
	selection: Object.freeze({ eventId, eventSetVersion: 3 })
});

const readSuccess = currentEventSettingsReadResultSchema.parse({
	kind: 'success',
	data: before,
	correlationId
});

function draftSuccess(input: {
	readonly diff?: EventSettingsSafeDiff;
	readonly approval?: 'none' | 'distinct_current_human';
} = {}): EventSettingsUpdateDraftOperationResult {
	return eventSettingsUpdateDraftOperationResultSchema.parse({
		kind: 'success',
		data: {
			schemaVersion: 1,
			action: 'update',
			changesetId,
			headVersion: 1,
			status: 'draft',
			revision: { id: revisionId, number: 1, digestSha256: revisionDigest },
			riskTier: 'low',
			approvalPolicy: {
				reference: { key: 'event.settings.ordinary', version: 1 },
				definitionDigestSha256: digest('b'),
				requirement: input.approval ?? 'none'
			},
			safeDiff: input.diff ?? safeDiff
		},
		receipt: {
			id: id(4),
			operationName: EVENT_SETTINGS_UPDATE_DRAFT_OPERATION.name,
			operationVersion: EVENT_SETTINGS_UPDATE_DRAFT_OPERATION.version
		},
		correlationId
	});
}

function changesetDiff(overrides: Record<string, unknown> = {}) {
	return {
		changesetId,
		headVersion: 2,
		status: 'proposed' as const,
		revisionId,
		revisionNumber: 1,
		revisionDigest,
		riskTier: 'low' as const,
		approvalPolicy: {
			reference: { key: 'event.settings.ordinary', version: 1 },
			definitionDigestSha256: digest('b'),
			requirement: 'none' as const
		},
		operations: [{
			kind: 'event.settings.update',
			version: 1,
			riskTier: 'low' as const,
			dependencyGroup: 'event_settings',
			safeDiff,
			consequences: ['event_settings_changed']
		}],
		...overrides
	};
}

function proposeSuccess(overrides: Record<string, unknown> = {}) {
	return proposedChangesetOperationResultSchema.parse({
		kind: 'success',
		data: {
			schemaVersion: 1,
			action: 'propose',
			diff: changesetDiff(overrides)
		},
		receipt: {
			id: id(5),
			operationName: CHANGESET_REVIEW_OPERATIONS.propose.name,
			operationVersion: CHANGESET_REVIEW_OPERATIONS.propose.version
		},
		correlationId
	});
}

function commitSuccess(overrides: Record<string, unknown> = {}) {
	return committedChangesetOperationResultSchema.parse({
		kind: 'success',
		data: {
			schemaVersion: 1,
			action: 'commit',
			changesetId,
			expectedHeadVersion: 2,
			committedHeadVersion: 3,
			revisionId,
			revisionDigest,
			...overrides
		},
		receipt: {
			id: id(6),
			operationName: CHANGESET_REVIEW_OPERATIONS.commit.name,
			operationVersion: CHANGESET_REVIEW_OPERATIONS.commit.version
		},
		correlationId
	});
}

const EXPECTED_OPERATIONS = Object.freeze({
	read: Object.freeze({
		...EVENT_SETTINGS_CURRENT_READ_OPERATION,
		effect: 'read' as const,
		method: 'GET' as const,
		input: 'query' as const,
		idempotencyRequired: false,
		...EVENT_SETTINGS_OPERATION_SCHEMA_REFS.currentRead,
		path: '/api/events/current/settings'
	}),
	draft: Object.freeze({
		...EVENT_SETTINGS_UPDATE_DRAFT_OPERATION,
		effect: 'draft' as const,
		method: 'POST' as const,
		input: 'body' as const,
		idempotencyRequired: true,
		...EVENT_SETTINGS_OPERATION_SCHEMA_REFS.updateDraft,
		path: '/api/events/current/settings/drafts/update'
	}),
	propose: Object.freeze({
		...CHANGESET_REVIEW_OPERATIONS.propose,
		path: '/api/changesets/proposals'
	}),
	commit: Object.freeze({
		...CHANGESET_REVIEW_OPERATIONS.commit,
		path: '/api/changesets/commits'
	})
});

type OperationKey = keyof typeof EXPECTED_OPERATIONS;

function operation(
	key: OperationKey,
	overrides: Partial<SafeOperationManifestEntry> = {}
): SafeOperationManifestEntry {
	const expected = EXPECTED_OPERATIONS[key];
	const effect = expected.effect as OperationEffect;
	return {
		name: expected.name,
		version: expected.version,
		lifecycle: { status: 'active' },
		summary: `Execute ${expected.name}.`,
		effect,
		maxRisk: effect === 'commit' ? 'consequential' : effect === 'read' ? 'low' : 'normal',
		autonomy: {
			policy: { key: `autonomy.${expected.name}`, version: 1 },
			riskFloor: 'low',
			unattendedRiskCeiling: 'normal',
			requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'],
			triggerDispositions: {
				authority_lost: 'block',
				unattended_bounds_exceeded: 'block',
				approval_required: 'block',
				known_retryable_failure: 'block',
				ambiguous_external_effect: 'block',
				stale_plan: 'block',
				compensation_required: 'block',
				terminal_failure: 'block'
			}
		},
		consequenceTags: [],
		inputSchema: expected.inputSchema,
		idempotency: expected.idempotencyRequired
			? {
					required: true,
					keySource: { key: 'idempotency.operator_header', version: 1 },
					credentialVerifierProfile: { key: 'credential.idempotency', version: 1 },
					requestHashProfile: { key: `request_hash.${expected.name}`, version: 1 }
				}
			: { required: false },
		concurrency: effect === 'read'
			? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: `concurrency.${expected.name}`, version: 1 } },
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http',
			protocol: 'http',
			method: expected.method,
			path: expected.path,
			input: expected.input,
			resultSchema: expected.resultSchema,
			browserResumption: { kind: 'none' }
		}],
		...overrides
	};
}

function manifest(
	keys: readonly OperationKey[] = ['read', 'draft', 'propose', 'commit'],
	overrides: Partial<Record<OperationKey, Partial<SafeOperationManifestEntry>>> = {}
): SafeOperationManifest {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('f'),
		operations: keys.map((key) => operation(key, overrides[key]))
	});
}

interface RecordedCall {
	readonly path: string;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
}

function requester(input: {
	readonly calls: RecordedCall[];
	readonly payloads?: Readonly<Record<string, unknown>>;
}): EventSettingsRequester {
	const payloads = input.payloads ?? {
		[EXPECTED_OPERATIONS.read.path]: readSuccess,
		[EXPECTED_OPERATIONS.draft.path]: draftSuccess(),
		[EXPECTED_OPERATIONS.propose.path]: proposeSuccess(),
		[EXPECTED_OPERATIONS.commit.path]: commitSuccess()
	};
	return async (requestInput) => {
		input.calls.push(requestInput as RecordedCall);
		return { kind: 'success', data: payloads[requestInput.path] };
	};
}

function noAuthorityInputSurface(_client: EventSettingsLiveClient): void {
	type ReadOptions = NonNullable<Parameters<EventSettingsLiveClient['read']>[0]>;
	type UpdateInput = Parameters<EventSettingsLiveClient['update']>[0];
	type Forbidden = Extract<
		keyof ReadOptions | keyof UpdateInput,
		'actor' | 'scope' | 'authority' | 'approval' | 'role' | 'workspaceId'
	>;
	const forbidden: readonly Forbidden[] = [];
	expect(forbidden).toEqual([]);
}

describe('pure-live Event Settings operation client', () => {
	test('binds canonical read and update through draft, propose, and commit', async () => {
		const calls: RecordedCall[] = [];
		const client = createEventSettingsLiveClient({
			manifest: manifest(),
			request: requester({ calls })
		});
		noAuthorityInputSurface(client);

		expect(await client.read()).toEqual({
			kind: 'success',
			data: {
				eventId,
				eventSetVersion: 3,
				eventVersion: 4,
				name: before.name,
				timezone: before.timezone,
				startDate: before.startDate,
				endDate: before.endDate,
				location: before.location,
				venueNote: before.venueNote,
				dayStart: before.dayStart,
				dayEnd: before.dayEnd,
				slotMinutes: before.slotMinutes,
				dates: span('18–20 Mar 2027')
			},
			correlationId
		});

		const first = await client.update(updateInput, 'settings-save-1');
		const replay = await client.update(updateInput, 'settings-save-1');
		expect(first).toMatchObject({
			kind: 'success',
			data: {
				changesetId,
				revisionId,
				revisionDigest,
				committedHeadVersion: 3,
				settings: {
					name: after.name,
					location: after.location,
					eventVersion: 5,
					dates: span('18–21 Mar 2027')
				},
				safeDiff
			},
			receipt: {
				operationName: CHANGESET_REVIEW_OPERATIONS.commit.name,
				operationVersion: CHANGESET_REVIEW_OPERATIONS.commit.version
			},
			correlationId
		});
		expect(replay).toEqual(first);

		expect(calls.map((call) => call.path)).toEqual([
			EXPECTED_OPERATIONS.read.path,
			EXPECTED_OPERATIONS.draft.path,
			EXPECTED_OPERATIONS.propose.path,
			EXPECTED_OPERATIONS.commit.path,
			EXPECTED_OPERATIONS.draft.path,
			EXPECTED_OPERATIONS.propose.path,
			EXPECTED_OPERATIONS.commit.path
		]);
		expect(calls[1]?.body).toEqual(updateInput);
		expect(calls[2]?.body).toEqual({
			changesetId, revisionId, revisionDigest, expectedHeadVersion: 1
		});
		expect(calls[3]?.body).toEqual({
			changesetId, revisionId, revisionDigest, expectedHeadVersion: 2
		});
		const firstKeys = calls.slice(1, 4).map((call) => call.idempotencyKey);
		const replayKeys = calls.slice(4, 7).map((call) => call.idempotencyKey);
		expect(replayKeys).toEqual(firstKeys);
		expect(firstKeys).toEqual([
			expect.stringMatching(/^je\.event-settings\.update\.draft\.[a-f0-9]{64}$/),
			expect.stringMatching(/^je\.event-settings\.update\.propose\.[a-f0-9]{64}$/),
			expect.stringMatching(/^je\.event-settings\.update\.commit\.[a-f0-9]{64}$/)
		]);
		expect(new Set(firstKeys).size).toBe(3);
		expect(JSON.stringify(calls.map((call) => call.body))).not.toContain('settings-save-1');
	});

	test('preserves structured no-event and stale outcomes without changing source', async () => {
		const eventRequired = currentEventSettingsReadResultSchema.parse({
			kind: 'outcome',
			outcome: {
				class: 'conflict',
				kind: 'event.settings.event_required',
				retryable: false,
				subjects: [],
				detail: null,
				detailSchemaVersion: 1
			},
			correlationId
		});
		const stale = eventSettingsUpdateDraftOperationResultSchema.parse({
			kind: 'outcome',
			terminal: false,
			outcome: {
				class: 'stale_revision',
				kind: 'event.settings_changed',
				retryable: false,
				subjects: [{ type: 'event', id: eventId }],
				detail: { code: 'stale_event', action: 'update', eventId },
				detailSchemaVersion: 1
			},
			correlationId
		});
		if (eventRequired.kind !== 'outcome' || stale.kind !== 'outcome') {
			throw new TypeError('expected_outcome_fixture');
		}
		const calls: RecordedCall[] = [];
		const client = createEventSettingsLiveClient({
			manifest: manifest(),
			request: requester({
				calls,
				payloads: {
					[EXPECTED_OPERATIONS.read.path]: eventRequired,
					[EXPECTED_OPERATIONS.draft.path]: stale
				}
			})
		});
		expect(await client.read()).toEqual({
			kind: 'outcome', outcome: eventRequired.outcome, correlationId
		});
		expect(await client.update(updateInput, 'stale-settings')).toEqual({
			kind: 'outcome',
			outcome: stale.outcome,
			terminal: false,
			correlationId
		});
		expect(calls).toHaveLength(2);
	});

	test('returns the exact draft when policy requires a distinct current human', async () => {
		const calls: RecordedCall[] = [];
		const client = createEventSettingsLiveClient({
			manifest: manifest(),
			request: requester({
				calls,
				payloads: { [EXPECTED_OPERATIONS.draft.path]: draftSuccess({ approval: 'distinct_current_human' }) }
			})
		});
		expect(await client.update(updateInput, 'separate-approval')).toMatchObject({
			kind: 'confirmation_required',
			data: {
				changesetId,
				revisionId,
				revisionDigest,
				headVersion: 1,
				safeDiff,
				requirement: 'distinct_current_human'
			},
			receipt: {
				operationName: EVENT_SETTINGS_UPDATE_DRAFT_OPERATION.name,
				operationVersion: EVENT_SETTINGS_UPDATE_DRAFT_OPERATION.version
			}
		});
		expect(calls.map((call) => call.path)).toEqual([EXPECTED_OPERATIONS.draft.path]);
	});

	test('preflights every exact manifest binding and schema identity', async () => {
		type UnavailableResult = Extract<EventSettingsLiveUpdateResult, { readonly kind: 'unavailable' }>;
		const candidates: readonly [
			unknown,
			UnavailableResult['operation'],
			UnavailableResult['reason']
		][] = [
			[{}, 'draft', 'invalid_operation_manifest'],
			[manifest(['read', 'draft', 'commit']), 'propose', 'operation_not_registered'],
			[manifest(['read', 'propose', 'commit']), 'draft', 'operation_not_registered'],
			[manifest(undefined, {
				draft: {
					inputSchema: {
						...EVENT_SETTINGS_OPERATION_SCHEMA_REFS.updateDraft.inputSchema,
						digestSha256: digest('0')
					}
				}
			}), 'draft', 'operation_contract_mismatch']
		];
		for (const [candidate, operationName, reason] of candidates) {
			const calls: RecordedCall[] = [];
			const client = createEventSettingsLiveClient({
				manifest: candidate,
				request: requester({ calls })
			});
			expect(await client.update(updateInput, 'manifest-closed')).toEqual({
				kind: 'unavailable', operation: operationName, reason
			});
			expect(calls).toHaveLength(0);
		}
	});

	test('rejects authored-diff, proposed-diff, and commit-receipt cross-binding drift', async () => {
		const wrongDraftDiff: EventSettingsSafeDiff = {
			...safeDiff,
			after: { ...safeDiff.after, location: 'A different venue' }
		};
		const wrongGeometryDiff: EventSettingsSafeDiff = {
			...safeDiff,
			after: { ...safeDiff.after, dayStart: '10:30', dayEnd: '16:30' }
		};
		const cases: readonly {
			readonly payloads: Readonly<Record<string, unknown>>;
			readonly expectedCalls: number;
		}[] = [
			{
				payloads: { [EXPECTED_OPERATIONS.draft.path]: draftSuccess({ diff: wrongDraftDiff }) },
				expectedCalls: 1
			},
			{
				payloads: { [EXPECTED_OPERATIONS.draft.path]: draftSuccess({ diff: wrongGeometryDiff }) },
				expectedCalls: 1
			},
			{
				payloads: {
					[EXPECTED_OPERATIONS.draft.path]: draftSuccess(),
					[EXPECTED_OPERATIONS.propose.path]: proposeSuccess({
						operations: [{
							...changesetDiff().operations[0],
							safeDiff: wrongDraftDiff
						}]
					})
				},
				expectedCalls: 2
			},
			{
				payloads: {
					[EXPECTED_OPERATIONS.draft.path]: draftSuccess(),
					[EXPECTED_OPERATIONS.propose.path]: proposeSuccess(),
					[EXPECTED_OPERATIONS.commit.path]: {
						...commitSuccess(),
						receipt: {
							id: id(6),
							operationName: CHANGESET_REVIEW_OPERATIONS.propose.name,
							operationVersion: CHANGESET_REVIEW_OPERATIONS.propose.version
						}
					}
				},
				expectedCalls: 3
			}
		];
		for (const candidate of cases) {
			const calls: RecordedCall[] = [];
			const client = createEventSettingsLiveClient({
				manifest: manifest(),
				request: requester({ calls, payloads: candidate.payloads })
			});
			expect(await client.update(updateInput, 'cross-bound')).toEqual({
				kind: 'transport_error',
				error: { code: 'invalid_contract', retryable: true }
			});
			expect(calls).toHaveLength(candidate.expectedCalls);
		}
	});
});
