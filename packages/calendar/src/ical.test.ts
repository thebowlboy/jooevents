import { describe, expect, test } from 'bun:test';
import { icalGoldenInputs } from './ical.fixtures';
import { renderIcalendar, renderIcalendarBatch } from './ical';

const goldenUrl = new URL('./__fixtures__/ical-goldens.json', import.meta.url);

async function goldenBytes(name: string): Promise<Uint8Array> {
  const fixtures = await Bun.file(goldenUrl).json() as Record<string, string>;
  const encoded = fixtures[name];
  if (!encoded) throw new TypeError(`missing_ical_golden:${name}`);
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

describe('deterministic iCalendar/iTIP renderer', () => {
  for (const name of ['request', 'update', 'cancel', 'date'] as const) {
    test(`${name} is byte-identical to its golden fixture`, async () => {
      const rendered = renderIcalendar(icalGoldenInputs[name]!);
      expect(rendered).toEqual(await goldenBytes(name));
      expect(renderIcalendar(icalGoldenInputs[name]!)).toEqual(rendered);
      const text = new TextDecoder().decode(rendered);
      expect(text.endsWith('\r\n')).toBe(true);
      expect(text.replaceAll('\r\n', '')).not.toContain('\n');
      for (const line of text.slice(0, -2).split('\r\n')) {
        expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(75);
      }
    });
  }

  test('update and cancel preserve UID while sequence increases monotonically', () => {
    const request = new TextDecoder().decode(renderIcalendar(icalGoldenInputs.request!));
    const update = new TextDecoder().decode(renderIcalendar(icalGoldenInputs.update!));
    const cancel = new TextDecoder().decode(renderIcalendar(icalGoldenInputs.cancel!));
    for (const text of [request, update, cancel]) {
      expect(text).toContain('UID:commitment-42@calendar.jooevents\r\n');
    }
    expect(request).toContain('SEQUENCE:0\r\n');
    expect(update).toContain('SEQUENCE:2\r\n');
    expect(cancel).toContain('SEQUENCE:3\r\n');
    expect(cancel).toContain('METHOD:CANCEL\r\n');
    expect(cancel).toContain('STATUS:CANCELLED\r\n');
  });

  test('timed events embed VTIMEZONE while date-only events use VALUE=DATE', () => {
    const timed = new TextDecoder().decode(renderIcalendar(icalGoldenInputs.request!));
    const date = new TextDecoder().decode(renderIcalendar(icalGoldenInputs.date!));
    expect(timed).toContain('BEGIN:VTIMEZONE\r\n');
    expect(timed).toContain('DTSTART;TZID="America/New_York":20260901T100000\r\n');
    expect(date).not.toContain('VTIMEZONE');
    expect(date).toContain('DTSTART;VALUE=DATE:20261012\r\n');
    expect(date).toContain('DTEND;VALUE=DATE:20261013\r\n');
  });

  test('folding counts UTF-8 octets and escaping preserves text meaning', () => {
    const text = new TextDecoder().decode(renderIcalendar(icalGoldenInputs.request!));
    expect(text).toContain('DESCRIPTION:Bring questions\\, examples\\; and notes.\\nSecond line proves esc\r\n aping.');
    expect(text).toContain('\r\n ');
    expect(text).toContain('LOCATION:Hall A\\, Level 2\r\n');
  });

  test('a batch is one method partition with deterministic ordered VEVENT bytes', () => {
    const first = icalGoldenInputs.request!;
    const second = { ...first, uid: 'commitment-43@calendar.jooevents', sequence: 1 };
    const rendered = renderIcalendarBatch({ method: 'REQUEST', events: [first, second] });
    const text = new TextDecoder().decode(rendered);
    expect(text.match(/BEGIN:VCALENDAR/gu)).toHaveLength(1);
    expect(text.match(/BEGIN:VTIMEZONE/gu)).toHaveLength(1);
    expect(text.match(/BEGIN:VEVENT/gu)).toHaveLength(2);
    expect(text.indexOf('UID:commitment-42')).toBeLessThan(text.indexOf('UID:commitment-43'));
    expect(renderIcalendarBatch({ method: 'REQUEST', events: [first, second] })).toEqual(rendered);
    expect(() => renderIcalendarBatch({
      method: 'CANCEL', events: [first]
    })).toThrow('calendar_ical_method_partition_invalid');
  });
});
