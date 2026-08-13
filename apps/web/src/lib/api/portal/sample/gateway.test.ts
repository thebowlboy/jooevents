import { describe, expect, test } from 'bun:test';
import { api, portalScenario } from './api';
import { samplePortalGateway } from './gateway';

describe('sample portal gateway', () => {
	test('wraps the existing sample source without copying its API or scenario', () => {
		expect(samplePortalGateway.api).toBe(api);
		expect(samplePortalGateway.source).toEqual({ kind: 'sample', scenario: portalScenario });
		expect(samplePortalGateway.source.scenario).toBe(portalScenario);
		expect(Object.isFrozen(samplePortalGateway)).toBe(true);
		expect(Object.isFrozen(samplePortalGateway.source)).toBe(true);
		expect(Object.isFrozen(samplePortalGateway.source.scenario)).toBe(true);
	});
});
