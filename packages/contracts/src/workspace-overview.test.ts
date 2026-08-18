import { describe, expect, test } from 'bun:test';
import {
  WORKSPACE_OVERVIEW_AREAS,
  WORKSPACE_OVERVIEW_OPERATION_SCHEMA_REFS,
  workspaceOverviewProjectionSchema,
  workspaceOverviewTriageMetricSchema
} from './workspace-overview';

const unavailableAreas = WORKSPACE_OVERVIEW_AREAS.map((area) => area === 'overview'
  ? { area, status: 'available' as const, capabilities: ['workspace.overview.read'] }
  : { area, status: 'unavailable' as const, reason: 'not_implemented' as const });

describe('workspace overview contract', () => {
  test('accepts an honest no-Event projection without manufacturing zero metrics', () => {
    expect(workspaceOverviewProjectionSchema.parse({
      schemaVersion: 1,
      event: { schemaVersion: 1, kind: 'no_event', eventSetVersion: 1 },
      areas: unavailableAreas,
      metrics: {
        forms: { kind: 'unavailable', reason: 'event_required' },
        submissions: { kind: 'unavailable', reason: 'event_required' },
        programVocabulary: { kind: 'unavailable', reason: 'event_required' },
        operations: { kind: 'unavailable', reason: 'event_required' },
        triage: { kind: 'unavailable', reason: 'event_required' },
        reviews: { kind: 'unavailable', reason: 'event_required' },
        reviewers: { kind: 'unavailable', reason: 'event_required' },
        decisions: { kind: 'unavailable', reason: 'event_required' },
        engagements: { kind: 'unavailable', reason: 'event_required' },
        sessions: { kind: 'unavailable', reason: 'event_required' },
        communications: { kind: 'unavailable', reason: 'event_required' },
        templates: { kind: 'unavailable', reason: 'event_required' }
      },
      history: { total: 0, truncated: false, threads: [] }
    }).event.kind).toBe('no_event');
  });

  test('rejects incomplete or reordered area catalogs', () => {
    expect(() => workspaceOverviewProjectionSchema.parse({
      schemaVersion: 1,
      event: { schemaVersion: 1, kind: 'no_event', eventSetVersion: 1 },
      areas: unavailableAreas.slice().reverse(),
      metrics: {
        forms: { kind: 'unavailable', reason: 'event_required' },
        submissions: { kind: 'unavailable', reason: 'event_required' },
        programVocabulary: { kind: 'unavailable', reason: 'event_required' },
        operations: { kind: 'unavailable', reason: 'event_required' },
        triage: { kind: 'unavailable', reason: 'event_required' },
        reviews: { kind: 'unavailable', reason: 'event_required' },
        reviewers: { kind: 'unavailable', reason: 'event_required' },
        decisions: { kind: 'unavailable', reason: 'event_required' },
        engagements: { kind: 'unavailable', reason: 'event_required' },
        sessions: { kind: 'unavailable', reason: 'event_required' },
        communications: { kind: 'unavailable', reason: 'event_required' },
        templates: { kind: 'unavailable', reason: 'event_required' }
      },
      history: { total: 0, truncated: false, threads: [] }
    })).toThrow();
  });

  test('publishes stable disclosure-safe operation schema identities', () => {
    expect(WORKSPACE_OVERVIEW_OPERATION_SCHEMA_REFS.read.inputSchema.key)
      .toBe('schema.workspace.overview.read.input');
    expect(WORKSPACE_OVERVIEW_OPERATION_SCHEMA_REFS.read.resultSchema.key)
      .toBe('schema.workspace.overview.read.operator-result');
    expect(WORKSPACE_OVERVIEW_OPERATION_SCHEMA_REFS.read.inputSchema.digestSha256)
      .toMatch(/^[a-f0-9]{64}$/);
  });

  test('requires canonical projection bytes and compares history as instants', () => {
    const thread = (input: {
      id: string;
      receiptId: string;
      occurredAt: string;
      actors?: string[];
      domain?: 'event' | 'field_registry' | 'submission_triage';
    }) => ({
      id: input.id,
      domain: input.domain ?? 'event',
      root: { kind: 'operation', receiptId: input.receiptId },
      firstOccurredAt: input.occurredAt,
      lastOccurredAt: input.occurredAt,
      actors: input.actors ?? ['person'],
      surfaces: ['operator_http'],
      latestOperation: { name: 'event.create', version: 1 },
      latestReceipt: {
        id: input.receiptId,
        operationName: 'event.create',
        operationVersion: 1
      },
      latestOutcome: { kind: 'success' },
      evidence: { timelineEntries: 1, receipts: 1 }
    });
    const laterId = '018f7d5a-4b3c-7abc-8def-0123456789a2';
    const earlierId = '018f7d5a-4b3c-7abc-8def-0123456789a1';
    const base = {
      schemaVersion: 1,
      event: { schemaVersion: 1, kind: 'no_event', eventSetVersion: 1 },
      areas: unavailableAreas,
      metrics: {
        forms: { kind: 'unavailable', reason: 'event_required' },
        submissions: { kind: 'unavailable', reason: 'event_required' },
        programVocabulary: { kind: 'unavailable', reason: 'event_required' },
        operations: { kind: 'unavailable', reason: 'event_required' },
        triage: { kind: 'unavailable', reason: 'event_required' },
        reviews: { kind: 'unavailable', reason: 'event_required' },
        reviewers: { kind: 'unavailable', reason: 'event_required' },
        decisions: { kind: 'unavailable', reason: 'event_required' },
        engagements: { kind: 'unavailable', reason: 'event_required' },
        sessions: { kind: 'unavailable', reason: 'event_required' },
        communications: { kind: 'unavailable', reason: 'event_required' },
        templates: { kind: 'unavailable', reason: 'event_required' }
      }
    } as const;
    expect(workspaceOverviewProjectionSchema.safeParse({
      ...base,
      history: {
        total: 2,
        truncated: false,
        threads: [
          thread({
            id: `operation:${earlierId}`,
            receiptId: earlierId,
            occurredAt: '2026-08-13T08:00:00.000+08:00'
          }),
          thread({
            id: `operation:${laterId}`,
            receiptId: laterId,
            occurredAt: '2026-08-13T00:00:00.000Z'
          })
        ]
      }
    }).success).toBe(true);
    expect(workspaceOverviewProjectionSchema.safeParse({
      ...base,
      history: {
        total: 1,
        truncated: false,
        threads: [thread({
          id: `operation:${earlierId}`,
          receiptId: earlierId,
          occurredAt: '2026-08-13T00:00:00.000Z',
          actors: ['agent', 'person']
        })]
      }
    }).success).toBe(false);
    expect(workspaceOverviewProjectionSchema.safeParse({
      ...base,
      history: {
        total: 2,
        truncated: false,
        threads: [
          thread({
            id: `operation:${laterId}`,
            receiptId: laterId,
            occurredAt: '2026-08-13T01:00:00.000Z',
            domain: 'submission_triage'
          }),
          thread({
            id: `operation:${earlierId}`,
            receiptId: earlierId,
            occurredAt: '2026-08-13T00:00:00.000Z',
            domain: 'field_registry'
          })
        ]
      }
    }).success).toBe(true);
  });

  test('rejects impossible subset counts in the added exact metrics', () => {
    const exactMetrics = {
      forms: { kind: 'exact', total: 0, draft: 0, open: 0, closed: 0 },
      submissions: { kind: 'exact', total: 0 },
      programVocabulary: {
        kind: 'exact',
        rooms: { total: 0, active: 0, retired: 0 },
        tracks: { total: 0, active: 0, retired: 0 },
        formats: { total: 0, active: 0, retired: 0 }
      },
      operations: { kind: 'exact', total: 0 },
      triage: { kind: 'exact', arrived: 1, sorted: 2 },
      reviews: { kind: 'exact', rounds: 1, assignments: 1, committed: 2 },
      reviewers: { kind: 'exact', total: 0 },
      decisions: { kind: 'exact', decided: 0, undecided: 0 },
      engagements: { kind: 'exact', total: 1, confirmed: 2 },
      sessions: { kind: 'exact', total: 1, placed: 2 },
      communications: { kind: 'exact', recipients: 1, sent: 2 },
      templates: { kind: 'exact', total: 0 }
    } as const;
    const candidate = {
      schemaVersion: 1,
      event: { schemaVersion: 1, kind: 'no_event', eventSetVersion: 1 },
      areas: unavailableAreas,
      metrics: exactMetrics,
      history: { total: 0, truncated: false, threads: [] }
    };
    expect(workspaceOverviewProjectionSchema.safeParse(candidate).success).toBe(false);
  });

  test('rejects a sorted triage subset larger than immutable arrivals', () => {
    expect(workspaceOverviewTriageMetricSchema.safeParse({
      kind: 'exact', arrived: 1, sorted: 2
    }).success).toBe(false);
    expect(workspaceOverviewTriageMetricSchema.parse({
      kind: 'exact', arrived: 2, sorted: 2
    })).toEqual({ kind: 'exact', arrived: 2, sorted: 2 });
    expect(workspaceOverviewTriageMetricSchema.parse({
      kind: 'unavailable', reason: 'dependency_unavailable'
    })).toEqual({ kind: 'unavailable', reason: 'dependency_unavailable' });
  });
});
