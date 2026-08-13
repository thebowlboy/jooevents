import type { SchedulePagePort } from './schedule-page-port';
import type { WorkspaceApi } from './workspace-gateway';

/** Adapts the resettable workspace fixture without changing its behavior. */
export function createSampleSchedulePagePort(api: WorkspaceApi): SchedulePagePort {
	return Object.freeze({
		workspace: Object.freeze({
			scheduleAttentionExpectedSnapshot(): boolean | null {
				const summary = api.workspace.summarySnapshot();
				return summary ? summary.navCounts.schedule !== undefined : null;
			}
		}),
		schedule: api.schedule,
		vocab: api.vocab,
		speakers: api.speakers,
		templates: api.templates
	});
}
