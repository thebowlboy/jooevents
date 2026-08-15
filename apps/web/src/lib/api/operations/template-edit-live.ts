import {
	TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS,
	operationHttpIdempotencyKeySchema,
	templateEditClassifyOperationResultSchema,
	templateEditModelChoicesInputSchema,
	templateEditModelChoicesOperationResultSchema,
	templateEditRequestSchema,
	templateEditReviseOperationResultSchema
} from '@jooevents/contracts';
import type { z } from 'zod';
import type { TemplateModelDraftPort } from '../templates-page-port.live';
import type { ReviseProgress } from '../types';
import { requestJson, type ApiResult } from '../client';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution
} from './operator-http-binding';

export const TEMPLATE_EDIT_LIVE_OPERATIONS = Object.freeze({
	choices: {
		name: 'template.edit.model_choices.list', version: 1, effect: 'read',
		method: 'GET', input: 'query', idempotencyRequired: false,
		...TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.modelChoices
	},
	classify: {
		name: 'template.edit.classify', version: 1, effect: 'draft',
		method: 'POST', input: 'body', idempotencyRequired: true,
		...TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.classify
	},
	revise: {
		name: 'template.edit.revise', version: 1, effect: 'draft',
		method: 'POST', input: 'body', idempotencyRequired: true,
		...TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.revise
	}
} as const satisfies Record<string, ExpectedOperatorHttpOperation>);

interface TemplateEditRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
}

type TemplateEditRequester = (input: TemplateEditRequestInput) => Promise<ApiResult<unknown>>;

export class TemplateEditLiveError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = 'TemplateEditLiveError';
		this.code = code;
	}
}

function defaultRequester(input: TemplateEditRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

function requireBinding(
	binding: OperatorHttpBindingResolution,
	label: string
): Extract<OperatorHttpBindingResolution, { readonly kind: 'available' }> {
	if (binding.kind === 'available') return binding;
	throw new TemplateEditLiveError(binding.reason, `${label} is not available in this live workspace.`);
}

function requestKey(action: string): string {
	return operationHttpIdempotencyKeySchema.parse(
		`je.template-model.${action}.${globalThis.crypto.randomUUID()}`
	);
}

function operationFailure(result: {
	readonly outcome: { readonly class: string; readonly kind: string; readonly retryable: boolean };
}): TemplateEditLiveError {
	if (result.outcome.class === 'access_denied') {
		return new TemplateEditLiveError(
			result.outcome.kind,
			'You no longer have permission to use assisted Template editing.'
		);
	}
	if (result.outcome.kind === 'template.artifact.not_found') {
		return new TemplateEditLiveError(result.outcome.kind, 'This template no longer exists.');
	}
	if (result.outcome.kind === 'template.edit.model_choice_unknown') {
		return new TemplateEditLiveError(result.outcome.kind, 'That processing profile is no longer available.');
	}
	return new TemplateEditLiveError(
		result.outcome.kind,
		result.outcome.retryable
			? 'Assisted Template editing could not finish. Try again.'
			: 'Assisted Template editing is not available for this request.'
	);
}

function transportFailure(error: { readonly code: string; readonly retryable: boolean }): never {
	throw new TemplateEditLiveError(
		error.code,
		error.retryable
			? 'Assisted Template editing could not be reached. Try again.'
			: 'This assisted Template request is not valid.'
	);
}

function invalidContract(): never {
	throw new TemplateEditLiveError(
		'invalid_contract',
		'The assisted Template response did not match the live contract.'
	);
}

/** Manifest-resolved client for inert, receipted Template model candidates. */
export function createTemplateEditLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: TemplateEditRequester;
}): TemplateModelDraftPort {
	const choicesBinding = resolveOperatorHttpBinding({
		manifest: input.manifest, expected: TEMPLATE_EDIT_LIVE_OPERATIONS.choices
	});
	const classifyBinding = resolveOperatorHttpBinding({
		manifest: input.manifest, expected: TEMPLATE_EDIT_LIVE_OPERATIONS.classify
	});
	const reviseBinding = resolveOperatorHttpBinding({
		manifest: input.manifest, expected: TEMPLATE_EDIT_LIVE_OPERATIONS.revise
	});
	const request = input.request ?? defaultRequester;

	return Object.freeze({
		async choices() {
			const binding = requireBinding(choicesBinding, 'Template processing profiles');
			const query = templateEditModelChoicesInputSchema.parse({});
			void query;
			const transport = await request({
				path: binding.path,
				method: 'GET',
				schema: templateEditModelChoicesOperationResultSchema
			});
			if (transport.kind === 'error') return transportFailure(transport.error);
			const parsed = templateEditModelChoicesOperationResultSchema.safeParse(transport.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') throw operationFailure(parsed.data);
			return parsed.data.data.choices.map(({ id, label, sub }) => ({ id, label, sub }));
		},

		async classify(artifactId: string, instruction: string, modelId = 'auto') {
			const binding = requireBinding(classifyBinding, 'Assisted Template classification');
			const business = templateEditRequestSchema.safeParse({
				artifactId, instruction, modelChoiceId: modelId
			});
			if (!business.success) {
				throw new TemplateEditLiveError('invalid_request', 'Enter a valid Template instruction.');
			}
			const transport = await request({
				path: binding.path,
				method: 'POST',
				schema: templateEditClassifyOperationResultSchema,
				body: business.data,
				idempotencyKey: requestKey('classify')
			});
			if (transport.kind === 'error') return transportFailure(transport.error);
			const parsed = templateEditClassifyOperationResultSchema.safeParse(transport.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') throw operationFailure(parsed.data);
			if (parsed.data.receipt.operationName !== TEMPLATE_EDIT_LIVE_OPERATIONS.classify.name
				|| parsed.data.receipt.operationVersion !== TEMPLATE_EDIT_LIVE_OPERATIONS.classify.version
				|| parsed.data.data.artifactId !== business.data.artifactId) return invalidContract();
			const classification = parsed.data.data.classification;
			return {
				scope: classification.scope,
				profileLabel: classification.profileLabel,
				reason: classification.reason,
				chosenBy: classification.chosenBy
			};
		},

		async revise(
			artifactId: string,
			instruction: string,
			onProgress?: (progress: ReviseProgress) => void,
			modelId = 'auto'
		) {
			const binding = requireBinding(reviseBinding, 'Assisted Template revision');
			const business = templateEditRequestSchema.safeParse({
				artifactId, instruction, modelChoiceId: modelId
			});
			if (!business.success) {
				throw new TemplateEditLiveError('invalid_request', 'Enter a valid Template instruction.');
			}
			onProgress?.({ status: 'classifying', tokens: 0 });
			const transport = await request({
				path: binding.path,
				method: 'POST',
				schema: templateEditReviseOperationResultSchema,
				body: business.data,
				idempotencyKey: requestKey('revise')
			});
			if (transport.kind === 'error') return transportFailure(transport.error);
			const parsed = templateEditReviseOperationResultSchema.safeParse(transport.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') throw operationFailure(parsed.data);
			if (parsed.data.receipt.operationName !== TEMPLATE_EDIT_LIVE_OPERATIONS.revise.name
				|| parsed.data.receipt.operationVersion !== TEMPLATE_EDIT_LIVE_OPERATIONS.revise.version
				|| parsed.data.data.artifactId !== business.data.artifactId) return invalidContract();
			const tokens = parsed.data.data.usage.outputTokens;
			onProgress?.({ status: 'drafting', tokens });
			onProgress?.({ status: 'done', tokens });
			return { document: parsed.data.data.document, note: parsed.data.data.note };
		}
	});
}
