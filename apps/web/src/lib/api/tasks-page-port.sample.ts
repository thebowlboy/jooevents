import type { TasksPagePort } from './tasks-page-port';
import type { WorkspaceApi } from './workspace-gateway';

/** Adapts the resettable workspace fixture without changing its behavior. */
export function createSampleTasksPagePort(api: WorkspaceApi): TasksPagePort {
	return Object.freeze({
		tasks: api.tasks,
		speakers: api.speakers,
		templates: api.templates
	});
}
