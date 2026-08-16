import { expect } from 'bun:test';
import { runJ2Spine } from './j2-spine.flow';
import type { FlowWorld } from './flow-world';

type Deadline = { readonly id: string; readonly kind: string; readonly status: string; readonly version: number; readonly displayDate: string | null };
type Deadlines = { readonly deadlines: readonly Deadline[] };
type DeadlineChange = { readonly deadline: Deadline };
type TaskBoard = {
  readonly definitions: readonly { readonly head: { readonly id: string } }[];
  readonly assignments: readonly { readonly id: string; readonly version: number; readonly state: string }[];
};
type TaskMutation = {
  readonly action: string;
  readonly assignments?: readonly { readonly id: string; readonly version: number; readonly state: string }[];
  readonly assignment?: { readonly id: string; readonly version: number; readonly state: string };
};

function required<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null) throw new Error(`J6 missing ${label}`);
  return value;
}

/** J6 — deadlines and speaker tasks remain ordinary audited work around the CFP. */
export async function runJ6DeadlinesAndTasks(world: FlowWorld): Promise<void> {
  const organizer = world.as('organizer');
  const reviewer = world.as('reviewer');
  await runJ2Spine(world);

  await reviewer.expectRefusal('deadline.change', { action: 'create', displayDate: '2027-06-09' }, 'authority.not_authorized');
  let before!: Deadlines;
  await organizer.expectRead('deadline.catalog.read', (projection) => {
    before = projection as Deadlines;
    return before.deadlines.some((deadline) => deadline.kind === 'review_due' && deadline.status === 'active');
  });
  const created = await organizer.do<DeadlineChange>('deadline.change', {
    action: 'create', displayDate: '2027-06-09'
  });
  await organizer.expectLog('Created a deadline');
  await organizer.replay(created);
  const cfpClose = created.data.deadline;
  expect(cfpClose.kind).toBe('cfp_close');
  const updated = await organizer.do<DeadlineChange>('deadline.change', {
    action: 'update', deadlineId: cfpClose.id, expectedVersion: cfpClose.version, displayDate: '2027-06-08'
  });
  await organizer.expectLog('Updated a deadline');
  const cleared = await organizer.do<DeadlineChange>('deadline.change', {
    action: 'clear', deadlineId: cfpClose.id, expectedVersion: updated.data.deadline.version
  });
  await organizer.expectLog('Cleared a deadline');
  await organizer.expectRead('deadline.catalog.read', (projection) => {
    const catalog = projection as Deadlines;
    return catalog.deadlines.some((deadline) => deadline.id === cleared.data.deadline.id && deadline.status === 'cleared')
      && catalog.deadlines.some((deadline) => deadline.kind === 'review_due' && deadline.status === 'active');
  });

  const tasks = await organizer.do<TaskMutation>('task.mutation', {
    action: 'create_definition', name: 'Send your speaker kit', description: 'Share the final materials.',
    completionMode: 'acknowledge', required: true, dueOn: '2027-06-07'
  });
  await organizer.expectLog('Created speaker tasks');
  const assignment = required(tasks.data.assignments?.[0], 'materialized speaker assignment');
  const waived = await organizer.do<TaskMutation>('task.mutation', {
    action: 'waive_assignment', assignmentId: assignment.id, expectedVersion: assignment.version
  });
  await organizer.expectLog('Waived a speaker task');
  const waivedAssignment = required(waived.data.assignment, 'waived assignment');
  expect(waivedAssignment.state).toBe('waived');
  const restored = await organizer.do<TaskMutation>('task.mutation', {
    action: 'restore_assignment', assignmentId: waivedAssignment.id, expectedVersion: waivedAssignment.version
  });
  await organizer.expectLog('Restored a speaker task');
  const restoredAssignment = required(restored.data.assignment, 'restored assignment');
  // Expected-skip J6-TASK-001 / Q46.b: operator acceptance correctly refuses a
  // pending task. The participant fulfillment ceremony remains an open product
  // decision, so manufacturing the preceding received state would be invalid.
  await organizer.expectRefusal('task.mutation', {
    action: 'accept_fulfillment', assignmentId: restoredAssignment.id, expectedVersion: restoredAssignment.version
  }, 'task.changed');
  await organizer.expectRead('task.board.read', (projection) => {
    const board = projection as TaskBoard;
    return board.definitions.length === 1
      && board.assignments.some((entry) => entry.id === restoredAssignment.id && entry.state === 'pending');
  });
  world.record('task.mutation@1 → expected-skip Q46.b accept fulfillment (J6-TASK-001)');
}
