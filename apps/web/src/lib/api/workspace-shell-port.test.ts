import { describe, expect, test } from 'bun:test';
import { sampleWorkspaceGateway } from './sample/gateway';
import { createSampleWorkspaceShellPort } from './workspace-shell-port.sample';
import { cloneWorkspaceShellSummary } from './workspace-shell-port';

describe('workspace shell source boundary', () => {
	test('keeps the resettable sample shell on its existing API and source label', async () => {
		const port = createSampleWorkspaceShellPort(sampleWorkspaceGateway);

		expect(port.source).toEqual(sampleWorkspaceGateway.source);
		expect(port.viewer).toEqual(sampleWorkspaceGateway.viewer);
		expect(port.summary.snapshot()).toEqual(
			cloneWorkspaceShellSummary(sampleWorkspaceGateway.api.workspace.summarySnapshot()!)
		);
		expect(await port.summary.read()).toMatchObject({ kind: 'success' });
		expect(await port.account.current()).toEqual(await sampleWorkspaceGateway.api.account.current());
		expect(await port.events?.list()).toEqual(await sampleWorkspaceGateway.api.workspace.events());
		expect(port.account.emailChange).toBeDefined();
		expect(port.createFirstEvent).toBeDefined();
	});

	test('clones shell facts without giving a consumer mutable canonical state', () => {
		const source = {
			event: null,
			lockedAreas: ['forms' as const],
			navCounts: {
				submissions: '12',
				decisions: { value: '3', tone: 'danger' as const }
			}
		};
		const cloned = cloneWorkspaceShellSummary(source);

		expect(cloned).toEqual(source);
		expect(cloned).not.toBe(source);
		expect(cloned.lockedAreas).not.toBe(source.lockedAreas);
		expect(cloned.navCounts).not.toBe(source.navCounts);
		expect(cloned.navCounts.decisions).not.toBe(source.navCounts.decisions);
	});
});
