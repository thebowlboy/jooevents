import type { WorkspaceApi } from './workspace-gateway';
import type { FormsPagePort } from './forms-page-port';

/** Keeps the tuned Forms page on the resettable fixture without entering live's import graph. */
export function createSampleFormsPagePort(api: WorkspaceApi): FormsPagePort {
	return Object.freeze({
		templates: Object.freeze({
			async applicationFormSurfaceId(): Promise<string | null> {
				const { surfaces } = await api.templates.list();
				return surfaces.find((surface) => surface.kind === 'application-form')?.id ?? null;
			}
		}),
		vocab: Object.freeze({ tracks: api.vocab.tracks, formats: api.vocab.formats }),
		schedule: Object.freeze({
			async sessions() {
				const schedule = await api.schedule.state();
				return schedule.sessions.map((session) => Object.freeze({
					id: session.id,
					title: session.title,
					state: session.state
				}));
			}
		}),
		forms: Object.freeze({
			list: api.forms.list,
			get: api.forms.get,
			fields: api.forms.fields,
			create: api.forms.create,
			setComposition: api.forms.setComposition,
			restoreComposition: api.forms.restoreComposition,
			setClosing: api.forms.setClosing,
			setStatus: api.forms.setStatus
		}),
		fields: Object.freeze({
			move: api.fields.move,
			remove: api.fields.remove,
			restore: api.fields.restore,
			add: api.fields.add
		})
	});
}
