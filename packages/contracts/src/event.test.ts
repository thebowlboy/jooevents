import { describe, expect, test } from 'bun:test';
import {
  currentEventProjectionSchema,
  eventCreateDraftInputSchema,
  eventCreateDraftOperationResultSchema,
  eventCreateInputSchema,
  eventCreateOperationResultSchema,
  eventCreationCompensationEligibilitySchema,
  eventSchema
} from './event';

const eventId = '018f7d5a-4b3c-7abc-8def-0123456789a2';
const correlationId = '018f0f47-7a86-7d36-8a25-9f86589c7a4d';
const receiptId = '018f0f47-7a86-7d36-8a25-9f86589c7a4e';

const event = {
  id: eventId,
  name: 'JooConf 2027',
  timezone: 'Asia/Singapore',
  startDate: '2027-04-16',
  endDate: '2027-04-18',
  version: 1
} as const;

describe('Event wire contracts', () => {
  test('accept canonical Event values and reject impossible dates or ranges', () => {
    expect(eventSchema.safeParse(event).success).toBe(true);
    expect(eventSchema.safeParse({ ...event, startDate: '2027-02-29' }).success).toBe(false);
    expect(eventSchema.safeParse({ ...event, endDate: '2027-04-15' }).success).toBe(false);
    expect(eventSchema.safeParse({ ...event, timezone: 'Not/A_Zone' }).success).toBe(false);
    expect(eventSchema.safeParse({ ...event, name: '  JooConf 2027  ' }).success).toBe(false);
  });

  test('create input contains no trusted workspace, Event identity, or attribution', () => {
    const input = {
      expectedEventSetVersion: 1,
      name: 'JooConf 2027',
      timezone: 'Asia/Singapore',
      startDate: '2027-04-16',
      endDate: '2027-04-18'
    };
    expect(eventCreateInputSchema.safeParse(input).success).toBe(true);
    expect(eventCreateInputSchema.safeParse({ ...input, workspaceId: eventId }).success).toBe(false);
    expect(eventCreateInputSchema.safeParse({ ...input, eventId }).success).toBe(false);
    expect(eventCreateInputSchema.safeParse({ ...input, createdByUserId: eventId }).success).toBe(false);
    expect(eventCreateInputSchema.safeParse({ ...input, expectedEventSetVersion: 0 }).success).toBe(false);
    expect(eventCreateInputSchema.safeParse({ ...input, timezone: 'GMT' }).success).toBe(false);
    expect(eventCreateInputSchema.safeParse({ ...input, timezone: 'UTC' }).success).toBe(true);
  });

  test('distinguishes a live empty scope from a current Event', () => {
    expect(currentEventProjectionSchema.parse({
      schemaVersion: 1,
      kind: 'no_event',
      eventSetVersion: 1
    }).kind).toBe('no_event');
    expect(currentEventProjectionSchema.parse({
      schemaVersion: 1,
      kind: 'current_event',
      eventSetVersion: 2,
      event
    }).kind).toBe('current_event');
    expect(currentEventProjectionSchema.safeParse({
      schemaVersion: 1,
      kind: 'no_event',
      eventSetVersion: 1,
      event: null
    }).success).toBe(false);
  });

  test('requires durable receipt evidence on a terminal create result', () => {
    const receipt = { id: receiptId, operationName: 'event.create', operationVersion: 1 };
    expect(eventCreateOperationResultSchema.safeParse({
      kind: 'success',
      data: { eventSetVersion: 2, event },
      receipt,
      correlationId
    }).success).toBe(true);
    expect(eventCreateOperationResultSchema.safeParse({
      kind: 'success',
      data: { eventSetVersion: 2, event },
      correlationId
    }).success).toBe(false);
  });

  test('keeps first-Event drafting scope-free and returns an inert exact diff', () => {
    const input = {
      name: 'JooConf 2027',
      timezone: 'Asia/Singapore',
      startDate: '2027-04-16',
      endDate: '2027-04-18'
    };
    expect(eventCreateDraftInputSchema.safeParse(input).success).toBe(true);
    expect(eventCreateDraftInputSchema.safeParse({
      ...input,
      expectedEventSetVersion: 1
    }).success).toBe(false);
    expect(eventCreateDraftInputSchema.safeParse({ ...input, workspaceId: eventId }).success)
      .toBe(false);

    expect(eventCreateDraftOperationResultSchema.safeParse({
      kind: 'success',
      data: {
        action: 'create',
        changesetId: '018f0f47-7a86-7d36-8a25-9f86589c7a4a',
        headVersion: 1,
        revision: {
          id: '018f0f47-7a86-7d36-8a25-9f86589c7a4b',
          number: 1,
          digestSha256: 'a'.repeat(64)
        },
        safeDiff: {
          action: 'create',
          before: null,
          after: event,
          currentSelection: { before: null, after: eventId },
          eventSetVersion: { before: 1, after: 2 }
        }
      },
      receipt: { id: receiptId, operationName: 'event.create.draft', operationVersion: 1 },
      correlationId
    }).success).toBe(true);
  });

  test('keeps creation correction outcomes closed', () => {
    expect(eventCreationCompensationEligibilitySchema.safeParse({
      kind: 'exact', eventId, dependencyCount: 0
    }).success).toBe(true);
    expect(eventCreationCompensationEligibilitySchema.safeParse({
      kind: 'blocked', eventId, reason: 'dependencies_present', dependencyCount: 3
    }).success).toBe(true);
    expect(eventCreationCompensationEligibilitySchema.safeParse({
      kind: 'partial', eventId
    }).success).toBe(false);
  });
});
