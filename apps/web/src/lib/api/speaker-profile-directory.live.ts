import type { SpeakerProfilesLiveClient } from './operations/speaker-profiles-live';
import { sessionPlacementDisplay } from './session-placement';
import type { ScheduleState, SpeakerProfile, SpeakerRow } from './types';

export interface SpeakerProfileRequest {
	readonly key: string;
	readonly personId?: string;
	readonly email: string;
	readonly submissionCount: number;
}

export interface SpeakerProfileBatchSource {
	profiles(requests: readonly SpeakerProfileRequest[]): Promise<Record<string, SpeakerProfile | null>>;
}

export function createSpeakerProfileBatchLiveSource(input: {
	readonly roster: { list(): Promise<SpeakerRow[]> };
	readonly profiles: SpeakerProfilesLiveClient;
	readonly schedule: { state(): Promise<ScheduleState> };
}): SpeakerProfileBatchSource {
	return Object.freeze({
		async profiles(requests: readonly SpeakerProfileRequest[]) {
			if (requests.length === 0) return {};
			const [roster, directory, schedule] = await Promise.all([
				input.roster.list(), input.profiles.readDirectory(), input.schedule.state()
			]);
			if (directory.kind !== 'success') {
				throw new Error('The current speaker profile directory could not be read.');
			}
			const views = new Map(directory.data.profiles.map((view) => [view.personId, view]));
			const rowsByPerson = new Map<string, SpeakerRow>();
			for (const row of roster) {
				if (!row.personId) continue;
				const current = rowsByPerson.get(row.personId);
				if (!current) {
					rowsByPerson.set(row.personId, row);
					continue;
				}
				const sessions = new Map(current.sessions.map((session) => [session.id, session]));
				for (const session of row.sessions) sessions.set(session.id, session);
				rowsByPerson.set(row.personId, {
					...current,
					name: current.name || row.name,
					email: current.email || row.email,
					sessions: [...sessions.values()]
				});
			}
			const result: Record<string, SpeakerProfile | null> = {};
			for (const request of requests) {
				const row = request.personId ? rowsByPerson.get(request.personId) : undefined;
				const view = row?.personId ? views.get(row.personId) : undefined;
				if (!row || !view?.profile) {
					result[request.key] = null;
					continue;
				}
				const profile: SpeakerProfile = {
					name: row.name,
					email: row.email,
					headline: view.profile.headline.value,
					submissionCount: request.submissionCount,
					speakerId: row.id,
					sessions: row.sessions.map((session) => {
						const placement = sessionPlacementDisplay(schedule, session.id);
						return { ...session, ...(placement ? { placement } : {}) };
					})
				};
				if (view.profile.location.value) profile.location = view.profile.location.value;
				if (view.profile.links.value.length > 0) profile.links = view.profile.links.value;
				result[request.key] = profile;
			}
			return result;
		}
	});
}
