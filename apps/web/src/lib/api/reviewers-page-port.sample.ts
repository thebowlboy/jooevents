import type { ReviewersPagePort } from './reviewers-page-port';
import type { ReminderPreview } from './tasks-page-port';
import type { WorkspaceApi } from './workspace-gateway';

/** Adapts the resettable workspace fixture without changing its behavior. */
export function createSampleReviewersPagePort(api: WorkspaceApi): ReviewersPagePort {
	return Object.freeze({
		reviewers: api.reviewers,
		vocab: api.vocab,
		schedule: api.schedule,
		tasks: Object.freeze({
			...api.tasks,
			reminderAvailability: Object.freeze({ kind: 'available' as const }),
			/**
			 * A reviewer reminder rides the speaker-task reminder lane, so what it
			 * sends is that lane's stored template — reported as it is, rather than
			 * as something written for reviewers.
			 */
			async reminderPreview(): Promise<ReminderPreview> {
				const { messages } = await api.templates.list();
				const template = messages.find((entry) => entry.key === 'task-reminder');
				return template
					? { kind: 'template', template }
					: {
							kind: 'plain',
							subject: 'Review reminder',
							body: 'You have reviews still to complete. Open your review queue to finish them.'
						};
			}
		}),
		theme: api.theme
	});
}
