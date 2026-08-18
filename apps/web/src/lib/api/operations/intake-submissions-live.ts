import {
	INTAKE_OPERATION_SCHEMA_REFS,
	intakeIdInputSchema,
	intakePersonSubmissionListInputSchema,
	organizerPersonSubmissionPageReadResultSchema,
	organizerSubmissionContactListReadResultSchema,
	organizerSubmissionContactReadResultSchema,
	organizerSubmissionDetailReadResultSchema,
	organizerSubmissionListReadResultSchema,
	SUBMISSION_CONTACT_LIST_MAX
} from '@jooevents/contracts';
import type { z } from 'zod';
import { requestJson, type ApiResult } from '../client';
import {
	mapOrganizerSubmissionContact,
	mapOrganizerSubmissionDetail,
	mapOrganizerSubmissionSummary
} from '../mappers/intake-submissions';
import type {
	LiveOrganizerSubmissionsPort,
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
export const INTAKE_PERSON_SUBMISSION_LIST_READ_OPERATION = Object.freeze({
	name: 'submission.person.list',
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
export const INTAKE_SUBMISSION_CONTACT_LIST_READ_OPERATION = Object.freeze({
	name: 'submission.contact.list',
	version: 1
} as const);

export {
	organizerSubmissionContactReadResultSchema,
	organizerSubmissionDetailReadResultSchema,
	organizerSubmissionListReadResultSchema
} from '@jooevents/contracts';

type OperationRef =
	| typeof INTAKE_SUBMISSION_LIST_READ_OPERATION
	| typeof INTAKE_PERSON_SUBMISSION_LIST_READ_OPERATION
	| typeof INTAKE_SUBMISSION_DETAIL_READ_OPERATION
	| typeof INTAKE_SUBMISSION_CONTACT_READ_OPERATION
	| typeof INTAKE_SUBMISSION_CONTACT_LIST_READ_OPERATION;

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

function pathForPerson(path: string, personId: string, afterSubmissionId?: string): string | null {
	const parsed = intakePersonSubmissionListInputSchema.safeParse({
		personId,
		...(afterSubmissionId ? { afterSubmissionId } : {})
	});
	if (!parsed.success) return null;
	const query = new URLSearchParams({ personId: parsed.data.personId });
	if (parsed.data.afterSubmissionId) query.set('afterSubmissionId', parsed.data.afterSubmissionId);
	return `${path}?${query.toString()}`;
}

async function readForPerson(
	binding: BindingResolution,
	request: IntakeSubmissionRequester,
	personId: string,
	options: { readonly signal?: AbortSignal }
): Promise<OrganizerSubmissionReadResult<readonly OrganizerSubmissionSummaryView[]>> {
	if (binding.kind === 'unavailable') return unavailable('person_list', binding);
	const rows: OrganizerSubmissionSummaryView[] = [];
	const seenCursors = new Set<string>();
	let afterSubmissionId: string | undefined;
	let correlationId: string | undefined;
	for (;;) {
		const path = pathForPerson(binding.path, personId, afterSubmissionId);
		if (!path) return invalidSubmissionId();
		const transport = await request({
			path,
			method: 'GET',
			schema: organizerPersonSubmissionPageReadResultSchema,
			...(options.signal ? { signal: options.signal } : {})
		});
		if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
		const parsed = organizerPersonSubmissionPageReadResultSchema.safeParse(transport.data);
		if (!parsed.success) return invalidContract();
		if (parsed.data.kind === 'outcome') return parsed.data;
		correlationId = parsed.data.correlationId;
		const pageRows = parsed.data.data.rows.map(mapOrganizerSubmissionSummary);
		const priorCursor = afterSubmissionId;
		if ((priorCursor !== undefined && pageRows.some((row) => row.id <= priorCursor))
			|| (rows.length > 0 && pageRows.length > 0 && rows.at(-1)!.id >= pageRows[0]!.id)) {
			return invalidContract();
		}
		rows.push(...pageRows);
		const next = parsed.data.data.nextAfterSubmissionId;
		if (next === null) {
			return {
				kind: 'success',
				data: Object.freeze(rows),
				...(correlationId ? { correlationId } : {})
			};
		}
		if (seenCursors.has(next) || (afterSubmissionId !== undefined && next <= afterSubmissionId)) {
			return invalidContract();
		}
		seenCursors.add(next);
		afterSubmissionId = next;
	}
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

function pathForContactList(path: string, submissionIds: readonly string[]): string | null {
	const query = new URLSearchParams();
	for (const raw of submissionIds) {
		const parsed = intakeIdInputSchema.safeParse(raw);
		if (!parsed.success) return null;
		query.append('submissionIds', parsed.data);
	}
	if (query.getAll('submissionIds').length === 0) return null;
	return `${path}?${query.toString()}`;
}

function chunked<Value>(values: readonly Value[], size: number): readonly (readonly Value[])[] {
	const chunks: Value[][] = [];
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size));
	}
	return chunks;
}

async function readContactList(
	listBinding: BindingResolution,
	singleBinding: BindingResolution,
	request: IntakeSubmissionRequester,
	submissionIds: readonly string[],
	options: { readonly signal?: AbortSignal }
): Promise<OrganizerSubmissionReadResult<readonly OrganizerSubmissionContactView[]>> {
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const submissionId of submissionIds) {
		const parsed = intakeIdInputSchema.safeParse(submissionId);
		if (!parsed.success) return invalidSubmissionId();
		if (seen.has(parsed.data)) continue;
		seen.add(parsed.data);
		unique.push(parsed.data);
	}
	if (unique.length === 0) return { kind: 'success', data: Object.freeze([]) };

	if (listBinding.kind !== 'unavailable') {
		const rows: OrganizerSubmissionContactView[] = [];
		let correlationId: string | undefined;
		for (const batch of chunked(unique, SUBMISSION_CONTACT_LIST_MAX)) {
			const path = pathForContactList(listBinding.path, batch);
			if (!path) return invalidSubmissionId();
			const transport = await request({
				path,
				method: 'GET',
				schema: organizerSubmissionContactListReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const parsed = organizerSubmissionContactListReadResultSchema.safeParse(transport.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') return parsed.data;
			const allowed = new Set(batch);
			for (const row of parsed.data.data.rows) {
				if (!allowed.has(row.submissionId) || rows.some((entry) => entry.submissionId === row.submissionId)) {
					return invalidContract();
				}
				rows.push(mapOrganizerSubmissionContact(row));
			}
			correlationId = parsed.data.correlationId;
		}
		return {
			kind: 'success',
			data: Object.freeze(rows),
			...(correlationId ? { correlationId } : {})
		};
	}

	const rows: OrganizerSubmissionContactView[] = [];
	for (const batch of chunked(unique, 8)) {
		const found = await Promise.all(
			batch.map((submissionId) => readContact(singleBinding, request, submissionId, options))
		);
		for (const result of found) {
			if (result.kind === 'outcome') {
				if (result.outcome.kind === 'intake.not_found') continue;
				return result;
			}
			if (result.kind === 'unavailable') return result;
			if (result.kind === 'transport_error') return result;
			rows.push(result.data);
		}
	}
	return { kind: 'success', data: Object.freeze(rows) };
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
}): LiveOrganizerSubmissionsPort {
	const listBinding = resolveBinding(
		input.manifest,
		INTAKE_SUBMISSION_LIST_READ_OPERATION,
		INTAKE_OPERATION_SCHEMA_REFS.submissionList
	);
	const personListBinding = resolveBinding(
		input.manifest,
		INTAKE_PERSON_SUBMISSION_LIST_READ_OPERATION,
		INTAKE_OPERATION_SCHEMA_REFS.personSubmissionList
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
	const contactListBinding = resolveBinding(
		input.manifest,
		INTAKE_SUBMISSION_CONTACT_LIST_READ_OPERATION,
		INTAKE_OPERATION_SCHEMA_REFS.submissionContactList
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
						readContact(contactBinding, request, submissionId, options),
					readMany: (submissionIds: readonly string[], options: { readonly signal?: AbortSignal } = {}) =>
						readContactList(contactListBinding, contactBinding, request, submissionIds, options)
				});

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),
		list: (options: { readonly signal?: AbortSignal } = {}) =>
			readList(listBinding, request, options),
		listForPerson: (
			personId: string,
			options: { readonly signal?: AbortSignal } = {}
		) => readForPerson(personListBinding, request, personId, options),
		readDetail: (submissionId: string, options: { readonly signal?: AbortSignal } = {}) =>
			readDetail(detailBinding, request, submissionId, options),
		contact
	});
}
