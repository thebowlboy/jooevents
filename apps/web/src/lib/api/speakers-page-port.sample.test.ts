import { describe, expect, test } from 'bun:test';
import { sampleWorkspaceGateway } from './sample/gateway';
import { createSampleSpeakersPagePort } from './speakers-page-port.sample';

describe('sample tuned Speakers page port', () => {
	test('keeps roster, obligations, lineup groups, and message tails behind one boundary', async () => {
		const port = createSampleSpeakersPagePort(sampleWorkspaceGateway.api);
		const [speakers, defs, assignments, categories] = await Promise.all([
			port.speakers.list(),
			port.tasks.defs(),
			port.tasks.assignments(),
			port.vocab.speakerCategories()
		]);

		expect(speakers.length).toBeGreaterThan(0);
		expect(defs.length).toBeGreaterThan(0);
		expect(assignments.length).toBeGreaterThan(0);
		expect(categories.length).toBeGreaterThan(0);
		expect((await port.communications.thread(speakers[0].id))?.personId).toBe(speakers[0].id);
	});
});
