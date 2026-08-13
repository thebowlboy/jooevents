import type { PortalSnapshotView } from '$lib/api/portal/view-models';
import { formatInstant } from './format';

/**
 * What the portal asks of someone right now.
 *
 * The rule is narrow on purpose: an entry appears only when the person can
 * finish it from here, so the strip stays a list of things to do rather than a
 * second rendering of everything below it. A task that has closed against
 * further work, a decision with no route back, an invitation already answered —
 * all of those are states, and states live with their record.
 */

/** Inside this window a deadline is close enough that not seeing it is a problem. */
export const DUE_SOON_MS = 7 * 24 * 60 * 60 * 1000;

export interface PortalActionItem {
	readonly id: string;
	readonly kind: 'engagement' | 'task' | 'appeal';
	/** Names the exact object, so the strip reads without its surroundings. */
	readonly headline: string;
	readonly detail: string | null;
	readonly actionLabel: string;
	/** Set when the action lands on another surface; otherwise it acts in place. */
	readonly href: string | null;
	/** The record the in-place action operates on. */
	readonly targetId: string;
}

export function portalActionItems(
	snapshot: PortalSnapshotView,
	now: number
): readonly PortalActionItem[] {
	const items: PortalActionItem[] = [];

	for (const engagement of snapshot.engagements) {
		if (engagement.status !== 'invited') continue;
		items.push({
			id: `engagement-${engagement.id}`,
			kind: 'engagement',
			headline: `Confirm you can speak at “${engagement.sessionTitle}”`,
			detail: engagement.respondBy
				? `The organizers asked for an answer by ${formatInstant(engagement.respondBy, snapshot.event.timezone)}.`
				: null,
			actionLabel: 'Confirm',
			href: null,
			targetId: engagement.id
		});
	}

	for (const task of snapshot.tasks) {
		if (task.state === 'late') {
			// A hard-closed task that ran out of time is a fact about the past; it
			// stays on the checklist with its reason and off the list of things to do.
			if (!task.acceptsLateCompletion) continue;
			items.push({
				id: `task-${task.id}`,
				kind: 'task',
				headline: `“${task.title}” was due ${task.dueAt ? formatInstant(task.dueAt, task.timezone) : 'earlier'}`,
				detail: 'You can still send it; it will be marked late.',
				actionLabel: 'Go to this task',
				href: null,
				targetId: task.id
			});
			continue;
		}
		if (task.state !== 'todo' || task.dueAt === null) continue;
		const due = Date.parse(task.dueAt);
		if (Number.isNaN(due) || due - now > DUE_SOON_MS) continue;
		items.push({
			id: `task-${task.id}`,
			kind: 'task',
			headline: `“${task.title}” is due ${formatInstant(task.dueAt, task.timezone)}`,
			detail: task.required ? null : 'Optional.',
			actionLabel: 'Go to this task',
			href: null,
			targetId: task.id
		});
	}

	for (const submission of snapshot.submissions) {
		if (submission.status !== 'declined' || submission.appeal.kind !== 'available') continue;
		items.push({
			id: `appeal-${submission.id}`,
			kind: 'appeal',
			headline: `“${submission.title}” was not accepted`,
			detail: 'You can ask the organizers to look at it once more.',
			actionLabel: 'Ask for another look',
			href: `/portal/submissions/${submission.id}?appeal=1`,
			targetId: submission.id
		});
	}

	return items;
}

/** The invitation a submission produced, when acceptance created one. */
export function engagementForSubmission(snapshot: PortalSnapshotView, submissionId: string) {
	return snapshot.engagements.find((engagement) => engagement.submissionId === submissionId) ?? null;
}

/** The checklist that belongs to a session, in the dataset's own order. */
export function tasksForSession(snapshot: PortalSnapshotView, sessionId: string | null) {
	if (sessionId === null) return [];
	return snapshot.tasks.filter((task) => task.sessionId === sessionId);
}

/** Outstanding means the person still owes something: not done, not being checked. */
export function isOutstanding(state: PortalSnapshotView['tasks'][number]['state']): boolean {
	return state === 'todo' || state === 'late';
}
