import type {
	TaskAssignmentDto,
	TaskDefinitionSnapshotDto
} from '@jooevents/contracts';
import {
	describeCalendarDeadline,
	formatDate,
	formatRelative
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

/** One canonical Task definition projection shared by every tuned page. */
export function taskDefinitionView(
	snapshot: TaskDefinitionSnapshotDto,
	now: number = Date.now()
): TaskDef {
	const reference = snapshot.current.deadline.reference;
	const deadline = reference.eventTimezone === undefined
		? null
		: describeCalendarDeadline({
				displayDate: reference.displayDate,
				effectiveAt: reference.effectiveAt,
				timezone: reference.eventTimezone,
				now,
				weekday: false,
				showTime: false
			});
	return {
		id: snapshot.head.id,
		name: snapshot.current.name,
		kind: completionKind[snapshot.current.completionMode],
		required: snapshot.current.required,
		dueAbsolute: deadline?.absolute ?? formatDate(reference.displayDate),
		// Retained pins created before event-zone projection cannot truthfully
		// claim whose today or tomorrow they mean, so the shared vocabulary
		// deliberately keeps their relative distance numeric.
		dueRelative: deadline?.relative ?? formatRelative(reference.effectiveAt, now),
		overdue: deadline?.state === 'overdue'
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
