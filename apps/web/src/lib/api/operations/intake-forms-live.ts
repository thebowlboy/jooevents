import {
	changesetDiffInputSchema,
	changesetDiffOperationResultSchema,
	CHANGESET_OPERATION_SCHEMA_REFS,
	commitChangesetInputSchema,
	committedChangesetOperationResultSchema,
	formClosingChangeDraftInputSchema,
	formDefinitionCreateDraftInputSchema,
	formDefinitionReviseDraftInputSchema,
	formLifecycleChangeDraftInputSchema,
	formVersionPublishDraftInputSchema,
	intakeFormDraftOperationResultSchema,
	INTAKE_OPERATION_SCHEMA_REFS,
	intakeIdInputSchema,
	organizerFormCatalogReadResultSchema,
	organizerFormDetailReadResultSchema,
	proposeChangesetInputSchema,
	proposedChangesetOperationResultSchema,
	type FormDefinitionCreateDraftInput,
	type FormDefinitionReviseDraftInput,
	type FormClosingChangeDraftInput,
	type FormLifecycleChangeDraftInput,
	type FormVersionPublishDraftInput,
	type StructuredOutcome
} from '@jooevents/contracts';
import { z } from 'zod';
import { requestJson, type ApiResult } from '../client';
import {
	mapOrganizerFormCatalog,
	mapOrganizerFormChangesetDiff,
	mapOrganizerFormDetail,
	mapOrganizerFormDraft
} from '../mappers/intake-forms';
import type {
	OrganizerFormChangesetDiffView,
	OrganizerFormCommitView,
	OrganizerFormDraftView,
	OrganizerFormsChangesetEffectInput,
	OrganizerFormsOperation,
	OrganizerFormsPort,
	OrganizerFormsResult
} from '../view-models/intake-forms';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution
} from './operator-http-binding';

export const INTAKE_FORMS_OPERATIONS = Object.freeze({
	list: { name: 'form.list', version: 1, effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false, ...INTAKE_OPERATION_SCHEMA_REFS.formList },
	detail: { name: 'form.read', version: 1, effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false, ...INTAKE_OPERATION_SCHEMA_REFS.formRead },
	draftCreate: { name: 'form.definition.create.draft', version: 1, effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true, ...INTAKE_OPERATION_SCHEMA_REFS.formDrafts.create },
	draftRevise: { name: 'form.definition.revise.draft', version: 1, effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true, ...INTAKE_OPERATION_SCHEMA_REFS.formDrafts.revise },
	draftPublish: { name: 'form.version.publish.draft', version: 1, effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true, ...INTAKE_OPERATION_SCHEMA_REFS.formDrafts.publish },
	draftLifecycle: { name: 'form.lifecycle.change.draft', version: 1, effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true, ...INTAKE_OPERATION_SCHEMA_REFS.formDrafts.lifecycle },
	draftClosing: { name: 'form.closing.change.draft', version: 1, effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true, ...INTAKE_OPERATION_SCHEMA_REFS.formDrafts.closing },
	diff: { name: 'changeset.diff.read', version: 1, effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false, ...CHANGESET_OPERATION_SCHEMA_REFS.diff },
	propose: { name: 'changeset.propose', version: 1, effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true, ...CHANGESET_OPERATION_SCHEMA_REFS.propose },
	commit: { name: 'changeset.commit', version: 1, effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true, ...CHANGESET_OPERATION_SCHEMA_REFS.commit }
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

type BindingKey = keyof typeof INTAKE_FORMS_OPERATIONS;
type Bindings = Readonly<Record<BindingKey, OperatorHttpBindingResolution>>;

function defaultRequester(input: IntakeFormsRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

function unavailable<Data>(
	operation: OrganizerFormsOperation,
	binding: Extract<OperatorHttpBindingResolution, { readonly kind: 'unavailable' }>
): OrganizerFormsResult<Data> {
	return { kind: 'unavailable', operation, reason: binding.reason };
}

function invalidContract<Data>(): OrganizerFormsResult<Data> {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}

function invalidRequest<Data>(): OrganizerFormsResult<Data> {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}

function operationResult<Data>(
	parsed: unknown,
	map: (value: unknown) => Data
): OrganizerFormsResult<Data> {
	const result = parsed as {
		readonly kind: 'success' | 'outcome';
		readonly data?: unknown;
		readonly outcome?: unknown;
		readonly terminal?: boolean;
		readonly correlationId: string;
		readonly receipt?: { readonly id: string; readonly operationName: string; readonly operationVersion: number };
	};
	if (result.kind === 'outcome') {
		return {
			kind: 'outcome',
			outcome: result.outcome as StructuredOutcome,
			...(result.terminal === undefined ? {} : { terminal: result.terminal }),
			correlationId: result.correlationId,
			...(result.receipt ? { receipt: result.receipt } : {})
		};
	}
	return {
		kind: 'success',
		data: map(result.data),
		correlationId: result.correlationId,
		...(result.receipt ? { receipt: result.receipt } : {})
	};
}

async function requestParsed<Data>(input: {
	readonly binding: OperatorHttpBindingResolution;
	readonly operation: OrganizerFormsOperation;
	readonly request: IntakeFormsRequester;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly pathSuffix?: string;
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
	readonly map: (value: unknown) => Data;
}): Promise<OrganizerFormsResult<Data>> {
	if (input.binding.kind === 'unavailable') return unavailable(input.operation, input.binding);
	const transport = await input.request({
		path: `${input.binding.path}${input.pathSuffix ?? ''}`,
		method: input.method,
		schema: input.schema,
		...(input.body === undefined ? {} : { body: input.body }),
		...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
		...(input.signal ? { signal: input.signal } : {})
	});
	if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
	const parsed = input.schema.safeParse(transport.data);
	if (!parsed.success) return invalidContract();
	try {
		return operationResult(parsed.data, input.map);
	} catch {
		return invalidContract();
	}
}

function resolveBindings(manifest: unknown): Bindings {
	return Object.freeze(Object.fromEntries(
		Object.entries(INTAKE_FORMS_OPERATIONS).map(([key, expected]) => [
			key,
			resolveOperatorHttpBinding({ manifest, expected })
		])
	) as unknown as Bindings);
}

/** Pure-live only: every route is manifest-resolved and no result path touches sample state. */
export function createIntakeFormsLivePort(input: {
	readonly manifest: unknown;
	readonly request?: IntakeFormsRequester;
}): OrganizerFormsPort {
	const bindings = resolveBindings(input.manifest);
	const request = input.request ?? defaultRequester;
	const draft = (
		binding: OperatorHttpBindingResolution,
		operation: OrganizerFormsOperation,
		body: unknown,
		idempotencyKey: string,
		signal?: AbortSignal
	) => requestParsed({
		binding,
		operation,
		request,
		schema: intakeFormDraftOperationResultSchema,
		method: 'POST',
		body,
		idempotencyKey,
		...(signal ? { signal } : {}),
		map: (value) => mapOrganizerFormDraft(value as Parameters<typeof mapOrganizerFormDraft>[0])
	});

	const port: OrganizerFormsPort = {
		source: Object.freeze({ kind: 'live' as const }),
		list: (options: { readonly signal?: AbortSignal } = {}) => requestParsed({
			binding: bindings.list,
			operation: 'list',
			request,
			schema: organizerFormCatalogReadResultSchema,
			method: 'GET',
			...(options.signal ? { signal: options.signal } : {}),
			map: (value) => mapOrganizerFormCatalog(value as Parameters<typeof mapOrganizerFormCatalog>[0])
		}),
		readDetail: (rawFormId: string, options: { readonly signal?: AbortSignal } = {}) => {
			const formId = intakeIdInputSchema.safeParse(rawFormId);
			if (!formId.success) return Promise.resolve(invalidRequest());
			return requestParsed({
				binding: bindings.detail,
				operation: 'detail',
				request,
				schema: organizerFormDetailReadResultSchema,
				method: 'GET',
				pathSuffix: `?${new URLSearchParams({ formId: formId.data }).toString()}`,
				...(options.signal ? { signal: options.signal } : {}),
				map: (value) => mapOrganizerFormDetail(value as Parameters<typeof mapOrganizerFormDetail>[0])
			});
		},
		draftCreate: (
			body: FormDefinitionCreateDraftInput,
			key: string,
			options: { readonly signal?: AbortSignal } = {}
		) => {
			const parsed = formDefinitionCreateDraftInputSchema.safeParse(body);
			return parsed.success
				? draft(bindings.draftCreate, 'draft_create', parsed.data, key, options.signal)
				: Promise.resolve(invalidRequest());
		},
		draftRevise: (
			body: FormDefinitionReviseDraftInput,
			key: string,
			options: { readonly signal?: AbortSignal } = {}
		) => {
			const parsed = formDefinitionReviseDraftInputSchema.safeParse(body);
			return parsed.success
				? draft(bindings.draftRevise, 'draft_revise', parsed.data, key, options.signal)
				: Promise.resolve(invalidRequest());
		},
		draftPublish: (
			body: FormVersionPublishDraftInput,
			key: string,
			options: { readonly signal?: AbortSignal } = {}
		) => {
			const parsed = formVersionPublishDraftInputSchema.safeParse(body);
			return parsed.success
				? draft(bindings.draftPublish, 'draft_publish', parsed.data, key, options.signal)
				: Promise.resolve(invalidRequest());
		},
		draftLifecycle: (
			body: FormLifecycleChangeDraftInput,
			key: string,
			options: { readonly signal?: AbortSignal } = {}
		) => {
			const parsed = formLifecycleChangeDraftInputSchema.safeParse(body);
			return parsed.success
				? draft(bindings.draftLifecycle, 'draft_lifecycle', parsed.data, key, options.signal)
				: Promise.resolve(invalidRequest());
		},
		draftClosing: (
			body: FormClosingChangeDraftInput,
			key: string,
			options: { readonly signal?: AbortSignal } = {}
		) => {
			const parsed = formClosingChangeDraftInputSchema.safeParse(body);
			return parsed.success
				? draft(bindings.draftClosing, 'draft_closing', parsed.data, key, options.signal)
				: Promise.resolve(invalidRequest());
		},
		readDiff: (body, options: { readonly signal?: AbortSignal } = {}) => {
			const parsed = changesetDiffInputSchema.safeParse(body);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			const query = new URLSearchParams(parsed.data).toString();
			return requestParsed({
				binding: bindings.diff,
				operation: 'diff',
				request,
				schema: changesetDiffOperationResultSchema,
				method: 'GET',
				pathSuffix: `?${query}`,
				...(options.signal ? { signal: options.signal } : {}),
				map: (value) => mapOrganizerFormChangesetDiff(value as Parameters<typeof mapOrganizerFormChangesetDiff>[0])
			});
		},
		propose: (
			body: OrganizerFormsChangesetEffectInput,
			key: string,
			options: { readonly signal?: AbortSignal } = {}
		) => {
			const parsed = proposeChangesetInputSchema.safeParse(body);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			return requestParsed<OrganizerFormChangesetDiffView>({
				binding: bindings.propose,
				operation: 'propose',
				request,
				schema: proposedChangesetOperationResultSchema,
				method: 'POST',
				body: parsed.data,
				idempotencyKey: key,
				...(options.signal ? { signal: options.signal } : {}),
				map: (value) => mapOrganizerFormChangesetDiff((value as { diff: Parameters<typeof mapOrganizerFormChangesetDiff>[0] }).diff)
			});
		},
		commit: (
			body: OrganizerFormsChangesetEffectInput,
			key: string,
			options: { readonly signal?: AbortSignal } = {}
		) => {
			const parsed = commitChangesetInputSchema.safeParse(body);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			return requestParsed<OrganizerFormCommitView>({
				binding: bindings.commit,
				operation: 'commit',
				request,
				schema: committedChangesetOperationResultSchema,
				method: 'POST',
				body: parsed.data,
				idempotencyKey: key,
				...(options.signal ? { signal: options.signal } : {}),
				map: (value) => {
					const commit = value as OrganizerFormCommitView & { readonly schemaVersion: 1; readonly action: 'commit' };
					return Object.freeze({
						changesetId: commit.changesetId,
						expectedHeadVersion: commit.expectedHeadVersion,
						committedHeadVersion: commit.committedHeadVersion,
						revisionId: commit.revisionId,
						revisionDigest: commit.revisionDigest
					});
				}
			});
		}
	};
	return Object.freeze(port);
}
