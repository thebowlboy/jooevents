import { expect } from 'bun:test';
import { runJ2Spine } from './j2-spine.flow';
import type { FlowWorld } from './flow-world';

type Registry = {
  readonly fields: readonly { readonly id: string; readonly kind: string; readonly mapsTo?: string }[];
};
type FormCatalog = {
  readonly forms: readonly { readonly id: string; readonly version: number; readonly status: string }[];
};
type Triage = {
  readonly queryGuard: { readonly version: number; readonly digestSha256: string };
  readonly rows: readonly {
    readonly source: { readonly source: string };
    readonly triage: { readonly submissionId: string; readonly version: number; readonly state: string };
  }[];
};
type Decision = {
  readonly rows: readonly {
    readonly submissionId: string;
    readonly origin: { readonly sessionId: string };
  }[];
};
type Engagements = {
  readonly engagements: readonly {
    readonly id: string;
    readonly submissionId: string | null;
    readonly version: number;
    readonly state: string;
  }[];
};
type Catalog = {
  readonly version: number;
  readonly digestSha256: string;
  readonly sessions: readonly {
    readonly id: string;
    readonly version: number;
    readonly digestSha256: string;
    readonly title: string;
    readonly programTarget: { readonly format: { readonly id: string } };
    readonly roster: { readonly version: number; readonly participants: readonly {
      readonly personId: string;
      readonly source: { readonly kind: string; readonly id: string; readonly version: number };
      readonly role: 'speaker' | 'moderator' | 'host' | 'panelist';
      readonly position: number;
      readonly publiclyVisible: boolean;
    }[] };
  }[];
};
type Vocabulary = { readonly setVersion: number };
type VocabularyChange = { readonly affectedIds: readonly string[] };
type SessionChange = {
  readonly action: string;
  readonly catalogVersion: number;
  readonly session: Catalog['sessions'][number] | null;
};
type Schedule = { readonly scheduleVersion: number; readonly occurrences: readonly { readonly sessionId: string }[] };

function required<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null) throw new Error(`J4 missing ${name}`);
  return value;
}

const scheduleWindow = {
  startAt: '2027-06-10T00:00:00.000Z', endAt: '2027-06-13T00:00:00.000Z', limit: 100
} as const;

/** J4 — manual intake and independently-created sessions remain first-class paths. */
export async function runJ4ManualPaths(world: FlowWorld): Promise<void> {
  const organizer = world.as('organizer');
  const spine = await runJ2Spine(world);

  let registry!: Registry;
  await organizer.expectRead('field_registry.snapshot.read', (projection) => {
    registry = projection as Registry;
    return registry.fields.length > 0;
  });
  const title = required(registry.fields.find((field) => field.mapsTo === 'talk.title' && field.kind === 'text'), 'title field');
  const name = required(registry.fields.find((field) => field.mapsTo === 'person.name' && field.kind === 'text'), 'name field');
  const email = required(registry.fields.find((field) => field.mapsTo === 'person.email' && field.kind === 'email'), 'email field');
  let forms!: FormCatalog;
  await organizer.expectRead('form.list', (projection) => {
    forms = projection as FormCatalog;
    return forms.forms.some((form) => form.status === 'open');
  });
  const form = required(forms.forms.find((candidate) => candidate.status === 'open'), 'open form');

  const direct = await organizer.do<{ readonly submissionId: string; readonly source: string }>('submission.direct_entry.create', {
    formId: form.id, expectedFormDefinitionVersion: form.version,
    answers: [
      { kind: 'text', fieldId: title.id, value: 'Entered beside the pipeline' },
      { kind: 'text', fieldId: name.id, value: 'Dana Direct' },
      { kind: 'email', fieldId: email.id, value: 'dana.direct@example.test' }
    ]
  });
  await organizer.expectLog('Added a direct-entry submission');
  await organizer.replay(direct);
  const directSubmissionId = direct.data.submissionId;

  let triage!: Triage;
  await organizer.expectRead('submission.triage.list', (projection) => {
    triage = projection as Triage;
    return triage.rows.some((row) => row.triage.submissionId === directSubmissionId
      && row.source.source === 'direct_entry' && row.triage.state === 'inbox');
  });
  const triageHead = required(triage.rows.find((row) => row.triage.submissionId === directSubmissionId), 'direct triage');
  await organizer.do('submission.triage.transition', {
    action: 'set_aside', submissionIds: [directSubmissionId],
    expectedHeads: [{ submissionId: directSubmissionId, version: triageHead.triage.version }],
    expectedQueryGuard: {
      version: triage.queryGuard.version,
      digestSha256: triage.queryGuard.digestSha256
    }
  });
  await organizer.expectLog('Set submissions aside');

  const accepted = await organizer.do<Decision>('decision.decide', {
    action: 'decide', decisions: [{
      submissionId: directSubmissionId, state: 'accepted', expectedDecisionVersion: null,
      expectedDecisionDigestSha256: null, graduation: { kind: 'spawn' }
    }]
  });
  await organizer.expectLog('Recorded submission decisions');
  const directSessionId = required(
    accepted.data.rows.find((row) => row.submissionId === directSubmissionId)?.origin.sessionId,
    'direct-entry accepted session'
  );
  let engagements!: Engagements;
  await organizer.expectRead('engagement.snapshot.read', (projection) => {
    engagements = projection as Engagements;
    return engagements.engagements.some((entry) => entry.submissionId === directSubmissionId && entry.state === 'invited');
  });
  const engagement = required(engagements.engagements.find((entry) => entry.submissionId === directSubmissionId), 'direct-entry engagement');
  await organizer.do('engagement.change', {
    action: 'record_confirmation', engagementId: engagement.id,
    expectedEngagementVersion: engagement.version, attribution: 'organizer_recorded'
  });
  await organizer.expectLog('Recorded a speaker confirmation');

  let schedule!: Schedule;
  await organizer.expectRead('schedule.placement.snapshot.read', scheduleWindow, (projection) => {
    schedule = projection as Schedule;
    return true;
  });
  await organizer.do('schedule.placement', {
    action: 'place', expectedScheduleVersion: schedule.scheduleVersion, roomId: spine.roomId,
    sessionId: directSessionId, startAt: '2027-06-10T02:00:00.000Z', endAt: '2027-06-10T02:45:00.000Z'
  });
  await organizer.expectLog('Placed a session on the schedule');

  let vocabulary!: Vocabulary;
  await organizer.expectRead('program_vocabulary.snapshot.read', (projection) => {
    vocabulary = projection as Vocabulary;
    return vocabulary.setVersion > 0;
  });
  const alternateFormat = await organizer.do<VocabularyChange>('program_vocabulary.create', {
    kind: 'format', expectedSetVersion: vocabulary.setVersion, name: 'Workshop'
  });
  await organizer.expectLog('Created a format');
  const alternateFormatId = required(alternateFormat.data.affectedIds[0], 'alternate format');

  let catalog!: Catalog;
  await organizer.expectRead('session.catalog.read', (projection) => {
    catalog = projection as Catalog;
    return catalog.sessions.some((session) => session.id === directSessionId);
  });
  const directSession = required(catalog.sessions.find((session) => session.id === directSessionId), 'direct session');
  const participant = required(directSession.roster.participants[0], 'direct session participant');
  const manual = await organizer.do<SessionChange>('session.change', {
    action: 'create', expectedCatalogVersion: catalog.version, expectedCatalogDigestSha256: catalog.digestSha256,
    title: 'Organizer-created workshop', plannedDurationMinutes: 45, lifecycle: 'programmed',
    formatId: spine.formatId, trackId: null,
    participants: [{ personId: participant.personId, role: 'speaker', publiclyVisible: true, source: participant.source }]
  });
  await organizer.expectLog('Created a session');
  const manualSession = required(manual.data.session, 'manual session');
  let afterManual!: Catalog;
  await organizer.expectRead('session.catalog.read', (projection) => {
    afterManual = projection as Catalog;
    return afterManual.sessions.some((session) => session.id === manualSession.id);
  });
  const manualHead = required(afterManual.sessions.find((session) => session.id === manualSession.id), 'manual session head');
  const retargeted = await organizer.do<SessionChange>('session.change', {
    action: 'retarget', expectedCatalogVersion: afterManual.version,
    expectedCatalogDigestSha256: afterManual.digestSha256,
    sessionId: manualHead.id, expectedSessionVersion: manualHead.version,
    expectedSessionDigestSha256: manualHead.digestSha256, formatId: alternateFormatId, trackId: null
  });
  await organizer.expectLog("Changed a session's format or track");
  const retargetedSession = required(retargeted.data.session, 'retargeted manual session');
  let afterRetarget!: Catalog;
  await organizer.expectRead('session.catalog.read', (projection) => {
    afterRetarget = projection as Catalog;
    return afterRetarget.sessions.some((session) => session.id === retargetedSession.id);
  });
  const retargetedHead = required(
    afterRetarget.sessions.find((session) => session.id === retargetedSession.id), 'retargeted session head'
  );
  const hidden = await organizer.do<SessionChange>('session.change', {
    action: 'roster_visibility', expectedCatalogVersion: afterRetarget.version,
    expectedCatalogDigestSha256: afterRetarget.digestSha256,
    sessionId: retargetedHead.id, expectedSessionVersion: retargetedHead.version,
    expectedSessionDigestSha256: retargetedHead.digestSha256,
    personId: participant.personId, publiclyVisible: false
  });
  await organizer.expectLog("Changed a participant's public visibility");
  const hiddenSession = required(hidden.data.session, 'hidden manual session');
  expect(hiddenSession.roster.participants[0]?.publiclyVisible).toBe(false);

  let beforeParticipantRemoval!: Catalog;
  await organizer.expectRead('session.catalog.read', (projection) => {
    beforeParticipantRemoval = projection as Catalog;
    return beforeParticipantRemoval.sessions.some((session) => session.id === hiddenSession.id);
  });
  const beforeRemovalHead = required(
    beforeParticipantRemoval.sessions.find((session) => session.id === hiddenSession.id),
    'participant removal session head'
  );
  const removedParticipant = required(
    beforeRemovalHead.roster.participants.find((entry) => entry.personId === participant.personId),
    'participant removal evidence'
  );
  const removedMembership = await organizer.do<SessionChange>('session.change', {
    action: 'roster_remove', expectedCatalogVersion: beforeParticipantRemoval.version,
    expectedCatalogDigestSha256: beforeParticipantRemoval.digestSha256,
    sessionId: beforeRemovalHead.id, expectedSessionVersion: beforeRemovalHead.version,
    expectedSessionDigestSha256: beforeRemovalHead.digestSha256,
    expectedRosterVersion: beforeRemovalHead.roster.version,
    expectedParticipant: removedParticipant
  });
  await organizer.expectLog('Removed a participant from a session');
  const withoutParticipant = required(removedMembership.data.session, 'removed participant session');
  expect(withoutParticipant.roster.participants).toEqual([]);

  let beforeParticipantRestore!: Catalog;
  await organizer.expectRead('session.catalog.read', (projection) => {
    beforeParticipantRestore = projection as Catalog;
    return beforeParticipantRestore.sessions.some((session) => session.id === hiddenSession.id);
  });
  const beforeRestoreHead = required(
    beforeParticipantRestore.sessions.find((session) => session.id === hiddenSession.id),
    'participant restore session head'
  );
  const restoredMembership = await organizer.do<SessionChange>('session.change', {
    action: 'roster_restore', expectedCatalogVersion: beforeParticipantRestore.version,
    expectedCatalogDigestSha256: beforeParticipantRestore.digestSha256,
    sessionId: beforeRestoreHead.id, expectedSessionVersion: beforeRestoreHead.version,
    expectedSessionDigestSha256: beforeRestoreHead.digestSha256,
    expectedRosterVersion: beforeRestoreHead.roster.version,
    participant: removedParticipant
  });
  await organizer.expectLog('Restored a participant to a session');
  expect(restoredMembership.data.session?.roster.participants).toEqual([removedParticipant]);

  let beforeRoleChange!: Catalog;
  await organizer.expectRead('session.catalog.read', (projection) => {
    beforeRoleChange = projection as Catalog;
    return beforeRoleChange.sessions.some((session) => session.id === hiddenSession.id);
  });
  const beforeRoleHead = required(
    beforeRoleChange.sessions.find((session) => session.id === hiddenSession.id),
    'participant role session head'
  );
  const beforeRoleParticipant = required(
    beforeRoleHead.roster.participants.find((entry) => entry.personId === participant.personId),
    'participant role evidence'
  );
  const changedRole = await organizer.do<SessionChange>('session.change', {
    action: 'roster_role', expectedCatalogVersion: beforeRoleChange.version,
    expectedCatalogDigestSha256: beforeRoleChange.digestSha256,
    sessionId: beforeRoleHead.id, expectedSessionVersion: beforeRoleHead.version,
    expectedSessionDigestSha256: beforeRoleHead.digestSha256,
    expectedRosterVersion: beforeRoleHead.roster.version,
    expectedParticipant: beforeRoleParticipant, role: 'moderator'
  });
  await organizer.expectLog("Changed a participant's session role");
  expect(changedRole.data.session?.roster.participants[0]?.role).toBe('moderator');

  let freshCatalog!: Catalog;
  await organizer.expectRead('session.catalog.read', (projection) => {
    freshCatalog = projection as Catalog;
    return freshCatalog.sessions.some((session) => session.id === hiddenSession.id);
  });
  const removable = await organizer.do<SessionChange>('session.change', {
    action: 'create', expectedCatalogVersion: freshCatalog.version, expectedCatalogDigestSha256: freshCatalog.digestSha256,
    title: 'Unreferenced new session', plannedDurationMinutes: 30, lifecycle: 'draft', formatId: spine.formatId, trackId: null
  });
  await organizer.expectLog('Created a session');
  const removableSession = required(removable.data.session, 'removable session');
  let afterRemovable!: Catalog;
  await organizer.expectRead('session.catalog.read', (projection) => {
    afterRemovable = projection as Catalog;
    return afterRemovable.sessions.some((session) => session.id === removableSession.id);
  });
  const removableHead = required(
    afterRemovable.sessions.find((session) => session.id === removableSession.id), 'removable session head'
  );
  await organizer.do<SessionChange>('session.change', {
    action: 'remove_new_session', expectedCatalogVersion: afterRemovable.version,
    expectedCatalogDigestSha256: afterRemovable.digestSha256, sessionId: removableHead.id,
    expectedSessionVersion: 1, expectedSessionDigestSha256: removableHead.digestSha256
  });
  await organizer.expectLog('Removed a new session');

  let finalCatalog!: Catalog;
  await organizer.expectRead('session.catalog.read', (projection) => {
    finalCatalog = projection as Catalog;
    return !finalCatalog.sessions.some((session) => session.id === removableSession.id);
  });
  const referenced = await organizer.do<SessionChange>('session.change', {
    action: 'create', expectedCatalogVersion: finalCatalog.version, expectedCatalogDigestSha256: finalCatalog.digestSha256,
    title: 'Referenced new session', plannedDurationMinutes: 30, lifecycle: 'collecting', formatId: spine.formatId, trackId: null
  });
  await organizer.expectLog('Created a session');
  const referencedSession = required(referenced.data.session, 'referenced session');
  let beforeReference!: Schedule;
  await organizer.expectRead('schedule.placement.snapshot.read', scheduleWindow, (projection) => {
    beforeReference = projection as Schedule;
    return true;
  });
  await organizer.do('schedule.placement', {
    action: 'place', expectedScheduleVersion: beforeReference.scheduleVersion, roomId: spine.roomId,
    sessionId: referencedSession.id, startAt: '2027-06-10T03:00:00.000Z', endAt: '2027-06-10T03:30:00.000Z'
  });
  await organizer.expectLog('Placed a session on the schedule');
  let beforeRefusal!: Catalog;
  await organizer.expectRead('session.catalog.read', (projection) => {
    beforeRefusal = projection as Catalog;
    return beforeRefusal.sessions.some((session) => session.id === referencedSession.id);
  });
  // A schedule reference makes removing this new session a non-writing,
  // typed stale-revision refusal with no success log.
  await organizer.expectRefusal('session.change', {
    action: 'remove_new_session', expectedCatalogVersion: beforeRefusal.version,
    expectedCatalogDigestSha256: beforeRefusal.digestSha256, sessionId: referencedSession.id,
    expectedSessionVersion: 1, expectedSessionDigestSha256: referencedSession.digestSha256
  }, 'session.changed');
}
