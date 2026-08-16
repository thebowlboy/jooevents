import { runJ2Spine } from './j2-spine.flow';
import type { FlowWorld } from './flow-world';

type Catalog = {
  readonly version: number; readonly digestSha256: string;
  readonly sessions: readonly { readonly id: string }[];
};
type SessionChange = { readonly session: { readonly id: string } | null };
type ReleaseDraft = { readonly draftId: string; readonly revision: { readonly id: string; readonly digestSha256: string } };
function required<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null) throw new Error(`J11 missing ${label}`);
  return value;
}

/** J11 — unpublished program changes remain absent until a reviewed release publishes them. */
export async function runJ11ReleasesAndPublicProjections(world: FlowWorld): Promise<void> {
  const organizer = world.as('organizer');
  const reviewer = world.as('reviewer');
  const publicCaller = world.asPublic();
  const spine = await runJ2Spine(world);
  let catalog!: Catalog;
  await organizer.expectRead('session.catalog.read', (projection) => {
    catalog = projection as Catalog;
    return catalog.sessions.some((session) => session.id === spine.sessionId);
  });
  const created = await organizer.do<SessionChange>('session.change', {
    action: 'create', expectedCatalogVersion: catalog.version, expectedCatalogDigestSha256: catalog.digestSha256,
    title: 'Release-bound session', plannedDurationMinutes: 30, lifecycle: 'programmed',
    formatId: spine.formatId, trackId: null
  });
  await organizer.expectLog('Created a session');
  const newSessionId = required(created.data.session, 'unpublished session').id;
  await publicCaller.expectRead('schedule.public.read', (projection) =>
    !(projection as { readonly sessions: readonly { readonly sessionId: string }[] }).sessions
      .some((session) => session.sessionId === newSessionId)
  );
  const draft = await organizer.do<ReleaseDraft>('release.change.draft', {
    action: 'publish_schedule', expectedCurrentReleaseNumber: 1
  });
  await reviewer.expectRefusal('release.publish', {
    draftId: draft.data.draftId, revisionId: draft.data.revision.id,
    revisionDigestSha256: draft.data.revision.digestSha256
  }, 'authority.not_authorized');
  await organizer.do('release.publish', {
    draftId: draft.data.draftId, revisionId: draft.data.revision.id,
    revisionDigestSha256: draft.data.revision.digestSha256
  });
  await organizer.expectLog('Published the schedule');
  await publicCaller.expectRead('schedule.public.read', (projection) =>
    (projection as { readonly sessions: readonly { readonly sessionId: string }[] }).sessions
      .some((session) => session.sessionId === newSessionId)
  );
}
