import { describe, expect, test } from 'bun:test';
import { buildIcalendarTimezoneDefinition } from './timezone';

describe('calendar timezone definition', () => {
  test('is deterministic and includes both New York seasonal transitions', () => {
    const input = {
      timeZone: 'America/New_York',
      startAt: '2026-09-01T14:00:00.000Z',
      endAt: '2026-09-01T15:00:00.000Z'
    };
    const definition = buildIcalendarTimezoneDefinition(input);
    expect(buildIcalendarTimezoneDefinition(input)).toEqual(definition);
    expect(definition.tzid).toBe('America/New_York');
    expect(definition.observances.some((item) => item.kind === 'DAYLIGHT'
      && item.offsetFrom === '-0500' && item.offsetTo === '-0400')).toBe(true);
    expect(definition.observances.some((item) => item.kind === 'STANDARD'
      && item.offsetFrom === '-0400' && item.offsetTo === '-0500')).toBe(true);
  });

  test('represents a fixed-offset UTC zone without a clock read', () => {
    expect(buildIcalendarTimezoneDefinition({
      timeZone: 'UTC',
      startAt: '2026-09-01T14:00:00.000Z',
      endAt: '2026-09-01T15:00:00.000Z'
    })).toMatchObject({
      tzid: 'UTC', observances: [{ kind: 'STANDARD', offsetFrom: '+0000', offsetTo: '+0000' }]
    });
  });
});
