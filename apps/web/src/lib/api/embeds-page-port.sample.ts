import type { EmbedsPagePort } from './embeds-page-port';
import type { WorkspaceApi } from './workspace-gateway';

/** Adapts the resettable workspace fixture without changing its behavior. */
export function createSampleEmbedsPagePort(api: WorkspaceApi): EmbedsPagePort {
	return Object.freeze({
		embeds: api.embeds,
		templates: api.templates,
		theme: api.theme,
		workspace: api.workspace,
		settings: api.settings,
		schedule: api.schedule,
		vocab: api.vocab,
		speakers: api.speakers,
		forms: api.forms
	});
}
