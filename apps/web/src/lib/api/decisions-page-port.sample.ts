import type { DecisionsPagePort } from './decisions-page-port';
import type { NotificationDispatch } from './types';
import type { WorkspaceApi } from './workspace-gateway';

/** Adapts the resettable workspace fixture without changing its behavior. */
export function createSampleDecisionsPagePort(api: WorkspaceApi): DecisionsPagePort {
	return Object.freeze({
		workspace: Object.freeze({
			decisionAttentionExpectedSnapshot(): boolean | null {
				const summary = api.workspace.summarySnapshot();
				return summary ? summary.navCounts.decisions !== undefined : null;
			}
		}),
		submissions: api.submissions,
		review: api.review,
		vocab: api.vocab,
		settings: api.settings,
		templates: api.templates,
		speakers: api.speakers,
		schedule: api.schedule,
		decisions: Object.freeze({
			...api.decisions,
			/**
			 * The fixture's send records a delivered message row; the dispatch the
			 * page renders is that row's own counts, so the sample states its
			 * simulated delivery rather than the request it was asked for.
			 */
			async notify(ids: string[], subject: string): Promise<NotificationDispatch> {
				const message = await api.decisions.notify(ids, subject);
				return {
					committed: message.audienceCount,
					sent: message.deliveredCount,
					note: 'Delivery state per recipient is tracked in Communications. Result not sent clears once delivery evidence lands.'
				};
			}
		}),
		communications: api.communications
	});
}
