import { expect } from 'bun:test';
import { runJ2Spine } from './j2-spine.flow';
import type { FlowWorld } from './flow-world';

type DecisionState = {
  readonly rows: readonly { readonly submissionId: string; readonly head: { readonly state: string } | null }[];
};
type Engagements = { readonly engagements: readonly { readonly submissionId: string | null }[] };
type Sessions = { readonly sessions: readonly { readonly id: string }[] };
type Schedule = { readonly occurrences: readonly { readonly sessionId: string }[] };
type PortalSnapshot = {
  readonly submissions: readonly {
    readonly id: string;
    readonly status: string;
    readonly statusNotifiedAt: string | null;
  }[];
};

/** J3 — a rejection is private until the submitter-facing decision communication occurs. */
export async function runJ3RejectionAndSilence(world: FlowWorld): Promise<void> {
  const organizer = world.as('organizer');
  const submitter = world.asSubmitter('pia.public@example.test');
  const ready = await runJ2Spine(world, { stopAt: 'decision' });
  if (!('kind' in ready) || ready.kind !== 'decision_ready') {
    throw new Error('J3 did not stop at the decision boundary');
  }

  const rejected = await organizer.do<{ readonly action: 'decide'; readonly rows: readonly unknown[] }>('decision.decide', {
    action: 'decide',
    decisions: [{
      submissionId: ready.submissionId, state: 'declined',
      expectedDecisionVersion: null, expectedDecisionDigestSha256: null
    }]
  });
  await organizer.expectLog('Recorded submission decisions');
  expect(rejected.data.rows).toHaveLength(1);
  await organizer.expectRead('decision.state.read', { submissionIds: [ready.submissionId] }, (projection) => {
    const state = projection as DecisionState;
    return state.rows.some((row) => row.submissionId === ready.submissionId && row.head?.state === 'declined');
  });
  await organizer.expectRead('engagement.snapshot.read', (projection) =>
    !(projection as Engagements).engagements.some((entry) => entry.submissionId === ready.submissionId)
  );
  await organizer.expectRead('session.catalog.read', (projection) =>
    (projection as Sessions).sessions.length === 0
  );
  await organizer.expectRead('schedule.placement.snapshot.read', {
    startAt: '2027-06-10T00:00:00.000Z', endAt: '2027-06-13T00:00:00.000Z', limit: 100
  }, (projection) => (projection as Schedule).occurrences.length === 0);

  // The organizer's declined decision is not itself a participant disclosure:
  // the portal must retain the last communicated standing until communication.
  await submitter.expectRead('portal.snapshot.read', (projection) => {
    const snapshot = projection as PortalSnapshot;
    return snapshot.submissions.some((submission) =>
      submission.id === ready.submissionId
        && submission.status === 'submitted'
        && submission.statusNotifiedAt === null
    );
  });

  // Expected-skip J3-COM-001 / Q47: Communications owns verified
  // recipient-level delivery, the only event that may advance this portal
  // status. A repository-side status mutation would be invalid evidence.
  world.record('portal.snapshot.read@1 → expected-skip Q47 declined disclosure after verified delivery (J3-COM-001)');
}
