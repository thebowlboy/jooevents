import { describe, expect, test } from 'bun:test';
import {
	safeOperationManifestSchema,
	type OperationEffect,
	type SafeOperationManifest,
	type SafeOperationManifestEntry,
	intakeFormDraftOperationResultSchema
} from '@jooevents/contracts';
import {
	intakeFormsFixtureIds,
	sampleOrganizerFormCatalogDto,
	sampleOrganizerFormDetailDtos
} from '../fixtures/intake-forms';
import {
	createIntakeFormsLivePort,
	INTAKE_FORMS_OPERATIONS,
	type IntakeFormsRequester
} from './intake-forms-live';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const correlationId = id(990);

type OperationKey = keyof typeof INTAKE_FORMS_OPERATIONS;

function bindingPath(key: OperationKey): string {
	return {
		list: '/api/events/current/forms',
		detail: '/api/events/current/forms/detail',
		draftCreate: '/api/events/current/forms/drafts/create',
		draftRevise: '/api/events/current/forms/drafts/revise',
		draftPublish: '/api/events/current/forms/drafts/publish',
		draftLifecycle: '/api/events/current/forms/drafts/lifecycle',
		draftClosing: '/api/events/current/forms/drafts/closing',
		diff: '/api/changesets/diff',
		propose: '/api/changesets/proposals',
		commit: '/api/changesets/commits'
	}[key];
}

function operation(key: OperationKey, overrides: Partial<SafeOperationManifestEntry> = {}) {
	const expected = INTAKE_FORMS_OPERATIONS[key];
	const effect = expected.effect as OperationEffect;
	return {
		name: expected.name,
		version: expected.version,
		lifecycle: { status: 'active' as const },
		summary: `Execute ${expected.name}.`,
		effect,
		maxRisk: effect === 'commit' ? 'consequential' as const : effect === 'read' ? 'low' as const : 'normal' as const,
		autonomy: {
			policy: { key: `autonomy.${expected.name}`, version: 1 },
			riskFloor: 'low' as const,
			unattendedRiskCeiling: 'low' as const,
			requiresSeparateApproval: false,
			supportedDispositions: ['proceed' as const, 'block' as const],
			triggerDispositions: {
				authority_lost: 'block' as const,
				unattended_bounds_exceeded: 'block' as const,
				approval_required: 'block' as const,
				known_retryable_failure: 'block' as const,
				ambiguous_external_effect: 'block' as const,
				stale_plan: 'block' as const,
				compensation_required: 'block' as const,
				terminal_failure: 'block' as const
			}
		},
		consequenceTags: [],
		inputSchema: expected.inputSchema,
		idempotency: expected.idempotencyRequired
			? {
					required: true as const,
					keySource: { key: 'idempotency.operator_header', version: 1 },
					credentialVerifierProfile: { key: 'credential.idempotency', version: 1 },
					requestHashProfile: { key: 'request_hash.form', version: 1 }
				}
			: { required: false as const },
		concurrency: effect === 'read'
			? { kind: 'read_snapshot' as const }
			: { kind: 'registered' as const, definition: { key: `concurrency.${expected.name}`, version: 1 } },
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http' as const,
			protocol: 'http' as const,
			method: expected.method,
			path: bindingPath(key),
			input: expected.input,
			resultSchema: expected.resultSchema,
			browserResumption: { kind: 'none' as const }
		}],
		...overrides
	};
}

function manifest(keys: readonly OperationKey[] = Object.keys(INTAKE_FORMS_OPERATIONS) as OperationKey[]): SafeOperationManifest {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('f'),
		operations: keys.map((key) => operation(key))
	});
}

const receipt = (operationName: string) => ({
	id: id(991),
	operationName,
	operationVersion: 1
});
const readSuccess = (data: unknown) => ({ kind: 'success', data, correlationId });
const effectSuccess = (data: unknown, operationName: string) => ({
	kind: 'success', data, receipt: receipt(operationName), correlationId
});

function requesterFor(payloads: Readonly<Record<string, unknown>>, calls: unknown[]): IntakeFormsRequester {
	return async (input) => {
		calls.push(input);
		return { kind: 'success', data: payloads[input.path] };
	};
}

describe('pure-live organizer Forms port', () => {
	test('manifest-resolves catalog and detail reads and maps canonical DTOs', async () => {
		const calls: unknown[] = [];
		const detailPath = `${bindingPath('detail')}?formId=${encodeURIComponent(intakeFormsFixtureIds.openForm)}`;
		const port = createIntakeFormsLivePort({
			manifest: manifest(),
			request: requesterFor({
				[bindingPath('list')]: readSuccess(sampleOrganizerFormCatalogDto),
				[detailPath]: readSuccess(sampleOrganizerFormDetailDtos[intakeFormsFixtureIds.openForm])
			}, calls)
		});

		const listed = await port.list();
		expect(listed).toMatchObject({ kind: 'success', data: { catalogVersion: 3 } });
		expect(listed.kind === 'success' ? listed.data.forms[0]?.id : null)
			.toBe(intakeFormsFixtureIds.openForm);
		expect(await port.readDetail(intakeFormsFixtureIds.openForm)).toMatchObject({
			kind: 'success',
			data: { form: { id: intakeFormsFixtureIds.openForm, status: 'open' } }
		});
		expect(calls).toMatchObject([
			{ path: bindingPath('list'), method: 'GET' },
			{ path: detailPath, method: 'GET' }
		]);
	});

	test('maps the entire draft, diff, propose, commit sequence and carries effect keys only in headers', async () => {
		const calls: Array<{ path?: string; body?: unknown; idempotencyKey?: string }> = [];
		const detail = sampleOrganizerFormDetailDtos[intakeFormsFixtureIds.openForm];
		if (!detail) throw new TypeError('Fixture detail missing.');
		const selector = { changesetId: id(700), revisionId: id(701), revisionDigest: digest('c') };
		const safeHead = {
			id: detail.head.id,
			version: detail.head.version,
			status: detail.head.status,
			currentPublishedVersionId: detail.head.currentPublishedVersionId,
			definition: detail.head.definition
		};
		const safeDiff = {
			action: 'lifecycle',
			before: safeHead,
			after: { ...safeHead, version: 3, status: 'closed' },
			publishedVersion: null
		} as const;
		const approvalPolicy = {
			reference: { key: 'approval.form', version: 1 },
			definitionDigestSha256: digest('d'),
			requirement: 'none'
		} as const;
		const draftData = {
			schemaVersion: 1,
			action: 'lifecycle',
			changesetId: selector.changesetId,
			headVersion: 1,
			status: 'draft',
			revision: { id: selector.revisionId, number: 1, digestSha256: selector.revisionDigest },
			riskTier: 'normal',
			approvalPolicy,
			safeDiff
		};
		const diff = {
			changesetId: selector.changesetId,
			headVersion: 1,
			status: 'draft',
			revisionId: selector.revisionId,
			revisionNumber: 1,
			revisionDigest: selector.revisionDigest,
			riskTier: 'normal',
			approvalPolicy,
			operations: [{
				kind: 'intake.form.mutate',
				version: 2,
				riskTier: 'normal',
				dependencyGroup: 'intake_form',
				safeDiff,
				consequences: ['intake_form_changed']
			}]
		};
		const diffPath = `${bindingPath('diff')}?${new URLSearchParams(selector).toString()}`;
		const port = createIntakeFormsLivePort({
			manifest: manifest(),
			request: requesterFor({
				[bindingPath('draftLifecycle')]: effectSuccess(draftData, INTAKE_FORMS_OPERATIONS.draftLifecycle.name),
				[diffPath]: readSuccess(diff),
				[bindingPath('propose')]: effectSuccess({ schemaVersion: 1, action: 'propose', diff: { ...diff, headVersion: 2, status: 'proposed' } }, INTAKE_FORMS_OPERATIONS.propose.name),
				[bindingPath('commit')]: effectSuccess({
					schemaVersion: 1,
					action: 'commit',
					changesetId: selector.changesetId,
					expectedHeadVersion: 2,
					committedHeadVersion: 3,
					revisionId: selector.revisionId,
					revisionDigest: selector.revisionDigest
				}, INTAKE_FORMS_OPERATIONS.commit.name)
			}, calls)
		});
		const debugDraft = intakeFormDraftOperationResultSchema.safeParse(
			effectSuccess(draftData, INTAKE_FORMS_OPERATIONS.draftLifecycle.name)
		);
		if (!debugDraft.success) throw new TypeError(debugDraft.error.message);

		const drafted = await port.draftLifecycle({
			transition: 'close',
			formId: intakeFormsFixtureIds.openForm,
			expectedDefinitionVersion: 2
		}, 'form-close-draft');
		expect(drafted).toMatchObject({ kind: 'success', data: { action: 'lifecycle' } });
		expect(await port.readDiff(selector)).toMatchObject({ kind: 'success', data: { status: 'draft' } });
		expect(await port.propose({ ...selector, expectedHeadVersion: 1 }, 'form-close-propose'))
			.toMatchObject({ kind: 'success', data: { status: 'proposed', headVersion: 2 } });
		expect(await port.commit({ ...selector, expectedHeadVersion: 2 }, 'form-close-commit'))
			.toMatchObject({ kind: 'success', data: { committedHeadVersion: 3 } });
		expect(calls.map((call) => call.idempotencyKey)).toEqual([
			'form-close-draft', undefined, 'form-close-propose', 'form-close-commit'
		]);
		expect(JSON.stringify(calls.map((call) => call.body))).not.toContain('form-close-draft');
	});

	test('dispatches closing intent through the Form-owned operation without a browser deadline id', async () => {
		const calls: Array<{ path?: string; body?: unknown; idempotencyKey?: string }> = [];
		const detail = sampleOrganizerFormDetailDtos[intakeFormsFixtureIds.openForm];
		if (!detail) throw new TypeError('Fixture detail missing.');
		const deadlineId = id(750);
		const safeHead = {
			id: detail.head.id,
			version: detail.head.version,
			status: detail.head.status,
			currentPublishedVersionId: detail.head.currentPublishedVersionId,
			definition: detail.head.definition
		};
		const safeDiff = {
			action: 'closing' as const,
			before: safeHead,
			after: {
				...safeHead,
				version: safeHead.version + 1,
				definition: {
					...safeHead.definition,
					availability: { kind: 'deadline' as const, deadlineId }
				}
			},
			deadline: {
				action: 'create' as const,
				before: null,
				after: {
					id: deadlineId,
					status: 'active' as const,
					version: 1,
					displayDate: '2026-11-01',
					effectiveAt: '2026-11-01T23:59:59.000Z',
					gracePolicy: 'soft' as const
				},
				representedConsequences: ['deadline_changed'] as const
			}
		};
		const draftData = {
			schemaVersion: 1,
			action: 'closing',
			changesetId: id(751),
			headVersion: 1,
			status: 'draft',
			revision: { id: id(752), number: 1, digestSha256: digest('a') },
			riskTier: 'normal',
			approvalPolicy: {
				reference: { key: 'approval.form', version: 1 },
				definitionDigestSha256: digest('d'),
				requirement: 'none'
			},
			safeDiff
		};
		const port = createIntakeFormsLivePort({
			manifest: manifest(),
			request: requesterFor({
				[bindingPath('draftClosing')]: effectSuccess(
					draftData,
					INTAKE_FORMS_OPERATIONS.draftClosing.name
				)
			}, calls)
		});
		expect(await port.draftClosing({
			formId: intakeFormsFixtureIds.openForm,
			expectedDefinitionVersion: detail.head.version,
			closesAt: '2026-11-01'
		}, 'form-closing-draft')).toMatchObject({
			kind: 'success', data: { action: 'closing', safeDiff: { deadline: { action: 'create' } } }
		});
		expect(calls).toMatchObject([{
			path: bindingPath('draftClosing'),
			body: {
				formId: intakeFormsFixtureIds.openForm,
				expectedDefinitionVersion: detail.head.version,
				closesAt: '2026-11-01'
			},
			idempotencyKey: 'form-closing-draft'
		}]);
		expect(JSON.stringify(calls[0]?.body)).not.toContain(deadlineId);
	});

	test('fails closed on a missing binding and never substitutes sample data', async () => {
		let calls = 0;
		const port = createIntakeFormsLivePort({
			manifest: manifest(['detail']),
			request: async () => {
				calls += 1;
				return { kind: 'success', data: readSuccess(sampleOrganizerFormCatalogDto) };
			}
		});
		expect(await port.list()).toEqual({
			kind: 'unavailable', operation: 'list', reason: 'operation_not_registered'
		});
		expect(calls).toBe(0);
	});

	test('fails closed before dispatch when a Form result schema digest drifts', async () => {
		const list = operation('list');
		const advertisedBinding = list.enabledBindings[0];
		if (!advertisedBinding || advertisedBinding.surface !== 'operator_http') {
			throw new TypeError('list_operator_binding_fixture_missing');
		}
		const candidate = safeOperationManifestSchema.parse({
			schemaVersion: 1,
			registryDigestSha256: digest('f'),
			operations: [{
				...list,
				enabledBindings: [{
					...advertisedBinding,
					resultSchema: {
						...advertisedBinding.resultSchema,
						digestSha256: digest('0')
					}
				}]
			}]
		});
		let calls = 0;
		const port = createIntakeFormsLivePort({
			manifest: candidate,
			request: async () => {
				calls += 1;
				return { kind: 'success', data: readSuccess(sampleOrganizerFormCatalogDto) };
			}
		});

		expect(await port.list()).toEqual({
			kind: 'unavailable', operation: 'list', reason: 'operation_contract_mismatch'
		});
		expect(calls).toBe(0);
	});
});
