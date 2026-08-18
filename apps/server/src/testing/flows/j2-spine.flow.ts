/**
 * J2 — Submitter becomes a session.
 *
 * This is a journey module rather than a Bun-test entrypoint.  The L1 harness
 * catalog imports it once the architect-owned ephemeral-operation and history
 * seams land.  Its only dependencies are the methodology API: actor.do(),
 * actor.replay(), actor.expectLog(), actor.expectRead(), and public.submitForm().
 */

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

interface Receipt<T> {
  readonly data: T;
}

interface Actor {
  readonly userId: string;
  readonly membership: { readonly id: string; readonly version: number };
  do<T>(operation: string, input: Json): Promise<Receipt<T>>;
  replay<T>(receipt: Receipt<T>): Promise<Receipt<T>>;
  expectRefusal(operation: string, input: Json, outcomeKind: string): Promise<void>;
  expectLog(summary: string): Promise<void>;
  expectRead(operation: string, assertion: (projection: unknown) => boolean): Promise<void>;
  expectRead(
    operation: string,
    input: unknown,
    assertion: (projection: unknown) => boolean
  ): Promise<void>;
  expectRead(
    operation: string,
    inputOrAssertion: unknown | ((projection: unknown) => boolean),
    assertion?: (projection: unknown) => boolean
  ): Promise<void>;
}

interface PublicActor {
  submitForm<T>(formId: string, answers: readonly Json[]): Promise<Receipt<T>>;
  expectRead(operation: 'schedule.public.read', assertion: (projection: unknown) => boolean): Promise<void>;
}

export interface J2FlowWorld {
  as(persona: 'organizer' | 'reviewer'): Actor;
  asPublic(): PublicActor;
}

type EventCreated = { readonly event: { readonly id: string } };
type VocabularyChange = { readonly affectedIds: readonly string[] };
type Field = {
  readonly id: string;
  readonly kind: string;
  readonly mapsTo: string | null;
  readonly scope: { readonly kind: string };
  readonly contexts: { readonly apply: { readonly visible: boolean } };
};
type FieldRegistry = { readonly version: number; readonly fields: readonly Field[] };
type FormCreated = { readonly formId: string; readonly formDefinitionVersion: number };
type FormDraft = {
  readonly draftId: string;
  readonly revision: { readonly id: string; readonly digestSha256: string };
};
type FormPublished = { readonly publishedVersionId: string };
type TemplateArtifact = {
  readonly head: { readonly artifactId: string };
  readonly current: {
    readonly revisionId: string;
    readonly number: number;
    readonly digestSha256: string;
    readonly document:
      | { readonly kind: 'theme'; readonly recipe: Json }
      | {
          readonly kind: 'surface';
          readonly surfaceKind: 'application-form';
          readonly blocks: readonly { readonly type: string; readonly title?: string; readonly intro?: string }[];
        };
  };
};
type TemplateArtifacts = { readonly artifacts: readonly TemplateArtifact[] };
type Submission = { readonly submission: { readonly submissionId: string } };
type Roster = { readonly rosterVersion: number; readonly rosterDigestSha256: string };
type Round = {
  readonly round: { readonly id: string; readonly version: number; readonly criteria: readonly { readonly id: string }[] };
  readonly assignmentCount: number;
};
type ReviewerRegistration = { readonly reviewer: { readonly reviewerId: string } };
type ReviewSnapshot = {
  readonly queue?: readonly {
    readonly assignmentId: string;
    readonly assignmentVersion: number;
    readonly submissionId: string;
    readonly draft?: { readonly version: number };
  }[];
};
type ReviewDraft = { readonly draft: { readonly version: number } };
type Decision = {
  readonly rows: readonly {
    readonly submissionId: string;
    readonly head: { readonly version: number; readonly digestSha256: string };
    readonly origin: { readonly sessionId: string };
  }[];
};
type DecisionState = {
  readonly rows: readonly {
    readonly submissionId: string;
    readonly firstDecidedAt?: string | null;
  }[];
};
type EngagementSnapshot = {
  readonly engagements: readonly {
    readonly id: string;
    readonly submissionId: string | null;
    readonly state: string;
    readonly version: number;
  }[];
};
type ScheduleSnapshot = { readonly scheduleVersion: number };
type Placement = {
  readonly scheduleVersion: number;
  readonly occurrence: {
    readonly id: string;
    readonly version: number;
    readonly sessionId: string;
    readonly roomId: string;
    readonly startAt: string;
    readonly endAt: string;
  } | null;
};
type ReleaseDraft = {
  readonly draftId: string;
  readonly revision: { readonly id: string; readonly digestSha256: string };
};
type StyleReleaseDraft = ReleaseDraft & {
  readonly safeDiff: { readonly action: 'style_set_publish'; readonly after: { readonly releaseId: string } };
};

function required<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null) throw new Error(`J2 prerequisite missing: ${label}`);
  return value;
}

/** Durable J2 facts that later catalog journeys correct through real operations. */
export interface J2SpineResult {
  readonly formatId: string;
  readonly roomId: string;
  readonly formId: string;
  readonly submissionId: string;
  readonly reviewerId: string;
  readonly decision: {
    readonly version: number;
    readonly digestSha256: string;
    readonly decidedAt: string;
  };
  readonly sessionId: string;
  readonly placement: NonNullable<Placement['occurrence']>;
}

export interface J2DecisionReadyResult {
  readonly kind: 'decision_ready';
  readonly formatId: string;
  readonly roomId: string;
  readonly formId: string;
  readonly submissionId: string;
  readonly reviewerId: string;
}

export interface J2SpineOptions {
  readonly stopAt?: 'decision';
}

/**
 * The fresh-world arrangement stays operation-driven: no fixture reaches into
 * SQLite.  `submitForm` is the methodology's public ceremony adapter; it is
 * responsible for the continuation-bound begin/save/submit calls, never for a
 * direct database write.
 */
export function runJ2Spine(w: J2FlowWorld): Promise<J2SpineResult>;
export function runJ2Spine(w: J2FlowWorld, options: J2SpineOptions): Promise<J2SpineResult | J2DecisionReadyResult>;
export async function runJ2Spine(
  w: J2FlowWorld,
  options?: J2SpineOptions
): Promise<J2SpineResult | J2DecisionReadyResult> {
  const organizer = w.as('organizer');
  const reviewer = w.as('reviewer');
  const submitter = w.asPublic();

  const event = await organizer.do<EventCreated>('event.create', {
    expectedEventSetVersion: 1,
    name: 'J2 Spine Conference',
    timezone: 'Asia/Singapore',
    startDate: '2027-06-10',
    endDate: '2027-06-12'
  });
  await organizer.expectLog('Created an event');

  await reviewer.expectRefusal('program_vocabulary.create', {
    kind: 'track', expectedSetVersion: 1, name: 'Unauthorized track'
  }, 'authority.not_authorized');

  const format = await organizer.do<VocabularyChange>('program_vocabulary.create', {
    kind: 'format', expectedSetVersion: 1, name: 'Talk'
  });
  await organizer.expectLog('Created a format');
  const formatId = required(format.data.affectedIds[0], 'format');

  const room = await organizer.do<VocabularyChange>('program_vocabulary.create', {
    kind: 'room', expectedSetVersion: 2, name: 'Spine Hall', capacity: 200
  });
  await organizer.expectLog('Created a room');
  const roomId = required(room.data.affectedIds[0], 'room');

  // The field registry is itself a registered read.  The CFP exposes only the
  // three mapped fields J2 needs, and all setup remains visible to the log.
  let registry!: FieldRegistry;
  await organizer.expectRead('field_registry.snapshot.read', (projection) => {
    registry = projection as FieldRegistry;
    return registry.fields.length > 0;
  });
  const title = required(registry.fields.find((field) =>
    field.mapsTo === 'talk.title' && field.kind === 'text'
  ), 'talk.title field');
  const name = required(registry.fields.find((field) =>
    field.mapsTo === 'person.name' && field.kind === 'text'
  ), 'person.name field');
  const email = required(registry.fields.find((field) =>
    field.mapsTo === 'person.email' && field.kind === 'email'
  ), 'person.email field');
  const included = new Set([title.id, name.id, email.id]);

  const form = await organizer.do<FormCreated>('form.definition.create', {
    expectedCatalogVersion: 1,
    expectedRegistryVersion: registry.version,
    definition: {
      kind: 'cfp',
      name: 'J2 Call for Talks',
      target: { kind: 'category', category: { kind: 'format', id: formatId } },
      availability: { kind: 'evergreen' },
      confirmation: 'Application received.',
      composition: {
        excludedFieldIds: registry.fields
          .filter((field) => field.scope.kind === 'shared' && field.contexts.apply.visible
            && !included.has(field.id))
          .map((field) => field.id)
          .sort(),
        requiredOverrides: {},
        optionExposure: {}
      },
      rules: []
    }
  });
  await organizer.expectLog('Created a form');

  const formDraft = await organizer.do<FormDraft>('form.version.publish.draft', {
    action: 'publish_and_open',
    formId: form.data.formId,
    expectedDefinitionVersion: form.data.formDefinitionVersion,
    expectedRegistryVersion: registry.version
  });
  const publishedForm = await organizer.do<FormPublished>('form.version.publish', {
    draftId: formDraft.data.draftId,
    revisionId: formDraft.data.revision.id,
    revisionDigestSha256: formDraft.data.revision.digestSha256
  });
  await organizer.expectLog('Published and opened a form');
  await organizer.replay(publishedForm);

  // Public intake is only live when an immutable application surface pins the
  // published form.  These are the feature-native review/publish operations,
  // not a fixture shortcut around the public boundary.
  let artifacts!: TemplateArtifacts;
  await organizer.expectRead('template.artifact.list', (projection) => {
    artifacts = projection as TemplateArtifacts;
    return artifacts.artifacts.length > 0;
  });
  const theme = required(artifacts.artifacts.find((artifact) =>
    artifact.current.document.kind === 'theme'
  ), 'theme template');
  const applicationSurface = required(artifacts.artifacts.find((artifact) =>
    artifact.current.document.kind === 'surface'
      && artifact.current.document.surfaceKind === 'application-form'
  ), 'application surface template');
  if (theme.current.document.kind !== 'theme'
      || applicationSurface.current.document.kind !== 'surface') {
    throw new Error('J2 template type mismatch');
  }
  const pin = (artifact: TemplateArtifact) => ({
    artifactId: artifact.head.artifactId,
    revisionId: artifact.current.revisionId,
    revisionNumber: artifact.current.number,
    digestSha256: artifact.current.digestSha256
  });
  const hero = applicationSurface.current.document.blocks.find((block) => block.type === 'hero');
  const styleDraft = await organizer.do<StyleReleaseDraft>('release.change.draft', {
    action: 'style_set_publish', sourceTemplateRevision: pin(theme),
    recipe: theme.current.document.recipe, expectedCurrentStyleSetNumber: null
  });
  await organizer.do('release.publish', {
    draftId: styleDraft.data.draftId,
    revisionId: styleDraft.data.revision.id,
    revisionDigestSha256: styleDraft.data.revision.digestSha256
  });
  await organizer.expectLog('Published the event style');
  const applicationDraft = await organizer.do<ReleaseDraft>('release.change.draft', {
    action: 'surface_publish', kind: 'apply', sourceTemplateRevision: pin(applicationSurface),
    manifest: { schemaVersion: 1, heading: hero?.title?.trim() || null, intro: hero?.intro?.trim() || null },
    styleSetReleaseId: styleDraft.data.safeDiff.after.releaseId,
    formRef: { formId: form.data.formId, formVersionId: publishedForm.data.publishedVersionId },
    expectedSurfaceHeadVersion: null
  });
  await organizer.do('release.publish', {
    draftId: applicationDraft.data.draftId,
    revisionId: applicationDraft.data.revision.id,
    revisionDigestSha256: applicationDraft.data.revision.digestSha256
  });
  await organizer.expectLog('Published a public surface');

  const submission = await submitter.submitForm<Submission>(form.data.formId, [
    { kind: 'text', fieldId: title.id, value: 'Operations as a product boundary' },
    { kind: 'text', fieldId: name.id, value: 'Pia Public' },
    { kind: 'email', fieldId: email.id, value: 'pia.public@example.test' }
  ]);
  const submissionId = submission.data.submission.submissionId;
  await organizer.expectRead('submission.triage.list', (projection) => {
    const list = projection as { readonly rows: readonly { readonly triage: { readonly submissionId: string; readonly state: string } }[] };
    return list.rows.some((row) => row.triage.submissionId === submissionId && row.triage.state === 'inbox');
  });

  let triage!: { readonly queryGuard: { readonly version: number; readonly digestSha256: string }; readonly rows: readonly { readonly triage: { readonly submissionId: string; readonly version: number } }[] };
  await organizer.expectRead('submission.triage.list', (projection) => {
    triage = projection as typeof triage;
    return true;
  });
  const triageHead = required(triage.rows.find((row) => row.triage.submissionId === submissionId), 'triage head');
  await organizer.do('submission.triage.transition', {
    action: 'set_aside', submissionIds: [submissionId],
    expectedHeads: [{ submissionId, version: triageHead.triage.version }],
    expectedQueryGuard: {
      version: triage.queryGuard.version,
      digestSha256: triage.queryGuard.digestSha256
    }
  });
  await organizer.expectLog('Set submissions aside');

  await organizer.expectRead('submission.triage.list', (projection) => {
    triage = projection as typeof triage;
    return true;
  });
  const setAsideHead = required(triage.rows.find((row) => row.triage.submissionId === submissionId), 'set-aside head');
  await organizer.do('submission.triage.transition', {
    action: 'return_to_inbox', submissionIds: [submissionId],
    expectedHeads: [{ submissionId, version: setAsideHead.triage.version }],
    expectedQueryGuard: {
      version: triage.queryGuard.version,
      digestSha256: triage.queryGuard.digestSha256
    }
  });
  await organizer.expectLog('Returned submissions to the inbox');

  // Keeping is intentionally a no-op: the submission remains visibly in the
  // inbox rather than receiving a synthetic "keep" mutation.
  await organizer.expectRead('submission.triage.list', (projection) => {
    const list = projection as { readonly rows: readonly { readonly triage: { readonly submissionId: string; readonly state: string } }[] };
    return list.rows.some((row) => row.triage.submissionId === submissionId && row.triage.state === 'inbox');
  });

  let roster!: Roster;
  await organizer.expectRead('reviewer_roster.snapshot.read', (projection) => {
    roster = projection as Roster;
    return true;
  });
  const registration = await organizer.do<ReviewerRegistration>('reviewer_roster.change', {
    action: 'register',
    reviewerId: reviewer.userId,
    accessSubject: {
      kind: 'workspace_membership', id: reviewer.membership.id, version: reviewer.membership.version
    },
    reviews: [],
    expectedRosterVersion: roster.rosterVersion,
    expectedRosterDigestSha256: roster.rosterDigestSha256
  });
  await organizer.expectLog('Added a reviewer');

  const round = await organizer.do<Round>('review.round.change', {
    action: 'open_round', deadlineDate: '2027-06-11', anonymized: true
  });
  await organizer.expectLog('Opened a review round');
  if (round.data.assignmentCount !== 1) throw new Error('J2 expected exactly one reviewer assignment');

  let review!: ReviewSnapshot;
  await reviewer.expectRead('review.snapshot.read', (projection) => {
    review = projection as ReviewSnapshot;
    return review.queue?.some((entry) => entry.submissionId === submissionId) === true;
  });
  const assignment = required(review.queue?.find((entry) => entry.submissionId === submissionId), 'review assignment');
  const criterion = required(round.data.round.criteria[0], 'default review criterion');
  const draft = await reviewer.do<ReviewDraft>('review.evaluation.draft.save', {
    assignmentId: assignment.assignmentId,
    expectedDraftVersion: assignment.draft?.version ?? null,
    scores: [{ criterionId: criterion.id, score: 5 }],
    comment: 'Clear, practical, and ready for the program.'
  });
  const evaluation = await reviewer.do('review.evaluation.change', {
    action: 'commit_review',
    assignmentId: assignment.assignmentId,
    expectedAssignmentVersion: assignment.assignmentVersion,
    expectedDraftVersion: draft.data.draft.version
  });
  await reviewer.expectLog('Submitted a review');
  await reviewer.replay(evaluation);

  if (options?.stopAt === 'decision') {
    return {
      kind: 'decision_ready', formatId, roomId, formId: form.data.formId,
      submissionId, reviewerId: registration.data.reviewer.reviewerId
    };
  }

  const decision = await organizer.do<Decision>('decision.decide', {
    action: 'decide',
    decisions: [{
      submissionId, state: 'accepted', expectedDecisionVersion: null,
      expectedDecisionDigestSha256: null, graduation: { kind: 'spawn' }
    }]
  });
  await organizer.expectLog('Recorded submission decisions');
  const accepted = required(decision.data.rows.find((row) => row.submissionId === submissionId), 'accepted decision');
  const firstDecidedAt: { value: string | null } = { value: null };
  await organizer.expectRead('decision.state.read', { submissionIds: [submissionId] }, (projection) => {
    const state = projection as DecisionState;
    firstDecidedAt.value = state.rows.find((row) => row.submissionId === submissionId)?.firstDecidedAt ?? null;
    return firstDecidedAt.value !== null;
  });

  let engagements!: EngagementSnapshot;
  await organizer.expectRead('engagement.snapshot.read', (projection) => {
    engagements = projection as EngagementSnapshot;
    return engagements.engagements.some((entry) => entry.submissionId === submissionId && entry.state === 'invited');
  });
  const engagement = required(engagements.engagements.find((entry) => entry.submissionId === submissionId), 'invited engagement');
  await organizer.do('engagement.change', {
    action: 'record_confirmation', engagementId: engagement.id,
    expectedEngagementVersion: engagement.version, attribution: 'organizer_recorded'
  });
  await organizer.expectLog('Recorded a speaker confirmation');

  let schedule!: ScheduleSnapshot;
  await organizer.expectRead('schedule.placement.snapshot.read', {
    startAt: '2027-06-10T00:00:00.000Z',
    endAt: '2027-06-13T00:00:00.000Z',
    limit: 100
  }, (projection) => {
    schedule = projection as ScheduleSnapshot;
    return true;
  });
  const placed = await organizer.do<Placement>('schedule.placement', {
    action: 'place', expectedScheduleVersion: schedule.scheduleVersion, roomId,
    sessionId: accepted.origin.sessionId,
    startAt: '2027-06-10T01:00:00.000Z', endAt: '2027-06-10T01:45:00.000Z'
  });
  await organizer.expectLog('Placed a session on the schedule');

  const programDraft = await organizer.do<ReleaseDraft>('release.change.draft', {
    action: 'publish_schedule', expectedCurrentReleaseNumber: null
  });
  await organizer.do('release.publish', {
    draftId: programDraft.data.draftId,
    revisionId: programDraft.data.revision.id,
    revisionDigestSha256: programDraft.data.revision.digestSha256
  });
  await organizer.expectLog('Published the schedule');
  await submitter.expectRead('schedule.public.read', (projection) => {
    const program = projection as { readonly sessions: readonly { readonly sessionId: string }[] };
    return program.sessions.some((session) => session.sessionId === accepted.origin.sessionId);
  });

  const placement = required(placed.data.occurrence, 'placement occurrence');

  // Retain the event receipt so a future trace can name the whole story even
  // when a failure occurs after the first dozen successful mutations.
  void event.data.event.id;
  return {
    formatId,
    roomId,
    formId: form.data.formId,
    submissionId,
    reviewerId: registration.data.reviewer.reviewerId,
    decision: {
      version: accepted.head.version,
      digestSha256: accepted.head.digestSha256,
      decidedAt: required(firstDecidedAt.value, 'first decision instant')
    },
    sessionId: accepted.origin.sessionId,
    placement
  };
}
