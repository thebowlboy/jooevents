import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import {
  changesetLifecycleOperationResultSchema
} from '@jooevents/changeset-operations';
import {
  programVocabularyDraftOperationResultSchema
} from '@jooevents/program-operations';
import { workspaceOverviewReadResultSchema } from '@jooevents/contracts/workspace-overview';
import { reviewSnapshotReadResultSchema } from '@jooevents/contracts/reviews';
import {
  createRichEphemeralLiveFixture,
  RICH_EPHEMERAL_LIVE_SCENARIO,
  RICH_REVIEWER_ID,
  type RichEphemeralLiveFixture
} from './rich-ephemeral-live-fixture';

const fixtures: RichEphemeralLiveFixture[] = [];

function cleanupRetainedTree(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || realpathSync(path) !== path
    || !basename(path).startsWith('jooevents-ephemeral-runtime-')
  ) {
    throw new Error(`unsafe_rich_ephemeral_fixture_cleanup:${path}`);
  }
  const parent = realpathSync(dirname(path));
  if (dirname(path) !== parent) throw new Error(`unsafe_rich_ephemeral_fixture_parent:${path}`);
  rmSync(path, { recursive: true });
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (!fixture) continue;
    fixture.close();
    cleanupRetainedTree(fixture.directoryPath);
  }
});

async function openFixture(): Promise<RichEphemeralLiveFixture> {
  const fixture = await createRichEphemeralLiveFixture();
  fixtures.push(fixture);
  return fixture;
}

async function effect(
  fixture: RichEphemeralLiveFixture,
  path: string,
  key: string,
  body: unknown
): Promise<unknown> {
  const response = await fixture.runtime.app.request(path, {
    method: 'POST',
    headers: {
      cookie: fixture.ownerCookie,
      origin: 'http://localhost:4193',
      'content-type': 'application/json',
      'idempotency-key': key,
      'x-correlation-id': crypto.randomUUID()
    },
    body: JSON.stringify(body)
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function retirePanelFormat(fixture: RichEphemeralLiveFixture): Promise<void> {
  const itemId = fixture.handles.vocabulary.panel;
  const snapshot = fixture.runtime.database.sqlite.query<{
    readonly set_version: number;
    readonly version: number;
  }, [string]>(`
    SELECT sets.set_version, formats.version
      FROM program_vocabulary_sets AS sets
      JOIN program_vocabulary_formats AS formats
        ON formats.workspace_id = sets.workspace_id
       AND formats.event_id = sets.event_id
     WHERE formats.id = ?
  `).get(itemId);
  if (!snapshot) throw new TypeError('rich_fixture_test_panel_missing');
  const draft = programVocabularyDraftOperationResultSchema.parse(await effect(
    fixture,
    '/api/events/current/program-vocabulary/drafts/retire',
    'isolation-panel-retire-draft',
    {
      kind: 'format',
      id: itemId,
      expectedSetVersion: snapshot.set_version,
      expectedItemVersion: snapshot.version
    }
  ));
  if (draft.kind !== 'success') throw new TypeError('rich_fixture_test_panel_draft_failed');
  const selector = {
    changesetId: draft.data.changesetId,
    revisionId: draft.data.revision.id,
    revisionDigest: draft.data.revision.digestSha256
  };
  const proposed = changesetLifecycleOperationResultSchema.parse(await effect(
    fixture,
    '/api/changesets/proposals',
    'isolation-panel-retire-propose',
    { ...selector, expectedHeadVersion: draft.data.headVersion }
  ));
  if (proposed.kind !== 'success' || proposed.data.action !== 'propose') {
    throw new TypeError('rich_fixture_test_panel_propose_failed');
  }
  const committed = changesetLifecycleOperationResultSchema.parse(await effect(
    fixture,
    '/api/changesets/commits',
    'isolation-panel-retire-commit',
    { ...selector, expectedHeadVersion: proposed.data.diff.headVersion }
  ));
  if (committed.kind !== 'success' || committed.data.action !== 'commit') {
    throw new TypeError('rich_fixture_test_panel_commit_failed');
  }
}

describe('rich ephemeral live SQLite fixture', () => {
  test('builds one coherent operation-seeded baseline with declared extension slots', async () => {
    const fixture = await openFixture();
    const expected = RICH_EPHEMERAL_LIVE_SCENARIO.expected;

    expect(fixture.baseline.event).toEqual({
      ...RICH_EPHEMERAL_LIVE_SCENARIO.event,
      ...RICH_EPHEMERAL_LIVE_SCENARIO.eventSettings,
      version: 2
    });
    expect(fixture.baseline.durableCounts).toEqual({
      eventHeads: expected.events,
      vocabularyItems: expected.vocabulary.total,
      formHeads: expected.forms.total,
      formVersions: expected.forms.publishedVersions,
      fieldRegistries: expected.events,
      submissions: expected.submissions,
      engagements: expected.engagements,
      messageReleases: expected.messageReleases,
      outboundDeliveries: expected.outboundDeliveries,
      programReleases: expected.programReleases,
      surfaceReleases: expected.surfaceReleases,
      participantIdentities: expected.participantIdentities,
      sessions: expected.sessions.total,
      sessionCatalogs: expected.sessions.catalogs,
      reviewerRosterSets: expected.reviewerRoster.sets,
      reviewerRosterRecords: expected.reviewerRoster.records,
      reviewerRosterScopes: expected.reviewerRoster.scopes,
      reviewCatalogs: expected.review.catalogs,
      reviewRounds: expected.review.rounds,
      reviewRoundCriteria: expected.review.roundCriteria,
      reviewAssignments: expected.review.assignments,
      deadlines: expected.deadlines.total,
      deadlineCatalogs: expected.deadlines.catalogs,
      changesets: expected.changesets,
      committedChangesets: expected.changesets,
      operationReceipts: expected.operationReceipts
    });
    expect(fixture.baseline.historyCounts).toEqual(expected.history);
    expect(fixture.baseline.vocabulary.items.filter((item) => item.status === 'retired'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'archive_hall', usage: { current: 0, historicalPins: 0 } }),
        expect.objectContaining({ key: 'legacy_integrations', usage: { current: 0, historicalPins: 0 } }),
        expect.objectContaining({ key: 'agent_systems', usage: { current: 1, historicalPins: 1 } }),
        expect.objectContaining({ key: 'workshop', usage: { current: 0, historicalPins: 1 } })
      ]));
    expect(fixture.baseline.vocabulary.items.find((item) => item.key === 'workshop_lab'))
      .toMatchObject({ name: 'Workshop Lab · Ground Floor', capacity: 84, version: 2 });
    expect(fixture.baseline.vocabulary.items.find((item) => item.key === 'lightning_talk'))
      .toMatchObject({ status: 'active', version: 3 });

    expect(fixture.baseline.forms.items.map((form) => ({
      key: form.key,
      status: form.status,
      version: form.version,
      published: form.publishedVersionCount
    }))).toEqual([
      { key: 'working_draft', status: 'draft', version: 1, published: 0 },
      { key: 'main_open', status: 'open', version: 2, published: 1 },
      { key: 'main_closed', status: 'closed', version: 3, published: 1 },
      { key: 'track_open', status: 'open', version: 2, published: 1 },
      { key: 'format_history', status: 'closed', version: 5, published: 2 }
    ]);
    expect(fixture.baseline.forms.items.find((form) => form.key === 'format_history'))
      .toMatchObject({
        target: { kind: 'category', category: { kind: 'format', key: 'talk' } },
        publishedVersions: [
          {
            number: 1,
            sourceDefinitionVersion: 1,
            target: { kind: 'category', category: { kind: 'format', key: 'workshop' } },
            targetPin: {
              kind: 'category', categoryKind: 'format', key: 'workshop',
              name: 'Workshop', version: 1
            }
          },
          {
            number: 2,
            sourceDefinitionVersion: 3,
            target: { kind: 'category', category: { kind: 'format', key: 'talk' } },
            targetPin: {
              kind: 'category', categoryKind: 'format', key: 'talk',
              name: 'Talk', version: 1
            }
          }
        ],
        currentPublishedVersion: {
          number: 2,
          sourceDefinitionVersion: 3,
          targetPin: {
            kind: 'category', categoryKind: 'format', key: 'talk', name: 'Talk', version: 1
          }
        }
      });
    expect(fixture.baseline.forms.items.find((form) => form.key === 'track_open'))
      .toMatchObject({
        target: { kind: 'category', category: { kind: 'track', key: 'agent_systems' } }
      });
    expect(fixture.baseline.forms.items.find((form) => form.key === 'main_open'))
      .toMatchObject({
        fields: expect.arrayContaining([
          expect.objectContaining({
            key: 'talk.format',
            kind: 'select',
            mapsTo: 'talk.format',
            options: {
              kind: 'program_vocabulary', source: 'formats',
              resolved: ['lightning_talk', 'panel', 'talk']
            }
          }),
          expect.objectContaining({
            key: 'talk.track',
            kind: 'select',
            mapsTo: 'talk.track',
            options: {
              kind: 'program_vocabulary', source: 'tracks',
              resolved: ['evaluation_reliability', 'product_craft']
            }
          }),
          expect.objectContaining({
            key: 'person.recording_consent',
            kind: 'checkbox',
            purpose: { kind: 'consent', key: 'recording_and_code_of_conduct' }
          })
        ]),
        rules: [{
          key: 'recording_exception',
          condition: {
            kind: 'checked_is', sourceFieldKey: 'person.recording_consent', value: false
          },
          effect: { kind: 'require', targetFieldKeys: ['talk.notes'] }
        }]
      });
    expect(fixture.baseline.fieldRegistry.version).toBe(expected.fieldRegistry.version);
    expect(fixture.baseline.fieldRegistry.fields).toHaveLength(expected.fieldRegistry.fields);
    expect(fixture.baseline.fieldRegistry.fields.find((field) => field.key === 'person.email'))
      .toMatchObject({ kind: 'email', answerOwner: 'person', locked: true });
    expect(fixture.baseline.fieldRegistry.fields.find((field) => field.key === 'talk.track'))
      .toMatchObject({
        kind: 'select',
        answerOwner: 'talk',
        options: {
          kind: 'program_vocabulary',
          source: 'tracks',
          resolved: expect.arrayContaining([
            expect.objectContaining({ key: 'evaluation_reliability' }),
            expect.objectContaining({ key: 'product_craft' })
          ])
        }
      });
    expect(fixture.baseline.fieldRegistry.fields.find((field) => field.key === 'person.headshot'))
      .toMatchObject({ kind: 'file', fileUpload: 'disabled' });

    expect(fixture.baseline.sessions).toEqual({
      catalogVersion: expected.sessions.catalogVersion,
      items: [
        {
          key: 'programmed_keynote',
          title: 'Deterministic Changesets in Production',
          lifecycle: 'programmed',
          plannedDurationMinutes: 45,
          version: 1,
          format: 'talk',
          track: 'evaluation_reliability',
          programSetVersion: expected.vocabulary.setVersion,
          participants: 0
        },
        {
          key: 'collecting_panel',
          title: 'Evaluating Agent Product Craft',
          lifecycle: 'collecting',
          plannedDurationMinutes: 60,
          version: 2,
          format: 'panel',
          track: 'product_craft',
          programSetVersion: expected.vocabulary.setVersion,
          participants: 0
        }
      ]
    });

    expect(fixture.reviewer.reviewerId).toBe(RICH_REVIEWER_ID);
    expect(fixture.reviewer.userId).not.toBe(fixture.ownerUserId);
    expect(fixture.baseline.reviewerRoster).toEqual({
      rosterVersion: expected.reviewerRoster.rosterVersion,
      reviewers: [{
        reviewerId: RICH_REVIEWER_ID,
        status: 'active',
        accessSubjectKind: 'workspace_membership',
        displayName: 'Rich Fixture Reviewer',
        reviews: 0
      }]
    });
    expect(fixture.baseline.review).toEqual({
      organizerViewer: 'organizer',
      plans: 0,
      standings: 0,
      roundSetup: {
        activeReviewers: 1,
        invitedReviewers: 0,
        submissions: expected.submissions,
        expectedReviews: expected.review.assignments,
        perReviewer: [{
          reviewerId: RICH_REVIEWER_ID,
          displayName: 'Rich Fixture Reviewer',
          assigned: 0
        }]
      }
    });
    expect(fixture.reviewPins).toEqual(RICH_EPHEMERAL_LIVE_SCENARIO.reviewPins);

    // The rostered reviewer-only principal is served the blind reviewer view.
    const reviewerSnapshotResponse = await fixture.runtime.app.request(
      '/api/events/current/review/snapshot',
      {
        headers: {
          cookie: fixture.reviewer.cookie,
          'x-correlation-id': crypto.randomUUID()
        }
      }
    );
    expect(reviewerSnapshotResponse.status).toBe(200);
    expect(reviewSnapshotReadResultSchema.parse(
      await reviewerSnapshotResponse.json()
    )).toMatchObject({
      kind: 'success',
      data: {
        viewer: { kind: 'reviewer', reviewerId: RICH_REVIEWER_ID },
        plans: [],
        standings: {}
      }
    });

    // The owner still resolves the organizer view after all seeding because
    // the roster contains only the reviewer principal and the owner carries
    // durable event.manage evidence.
    const organizerSnapshotResponse = await fixture.runtime.app.request(
      '/api/events/current/review/snapshot',
      {
        headers: {
          cookie: fixture.ownerCookie,
          'x-correlation-id': crypto.randomUUID()
        }
      }
    );
    expect(organizerSnapshotResponse.status).toBe(200);
    expect(reviewSnapshotReadResultSchema.parse(
      await organizerSnapshotResponse.json()
    )).toMatchObject({
      kind: 'success',
      data: {
        viewer: { kind: 'organizer' },
        plans: [],
        roundSetup: {
          activeReviewers: 1,
          invitedReviewers: 0,
          submissions: 0,
          expectedReviews: 0
        }
      }
    });

    expect(fixture.baseline.extensionSlots.submissions).toEqual(
      RICH_EPHEMERAL_LIVE_SCENARIO.extensionSlots.submissions
    );
    expect(fixture.baseline.extensionSlots.reviewRounds).toEqual(
      RICH_EPHEMERAL_LIVE_SCENARIO.extensionSlots.reviewRounds
    );
    const overviewCorrelationId = crypto.randomUUID();
    const overviewResponse = await fixture.runtime.app.request('/api/workspace/overview', {
      headers: {
        cookie: fixture.ownerCookie,
        'x-correlation-id': overviewCorrelationId
      }
    });
    expect(overviewResponse.status).toBe(200);
    expect(workspaceOverviewReadResultSchema.parse(await overviewResponse.json())).toMatchObject({
      kind: 'success',
      data: {
        schemaVersion: 1,
        event: {
          kind: 'current_event',
          event: { id: fixture.handles.eventId, name: RICH_EPHEMERAL_LIVE_SCENARIO.event.name }
        },
        metrics: {
          forms: {
            kind: 'exact',
            total: expected.forms.total,
            draft: expected.forms.draft,
            open: expected.forms.open,
            closed: expected.forms.closed
          },
          submissions: { kind: 'exact', total: expected.submissions },
          programVocabulary: {
            kind: 'exact',
            rooms: { total: expected.vocabulary.rooms },
            tracks: { total: expected.vocabulary.tracks },
            formats: { total: expected.vocabulary.formats }
          },
          changesets: {
            kind: 'exact',
            // Event-scoped heads only: the event-creation changeset precedes
            // the event and the workspace_team role change is workspace-scoped.
            total: expected.changesets - 2,
            committed: expected.changesets - 2
          }
        },
        // The overview history evidence union covers the event, vocabulary,
        // form, field-registry, triage, and workspace_team timelines; the
        // three Session changesets and the roster registration have no
        // source there, while the reviewer role change adds one team thread.
        history: { total: expected.changesets - 4, truncated: true }
      },
      correlationId: overviewCorrelationId
    });
    expect(fixture.baselineFingerprintSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.runtime.database.sqlite.query<Record<string, unknown>, []>(
      'PRAGMA foreign_key_check'
    ).all()).toEqual([]);
  });

  test('isolates callers and rebuilds an exact identity-normalized baseline', async () => {
    const first = await openFixture();
    const second = await openFixture();

    expect(first.databasePath).not.toBe(second.databasePath);
    expect(first.workspaceId).not.toBe(second.workspaceId);
    expect(first.handles.eventId).not.toBe(second.handles.eventId);
    expect(first.handles.forms.main_open).not.toBe(second.handles.forms.main_open);
    expect(first.baseline).toEqual(second.baseline);
    expect(first.baselineFingerprintSha256).toBe(second.baselineFingerprintSha256);

    await retirePanelFormat(first);
    const firstPanel = first.runtime.database.sqlite.query<{
      readonly status: string;
      readonly version: number;
    }, [string]>(`
      SELECT status, version FROM program_vocabulary_formats WHERE id = ?
    `).get(first.handles.vocabulary.panel);
    const secondPanel = second.runtime.database.sqlite.query<{
      readonly status: string;
      readonly version: number;
    }, [string]>(`
      SELECT status, version FROM program_vocabulary_formats WHERE id = ?
    `).get(second.handles.vocabulary.panel);
    expect(firstPanel).toEqual({ status: 'retired', version: 2 });
    expect(secondPanel).toEqual({ status: 'active', version: 1 });

    const rebuilt = await openFixture();
    expect(rebuilt.baseline).toEqual(second.baseline);
    expect(rebuilt.baselineFingerprintSha256).toBe(second.baselineFingerprintSha256);
  }, 15_000);
});
