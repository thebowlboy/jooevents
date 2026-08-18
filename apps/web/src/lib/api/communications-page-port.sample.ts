import type { CommunicationsPagePort } from './communications-page-port';
import type { SpeakerProfile } from './types';
import type { WorkspaceApi } from './workspace-gateway';

/** Adapts the resettable workspace fixture without changing its behavior. */
export function createSampleCommunicationsPagePort(api: WorkspaceApi): CommunicationsPagePort {
	return Object.freeze({
		communications: api.communications,
		templates: api.templates,
		theme: api.theme,
		workspace: api.workspace,
		speakers: Object.freeze({
			/**
			 * The audience preview holds roster ids rather than addresses, so the
			 * id is resolved to the person here and answered with the same profile
			 * every other name on the product opens.
			 */
			async profileById(speakerId: string): Promise<SpeakerProfile | null> {
				const roster = await api.speakers.list();
				const person = roster.find((entry) => entry.id === speakerId);
				return person ? await api.speakers.profile(person.email) : null;
			}
		})
	});
}
