import type { ReviewersPagePort } from './reviewers-page-port';
import type { WorkspaceApi } from './workspace-gateway';

/** Adapts the resettable workspace fixture without changing its behavior. */
export function createSampleReviewersPagePort(api: WorkspaceApi): ReviewersPagePort {
	return Object.freeze({
		reviewers: api.reviewers,
		vocab: api.vocab,
		schedule: api.schedule
	});
}
