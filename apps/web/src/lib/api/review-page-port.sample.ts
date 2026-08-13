import type { ReviewPagePort, ReviewPageViewer } from './review-page-port';
import type { WorkspaceApi } from './workspace-gateway';

/** Adapts the resettable workspace fixture without changing its behavior. */
export function createSampleReviewPagePort(
	api: WorkspaceApi,
	viewer: ReviewPageViewer
): ReviewPagePort {
	return Object.freeze({
		viewer: Object.freeze({ ...viewer }),
		workspace: Object.freeze({
			reviewPlanExpectedSnapshot(): boolean | null {
				const summary = api.workspace.summarySnapshot();
				return summary ? summary.navCounts.review !== undefined : null;
			}
		}),
		vocab: api.vocab,
		submissions: api.submissions,
		review: api.review,
		speakers: api.speakers,
		tasks: api.tasks,
		schedule: api.schedule
	});
}
