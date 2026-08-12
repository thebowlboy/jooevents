import { describe, expect, test } from 'bun:test';
import { api, sampleScenario } from '../workspace';
import { sampleWorkspaceGateway } from './gateway';

describe('sample workspace gateway', () => {
	test('wraps the existing sample source without copying its API or scenario', () => {
		expect(sampleWorkspaceGateway.api).toBe(api);
		expect(sampleWorkspaceGateway.source).toEqual({
			kind: 'sample',
			scenario: sampleScenario
		});
		expect(sampleWorkspaceGateway.source.scenario).toBe(sampleScenario);
		expect(Object.isFrozen(sampleWorkspaceGateway)).toBe(true);
		expect(Object.isFrozen(sampleWorkspaceGateway.source)).toBe(true);
		expect(Object.isFrozen(sampleWorkspaceGateway.source.scenario)).toBe(true);
	});
});
