import { describe, expect, test } from 'bun:test';
import {
	emailProviderConnectionProjectionSchema,
	organizerEmailReadinessProjectionSchema
} from '@jooevents/contracts';
import {
	mapEmailProviderConnection,
	mapEmailProviderReadiness
} from './communications-provider-read';

const digest = (character: string) => character.repeat(64);
const instant = '2026-08-13T02:00:00.000Z';

const candidate = {
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
};

describe('communication provider read mappers', () => {
	test('retains restricted references and fixed unsupported capabilities without wire aliases', () => {
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

		const view = mapEmailProviderConnection(connection);
		const revision = view.candidateRevisions[0]!;

		expect(revision.configRef).toMatchObject({
			payloadRefId: 'provider-config-ref-1',
			classification: 'restricted'
		});
		expect(revision.secretRequirements).toEqual([{ key: 'api_token', configured: true }]);
		expect(revision.callbacks).toEqual({ state: 'not_supported' });
		expect(revision.inbound).toEqual({ state: 'not_enabled' });
		expect('secretReference' in revision).toBe(false);
		expect(Object.isFrozen(view)).toBe(true);
		expect(Object.isFrozen(revision.configRef)).toBe(true);
		expect(view).not.toBe(connection);
		expect(revision).not.toBe(connection.candidateRevisions[0]);
	});

	test('keeps unconfigured unknown distinct from configured ready evidence', () => {
		const unconfigured = organizerEmailReadinessProjectionSchema.parse({
			schemaVersion: 1,
			outbound: { state: 'unknown', nextStepCode: 'configure_email_provider' },
			callbacks: { state: 'not_supported' },
			inbound: { state: 'not_enabled' }
		});
		const ready = organizerEmailReadinessProjectionSchema.parse({
			schemaVersion: 1,
			provider: {
				adapterKey: candidate.adapterKey,
				adapterVersion: candidate.adapterVersion,
				displayName: 'Registered email adapter'
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

		const unconfiguredView = mapEmailProviderReadiness(unconfigured);
		const readyView = mapEmailProviderReadiness(ready);

		expect('provider' in unconfiguredView).toBe(false);
		expect(unconfiguredView.outbound).toEqual({
			state: 'unknown', nextStepCode: 'configure_email_provider'
		});
		expect(readyView).toMatchObject({
			provider: { adapterKey: candidate.adapterKey },
			outbound: {
				state: 'ready',
				evidence: { evidenceId: 'safe-evidence-1', registeredCode: 'outbound.ready' }
			},
			callbacks: { state: 'not_supported' },
			inbound: { state: 'not_enabled' }
		});
		expect(Object.isFrozen(readyView.outbound)).toBe(true);
		expect(readyView).not.toBe(ready);
	});
});
