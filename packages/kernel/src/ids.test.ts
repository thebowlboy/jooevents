import { expect, test } from 'bun:test';
import {
  isApplicationId,
  parseEventId,
  parsePayloadRefId,
  parseUserId,
  parseWorkspaceId,
  type EventId,
  type WorkspaceId
} from './ids';

const uuidV4 = '550e8400-e29b-41d4-a716-446655440000';
const uuidV7 = '01890f47-9abc-7def-8123-456789abcdef';

test('application IDs accept existing UUIDv4 and normalized UUIDv7 values', () => {
  expect(String(parseWorkspaceId(uuidV4))).toBe(uuidV4);
  expect(String(parseUserId(uuidV7.toUpperCase()))).toBe(uuidV7);
  expect(String(parsePayloadRefId(uuidV7))).toBe(uuidV7);
  expect(isApplicationId(uuidV4)).toBe(true);
  expect(isApplicationId(uuidV7)).toBe(true);
  expect(isApplicationId(uuidV7.toUpperCase())).toBe(false);
});

test('application IDs reject non-application identifiers and unsupported UUID versions', () => {
  for (const value of [
    'workspace_summit',
    ` ${uuidV7}`,
    '550e8400-e29b-11d4-a716-446655440000',
    '550e8400-e29b-51d4-a716-446655440000',
    '550e8400-e29b-41d4-7716-446655440000'
  ]) {
    expect(() => parseWorkspaceId(value)).toThrow();
    expect(isApplicationId(value)).toBe(false);
  }
});

test('brands keep application ID kinds distinct at compile time', () => {
  const useWorkspace = (id: WorkspaceId) => id;
  const workspaceId = parseWorkspaceId(uuidV4);
  const eventId = parseEventId(uuidV7);

  expect(String(useWorkspace(workspaceId))).toBe(uuidV4);
  // @ts-expect-error Event IDs cannot enter workspace-ID APIs.
  const invalid: WorkspaceId = eventId;
  expect(String(invalid)).toBe(uuidV7);

  const acceptsEvent = (id: EventId) => id;
  expect(String(acceptsEvent(eventId))).toBe(uuidV7);
});
