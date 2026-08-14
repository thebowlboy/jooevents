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

	test('the response acts resolve outcomes: commit once, then refuse the stale repeat', async () => {
		const port = createSampleSpeakersPagePort(sampleWorkspaceGateway.api);
		const invited = (await port.speakers.list()).find((row) => row.state === 'invited');
		if (!invited) throw new Error('sample scenario must seed an invited speaker');

		expect(await port.speakers.recordConfirmation(invited.id)).toEqual({ ok: true });
		const confirmed = (await port.speakers.list()).find((row) => row.id === invited.id);
		expect(confirmed?.state).toBe('confirmed');

		// The engagement is no longer awaiting confirmation: a refusal with its
		// reason, never a silent no-op behind a resolved void.
		const repeat = await port.speakers.recordConfirmation(invited.id);
		expect(repeat.ok).toBe(false);
		if (!repeat.ok) expect(repeat.reason.length).toBeGreaterThan(0);

		const missing = await port.speakers.acceptCancellation('spk-never-existed');
		expect(missing.ok).toBe(false);
	});
});
