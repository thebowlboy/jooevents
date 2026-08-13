import type { DecisionsPagePort } from './decisions-page-port';
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
		decisions: api.decisions,
		communications: api.communications
	});
}
