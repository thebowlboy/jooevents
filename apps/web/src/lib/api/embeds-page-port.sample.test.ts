import { describe, expect, test } from 'bun:test';
import { sampleWorkspaceGateway } from './sample/gateway';
import { createSampleEmbedsPagePort } from './embeds-page-port.sample';

describe('sample tuned Embeds page port', () => {
	test('keeps derived publish targets and their real preview projections behind one boundary', async () => {
		const port = createSampleEmbedsPagePort(sampleWorkspaceGateway.api);
		const [targets, speakerTargets, surfaces, settings] = await Promise.all([
			port.embeds.targets(),
			port.embeds.speakerTargets(),
			port.templates.list(),
			port.settings.get()
		]);

		expect(targets.length).toBeGreaterThan(0);
		expect(speakerTargets.length).toBeGreaterThan(0);
		expect(surfaces.surfaces.length).toBeGreaterThan(0);
		expect(settings).not.toBeNull();
		expect(settings?.publicIndexing ?? false).toBe(false);
	});
});
