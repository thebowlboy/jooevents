import { describe, expect, test } from 'bun:test';
import {
  SUBMISSION_TRIAGE_BULK_MAX,
  submissionArrivalFactSchema,
  submissionTriageHeadSchema,
  submissionTriageProjectionSchema,
  submissionTriageTransitionInputSchema
} from './submission-triage';

const workspaceId = '018f0000-0000-7000-8000-000000000001';
const eventId = '018f0000-0000-7000-8000-000000000002';
const submissionId = '018f0000-0000-7000-8000-000000000003';
const formId = '018f0000-0000-7000-8000-000000000004';
const formVersionId = '018f0000-0000-7000-8000-000000000005';
const arrivalId = '018f0000-0000-7000-8000-000000000006';
const fieldId = '018f0000-0000-7000-8000-000000000007';
const invocationId = '018f0000-0000-7000-8000-000000000008';
const digest = 'a'.repeat(64);
const scope = { workspaceId, eventId } as const;

function arrival(classification: 'on_time' | 'late') {
  return {
    schemaVersion: 1,
    id: arrivalId,
    scope,
    submissionId,
    formId,
    formVersionId,
    source: 'public_form',
    submittedAt: '2026-08-13T10:01:00.000Z',
    classification,
    closeEvidence: classification === 'late'
      ? {
          closeAt: '2026-08-13T10:00:00.000Z',
          policy: {
            reference: { key: 'intake.soft_close', version: 1 },
            definitionDigestSha256: digest
          }
        }
      : null,
    recordedAt: '2026-08-13T10:01:00.000Z'
  } as const;
}

function head(state: 'inbox' | 'set_aside' | 'spam') {
  return {
    schemaVersion: 1,
    scope,
    submissionId,
    version: 1,
    state,
    setAsideAttribution: state === 'set_aside'
      ? { kind: 'manual', principalKey: 'operator:1', invocationId, surface: 'operator_http' }
      : null,
    updatedAt: '2026-08-13T10:02:00.000Z'
  } as const;
}

function source() {
  return {
    schemaVersion: 1,
    scope,
    source: 'public_form',
    summary: {
      schemaVersion: 1,
      id: submissionId,
      formId,
      formVersionId,
      target: { kind: 'general_pool' },
      title: 'A durable proposal',
      primaryParticipantName: 'Avery',
      submittedAt: '2026-08-13T10:01:00.000Z'
    },
    detail: {
      schemaVersion: 1,
      submissionId,
      formId,
      formVersionId,
      submittedAt: '2026-08-13T10:01:00.000Z',
      participantCount: 1,
      answers: [{ kind: 'text', fieldId, fieldLabel: 'Session title', value: 'A durable proposal' }],
      affirmedConsentFieldIds: []
    },
    abstract: null,
    track: null,
    format: null
  } as const;
}

describe('submission triage contracts', () => {
  test('late is immutable arrival evidence rather than a mutable triage state', () => {
    expect(submissionArrivalFactSchema.parse(arrival('late')).classification).toBe('late');
    expect(submissionTriageHeadSchema.safeParse({ ...head('inbox'), state: 'late' }).success).toBe(false);
  });

  test('visible tray precedence keeps late orthogonal to set-aside and spam', () => {
    expect(submissionTriageProjectionSchema.parse({
      schemaVersion: 1,
      source: source(),
      triage: head('inbox'),
      arrival: arrival('late'),
      visibleTray: 'late'
    }).visibleTray).toBe('late');

    expect(submissionTriageProjectionSchema.parse({
      schemaVersion: 1,
      source: source(),
      triage: head('set_aside'),
      arrival: arrival('late'),
      visibleTray: 'set_aside'
    }).visibleTray).toBe('set_aside');

    expect(submissionTriageProjectionSchema.parse({
      schemaVersion: 1,
      source: source(),
      triage: head('spam'),
      arrival: arrival('late'),
      visibleTray: 'spam'
    }).visibleTray).toBe('spam');
  });

  test('late evidence requires and agrees with its close fact', () => {
    expect(submissionArrivalFactSchema.safeParse({
      ...arrival('late'),
      closeEvidence: null
    }).success).toBe(false);
    expect(submissionArrivalFactSchema.safeParse({
      ...arrival('late'),
      submittedAt: '2026-08-13T09:59:00.000Z'
    }).success).toBe(false);
  });

  test('source provenance is cross-bound into the immutable arrival fact', () => {
    expect(submissionTriageProjectionSchema.safeParse({
      schemaVersion: 1,
      source: { ...source(), source: 'import' },
      triage: head('inbox'),
      arrival: arrival('late'),
      visibleTray: 'late'
    }).success).toBe(false);
  });

  test('set-aside attribution is present exactly for the set-aside head', () => {
    expect(submissionTriageHeadSchema.safeParse(head('set_aside')).success).toBe(true);
    expect(submissionTriageHeadSchema.safeParse({
      ...head('inbox'),
      setAsideAttribution: head('set_aside').setAsideAttribution
    }).success).toBe(false);
  });

  test('bulk selections are bounded, canonical, unique, and version-paired', () => {
    const input = {
      action: 'set_aside',
      submissionIds: [submissionId],
      expectedHeads: [{ submissionId, version: 1 }],
      expectedQueryGuard: { version: 1, digestSha256: digest }
    } as const;
    expect(submissionTriageTransitionInputSchema.parse(input).submissionIds).toEqual([submissionId]);
    expect(submissionTriageTransitionInputSchema.safeParse({
      ...input,
      submissionIds: [submissionId, submissionId],
      expectedHeads: [
        { submissionId, version: 1 },
        { submissionId, version: 1 }
      ]
    }).success).toBe(false);

    const tooMany = Array.from({ length: SUBMISSION_TRIAGE_BULK_MAX + 1 }, (_, index) =>
      `018f0000-0000-7000-8000-${(index + 100).toString().padStart(12, '0')}`
    );
    expect(submissionTriageTransitionInputSchema.safeParse({
      ...input,
      submissionIds: tooMany,
      expectedHeads: tooMany.map((id) => ({ submissionId: id, version: 1 }))
    }).success).toBe(false);
  });
});
