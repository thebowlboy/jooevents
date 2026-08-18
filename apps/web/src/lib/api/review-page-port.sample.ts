import { assembleReviewResults } from '../features/review/review-results';
import type { ReviewPagePort, ReviewPageViewer, ReviewResultRow } from './review-page-port';
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
		review: Object.freeze({
			...api.review,
			async results(): Promise<ReviewResultRow[]> {
				const page = await api.submissions.list({ tray: 'inbox' });
				const standings = await api.review.standings(page.rows.map((row) => row.id));
				return assembleReviewResults(
					page.rows.map((row) => ({
						submissionId: row.id,
						title: row.title,
						trackId: row.trackId,
						reviews: row.reviewCount
					})),
					standings
				);
			}
		}),
		speakers: api.speakers,
		tasks: api.tasks,
		schedule: api.schedule
	});
}
