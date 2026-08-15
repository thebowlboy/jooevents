import {
	PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS,
	safeOperationManifestSchema,
	type SafeOperationManifest
} from '@jooevents/contracts';
import {
	DEADLINE_CATALOG_READ_EXPECTATION,
	FILES_COMMAND_ACTIONS,
	FILES_OPERATOR_COMMAND_EXPECTATIONS,
	FILES_ORGANIZER_OVERVIEW_EXPECTATION,
	FILES_PORTAL_COMMAND_ACTIONS,
	FILES_PORTAL_COMMAND_EXPECTATIONS,
	FILES_PORTAL_ENGAGEMENT_FILES_EXPECTATION,
	type ExpectedFilesHttpOperation,
	type FilesCommandAction
} from './wire';

/**
 * A complete, schema-valid operation manifest carrying exactly the files
 * vertical (both lanes) and the deadline catalog read, with the same schema
 * refs the browser clients recompute. Test support only: unit tests prove the
 * resolvers accept it, and the `.live.ts` e2e specs serve it at the HTTP
 * boundary so the live composition runs against the real binding-resolution
 * path. Never imported by production code.
 */

/** The registered wire path suffix of each command under a lane's files prefix. */
export const FILES_COMMAND_WIRE_PATHS = Object.freeze({
	'upload.intent': 'uploads/intent',
	'upload.confirm': 'uploads/confirm',
	'attachment.attach': 'attachments/attach',
	'attachment.link': 'attachments/link',
	'attachment.detach': 'attachments/detach',
	'share.create': 'shares/create',
	'share.revoke': 'shares/revoke',
	'request.create': 'requests/create',
	'request.withdraw': 'requests/withdraw',
	'request.fulfill': 'requests/fulfill'
} as const satisfies Record<FilesCommandAction, string>);

export const FILES_OPERATOR_PATH_PREFIX = '/api/events/current/files';
export const FILES_PORTAL_PATH_PREFIX = '/api/portal/files';
export const FILES_PORTAL_READ_PATH = '/api/portal/engagements/files';
export const DEADLINE_CATALOG_READ_PATH = '/api/events/current/deadlines';

const ref = (key: string) => ({ key, version: 1 });

function manifestEntry(
	expected: ExpectedFilesHttpOperation,
	surface: 'operator_http' | 'participant_http',
	path: string
): unknown {
	const slug = expected.name.replace(/\./gu, '-');
	return {
		name: expected.name,
		version: expected.version,
		lifecycle: { status: 'active' },
		summary: `${expected.name} (files live fixture)`,
		effect: expected.effect,
		maxRisk: expected.effect === 'read' ? 'low' : 'normal',
		autonomy: {
			policy: ref(`autonomy.${slug}`),
			riskFloor: 'low',
			unattendedRiskCeiling: expected.effect === 'read' ? 'low' : 'normal',
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
					keySource: ref('idempotency.operator-header'),
					credentialVerifierProfile: ref(`idempotency.${slug}.credential`),
					requestHashProfile: ref('request-hash.file.command')
				}
			: { required: false },
		concurrency: expected.effect === 'read'
			? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: ref(`concurrency.${slug}`) },
		outcomes: [],
		enabledBindings: [{
			surface,
			protocol: 'http',
			method: expected.method,
			path,
			input: expected.input,
			resultSchema: expected.resultSchema,
			browserResumption: { kind: 'none' }
		}]
	};
}

/** Both lanes and the deadline catalog; parsed so an invalid fixture cannot ship. */
export function filesLiveManifestFixture(): SafeOperationManifest {
	const operations = [
		manifestEntry(
			FILES_ORGANIZER_OVERVIEW_EXPECTATION,
			'operator_http',
			FILES_OPERATOR_PATH_PREFIX
		),
		manifestEntry(
			DEADLINE_CATALOG_READ_EXPECTATION,
			'operator_http',
			DEADLINE_CATALOG_READ_PATH
		),
		...FILES_COMMAND_ACTIONS.map((action) => manifestEntry(
			FILES_OPERATOR_COMMAND_EXPECTATIONS[action],
			'operator_http',
			`${FILES_OPERATOR_PATH_PREFIX}/${FILES_COMMAND_WIRE_PATHS[action]}`
		)),
		manifestEntry(
			FILES_PORTAL_ENGAGEMENT_FILES_EXPECTATION,
			'participant_http',
			FILES_PORTAL_READ_PATH
		),
		...FILES_PORTAL_COMMAND_ACTIONS.map((action) => manifestEntry(
			FILES_PORTAL_COMMAND_EXPECTATIONS[action],
			'participant_http',
			`${FILES_PORTAL_PATH_PREFIX}/${FILES_COMMAND_WIRE_PATHS[action]}`
		))
	];
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: 'f'.repeat(64),
		operations
	});
}

/**
 * The files fixture plus the portal's own core operations (snapshot read and
 * engagement respond), so a `.live.ts` spec can boot the whole portal shell
 * against one served manifest.
 */
export function portalLiveManifestFixture(): SafeOperationManifest {
	const base = filesLiveManifestFixture();
	return safeOperationManifestSchema.parse({
		...base,
		operations: [
			...base.operations,
			manifestEntry(
				{
					name: 'portal.snapshot.read',
					version: 1,
					effect: 'read',
					method: 'GET',
					input: 'query',
					idempotencyRequired: false,
					...PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS.snapshotRead
				},
				'participant_http',
				'/api/portal/snapshot'
			),
			manifestEntry(
				{
					name: 'portal.engagement.respond',
					version: 1,
					effect: 'commit',
					method: 'POST',
					input: 'body',
					idempotencyRequired: true,
					...PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS.engagementRespond
				},
				'participant_http',
				'/api/portal/engagements/respond'
			)
		]
	});
}
