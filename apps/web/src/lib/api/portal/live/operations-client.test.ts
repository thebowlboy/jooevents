import { describe, expect, test } from 'bun:test';
import {
	PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS,
	safeOperationManifestSchema,
	type PortalEngagementDto,
	type PortalSnapshotDto,
	type SafeOperationManifest,
	type SafeOperationManifestEntry,
	type StructuredOutcome
} from '@jooevents/contracts';
import type { ApiResult } from '../../client';
import {
	createPortalOperationsLiveClient,
	PORTAL_LIVE_OPERATIONS,
	type PortalLiveRequestInput
} from './operations-client';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const correlationId = id(900);

const personId = id(20);
const coSpeakerPersonId = id(21);
const engagementId = id(40);

const PATHS = Object.freeze({
	snapshot: '/api/portal/snapshot',
	respond: '/api/portal/engagements/respond'
});

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
		submissions: [],
		engagements: [],
		tasks: [],
		files: [],
		resources: [],
		profile: { fields: [] }
	};
}

function engagementDto(): PortalEngagementDto {
	return {
		id: engagementId,
		sessionId: id(10),
		sessionTitle: 'Signals in practice',
		submissionId: id(30),
		status: 'confirmed',
		invitedAt: '2026-08-01T09:00:00.000Z',
		respondBy: null,
		confirmation: { by: 'you', at: '2026-08-14T10:00:00.000Z' },
		speakers: [
			{ participantId: personId, displayName: 'Maya Kern' },
			{ participantId: coSpeakerPersonId, displayName: 'Ana Ruiz' }
		]
	};
}

const receipt = Object.freeze({
	id: id(100),
	operationName: PORTAL_LIVE_OPERATIONS.respond.name,
	operationVersion: PORTAL_LIVE_OPERATIONS.respond.version
});

function refusalOutcome(kind: string, klass: StructuredOutcome['class']): StructuredOutcome {
	return {
		class: klass,
		kind,
		retryable: false,
		subjects: [],
		detail: null,
		detailSchemaVersion: 1
	};
}

type OperationKey = keyof typeof PATHS;

function manifestEntry(key: OperationKey): SafeOperationManifestEntry {
	const respond = key === 'respond';
	const operation = respond ? PORTAL_LIVE_OPERATIONS.respond : PORTAL_LIVE_OPERATIONS.snapshot;
	const refs = respond
		? PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS.engagementRespond
		: PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS.snapshotRead;
	return {
		name: operation.name,
		version: operation.version,
		lifecycle: { status: 'active' },
		summary: `Execute ${operation.name}.`,
		effect: respond ? 'commit' : 'read',
		maxRisk: respond ? 'normal' : 'low',
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
		inputSchema: refs.inputSchema,
		idempotency: respond
			? {
					required: true,
					keySource: { key: 'idempotency.participant-header', version: 1 },
					credentialVerifierProfile: { key: 'credential.participant-session', version: 1 },
					requestHashProfile: { key: 'request-hash.portal.engagement.respond', version: 1 }
				}
			: { required: false },
		concurrency: respond
			? { kind: 'registered', definition: { key: `concurrency.${operation.name}`, version: 1 } }
			: { kind: 'read_snapshot' },
		outcomes: [],
		enabledBindings: [
			{
				surface: 'participant_http',
				protocol: 'http',
				method: respond ? 'POST' : 'GET',
				path: PATHS[key],
				input: respond ? 'body' : 'query',
				resultSchema: refs.resultSchema,
				browserResumption: { kind: 'none' }
			}
		]
	};
}

function manifest(input: { readonly omit?: readonly OperationKey[] } = {}): SafeOperationManifest {
	const keys: readonly OperationKey[] = ['snapshot', 'respond'];
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('f'),
		operations: keys.filter((key) => !input.omit?.includes(key)).map((key) => manifestEntry(key))
	});
}

function stubRequester(payloads: Readonly<Record<string, unknown>>) {
	const calls: PortalLiveRequestInput[] = [];
	const request = async (input: PortalLiveRequestInput): Promise<ApiResult<unknown>> => {
		calls.push(input);
		const payload = payloads[input.path];
		if (payload === undefined) {
			return { kind: 'error', error: { code: 'http_404', retryable: false } };
		}
		if (typeof payload === 'object' && payload !== null && '__transportError' in payload) {
			return {
				kind: 'error',
				error: (payload as { __transportError: { code: string; retryable: boolean } })
					.__transportError
			};
		}
		return { kind: 'success', data: payload };
	};
	return { calls, request };
}

describe('portal operations live client — snapshot read', () => {
	test('reads the snapshot over the manifest-resolved GET path', async () => {
		const { calls, request } = stubRequester({
			[PATHS.snapshot]: { kind: 'success', data: snapshotDto(), correlationId }
		});
		const client = createPortalOperationsLiveClient({ manifest: manifest(), request });
		const result = await client.readSnapshot();
		expect(result).toEqual({ kind: 'success', data: snapshotDto(), correlationId });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ path: PATHS.snapshot, method: 'GET' });
		expect(calls[0]!.idempotencyKey).toBeUndefined();
	});

	test('a structured outcome passes through typed, never as data', async () => {
		const outcome = refusalOutcome('authority.revoked', 'access_denied');
		const { request } = stubRequester({
			[PATHS.snapshot]: { kind: 'outcome', outcome, correlationId }
		});
		const client = createPortalOperationsLiveClient({ manifest: manifest(), request });
		expect(await client.readSnapshot()).toEqual({ kind: 'outcome', outcome, correlationId });
	});

	test('transport failure stays a transport error', async () => {
		const { request } = stubRequester({
			[PATHS.snapshot]: { __transportError: { code: 'network_unavailable', retryable: true } }
		});
		const client = createPortalOperationsLiveClient({ manifest: manifest(), request });
		expect(await client.readSnapshot()).toEqual({
			kind: 'transport_error',
			error: { code: 'network_unavailable', retryable: true }
		});
	});

	test('an unregistered operation is typed unavailable and sends nothing', async () => {
		const { calls, request } = stubRequester({});
		const client = createPortalOperationsLiveClient({
			manifest: manifest({ omit: ['snapshot'] }),
			request
		});
		expect(await client.readSnapshot()).toEqual({
			kind: 'unavailable',
			operation: 'snapshot',
			reason: 'operation_not_registered'
		});
		expect(calls).toHaveLength(0);
	});

	test('a payload outside the contract is refused as invalid_contract', async () => {
		const { request } = stubRequester({
			[PATHS.snapshot]: { kind: 'success', data: { fabricated: true }, correlationId }
		});
		const client = createPortalOperationsLiveClient({ manifest: manifest(), request });
		expect(await client.readSnapshot()).toEqual({
			kind: 'transport_error',
			error: { code: 'invalid_contract', retryable: true }
		});
	});
});

describe('portal operations live client — engagement respond', () => {
	test('sends exactly the narrow wire input with the idempotency key on the header seam', async () => {
		const { calls, request } = stubRequester({
			[PATHS.respond]: { kind: 'success', data: engagementDto(), receipt, correlationId }
		});
		const client = createPortalOperationsLiveClient({ manifest: manifest(), request });
		const result = await client.respondToEngagement(
			{ engagementId, response: 'confirm' },
			'je.portal.respond.test-key'
		);
		expect(result).toEqual({ kind: 'success', data: engagementDto(), receipt, correlationId });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			path: PATHS.respond,
			method: 'POST',
			body: { engagementId, response: 'confirm' },
			idempotencyKey: 'je.portal.respond.test-key'
		});
	});

	test('an attribution or actor claim is structurally refused before any request leaves', async () => {
		const { calls, request } = stubRequester({
			[PATHS.respond]: { kind: 'success', data: engagementDto(), receipt, correlationId }
		});
		const client = createPortalOperationsLiveClient({ manifest: manifest(), request });
		for (const smuggled of [
			{ engagementId, response: 'confirm', attribution: 'organizer_recorded' },
			{ engagementId, response: 'confirm', confirmingPersonId: personId },
			{ engagementId, response: 'confirm', actorUserId: id(90) },
			{ engagementId: 'not-a-uuid', response: 'confirm' }
		]) {
			expect(
				await client.respondToEngagement(
					smuggled as never,
					'je.portal.respond.test-key'
				)
			).toEqual({
				kind: 'transport_error',
				error: { code: 'invalid_request', retryable: false }
			});
		}
		expect(calls).toHaveLength(0);
	});

	test('a terminal refusal carries its receipt through typed', async () => {
		const outcome = refusalOutcome('portal.engagement_not_open', 'conflict');
		const { request } = stubRequester({
			[PATHS.respond]: { kind: 'outcome', outcome, terminal: true, receipt, correlationId }
		});
		const client = createPortalOperationsLiveClient({ manifest: manifest(), request });
		expect(
			await client.respondToEngagement({ engagementId, response: 'decline' }, 'je.key')
		).toEqual({ kind: 'outcome', outcome, terminal: true, receipt, correlationId });
	});

	test('a non-terminal outcome passes through without a receipt', async () => {
		const outcome: StructuredOutcome = {
			class: 'conflict',
			kind: 'operation.in_progress',
			retryable: true,
			subjects: [],
			detail: null,
			detailSchemaVersion: 1
		};
		const { request } = stubRequester({
			[PATHS.respond]: { kind: 'outcome', outcome, terminal: false, correlationId }
		});
		const client = createPortalOperationsLiveClient({ manifest: manifest(), request });
		expect(
			await client.respondToEngagement({ engagementId, response: 'confirm' }, 'je.key')
		).toEqual({ kind: 'outcome', outcome, terminal: false, correlationId });
	});

	test('a success answering for a different engagement never reads as this response succeeding', async () => {
		const swapped = { ...engagementDto(), id: id(41) };
		const { request } = stubRequester({
			[PATHS.respond]: { kind: 'success', data: swapped, receipt, correlationId }
		});
		const client = createPortalOperationsLiveClient({ manifest: manifest(), request });
		expect(
			await client.respondToEngagement({ engagementId, response: 'confirm' }, 'je.key')
		).toEqual({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });
	});

	test('a receipt from another operation is refused', async () => {
		const foreignReceipt = { ...receipt, operationName: 'engagement.change.draft' };
		const { request } = stubRequester({
			[PATHS.respond]: {
				kind: 'success',
				data: engagementDto(),
				receipt: foreignReceipt,
				correlationId
			}
		});
		const client = createPortalOperationsLiveClient({ manifest: manifest(), request });
		expect(
			await client.respondToEngagement({ engagementId, response: 'confirm' }, 'je.key')
		).toEqual({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });
	});

	test('an unregistered respond operation is typed unavailable and sends nothing', async () => {
		const { calls, request } = stubRequester({});
		const client = createPortalOperationsLiveClient({
			manifest: manifest({ omit: ['respond'] }),
			request
		});
		expect(
			await client.respondToEngagement({ engagementId, response: 'confirm' }, 'je.key')
		).toEqual({
			kind: 'unavailable',
			operation: 'respond',
			reason: 'operation_not_registered'
		});
		expect(calls).toHaveLength(0);
	});
});
