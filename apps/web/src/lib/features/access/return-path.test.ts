import { expect, test } from 'bun:test';
import { safeOperatorReturnPath } from './return-path';

test('accepts only normalized operator return paths', () => {
  expect(safeOperatorReturnPath('/app')).toBe('/app');
  expect(safeOperatorReturnPath('/app/events?day=2')).toBe('/app/events?day=2');
  for (const unsafe of ['https://evil.example/app', '//evil.example/app', '/api/users', '/sign-in', '/embed/app', '/app\\evil', '/app/%2e%2e/api', '/app/../api']) {
    expect(safeOperatorReturnPath(unsafe)).toBe('/app');
  }
});
