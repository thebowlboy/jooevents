import { describe, expect, test } from 'bun:test';
import { sampleWorkspaceGateway } from './sample/gateway';
import { createSampleTemplatesPagePort } from './templates-page-port.sample';

describe('sample tuned Templates page port', () => {
	test('keeps authored artifacts, brand, and real preview projections behind one boundary', async () => {
		const port = createSampleTemplatesPagePort(sampleWorkspaceGateway.api);
		const [library, theme, schedule, roster, forms, registry] = await Promise.all([
			port.templates.list(),
			port.theme.get(),
			port.schedule.state(),
			port.speakers.publicRoster(),
			port.forms.list(),
			port.fields.list()
		]);

		expect(library.messages.length).toBeGreaterThan(0);
		expect(library.surfaces.length).toBeGreaterThan(0);
		expect(theme).toHaveProperty('markText');
		expect(schedule.sessions.length).toBeGreaterThan(0);
		expect(roster.length).toBeGreaterThan(0);
		expect(forms.length).toBeGreaterThan(0);
		expect(registry.length).toBeGreaterThan(0);
	});
});
