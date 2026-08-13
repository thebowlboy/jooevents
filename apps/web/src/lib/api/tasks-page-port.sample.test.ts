import { describe, expect, test } from 'bun:test';
import { sampleWorkspaceGateway } from './sample/gateway';
import { createSampleTasksPagePort } from './tasks-page-port.sample';

describe('sample tuned Tasks page port', () => {
	test('keeps task definitions, assignments, roster, and reminder template behind one boundary', async () => {
		const port = createSampleTasksPagePort(sampleWorkspaceGateway.api);
		const [defs, assignments, speakers, templates] = await Promise.all([
			port.tasks.defs(),
			port.tasks.assignments(),
			port.speakers.list(),
			port.templates.list()
		]);

		expect(defs.length).toBeGreaterThan(0);
		expect(assignments.length).toBeGreaterThan(0);
		expect(speakers.length).toBeGreaterThan(0);
		expect(templates.messages.some((template) => template.key === 'task-reminder')).toBe(true);
	});
});
