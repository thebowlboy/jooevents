import type { CommunicationsPagePort } from './communications-page-port';
import type { WorkspaceApi } from './workspace-gateway';

/** Adapts the resettable workspace fixture without changing its behavior. */
export function createSampleCommunicationsPagePort(api: WorkspaceApi): CommunicationsPagePort {
	return Object.freeze({
		communications: api.communications,
		templates: api.templates,
		theme: api.theme,
		workspace: api.workspace
	});
}
