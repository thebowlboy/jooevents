/**
 * The arrival pulse: *what is new since I last had this in my head.*
 *
 * An organizer's real question on opening a workspace is never "how many
 * submissions exist" — it is "what changed". The obvious answer, *since your
 * last visit*, is the one that cannot be shipped alone: a visit is not a
 * reading. Somebody who opens the tab for four seconds to check a name has
 * "visited", and a diff anchored to that instant reports zero for the rest of
 * the day. The baseline a person actually holds is a **calendar** one — what
 * has come in today, or this week — because that is the unit they think in and
 * a glance cannot reset it.
 *
 * So the window is chosen for the reader rather than fixed, and the surface
 * always names which one it chose:
 *
 * | Their habit | Window | Why |
 * | --- | --- | --- |
 * | Here most days | **today** | Yesterday is still in short-term memory; a week's worth of arrivals would bury the three that are actually new. |
 * | Here now and then | **this week** (Mon–Sun) | A day is too fine to be a useful diff for someone who was last here on Tuesday. |
 * | Away since before this week | **since your last visit** | Neither calendar window covers the gap, and the gap is precisely what they missed. |
 *
 * The third row only ever *widens*. A quick glance can never shrink the window
 * below today or this week, which is the failure the calendar anchor exists to
 * prevent; an absence widens it to cover everything the person was not here
 * for. That union is the same rule the row-level New mark uses, so the count in
 * the header and the marks in the list are claims about one window rather than
 * two.
 *
 * Every boundary is a boundary **in the event's timezone**. "Today" is a claim
 * about a particular midnight, and an organizer in Auckland reading an event in
 * Helsinki must see the event's day, not their own. Without a readable zone
 * this module returns null rather than counting from the browser's.
 *
 * Pure, like the date vocabulary beside it: no DOM, no framework, no ambient
 * clock. `now` is passed in, so a projection assembled on the server and a
 * panel rendered in the browser cannot disagree about which day it is.
 */

import { formatDateRange, formatRelative, parseZonedInstant } from './dates';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How many of the last seven local days must carry a visit to count as daily. */
export const DAILY_CADENCE_DAYS = 4;

/** How many weeks of history the pulse carries by default. */
export const ARRIVAL_WEEKS = 12;

export type ArrivalWindowKind = 'today' | 'week' | 'since-visit';

export interface ArrivalWindow {
  readonly kind: ArrivalWindowKind;
  /** The first instant the window covers, as canonical UTC bytes. */
  readonly startsAt: string;
}

export interface ArrivalWeek {
  /** The event-local Monday this week begins on, as an instant. */
  readonly startsAt: string;
  readonly count: number;
}

export interface ArrivalPulse {
  readonly window: ArrivalWindow;
  /** Arrivals inside the window. */
  readonly inWindow: number;
  /** The whole population the window is a slice of. */
  readonly total: number;
  /** Oldest first; the last entry is the week in progress. */
  readonly weeks: readonly ArrivalWeek[];
}

// ---------------------------------------------------------------------------
// Zoned day boundaries

interface LocalDate {
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  /** 1–31. */
  readonly day: number;
}

function zonedParts(atMs: number, timezone: string) {
  if (!Number.isFinite(atMs)) return null;
  return parseZonedInstant(new Date(atMs).toISOString(), timezone);
}

/** The local calendar date as a comparable number, for ordering days only. */
function localDayNumber(date: LocalDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

/**
 * The first instant of a named event-local calendar date.
 *
 * Found by bisection rather than by adding an offset, because the offset is the
 * thing in question: on a spring-forward day the local midnight an offset would
 * produce does not exist, and on a fall-back day two instants claim it. Local
 * time is monotonic in UTC time, so the earliest instant whose local date has
 * reached the target *is* the start of that day under every transition — the
 * transition instant itself where midnight was skipped, the earlier of the two
 * where it repeated.
 */
export function startOfLocalDate(date: LocalDate, timezone: string): number | null {
  const target = localDayNumber(date);
  if (!Number.isFinite(target)) return null;
  // Offsets span -12h…+14h, so local midnight lies within ±15h of the same
  // wall value read as UTC. The 26h bracket clears that with room to spare.
  let before = target - 26 * HOUR_MS;
  let onOrAfter = target + 26 * HOUR_MS;

  const reached = (atMs: number): boolean | null => {
    const parts = zonedParts(atMs, timezone);
    if (parts === null) return null;
    return localDayNumber(parts) >= target;
  };

  const low = reached(before);
  const high = reached(onOrAfter);
  if (low === null || high === null) return null;
  // A bracket that does not bracket means the zone is not behaving like a zone.
  if (low || !high) return null;

  // Down to the millisecond, not to the minute the formatter resolves: every
  // instant inside the boundary minute already reads as the new local day, so
  // the bisection lands on the transition itself rather than near it — and a
  // "start of day" that is 42 seconds off is a boundary two counts can
  // disagree across.
  while (onOrAfter - before > 1) {
    const mid = before + Math.floor((onOrAfter - before) / 2);
    const hit = reached(mid);
    if (hit === null) return null;
    if (hit) onOrAfter = mid;
    else before = mid;
  }
  return onOrAfter;
}

/** The first instant of the event-local day containing `atMs`. */
export function startOfZonedDay(atMs: number, timezone: string): number | null {
  const parts = zonedParts(atMs, timezone);
  if (parts === null) return null;
  return startOfLocalDate(parts, timezone);
}

/** A calendar date shifted by whole days, with no zone or clock involved. */
function shiftDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
}

/**
 * The first instant of the event-local week containing `atMs`.
 *
 * Monday, because that is the week an organizer plans in: a Mon–Sun window
 * keeps a working week whole, where a Sunday start cuts it in the middle.
 */
export function startOfZonedWeek(atMs: number, timezone: string): number | null {
  const parts = zonedParts(atMs, timezone);
  if (parts === null) return null;
  // `weekday` is 0 = Sunday; Monday is the week's first day here.
  const sinceMonday = (parts.weekday + 6) % 7;
  return startOfLocalDate(shiftDays(parts, -sinceMonday), timezone);
}

// ---------------------------------------------------------------------------
// Cadence and window

function instantMs(value: string): number | null {
  // `Date.parse` invents dates for prose ("Jul 2" parses), so the shape is
  // checked before the value is trusted.
  if (!/^\d{4}-/.test(value)) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

function readInstants(values: readonly string[]): number[] {
  const out: number[] = [];
  for (const value of values) {
    const at = instantMs(value);
    if (at !== null) out.push(at);
  }
  return out;
}

/**
 * Does this person work here daily? Measured as distinct event-local days
 * carrying a visit across the last seven, today included — a count of *days*
 * rather than of visits, so six tab-switches in one afternoon is still one day
 * of habit.
 */
export function visitsDaily(input: {
  readonly visits: readonly string[];
  readonly timezone: string;
  readonly now: number;
}): boolean {
  const todayStart = startOfZonedDay(input.now, input.timezone);
  if (todayStart === null) return false;
  const floor = todayStart - 6 * DAY_MS;
  const days = new Set<number>();
  for (const at of readInstants(input.visits)) {
    if (at < floor || at > input.now) continue;
    const parts = zonedParts(at, input.timezone);
    if (parts !== null) days.add(localDayNumber(parts));
  }
  return days.size >= DAILY_CADENCE_DAYS;
}

/**
 * The window this operator's diff is measured over. Null when the zone cannot
 * be read — a surface that cannot say whose midnight it means says nothing.
 *
 * `visits` are the operator's *previous* entries to the surface, in any order;
 * the current visit is not one of them.
 */
export function chooseArrivalWindow(input: {
  readonly visits: readonly string[];
  readonly timezone: string;
  readonly now: number;
}): ArrivalWindow | null {
  const weekStart = startOfZonedWeek(input.now, input.timezone);
  if (weekStart === null) return null;

  const visits = readInstants(input.visits).filter((at) => at <= input.now);
  const lastVisit = visits.length > 0 ? Math.max(...visits) : null;

  // Away since before this week: neither calendar window covers the gap, and
  // the gap is the thing they missed. Widening is the only direction this
  // branch can move the boundary.
  if (lastVisit !== null && lastVisit < weekStart) {
    return Object.freeze({
      kind: 'since-visit' as const,
      startsAt: new Date(lastVisit).toISOString()
    });
  }

  if (visitsDaily(input)) {
    const todayStart = startOfZonedDay(input.now, input.timezone);
    if (todayStart !== null) {
      return Object.freeze({
        kind: 'today' as const,
        startsAt: new Date(todayStart).toISOString()
      });
    }
  }
  return Object.freeze({ kind: 'week' as const, startsAt: new Date(weekStart).toISOString() });
}

// ---------------------------------------------------------------------------
// Counting

/**
 * The pulse over a set of arrival instants. `arrivals` is the population the
 * figures speak for — a caller that excludes spam rows from the total must
 * exclude them here too, or the header and the breakdown disagree.
 */
export function summarizeArrivals(input: {
  readonly arrivals: readonly string[];
  readonly visits: readonly string[];
  readonly timezone: string;
  readonly now: number;
  readonly weeks?: number;
}): ArrivalPulse | null {
  const window = chooseArrivalWindow(input);
  if (window === null) return null;
  const windowStart = instantMs(window.startsAt);
  const currentWeekStart = startOfZonedWeek(input.now, input.timezone);
  if (windowStart === null || currentWeekStart === null) return null;

  const currentWeekParts = zonedParts(currentWeekStart, input.timezone);
  if (currentWeekParts === null) return null;

  const weekCount = Math.max(1, Math.trunc(input.weeks ?? ARRIVAL_WEEKS));
  const starts: number[] = [];
  for (let index = weekCount - 1; index >= 0; index -= 1) {
    const start = startOfLocalDate(shiftDays(currentWeekParts, -7 * index), input.timezone);
    if (start === null) return null;
    starts.push(start);
  }

  const counts = new Array<number>(starts.length).fill(0);
  const arrivals = readInstants(input.arrivals);
  let inWindow = 0;
  for (const at of arrivals) {
    if (at >= windowStart && at <= input.now) inWindow += 1;
    // Newest bucket first: an arrival belongs to the last week that started
    // before it. Anything older than the oldest bucket is in `total` only.
    for (let index = starts.length - 1; index >= 0; index -= 1) {
      if (at >= starts[index]!) {
		counts[index] = (counts[index] ?? 0) + 1;
        break;
      }
    }
  }

  return Object.freeze({
    window,
    inWindow,
    total: arrivals.length,
    weeks: Object.freeze(
      starts.map((start, index) =>
        Object.freeze({ startsAt: new Date(start).toISOString(), count: counts[index]! })
      )
    )
  });
}

// ---------------------------------------------------------------------------
// Words

export interface ArrivalPulsePresentation {
  /** The window as a phrase that ends a sentence: `today`, `this week`. */
  readonly noun: string;
  /** The delta a surface renders as its chip: `+3 today`. Empty at zero. */
  readonly delta: string;
  /** What replaces the chip at zero: `Nothing new today`. */
  readonly quiet: string;
  /** The window in a full sentence, for the disclosure that explains it. */
  readonly caption: string;
}

const WINDOW_NOUN: Readonly<Record<ArrivalWindowKind, string>> = Object.freeze({
  today: 'today',
  week: 'this week',
  'since-visit': 'since your last visit'
});

/**
 * The pulse in the product's words. The noun is deliberately the same phrase in
 * the chip and in the caption: a reader who sees `+3 today` and then opens the
 * breakdown must meet the same window, not a second wording of it.
 */
export function describeArrivalPulse(input: {
  readonly pulse: ArrivalPulse;
  readonly timezone: string;
  readonly now: number;
}): ArrivalPulsePresentation {
  const kind = input.pulse.window.kind;
  const noun = WINDOW_NOUN[kind];
  const count = input.pulse.inWindow;
  const delta = count === 0 ? '' : `+${count} ${noun}`;
  const quiet = kind === 'since-visit' ? 'Nothing new since your last visit' : `Nothing new ${noun}`;

  const since = formatRelative(input.pulse.window.startsAt, input.now, {
    timezone: input.timezone,
    fallback: ''
  });
  const caption =
    kind === 'since-visit'
      ? since === ''
        ? 'Counted since your last visit.'
        : `Counted since your last visit, ${since}.`
      : kind === 'today'
        ? 'You are here most days, so the count is today’s.'
        : 'Counted from Monday. It widens to cover a longer absence.';

  return Object.freeze({ noun, delta, quiet, caption });
}

export interface ArrivalWeekPresentation {
  /** `10–16 Aug` — the week's span, in the one date vocabulary. */
  readonly range: string;
  /** `This week`, `Last week`, `3 weeks ago`. */
  readonly relative: string;
  readonly current: boolean;
}

/** A week bucket as a breakdown row names it. Null when the zone cannot be read. */
export function describeArrivalWeek(input: {
  readonly week: ArrivalWeek;
  readonly timezone: string;
  readonly now: number;
}): ArrivalWeekPresentation | null {
  const start = zonedParts(instantMs(input.week.startsAt) ?? NaN, input.timezone);
  if (start === null) return null;
  const end = shiftDays(start, 6);
  const range = formatDateRange(
    `${pad4(start.year)}-${pad2(start.month)}-${pad2(start.day)}`,
    `${pad4(end.year)}-${pad2(end.month)}-${pad2(end.day)}`,
    { year: false, fallback: '' }
  );

  const currentStart = startOfZonedWeek(input.now, input.timezone);
  const weekStart = instantMs(input.week.startsAt);
  let relative = '';
  let current = false;
  if (currentStart !== null && weekStart !== null) {
    const back = Math.round((currentStart - weekStart) / (7 * DAY_MS));
    current = back === 0;
    relative = back === 0 ? 'This week' : back === 1 ? 'Last week' : `${back} weeks ago`;
  }
  return Object.freeze({ range, relative, current });
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function pad4(value: number): string {
  return String(value).padStart(4, '0');
}
