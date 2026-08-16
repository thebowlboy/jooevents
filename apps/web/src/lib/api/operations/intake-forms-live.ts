import {
	formClosingChangeDraftInputSchema,
	formDefinitionCreateDraftInputSchema,
	formDefinitionReviseDraftInputSchema,
	intakeFormDirectLifecycleInputSchema,
	intakeFormDirectOperationResultSchema,
	intakeFormVersionPublishInputSchema,
	intakeFormVersionPublishOperationResultSchema,
	intakeFormVersionReviewDraftOperationResultSchema,
	intakeFormVersionReviewInputSchema,
	INTAKE_OPERATION_SCHEMA_REFS,
	intakeIdInputSchema,
	operationHttpIdempotencyKeySchema,
	organizerFormCatalogReadResultSchema,
	organizerFormDetailReadResultSchema,
	type FormClosingChangeDraftInput,
	type FormDefinitionCreateDraftInput,
	type FormDefinitionReviseDraftInput,
	type IntakeFormVersionPublishInput,
	type IntakeFormVersionReviewInput,
	type OperationReceiptRef
} from '@jooevents/contracts';
import { z } from 'zod';
import { requestJson, type ApiResult } from '../client';
import { mapOrganizerFormCatalog, mapOrganizerFormDetail } from '../mappers/intake-forms';
import type {
	OrganizerFormLifecycleInput,
	OrganizerFormsOperation,
	OrganizerFormsPort,
	OrganizerFormsResult,
	OrganizerFormWriteView
} from '../view-models/intake-forms';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution
} from './operator-http-binding';

const PATHS = Object.freeze({
	list: '/api/events/current/forms',
	detail: '/api/events/current/forms/detail',
	create: '/api/events/current/forms/create',
	revise: '/api/events/current/forms/revise',
	closing: '/api/events/current/forms/closing',
	lifecycle: '/api/events/current/forms/lifecycle',
	draftPublish: '/api/events/current/forms/publish/draft',
	publish: '/api/events/current/forms/publish'
});

export const INTAKE_FORMS_OPERATIONS = Object.freeze({
	list: { name: 'form.list', version: 1, effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false, ...INTAKE_OPERATION_SCHEMA_REFS.formList },
	detail: { name: 'form.read', version: 1, effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false, ...INTAKE_OPERATION_SCHEMA_REFS.formRead },
	create: { name: 'form.definition.create', version: 1, effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true, ...INTAKE_OPERATION_SCHEMA_REFS.formWrites.create },
	revise: { name: 'form.definition.revise', version: 1, effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true, ...INTAKE_OPERATION_SCHEMA_REFS.formWrites.revise },
	closing: { name: 'form.closing.change', version: 1, effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true, ...INTAKE_OPERATION_SCHEMA_REFS.formWrites.closing },
	lifecycle: { name: 'form.lifecycle.change', version: 1, effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true, ...INTAKE_OPERATION_SCHEMA_REFS.formWrites.lifecycle },
	draftPublish: { name: 'form.version.publish.draft', version: 1, effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true, ...INTAKE_OPERATION_SCHEMA_REFS.formWrites.publishDraft },
	publish: { name: 'form.version.publish', version: 1, effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true, ...INTAKE_OPERATION_SCHEMA_REFS.formWrites.publish }
} as const satisfies Record<string, ExpectedOperatorHttpOperation>);

export interface IntakeFormsRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}
export type IntakeFormsRequester = (input: IntakeFormsRequestInput) => Promise<ApiResult<unknown>>;

function defaultRequester(input: IntakeFormsRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}
function invalidContract<Data>(): OrganizerFormsResult<Data> {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}
function invalidRequest<Data>(): OrganizerFormsResult<Data> {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}
function exactBinding(manifest: unknown, key: keyof typeof INTAKE_FORMS_OPERATIONS): OperatorHttpBindingResolution {
	const binding = resolveOperatorHttpBinding({ manifest, expected: INTAKE_FORMS_OPERATIONS[key] });
	return binding.kind === 'available' && binding.path !== PATHS[key]
		? { kind: 'unavailable', reason: 'operation_contract_mismatch' }
		: binding;
}
function receiptMatches(receipt: OperationReceiptRef | undefined, key: keyof typeof INTAKE_FORMS_OPERATIONS): receipt is OperationReceiptRef {
	const operation = INTAKE_FORMS_OPERATIONS[key];
	return receipt?.operationName === operation.name && receipt.operationVersion === operation.version;
}

export function createIntakeFormsLivePort(input: {
	readonly manifest: unknown;
	readonly request?: IntakeFormsRequester;
}): OrganizerFormsPort {
	const request = input.request ?? defaultRequester;
	const bindings = Object.freeze({
		list: exactBinding(input.manifest, 'list'), detail: exactBinding(input.manifest, 'detail'),
		create: exactBinding(input.manifest, 'create'), revise: exactBinding(input.manifest, 'revise'),
		closing: exactBinding(input.manifest, 'closing'), lifecycle: exactBinding(input.manifest, 'lifecycle'),
		draftPublish: exactBinding(input.manifest, 'draftPublish'), publish: exactBinding(input.manifest, 'publish')
	});

	async function write(options: {
		readonly key: 'create' | 'revise' | 'closing' | 'lifecycle' | 'publish';
		readonly operation: OrganizerFormsOperation; readonly body: unknown; readonly idempotencyKey: string;
		readonly signal?: AbortSignal; readonly expectedActions: readonly OrganizerFormWriteView['action'][];
	}): Promise<OrganizerFormsResult<OrganizerFormWriteView>> {
		if (!operationHttpIdempotencyKeySchema.safeParse(options.idempotencyKey).success) return invalidRequest();
		const binding = bindings[options.key];
		if (binding.kind === 'unavailable') return { kind: 'unavailable', operation: options.operation, reason: binding.reason };
		options.signal?.throwIfAborted();
		const schema = options.key === 'publish' ? intakeFormVersionPublishOperationResultSchema : intakeFormDirectOperationResultSchema;
		const transport = await request({ path: binding.path, method: 'POST', schema, body: options.body,
			idempotencyKey: options.idempotencyKey, ...(options.signal ? { signal: options.signal } : {}) });
		if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
		const parsed = schema.safeParse(transport.data);
		if (!parsed.success) return invalidContract();
		const result = parsed.data;
		if (result.kind === 'outcome') {
			if ((result.terminal && !receiptMatches(result.receipt, options.key)) || (!result.terminal && 'receipt' in result)) return invalidContract();
			return { kind: 'outcome', outcome: result.outcome, terminal: result.terminal,
				...('receipt' in result ? { receipt: result.receipt } : {}), correlationId: result.correlationId };
		}
		if (!receiptMatches(result.receipt, options.key) || !options.expectedActions.includes(result.data.action)) return invalidContract();
		return { kind: 'success', data: result.data, receipt: result.receipt, correlationId: result.correlationId };
	}

	const port: OrganizerFormsPort = {
		source: Object.freeze({ kind: 'live' as const }),
		async list(options = {}) {
			const binding = bindings.list;
			if (binding.kind === 'unavailable') return { kind: 'unavailable', operation: 'list', reason: binding.reason };
			const transport = await request({ path: binding.path, method: 'GET', schema: organizerFormCatalogReadResultSchema,
				...(options.signal ? { signal: options.signal } : {}) });
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const parsed = organizerFormCatalogReadResultSchema.safeParse(transport.data);
			if (!parsed.success) return invalidContract();
			return parsed.data.kind === 'outcome'
				? { kind: 'outcome', outcome: parsed.data.outcome, correlationId: parsed.data.correlationId }
				: { kind: 'success', data: mapOrganizerFormCatalog(parsed.data.data), correlationId: parsed.data.correlationId };
		},
		async readDetail(rawFormId, options = {}) {
			const formId = intakeIdInputSchema.safeParse(rawFormId);
			if (!formId.success) return invalidRequest();
			const binding = bindings.detail;
			if (binding.kind === 'unavailable') return { kind: 'unavailable', operation: 'detail', reason: binding.reason };
			const transport = await request({ path: `${binding.path}?${new URLSearchParams({ formId: formId.data }).toString()}`,
				method: 'GET', schema: organizerFormDetailReadResultSchema,
				...(options.signal ? { signal: options.signal } : {}) });
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const parsed = organizerFormDetailReadResultSchema.safeParse(transport.data);
			if (!parsed.success) return invalidContract();
			return parsed.data.kind === 'outcome'
				? { kind: 'outcome', outcome: parsed.data.outcome, correlationId: parsed.data.correlationId }
				: { kind: 'success', data: mapOrganizerFormDetail(parsed.data.data), correlationId: parsed.data.correlationId };
		},
		create(raw, key, options = {}) {
			const parsed = formDefinitionCreateDraftInputSchema.safeParse(raw);
			return parsed.success ? write({ key: 'create', operation: 'create', body: parsed.data, idempotencyKey: key,
				expectedActions: ['create'], ...(options.signal ? { signal: options.signal } : {}) }) : Promise.resolve(invalidRequest());
		},
		revise(raw, key, options = {}) {
			const parsed = formDefinitionReviseDraftInputSchema.safeParse(raw);
			return parsed.success ? write({ key: 'revise', operation: 'revise', body: parsed.data, idempotencyKey: key,
				expectedActions: ['revise'], ...(options.signal ? { signal: options.signal } : {}) }) : Promise.resolve(invalidRequest());
		},
		closing(raw, key, options = {}) {
			const parsed = formClosingChangeDraftInputSchema.safeParse(raw);
			return parsed.success ? write({ key: 'closing', operation: 'closing', body: parsed.data, idempotencyKey: key,
				expectedActions: ['set_closing', 'update_closing', 'remove_closing'], ...(options.signal ? { signal: options.signal } : {}) }) : Promise.resolve(invalidRequest());
		},
		lifecycle(raw, key, options = {}) {
			const parsed = intakeFormDirectLifecycleInputSchema.safeParse(raw);
			return parsed.success ? write({ key: 'lifecycle', operation: 'lifecycle', body: parsed.data, idempotencyKey: key,
				expectedActions: [parsed.data.transition], ...(options.signal ? { signal: options.signal } : {}) }) : Promise.resolve(invalidRequest());
		},
		async draftPublish(raw: IntakeFormVersionReviewInput, key: string, options = {}) {
			const parsedInput = intakeFormVersionReviewInputSchema.safeParse(raw);
			if (!parsedInput.success || !operationHttpIdempotencyKeySchema.safeParse(key).success) return invalidRequest();
			const binding = bindings.draftPublish;
			if (binding.kind === 'unavailable') return { kind: 'unavailable', operation: 'draft_publish', reason: binding.reason };
			const transport = await request({ path: binding.path, method: 'POST', schema: intakeFormVersionReviewDraftOperationResultSchema,
				body: parsedInput.data, idempotencyKey: key, ...(options.signal ? { signal: options.signal } : {}) });
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const parsed = intakeFormVersionReviewDraftOperationResultSchema.safeParse(transport.data);
			if (!parsed.success) return invalidContract();
			const result = parsed.data;
			if (result.kind === 'outcome') {
				if ((result.terminal && !receiptMatches(result.receipt, 'draftPublish')) || (!result.terminal && 'receipt' in result)) return invalidContract();
				return { kind: 'outcome', outcome: result.outcome, terminal: result.terminal,
					...('receipt' in result ? { receipt: result.receipt } : {}), correlationId: result.correlationId };
			}
			if (!receiptMatches(result.receipt, 'draftPublish') || result.data.action !== parsedInput.data.action) return invalidContract();
			return { kind: 'success', data: result.data,
				receipt: result.receipt, correlationId: result.correlationId };
		},
		publish(raw: IntakeFormVersionPublishInput, key: string, options = {}) {
			const parsed = intakeFormVersionPublishInputSchema.safeParse(raw);
			return parsed.success ? write({ key: 'publish', operation: 'publish', body: parsed.data, idempotencyKey: key,
				expectedActions: ['publish', 'publish_and_open'], ...(options.signal ? { signal: options.signal } : {}) }) : Promise.resolve(invalidRequest());
		}
	};
	return Object.freeze(port);
}
