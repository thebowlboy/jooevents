import { describe, expect, test } from 'bun:test';
import {
	intakeFormDirectOperationResultSchema,
	intakeFormVersionReviewDraftOperationResultSchema,
	safeOperationManifestSchema,
	type OperationEffect,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import { intakeFormsFixtureIds, sampleFormRegistryPin, sampleOrganizerFormCatalogDto,
	sampleOrganizerFormDetailDtos } from '../fixtures/intake-forms';
import { mapFormDefinitionToAuthorInput } from '../mappers/intake-forms';
import { createIntakeFormsLivePort, INTAKE_FORMS_OPERATIONS,
	type IntakeFormsRequester } from './intake-forms-live';

const paths = Object.freeze({ list: '/api/events/current/forms', detail: '/api/events/current/forms/detail',
	create: '/api/events/current/forms/create', revise: '/api/events/current/forms/revise',
	closing: '/api/events/current/forms/closing', lifecycle: '/api/events/current/forms/lifecycle',
	draftPublish: '/api/events/current/forms/publish/draft', publish: '/api/events/current/forms/publish' });
type Key = keyof typeof INTAKE_FORMS_OPERATIONS;
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const correlationId = id(90);

function entry(key: Key): SafeOperationManifestEntry {
	const operation = INTAKE_FORMS_OPERATIONS[key];
	const effect = operation.effect as OperationEffect;
	return { name: operation.name, version: 1, lifecycle: { status: 'active' }, summary: operation.name,
		effect, maxRisk: effect === 'read' ? 'low' : 'normal', consequenceTags: [],
		autonomy: { policy: { key: `autonomy.${operation.name}`, version: 1 }, riskFloor: 'low',
			unattendedRiskCeiling: 'normal', requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'], triggerDispositions: {
				authority_lost: 'block', unattended_bounds_exceeded: 'block', approval_required: 'block',
				known_retryable_failure: 'block', ambiguous_external_effect: 'block', stale_plan: 'block',
				compensation_required: 'block', terminal_failure: 'block' } },
		inputSchema: operation.inputSchema,
		idempotency: effect === 'read' ? { required: false } : { required: true,
			keySource: { key: 'idempotency.operator', version: 1 },
			credentialVerifierProfile: { key: 'credential.operator', version: 1 },
			requestHashProfile: { key: 'request-hash.form', version: 1 } },
		concurrency: effect === 'read' ? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: 'concurrency.form', version: 1 } }, outcomes: [],
		enabledBindings: [{ surface: 'operator_http', protocol: 'http', method: operation.method,
			path: paths[key], input: operation.input, resultSchema: operation.resultSchema,
			browserResumption: { kind: 'none' } }] };
}
const manifest = safeOperationManifestSchema.parse({ schemaVersion: 1,
	registryDigestSha256: 'f'.repeat(64), operations: (Object.keys(INTAKE_FORMS_OPERATIONS) as Key[]).map(entry) });
const draftDetail = sampleOrganizerFormDetailDtos[intakeFormsFixtureIds.draftForm]!;
const definition = mapFormDefinitionToAuthorInput(draftDetail.head.definition);
const safeBefore = { id: draftDetail.head.id, version: draftDetail.head.version, status: draftDetail.head.status,
	currentPublishedVersionId: draftDetail.head.currentPublishedVersionId, definition: draftDetail.head.definition };
const reviewData = { schemaVersion: 1 as const, action: 'publish_and_open' as const, draftId: id(40), status: 'draft' as const,
	revision: { id: id(41), number: 1 as const, digestSha256: 'a'.repeat(64) }, safeDiff: {
		action: 'publish_and_open' as const, before: safeBefore,
		after: { ...safeBefore, version: safeBefore.version + 1, status: 'open' as const,
			currentPublishedVersionId: id(42) },
		publishedVersion: { id: id(42), number: 1, definitionDigestSha256: 'b'.repeat(64) },
		surfaceSuccessors: [] } };

function writeResult(action: 'create' | 'revise' | 'set_closing' | 'close' | 'publish_and_open', operationName: string) {
	return intakeFormDirectOperationResultSchema.parse({ kind: 'success', correlationId,
		receipt: { id: id(50), operationName, operationVersion: 1 }, data: { schemaVersion: 1, action,
			formId: draftDetail.head.id, formDefinitionVersion: draftDetail.head.version + 1,
			catalogVersion: sampleOrganizerFormCatalogDto.catalogVersion + 1,
			publishedVersionId: action === 'publish_and_open' ? id(42) : null } });
}
function requester(calls: unknown[]): IntakeFormsRequester {
	return async (request) => {
		calls.push(request);
		if (request.path === paths.draftPublish) return { kind: 'success', data:
			intakeFormVersionReviewDraftOperationResultSchema.parse({ kind: 'success', correlationId,
				receipt: { id: id(51), operationName: 'form.version.publish.draft', operationVersion: 1 }, data: reviewData }) };
		const keyed = (Object.keys(paths) as Key[]).find((key) => paths[key] === request.path);
		if (!keyed || keyed === 'list' || keyed === 'detail' || keyed === 'draftPublish') throw new TypeError('unexpected_path');
		const action = keyed === 'create' ? 'create' : keyed === 'revise' ? 'revise'
			: keyed === 'closing' ? 'set_closing' : keyed === 'lifecycle' ? 'close' : 'publish_and_open';
		return { kind: 'success', data: writeResult(action, INTAKE_FORMS_OPERATIONS[keyed].name) };
	};
}

describe('Form direct and owner-native live client', () => {
	test('uses all six exact write bindings once with each caller key unchanged', async () => {
		const calls: { idempotencyKey?: string; path?: string }[] = [];
		const port = createIntakeFormsLivePort({ manifest, request: requester(calls) });
		const common = { formId: draftDetail.head.id, expectedDefinitionVersion: draftDetail.head.version };
		const actions = [
			() => port.create({ expectedCatalogVersion: sampleOrganizerFormCatalogDto.catalogVersion,
				expectedRegistryVersion: sampleFormRegistryPin.version, definition: { ...definition,
					availability: { kind: 'evergreen' } } }, 'form-create-key'),
			() => port.revise({ ...common, expectedRegistryVersion: sampleFormRegistryPin.version,
				definition }, 'form-revise-key'),
			() => port.closing({ ...common, closesAt: '2027-01-01' }, 'form-closing-key'),
			() => port.lifecycle({ ...common, transition: 'close' }, 'form-lifecycle-key'),
			() => port.draftPublish({ action: 'publish_and_open', ...common,
				expectedRegistryVersion: sampleFormRegistryPin.version }, 'form-publish-draft-key'),
			() => port.publish({ draftId: id(40), revisionId: id(41), revisionDigestSha256: 'a'.repeat(64) },
				'form-publish-key')
		];
		for (const invoke of actions) await invoke();
		expect(calls).toHaveLength(6);
		expect(calls.map((call) => call.idempotencyKey)).toEqual(['form-create-key', 'form-revise-key',
			'form-closing-key', 'form-lifecycle-key', 'form-publish-draft-key', 'form-publish-key']);
		expect(calls.map((call) => call.path)).toEqual([paths.create, paths.revise, paths.closing,
			paths.lifecycle, paths.draftPublish, paths.publish]);
	});

	test('fails closed for a mismatched publish receipt and invalid input before transport', async () => {
		let calls = 0;
		const port = createIntakeFormsLivePort({ manifest, request: async (request) => {
			calls += 1;
			return { kind: 'success', data: { ...writeResult('publish_and_open', 'form.version.publish'),
				receipt: { id: id(60), operationName: 'form.version.publish.draft', operationVersion: 1 } } };
		} });
		expect(await port.publish({ draftId: id(40), revisionId: id(41),
			revisionDigestSha256: 'a'.repeat(64) }, 'publish-key')).toEqual({ kind: 'transport_error',
			error: { code: 'invalid_contract', retryable: true } });
		expect(await port.lifecycle({ transition: 'close', formId: 'bad', expectedDefinitionVersion: 1 }, 'key'))
			.toEqual({ kind: 'transport_error', error: { code: 'invalid_request', retryable: false } });
		expect(calls).toBe(1);
	});
});
