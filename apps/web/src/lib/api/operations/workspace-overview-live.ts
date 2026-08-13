import {
	WORKSPACE_OVERVIEW_OPERATION_SCHEMA_REFS,
	workspaceOverviewReadResultSchema,
	type WorkspaceOverviewReadResult
} from '@jooevents/contracts/workspace-overview';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import {
	resolveOperatorHttpBinding,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const WORKSPACE_OVERVIEW_READ_OPERATION = Object.freeze({
	name: 'workspace.overview.read',
	version: 1
} as const);

export interface WorkspaceOverviewRequestInput {
	readonly path: string;
	readonly method: 'GET';
	readonly schema: z.ZodType;
	readonly signal?: AbortSignal;
}

export type WorkspaceOverviewRequester = (
	input: WorkspaceOverviewRequestInput
) => Promise<ApiResult<unknown>>;

export type WorkspaceOverviewPortResult =
	| WorkspaceOverviewReadResult
	| {
			readonly kind: 'unavailable';
			readonly reason: OperatorHttpBindingUnavailableReason;
	  }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError };

export interface WorkspaceOverviewPort {
	readonly source: Readonly<{ readonly kind: 'live' }>;
	read(options?: { readonly signal?: AbortSignal }): Promise<WorkspaceOverviewPortResult>;
}

function defaultRequester(input: WorkspaceOverviewRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

/**
 * Resolves the exact registered Overview read. It returns the canonical projection;
 * mapping into the tuned workspace view remains a separate source-neutral adapter.
 */
export function createWorkspaceOverviewLivePort(input: {
	readonly manifest: unknown;
	readonly request?: WorkspaceOverviewRequester;
}): WorkspaceOverviewPort {
	const binding = resolveOperatorHttpBinding({
		manifest: input.manifest,
		expected: {
			...WORKSPACE_OVERVIEW_READ_OPERATION,
			effect: 'read',
			method: 'GET',
			input: 'query',
			idempotencyRequired: false,
			...WORKSPACE_OVERVIEW_OPERATION_SCHEMA_REFS.read
		}
	});
	const request = input.request ?? defaultRequester;

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),
		async read(options: { readonly signal?: AbortSignal } = {}) {
			if (binding.kind === 'unavailable') {
				return { kind: 'unavailable' as const, reason: binding.reason };
			}
			const transport = await request({
				path: binding.path,
				method: 'GET',
				schema: workspaceOverviewReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (transport.kind === 'error') {
				return { kind: 'transport_error' as const, error: transport.error };
			}
			const parsed = workspaceOverviewReadResultSchema.safeParse(transport.data);
			return parsed.success
				? parsed.data
				: {
						kind: 'transport_error' as const,
						error: { code: 'invalid_contract', retryable: true }
					};
		}
	});
}
