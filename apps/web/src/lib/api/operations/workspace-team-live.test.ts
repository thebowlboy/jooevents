import { describe, expect, test } from 'bun:test';
import {
	WORKSPACE_TEAM_OPERATION_SCHEMA_REFS,
	committedChangesetOperationResultSchema,
	proposedChangesetOperationResultSchema,
	safeOperationManifestSchema,
	workspaceTeamDraftOperationResultSchema,
	workspaceTeamInviteDraftInputSchema,
	workspaceTeamMembersReadResultSchema,
	workspaceTeamRemovalDraftInputSchema,
	workspaceTeamRoleChangeDraftInputSchema,
	workspaceTeamSafeDiffSchema,
	type OperationEffect,
	type SafeOperationManifest,
	type SafeOperationManifestEntry,
	type WorkspaceTeamSafeDiff
} from '@jooevents/contracts';
import { CHANGESET_REVIEW_OPERATIONS } from '../changesets/live';
import {
	createWorkspaceTeamLiveClient,
	WORKSPACE_TEAM_DRAFT_OPERATIONS,
	WORKSPACE_TEAM_MEMBERS_READ_OPERATION,
	type WorkspaceTeamDraftRequest,
	type WorkspaceTeamLiveApplyResult,
	type WorkspaceTeamRequester
} from './workspace-team-live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const correlationId = id(900);
const changesetId = id(100);
const revisionId = id(101);
const revisionDigest = digest('b');

const roles = [
	{ key: 'workspace_admin', name: 'Workspace Admin', version: 1 },
	{ key: 'event_manager', name: 'Event Manager', version: 1 },
	{ key: 'speaker_manager', name: 'Speaker Manager', version: 1 },
	{ key: 'speaker_reviewer', name: 'Speaker Reviewer', version: 1 },
	{ key: 'scheduler', name: 'Scheduler', version: 1 },
	{ key: 'communications_coordinator', name: 'Communications Coordinator', version: 1 },
	{ key: 'viewer', name: 'Viewer', version: 1 }
] as const;

const snapshot = {
	schemaVersion: 1 as const,
	version: 7,
	digestSha256: digest('a'),
	roles,
	members: [{
		id: id(1),
		kind: 'member' as const,
		userId: id(2),
		name: 'Ada Lovelace',
		email: 'ada@example.test',
		role: roles[0],
		status: 'active' as const,
		version: 4,
		hasAdditionalAccess: false
	}]
};

const readSuccess = workspaceTeamMembersReadResultSchema.parse({
	kind: 'success', data: snapshot, correlationId
});

const requests = Object.freeze({
	invite: {
		action: 'invite',
		input: workspaceTeamInviteDraftInputSchema.parse({
			email: 'reviewer@example.test',
			roleKey: 'speaker_reviewer',
			expectedTeamVersion: 7,
			expectedTeamDigestSha256: digest('a')
		})
	},
	change_role: {
		action: 'change_role',
		input: workspaceTeamRoleChangeDraftInputSchema.parse({
			subject: { kind: 'member', membershipId: id(1), version: 4 },
			roleKey: 'event_manager',
			expectedTeamVersion: 7,
			expectedTeamDigestSha256: digest('a')
		})
	},
	remove: {
		action: 'remove',
		input: workspaceTeamRemovalDraftInputSchema.parse({
			subject: { kind: 'member', membershipId: id(1), version: 4 },
			expectedTeamVersion: 7,
			expectedTeamDigestSha256: digest('a')
		})
	}
} as const satisfies Readonly<Record<
	WorkspaceTeamDraftRequest['action'],
	WorkspaceTeamDraftRequest
>>);

const safeDiffs = Object.freeze({
	invite: workspaceTeamSafeDiffSchema.parse({
		action: 'invite',
		recipientHint: 'recipient-0123456789ab',
		role: roles[3],
		invitationStatus: 'recorded',
		delivery: 'awaiting_activation'
	}),
	change_role: workspaceTeamSafeDiffSchema.parse({
		action: 'change_role',
		subject: requests.change_role.input.subject,
		before: roles[0],
		after: roles[1]
	}),
	remove: workspaceTeamSafeDiffSchema.parse({
		action: 'remove',
		subject: requests.remove.input.subject,
		before: roles[0],
		after: null,
		sessionRevocation: 'awaiting_activation'
	})
} as const satisfies Readonly<Record<
	WorkspaceTeamDraftRequest['action'],
	WorkspaceTeamSafeDiff
>>);

function draftSuccess(
	action: WorkspaceTeamDraftRequest['action'],
	input: {
		readonly approval?: 'none' | 'distinct_current_human';
		readonly safeDiff?: WorkspaceTeamSafeDiff;
		readonly receiptOperation?: { readonly name: string; readonly version: number };
	} = {}
) {
	const operation = input.receiptOperation ?? WORKSPACE_TEAM_DRAFT_OPERATIONS[action];
	return workspaceTeamDraftOperationResultSchema.parse({
		kind: 'success',
		data: {
			schemaVersion: 1,
			action,
			changesetId,
			headVersion: 1,
			status: 'draft',
			revision: { id: revisionId, number: 1, digestSha256: revisionDigest },
			riskTier: action === 'invite' ? 'normal' : 'consequential',
			approvalPolicy: {
				reference: { key: 'workspace_team.bounded', version: 1 },
				definitionDigestSha256: digest('c'),
				requirement: input.approval ?? 'none'
			},
			safeDiff: input.safeDiff ?? safeDiffs[action]
		},
		receipt: { id: id(102), operationName: operation.name, operationVersion: operation.version },
		correlationId
	});
}

function changesetDiff(
	action: WorkspaceTeamDraftRequest['action'],
	overrides: Record<string, unknown> = {}
) {
	const riskTier = action === 'invite' ? 'normal' as const : 'consequential' as const;
	return {
		changesetId,
		headVersion: 2,
		status: 'proposed' as const,
		revisionId,
		revisionNumber: 1,
		revisionDigest,
		riskTier,
		approvalPolicy: {
			reference: { key: 'workspace_team.bounded', version: 1 },
			definitionDigestSha256: digest('c'),
			requirement: 'none' as const
		},
		operations: [{
			kind: 'workspace_team.mutate',
			version: 1,
			riskTier,
			dependencyGroup: 'workspace_team',
			safeDiff: safeDiffs[action],
			consequences: ['workspace_team_changed']
		}],
		...overrides
	};
}

function proposeSuccess(
	action: WorkspaceTeamDraftRequest['action'],
	overrides: Record<string, unknown> = {}
) {
	return proposedChangesetOperationResultSchema.parse({
		kind: 'success',
		data: { schemaVersion: 1, action: 'propose', diff: changesetDiff(action, overrides) },
		receipt: {
			id: id(103),
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
			id: id(104),
			operationName: CHANGESET_REVIEW_OPERATIONS.commit.name,
			operationVersion: CHANGESET_REVIEW_OPERATIONS.commit.version
		},
		correlationId
	});
}

const EXPECTED = Object.freeze({
	members: Object.freeze({
		...WORKSPACE_TEAM_MEMBERS_READ_OPERATION,
		effect: 'read' as const, method: 'GET' as const, input: 'query' as const,
		idempotencyRequired: false,
		...WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.members,
		path: '/api/workspace/team'
	}),
	invite: Object.freeze({
		...WORKSPACE_TEAM_DRAFT_OPERATIONS.invite,
		effect: 'draft' as const, method: 'POST' as const, input: 'body' as const,
		idempotencyRequired: true,
		...WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.invite,
		path: '/api/workspace/team/invitations/drafts'
	}),
	change_role: Object.freeze({
		...WORKSPACE_TEAM_DRAFT_OPERATIONS.change_role,
		effect: 'draft' as const, method: 'POST' as const, input: 'body' as const,
		idempotencyRequired: true,
		...WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.roleChange,
		path: '/api/workspace/team/role-changes/drafts'
	}),
	remove: Object.freeze({
		...WORKSPACE_TEAM_DRAFT_OPERATIONS.remove,
		effect: 'draft' as const, method: 'POST' as const, input: 'body' as const,
		idempotencyRequired: true,
		...WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.removal,
		path: '/api/workspace/team/removals/drafts'
	}),
	propose: Object.freeze({ ...CHANGESET_REVIEW_OPERATIONS.propose, path: '/api/changesets/proposals' }),
	commit: Object.freeze({ ...CHANGESET_REVIEW_OPERATIONS.commit, path: '/api/changesets/commits' })
});

type OperationKey = keyof typeof EXPECTED;

function operation(
	key: OperationKey,
	overrides: Partial<SafeOperationManifestEntry> = {}
): SafeOperationManifestEntry {
	const expected = EXPECTED[key];
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
	keys: readonly OperationKey[] = ['members', 'invite', 'change_role', 'remove', 'propose', 'commit'],
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
	readonly payloads: Readonly<Record<string, unknown>>;
}): WorkspaceTeamRequester {
	return async (requestInput) => {
		input.calls.push(requestInput as RecordedCall);
		return { kind: 'success', data: input.payloads[requestInput.path] };
	};
}

function payloads(action: WorkspaceTeamDraftRequest['action']): Readonly<Record<string, unknown>> {
	return {
		[EXPECTED.members.path]: readSuccess,
		[EXPECTED[action].path]: draftSuccess(action),
		[EXPECTED.propose.path]: proposeSuccess(action),
		[EXPECTED.commit.path]: commitSuccess()
	};
}

function noAuthorityInputSurface(client: ReturnType<typeof createWorkspaceTeamLiveClient>): void {
	type ReadOptions = NonNullable<Parameters<typeof client.read>[0]>;
	type BusinessInput = WorkspaceTeamDraftRequest['input'];
	type Forbidden = Extract<
		keyof ReadOptions | keyof BusinessInput,
		'actor' | 'scope' | 'authority' | 'approval' | 'workspaceId' | 'userId' | 'membershipId'
	>;
	const forbidden: readonly Forbidden[] = [];
	expect(forbidden).toEqual([]);
}

describe('pure-live Workspace Team operation client', () => {
	test('binds roster read and invite through one exact draft, proposal, and commit', async () => {
		const calls: RecordedCall[] = [];
		const client = createWorkspaceTeamLiveClient({
			manifest: manifest(),
			request: requester({ calls, payloads: payloads('invite') })
		});
		noAuthorityInputSurface(client);

		expect(await client.read()).toMatchObject({
			kind: 'success',
			data: {
				version: 7,
				members: [{
					id: id(1),
					subject: { kind: 'member', membershipId: id(1), version: 4 }
				}]
			},
			correlationId
		});

		const first = await client.apply(requests.invite, 'team-invite-1');
		const replay = await client.apply(requests.invite, 'team-invite-1');
		expect(first).toMatchObject({
			kind: 'success',
			data: {
				action: 'invite',
				changesetId,
				revisionId,
				revisionDigest,
				committedHeadVersion: 3,
				change: {
					recipientHint: 'recipient-0123456789ab',
					invitationStatus: 'recorded',
					delivery: 'awaiting_activation'
				}
			},
			receipt: {
				operationName: CHANGESET_REVIEW_OPERATIONS.commit.name,
				operationVersion: CHANGESET_REVIEW_OPERATIONS.commit.version
			},
			correlationId
		});
		expect(replay).toEqual(first);
		expect(calls.map((call) => call.path)).toEqual([
			EXPECTED.members.path,
			EXPECTED.invite.path, EXPECTED.propose.path, EXPECTED.commit.path,
			EXPECTED.invite.path, EXPECTED.propose.path, EXPECTED.commit.path
		]);
		expect(calls[1]?.body).toEqual(requests.invite.input);
		expect(calls[2]?.body).toEqual({
			changesetId, revisionId, revisionDigest, expectedHeadVersion: 1
		});
		expect(calls[3]?.body).toEqual({
			changesetId, revisionId, revisionDigest, expectedHeadVersion: 2
		});
		const firstKeys = calls.slice(1, 4).map((call) => call.idempotencyKey);
		expect(calls.slice(4, 7).map((call) => call.idempotencyKey)).toEqual(firstKeys);
		expect(firstKeys).toEqual([
			expect.stringMatching(/^je\.workspace-team\.invite\.draft\.[a-f0-9]{64}$/),
			expect.stringMatching(/^je\.workspace-team\.invite\.propose\.[a-f0-9]{64}$/),
			expect.stringMatching(/^je\.workspace-team\.invite\.commit\.[a-f0-9]{64}$/)
		]);
		expect(new Set(firstKeys).size).toBe(3);
		expect(JSON.stringify(calls.map((call) => call.body))).not.toContain('team-invite-1');
	});

	test('preserves typed domain refusals without proposing or changing source', async () => {
		const stale = workspaceTeamDraftOperationResultSchema.parse({
			kind: 'outcome',
			terminal: false,
			outcome: {
				class: 'stale_revision',
				kind: 'workspace_team.change_refused',
				retryable: false,
				subjects: [],
				detail: { code: 'stale_team', action: 'invite' },
				detailSchemaVersion: 1
			},
			correlationId
		});
		if (stale.kind !== 'outcome') throw new TypeError('expected_workspace_team_outcome');
		const calls: RecordedCall[] = [];
		const client = createWorkspaceTeamLiveClient({
			manifest: manifest(),
			request: requester({
				calls,
				payloads: { [EXPECTED.invite.path]: stale }
			})
		});

		expect(await client.apply(requests.invite, 'stale-team')).toEqual({
			kind: 'outcome',
			outcome: stale.outcome,
			terminal: false,
			correlationId
		});
		expect(calls.map((call) => call.path)).toEqual([EXPECTED.invite.path]);
	});

	test('binds member role changes and removals to exact versioned subjects', async () => {
		for (const action of ['change_role', 'remove'] as const) {
			const calls: RecordedCall[] = [];
			const client = createWorkspaceTeamLiveClient({
				manifest: manifest(),
				request: requester({ calls, payloads: payloads(action) })
			});
			const result = await client.apply(requests[action], `team-${action}-1`);
			expect(result).toMatchObject({
				kind: 'success',
				data: { action, change: safeDiffs[action] }
			});
			expect(calls[0]?.path).toBe(EXPECTED[action].path);
			expect(calls[0]?.body).toEqual(requests[action].input);
			if (result.kind === 'success' && result.data.change.action === 'remove') {
				expect(result.data.change.sessionRevocation).toBe('awaiting_activation');
			}
		}
	});

	test('returns the exact draft when a distinct current human is required', async () => {
		const calls: RecordedCall[] = [];
		const client = createWorkspaceTeamLiveClient({
			manifest: manifest(),
			request: requester({
				calls,
				payloads: { [EXPECTED.remove.path]: draftSuccess('remove', {
					approval: 'distinct_current_human'
				}) }
			})
		});
		expect(await client.apply(requests.remove, 'team-remove-confirm')).toMatchObject({
			kind: 'confirmation_required',
			data: {
				action: 'remove',
				changesetId,
				revisionId,
				revisionDigest,
				headVersion: 1,
				change: safeDiffs.remove,
				requirement: 'distinct_current_human'
			},
			receipt: {
				operationName: WORKSPACE_TEAM_DRAFT_OPERATIONS.remove.name,
				operationVersion: WORKSPACE_TEAM_DRAFT_OPERATIONS.remove.version
			}
		});
		expect(calls.map((call) => call.path)).toEqual([EXPECTED.remove.path]);
	});

	test('preflights every exact manifest binding and schema identity', async () => {
		type UnavailableResult = Extract<WorkspaceTeamLiveApplyResult,
			{ readonly kind: 'unavailable' }>;
		const candidates: readonly [
			unknown,
			UnavailableResult['operation'],
			UnavailableResult['reason']
		][] = [
			[{}, 'invite', 'invalid_operation_manifest'],
			[manifest(['members', 'invite', 'change_role', 'remove', 'commit']),
				'propose', 'operation_not_registered'],
			[manifest(['members', 'change_role', 'remove', 'propose', 'commit']),
				'invite', 'operation_not_registered'],
			[manifest(undefined, {
				invite: {
					inputSchema: {
						...WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.invite.inputSchema,
						digestSha256: digest('0')
					}
				}
			}), 'invite', 'operation_contract_mismatch']
		];
		for (const [candidate, operationName, reason] of candidates) {
			const calls: RecordedCall[] = [];
			const client = createWorkspaceTeamLiveClient({
				manifest: candidate,
				request: requester({ calls, payloads: {} })
			});
			expect(await client.apply(requests.invite, 'manifest-closed')).toEqual({
				kind: 'unavailable', operation: operationName, reason
			});
			expect(calls).toHaveLength(0);
		}
	});

	test('rejects request/draft, proposed diff, and commit receipt cross-binding drift', async () => {
		const wrongRoleDiff = workspaceTeamSafeDiffSchema.parse({
			...safeDiffs.invite,
			role: roles[6]
		});
		const cases: readonly {
			readonly payloads: Readonly<Record<string, unknown>>;
			readonly expectedCalls: number;
		}[] = [{
			payloads: { [EXPECTED.invite.path]: draftSuccess('invite', { safeDiff: wrongRoleDiff }) },
			expectedCalls: 1
		}, {
			payloads: {
				[EXPECTED.invite.path]: draftSuccess('invite'),
				[EXPECTED.propose.path]: proposeSuccess('invite', {
					operations: [{
						...changesetDiff('invite').operations[0],
						safeDiff: wrongRoleDiff
					}]
				})
			},
			expectedCalls: 2
		}, {
			payloads: {
				[EXPECTED.invite.path]: draftSuccess('invite'),
				[EXPECTED.propose.path]: proposeSuccess('invite'),
				[EXPECTED.commit.path]: {
					...commitSuccess(),
					receipt: {
						id: id(104),
						operationName: CHANGESET_REVIEW_OPERATIONS.propose.name,
						operationVersion: CHANGESET_REVIEW_OPERATIONS.propose.version
					}
				}
			},
			expectedCalls: 3
		}];

		for (const candidate of cases) {
			const calls: RecordedCall[] = [];
			const client = createWorkspaceTeamLiveClient({
				manifest: manifest(),
				request: requester({ calls, payloads: candidate.payloads })
			});
			expect(await client.apply(requests.invite, 'cross-bound')).toEqual({
				kind: 'transport_error',
				error: { code: 'invalid_contract', retryable: true }
			});
			expect(calls).toHaveLength(candidate.expectedCalls);
		}
	});
});
