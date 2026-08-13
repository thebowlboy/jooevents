import { describe, expect, test } from 'bun:test';
import {
	emailProviderConfigurationReadOperationResultSchema,
	emailProviderConnectionProjectionSchema,
	emailProviderReadinessReadOperationResultSchema,
	organizerEmailReadinessProjectionSchema,
	safeOperationManifestSchema,
	type SafeOperationManifest,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import type { ExpectedOperatorHttpOperation } from './operator-http-binding';
import {
	COMMUNICATIONS_PROVIDER_READ_OPERATIONS,
	createCommunicationsProviderReadLivePort,
	type CommunicationsProviderReadRequester,
	type CommunicationsProviderReadRequestInput
} from './communications-provider-read-live';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (character: string) => character.repeat(64);
const correlationId = id(700);
const instant = '2026-08-13T02:00:00.000Z';

const paths = Object.freeze({
	getConnection: '/api/communications/provider-connection',
	getReadiness: '/api/communications/email-readiness'
} as const);

const candidate = Object.freeze({
	revisionId: 'provider-revision-1',
	connectionId: 'provider-connection-1',
	revisionNumber: 1,
	adapterKey: 'registered.email.adapter',
	adapterVersion: 'v1',
	setupManifestKey: 'registered.email.setup',
	setupManifestVersion: 1,
	setupManifestDigestSha256: digest('a'),
	configSchemaVersion: 1,
	configRef: {
		payloadRefId: 'provider-config-ref-1',
		payloadRefVersion: 1,
		payloadKind: 'email_provider_configuration' as const,
		schemaKey: 'communication.provider.configuration',
		schemaVersion: 1,
		classification: 'restricted' as const
	},
	secretRequirements: [{ key: 'api_token', configured: true }],
	configDigestSha256: digest('b'),
	callbacks: { state: 'not_supported' as const },
	inbound: { state: 'not_enabled' as const },
	createdAt: instant
});

const connection = emailProviderConnectionProjectionSchema.parse({
	schemaVersion: 1,
	connectionId: candidate.connectionId,
	workspaceId: 'workspace-1',
	displayName: 'Registered email adapter',
	adapterKey: candidate.adapterKey,
	lifecycle: 'active_outbound',
	headVersion: 2,
	currentRevisionId: candidate.revisionId,
	candidateRevisions: [candidate],
	createdAt: instant,
	updatedAt: instant
});

const ready = organizerEmailReadinessProjectionSchema.parse({
	schemaVersion: 1,
	provider: {
		adapterKey: candidate.adapterKey,
		adapterVersion: candidate.adapterVersion,
		displayName: connection.displayName
	},
	outbound: {
		state: 'ready',
		connectionRevisionId: candidate.revisionId,
		evidence: {
			evidenceId: 'safe-evidence-1',
			registeredCode: 'outbound.ready',
			digestSha256: digest('c'),
			observedAt: instant
		},
		validUntil: '2026-08-14T02:00:00.000Z'
	},
	callbacks: { state: 'not_supported' },
	inbound: { state: 'not_enabled' }
});

const unconfigured = organizerEmailReadinessProjectionSchema.parse({
	schemaVersion: 1,
	outbound: { state: 'unknown', nextStepCode: 'configure_email_provider' },
	callbacks: { state: 'not_supported' },
	inbound: { state: 'not_enabled' }
});

function manifestEntry(
	key: keyof typeof paths,
	expected: ExpectedOperatorHttpOperation,
	path: string = paths[key]
): SafeOperationManifestEntry {
	return {
		name: expected.name,
		version: expected.version,
		lifecycle: { status: 'active' },
		summary: `Read ${expected.name}.`,
		effect: 'read',
		maxRisk: 'normal',
		autonomy: {
			policy: { key: `autonomy.${expected.name}`, version: 1 },
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
		},
		consequenceTags: [],
		inputSchema: expected.inputSchema,
		idempotency: { required: false },
		concurrency: { kind: 'read_snapshot' },
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http',
			protocol: 'http',
			method: 'GET',
			path,
			input: 'query',
			resultSchema: expected.resultSchema,
			browserResumption: { kind: 'none' }
		}]
	};
}

function manifest(input: {
	readonly omit?: keyof typeof paths;
	readonly pathOverride?: { readonly key: keyof typeof paths; readonly path: string };
} = {}): SafeOperationManifest {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('9'),
		operations: Object.entries(COMMUNICATIONS_PROVIDER_READ_OPERATIONS)
			.filter(([key]) => key !== input.omit)
			.map(([key, expected]) => manifestEntry(
				key as keyof typeof paths,
				expected,
				input.pathOverride?.key === key ? input.pathOverride.path : paths[key as keyof typeof paths]
			))
	});
}

function readSuccess(data: unknown) {
	return { kind: 'success' as const, data, correlationId };
}

function requester(
	payloads: Readonly<Record<string, unknown>>,
	calls: CommunicationsProviderReadRequestInput[] = []
): CommunicationsProviderReadRequester {
	return async (request) => {
		calls.push(request);
		const base = request.path.split('?')[0] ?? request.path;
		const payload = payloads[base];
		return payload === undefined
			? { kind: 'error', error: { code: 'unexpected_request', retryable: false } }
			: { kind: 'success', data: payload };
	};
}

describe('pure-live Communications provider read browser port', () => {
	test('reads exact safe connection and readiness projections from both mounted operations', async () => {
		const calls: CommunicationsProviderReadRequestInput[] = [];
		const port = createCommunicationsProviderReadLivePort({
			manifest: manifest(),
			request: requester({
				[paths.getConnection]: emailProviderConfigurationReadOperationResultSchema.parse(
					readSuccess(connection)
				),
				[paths.getReadiness]: emailProviderReadinessReadOperationResultSchema.parse(
					readSuccess(ready)
				)
			}, calls)
		});

		const connectionResult = await port.getConnection({ connectionId: candidate.connectionId });
		const readinessResult = await port.getReadiness({ connectionId: candidate.connectionId });

		expect(port.source).toEqual({ kind: 'live' });
		expect(connectionResult).toMatchObject({
			kind: 'success',
			data: {
				connectionId: candidate.connectionId,
				candidateRevisions: [{
					configRef: { classification: 'restricted' },
					secretRequirements: [{ key: 'api_token', configured: true }],
					callbacks: { state: 'not_supported' },
					inbound: { state: 'not_enabled' }
				}]
			}
		});
		expect(readinessResult).toMatchObject({
			kind: 'success',
			data: {
				outbound: {
					state: 'ready',
					evidence: { evidenceId: 'safe-evidence-1', registeredCode: 'outbound.ready' }
				},
				callbacks: { state: 'not_supported' },
				inbound: { state: 'not_enabled' }
			}
		});
		expect(calls.map((call) => call.path)).toEqual([
			`${paths.getConnection}?connectionId=${candidate.connectionId}`,
			`${paths.getReadiness}?connectionId=${candidate.connectionId}`
		]);
		expect(calls.every((call) => call.method === 'GET')).toBe(true);
		expect('runReadinessCheck' in port).toBe(false);
		expect('sendDiagnosticTest' in port).toBe(false);
	});

	test('preserves unconfigured readiness and structured unavailable outcomes', async () => {
		const unavailable = emailProviderConfigurationReadOperationResultSchema.parse({
			kind: 'outcome',
			correlationId,
			outcome: {
				class: 'conflict',
				kind: 'communication.provider_connection_unavailable',
				retryable: false,
				subjects: [{ type: 'communication.provider_connection', id: 'missing-connection' }],
				detail: null,
				detailSchemaVersion: 1
			}
		});
		if (unavailable.kind !== 'outcome') throw new Error('Expected an outcome fixture.');
		const port = createCommunicationsProviderReadLivePort({
			manifest: manifest(),
			request: requester({
				[paths.getConnection]: unavailable,
				[paths.getReadiness]: emailProviderReadinessReadOperationResultSchema.parse(
					readSuccess(unconfigured)
				)
			})
		});

		expect(await port.getConnection({ connectionId: 'missing-connection' })).toEqual({
			kind: 'outcome', correlationId, outcome: unavailable.outcome
		});
		expect(await port.getReadiness()).toEqual({
			kind: 'success', correlationId,
			data: {
				schemaVersion: 1,
				outbound: { state: 'unknown', nextStepCode: 'configure_email_provider' },
				callbacks: { state: 'not_supported' },
				inbound: { state: 'not_enabled' }
			}
		});
	});

	test('fails closed on absent or moved bindings, invalid input, and mismatched connection identity', async () => {
		const calls: CommunicationsProviderReadRequestInput[] = [];
		const missing = createCommunicationsProviderReadLivePort({
			manifest: manifest({ omit: 'getReadiness' }),
			request: requester({}, calls)
		});
		const moved = createCommunicationsProviderReadLivePort({
			manifest: manifest({
				pathOverride: { key: 'getConnection', path: '/api/communications/moved-provider' }
			}),
			request: requester({}, calls)
		});
		const mismatched = createCommunicationsProviderReadLivePort({
			manifest: manifest(),
			request: requester({
				[paths.getConnection]: emailProviderConfigurationReadOperationResultSchema.parse(
					readSuccess(connection)
				)
			}, calls)
		});

		expect(await missing.getReadiness()).toEqual({
			kind: 'unavailable',
			operation: 'communication.email_readiness.read',
			reason: 'operation_not_registered'
		});
		expect(await moved.getConnection({ connectionId: candidate.connectionId })).toEqual({
			kind: 'unavailable',
			operation: 'communication.provider_connection.read',
			reason: 'operation_contract_mismatch'
		});
		expect(await mismatched.getConnection({ connectionId: 'another-connection' })).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});
		expect(await mismatched.getConnection({ connectionId: '' })).toEqual({
			kind: 'transport_error', error: { code: 'invalid_request', retryable: false }
		});
		expect(calls).toHaveLength(1);
	});
});
