import { expect, test } from 'bun:test';
import { safeParticipantReturnPath } from './return-path';

test('accepts only normalized participant return paths', () => {
  expect(safeParticipantReturnPath('/portal')).toBe('/portal');
  expect(safeParticipantReturnPath('/portal/submissions/sub_1')).toBe('/portal/submissions/sub_1');
  expect(safeParticipantReturnPath('/portal/submissions?open=1')).toBe('/portal/submissions?open=1');
  for (const unsafe of [
    'https://evil.example/portal',
    '//evil.example/portal',
    '/app',
    '/app/submissions',
    '/api/portal',
    '/embed/portal',
    '/portal\\evil',
    '/portal/%2e%2e/api',
    '/portal/../api',
    '/portal/sign-in',
    '/portal/auth/complete'
  ]) {
    expect(safeParticipantReturnPath(unsafe)).toBe('/portal');
  }
});
