import { expect, test } from 'bun:test';
import {
  OPERATION_SURFACES,
  createPayloadRef,
  isOperationSurface,
  parseEventId,
  parsePayloadRefId,
  parseWorkspaceId,
  type ResolvedScope
} from './index';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('01890f47-9abc-7def-8123-456789abcdef');

test('operation surfaces are a closed runtime vocabulary', () => {
  expect(OPERATION_SURFACES).toEqual([
    'operator_http',
    'participant_http',
    'public_http',
    'external_mcp',
    'app_model',
    'application_job',
    'provider_ingress'
  ]);
  expect(OPERATION_SURFACES.every(isOperationSurface)).toBe(true);
  expect(isOperationSurface('admin')).toBe(false);
});

test('resolved scopes retain workspace, event, and typed subject identity', () => {
  const scope: ResolvedScope = {
    workspaceId,
    eventId,
    subjects: [
      { kind: 'workspace', id: workspaceId },
      { kind: 'event', id: eventId }
    ],
    resolutionEvidenceIds: ['event-workspace-relation:v1']
  };

  expect(scope.subjects.map((subject) => subject.kind)).toEqual(['workspace', 'event']);
});

test('classified payload references expose only their opaque application ID', () => {
  const id = parsePayloadRefId('01890f47-9abc-7def-8123-456789abcdef');
  const ref = createPayloadRef(id);

  expect(ref).toEqual({ id });
  expect(Object.keys(ref)).toEqual(['id']);
  expect(Object.isFrozen(ref)).toBe(true);
});
