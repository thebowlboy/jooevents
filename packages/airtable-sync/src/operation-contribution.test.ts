import { describe, expect, test } from 'bun:test';
import { parseEventId, parseInstant, parseWorkspaceId } from '@jooevents/kernel';
import { createAirtableDirectFeatureContributor } from './operation-contribution';

const workspaceId = parseWorkspaceId('018f0f64-4d6c-7b2f-8a1e-1234567890ac');
const eventId = parseEventId('018f0f64-4d6c-7b2f-8a1e-1234567890ad');
const assignmentId = '018f0f64-4d6c-7b2f-8a1e-1234567890ae';
const taskDefinitionId = '018f0f64-4d6c-7b2f-8a1e-1234567890af';

describe('Airtable direct operation contribution', () => {
  test('classifies the selected task mutation by stable assignment and current version', () => {
    const contributor = createAirtableDirectFeatureContributor();
    const value = contributor.contribute({
      operation: { name: 'task.mutation', version: 1 },
      businessInput: { action: 'waive_assignment' },
      canonicalResult: {
        kind: 'success',
        data: {
          schemaVersion: 1,
          action: 'waive_assignment',
          assignment: {
            schemaVersion: 1,
            scope: { workspaceId, eventId },
            id: assignmentId,
            taskDefinitionId,
            taskDefinitionRevisionId: '018f0f64-4d6c-7b2f-8a1e-1234567890b0',
            engagementId: '018f0f64-4d6c-7b2f-8a1e-1234567890b1',
            personId: '018f0f64-4d6c-7b2f-8a1e-1234567890b2',
            state: 'waived',
            deadline: {
              kind: 'task_due',
              reference: {
                id: '018f0f64-4d6c-7b2f-8a1e-1234567890b3',
                version: 1,
                digestSha256: 'a'.repeat(64),
                effectiveAt: '2026-08-20T23:59:59.999Z',
                displayDate: '2026-08-20',
                gracePolicy: 'soft'
              }
            },
            deadlineOverride: null,
            completionEvidence: null,
            assignedAt: '2026-08-17T00:00:00.000Z',
            updatedAt: '2026-08-17T00:01:00.000Z',
            version: 4
          }
        }
      },
      scope: {
        workspaceId,
        eventId,
        subjects: [{ kind: 'event', id: eventId }],
        resolutionEvidenceIds: []
      },
      occurredAt: parseInstant('2026-08-17T00:01:00.000Z')
    });
    expect(value).toMatchObject({
      schemaVersion: 2,
      workspaceId,
      eventId,
      impacts: [{
        areaKey: 'tasks',
        subjectKind: 'task_assignment',
        subjectId: assignmentId,
        projectionVersion: 4
      }]
    });
  });

  test('contributes nothing for an operation outside the selected inventory', () => {
    const contributor = createAirtableDirectFeatureContributor();
    expect(contributor.contribute({
      operation: { name: 'workspace.rename', version: 1 },
      businessInput: {},
      canonicalResult: { kind: 'success', data: {} },
      scope: { workspaceId, subjects: [], resolutionEvidenceIds: [] },
      occurredAt: parseInstant('2026-08-17T00:01:00.000Z')
    })).toBeUndefined();
  });

  test('selects bounded area refreshes for managed values without provider code', () => {
    const contributor = createAirtableDirectFeatureContributor();
    expect(contributor.contribute({
      operation: { name: 'schedule.placement', version: 1 },
      businessInput: {},
      canonicalResult: { kind: 'success', data: {} },
      scope: { workspaceId, eventId, subjects: [], resolutionEvidenceIds: [] },
      occurredAt: parseInstant('2026-08-17T00:01:00.000Z')
    })).toMatchObject({
      schemaVersion: 2,
      impacts: [],
      refreshAreas: ['sessions', 'schedule']
    });
  });

  test('carries only verified-inbox controlled observations beside a successful operation', () => {
    const contributor = createAirtableDirectFeatureContributor();
    const featureContext = {
      schemaVersion: 1,
      kind: 'airtable_controlled_inbound',
      observations: [{
        connectionId: '018f0f64-4d6c-7b2f-8a1e-1234567890b1',
        recordLinkId: '018f0f64-4d6c-7b2f-8a1e-1234567890b2',
        fieldKey: 'speaker.requested_status',
        kind: 'request',
        classification: 'personal',
        before: null,
        after: 'Cancelled',
        providerActorDisplayName: 'Dana',
        observedAtMs: 2_000
      }]
    } as const;
    expect(contributor.contribute({
      operation: { name: 'engagement.change', version: 1 },
      businessInput: { action: 'request_cancellation' },
      canonicalResult: { kind: 'success', data: { action: 'request_cancellation' } },
      scope: { workspaceId, eventId, subjects: [], resolutionEvidenceIds: [] },
      occurredAt: parseInstant('2026-08-17T00:01:00.000Z'),
      provenance: {
        kind: 'verified_inbox',
        inboxReceiptId: '018f0f64-4d6c-7b2f-8a1e-1234567890b3' as never
      },
      featureContext
    })).toMatchObject({
      schemaVersion: 2,
      impacts: [],
      inbound: {
        inboxReceiptId: '018f0f64-4d6c-7b2f-8a1e-1234567890b3',
        observations: [{ fieldKey: 'speaker.requested_status', after: 'Cancelled' }]
      }
    });
    expect(() => contributor.contribute({
      operation: { name: 'engagement.change', version: 1 },
      businessInput: {},
      canonicalResult: { kind: 'success', data: {} },
      scope: { workspaceId, eventId, subjects: [], resolutionEvidenceIds: [] },
      occurredAt: parseInstant('2026-08-17T00:01:00.000Z'),
      provenance: { kind: 'operator' },
      featureContext
    })).toThrow('untrusted');
  });
});
