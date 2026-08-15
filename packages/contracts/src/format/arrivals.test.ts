import { describe, expect, test } from 'bun:test';
import {
  chooseArrivalWindow,
  describeArrivalPulse,
  describeArrivalWeek,
  startOfLocalDate,
  startOfZonedDay,
  startOfZonedWeek,
  summarizeArrivals,
  visitsDaily
} from './arrivals';

const NY = 'America/New_York';
const HELSINKI = 'Europe/Helsinki';
const DAY = 86_400_000;

/** Saturday 15 Aug 2026, 18:00 in New York. */
const SATURDAY = Date.parse('2026-08-15T18:00:00-04:00');

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe('zoned day boundaries', () => {
  test('a day starts at the event zone midnight, not the reader’s', () => {
    expect(startOfZonedDay(SATURDAY, NY)).toBe(Date.parse('2026-08-15T00:00:00-04:00'));
    // The same instant is already Sunday in Helsinki, so its day starts later.
    expect(startOfZonedDay(SATURDAY, HELSINKI)).toBe(Date.parse('2026-08-16T00:00:00+03:00'));
  });

  test('the week starts on the event zone Monday', () => {
    expect(startOfZonedWeek(SATURDAY, NY)).toBe(Date.parse('2026-08-10T00:00:00-04:00'));
  });

  test('a Monday instant is already its own week start', () => {
    const monday = Date.parse('2026-08-10T09:15:00-04:00');
    expect(startOfZonedWeek(monday, NY)).toBe(Date.parse('2026-08-10T00:00:00-04:00'));
  });

  test('a Sunday belongs to the week that began six days earlier', () => {
    const sunday = Date.parse('2026-08-16T23:30:00-04:00');
    expect(startOfZonedWeek(sunday, NY)).toBe(Date.parse('2026-08-10T00:00:00-04:00'));
  });

  test('spring forward: the day is 23 hours long and still starts at midnight', () => {
    const after = Date.parse('2026-03-08T12:00:00-04:00');
    const start = startOfZonedDay(after, NY);
    expect(start).toBe(Date.parse('2026-03-08T00:00:00-05:00'));
    expect(startOfLocalDate({ year: 2026, month: 3, day: 9 }, NY)! - start!).toBe(23 * 3_600_000);
  });

  test('fall back: the day is 25 hours long and starts at the first of the two midnights', () => {
    const start = startOfLocalDate({ year: 2026, month: 11, day: 1 }, NY);
    expect(start).toBe(Date.parse('2026-11-01T00:00:00-04:00'));
    expect(startOfLocalDate({ year: 2026, month: 11, day: 2 }, NY)! - start!).toBe(25 * 3_600_000);
  });

  test('a midnight that does not exist starts the day at the transition instant', () => {
    // Chile skips 00:00 on the September spring-forward; the day begins at 01:00.
    const start = startOfLocalDate({ year: 2026, month: 9, day: 6 }, 'America/Santiago');
    expect(start).not.toBeNull();
    expect(new Date(start!).toISOString()).toBe('2026-09-06T04:00:00.000Z');
  });

  test('an unreadable zone says nothing rather than counting from the browser', () => {
    expect(startOfZonedDay(SATURDAY, 'Not/AZone')).toBeNull();
    expect(startOfZonedWeek(SATURDAY, '')).toBeNull();
    expect(chooseArrivalWindow({ visits: [], timezone: 'Not/AZone', now: SATURDAY })).toBeNull();
  });
});

describe('cadence', () => {
  test('four distinct days in the last seven is daily', () => {
    const visits = [1, 2, 3, 4].map((back) => iso(SATURDAY - back * DAY));
    expect(visitsDaily({ visits, timezone: NY, now: SATURDAY })).toBe(true);
  });

  test('six visits on one afternoon is one day of habit, not six', () => {
    const visits = [1, 2, 3, 4, 5, 6].map((hours) => iso(SATURDAY - hours * 3_600_000));
    expect(visitsDaily({ visits, timezone: NY, now: SATURDAY })).toBe(false);
  });

  test('visits older than a week do not establish a habit', () => {
    const visits = [8, 9, 10, 11].map((back) => iso(SATURDAY - back * DAY));
    expect(visitsDaily({ visits, timezone: NY, now: SATURDAY })).toBe(false);
  });
});

describe('window choice', () => {
  test('someone here most days gets today', () => {
    const visits = [1, 2, 3, 4].map((back) => iso(SATURDAY - back * DAY));
    const window = chooseArrivalWindow({ visits, timezone: NY, now: SATURDAY });
    expect(window?.kind).toBe('today');
    expect(window?.startsAt).toBe(new Date(Date.parse('2026-08-15T00:00:00-04:00')).toISOString());
  });

  test('an occasional visitor gets the week', () => {
    const window = chooseArrivalWindow({
      visits: [iso(SATURDAY - 2 * DAY)],
      timezone: NY,
      now: SATURDAY
    });
    expect(window?.kind).toBe('week');
    expect(window?.startsAt).toBe(new Date(Date.parse('2026-08-10T00:00:00-04:00')).toISOString());
  });

  test('away since before this week widens to the absence', () => {
    const lastVisit = SATURDAY - 13 * DAY;
    const window = chooseArrivalWindow({
      visits: [iso(lastVisit)],
      timezone: NY,
      now: SATURDAY
    });
    expect(window?.kind).toBe('since-visit');
    expect(window?.startsAt).toBe(iso(lastVisit));
  });

  test('a quick glance never shrinks the window below the calendar one', () => {
    // Two visits today and one yesterday is not a daily habit, so the window
    // stays the week — it does not collapse onto "since ten minutes ago".
    const visits = [
      iso(SATURDAY - 10 * 60_000),
      iso(SATURDAY - 3 * 3_600_000),
      iso(SATURDAY - DAY)
    ];
    const window = chooseArrivalWindow({ visits, timezone: NY, now: SATURDAY });
    expect(window?.kind).toBe('week');
  });

  test('a first-ever visit takes the calendar window, not a since-forever one', () => {
    const window = chooseArrivalWindow({ visits: [], timezone: NY, now: SATURDAY });
    expect(window?.kind).toBe('week');
  });

  test('unreadable visit instants are ignored rather than trusted', () => {
    const window = chooseArrivalWindow({
      visits: ['soon', 'Jul 2', ''],
      timezone: NY,
      now: SATURDAY
    });
    expect(window?.kind).toBe('week');
  });
});

describe('counting', () => {
  const arrivals = [
    SATURDAY - 2 * 3_600_000, // today
    SATURDAY - 5 * 3_600_000, // today
    SATURDAY - 2 * DAY, // this week
    SATURDAY - 9 * DAY, // last week
    SATURDAY - 30 * DAY // five weeks back
  ].map(iso);

  test('the window count and the total are claims about one population', () => {
    const pulse = summarizeArrivals({
      arrivals,
      visits: [iso(SATURDAY - 2 * DAY)],
      timezone: NY,
      now: SATURDAY
    });
    expect(pulse?.window.kind).toBe('week');
    expect(pulse?.inWindow).toBe(3);
    expect(pulse?.total).toBe(5);
  });

  test('weeks run oldest first and end with the week in progress', () => {
    const pulse = summarizeArrivals({
      arrivals,
      visits: [],
      timezone: NY,
      now: SATURDAY,
      weeks: 6
    });
    expect(pulse?.weeks).toHaveLength(6);
    expect(pulse?.weeks.at(-1)?.count).toBe(3);
    expect(pulse?.weeks.at(-2)?.count).toBe(1);
    // Five weeks back lands in the oldest bucket held here.
    expect(pulse?.weeks.reduce((sum, week) => sum + week.count, 0)).toBe(5);
  });

  test('an arrival older than every bucket stays in the total only', () => {
    const pulse = summarizeArrivals({
      arrivals: [iso(SATURDAY - 200 * DAY)],
      visits: [],
      timezone: NY,
      now: SATURDAY,
      weeks: 4
    });
    expect(pulse?.total).toBe(1);
    expect(pulse?.weeks.every((week) => week.count === 0)).toBe(true);
  });

  test('an arrival in the future is not counted as new', () => {
    const pulse = summarizeArrivals({
      arrivals: [iso(SATURDAY + DAY)],
      visits: [],
      timezone: NY,
      now: SATURDAY
    });
    expect(pulse?.inWindow).toBe(0);
  });
});

describe('words', () => {
  function pulseWith(kind: 'today' | 'week' | 'since-visit', count: number) {
    const visits =
      kind === 'today'
        ? [1, 2, 3, 4].map((back) => iso(SATURDAY - back * DAY))
        : kind === 'since-visit'
          ? [iso(SATURDAY - 13 * DAY)]
          : [iso(SATURDAY - 2 * DAY)];
    const arrivals = new Array(count).fill(iso(SATURDAY - 60_000));
    return summarizeArrivals({ arrivals, visits, timezone: NY, now: SATURDAY })!;
  }

  test('the chip names the window it counted', () => {
    expect(describeArrivalPulse({ pulse: pulseWith('today', 3), timezone: NY, now: SATURDAY }).delta)
      .toBe('+3 today');
    expect(describeArrivalPulse({ pulse: pulseWith('week', 12), timezone: NY, now: SATURDAY }).delta)
      .toBe('+12 this week');
    expect(
      describeArrivalPulse({ pulse: pulseWith('since-visit', 27), timezone: NY, now: SATURDAY })
        .delta
    ).toBe('+27 since your last visit');
  });

  test('zero says nothing arrived rather than rendering a +0 chip', () => {
    const words = describeArrivalPulse({ pulse: pulseWith('week', 0), timezone: NY, now: SATURDAY });
    expect(words.delta).toBe('');
    expect(words.quiet).toBe('Nothing new this week');
  });

  test('the caption dates the absence it widened to cover', () => {
    const words = describeArrivalPulse({
      pulse: pulseWith('since-visit', 4),
      timezone: NY,
      now: SATURDAY
    });
    // The distance is spelled by the one date vocabulary, which coarsens to
    // weeks past seven days — this caption cannot grow a second dialect.
    expect(words.caption).toBe('Counted since your last visit, 2 weeks ago.');
  });

  test('a week row carries its span and its distance', () => {
    const pulse = pulseWith('week', 1);
    const current = describeArrivalWeek({ week: pulse.weeks.at(-1)!, timezone: NY, now: SATURDAY });
    // Word-joined either side of the en dash by the date vocabulary, so a week
    // span can never break across two lines.
    expect(current?.range).toBe('10⁠–⁠16 Aug');
    expect(current?.relative).toBe('This week');
    expect(current?.current).toBe(true);

    const previous = describeArrivalWeek({ week: pulse.weeks.at(-2)!, timezone: NY, now: SATURDAY });
    expect(previous?.relative).toBe('Last week');
    expect(previous?.current).toBe(false);
  });
});
