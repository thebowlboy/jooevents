import { describe, expect, test } from 'bun:test';
import {
	publicThemeTokenNameSchema,
	releaseAuthorInputSchema,
	releaseMutationResultSchema,
	releasePublishOperationResultSchema,
	releaseReviewDraftOperationResultSchema,
	releaseSafeDiffSchema,
	safeOperationManifestSchema,
	type OperationEffect,
	type ReleaseAction,
	type ReleaseAuthorInput,
	type ReleaseMutationResultDto,
	type ReleaseSafeDiffDto,
	type SafeOperationManifestEntry,
	type StructuredOutcome
} from '@jooevents/contracts';
import {
	createReleaseLiveClient,
	RELEASE_LIVE_OPERATIONS,
	type ReleaseRequester
} from './release-live';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const correlationId = id(90);
const scope = { workspaceId: id(1), eventId: id(2) };
const actorUserId = id(3);
const occurredAt = '2026-08-15T00:00:00.000Z';
const pin = { artifactId: id(10), revisionId: id(11), revisionNumber: 1, digestSha256: digest('a') };
const recipe = { name: 'Warm', canvas: '#faf8f5', surface: '#ffffff', text: '#2a2522',
	action: '#b05a4f', radius: 6, controlHeight: 36 };
const tokens = Object.fromEntries(publicThemeTokenNameSchema.options.map((name) => [name, 'initial']));

type OperationKey = keyof typeof RELEASE_LIVE_OPERATIONS;
function entry(key: OperationKey): SafeOperationManifestEntry {
	const operation = RELEASE_LIVE_OPERATIONS[key];
	const effect: OperationEffect = operation.effect;
	return {
		name: operation.name, version: operation.version, lifecycle: { status: 'active' },
		summary: operation.name, effect, maxRisk: effect === 'read' ? 'low' : 'consequential',
		consequenceTags: [], inputSchema: operation.inputSchema,
		autonomy: {
			policy: { key: `autonomy.${operation.name}`, version: 1 }, riskFloor: 'low',
			unattendedRiskCeiling: 'normal', requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'], triggerDispositions: {
				authority_lost: 'block', unattended_bounds_exceeded: 'block', approval_required: 'block',
				known_retryable_failure: 'block', ambiguous_external_effect: 'block', stale_plan: 'block',
				compensation_required: 'block', terminal_failure: 'block'
			}
		},
		idempotency: operation.idempotencyRequired ? {
			required: true, keySource: { key: 'idempotency.release', version: 1 },
			credentialVerifierProfile: { key: 'credential.release', version: 1 },
			requestHashProfile: { key: 'request-hash.release', version: 1 }
		} : { required: false },
		concurrency: effect === 'read' ? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: 'concurrency.release', version: 1 } },
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http', protocol: 'http', method: operation.method,
			path: operation.path, input: operation.input, resultSchema: operation.resultSchema,
			browserResumption: { kind: 'none' }
		}]
	};
}

function manifest() {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1, registryDigestSha256: digest('f'),
		operations: [entry('overview'), entry('draft'), entry('publish')]
	});
}

function chain(releaseId: string, seed: string) {
	return { releaseId, number: 1, digestSha256: digest(seed) };
}

function head(input: { activeReleaseId: string; version: number; origins?: readonly string[] }) {
	return {
		schemaVersion: 1 as const, scope, kind: 'schedule' as const,
		activeReleaseId: input.activeReleaseId, version: input.version,
		allowedFrameOrigins: [...(input.origins ?? [])], updatedByUserId: actorUserId, updatedAt: occurredAt
	};
}

function programRelease(action: 'publish_schedule' | 'program_rollback', releaseId: string) {
	return {
		schemaVersion: 1, scope, id: releaseId, number: 1,
		origin: action === 'publish_schedule' ? { kind: 'publish' } : { kind: 'rollback', restoredFromReleaseId: id(19) },
		predecessor: null,
		pins: { sessionCatalog: { version: 1, digestSha256: digest('b') }, scheduleVersion: 1,
			engagementSnapshotDigestSha256: digest('c'),
			vocabulary: { setVersion: 1, digestSha256: digest('d') }, eventSettingsVersion: 1 },
		rooms: [], sessions: [], nameDeclassifications: [], releasedByUserId: actorUserId,
		releasedAt: occurredAt, digestSha256: digest('e')
	};
}

type Fixture = Readonly<{
	action: ReleaseAction;
	input: ReleaseAuthorInput;
	safeDiff: ReleaseSafeDiffDto;
	mutation: ReleaseMutationResultDto;
}>;

function fixture(action: ReleaseAction): Fixture {
	if (action === 'publish_schedule' || action === 'program_rollback') {
		const releaseId = action === 'publish_schedule' ? id(20) : id(21);
		const release = programRelease(action, releaseId);
		return {
			action,
			input: releaseAuthorInputSchema.parse(action === 'publish_schedule'
				? { action, expectedCurrentReleaseNumber: null }
				: { action, targetReleaseId: id(19), expectedCurrentReleaseNumber: 1 }),
			safeDiff: releaseSafeDiffSchema.parse({ action, before: null, after: chain(releaseId, 'e'),
				releasedSessionCount: 0, releasedOccurrenceCount: 0, nameDeclassifications: [],
				rollbackSuppressions: null }),
			mutation: releaseMutationResultSchema.parse({ action, release })
		};
	}
	if (action === 'style_set_publish') {
		const releaseId = id(30);
		return {
			action,
			input: releaseAuthorInputSchema.parse({ action, sourceTemplateRevision: pin, recipe,
				expectedCurrentStyleSetNumber: null }),
			safeDiff: releaseSafeDiffSchema.parse({ action, before: null, after: chain(releaseId, 'f'),
				sourceTemplateRevision: pin, recipe }),
			mutation: releaseMutationResultSchema.parse({ action, release: {
				schemaVersion: 1, scope, id: releaseId, number: 1, predecessor: null,
				sourceTemplateRevision: pin, recipe, tokens, releasedByUserId: actorUserId,
				releasedAt: occurredAt, digestSha256: digest('f')
			} })
		};
	}
	if (action === 'surface_publish') {
		const releaseId = id(40); const after = head({ activeReleaseId: releaseId, version: 1 });
		return {
			action,
			input: releaseAuthorInputSchema.parse({ action, kind: 'schedule', sourceTemplateRevision: pin,
				manifest: { schemaVersion: 1, heading: 'Schedule', intro: null }, styleSetReleaseId: id(30),
				formRef: null, expectedSurfaceHeadVersion: null }),
			safeDiff: releaseSafeDiffSchema.parse({ action, kind: 'schedule', before: null, after,
				sourceTemplateRevision: pin, styleSetReleaseId: id(30), formRef: null }),
			mutation: releaseMutationResultSchema.parse({ action, head: after, release: {
				kind: 'schedule', schemaVersion: 1, scope, id: releaseId, number: 1, predecessor: null,
				sourceTemplateRevision: pin, manifest: { schemaVersion: 1, heading: 'Schedule', intro: null },
				styleSetReleaseId: id(30), releasedByUserId: actorUserId, releasedAt: occurredAt,
				digestSha256: digest('c')
			} })
		};
	}
	const before = head({ activeReleaseId: id(40), version: 1 });
	const after = action === 'surface_rollback'
		? head({ activeReleaseId: id(41), version: 2 })
		: head({ activeReleaseId: id(40), version: 2, origins: ['https://host.example'] });
	return {
		action,
		input: releaseAuthorInputSchema.parse(action === 'surface_rollback'
			? { action, kind: 'schedule', targetReleaseId: id(41), expectedSurfaceHeadVersion: 1 }
			: { action, kind: 'schedule', allowedFrameOrigins: ['https://host.example'], expectedSurfaceHeadVersion: 1 }),
		safeDiff: releaseSafeDiffSchema.parse({ action, kind: 'schedule', before, after }),
		mutation: releaseMutationResultSchema.parse({ action, head: after })
	};
}

function drafted(value: Fixture) {
	return releaseReviewDraftOperationResultSchema.parse({
		kind: 'success', correlationId,
		receipt: { id: id(70), operationName: 'release.change.draft', operationVersion: 1 },
		data: { schemaVersion: 1, action: value.action, draftId: id(71), status: 'draft',
			revision: { id: id(72), number: 1, digestSha256: digest('a') }, safeDiff: value.safeDiff }
	});
}

function published(value: Fixture) {
	return releasePublishOperationResultSchema.parse({
		kind: 'success', correlationId,
		receipt: { id: id(73), operationName: 'release.publish', operationVersion: 1 },
		data: value.mutation
	});
}

describe('Release owner-native live client', () => {
	test('uses one draft and one publish request with unchanged explicit keys for all six actions', async () => {
		const values = [
			fixture('publish_schedule'), fixture('program_rollback'), fixture('style_set_publish'),
			fixture('surface_publish'), fixture('surface_rollback'), fixture('surface_allowlist')
		];
		const calls: { path: string; body?: unknown; idempotencyKey?: string }[] = [];
		let pending: Fixture | undefined;
		const request: ReleaseRequester = async (requestInput) => {
			calls.push(requestInput);
			if (requestInput.path === RELEASE_LIVE_OPERATIONS.draft.path) {
				const input = releaseAuthorInputSchema.parse(requestInput.body);
				pending = values.find((value) => value.action === input.action);
				if (!pending) throw new TypeError('release_fixture_missing');
				return { kind: 'success', data: drafted(pending) };
			}
			if (!pending) throw new TypeError('release_draft_missing');
			return { kind: 'success', data: published(pending) };
		};
		const client = createReleaseLiveClient({ manifest: manifest(), request });
		for (const value of values) {
			const result = await client.mutate(value.input, {
				draft: `release-${value.action}-draft`, publish: `release-${value.action}-publish`
			});
			expect(result).toMatchObject({ kind: 'success', data: {
				mutation: { action: value.action }, safeDiff: { action: value.action }
			}, receipt: { operationName: 'release.publish', operationVersion: 1 } });
		}
		expect(calls).toHaveLength(12);
		for (const [index, value] of values.entries()) {
			const draft = calls[index * 2]; const publish = calls[index * 2 + 1];
			expect({ path: draft?.path, key: draft?.idempotencyKey }).toEqual({
				path: '/api/events/current/releases/drafts', key: `release-${value.action}-draft`
			});
			expect({ path: publish?.path, key: publish?.idempotencyKey, body: publish?.body }).toEqual({
				path: '/api/events/current/releases/publish', key: `release-${value.action}-publish`,
				body: { draftId: id(71), revisionId: id(72), revisionDigestSha256: digest('a') }
			});
		}
	});

	test('propagates typed refusal and fails malformed or action-mismatched responses closed', async () => {
		const value = fixture('surface_allowlist');
		const outcome: StructuredOutcome = { class: 'access_denied', kind: 'authority.not_authorized',
			retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 };
		const refused = releaseReviewDraftOperationResultSchema.parse({
			kind: 'outcome', outcome, terminal: false, correlationId
		});
		const refusalClient = createReleaseLiveClient({ manifest: manifest(), request: async () => ({
			kind: 'success', data: refused
		}) });
		expect(await refusalClient.mutate(value.input, { draft: 'release-refusal-draft', publish: 'release-refusal-publish' }))
			.toEqual({ kind: 'outcome', outcome, terminal: false, correlationId });

		const malformed = createReleaseLiveClient({ manifest: manifest(), request: async () => ({
			kind: 'success', data: { malformed: true }
		}) });
		expect(await malformed.mutate(value.input, { draft: 'release-malformed-draft', publish: 'release-malformed-publish' }))
			.toEqual({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });

		const mismatchValue = fixture('surface_rollback');
		const mismatch = createReleaseLiveClient({ manifest: manifest(), request: async () => ({
			kind: 'success', data: drafted(mismatchValue)
		}) });
		expect(await mismatch.mutate(value.input, { draft: 'release-mismatch-draft', publish: 'release-mismatch-publish' }))
			.toEqual({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });
	});

	test('fails terminal receipt mismatches and nonterminal receipts closed at both native stages', async () => {
		const value = fixture('surface_allowlist');
		const outcome: StructuredOutcome = { class: 'access_denied', kind: 'authority.not_authorized',
			retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 };
		const keys = { draft: 'release-outcome-draft', publish: 'release-outcome-publish' };
		const invalid = { kind: 'transport_error' as const,
			error: { code: 'invalid_contract', retryable: true } };

		const draftResponses: readonly unknown[] = [
			releaseReviewDraftOperationResultSchema.parse({ kind: 'outcome', outcome, terminal: true,
				correlationId, receipt: { id: id(80), operationName: 'release.publish', operationVersion: 1 } }),
			{ kind: 'outcome', outcome, terminal: false, correlationId,
				receipt: { id: id(81), operationName: 'release.change.draft', operationVersion: 1 } }
		];
		for (const response of draftResponses) {
			const client = createReleaseLiveClient({ manifest: manifest(), request: async () => ({
				kind: 'success', data: response
			}) });
			expect(await client.mutate(value.input, keys)).toEqual(invalid);
		}

		const publishResponses: readonly unknown[] = [
			releasePublishOperationResultSchema.parse({ kind: 'outcome', outcome, terminal: true,
				correlationId, receipt: { id: id(82), operationName: 'release.change.draft', operationVersion: 1 } }),
			{ kind: 'outcome', outcome, terminal: false, correlationId,
				receipt: { id: id(83), operationName: 'release.publish', operationVersion: 1 } }
		];
		for (const response of publishResponses) {
			let draftedStage = false;
			const client = createReleaseLiveClient({ manifest: manifest(), request: async () => {
				if (!draftedStage) { draftedStage = true; return { kind: 'success', data: drafted(value) }; }
				return { kind: 'success', data: response };
			} });
			expect(await client.mutate(value.input, keys)).toEqual(invalid);
		}
	});
});
