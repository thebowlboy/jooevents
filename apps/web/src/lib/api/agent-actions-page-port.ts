import {
	agentActionBatchViewSchema,
	type AgentActionBatchView
} from '@jooevents/contracts';

export type AgentActionCommandResult =
	| { readonly kind: 'success'; readonly data: AgentActionBatchView }
	| { readonly kind: 'refused'; readonly message: string }
	| { readonly kind: 'transport_error'; readonly message: string };

export interface AgentActionsPagePort {
	readonly source: { readonly kind: 'live' | 'sample' };
	list(): Promise<readonly AgentActionBatchView[]>;
	inspect(batchId: string): Promise<AgentActionBatchView | undefined>;
	approve(input: {
		readonly batchId: string;
		readonly expectedVersion: number;
		readonly expectedPlanDigestSha256: string;
	}): Promise<AgentActionCommandResult>;
	pause(input: { readonly batchId: string; readonly expectedVersion: number }): Promise<AgentActionCommandResult>;
	resume(input: { readonly batchId: string; readonly expectedVersion: number }): Promise<AgentActionCommandResult>;
	cancel(input: { readonly batchId: string; readonly expectedVersion: number }): Promise<AgentActionCommandResult>;
}

async function parsedJson(response: Response): Promise<unknown> {
	try { return await response.json(); } catch { return undefined; }
}

function messageFrom(value: unknown, fallback: string): string {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const message = (value as { readonly message?: unknown }).message;
		if (typeof message === 'string' && message.trim()) return message;
	}
	return fallback;
}

export function createLiveAgentActionsPagePort(): AgentActionsPagePort {
	async function command(path: string, body: unknown): Promise<AgentActionCommandResult> {
		try {
			const response = await fetch(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify(body)
			});
			const payload = await parsedJson(response);
			if (!response.ok) {
				return {
					kind: response.status >= 500 ? 'transport_error' : 'refused',
					message: messageFrom(payload, response.status >= 500
						? 'The action run could not be reached.'
						: 'The action run changed before this request completed.')
				};
			}
			const parsed = agentActionBatchViewSchema.safeParse(payload);
			return parsed.success
				? { kind: 'success', data: parsed.data }
				: { kind: 'transport_error', message: 'The action run returned an invalid response.' };
		} catch {
			return { kind: 'transport_error', message: 'The action run could not be reached.' };
		}
	}

	const port: AgentActionsPagePort = {
		source: Object.freeze({ kind: 'live' as const }),
		async list() {
			const response = await fetch('/api/agent-actions', { headers: { accept: 'application/json' } });
			if (!response.ok) throw new Error('The action-run directory could not be loaded.');
			const payload = await parsedJson(response);
			if (!Array.isArray(payload)) throw new Error('The action-run directory returned an invalid response.');
			return Object.freeze(payload.map((entry) => agentActionBatchViewSchema.parse(entry)));
		},
		async inspect(batchId) {
			const response = await fetch(`/api/agent-actions/${encodeURIComponent(batchId)}`, {
				headers: { accept: 'application/json' }
			});
			if (response.status === 404) return undefined;
			if (!response.ok) throw new Error('The action run could not be loaded.');
			return agentActionBatchViewSchema.parse(await parsedJson(response));
		},
		approve: (input) => command(`/api/agent-actions/${encodeURIComponent(input.batchId)}/approve`, input),
		pause: (input) => command(`/api/agent-actions/${encodeURIComponent(input.batchId)}/pause`, input),
		resume: (input) => command(`/api/agent-actions/${encodeURIComponent(input.batchId)}/resume`, input),
		cancel: (input) => command(`/api/agent-actions/${encodeURIComponent(input.batchId)}/cancel`, input)
	};
	return Object.freeze(port);
}
