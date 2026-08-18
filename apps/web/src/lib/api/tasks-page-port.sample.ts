import type { ReminderPreview, TasksPagePort } from './tasks-page-port';
import type { WorkspaceApi } from './workspace-gateway';

/** Adapts the resettable workspace fixture without changing its behavior. */
export function createSampleTasksPagePort(api: WorkspaceApi): TasksPagePort {
	return Object.freeze({
		tasks: Object.freeze({
			...api.tasks,
			/**
			 * The fixture's reminder lane renders the stored task-reminder
			 * template, so the ceremony shows that template — the same record the
			 * dialog's door opens.
			 */
			async reminderPreview(): Promise<ReminderPreview> {
				const { messages } = await api.templates.list();
				const template = messages.find((entry) => entry.key === 'task-reminder');
				if (template) return { kind: 'template', template };
				// Nothing stored to render: say what would be sent rather than
				// naming a template this workspace does not have.
				return {
					kind: 'plain',
					subject: 'Your outstanding speaker tasks',
					body: 'You have one or more outstanding speaker tasks. Open your speaker checklist to review and complete them.'
				};
			}
		}),
		speakers: api.speakers,
		templates: api.templates,
		theme: api.theme
	});
}
