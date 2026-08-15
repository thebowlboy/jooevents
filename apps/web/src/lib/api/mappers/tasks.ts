import type {
	TaskAssignmentDto,
	TaskDefinitionSnapshotDto
} from '@jooevents/contracts';
import type { AssignmentState, TaskAssignment, TaskDef } from '../types';

const completionKind: Readonly<Record<
	TaskDefinitionSnapshotDto['current']['completionMode'], TaskDef['kind']
>> = Object.freeze({
	acknowledge: 'confirm',
	file_upload: 'upload',
	form: 'form',
	external_action: 'link'
});

const assignmentState: Readonly<Record<TaskAssignmentDto['state'], AssignmentState>> = Object.freeze({
	pending: 'todo',
	received_pending_check: 'received',
	complete: 'complete',
	late_complete: 'late-complete',
	waived: 'waived'
});

function dueText(effectiveAt: string, now: number): string {
	const days = Math.ceil((Date.parse(effectiveAt) - now) / 86_400_000);
	if (days < 0) return `${Math.abs(days)} day${days === -1 ? '' : 's'} overdue`;
	if (days === 0) return 'due today';
	return `in ${days} day${days === 1 ? '' : 's'}`;
}

function absoluteDate(displayDate: string): string {
	const parsed = new Date(`${displayDate}T12:00:00Z`);
	return Number.isNaN(parsed.getTime())
		? displayDate
		: new Intl.DateTimeFormat('en-US', {
				month: 'short', day: 'numeric', year: 'numeric'
			}).format(parsed);
}

/** One canonical Task definition projection shared by every tuned page. */
export function taskDefinitionView(
	snapshot: TaskDefinitionSnapshotDto,
	now: number = Date.now()
): TaskDef {
	return {
		id: snapshot.head.id,
		name: snapshot.current.name,
		kind: completionKind[snapshot.current.completionMode],
		required: snapshot.current.required,
		dueAbsolute: absoluteDate(snapshot.current.deadline.reference.displayDate),
		dueRelative: dueText(snapshot.current.deadline.reference.effectiveAt, now)
	};
}

/** One canonical Task assignment projection shared by Tasks and Speakers. */
export function taskAssignmentView(
	value: TaskAssignmentDto,
	now: number = Date.now()
): TaskAssignment {
	const due = value.deadlineOverride?.reference ?? value.deadline.reference;
	return {
		taskId: value.taskDefinitionId,
		speakerId: value.engagementId,
		state: assignmentState[value.state],
		overdue: (value.state === 'pending' || value.state === 'received_pending_check')
			&& Date.parse(due.effectiveAt) < now
	};
}
