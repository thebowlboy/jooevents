import { describe, expect, test } from 'bun:test';
import { sampleWorkspaceGateway } from './sample/gateway';
import { createSampleFormsPagePort } from './forms-page-port.sample';

describe('sample tuned Forms page port', () => {
	test('projects the existing form, registry, target, and preview dependencies', async () => {
		const port = createSampleFormsPagePort(sampleWorkspaceGateway.api);
		const [forms, tracks, formats, sessions, surfaceId, publication] = await Promise.all([
			port.forms.list(),
			port.vocab.tracks(),
			port.vocab.formats(),
			port.schedule.sessions(),
			port.templates.applicationFormSurfaceId(),
			port.templates.applicationSurfacePublication()
		]);

		expect(forms.length).toBeGreaterThan(0);
		expect(tracks.length).toBeGreaterThan(0);
		expect(formats.length).toBeGreaterThan(0);
		expect(sessions.some((session) => session.state === 'collecting')).toBe(true);
		expect(surfaceId).toBeTruthy();
		expect(publication).toEqual({ kind: 'any' });
	});
});
