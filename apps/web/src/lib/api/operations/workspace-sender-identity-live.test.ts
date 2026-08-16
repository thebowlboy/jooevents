import { describe, expect, test } from 'bun:test';
import {
	WORKSPACE_SENDER_IDENTITY_OPERATION_SCHEMA_REFS,
	safeOperationManifestSchema,
	workspaceSenderIdentitySchema,
	type SafeOperationManifest,
	type SafeOperationManifestEntry,
	type StructuredOutcome,
	type WorkspaceSenderIdentityDto
} from '@jooevents/contracts';
import {
	WORKSPACE_SENDER_IDENTITY_READ_OPERATION,
	WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION,
	createWorkspaceSenderIdentityLiveClient,
	type WorkspaceSenderIdentityRequestInput
} from './workspace-sender-identity-live';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (character: string) => character.repeat(64);
const correlationId = id(900);
const PATH = '/api/communications/sender-identity';

const receipt = {
	id: id(11),
	operationName: WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION.name,
	operationVersion: WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION.version
};

function identity(overrides: Partial<WorkspaceSenderIdentityDto> = {}): WorkspaceSenderIdentityDto {
	return workspaceSenderIdentitySchema.parse({
		schemaVersion: 1,
		workspaceId: 'workspace-1',
		headVersion: 1,
		displayName: null,
		replyToAddress: null,
		effective: {
			fromAddress: 'program@example.test',
			fromDisplayName: 'Example Installation',
			replyToAddress: null,
			source: 'installation'
		},
		updatedAt: null,
		...overrides
	});
}

const autonomy: SafeOperationManifestEntry['autonomy'] = {
	policy: { key: 'autonomy.communication.sender-identity', version: 1 },
	riskFloor: 'normal',
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
};

function readEntry(path = PATH): SafeOperationManifestEntry {
	return {
		...WORKSPACE_SENDER_IDENTITY_READ_OPERATION,
		lifecycle: { status: 'active' },
		summary: 'Read the outbound sender presentation.',
		effect: 'read',
		maxRisk: 'normal',
		autonomy,
		consequenceTags: [],
		inputSchema: WORKSPACE_SENDER_IDENTITY_OPERATION_SCHEMA_REFS.read.inputSchema,
		idempotency: { required: false },
		concurrency: { kind: 'read_snapshot' },
		outcomes: [],
		enabledBindings: [
			{
				surface: 'operator_http',
				protocol: 'http',
				method: 'GET',
				path,
				input: 'query',
				resultSchema: WORKSPACE_SENDER_IDENTITY_OPERATION_SCHEMA_REFS.read.resultSchema,
				browserResumption: { kind: 'none' }
			}
		]
	};
}

function updateEntry(
	overrides: { readonly idempotencyRequired?: boolean } = {}
): SafeOperationManifestEntry {
	const required = overrides.idempotencyRequired ?? true;
	return {
		...WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION,
		lifecycle: { status: 'active' },
		summary: 'Set the workspace sender display name and reply-to address.',
		effect: 'commit',
		maxRisk: 'normal',
		autonomy,
		consequenceTags: ['sender-identity-changed'],
		inputSchema: WORKSPACE_SENDER_IDENTITY_OPERATION_SCHEMA_REFS.update.inputSchema,
		idempotency: required
			? {
					required: true,
					keySource: { key: 'idempotency.key-source', version: 1 },
					credentialVerifierProfile: { key: 'idempotency.credential', version: 1 },
					requestHashProfile: { key: 'request-hash.sender-identity', version: 1 }
				}
			: { required: false },
		concurrency: {
			kind: 'registered',
			definition: { key: 'concurrency.communication.sender-identity.workspace', version: 1 }
		},
		outcomes: [],
		enabledBindings: [
			{
				surface: 'operator_http',
				protocol: 'http',
				method: 'POST',
				path: PATH,
				input: 'body',
				resultSchema: WORKSPACE_SENDER_IDENTITY_OPERATION_SCHEMA_REFS.update.resultSchema,
				browserResumption: { kind: 'none' }
			}
		]
	};
}

function manifest(entries: readonly SafeOperationManifestEntry[]): SafeOperationManifest {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('7'),
		operations: entries
	});
}

const fullManifest = () => manifest([readEntry(), updateEntry()]);

function client(
	payloads: Readonly<Record<'GET' | 'POST', unknown>>,
	calls: WorkspaceSenderIdentityRequestInput[] = []
) {
	return createWorkspaceSenderIdentityLiveClient({
		manifest: fullManifest(),
		request: async (request) => {
			calls.push(request);
			const payload = payloads[request.method];
			return payload === undefined
				? { kind: 'error', error: { code: 'unexpected_request', retryable: false } }
				: { kind: 'success', data: payload };
		}
	});
}

const refusalOutcome: StructuredOutcome = {
	class: 'policy_violation',
	kind: 'communication.sender_identity_refused',
	retryable: false,
	subjects: [],
	detail: { field: 'reply_to_address', code: 'reply_to_multiple_addresses' },
	detailSchemaVersion: 1
};

describe('the live sender-identity client', () => {
	test('reads the served projection from the one active operator binding', async () => {
		const calls: WorkspaceSenderIdentityRequestInput[] = [];
		const port = client(
			{ GET: { kind: 'success', data: identity(), correlationId }, POST: undefined },
			calls
		);

		const result = await port.read();

		expect(result).toEqual({ kind: 'success', data: identity(), correlationId });
		expect(calls).toEqual([
			{ path: PATH, method: 'GET', schema: expect.anything() }
		]);
	});

	test('carries a read refusal as its outcome rather than an error', async () => {
		const outcome: StructuredOutcome = {
			class: 'access_denied',
			kind: 'authority.not_authorized',
			retryable: false,
			subjects: [],
			detail: null,
			detailSchemaVersion: 1
		};
		const port = client({ GET: { kind: 'outcome', outcome, correlationId }, POST: undefined });

		expect(await port.read()).toEqual({ kind: 'outcome', outcome, correlationId });
	});

	test('sends the update as a body with a required idempotency key and no from-address', async () => {
		const calls: WorkspaceSenderIdentityRequestInput[] = [];
		const committed = identity({
			headVersion: 2,
			displayName: 'Deep Dish Conf',
			replyToAddress: null,
			effective: {
				fromAddress: 'program@example.test',
				fromDisplayName: 'Deep Dish Conf',
				replyToAddress: null,
				source: 'workspace'
			},
			updatedAt: '2026-08-15T09:00:00.000Z'
		});
		const port = client(
			{
				GET: undefined,
				POST: { kind: 'success', data: committed, receipt, correlationId }
			},
			calls
		);

		const result = await port.update({
			expectedHeadVersion: 1,
			displayName: 'Deep Dish Conf',
			replyToAddress: null
		});

		expect(result).toEqual({ kind: 'success', data: committed, receipt, correlationId });
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.body).toEqual({
			expectedHeadVersion: 1,
			displayName: 'Deep Dish Conf',
			replyToAddress: null
		});
		expect(calls[0]?.idempotencyKey).toMatch(
			/^je\.sender-identity\.update\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
		);
	});

	test('mints a fresh key per attempt, so a repeat save is never replayed as the old one', async () => {
		// A content-derived key made a later save carrying the same values a
		// REPLAY: the server answered with the earlier receipt, and the stale
		// guard that should have refused was swallowed by the idempotency layer,
		// leaving the surface showing a sender someone else had replaced.
		const calls: WorkspaceSenderIdentityRequestInput[] = [];
		const port = client(
			{ GET: undefined, POST: { kind: 'success', data: identity({ headVersion: 2, updatedAt: '2026-08-15T09:00:00.000Z' }), receipt, correlationId } },
			calls
		);

		await port.update({ expectedHeadVersion: 1, displayName: 'One', replyToAddress: null });
		await port.update({ expectedHeadVersion: 1, displayName: 'One', replyToAddress: null });
		await port.update({ expectedHeadVersion: 1, displayName: 'Two', replyToAddress: null });

		const keys = calls.map((call) => call.idempotencyKey);
		expect(new Set(keys).size).toBe(3);
	});

	test('carries a terminal field refusal with its receipt', async () => {
		const port = client({
			GET: undefined,
			POST: {
				kind: 'outcome',
				outcome: refusalOutcome,
				terminal: true,
				receipt,
				correlationId
			}
		});

		expect(
			await port.update({
				expectedHeadVersion: 1,
				displayName: null,
				replyToAddress: 'a@example.test, b@example.test'
			})
		).toEqual({
			kind: 'outcome',
			outcome: refusalOutcome,
			terminal: true,
			receipt,
			correlationId
		});
	});

	test('refuses a success whose receipt names another operation', async () => {
		const port = client({
			GET: undefined,
			POST: {
				kind: 'success',
				data: identity({ headVersion: 2, updatedAt: '2026-08-15T09:00:00.000Z' }),
				receipt: { ...receipt, operationName: 'event.settings.update' },
				correlationId
			}
		});

		expect(
			await port.update({ expectedHeadVersion: 1, displayName: 'X', replyToAddress: null })
		).toEqual({
			kind: 'transport_error',
			error: { code: 'invalid_contract', retryable: true }
		});
	});

	test('reports each half unavailable by name when its binding is not registered', async () => {
		const readOnly = createWorkspaceSenderIdentityLiveClient({
			manifest: manifest([readEntry()]),
			request: async () => ({ kind: 'error', error: { code: 'unexpected_request', retryable: false } })
		});
		expect(
			await readOnly.update({ expectedHeadVersion: 1, displayName: null, replyToAddress: null })
		).toEqual({
			kind: 'unavailable',
			operation: 'update',
			reason: 'operation_not_registered'
		});

		const updateOnly = createWorkspaceSenderIdentityLiveClient({
			manifest: manifest([updateEntry()]),
			request: async () => ({ kind: 'error', error: { code: 'unexpected_request', retryable: false } })
		});
		expect(await updateOnly.read()).toEqual({
			kind: 'unavailable',
			operation: 'read',
			reason: 'operation_not_registered'
		});
	});

	test('refuses an update binding the registry no longer requires a key for', async () => {
		const port = createWorkspaceSenderIdentityLiveClient({
			manifest: manifest([readEntry(), updateEntry({ idempotencyRequired: false })])
		});

		expect(
			await port.update({ expectedHeadVersion: 1, displayName: 'X', replyToAddress: null })
		).toEqual({
			kind: 'unavailable',
			operation: 'update',
			reason: 'operation_contract_mismatch'
		});
	});

	test('refuses an update input the served contract would reject', async () => {
		const port = client({ GET: undefined, POST: undefined });

		expect(
			await port.update({ expectedHeadVersion: 0, displayName: null, replyToAddress: null })
		).toEqual({
			kind: 'transport_error',
			error: { code: 'invalid_request', retryable: false }
		});
	});
});
