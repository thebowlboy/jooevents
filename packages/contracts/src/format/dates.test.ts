import { describe, expect, test } from 'bun:test';
import {
  DATE_CLASS,
  DEFAULT_DUE_SOON_HOURS,
  NO_DATE,
  NO_TIME,
  deadlineState,
  deadlineStateDescriptor,
  describeCalendarDeadline,
  describeDeadline,
  describeRecency,
  describeZoneMarker,
  formatClock,
  formatClockRange,
  formatDate,
  formatDateRange,
  formatInstant,
  formatInstantDate,
  formatRelative,
  formatZoneLabel,
  parseCalendarDate,
  parseClockMinutes,
  parseZonedInstant,
  type DeadlineState
} from './dates';

/**
 * Expectations are written with ordinary spaces and compared against the real
 * bytes with the non-breaking spaces put back, so a reader can see the shape
 * being asserted and the assertion still proves the span cannot wrap.
 */
function span(value: string): string {
  // Both no-break characters the vocabulary uses: NBSP between words, and the
  // word joiners binding a day span to its dash. Writing them literally in
  // every expectation would make the assertions unreadable.
  return value
    .replace(/ /gu, '\u00a0')
    .replace(/(\d)\u2013(\d)/gu, '$1\u2060\u2013\u2060$2');
}

const NBSP = ' ';
const EN_DASH = '–';

describe('parsing degrades honestly', () => {
  const rejected: readonly [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['number', 20270820],
    ['american order', '08/20/2027'],
    ['unpadded', '2027-8-20'],
    ['day 32', '2027-08-32'],
    ['month 13', '2027-13-01'],
    ['february 30th', '2027-02-30'],
    ['non-leap february 29th', '2027-02-29'],
    ['two-digit year rolled to 1900', '0099-01-01'],
    ['instant, not a date', '2027-08-20T00:00:00.000Z']
  ];

  for (const [name, value] of rejected) {
    test(`parseCalendarDate rejects ${name}`, () => {
      expect(parseCalendarDate(value)).toBeNull();
    });
  }

  test('parseCalendarDate accepts a real leap day', () => {
    expect(parseCalendarDate('2028-02-29')).toEqual({
      year: 2028,
      month: 2,
      day: 29,
      weekday: 2
    });
  });

  test('parseClockMinutes reads the boundaries and rejects the rest', () => {
    expect(parseClockMinutes('00:00')).toBe(0);
    expect(parseClockMinutes('09:30')).toBe(570);
    expect(parseClockMinutes('24:00')).toBe(1440);
    expect(parseClockMinutes('24:01')).toBeNull();
    expect(parseClockMinutes('25:00')).toBeNull();
    expect(parseClockMinutes('09:60')).toBeNull();
    expect(parseClockMinutes('9:3')).toBeNull();
    expect(parseClockMinutes(570)).toBeNull();
  });

  test('parseZonedInstant refuses the loose values Date.parse would accept', () => {
    expect(parseZonedInstant('2027', 'UTC')).toBeNull();
    expect(parseZonedInstant('Aug 20 2027', 'UTC')).toBeNull();
    expect(parseZonedInstant('2027-08-20', 'UTC')).toBeNull();
    expect(parseZonedInstant('2027-08-20T09:30:00.000Z', 'Not/AZone')).toBeNull();
    expect(parseZonedInstant('2027-08-20T09:30:00.000Z', '')).toBeNull();
    expect(parseZonedInstant('2027-08-20T09:30:00.000Z', null)).toBeNull();
  });

  test('parseZonedInstant resolves an instant into the named zone', () => {
    const parts = parseZonedInstant('2027-08-20T09:30:00.000Z', 'America/New_York');
    expect(parts).not.toBeNull();
    expect(parts?.year).toBe(2027);
    expect(parts?.month).toBe(8);
    expect(parts?.day).toBe(20);
    expect(parts?.hour).toBe(5);
    expect(parts?.minute).toBe(30);
    expect(parts?.weekday).toBe(5);
    expect(parts?.zoneName).toBe('EDT');
    expect(parts?.machine).toBe('2027-08-20T09:30:00.000Z');
  });

  test('an instant without milliseconds or with an offset still canonicalises', () => {
    expect(parseZonedInstant('2027-08-20T09:30Z', 'UTC')?.machine).toBe('2027-08-20T09:30:00.000Z');
    expect(parseZonedInstant('2027-08-20T09:30:00Z', 'UTC')?.machine).toBe(
      '2027-08-20T09:30:00.000Z'
    );
    expect(parseZonedInstant('2027-08-20T11:30:00+02:00', 'UTC')?.machine).toBe(
      '2027-08-20T09:30:00.000Z'
    );
  });
});
describe('formatDate — day first, abbreviated month, no machine punctuation', () => {
  const cases: readonly [string, string, string][] = [
    ['ordinary day', '2027-08-20', '20 Aug 2027'],
    ['first of a month', '2027-01-01', '1 Jan 2027'],
    ['no zero padding on the day', '2027-09-05', '5 Sep 2027'],
    ['leap day', '2028-02-29', '29 Feb 2028'],
    ['last day of a year', '2026-12-31', '31 Dec 2026']
  ];

  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(formatDate(input)).toBe(span(expected));
    });
  }

  test('weekday is a variant, never the default', () => {
    expect(formatDate('2027-08-20')).toBe(span('20 Aug 2027'));
    expect(formatDate('2027-08-20', { weekday: true })).toBe(span('Fri 20 Aug 2027'));
    expect(formatDate('2028-02-29', { weekday: true })).toBe(span('Tue 29 Feb 2028'));
  });

  test('the year drops only where the surface already fixes it', () => {
    // A schedule day tab inside one event: every tab would repeat the year.
    expect(formatDate('2027-03-18', { weekday: true, year: false })).toBe(span('Thu 18 Mar'));
    expect(formatDate('2027-03-18', { year: false })).toBe(span('18 Mar'));
    expect(formatDate('2027-03-18')).toBe(span('18 Mar 2027'));
  });

  test('a date never breaks across two lines', () => {
    expect(formatDate('2027-08-20')).not.toContain(' ');
    expect(formatDate('2027-08-20')).toContain(NBSP);
  });

  test('unreadable input says so in words, never Invalid Date and never empty', () => {
    for (const value of [null, undefined, '', 'tomorrow', '2027-02-30', '08/20/2027']) {
      const rendered = formatDate(value);
      expect(rendered).toBe(NO_DATE);
      expect(rendered).not.toBe('');
      expect(rendered).not.toContain('Invalid');
      expect(rendered).not.toContain('NaN');
    }
  });

  test('a caller can name its own reason instead of the generic absence', () => {
    expect(formatDate(null, { fallback: 'No close date set' })).toBe('No close date set');
  });
});

describe('formatDateRange — collapse what is redundant, keep what is not', () => {
  const cases: readonly [string, string, string, string][] = [
    ['single day', '2027-08-20', '2027-08-20', '20 Aug 2027'],
    ['same month', '2027-09-15', '2027-09-17', '15–17 Sep 2027'],
    ['same month, adjacent days', '2027-03-18', '2027-03-20', '18–20 Mar 2027'],
    ['across months', '2027-09-30', '2027-10-02', '30 Sep – 2 Oct 2027'],
    ['across years', '2026-12-30', '2027-01-02', '30 Dec 2026 – 2 Jan 2027'],
    ['across a leap day', '2028-02-27', '2028-03-01', '27 Feb – 1 Mar 2028'],
    ['whole month', '2027-06-01', '2027-06-30', '1–30 Jun 2027'],
    ['whole year', '2027-01-01', '2027-12-31', '1 Jan – 31 Dec 2027']
  ];

  for (const [name, start, end, expected] of cases) {
    test(name, () => {
      expect(formatDateRange(start, end)).toBe(span(expected));
    });
  }

  test('the en dash is a true en dash, not a hyphen', () => {
    expect(formatDateRange('2027-09-15', '2027-09-17')).toContain(EN_DASH);
    expect(formatDateRange('2027-09-15', '2027-09-17')).not.toContain('-');
  });

  test('the span never wraps mid-range', () => {
    for (const [, start, end] of cases) {
      expect(formatDateRange(start, end)).not.toContain(' ');
    }
  });

  test('weekday suppresses the day-number collapse, which would read as neither', () => {
    expect(formatDateRange('2027-09-15', '2027-09-17', { weekday: true })).toBe(
      span('Wed 15 – Fri 17 Sep 2027')
    );
    expect(formatDateRange('2027-08-20', '2027-08-20', { weekday: true })).toBe(
      span('Fri 20 Aug 2027')
    );
  });

  test('a cross-year range keeps its years even when asked to drop them', () => {
    expect(formatDateRange('2027-09-15', '2027-09-17', { year: false })).toBe(span('15–17 Sep'));
    expect(formatDateRange('2027-09-30', '2027-10-02', { year: false })).toBe(span('30 Sep – 2 Oct'));
    // Without the years this is a different range, not a shorter one.
    expect(formatDateRange('2026-12-30', '2027-01-02', { year: false })).toBe(
      span('30 Dec 2026 – 2 Jan 2027')
    );
  });

  test('a reversed range is shown in full rather than collapsed into a claim', () => {
    expect(formatDateRange('2027-08-20', '2027-08-18')).toBe(
      span('20 Aug 2027 – 18 Aug 2027')
    );
  });

  test('one readable end renders as an OPEN range, never as a confident single day', () => {
    // Collapsing to `20 Aug 2027` would state a one-day event, which is a
    // claim the data does not support when the other end is simply unknown.
    expect(formatDateRange('2027-08-20', null)).toBe(span('20 Aug 2027 – …'));
    expect(formatDateRange(undefined, '2027-08-20')).toBe(span('… – 20 Aug 2027'));
  });

  test('two unreadable ends say so in words', () => {
    expect(formatDateRange(null, undefined)).toBe(NO_DATE);
    expect(formatDateRange('', '', { fallback: 'Dates not set' })).toBe('Dates not set');
  });
});

describe('formatClock and formatClockRange', () => {
  const cases: readonly [number, string][] = [
    [0, '00:00'],
    [570, '09:30'],
    [615, '10:15'],
    [1439, '23:59'],
    [1440, '00:00'],
    [1455, '00:15'],
    [-15, '23:45']
  ];

  for (const [minutes, expected] of cases) {
    test(`${minutes} minutes reads ${expected}`, () => {
      expect(formatClock(minutes)).toBe(expected);
    });
  }

  test('24-hour throughout, never am/pm', () => {
    expect(formatClock(825)).toBe('13:45');
    expect(formatClock(825)).not.toContain('PM');
  });

  test('a range binds its two ends with an en dash and does not wrap', () => {
    expect(formatClockRange(570, 615)).toBe(`09:30${EN_DASH}10:15`);
    expect(formatClockRange(570, 615)).not.toContain(' ');
  });

  test('unreadable clocks say so in words', () => {
    expect(formatClock(Number.NaN)).toBe(NO_TIME);
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe(NO_TIME);
    expect(formatClock('09:30')).toBe(NO_TIME);
    expect(formatClockRange(null, undefined)).toBe(NO_TIME);
    expect(formatClockRange(570, null)).toBe('09:30');
    expect(formatClock(null, { fallback: 'Not scheduled' })).toBe('Not scheduled');
  });
});

describe('instants resolve in the event zone, never the reader zone or UTC', () => {
  test('the same instant is a different day in different zones', () => {
    const instant = '2027-08-20T23:30:00.000Z';
    expect(formatInstantDate(instant, 'UTC')).toBe(span('20 Aug 2027'));
    expect(formatInstantDate(instant, 'America/New_York')).toBe(span('20 Aug 2027'));
    expect(formatInstantDate(instant, 'Pacific/Auckland')).toBe(span('21 Aug 2027'));
    expect(formatInstantDate(instant, 'Asia/Kolkata')).toBe(span('21 Aug 2027'));
  });

  test('an instant just before local midnight keeps its own day', () => {
    // 23:59 in Helsinki on 20 Aug; 20:59 UTC the same day.
    const instant = '2027-08-20T20:59:00.000Z';
    expect(formatInstant(instant, 'Europe/Helsinki', { zone: true })).toBe(
      span('20 Aug 2027 · 23:59 GMT+3')
    );
    expect(formatInstant(instant, 'UTC', { zone: true })).toBe(span('20 Aug 2027 · 20:59 UTC'));
  });

  test('an instant just after local midnight has already turned over', () => {
    const instant = '2027-08-20T21:01:00.000Z';
    expect(formatInstant(instant, 'Europe/Helsinki', { zone: true })).toBe(
      span('21 Aug 2027 · 00:01 GMT+3')
    );
  });

  test('midnight renders 00:00 and never 24:00', () => {
    expect(formatInstant('2027-08-20T00:00:00.000Z', 'UTC')).toBe(span('20 Aug 2027 · 00:00'));
  });

  test('the zone label is only present when asked for, and moves with DST', () => {
    expect(formatInstant('2027-08-20T13:30:00.000Z', 'America/New_York')).toBe(
      span('20 Aug 2027 · 09:30')
    );
    expect(formatInstant('2027-08-20T13:30:00.000Z', 'America/New_York', { zone: true })).toBe(
      span('20 Aug 2027 · 09:30 EDT')
    );
    expect(formatZoneLabel('2027-08-20T13:30:00.000Z', 'America/New_York')).toBe('EDT');
    expect(formatZoneLabel('2027-01-20T13:30:00.000Z', 'America/New_York')).toBe('EST');
  });

  test('a half-hour zone is named as that zone names itself', () => {
    expect(formatInstant('2027-08-20T04:00:00.000Z', 'Asia/Kolkata', { zone: true })).toBe(
      span('20 Aug 2027 · 09:30 GMT+5:30')
    );
  });

  test('weekday composes with the clock for a planning surface', () => {
    expect(
      formatInstant('2027-08-20T13:30:00.000Z', 'America/New_York', {
        zone: true,
        weekday: true
      })
    ).toBe(span('Fri 20 Aug 2027 · 09:30 EDT'));
  });

  test('unreadable instants and zones say so in words', () => {
    expect(formatInstant('nope', 'UTC')).toBe(NO_DATE);
    expect(formatInstant('2027-08-20T09:30:00.000Z', 'Not/AZone')).toBe(NO_DATE);
    expect(formatInstantDate(null, 'UTC')).toBe(NO_DATE);
    expect(formatZoneLabel('nope', 'UTC')).toBe('');
    expect(formatInstant('nope', 'UTC', { fallback: 'Never submitted' })).toBe('Never submitted');
  });
});

// Two instants, six months apart, because an offset is a fact about a moment
// and not about a zone: in July the northern zones are on summer time and in
// January they are not.
const JULY = '2027-07-15T12:00:00.000Z';
const JANUARY = '2027-01-15T12:00:00.000Z';

describe('the zone marker appears by OFFSET, not by zone name', () => {
  const cases: readonly {
    readonly name: string;
    readonly instant: string;
    readonly event: string;
    readonly viewer: string | undefined;
    readonly marker: string | null;
  }[] = [
    {
      name: 'the reader is already on the event clock',
      instant: JULY,
      event: 'America/New_York',
      viewer: 'America/New_York',
      marker: null
    },
    {
      name: 'two names for one clock is not a difference (Berlin read from Paris)',
      instant: JULY,
      event: 'Europe/Berlin',
      viewer: 'Europe/Paris',
      marker: null
    },
    {
      name: 'six hours apart is the case the marker exists for',
      instant: JULY,
      event: 'America/New_York',
      viewer: 'Europe/Berlin',
      marker: 'New York'
    },
    {
      name: 'a half-hour zone read from a 45-minute one',
      instant: JULY,
      event: 'Asia/Kolkata',
      viewer: 'Asia/Kathmandu',
      marker: 'Kolkata'
    },
    {
      name: 'and the same pair the other way round',
      instant: JULY,
      event: 'Asia/Kathmandu',
      viewer: 'Asia/Kolkata',
      marker: 'Kathmandu'
    },
    {
      name: 'a 45-minute zone read from a whole-hour one',
      instant: JULY,
      event: 'Asia/Kathmandu',
      viewer: 'UTC',
      marker: 'Kathmandu'
    },
    {
      name: 'London and Reykjavik differ in July, when only one keeps summer time',
      instant: JULY,
      event: 'Europe/London',
      viewer: 'Atlantic/Reykjavik',
      marker: 'London'
    },
    {
      name: 'and the very same pair matches in January',
      instant: JANUARY,
      event: 'Europe/London',
      viewer: 'Atlantic/Reykjavik',
      marker: null
    },
    {
      name: 'an unknown reader is never guessed at',
      instant: JULY,
      event: 'America/New_York',
      viewer: undefined,
      marker: null
    },
    {
      name: 'a malformed reader zone degrades to silence rather than throwing',
      instant: JULY,
      event: 'America/New_York',
      viewer: 'Not/AZone',
      marker: null
    },
    {
      name: 'an event zone naming no place falls back to its offset',
      instant: JULY,
      event: 'Etc/GMT+5',
      viewer: 'Europe/Berlin',
      marker: 'GMT-5'
    }
  ];

  for (const row of cases) {
    test(row.name, () => {
      const marker = describeZoneMarker(row.instant, row.event, {
        zone: 'auto',
        viewerTimezone: row.viewer
      });
      expect(marker?.short ?? null).toBe(row.marker === null ? null : span(row.marker));
    });
  }

  test('the DST boundary moves the answer for one pair, not the pair', () => {
    // Stated as one assertion because it is one claim: nothing about these two
    // zones changed except the month, and that is enough to change the answer.
    const summer = describeZoneMarker(JULY, 'Europe/London', {
      zone: 'auto',
      viewerTimezone: 'Atlantic/Reykjavik'
    });
    const winter = describeZoneMarker(JANUARY, 'Europe/London', {
      zone: 'auto',
      viewerTimezone: 'Atlantic/Reykjavik'
    });
    expect(summer?.offset).toBe('GMT+1');
    expect(winter).toBeNull();
  });

  test('a malformed reader zone never throws, in any mode', () => {
    for (const mode of ['never', 'auto', 'always'] as const) {
      expect(() =>
        describeZoneMarker(JULY, 'America/New_York', { zone: mode, viewerTimezone: '¬zone' })
      ).not.toThrow();
    }
  });
});

describe('the three modes — off unless a surface opts in', () => {
  const differing = { viewerTimezone: 'Europe/Berlin' } as const;
  const identical = { viewerTimezone: 'America/New_York' } as const;

  test('never says nothing, however far apart the two readers are', () => {
    expect(describeZoneMarker(JULY, 'America/New_York', { zone: 'never', ...differing })).toBeNull();
    expect(
      formatInstant(JULY, 'America/New_York', { zone: 'never', ...differing })
    ).toBe(span('15 Jul 2027 · 08:00'));
  });

  test('never is the default, so nothing sprays markers by accident', () => {
    expect(formatInstant(JULY, 'America/New_York', differing)).toBe(span('15 Jul 2027 · 08:00'));
  });

  test('auto names the zone only for a reader whose own clock disagrees', () => {
    expect(formatInstant(JULY, 'America/New_York', { zone: 'auto', ...differing })).toBe(
      span('15 Jul 2027 · 08:00 New York')
    );
    expect(formatInstant(JULY, 'America/New_York', { zone: 'auto', ...identical })).toBe(
      span('15 Jul 2027 · 08:00')
    );
  });

  test('always names it regardless — the honest mode where the reader is unknowable', () => {
    expect(formatInstant(JULY, 'America/New_York', { zone: 'always', ...identical })).toBe(
      span('15 Jul 2027 · 08:00 New York')
    );
    expect(formatInstant(JULY, 'America/New_York', { zone: 'always' })).toBe(
      span('15 Jul 2027 · 08:00 New York')
    );
    // The viewer decides WHETHER, never WHAT: an unreadable one cannot silence
    // a marker the surface asked for unconditionally.
    expect(
      formatInstant(JULY, 'America/New_York', { zone: 'always', viewerTimezone: 'Not/AZone' })
    ).toBe(span('15 Jul 2027 · 08:00 New York'));
  });

  test('the older boolean still spells the zone the older way, byte for byte', () => {
    expect(formatInstant(JULY, 'America/New_York', { zone: true })).toBe(
      span('15 Jul 2027 · 08:00 EDT')
    );
    expect(formatInstant(JULY, 'America/New_York', { zone: false })).toBe(
      span('15 Jul 2027 · 08:00')
    );
  });
});

describe('the marker says the PLACE, taken from the identifier and not invented', () => {
  const humanised: readonly [string, string][] = [
    ['America/New_York', 'New York'],
    ['America/Sao_Paulo', 'Sao Paulo'],
    ['America/Argentina/Buenos_Aires', 'Buenos Aires'],
    ['America/Indiana/Indianapolis', 'Indianapolis'],
    ['Asia/Kolkata', 'Kolkata'],
    ['Europe/Kyiv', 'Kyiv'],
    ['America/Port-au-Prince', 'Port-au-Prince']
  ];

  for (const [timezone, place] of humanised) {
    test(`${timezone} reads ${place}`, () => {
      const marker = describeZoneMarker(JULY, timezone, { zone: 'always' });
      expect(marker?.place).toBe(span(place));
      expect(marker?.short).toBe(span(place));
    });
  }

  test('a city name is never corrected, only unpunctuated', () => {
    // `Sao Paulo`, not `São Paulo`: the identifier is the source, and adding
    // the diacritic would be inventing a name this module was not given.
    expect(describeZoneMarker(JULY, 'America/Sao_Paulo', { zone: 'always' })?.place).toBe(
      span('Sao Paulo')
    );
  });

  /** `GMT`, `GMT+0`, `GMT-5`, `GMT+5:30` — every shape `Intl` produces. */
  const OFFSET_SHAPE = /^GMT(?:[+-]\d{1,2}(?::\d{2})?)?$/u;

  const offsetOnly: readonly [string, string | null][] = [
    // Zero-offset identifiers are asserted by shape, not by literal: this
    // runtime's ICU spells that offset `GMT` and another spells it `GMT+0`,
    // which is a fact about ICU rather than about the vocabulary.
    ['UTC', null],
    ['GMT', null],
    ['Etc/UTC', null],
    ['Etc/GMT+5', 'GMT-5'],
    ['EST5EDT', null]
  ];

  for (const [timezone, offset] of offsetOnly) {
    test(`${timezone} names no place, so it falls back to its offset`, () => {
      const marker = describeZoneMarker(JULY, timezone, { zone: 'always' });
      expect(marker?.place).toBe('');
      expect(marker?.short).toMatch(OFFSET_SHAPE);
      expect(marker?.short).toBe(marker?.offset ?? '');
      // No repetition when the fallback is already the offset.
      if (offset !== null) expect(marker?.offset).toBe(offset);
    });
  }

  test('a zero offset is one offset however this runtime spells it', () => {
    // The comparison is on parsed minutes rather than on the two strings, so
    // an ICU that says `GMT` for one zone and `GMT+0` for another cannot make
    // two readers on the same clock look displaced.
    expect(
      describeZoneMarker(JULY, 'Atlantic/Reykjavik', { zone: 'auto', viewerTimezone: 'UTC' })
    ).toBeNull();
    expect(
      describeZoneMarker(JULY, 'UTC', { zone: 'auto', viewerTimezone: 'Africa/Abidjan' })
    ).toBeNull();
  });

  test('the offset comes from Intl, which is why Etc/GMT+5 is GMT-5', () => {
    // The POSIX sign is inverted. Any hand-rolled arithmetic over the
    // identifier would confidently produce GMT+5 and be wrong for every reader.
    expect(describeZoneMarker(JULY, 'Etc/GMT+5', { zone: 'always' })?.offset).toBe('GMT-5');
  });

  test('the offset moves with DST while the place does not', () => {
    const summer = describeZoneMarker(JULY, 'America/New_York', { zone: 'always' });
    const winter = describeZoneMarker(JANUARY, 'America/New_York', { zone: 'always' });
    expect(summer?.offset).toBe('GMT-4');
    expect(winter?.offset).toBe('GMT-5');
    expect(summer?.place).toBe(winter?.place);
  });

  test('the complete form carries city, identifier, AND offset together', () => {
    const marker = describeZoneMarker(JULY, 'America/New_York', { zone: 'always' });
    expect(marker?.complete).toBe(`${span('New York')} (America/New_York), GMT-4`);
    expect(marker?.timezone).toBe('America/New_York');
    // The offset is the precision layer, available beside the city where a
    // surface has room for it.
  });

  test('an identifier with no place still reaches the reader in full', () => {
    expect(describeZoneMarker(JULY, 'Etc/GMT+5', { zone: 'always' })?.complete).toBe(
      'Etc/GMT+5, GMT-5'
    );
  });

  test('a place name cannot wrap in half any more than a date can', () => {
    expect(describeZoneMarker(JULY, 'America/New_York', { zone: 'always' })?.short).toContain(
      NBSP
    );
  });

  test('an unreadable instant or zone has no marker at all', () => {
    expect(describeZoneMarker('nope', 'America/New_York', { zone: 'always' })).toBeNull();
    expect(describeZoneMarker(JULY, 'Not/AZone', { zone: 'always' })).toBeNull();
    expect(describeZoneMarker(JULY, '', { zone: 'always' })).toBeNull();
    expect(describeZoneMarker(JULY, null, { zone: 'always' })).toBeNull();
  });
});

describe('descriptors carry the marker as a field and the identity where it is reachable', () => {
  const now = Date.parse('2027-07-12T12:00:00.000Z');

  test('a deadline read from another zone names the place and keeps the record', () => {
    const described = describeDeadline({
      at: JULY,
      timezone: 'America/New_York',
      now,
      label: 'Closes',
      zone: 'auto',
      viewerTimezone: 'Europe/Berlin'
    });
    const absolute = span('Thu 15 Jul 2027 · 08:00 New York');
    const complete = `${span('Thu 15 Jul 2027 · 08:00 New York')} (America/New_York), GMT-4`;
    expect(described?.absolute).toBe(absolute);
    // The marker is its own field, so a surface can put it in its own element
    // at its own weight instead of slicing it back out of the sentence.
    expect(described?.zoneMarker?.short).toBe(span('New York'));
    expect(described?.zoneMarker?.complete).toBe(`${span('New York')} (America/New_York), GMT-4`);
    // Title is a convenience; the accessible sentence is the one that has to
    // hold everything, because a title does not exist on a touch device.
    expect(described?.title).toBe(`Closes ${complete}`);
    expect(described?.accessibleText).toBe(`Closes ${complete}, in 3 days, Upcoming`);
    expect(described?.accessibleText).toContain('America/New_York');
    expect(described?.accessibleText).toContain('GMT-4');
  });

  test('a reader on the event clock is told nothing they already know', () => {
    const described = describeDeadline({
      at: JULY,
      timezone: 'America/New_York',
      now,
      zone: 'auto',
      viewerTimezone: 'America/New_York'
    });
    expect(described?.absolute).toBe(span('Thu 15 Jul 2027 · 08:00'));
    expect(described?.zoneMarker).toBeNull();
  });

  test('recency composes the same way', () => {
    const described = describeRecency({
      at: JULY,
      timezone: 'America/New_York',
      now: Date.parse('2027-07-15T18:00:00.000Z'),
      zone: 'auto',
      viewerTimezone: 'Asia/Kolkata'
    });
    expect(described?.absolute).toBe(span('15 Jul 2027 · 08:00 New York'));
    expect(described?.zoneMarker?.offset).toBe('GMT-4');
    expect(described?.accessibleText).toBe(
      `6 hours ago (${span('15 Jul 2027 · 08:00 New York')} (America/New_York), GMT-4)`
    );
  });

  test('a calendar deadline marks the zone in force during its own last minute', () => {
    const described = describeCalendarDeadline({
      displayDate: '2027-07-15',
      effectiveAt: '2027-07-16T04:00:00.000Z',
      timezone: 'America/New_York',
      now,
      label: 'Closes',
      zone: 'auto',
      viewerTimezone: 'Europe/Berlin'
    });
    expect(described?.absolute).toBe(span('Thu 15 Jul 2027 · 23:59 New York'));
    expect(described?.zoneMarker?.short).toBe(span('New York'));
    expect(described?.title).toBe(
      `Closes ${span('Thu 15 Jul 2027 · 23:59 New York')} (America/New_York), GMT-4`
    );
  });

  test('a date-only deadline still names whose calendar the day belongs to', () => {
    // "Closes on the 20th" means the 20th THERE. A reader in Los Angeles
    // looking at a Tokyo event whose day has already ended would otherwise act
    // a full day late — there is no clock to get wrong, but there is still a
    // date to get wrong.
    const base = {
      displayDate: '2027-07-15',
      effectiveAt: '2027-07-16T04:00:00.000Z',
      timezone: 'America/New_York',
      now,
      showTime: false
    } as const;
    const marked = describeCalendarDeadline({
      ...base,
      zone: 'auto',
      viewerTimezone: 'Europe/Berlin'
    });
    expect(marked?.absolute).toBe(span('Thu 15 Jul 2027 New York'));
    expect(marked?.zoneMarker?.place).toBe(span('New York'));
    expect(marked?.title).toContain('America/New_York');
    expect(marked?.accessibleText).toContain('America/New_York');

    // A reader on the event's own clock is told nothing, and the default stays
    // silent for every surface that has not opted in.
    const sameClock = describeCalendarDeadline({
      ...base,
      zone: 'auto',
      viewerTimezone: 'America/New_York'
    });
    expect(sameClock?.absolute).toBe(span('Thu 15 Jul 2027'));
    expect(sameClock?.zoneMarker).toBeNull();
    expect(describeCalendarDeadline(base)?.zoneMarker).toBeNull();
  });

  test('the descriptors are unchanged for every caller that has not opted in', () => {
    const deadline = describeDeadline({
      at: '2027-08-21T03:59:00.000Z',
      timezone: 'America/New_York',
      now: Date.parse('2027-08-17T12:00:00.000Z'),
      label: 'Closes'
    });
    expect(deadline?.absolute).toBe(span('Fri 20 Aug 2027 · 23:59 EDT'));
    expect(deadline?.title).toBe(`Closes ${span('Fri 20 Aug 2027 · 23:59 EDT')}`);
    expect(deadline?.zoneMarker).toBeNull();

    const recency = describeRecency({
      at: '2027-08-20T06:00:00.000Z',
      timezone: 'America/New_York',
      now: Date.parse('2027-08-20T12:00:00.000Z')
    });
    expect(recency?.absolute).toBe(span('20 Aug 2027 · 02:00 EDT'));
    expect(recency?.zoneMarker).toBeNull();
  });
});

describe('formatRelative counts days in the event zone', () => {
  const now = Date.parse('2027-08-20T12:00:00.000Z');

  const cases: readonly [string, string, string][] = [
    ['just now', '2027-08-20T12:00:30.000Z', 'just now'],
    ['minutes back', '2027-08-20T11:20:00.000Z', '40 minutes ago'],
    ['hours forward', '2027-08-20T15:00:00.000Z', 'in 3 hours'],
    ['tomorrow', '2027-08-21T12:00:00.000Z', 'tomorrow'],
    ['yesterday', '2027-08-19T12:00:00.000Z', 'yesterday'],
    ['days forward', '2027-08-23T12:00:00.000Z', 'in 3 days'],
    ['days back', '2027-08-15T12:00:00.000Z', '5 days ago'],
    ['exactly a week forward', '2027-08-27T12:00:00.000Z', 'in 1 week'],
    ['two weeks back', '2027-08-06T12:00:00.000Z', '2 weeks ago'],
    ['three weeks forward', '2027-09-10T12:00:00.000Z', 'in 3 weeks'],
    ['months forward', '2027-11-20T12:00:00.000Z', 'in 3 months'],
    ['months back', '2027-05-20T12:00:00.000Z', '3 months ago'],
    ['a year forward', '2028-08-20T12:00:00.000Z', 'in 1 year'],
    ['years back', '2025-08-20T12:00:00.000Z', '2 years ago']
  ];

  for (const [name, instant, expected] of cases) {
    test(name, () => {
      expect(formatRelative(instant, now, { timezone: 'UTC' })).toBe(expected);
    });
  }

  test('the day count is the event zone\'s, which is the whole point', () => {
    // 38 hours out. In UTC that crosses two midnights; in New York, where the
    // instant is still 21 Aug at 22:00 local, it crosses one. Counting this in
    // UTC — or in the reader's browser — is how a row ends up a day wrong.
    const instant = '2027-08-22T02:00:00.000Z';
    expect(formatRelative(instant, now, { timezone: 'UTC' })).toBe('in 2 days');
    expect(formatRelative(instant, now, { timezone: 'America/New_York' })).toBe('tomorrow');
  });

  test('a deadline two hours away is not "tomorrow" just because midnight is between', () => {
    const late = Date.parse('2027-08-20T22:00:00.000Z');
    expect(formatRelative('2027-08-21T00:30:00.000Z', late, { timezone: 'UTC' })).toBe(
      'in 3 hours'
    );
  });

  test('without a zone it will not claim a day boundary it cannot know', () => {
    const rendered = formatRelative('2027-08-21T12:00:00.000Z', now);
    expect(rendered).toBe('in 1 day');
    expect(rendered).not.toBe('tomorrow');
  });

  test('an unreadable instant says so in words rather than counting from NaN', () => {
    expect(formatRelative('nope', now)).toBe(NO_DATE);
    expect(formatRelative(null, now)).toBe(NO_DATE);
    expect(formatRelative('2027-08-20T12:00:00.000Z', Number.NaN)).toBe(NO_DATE);
    expect(formatRelative(null, now, { fallback: 'Never opened' })).toBe('Never opened');
  });
});

describe('deadlineState — every threshold', () => {
  const at = '2027-08-20T00:00:00.000Z';
  const boundary = Date.parse(at);
  const dueSoon = DEFAULT_DUE_SOON_HOURS * 3_600_000;

  const cases: readonly [string, number, boolean, DeadlineState][] = [
    ['well ahead', boundary - 30 * 86_400_000, false, 'upcoming'],
    ['one millisecond outside the window', boundary - dueSoon - 1, false, 'upcoming'],
    ['exactly at the due-soon threshold', boundary - dueSoon, false, 'due-soon'],
    ['inside the window', boundary - 3_600_000, false, 'due-soon'],
    ['one millisecond before the boundary', boundary - 1, false, 'due-soon'],
    ['exactly at the boundary', boundary, false, 'overdue'],
    ['past the boundary', boundary + 86_400_000, false, 'overdue'],
    ['settled while still upcoming', boundary - dueSoon - 60_000, true, 'passed'],
    ['settled after the boundary', boundary + 86_400_000, true, 'passed']
  ];

  for (const [name, now, settled, expected] of cases) {
    test(name, () => {
      expect(deadlineState({ at, now, settled })).toBe(expected);
    });
  }

  test('the window is configurable', () => {
    const now = boundary - 6 * 3_600_000;
    expect(deadlineState({ at, now })).toBe('due-soon');
    expect(deadlineState({ at, now, dueSoonHours: 2 })).toBe('upcoming');
  });

  test('an unreadable boundary has no state at all', () => {
    expect(deadlineState({ at: 'nope', now: boundary })).toBeNull();
    expect(deadlineState({ at, now: Number.NaN })).toBeNull();
  });

  test('every state carries a word, a tone, and an ink', () => {
    const states: readonly DeadlineState[] = ['overdue', 'due-soon', 'upcoming', 'passed'];
    for (const state of states) {
      const descriptor = deadlineStateDescriptor(state);
      expect(descriptor.word.length).toBeGreaterThan(0);
      expect(descriptor.state).toBe(state);
    }
    expect(deadlineStateDescriptor('overdue')).toEqual({
      state: 'overdue',
      word: 'Overdue',
      tone: 'danger',
      ink: 'normal'
    });
    expect(deadlineStateDescriptor('due-soon').tone).toBe('warning');
    expect(deadlineStateDescriptor('upcoming').tone).toBe('neutral');
  });

  test('settled and passed recede; live states hold the row ink', () => {
    expect(deadlineStateDescriptor('passed').ink).toBe('quiet');
    expect(deadlineStateDescriptor('overdue').ink).toBe('normal');
    expect(deadlineStateDescriptor('due-soon').ink).toBe('normal');
    expect(deadlineStateDescriptor('upcoming').ink).toBe('normal');
  });
});

describe('describeDeadline — an instant deadline', () => {
  const now = Date.parse('2027-08-17T12:00:00.000Z');

  test('carries the moment, the distance, and the state together', () => {
    const described = describeDeadline({
      at: '2027-08-21T03:59:00.000Z',
      timezone: 'America/New_York',
      now,
      label: 'Closes'
    });
    expect(described).not.toBeNull();
    expect(described?.absolute).toBe(span('Fri 20 Aug 2027 · 23:59 EDT'));
    expect(described?.relative).toBe('in 3 days');
    expect(described?.label).toBe('Closes');
    expect(described?.state).toBe('upcoming');
    expect(described?.stateWord).toBe('Upcoming');
    expect(described?.tone).toBe('neutral');
    expect(described?.ink).toBe('normal');
    expect(described?.machine).toBe('2027-08-21T03:59:00.000Z');
  });

  test('the absolute stays reachable on hover and to assistive tech', () => {
    const described = describeDeadline({
      at: '2027-08-21T03:59:00.000Z',
      timezone: 'America/New_York',
      now,
      label: 'Closes'
    });
    const absolute = span('Fri 20 Aug 2027 · 23:59 EDT');
    // The qualifier joins its value with an ordinary space: that is the one
    // place the line may wrap, and the date itself still cannot.
    expect(described?.title).toBe(`Closes ${absolute}`);
    expect(described?.accessibleText).toBe(`Closes ${absolute}, in 3 days, Upcoming`);
    expect(described?.text).toBe(`Closes ${absolute} — in 3 days`);
  });

  test('the weekday is on by default, because a deadline is a planning fact', () => {
    const withWeekday = describeDeadline({
      at: '2027-08-21T03:59:00.000Z',
      timezone: 'America/New_York',
      now
    });
    const without = describeDeadline({
      at: '2027-08-21T03:59:00.000Z',
      timezone: 'America/New_York',
      now,
      weekday: false
    });
    expect(withWeekday?.absolute).toBe(span('Fri 20 Aug 2027 · 23:59 EDT'));
    expect(without?.absolute).toBe(span('20 Aug 2027 · 23:59 EDT'));
  });

  test('an overdue deadline is danger-toned and keeps normal ink', () => {
    const described = describeDeadline({
      at: '2027-08-15T03:59:00.000Z',
      timezone: 'America/New_York',
      now,
      label: 'Due'
    });
    expect(described?.state).toBe('overdue');
    expect(described?.stateWord).toBe('Overdue');
    expect(described?.tone).toBe('danger');
    expect(described?.ink).toBe('normal');
    // 14 Aug 23:59 in New York, read on 17 Aug there: three of its days ago.
    expect(described?.relative).toBe('3 days ago');
  });

  test('a settled deadline recedes instead of shouting', () => {
    const described = describeDeadline({
      at: '2027-08-15T03:59:00.000Z',
      timezone: 'America/New_York',
      now,
      settled: true
    });
    expect(described?.state).toBe('passed');
    expect(described?.stateWord).toBe('Passed');
    expect(described?.ink).toBe('quiet');
    expect(described?.tone).toBe('neutral');
  });

  test('an unlabelled deadline does not leave a leading space', () => {
    const described = describeDeadline({
      at: '2027-08-21T03:59:00.000Z',
      timezone: 'UTC',
      now
    });
    expect(described?.label).toBe('');
    expect(described?.title.startsWith(' ')).toBe(false);
    expect(described?.title).toBe(described?.absolute);
  });

  test('null when it cannot be read, so the surface names its own reason', () => {
    expect(describeDeadline({ at: 'nope', timezone: 'UTC', now })).toBeNull();
    expect(
      describeDeadline({ at: '2027-08-21T03:59:00.000Z', timezone: 'Not/AZone', now })
    ).toBeNull();
  });
});

describe('describeCalendarDeadline — the catalog shape, end-exclusive', () => {
  const now = Date.parse('2027-08-17T12:00:00.000Z');
  // The profile stores the first instant of the *next* event-local date.
  const boundary = '2027-08-21T04:00:00.000Z'; // 21 Aug 00:00 in New York

  test('shows the last moment a person can act, not the boundary after it', () => {
    const described = describeCalendarDeadline({
      displayDate: '2027-08-20',
      effectiveAt: boundary,
      timezone: 'America/New_York',
      now,
      label: 'Closes'
    });
    expect(described?.absolute).toBe(span('Fri 20 Aug 2027 · 23:59 EDT'));
    // The trap this exists to avoid: the raw boundary is the following day.
    expect(formatInstantDate(boundary, 'America/New_York')).toBe(span('21 Aug 2027'));
  });

  test('the boundary still decides the state', () => {
    const oneMinuteInside = Date.parse('2027-08-21T03:59:00.000Z');
    const atBoundary = Date.parse(boundary);
    expect(
      describeCalendarDeadline({
        displayDate: '2027-08-20',
        effectiveAt: boundary,
        timezone: 'America/New_York',
        now: oneMinuteInside
      })?.state
    ).toBe('due-soon');
    expect(
      describeCalendarDeadline({
        displayDate: '2027-08-20',
        effectiveAt: boundary,
        timezone: 'America/New_York',
        now: atBoundary
      })?.state
    ).toBe('overdue');
  });

  test('the same stored deadline reads the same day in every reader zone', () => {
    for (const zone of ['UTC', 'America/New_York', 'Pacific/Auckland', 'Asia/Kolkata']) {
      const described = describeCalendarDeadline({
        displayDate: '2027-08-20',
        effectiveAt: boundary,
        timezone: zone,
        now
      });
      expect(described?.absolute).toContain(span('20 Aug 2027'));
    }
  });

  test('the day can be shown without a clock where there is no room for one', () => {
    const described = describeCalendarDeadline({
      displayDate: '2027-08-20',
      effectiveAt: boundary,
      timezone: 'America/New_York',
      now,
      showTime: false,
      weekday: false
    });
    expect(described?.absolute).toBe(span('20 Aug 2027'));
  });

  test('relative copy follows the authored event-calendar day, not hours to its last minute', () => {
    const at = Date.parse('2026-08-19T12:00:00.000Z');
    const cases = [
      ['2026-08-18', '2026-08-19T07:00:00.000Z', 'yesterday'],
      ['2026-08-19', '2026-08-20T07:00:00.000Z', 'today'],
      ['2026-08-20', '2026-08-21T07:00:00.000Z', 'tomorrow']
    ] as const;

    for (const [displayDate, effectiveAt, expected] of cases) {
      expect(describeCalendarDeadline({
        displayDate,
        effectiveAt,
        timezone: 'America/Los_Angeles',
        now: at
      })?.relative).toBe(expected);
    }
  });

  test('a leap-day deadline keeps its day', () => {
    const described = describeCalendarDeadline({
      displayDate: '2028-02-29',
      effectiveAt: '2028-03-01T05:00:00.000Z',
      timezone: 'America/New_York',
      now: Date.parse('2028-02-20T12:00:00.000Z')
    });
    expect(described?.absolute).toBe(span('Tue 29 Feb 2028 · 23:59 EST'));
  });

  test('null when either half cannot be read', () => {
    expect(
      describeCalendarDeadline({
        displayDate: '2027-02-30',
        effectiveAt: boundary,
        timezone: 'UTC',
        now
      })
    ).toBeNull();
    expect(
      describeCalendarDeadline({
        displayDate: '2027-08-20',
        effectiveAt: 'nope',
        timezone: 'UTC',
        now
      })
    ).toBeNull();
    expect(
      describeCalendarDeadline({
        displayDate: '2027-08-20',
        effectiveAt: boundary,
        timezone: 'Not/AZone',
        now
      })
    ).toBeNull();
  });
});

describe('describeRecency — relative in front, absolute never lost', () => {
  const now = Date.parse('2027-08-20T12:00:00.000Z');

  test('the row shows the distance and hover holds the record', () => {
    const described = describeRecency({
      at: '2027-08-20T06:00:00.000Z',
      timezone: 'America/New_York',
      now
    });
    expect(described?.relative).toBe('6 hours ago');
    expect(described?.absolute).toBe(span('20 Aug 2027 · 02:00 EDT'));
    expect(described?.title).toBe(described?.absolute);
    expect(described?.accessibleText).toBe(`6 hours ago (${span('20 Aug 2027 · 02:00 EDT')})`);
    expect(described?.machine).toBe('2027-08-20T06:00:00.000Z');
  });

  test('an old arrival is still recoverable, which relative-only would not be', () => {
    const described = describeRecency({
      at: '2026-11-02T09:20:00.000Z',
      timezone: 'UTC',
      now
    });
    expect(described?.relative).toBe('10 months ago');
    expect(described?.absolute).toContain(span('2 Nov 2026'));
    expect(described?.title).toContain('2026');
  });

  test('null when it cannot be read', () => {
    expect(describeRecency({ at: 'nope', timezone: 'UTC', now })).toBeNull();
    expect(
      describeRecency({ at: '2027-08-20T06:00:00.000Z', timezone: 'Not/AZone', now })
    ).toBeNull();
  });
});

describe('the scannability vocabulary is one closed set', () => {
  test('class names are stable and namespaced', () => {
    expect(DATE_CLASS).toEqual({
      column: 'je-date-column',
      value: 'je-date-value',
      label: 'je-date-label',
      zone: 'je-date-zone',
      quiet: 'je-date-quiet'
    });
    expect(Object.isFrozen(DATE_CLASS)).toBe(true);
  });
});

describe('purity — the module makes no assumption about its host', () => {
  test('nothing reads an ambient clock', () => {
    const fixed = Date.parse('2027-08-20T12:00:00.000Z');
    const first = describeDeadline({ at: '2027-08-25T00:00:00.000Z', timezone: 'UTC', now: fixed });
    const second = describeDeadline({ at: '2027-08-25T00:00:00.000Z', timezone: 'UTC', now: fixed });
    expect(first).toEqual(second);
  });

  test('nothing detects the host timezone', () => {
    // The host running this test is in *some* zone, and `auto` with no
    // `viewerTimezone` must still be silent: a module that reached for
    // `Intl...resolvedOptions().timeZone` would answer differently on a laptop
    // in Berlin and on the server that renders the same row into an email.
    expect(
      describeZoneMarker('2027-07-15T12:00:00.000Z', 'America/New_York', { zone: 'auto' })
    ).toBeNull();
    expect(
      formatInstant('2027-07-15T12:00:00.000Z', 'America/New_York', { zone: 'auto' })
    ).toBe(span('15 Jul 2027 · 08:00'));
  });

  test('a zone marker is frozen too', () => {
    const marker = describeZoneMarker('2027-07-15T12:00:00.000Z', 'America/New_York', {
      zone: 'always'
    });
    expect(Object.isFrozen(marker)).toBe(true);
  });

  test('results are frozen, so a surface cannot edit the vocabulary in place', () => {
    const described = describeDeadline({
      at: '2027-08-25T00:00:00.000Z',
      timezone: 'UTC',
      now: Date.parse('2027-08-20T12:00:00.000Z')
    });
    expect(Object.isFrozen(described)).toBe(true);
  });
});
describe('legacy region aliases are not places', () => {
  test('a compass direction is never presented as a city', () => {
    // `US/Pacific` is an alias whose last segment names a region, not a place;
    // showing "Pacific" would invent a city that does not exist.
    for (const [zone, expected] of [
      ['US/Pacific', 'GMT-7'],
      ['US/Eastern', 'GMT-4'],
      ['Canada/Mountain', 'GMT-6'],
      ['Brazil/East', 'GMT-3']
    ] as const) {
      const marker = describeZoneMarker('2027-07-15T12:00:00.000Z', zone, {
        zone: 'always'
      });
      expect(marker?.place).toBe('');
      expect(marker?.short).toBe(expected);
    }
  });

  test('a real city under a real area still reads as its city', () => {
    const marker = describeZoneMarker('2027-07-15T12:00:00.000Z', 'Australia/Sydney', {
      zone: 'always'
    });
    expect(marker?.place).toBe('Sydney');
    expect(marker?.short).toBe('Sydney');
  });
});
