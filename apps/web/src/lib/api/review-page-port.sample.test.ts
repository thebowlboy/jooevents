import { describe, expect, test } from 'bun:test';
import { sampleWorkspaceGateway } from './sample/gateway';
import { createSampleReviewPagePort } from './review-page-port.sample';

describe('sample tuned Review page port', () => {
	test('keeps the populated interactive fixture behind one injected boundary', async () => {
		const port = createSampleReviewPagePort(
			sampleWorkspaceGateway.api,
			sampleWorkspaceGateway.viewer
		);
		const [plans, queue, tracks, formats] = await Promise.all([
			port.review.plans(),
			port.review.myQueue(),
			port.vocab.tracks(),
			port.vocab.formats()
		]);

		expect(port.viewer).toEqual(sampleWorkspaceGateway.viewer);
		expect(port.workspace.reviewPlanExpectedSnapshot()).toBe(true);
		expect(plans.length).toBeGreaterThan(0);
		expect(queue.length).toBeGreaterThan(0);
		expect(tracks.length).toBeGreaterThan(0);
		expect(formats.length).toBeGreaterThan(0);
	});
});
