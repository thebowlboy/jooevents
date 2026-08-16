import { describe, expect, test } from 'bun:test';
import {
  operationHistoryEntrySchema,
  operationHistoryListInputSchema,
  operationHistoryPageSchema
} from './operation-history';

const workspaceId = '019c42aa-0000-7000-8000-000000000001';
const eventId = '019c42aa-0000-7000-8000-000000000002';
const userId = '019c42aa-0000-7000-8000-000000000003';
const entry = {
  id: '019c42aa-0000-7000-8000-000000000004',
  operation: { name: 'event.settings.update', version: 1 },
  scope: { workspaceId, eventId },
  surface: 'operator_http',
  actor: { kind: 'workspace_user', userId },
  subjects: [
    { kind: 'workspace', id: workspaceId },
    { kind: 'event', id: eventId }
  ],
  summary: 'Updated event settings',
  occurredAt: '2026-08-16T10:00:00.000Z',
  correlationId: '019c42aa-0000-7000-8000-000000000005',
  resultKind: 'success'
} as const;

describe('operation history contracts', () => {
  test('keeps safe summary, typed actor, typed subjects, and exact scope', () => {
    expect(JSON.parse(JSON.stringify(operationHistoryEntrySchema.parse(entry)))).toEqual(entry);
    expect(operationHistoryEntrySchema.safeParse({ ...entry, actor: { kind: 'workspace_user' } }).success)
      .toBe(false);
    expect(operationHistoryEntrySchema.safeParse({ ...entry, secret: 'not allowed' }).success)
      .toBe(false);
  });

  test('requires complete pagination cursors and bounds pages', () => {
    expect(operationHistoryListInputSchema.parse({ view: 'workspace' }))
      .toEqual({ view: 'workspace', limit: 50 });
    expect(operationHistoryListInputSchema.safeParse({
      view: 'event', beforeOccurredAt: entry.occurredAt
    }).success).toBe(false);
    expect(operationHistoryPageSchema.safeParse({
      schemaVersion: 1, scope: 'event', entries: [entry],
      next: { occurredAt: entry.occurredAt, id: entry.id }
    }).success).toBe(true);
  });
});
