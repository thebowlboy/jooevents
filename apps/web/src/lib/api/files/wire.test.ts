import { describe, expect, test } from 'bun:test';
import { resolveOperatorHttpBinding } from '../operations/operator-http-binding';
import { resolveParticipantHttpBinding } from '../portal/live/participant-http-binding';
import { laneScopedManifest } from './live-shared';
import {
	filesLiveManifestFixture,
	FILES_COMMAND_WIRE_PATHS,
	FILES_OPERATOR_PATH_PREFIX,
	FILES_PORTAL_PATH_PREFIX,
	FILES_PORTAL_READ_PATH
} from './manifest-fixture';
import {
	assetDownloadPath,
	filesLanePrefix,
	portalEngagementFilesQuery,
	uploadBytesPath,
	DEADLINE_CATALOG_READ_EXPECTATION,
	FILES_COMMAND_ACTIONS,
	FILES_OPERATOR_COMMAND_EXPECTATIONS,
	FILES_ORGANIZER_OVERVIEW_EXPECTATION,
	FILES_PORTAL_COMMAND_ACTIONS,
	FILES_PORTAL_COMMAND_EXPECTATIONS,
	FILES_PORTAL_ENGAGEMENT_FILES_EXPECTATION
} from './wire';

/**
 * The load-bearing agreement test: the schema refs this client recomputes
 * from the published contracts must resolve a manifest carrying the same
 * refs. A drift in key, digest, effect, method, or idempotency posture reads
 * as an unavailable binding here before it can read as one in a browser.
 */

describe('files wire expectations', () => {
	const served = filesLiveManifestFixture();
	// The ports narrow the manifest to their own lane before resolving, because
	// the files commands are registered once per lane under one operation name.
	const operatorManifest = laneScopedManifest(served, 'operator_http');
	const portalManifest = laneScopedManifest(served, 'participant_http');

	test('names the operation identities the producer registered', () => {
		expect(FILES_ORGANIZER_OVERVIEW_EXPECTATION.name).toBe('file.overview.read');
		expect(FILES_PORTAL_ENGAGEMENT_FILES_EXPECTATION.name).toBe('file.portal.engagement-files.read');
		expect(DEADLINE_CATALOG_READ_EXPECTATION.name).toBe('deadline.catalog.read');
		for (const action of FILES_COMMAND_ACTIONS) {
			expect(FILES_OPERATOR_COMMAND_EXPECTATIONS[action].name).toBe(`file.${action}`);
		}
	});

	test('pins the producer schema-ref keys, lane by lane', () => {
		expect(FILES_ORGANIZER_OVERVIEW_EXPECTATION.inputSchema.key).toBe('schema.file.overview.input');
		expect(FILES_ORGANIZER_OVERVIEW_EXPECTATION.resultSchema.key).toBe('schema.file.overview.result');
		expect(FILES_PORTAL_ENGAGEMENT_FILES_EXPECTATION.inputSchema.key)
			.toBe('schema.file.portal-engagement.input');
		expect(FILES_OPERATOR_COMMAND_EXPECTATIONS['upload.intent'].inputSchema.key)
			.toBe('schema.files.command-operations.upload.intent.input');
		expect(FILES_OPERATOR_COMMAND_EXPECTATIONS['upload.intent'].resultSchema.key)
			.toBe('schema.files.command-operations.upload.intent.projected-result');
		expect(FILES_PORTAL_COMMAND_EXPECTATIONS['upload.intent'].inputSchema.key)
			.toBe('schema.files.portal-command-operations.upload.intent.input');
	});

	test('every operator expectation resolves its binding from the fixture manifest', () => {
		const overview = resolveOperatorHttpBinding({
			manifest: operatorManifest,
			expected: FILES_ORGANIZER_OVERVIEW_EXPECTATION
		});
		expect(overview).toEqual({ kind: 'available', path: FILES_OPERATOR_PATH_PREFIX });
		const catalog = resolveOperatorHttpBinding({
			manifest: operatorManifest,
			expected: DEADLINE_CATALOG_READ_EXPECTATION
		});
		expect(catalog.kind).toBe('available');
		for (const action of FILES_COMMAND_ACTIONS) {
			const resolved = resolveOperatorHttpBinding({
				manifest: operatorManifest,
				expected: FILES_OPERATOR_COMMAND_EXPECTATIONS[action]
			});
			expect(resolved).toEqual({
				kind: 'available',
				path: `${FILES_OPERATOR_PATH_PREFIX}/${FILES_COMMAND_WIRE_PATHS[action]}`
			});
		}
	});

	test('every portal expectation resolves its binding, and lanes never cross', () => {
		const read = resolveParticipantHttpBinding({
			manifest: portalManifest,
			expected: FILES_PORTAL_ENGAGEMENT_FILES_EXPECTATION
		});
		expect(read).toEqual({ kind: 'available', path: FILES_PORTAL_READ_PATH });
		for (const action of FILES_PORTAL_COMMAND_ACTIONS) {
			const resolved = resolveParticipantHttpBinding({
				manifest: portalManifest,
				expected: FILES_PORTAL_COMMAND_EXPECTATIONS[action]
			});
			expect(resolved).toEqual({
				kind: 'available',
				path: `${FILES_PORTAL_PATH_PREFIX}/${FILES_COMMAND_WIRE_PATHS[action]}`
			});
		}
		// The portal resolver must not accept the operator registration of the
		// same operation: an operator-only manifest reads as unavailable.
		const operatorOnly = {
			...served,
			operations: served.operations.filter((operation) =>
				operation.enabledBindings.every((binding) => binding.surface === 'operator_http'))
		};
		const crossed = resolveParticipantHttpBinding({
			manifest: laneScopedManifest(operatorOnly, 'participant_http'),
			expected: FILES_PORTAL_COMMAND_EXPECTATIONS['upload.intent']
		});
		expect(crossed.kind).toBe('unavailable');
	});

	test('a drifted digest is refused as a contract mismatch, never repaired', () => {
		const drifted = {
			...served,
			operations: served.operations.map((operation) =>
				operation.name === 'file.upload.intent'
					? {
							...operation,
							inputSchema: { ...operation.inputSchema, digestSha256: 'e'.repeat(64) }
						}
					: operation)
		};
		const resolved = resolveParticipantHttpBinding({
			manifest: laneScopedManifest(drifted, 'participant_http'),
			expected: FILES_PORTAL_COMMAND_EXPECTATIONS['upload.intent']
		});
		expect(resolved).toEqual({ kind: 'unavailable', reason: 'operation_contract_mismatch' });
	});
});

describe('files wire path conventions', () => {
	const intentId = '018f6f00-0000-7000-8000-0000000000aa';

	test('the lane prefix derives from the resolved upload-intent path only', () => {
		expect(filesLanePrefix('/api/portal/files/uploads/intent')).toBe('/api/portal/files');
		expect(filesLanePrefix('/api/events/current/files/uploads/intent'))
			.toBe('/api/events/current/files');
		expect(filesLanePrefix('/api/portal/files/uploads/other')).toBeNull();
		expect(filesLanePrefix('/elsewhere/uploads/intent')).toBeNull();
	});

	test('byte and download routes require canonical ids', () => {
		expect(uploadBytesPath('/api/portal/files', intentId))
			.toBe(`/api/portal/files/uploads/${intentId}/bytes`);
		expect(uploadBytesPath('/api/portal/files', '../escape')).toBeNull();
		expect(assetDownloadPath('/api/portal/files', intentId))
			.toBe(`/api/portal/files/download/${intentId}`);
		expect(assetDownloadPath('/api/portal/files', 'not-an-id')).toBeNull();
	});

	test('the portal subject query spells the one legal subject', () => {
		expect(portalEngagementFilesQuery(intentId))
			.toBe(`engagementId=${intentId}`);
		expect(portalEngagementFilesQuery('nope')).toBeNull();
	});
});
