import { describe, expect, test } from 'bun:test';
import { sampleWorkspaceGateway } from './sample/gateway';
import { createSampleSubmissionsPagePort } from './submissions-page-port.sample';

describe('sample tuned Submissions page port', () => {
	test('keeps the existing populated fixture and interaction dependencies behind one injected port', async () => {
		const port = createSampleSubmissionsPagePort(sampleWorkspaceGateway.api);
		const [page, tracks, formats, collecting] = await Promise.all([
			port.submissions.list({ tray: 'inbox' }),
			port.vocab.tracks(),
			port.vocab.formats(),
			port.schedule.collectingSessions()
		]);

		expect(port.source).toEqual({ kind: 'sample' });
		expect(page.rows.length).toBeGreaterThan(0);
		expect(page.trayTotals.inbox).toBeGreaterThanOrEqual(page.rows.length);
		expect(tracks.length).toBeGreaterThan(0);
		expect(formats.length).toBeGreaterThan(0);
		expect(collecting.every((session) => typeof session.id === 'string' && session.title.length > 0))
			.toBe(true);
	});
});

