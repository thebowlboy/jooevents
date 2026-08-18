import { describe, expect, test } from 'bun:test';
import { TASK_REMINDER_BODY } from './task-reminder-copy';
import { createLiveTasksPagePort } from './tasks-page-port.live';
import { createSampleTasksPagePort } from './tasks-page-port.sample';
import { createSampleReviewersPagePort } from './reviewers-page-port.sample';
import { api } from './workspace';

/**
 * The rule this file guards: a send ceremony shows what the lane actually
 * sends. For the fixed-copy reminder lane that means the dialog and the sender
 * must read one string — a preview quoting its own copy could drift from the
 * mail, and a ceremony that promises different words than it sends is worse
 * than one that shows nothing.
 */

describe('the fixed reminder body', () => {
	test('the live ceremony previews the shared string, and says the lane sends fixed copy', async () => {
		const port = createLiveTasksPagePort({
			tasks: { source: { kind: 'live' } } as never,
			speakers: { speakers: { list: async () => [] } } as never,
			templates: { list: async () => ({ messages: [] }) } as never,
			schedule: { state: async () => ({}) } as never,
			remind: async () => undefined
		} as never);

		const preview = await port.tasks.reminderPreview!();
		expect(preview.kind).toBe('plain');
		if (preview.kind !== 'plain') return;
		// The dialog cannot drift from the send: it is the same constant.
		expect(preview.body).toBe(TASK_REMINDER_BODY);
	});
});

describe('the sample reminder ceremonies', () => {
	test('the tasks lane previews the stored template it actually renders', async () => {
		const port = createSampleTasksPagePort(api);
		const preview = await port.tasks.reminderPreview!();
		expect(preview.kind).toBe('template');
		if (preview.kind !== 'template') return;
		expect(preview.template.key).toBe('task-reminder');
		// The door the dialog renders opens exactly this record.
		expect(preview.template.id.length).toBeGreaterThan(0);
	});

	test('the reviewers lane reports the speaker-task copy it borrows', async () => {
		const port = createSampleReviewersPagePort(api);
		const preview = await port.tasks.reminderPreview!();
		expect(preview.kind).toBe('template');
		if (preview.kind !== 'template') return;
		// Reviewer reminders ride the speaker-task lane; the ceremony names whose
		// words these are rather than implying they were written for reviewers.
		expect(preview.template.key).toBe('task-reminder');
	});

	test('both sample ceremonies can draw their preview in the event brand', async () => {
		expect(await createSampleTasksPagePort(api).theme!.get()).toBeDefined();
		expect(await createSampleReviewersPagePort(api).theme!.get()).toBeDefined();
	});
});
