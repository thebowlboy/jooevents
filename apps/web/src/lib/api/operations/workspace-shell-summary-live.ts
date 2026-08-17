import {
	WORKSPACE_SHELL_SUMMARY_OPERATION_SCHEMA_REFS,
	workspaceShellSummaryReadResultSchema,
	type StructuredOutcome,
	type WorkspaceShellSummaryProjection,
	type WorkspaceShellSummaryReadResult
} from '@jooevents/contracts';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const WORKSPACE_SHELL_SUMMARY_READ_OPERATION = Object.freeze({
	name: 'workspace.shell.summary.read', version: 1
} as const);

const EXPECTED_PATH = '/api/workspace/shell-summary';

type ExactExpectedOperation = ExpectedOperatorHttpOperation & { readonly path: string };

export type WorkspaceShellSummaryLiveResult =
	| {
			readonly kind: 'success';
			readonly data: WorkspaceShellSummaryProjection;
			readonly correlationId: string;
	  }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly reason: OperatorHttpBindingUnavailableReason };

export interface WorkspaceShellSummaryLivePort {
	readonly source: { readonly kind: 'live' };
	read(options?: { readonly signal?: AbortSignal }): Promise<WorkspaceShellSummaryLiveResult>;
}

interface ShellSummaryRequestInput {
	readonly path: string;
	readonly schema: typeof workspaceShellSummaryReadResultSchema;
	readonly method: 'GET';
	readonly signal?: AbortSignal;
}

export type WorkspaceShellSummaryRequester = (
	input: ShellSummaryRequestInput
) => Promise<ApiResult<WorkspaceShellSummaryReadResult>>;

const defaultRequester: WorkspaceShellSummaryRequester = (input) =>
	requestJson<WorkspaceShellSummaryReadResult>(input);

function exactBinding(
	manifest: unknown,
	expected: ExactExpectedOperation
): OperatorHttpBindingResolution {
	const binding = resolveOperatorHttpBinding({ manifest, expected });
	return binding.kind === 'available' && binding.path !== expected.path
		? { kind: 'unavailable', reason: 'operation_contract_mismatch' }
		: binding;
}

/**
 * The workspace nameplate's own read: current-event identity and the workspace
 * name, and nothing else.
 *
 * It exists because the shell used to derive its card from the full workspace
 * overview — seven metric families and fifty history threads — so the first
 * thing a person looks at was the last thing to arrive. Identity is cheap and
 * is wanted immediately; counts are expensive and are wanted eventually. They
 * are two reads because they are two costs.
 */
export function createWorkspaceShellSummaryLivePort(input: {
	readonly manifest: unknown;
	readonly request?: WorkspaceShellSummaryRequester;
}): WorkspaceShellSummaryLivePort {
	const binding = exactBinding(input.manifest, {
		...WORKSPACE_SHELL_SUMMARY_READ_OPERATION,
		effect: 'read',
		method: 'GET',
		input: 'query',
		idempotencyRequired: false,
		path: EXPECTED_PATH,
		...WORKSPACE_SHELL_SUMMARY_OPERATION_SCHEMA_REFS.read
	});
	const request = input.request ?? defaultRequester;

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),
		async read(options: { readonly signal?: AbortSignal } = {}) {
			if (binding.kind === 'unavailable') return binding;
			const transport = await request({
				path: binding.path,
				method: 'GET',
				schema: workspaceShellSummaryReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (transport.kind === 'error') return { kind: 'transport_error' as const, error: transport.error };
			const parsed = workspaceShellSummaryReadResultSchema.safeParse(transport.data);
			if (!parsed.success) {
				return { kind: 'transport_error' as const, error: { code: 'invalid_contract', retryable: true } };
			}
			return parsed.data.kind === 'success'
				? {
						kind: 'success' as const,
						data: parsed.data.data,
						correlationId: parsed.data.correlationId
					}
				: {
						kind: 'outcome' as const,
						outcome: parsed.data.outcome,
						correlationId: parsed.data.correlationId
					};
		}
	});
}
