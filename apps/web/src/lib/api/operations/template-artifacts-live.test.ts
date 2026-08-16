import { describe, expect, test } from 'bun:test';
import {
	safeOperationManifestSchema,
	templateArtifactPublishOperationResultSchema,
	templateArtifactReviewDraftOperationResultSchema,
	templateArtifactSafeDiffSchema,
	type OperationEffect,
	type SafeOperationManifestEntry,
	type TemplateArtifactMutationInputDto
} from '@jooevents/contracts';
import {
	createTemplateArtifactLiveClient,
	TEMPLATE_ARTIFACT_LIVE_OPERATIONS,
	type TemplateArtifactRequester
} from './template-artifacts-live';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const scope = { workspaceId: id(1), eventId: id(2) };
const actor = id(3);
const artifactId = id(4);
const document = (subject: string) => ({
	kind: 'message' as const, key: 'welcome', name: 'Welcome', purpose: 'Welcome people.',
	subject, blocks: [], mergeFields: [], usedBy: ['Invitation']
});
const revision = (number: number, subject: string) => ({
	schemaVersion: 1 as const, scope, artifactId, revisionId: id(10 + number), number,
	predecessor: number === 1 ? null : { revisionId: id(10 + number - 1), digestSha256: digest(number === 2 ? 'a' : 'b') },
	document: document(subject), author: 'organizer' as const, note: 'Reviewed change.',
	createdByUserId: actor, createdAt: `2026-08-15T00:0${number}:00.000Z`,
	digestSha256: digest(number === 1 ? 'a' : number === 2 ? 'b' : 'c')
});

type Key = keyof typeof TEMPLATE_ARTIFACT_LIVE_OPERATIONS;
function entry(key: Key): SafeOperationManifestEntry {
	const operation = TEMPLATE_ARTIFACT_LIVE_OPERATIONS[key];
	const effect: OperationEffect = operation.effect;
	return {
		name: operation.name, version: operation.version, lifecycle: { status: 'active' },
		summary: operation.name, effect, maxRisk: effect === 'read' ? 'low' : 'normal',
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
			required: true, keySource: { key: 'idempotency.template', version: 1 },
			credentialVerifierProfile: { key: 'credential.template', version: 1 },
			requestHashProfile: { key: 'request-hash.template', version: 1 }
		} : { required: false },
		concurrency: effect === 'read' ? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: 'concurrency.template', version: 1 } },
		outcomes: [], enabledBindings: [{
			surface: 'operator_http', protocol: 'http', method: operation.method,
			path: operation.path, input: operation.input, resultSchema: operation.resultSchema,
			browserResumption: { kind: 'none' }
		}]
	};
}
function manifest() {
	return safeOperationManifestSchema.parse({ schemaVersion: 1, registryDigestSha256: digest('f'),
		operations: [entry('list'), entry('draft'), entry('publish')] });
}

function fixture(action: 'replace' | 'revert') {
	const before = action === 'replace' ? revision(1, 'Welcome') : revision(2, 'Warmer welcome');
	const after = action === 'replace' ? revision(2, 'Warmer welcome') : revision(3, 'Welcome');
	const safeDiff = templateArtifactSafeDiffSchema.parse({
		action, artifactId, artifactKind: 'message', before, after,
		restoredFromRevisionNumber: action === 'revert' ? 1 : null
	});
	const input: TemplateArtifactMutationInputDto = action === 'replace'
		? { action, artifactId, expectedRevisionNumber: 1, document: after.document,
			author: 'organizer', note: 'Reviewed change.' }
		: { action, artifactId, expectedRevisionNumber: 2, targetRevisionNumber: 1 };
	const draft = templateArtifactReviewDraftOperationResultSchema.parse({
		kind: 'success', correlationId: id(90),
		receipt: { id: id(70), operationName: 'template.artifact.change.draft', operationVersion: 1 },
		data: { schemaVersion: 1, action, draftId: id(action === 'replace' ? 71 : 74), status: 'draft',
			revision: { id: id(action === 'replace' ? 72 : 75), number: 1, digestSha256: digest('d') },
			safeDiff }
	});
	const publish = templateArtifactPublishOperationResultSchema.parse({
		kind: 'success', correlationId: id(91),
		receipt: { id: id(73), operationName: 'template.artifact.change', operationVersion: 1 },
		data: { schemaVersion: 1, action, revision: after, safeDiff }
	});
	return { action, input, draft, publish };
}

describe('Template owner-native live client', () => {
	test('uses one request per stage and forwards both caller keys unchanged', async () => {
		for (const value of [fixture('replace'), fixture('revert')]) {
			const calls: { path: string; idempotencyKey?: string; body?: unknown }[] = [];
			let stage = 0;
			const request: TemplateArtifactRequester = async (input) => {
				calls.push(input);
				return { kind: 'success', data: stage++ === 0 ? value.draft : value.publish };
			};
			const client = createTemplateArtifactLiveClient({ manifest: manifest(), request });
			const keys = { draft: `template-${value.action}-draft`, publish: `template-${value.action}-publish` };
			expect(await client.mutate(value.input, keys)).toMatchObject({
				kind: 'success', data: { safeDiff: { action: value.action } },
				receipt: { operationName: 'template.artifact.change', operationVersion: 1 }
			});
			expect(calls).toHaveLength(2);
			expect(calls.map(({ path, idempotencyKey }) => ({ path, idempotencyKey }))).toEqual([
				{ path: '/api/events/current/template-artifacts/drafts', idempotencyKey: keys.draft },
				{ path: '/api/events/current/template-artifacts/publish', idempotencyKey: keys.publish }
			]);
		}
	});

	test('fails malformed and stage-mismatched results closed', async () => {
		const value = fixture('replace');
		const keys = { draft: 'template-invalid-draft', publish: 'template-invalid-publish' };
		const malformed = createTemplateArtifactLiveClient({ manifest: manifest(), request: async () => ({
			kind: 'success', data: { malformed: true }
		}) });
		expect(await malformed.mutate(value.input, keys)).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});
		const wrong = fixture('revert');
		const mismatch = createTemplateArtifactLiveClient({ manifest: manifest(), request: async () => ({
			kind: 'success', data: wrong.draft
		}) });
		expect(await mismatch.mutate(value.input, keys)).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});
	});
});
