import { describe, expect, test } from 'bun:test';
import { sampleWorkspaceGateway } from './sample/gateway';
import { createSampleDecisionsPagePort } from './decisions-page-port.sample';

describe('sample tuned Decisions page port', () => {
	test('keeps the populated candidate and review evidence behind one injected boundary', async () => {
		const port = createSampleDecisionsPagePort(sampleWorkspaceGateway.api);
		const [inbox, late, plans, readiness] = await Promise.all([
			port.submissions.list({ tray: 'inbox' }),
			port.submissions.list({ tray: 'late' }),
			port.review.plans(),
			port.communications.readiness()
		]);

		expect(port.workspace.decisionAttentionExpectedSnapshot()).not.toBeNull();
		expect(inbox.rows.length + late.rows.length).toBeGreaterThan(0);
		expect(plans.length).toBeGreaterThan(0);
		expect(readiness.provider.length).toBeGreaterThan(0);
		expect(['ready', 'action_required', 'unknown', 'not_applicable']).toContain(readiness.outbound);
	});
});
