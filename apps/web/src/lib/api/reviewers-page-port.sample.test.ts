import { describe, expect, test } from 'bun:test';
import { sampleWorkspaceGateway } from './sample/gateway';
import { createSampleReviewersPagePort } from './reviewers-page-port.sample';

describe('sample tuned Reviewers page port', () => {
	test('keeps roster, coverage vocabulary, and session scope behind one boundary', async () => {
		const port = createSampleReviewersPagePort(sampleWorkspaceGateway.api);
		const [roster, tracks, formats, schedule] = await Promise.all([
			port.reviewers.list(),
			port.vocab.tracks(),
			port.vocab.formats(),
			port.schedule.state()
		]);

		expect(roster.reviewers.length).toBeGreaterThan(0);
		expect(tracks.length).toBeGreaterThan(0);
		expect(formats.length).toBeGreaterThan(0);
		expect(schedule.sessions.length).toBeGreaterThan(0);
		expect(port.tasks.reminderAvailability).toEqual({ kind: 'available' });
	});
});
