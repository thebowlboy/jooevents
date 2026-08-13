import type { TemplatesPagePort } from './templates-page-port';
import type { WorkspaceApi } from './workspace-gateway';

/** Adapts the resettable workspace fixture without changing its behavior. */
export function createSampleTemplatesPagePort(api: WorkspaceApi): TemplatesPagePort {
	return Object.freeze({
		templates: api.templates,
		theme: api.theme,
		workspace: api.workspace,
		schedule: api.schedule,
		vocab: api.vocab,
		speakers: api.speakers,
		forms: api.forms,
		fields: api.fields
	});
}
