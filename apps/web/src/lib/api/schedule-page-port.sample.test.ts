import { describe, expect, test } from 'bun:test';
import { sampleWorkspaceGateway } from './sample/gateway';
import { createSampleSchedulePagePort } from './schedule-page-port.sample';

describe('sample tuned Schedule page port', () => {
	test('keeps the populated grid, sessions, roster, and public surface behind one boundary', async () => {
		const port = createSampleSchedulePagePort(sampleWorkspaceGateway.api);
		const [schedule, proposals, speakers, templates] = await Promise.all([
			port.schedule.state(),
			port.schedule.proposalTargets(),
			port.speakers.list(),
			port.templates.list()
		]);

		expect(schedule.sessions.length).toBeGreaterThan(0);
		expect(schedule.rooms.length).toBeGreaterThan(0);
		expect(Object.keys(proposals).length).toBeGreaterThan(0);
		expect(speakers.length).toBeGreaterThan(0);
		expect(templates.surfaces.some((surface) => surface.kind === 'schedule')).toBe(true);
	});
});
