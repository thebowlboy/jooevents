import { describe, expect, test } from 'bun:test';
import {
	safeOperationManifestSchema,
	type OperationEffect,
	type SafeOperationManifest,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import {
	REVIEWER_ROSTER_OPERATION_SCHEMA_REFS,
	reviewerRosterChangeDraftOperationResultSchema,
	reviewerRosterSnapshotReadResultSchema
} from '@jooevents/contracts/reviewer-roster';
import type { ExpectedOperatorHttpOperation } from './operator-http-binding';
import {
	createReviewerRosterLivePort,
	REVIEWER_ROSTER_LIVE_OPERATIONS,
	type ReviewerRosterRequestInput,
	type ReviewerRosterRequester
} from './reviewer-roster-live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const correlationId = id(900);

type BindingKey = keyof typeof REVIEWER_ROSTER_LIVE_OPERATIONS;

const schemaRefs = Object.freeze({
	snapshot: REVIEWER_ROSTER_OPERATION_SCHEMA_REFS.snapshotRead,
	change_draft: REVIEWER_ROSTER_OPERATION_SCHEMA_REFS.changeDraft
});

function expected(key: BindingKey): ExpectedOperatorHttpOperation {
	return { ...REVIEWER_ROSTER_LIVE_OPERATIONS[key], ...schemaRefs[key] };
}

function manifestEntry(
	key: BindingKey,
	overrides: Partial<SafeOperationManifestEntry> = {}
): SafeOperationManifestEntry {
	const operation = expected(key);
	const effect = operation.effect as OperationEffect;
	return {
		name: operation.name,
		version: operation.version,
		lifecycle: { status: 'active' },
		summary: `Execute ${operation.name}.`,
		effect,
		maxRisk: 'low',
		autonomy: {
			policy: { key: `autonomy.${operation.name}`, version: 1 },
			riskFloor: 'low',
			unattendedRiskCeiling: 'low',
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
		inputSchema: operation.inputSchema,
		idempotency: operation.idempotencyRequired
			? {
					required: true,
					keySource: { key: `idempotency.${operation.name}`, version: 1 },
					credentialVerifierProfile: { key: 'credential.reviewer-roster', version: 1 },
					requestHashProfile: { key: 'request-hash.reviewer_roster.change-draft', version: 1 }
				}
			: { required: false },
		concurrency: effect === 'read'
			? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: `concurrency.${operation.name}`, version: 1 } },
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http',
			protocol: 'http',
			method: operation.method,
			path: REVIEWER_ROSTER_LIVE_OPERATIONS[key].path,
			input: operation.input,
			resultSchema: operation.resultSchema,
			browserResumption: { kind: 'none' }
		}],
		...overrides
	};
}

function manifest(input: {
	readonly omit?: readonly BindingKey[];
	readonly replace?: Partial<Record<BindingKey, SafeOperationManifestEntry>>;
} = {}): SafeOperationManifest {
	const keys = Object.keys(REVIEWER_ROSTER_LIVE_OPERATIONS) as BindingKey[];
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('f'),
		operations: keys
			.filter((key) => !input.omit?.includes(key))
			.map((key) => input.replace?.[key] ?? manifestEntry(key))
	});
}

const scope = Object.freeze({ workspaceId: id(1), eventId: id(2) });

function memberSubject(memberId: string) {
	return { kind: 'workspace_membership' as const, id: memberId, version: 1 };
}

function activeMember(reviewerId: string, memberId: string, trackId: string) {
	return {
		reviewerId,
		recordVersion: 1,
		projectionVersion: 2,
		status: 'active' as const,
		accessSubject: memberSubject(memberId),
		authority: {
			schemaVersion: 1 as const,
			scope,
			rosterSubject: memberSubject(memberId),
			currentSubject: memberSubject(memberId),
			state: 'active' as const,
			version: 3,
			digestSha256: digest('d'),
			capabilityIds: [
				'event.read',
				'speaker.directory.read',
				'submission.read',
				'submission.score',
				'submission.comment',
				'schedule.read'
			],
			evidenceIds: ['evidence:membership'],
			displayName: 'Ada Bell'
		},
		displayName: 'Ada Bell',
		reviews: [{ kind: 'track' as const, id: trackId }]
	};
}

function snapshotResult() {
	return reviewerRosterSnapshotReadResultSchema.parse({
		kind: 'success',
		data: {
			schemaVersion: 1,
			scope,
			version: 4,
			digestSha256: digest('a'),
			rosterVersion: 3,
			rosterDigestSha256: digest('b'),
			authorityVersion: 2,
			authorityDigestSha256: digest('c'),
			reviewers: [activeMember(id(10), id(11), id(12))]
		},
		correlationId
	});
}

function eventRequiredOutcome() {
	return {
		kind: 'outcome' as const,
		outcome: {
			class: 'conflict' as const,
			kind: 'reviewer_roster.event_required',
			retryable: false,
			subjects: [],
			detail: null,
			detailSchemaVersion: 1
		},
		terminal: false as const,
		correlationId
	};
}

describe('live Reviewer Roster operation port', () => {
	test('pins the two frozen operation identities and HTTP paths', () => {
		expect(Object.fromEntries(
			Object.entries(REVIEWER_ROSTER_LIVE_OPERATIONS).map(([key, value]) => [
				key,
				{ name: value.name, path: value.path }
			])
		)).toEqual({
			snapshot: {
				name: 'reviewer_roster.snapshot.read',
				path: '/api/events/current/reviewer-roster'
			},
			change_draft: {
				name: 'reviewer_roster.change.draft',
				path: '/api/events/current/reviewer-roster/drafts'
			}
		});
	});

	test('reads a manifest-resolved snapshot and severs wire aliases', async () => {
		const calls: ReviewerRosterRequestInput[] = [];
		const request: ReviewerRosterRequester = async (requestInput) => {
			calls.push(requestInput);
			return { kind: 'success', data: snapshotResult() };
		};
		const result = await createReviewerRosterLivePort({
			manifest: manifest(),
			request
		}).readSnapshot();

		expect(result).toMatchObject({
			kind: 'success',
			data: {
				rosterVersion: 3,
				reviewers: [{
					reviewerId: id(10),
					status: 'active',
					accessSubject: { kind: 'workspace_membership', id: id(11) },
					reviews: [{ kind: 'track', id: id(12) }]
				}]
			},
			correlationId
		});
		if (result.kind !== 'success') throw new TypeError('Expected snapshot success.');
		expect(Object.isFrozen(result.data)).toBe(true);
		expect(Object.isFrozen(result.data.reviewers[0])).toBe(true);
		expect(calls).toEqual([{
			path: REVIEWER_ROSTER_LIVE_OPERATIONS.snapshot.path,
			method: 'GET',
			schema: expect.anything()
		}]);
	});

	test('keeps roster identity access-subject-keyed on the draft wire input', async () => {
		const calls: ReviewerRosterRequestInput[] = [];
		const outcome = eventRequiredOutcome();
		const result = await createReviewerRosterLivePort({
			manifest: manifest(),
			request: async (requestInput) => {
				calls.push(requestInput);
				return { kind: 'success', data: outcome };
			}
		}).draftChange({
			action: 'register',
			reviewerId: id(10),
			accessSubject: { kind: 'access_reservation', id: id(13), version: 1 },
			reviews: [{ kind: 'track', id: id(12) }],
			expectedRosterVersion: 3,
			expectedRosterDigestSha256: digest('b')
		}, 'roster-register');

		expect(result).toEqual(outcome);
		expect(calls).toEqual([{
			path: REVIEWER_ROSTER_LIVE_OPERATIONS.change_draft.path,
			method: 'POST',
			schema: expect.anything(),
			body: {
				action: 'register',
				reviewerId: id(10),
				accessSubject: { kind: 'access_reservation', id: id(13), version: 1 },
				reviews: [{ kind: 'track', id: id(12) }],
				expectedRosterVersion: 3,
				expectedRosterDigestSha256: digest('b')
			},
			idempotencyKey: 'roster-register'
		}]);
		// The wire input carries the access subject; no email identity exists here.
		expect(JSON.stringify(calls[0]?.body)).not.toContain('email');
	});

	test('maps a drafted change with its receipt verified', async () => {
		const response = reviewerRosterChangeDraftOperationResultSchema.parse({
			kind: 'success',
			data: {
				changesetId: id(20),
				revision: { id: id(21), digestSha256: digest('e') },
				action: 'set_scope',
				reviewerId: id(10)
			},
			receipt: {
				id: id(22),
				operationName: REVIEWER_ROSTER_LIVE_OPERATIONS.change_draft.name,
				operationVersion: 1
			},
			correlationId
		});
		const result = await createReviewerRosterLivePort({
			manifest: manifest(),
			request: async () => ({ kind: 'success', data: response })
		}).draftChange({
			action: 'set_scope',
			reviewerId: id(10),
			expectedReviewerVersion: 1,
			reviews: [{ kind: 'track', id: id(12) }],
			expectedRosterVersion: 3,
			expectedRosterDigestSha256: digest('b')
		}, 'roster-set-scope');

		expect(result).toMatchObject({
			kind: 'success',
			data: { action: 'set_scope', reviewerId: id(10), changesetId: id(20) },
			correlationId
		});
		if (result.kind !== 'success') throw new TypeError('Expected draft success.');
		expect(Object.isFrozen(result.data.revision)).toBe(true);
	});

	test('rejects a success receipt naming a different operation', async () => {
		const response = reviewerRosterChangeDraftOperationResultSchema.parse({
			kind: 'success',
			data: {
				changesetId: id(20),
				revision: { id: id(21), digestSha256: digest('e') },
				action: 'revoke',
				reviewerId: id(10)
			},
			receipt: { id: id(22), operationName: 'reviewer_roster.snapshot.read', operationVersion: 1 },
			correlationId
		});
		const result = await createReviewerRosterLivePort({
			manifest: manifest(),
			request: async () => ({ kind: 'success', data: response })
		}).draftChange({
			action: 'revoke',
			reviewerId: id(10),
			expectedReviewerVersion: 1,
			expectedRosterVersion: 3,
			expectedRosterDigestSha256: digest('b')
		}, 'roster-revoke');

		expect(result).toEqual({
			kind: 'transport_error',
			error: { code: 'invalid_contract', retryable: true }
		});
	});

	test('fails closed on missing and path-drifted operation contracts', async () => {
		let calls = 0;
		const request: ReviewerRosterRequester = async () => {
			calls += 1;
			return { kind: 'success', data: eventRequiredOutcome() };
		};
		const missing = createReviewerRosterLivePort({
			manifest: manifest({ omit: ['snapshot'] }), request
		});
		expect(await missing.readSnapshot()).toEqual({
			kind: 'unavailable', operation: 'snapshot', reason: 'operation_not_registered'
		});

		const driftedEntry = manifestEntry('change_draft');
		const binding = driftedEntry.enabledBindings[0];
		if (!binding || binding.protocol !== 'http') throw new TypeError('HTTP binding missing.');
		const drifted = createReviewerRosterLivePort({
			manifest: manifest({
				replace: {
					change_draft: {
						...driftedEntry,
						enabledBindings: [{
							...binding,
							path: '/api/events/current/reviewer-roster/drafts-v2'
						}]
					}
				}
			}),
			request
		});
		expect(await drifted.draftChange({
			action: 'restore',
			reviewerId: id(10),
			expectedReviewerVersion: 1,
			expectedRosterVersion: 3,
			expectedRosterDigestSha256: digest('b')
		}, 'roster-restore')).toEqual({
			kind: 'unavailable', operation: 'change_draft', reason: 'operation_contract_mismatch'
		});
		expect(calls).toBe(0);
	});

	test('exposes no tuned-screen capability the backend does not own', () => {
		const port = createReviewerRosterLivePort({
			manifest: manifest(),
			request: async () => ({ kind: 'success', data: snapshotResult() })
		});
		expect(Object.keys(port).sort()).toEqual(['draftChange', 'readSnapshot', 'source']);
		expect(port).not.toHaveProperty('invite');
		expect(port).not.toHaveProperty('list');
		expect(port).not.toHaveProperty('coverage');
	});
});
