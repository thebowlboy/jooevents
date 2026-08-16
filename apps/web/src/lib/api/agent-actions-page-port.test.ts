import { afterEach, describe, expect, test } from 'bun:test';
import { agentActionBatchViewSchema } from '@jooevents/contracts';
import { createLiveAgentActionsPagePort } from './agent-actions-page-port';
import { createSampleAgentActionsPagePort } from './agent-actions-page-port.sample';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('agent action approval page ports', () => {
	test('sample projection preserves visible partial state and cancels only the remainder', async () => {
		const port = createSampleAgentActionsPagePort();
		const [batch] = await port.list();
		expect(agentActionBatchViewSchema.parse(batch)).toEqual(batch!);
		expect(batch?.steps.map((step) => step.status)).toEqual([
			'succeeded', 'succeeded', 'needs_attention', 'pending', 'pending'
		]);
		const result = await port.cancel({ batchId: batch!.plan.batchId, expectedVersion: batch!.version });
		expect(result.kind).toBe('success');
		if (result.kind !== 'success') return;
		expect(result.data.steps.map((step) => step.status)).toEqual([
			'succeeded', 'succeeded', 'cancelled', 'cancelled', 'cancelled'
		]);
	});

	test('live approval makes one same-origin request with the exact digest and version', async () => {
		const [batch] = await createSampleAgentActionsPagePort().list();
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			return Response.json(batch);
		}) as typeof fetch;
		const port = createLiveAgentActionsPagePort();
		const result = await port.approve({
			batchId: batch!.plan.batchId,
			expectedVersion: batch!.version,
			expectedPlanDigestSha256: batch!.planDigestSha256
		});
		expect(result.kind).toBe('success');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`/api/agent-actions/${batch!.plan.batchId}/approve`);
		expect(calls[0]?.init?.method).toBe('POST');
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			batchId: batch!.plan.batchId,
			expectedVersion: batch!.version,
			expectedPlanDigestSha256: batch!.planDigestSha256
		});
	});
});
