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

	test('adds and explicitly removes a Session description in the sample workspace', async () => {
		const port = createSampleSchedulePagePort(sampleWorkspaceGateway.api);
		const session = (await port.schedule.state()).sessions[0]!;
		const original = session.description ?? null;
		try {
			expect(await port.schedule.updateSessionDescription(session.id, 'A public summary.')).toMatchObject({
				description: 'A public summary.'
			});
			expect((await port.schedule.updateSessionDescription(session.id, null)).description).toBeUndefined();
		} finally {
			await port.schedule.updateSessionDescription(session.id, original);
		}
	});
});
