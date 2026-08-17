import { expect, test } from 'bun:test';
import { flowWorld } from './flow-world';
import { runJ2Spine } from './j2-spine.flow';

test('retained launch journey survives restart with authority, history, and public heads intact', async () => {
  const world = await flowWorld({ database: 'retained-frozen' });
  try {
    const result = await runJ2Spine(world);
    const preRestartOrganizer = world.as('organizer');
    const tasks = await preRestartOrganizer.do<{
      readonly assignments?: readonly { readonly id: string }[];
    }>('task.mutation', {
      action: 'create_definition',
      name: 'Send your speaker kit',
      description: 'Share the final materials.',
      completionMode: 'acknowledge',
      required: true,
      dueOn: '2027-06-07'
    });
    const taskAssignmentId = tasks.data.assignments?.[0]?.id;
    expect(taskAssignmentId).toBeDefined();
    const lostResponse = await preRestartOrganizer.do('deadline.change', {
      action: 'create', displayDate: '2027-06-09'
    });
    await world.restartRetained();
    await preRestartOrganizer.replay(lostResponse);
    const organizer = world.as('organizer');
    const reviewer = world.as('reviewer');

    await organizer.expectRead('event.current.read', (projection) =>
      (projection as { readonly event?: { readonly id?: string } }).event?.id !== undefined
    );
    await organizer.expectRead('submission.triage.list', (projection) =>
      (projection as { readonly rows: readonly { readonly triage: { readonly submissionId: string } }[] }).rows
        .some((row) => row.triage.submissionId === result.submissionId)
    );
    await organizer.expectRead('decision.state.read', { submissionIds: [result.submissionId] }, (projection) =>
      (projection as { readonly rows: readonly { readonly submissionId: string; readonly head: { readonly state: string } | null }[] }).rows
        .some((row) => row.submissionId === result.submissionId && row.head?.state === 'accepted')
    );
    await organizer.expectRead('schedule.placement.snapshot.read', {
      startAt: '2027-06-10T00:00:00.000Z',
      endAt: '2027-06-13T00:00:00.000Z',
      limit: 100
    }, (projection) =>
      (projection as { readonly occurrences: readonly { readonly sessionId: string }[] }).occurrences
        .some((occurrence) => occurrence.sessionId === result.sessionId)
    );
    await organizer.expectRead('task.board.read', (projection) =>
      (projection as { readonly assignments: readonly { readonly id: string; readonly state: string }[] }).assignments
        .some((assignment) => assignment.id === taskAssignmentId && assignment.state === 'pending')
    );
    await reviewer.expectRefusal('program_vocabulary.create', {
      kind: 'track', expectedSetVersion: 3, name: 'Still unauthorized after restart'
    }, 'authority.not_authorized');
    await world.asPublic().expectRead('schedule.public.read', (projection) =>
      (projection as { readonly sessions: readonly { readonly sessionId: string }[] }).sessions
        .some((session) => session.sessionId === result.sessionId)
    );
    await world.asSubmitter('pia.public@example.test').expectRead('portal.snapshot.read', (projection) => {
      const snapshot = projection as {
        readonly submissions: readonly { readonly id: string }[];
        readonly engagements: readonly { readonly sessionId: string }[];
      };
      return snapshot.submissions.some((submission) => submission.id === result.submissionId)
        && snapshot.engagements.some((engagement) => engagement.sessionId === result.sessionId);
    });
    const history = await world.history(organizer.actor);
    expect(history.entries.length).toBeGreaterThan(10);
    expect(world.trace()).toContain('retained runtime → graceful restart');
  } finally {
    world.close();
  }
});
