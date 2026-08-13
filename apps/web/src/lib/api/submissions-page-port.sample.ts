import type { WorkspaceApi } from './workspace-gateway';
import type {
	SubmissionsPagePort,
	SubmissionTrayRestoreEntry
} from './submissions-page-port';

/** Keeps the tuned Submissions page on its resettable fixture without exposing that source to live. */
export function createSampleSubmissionsPagePort(api: WorkspaceApi): SubmissionsPagePort {
	return Object.freeze({
		source: Object.freeze({ kind: 'sample' as const }),
		submissions: Object.freeze({
			list: api.submissions.list,
			addDirectEntry: api.submissions.addDirectEntry,
			removeDirectEntry: api.submissions.removeDirectEntry,
			setAside: (ids: readonly string[]) => api.submissions.setAside([...ids]),
			returnToInbox: (ids: readonly string[]) => api.submissions.returnToInbox([...ids]),
			discard: (ids: readonly string[]) => api.submissions.discard([...ids]),
			restore: (ids: readonly string[]) => api.submissions.restore([...ids]),
			restoreTray: (entries: readonly SubmissionTrayRestoreEntry[]) =>
				api.submissions.restoreTray(entries.map((entry: SubmissionTrayRestoreEntry) => ({ ...entry })))
		}),
		speakers: Object.freeze({ profile: api.speakers.profile }),
		review: Object.freeze({
			standings: (submissionIds: readonly string[]) => api.review.standings([...submissionIds]),
			round: api.review.roundStatus
		}),
		visits: Object.freeze({
			previous: () => api.visits.previous('submissions')
		}),
		vocab: Object.freeze({
			tracks: api.vocab.tracks,
			formats: api.vocab.formats,
			addTrack: api.vocab.addTrack,
			addFormat: api.vocab.addFormat
		}),
		schedule: Object.freeze({
			async collectingSessions() {
				const schedule = await api.schedule.state();
				return Object.freeze(schedule.sessions
					.filter((session) => session.state === 'collecting')
					.map((session) => Object.freeze({ id: session.id, title: session.title })));
			},
			originOf: api.schedule.originOf
		}),
		forms: Object.freeze({
			async openCount() {
				const forms = await api.forms.list();
				return forms.filter((form) => form.status === 'open').length;
			}
		})
	});
}
