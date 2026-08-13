import {
	INTAKE_OPERATION_SCHEMA_REFS,
	intakeIdInputSchema,
	organizerSubmissionContactReadResultSchema,
	organizerSubmissionDetailReadResultSchema,
	organizerSubmissionListReadResultSchema
} from '@jooevents/contracts';
import type { z } from 'zod';
import { requestJson, type ApiResult } from '../client';
import {
	mapOrganizerSubmissionContact,
	mapOrganizerSubmissionDetail,
	mapOrganizerSubmissionSummary
} from '../mappers/intake-submissions';
import type {
	OrganizerSubmissionContactView,
	OrganizerSubmissionDetailView,
	OrganizerSubmissionOperation,
	OrganizerSubmissionReadResult,
	OrganizerSubmissionsPort,
	OrganizerSubmissionSummaryView,
	OrganizerSubmissionUnavailableReason
} from '../view-models/intake-submissions';
import {
	resolveOperatorHttpBinding,
	type OperatorHttpBindingResolution
} from './operator-http-binding';

export const INTAKE_SUBMISSION_LIST_READ_OPERATION = Object.freeze({
	name: 'submission.list',
	version: 1
} as const);
export const INTAKE_SUBMISSION_DETAIL_READ_OPERATION = Object.freeze({
	name: 'submission.read',
	version: 1
} as const);
export const INTAKE_SUBMISSION_CONTACT_READ_OPERATION = Object.freeze({
	name: 'submission.contact.read',
	version: 1
} as const);

export {
	organizerSubmissionContactReadResultSchema,
	organizerSubmissionDetailReadResultSchema,
	organizerSubmissionListReadResultSchema
} from '@jooevents/contracts';

type OperationRef =
	| typeof INTAKE_SUBMISSION_LIST_READ_OPERATION
	| typeof INTAKE_SUBMISSION_DETAIL_READ_OPERATION
	| typeof INTAKE_SUBMISSION_CONTACT_READ_OPERATION;

type BindingResolution = OperatorHttpBindingResolution;

export interface IntakeSubmissionRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET';
	readonly signal?: AbortSignal;
}

export type IntakeSubmissionRequester = (
	input: IntakeSubmissionRequestInput
) => Promise<ApiResult<unknown>>;

function resolveBinding(
	manifest: unknown,
	ref: OperationRef,
	schemas: typeof INTAKE_OPERATION_SCHEMA_REFS.submissionList
): BindingResolution {
	return resolveOperatorHttpBinding({
		manifest,
		expected: {
			...ref,
			effect: 'read',
			method: 'GET',
			input: 'query',
			idempotencyRequired: false,
			...schemas
		}
	});
}

function defaultRequester(input: IntakeSubmissionRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

function unavailable<Data>(
	operation: OrganizerSubmissionOperation,
	binding: Extract<BindingResolution, { readonly kind: 'unavailable' }>
): OrganizerSubmissionReadResult<Data> {
	return { kind: 'unavailable', operation, reason: binding.reason };
}

function invalidContract<Data>(): OrganizerSubmissionReadResult<Data> {
	return {
		kind: 'transport_error',
		error: { code: 'invalid_contract', retryable: true }
	};
}

function invalidSubmissionId<Data>(): OrganizerSubmissionReadResult<Data> {
	return {
		kind: 'transport_error',
		error: { code: 'invalid_request', retryable: false }
	};
}

function pathForSubmission(path: string, rawSubmissionId: string): string | null {
	const parsed = intakeIdInputSchema.safeParse(rawSubmissionId);
	if (!parsed.success) return null;
	const query = new URLSearchParams({ submissionId: parsed.data });
	return `${path}?${query.toString()}`;
}

async function readList(
	binding: BindingResolution,
	request: IntakeSubmissionRequester,
	options: { readonly signal?: AbortSignal }
): Promise<OrganizerSubmissionReadResult<readonly OrganizerSubmissionSummaryView[]>> {
	if (binding.kind === 'unavailable') return unavailable('list', binding);
	const transport = await request({
		path: binding.path,
		method: 'GET',
		schema: organizerSubmissionListReadResultSchema,
		...(options.signal ? { signal: options.signal } : {})
	});
	if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
	const parsed = organizerSubmissionListReadResultSchema.safeParse(transport.data);
	if (!parsed.success) return invalidContract();
	if (parsed.data.kind === 'outcome') return parsed.data;
	return {
		kind: 'success',
		data: Object.freeze(parsed.data.data.map(mapOrganizerSubmissionSummary)),
		correlationId: parsed.data.correlationId
	};
}

async function readDetail(
	binding: BindingResolution,
	request: IntakeSubmissionRequester,
	submissionId: string,
	options: { readonly signal?: AbortSignal }
): Promise<OrganizerSubmissionReadResult<OrganizerSubmissionDetailView>> {
	if (binding.kind === 'unavailable') return unavailable('detail', binding);
	const path = pathForSubmission(binding.path, submissionId);
	if (!path) return invalidSubmissionId();
	const transport = await request({
		path,
		method: 'GET',
		schema: organizerSubmissionDetailReadResultSchema,
		...(options.signal ? { signal: options.signal } : {})
	});
	if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
	const parsed = organizerSubmissionDetailReadResultSchema.safeParse(transport.data);
	if (!parsed.success) return invalidContract();
	if (parsed.data.kind === 'outcome') return parsed.data;
	if (parsed.data.data.submissionId !== submissionId) return invalidContract();
	return {
		kind: 'success',
		data: mapOrganizerSubmissionDetail(parsed.data.data),
		correlationId: parsed.data.correlationId
	};
}

async function readContact(
	binding: BindingResolution,
	request: IntakeSubmissionRequester,
	submissionId: string,
	options: { readonly signal?: AbortSignal }
): Promise<OrganizerSubmissionReadResult<OrganizerSubmissionContactView>> {
	if (binding.kind === 'unavailable') return unavailable('contact', binding);
	const path = pathForSubmission(binding.path, submissionId);
	if (!path) return invalidSubmissionId();
	const transport = await request({
		path,
		method: 'GET',
		schema: organizerSubmissionContactReadResultSchema,
		...(options.signal ? { signal: options.signal } : {})
	});
	if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
	const parsed = organizerSubmissionContactReadResultSchema.safeParse(transport.data);
	if (!parsed.success) return invalidContract();
	if (parsed.data.kind === 'outcome') return parsed.data;
	if (parsed.data.data.submissionId !== submissionId) return invalidContract();
	return {
		kind: 'success',
		data: mapOrganizerSubmissionContact(parsed.data.data),
		correlationId: parsed.data.correlationId
	};
}

export type LiveSubmissionContactCapability =
	| { readonly kind: 'available' }
	| { readonly kind: 'unavailable'; readonly reason: 'not_enabled' | 'not_authorized' };

/**
 * Builds the live aggregate from the server-owned operation manifest. Contact
 * availability is supplied explicitly by composition; neither operation
 * registration nor a browser role guess is treated as disclosure authority.
 */
export function createIntakeSubmissionsLivePort(input: {
	readonly manifest: unknown;
	readonly contactCapability: LiveSubmissionContactCapability;
	readonly request?: IntakeSubmissionRequester;
}): OrganizerSubmissionsPort {
	const listBinding = resolveBinding(
		input.manifest,
		INTAKE_SUBMISSION_LIST_READ_OPERATION,
		INTAKE_OPERATION_SCHEMA_REFS.submissionList
	);
	const detailBinding = resolveBinding(
		input.manifest,
		INTAKE_SUBMISSION_DETAIL_READ_OPERATION,
		INTAKE_OPERATION_SCHEMA_REFS.submissionRead
	);
	const contactBinding = resolveBinding(
		input.manifest,
		INTAKE_SUBMISSION_CONTACT_READ_OPERATION,
		INTAKE_OPERATION_SCHEMA_REFS.submissionContactRead
	);
	const request = input.request ?? defaultRequester;
	const contact =
		input.contactCapability.kind === 'unavailable'
			? Object.freeze({
					kind: 'unavailable' as const,
					reason: input.contactCapability.reason
				})
			: Object.freeze({
					kind: 'available' as const,
					read: (submissionId: string, options: { readonly signal?: AbortSignal } = {}) =>
						readContact(contactBinding, request, submissionId, options)
				});

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),
		list: (options: { readonly signal?: AbortSignal } = {}) =>
			readList(listBinding, request, options),
		readDetail: (submissionId: string, options: { readonly signal?: AbortSignal } = {}) =>
			readDetail(detailBinding, request, submissionId, options),
		contact
	});
}
