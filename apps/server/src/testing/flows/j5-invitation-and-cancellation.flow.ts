import type { FlowWorld } from './flow-world';

/**
 * J5 expected-skip (Q46.a): invitation seeding for a non-intake manual Session
 * has no registered operator operation. Existing engagement.change only
 * responds to acceptance-seeded rows, so using a repository fixture would
 * invalidate the invitation-path evidence.
 */
export async function runJ5InvitationAndCancellation(_world: FlowWorld): Promise<void> {
  throw new Error('J5 expected-skip (Q46.a): non-intake invitation operation is not registered');
}
