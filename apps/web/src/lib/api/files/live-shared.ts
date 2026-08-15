import { safeOperationManifestSchema } from '@jooevents/contracts';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import {
	filesCommandRefusalDetailSchema,
	filesCommandWireResultSchema,
	type FilesCommandAction,
	type FilesCommandData
} from './wire';

/**
 * Shared live plumbing for the two files lanes. One command runner maps every
 * wire answer into the closed vocabulary both ports speak: a typed success, a
 * typed domain refusal, a denial, or the honest "unconfirmed" when no
 * trustworthy server answer exists.
 */

export interface FilesLiveRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

export type FilesLiveRequester = (input: FilesLiveRequestInput) => Promise<ApiResult<unknown>>;

export const defaultFilesRequester: FilesLiveRequester = (input) => requestJson(input);

/**
 * The files commands are registered once per lane under one operation name
 * (`file.<action>` exists on both the operator and the participant modules,
 * each with its own lane-scoped schema identities). The shared binding
 * resolvers demand exactly one manifest entry per operation name, so the
 * manifest is narrowed to the entries carrying a binding on this lane before
 * resolution — lane separation stays checked, and a manifest that is invalid
 * or serves neither lane falls through to the resolver's own refusal.
 */
export function laneScopedManifest(
	manifest: unknown,
	surface: 'operator_http' | 'participant_http'
): unknown {
	const parsed = safeOperationManifestSchema.safeParse(manifest);
	if (!parsed.success) return manifest;
	return {
		...parsed.data,
		operations: parsed.data.operations.filter((operation) =>
			operation.enabledBindings.some((binding) => binding.surface === surface))
	};
}

export type FilesCommandRunResult<Action extends FilesCommandAction> =
	| { readonly kind: 'success'; readonly data: FilesCommandData<Action> }
	| { readonly kind: 'refused'; readonly code: z.infer<typeof filesCommandRefusalDetailSchema>['code'] }
	| { readonly kind: 'denied' }
	| { readonly kind: 'event_required' }
	| { readonly kind: 'unconfirmed' };

function deniedTransport(error: SafeApiError): boolean {
	return error.code === 'unauthenticated' || error.code === 'forbidden';
}

/** Runs one files command against its resolved binding path. */
export async function runFilesCommand<Action extends FilesCommandAction>(input: {
	readonly action: Action;
	readonly path: string;
	readonly body: unknown;
	readonly idempotencyKey: string;
	readonly request: FilesLiveRequester;
}): Promise<FilesCommandRunResult<Action>> {
	const wireSchema = filesCommandWireResultSchema(input.action);
	const response = await input.request({
		path: input.path,
		method: 'POST',
		schema: wireSchema,
		body: input.body,
		idempotencyKey: input.idempotencyKey
	});
	if (response.kind === 'error') {
		return deniedTransport(response.error) ? { kind: 'denied' } : { kind: 'unconfirmed' };
	}
	const parsed = wireSchema.safeParse(response.data);
	if (!parsed.success) return { kind: 'unconfirmed' };
	if (parsed.data.kind === 'success') {
		if (parsed.data.receipt.operationName !== `file.${input.action}`
			|| parsed.data.receipt.operationVersion !== 1) {
			return { kind: 'unconfirmed' };
		}
		return { kind: 'success', data: parsed.data.data as FilesCommandData<Action> };
	}
	const outcome = parsed.data.outcome;
	if (outcome.class === 'access_denied') return { kind: 'denied' };
	if (outcome.kind === 'file.event_required') return { kind: 'event_required' };
	if (outcome.kind === 'file.command_refused') {
		const detail = filesCommandRefusalDetailSchema.safeParse(outcome.detail);
		if (detail.success && detail.data.action === input.action) {
			return { kind: 'refused', code: detail.data.code };
		}
	}
	return { kind: 'unconfirmed' };
}

export type FilesLiveReadResult<Data> =
	| { readonly kind: 'success'; readonly data: Data }
	| { readonly kind: 'failed'; readonly code: string; readonly retryable: boolean };

/** Runs one enveloped read and flattens it into data or a classified failure. */
export async function runFilesRead<Data>(input: {
	readonly path: string;
	readonly wireSchema: z.ZodType<
		| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string }
		| {
				readonly kind: 'outcome';
				readonly outcome: { readonly kind: string; readonly retryable: boolean };
				readonly correlationId: string;
		  }
	>;
	readonly request: FilesLiveRequester;
	readonly signal?: AbortSignal;
}): Promise<FilesLiveReadResult<Data>> {
	const response = await input.request({
		path: input.path,
		method: 'GET',
		schema: input.wireSchema,
		...(input.signal ? { signal: input.signal } : {})
	});
	if (response.kind === 'error') {
		return { kind: 'failed', code: response.error.code, retryable: response.error.retryable };
	}
	const parsed = input.wireSchema.safeParse(response.data);
	if (!parsed.success) return { kind: 'failed', code: 'invalid_contract', retryable: true };
	if (parsed.data.kind === 'outcome') {
		return {
			kind: 'failed',
			code: parsed.data.outcome.kind,
			retryable: parsed.data.outcome.retryable
		};
	}
	return { kind: 'success', data: parsed.data.data };
}
