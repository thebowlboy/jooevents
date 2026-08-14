import { describe, expect, test } from 'bun:test';
import {
  PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS,
  portalEngagementRespondInputSchema,
  portalSnapshotReadInputSchema
} from './participant-portal-operations';

const ENGAGEMENT_ID = '88888888-1111-4111-8111-111111111111';

describe('participant portal operation wire contracts', () => {
  test('the snapshot read takes exactly nothing', () => {
    expect(portalSnapshotReadInputSchema.safeParse({}).success).toBe(true);
    expect(portalSnapshotReadInputSchema.safeParse({ personId: ENGAGEMENT_ID }).success).toBe(false);
  });

  test('the respond input admits exactly one engagement id and one response', () => {
    const parsed = portalEngagementRespondInputSchema.parse({
      engagementId: ENGAGEMENT_ID.toUpperCase(),
      response: 'confirm'
    });
    expect(parsed).toEqual({ engagementId: ENGAGEMENT_ID, response: 'confirm' });
    expect(portalEngagementRespondInputSchema.safeParse({
      engagementId: ENGAGEMENT_ID, response: 'decline'
    }).success).toBe(true);
    expect(portalEngagementRespondInputSchema.safeParse({
      engagementId: 'not-a-uuid', response: 'confirm'
    }).success).toBe(false);
    expect(portalEngagementRespondInputSchema.safeParse({
      engagementId: ENGAGEMENT_ID, response: 'maybe'
    }).success).toBe(false);
  });

  test('attribution, person, version, and actor claims are structurally unrepresentable', () => {
    for (const forged of [
      { attribution: 'self' },
      { attribution: 'co_speaker' },
      { attribution: 'organizer_recorded' },
      { confirmingPersonId: ENGAGEMENT_ID },
      { personId: ENGAGEMENT_ID },
      { actorUserId: ENGAGEMENT_ID },
      { expectedEngagementVersion: 1 },
      { actor: 'participant' },
      { scope: { workspaceId: ENGAGEMENT_ID, eventId: ENGAGEMENT_ID } }
    ]) {
      expect(portalEngagementRespondInputSchema.safeParse({
        engagementId: ENGAGEMENT_ID, response: 'confirm', ...forged
      }).success).toBe(false);
    }
  });

  test('the manifest refs pin both operations’ input and result schema identities', () => {
    const refs = PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS;
    expect(refs.snapshotRead.inputSchema.key).toBe('schema.portal.snapshot-read.input');
    expect(refs.snapshotRead.resultSchema.key).toBe('schema.portal.snapshot-read.participant-result');
    expect(refs.engagementRespond.inputSchema.key).toBe('schema.portal.engagement-respond.input');
    expect(refs.engagementRespond.resultSchema.key)
      .toBe('schema.portal.engagement-respond.participant-result');
    for (const ref of [
      refs.snapshotRead.inputSchema, refs.snapshotRead.resultSchema,
      refs.engagementRespond.inputSchema, refs.engagementRespond.resultSchema
    ]) {
      expect(ref.digestSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
