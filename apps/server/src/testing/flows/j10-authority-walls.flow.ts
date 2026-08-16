import { expect } from 'bun:test';
import { runJ2Spine, type J2FlowWorld } from './j2-spine.flow';
import { type ActorHandle, type FlowWorld } from './flow-world';

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

interface Receipt<T> {
  readonly data: T;
}

/**
 * J10a — authority walls for every admitted-actor mutation in J2.
 *
 * The delegate runs the spine unchanged, but each effective operation first
 * travels through the actor that has the wrong role or scope.  `expectRefusal`
 * reads the operation-history projection before and after every attack, so a
 * typed outcome must leave neither a success log nor a durable write that
 * could make the immediately-following valid J2 input stale.
 */
class GuardedActor {
  constructor(
    private readonly allowed: ActorHandle,
    private readonly denied: ActorHandle,
    private readonly deniedOutcome: string
  ) {}

  get userId() { return this.allowed.userId; }
  get membership() { return this.allowed.membership; }

  async do<T>(operation: string, input: Json): Promise<Receipt<T>> {
    await this.denied.expectRefusal(operation, input, this.deniedOutcome);
    return this.allowed.do<T>(operation, input);
  }

  async replay<T>(receipt: Receipt<T>): Promise<Receipt<T>> {
    return await this.allowed.replay(
      receipt as unknown as Parameters<ActorHandle['replay']>[0]
    ) as unknown as Receipt<T>;
  }

  async expectRefusal(operation: string, input: Json, outcomeKind: string): Promise<void> {
    await this.allowed.expectRefusal(operation, input, outcomeKind);
  }

  async expectLog(summary: string): Promise<void> {
    await this.allowed.expectLog(summary);
  }

  async expectRead(
    operation: string,
    assertion: (projection: unknown) => boolean
  ): Promise<void>;
  async expectRead(
    operation: string,
    input: unknown,
    assertion: (projection: unknown) => boolean
  ): Promise<void>;
  async expectRead(
    operation: string,
    inputOrAssertion: unknown | ((projection: unknown) => boolean),
    maybeAssertion?: (projection: unknown) => boolean
  ): Promise<void> {
    if (typeof inputOrAssertion === 'function') {
      await this.allowed.expectRead(operation, inputOrAssertion as (projection: unknown) => boolean);
      return;
    }
    if (!maybeAssertion) throw new Error(`${operation} is missing a J10 projection assertion`);
    await this.allowed.expectRead(operation, inputOrAssertion, maybeAssertion);
  }
}

function j10aWorld(world: FlowWorld): J2FlowWorld {
  const organizer = world.as('organizer');
  const reviewer = world.as('reviewer');
  const secondOrganizer = world.as('second-organizer');
  return {
    as(persona) {
      // A reviewer lacks every organizer capability used in J2.
      if (persona === 'organizer') return new GuardedActor(organizer, reviewer, 'authority.not_authorized');
      // The second organizer has review capabilities, but is outside the
      // assignment scope.  The registered operation produces a typed refusal
      // rather than a log or a write before the assigned reviewer continues.
      return new GuardedActor(reviewer, secondOrganizer, 'review.viewer_required');
    },
    asPublic: () => world.asPublic()
  };
}

type TeamProjection = {
  readonly version: number;
  readonly digestSha256: string;
  readonly members: readonly {
    readonly kind: string;
    readonly id?: string;
    readonly userId?: string;
    readonly version?: number;
    readonly status: string;
  }[];
};

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`J10 prerequisite missing: ${label}`);
  return value;
}

export async function runJ10aAuthorityWalls(world: FlowWorld): Promise<void> {
  await runJ2Spine(j10aWorld(world));

  const organizer = world.as('organizer');
  const reviewer = world.as('reviewer');
  let team!: TeamProjection;
  await organizer.expectRead('workspace_team.members.read', (projection) => {
    team = projection as TeamProjection;
    return team.members.some((member) => member.userId === reviewer.userId && member.status === 'active');
  });
  const reviewerMembership = required(team.members.find((member) =>
    member.kind === 'member' && member.userId === reviewer.userId && member.status === 'active'
  ), 'active reviewer membership');
  if (!reviewerMembership.id || reviewerMembership.version === undefined) {
    throw new Error('J10 reviewer membership is not removable');
  }
  await organizer.do('workspace_team.remove', {
    subject: { kind: 'member', membershipId: reviewerMembership.id, version: reviewerMembership.version },
    expectedTeamVersion: team.version,
    expectedTeamDigestSha256: team.digestSha256
  });
  await organizer.expectLog('Removed a teammate');

  // Current authority is resolved on every call: the previously admitted
  // reviewer session must not retain its old role after the removal commits.
  const historyBeforeRevokedAttempt = await world.historyIds(organizer.actor);
  const revokedAttempt = await world.support().invokeEffect({
    actor: reviewer.actor,
    operationName: 'program_vocabulary.create',
    businessInput: { kind: 'track', expectedSetVersion: 3, name: 'Revoked member track' },
    idempotencyKey: `j10-revoked-${crypto.randomUUID()}`
  });
  expect(revokedAttempt.kind, world.trace()).toBe('outcome');
  if (revokedAttempt.kind !== 'outcome') throw new Error('revoked reviewer unexpectedly succeeded');
  expect(revokedAttempt.outcome.kind, world.trace()).toBe('authority.revoked');
  expect(await world.historyIds(organizer.actor), world.trace()).toEqual(historyBeforeRevokedAttempt);
  world.record('program_vocabulary.create@1 → refused authority.revoked');
  await organizer.expectRead('workspace_team.members.read', (projection) => {
    const current = projection as TeamProjection;
    return !current.members.some((member) => member.userId === reviewer.userId && member.status === 'active');
  });
  expect(world.trace()).toContain('workspace_team.remove@1 → Removed a teammate');
}
