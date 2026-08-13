import type { SpeakersPagePort } from './speakers-page-port';
import type { WorkspaceApi } from './workspace-gateway';

/** Adapts the resettable workspace fixture without changing its behavior. */
export function createSampleSpeakersPagePort(api: WorkspaceApi): SpeakersPagePort {
	return Object.freeze({
		speakers: api.speakers,
		tasks: api.tasks,
		communications: api.communications,
		vocab: api.vocab
	});
}
