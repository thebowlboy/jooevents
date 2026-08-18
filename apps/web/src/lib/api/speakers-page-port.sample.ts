import type { SpeakersPagePort } from './speakers-page-port';
import type { WorkspaceApi } from './workspace-gateway';

/** Adapts the resettable workspace fixture without changing its behavior. */
export function createSampleSpeakersPagePort(api: WorkspaceApi): SpeakersPagePort {
	return Object.freeze({
		speakers: Object.freeze({
			list: api.speakers.list,
			recordConfirmation: api.speakers.recordConfirmation,
			acceptCancellation: api.speakers.acceptCancellation
		}),
		lineup: Object.freeze({
			list: async () => (await api.speakers.list()).map((row) => ({
				id: row.id,
				rosterId: row.id,
				name: row.name,
				state: row.state,
				sessions: row.sessions,
				publiclyVisible: row.publiclyVisible,
				contentApproved: row.contentApproved,
				position: row.position,
				...(row.categoryId === undefined ? {} : { categoryId: row.categoryId })
			})),
			reorder: api.speakers.reorder,
			setCategory: api.speakers.setCategory,
			setVisibility: api.speakers.setVisibility
		}),
		tasks: api.tasks,
		communications: api.communications,
		vocab: api.vocab
	});
}
