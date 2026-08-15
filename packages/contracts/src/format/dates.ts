/**
 * The one date vocabulary. Every human-facing date, time, range, and countdown
 * in JooEvents is spelled here — the operator app, the participant portal, the
 * public surfaces, and the outbound email layer alike. A seventeenth local
 * formatter is a review defect, not a shortcut.
 *
 * It lives in `@jooevents/contracts` rather than the web app because human
 * dates are produced outside the browser too: an email body is assembled on the
 * server, and a date that reads one way in the sidebar and another way in the
 * message about it is the same defect twice. The module is therefore pure —
 * no DOM, no framework, no I/O, no ambient clock. Callers pass `now`.
 *
 * ## The shape
 *
 * Day-first, abbreviated month, no punctuation clutter: **`20 Aug 2027`**.
 * Never a machine format in a human surface — no ISO dashes, no slashes, no
 * American month-first ordering. Ranges collapse what is redundant
 * (`15–17 Sep 2027`, `30 Sep – 2 Oct 2027`, both years only when the range
 * crosses one) and never wrap mid-span, because half a date on each line is
 * two wrong dates.
 *
 * ## Which variant belongs where
 *
 * | Context | Call | Reads |
 * | --- | --- | --- |
 * | Event identity, a day with no clock | {@link formatDate} | `20 Aug 2027` |
 * | Event span, anything with two ends | {@link formatDateRange} | `18–20 Mar 2027` |
 * | Schedule gutter, session card | {@link formatClock}, {@link formatClockRange} | `09:30`, `09:30–10:15` |
 * | Schedule day tab | {@link formatDate}, `weekday`, `year: false` | `Thu 18 Mar` |
 * | A stored instant's calendar day | {@link formatInstantDate} | `20 Aug 2027` |
 * | A stored instant in full | {@link formatInstant} | `20 Aug 2027 · 09:30 EDT` |
 * | Recency — arrived, opened, last seen | {@link describeRecency} | `6 hours ago` (+ absolute) |
 * | A deadline stored as an instant | {@link describeDeadline} | `Fri 20 Aug 2027 · 23:59 EDT` |
 * | A deadline stored as a calendar date | {@link describeCalendarDeadline} | same, from `displayDate` |
 *
 * The weekday prefix is **opt-in**: it belongs where knowing the day of week
 * changes what a person does — a schedule, a deadline — and is noise anywhere
 * else. The two deadline describers turn it on by default for exactly that
 * reason; every plain formatter leaves it off.
 *
 * Pick the deadline describer by how the deadline is *stored*, not by how it
 * looks. The catalog keeps a calendar date plus an **end-exclusive** boundary
 * instant, so formatting that instant directly names the following midnight and
 * moves every deadline in the product a day later;
 * {@link describeCalendarDeadline} is the one that does not.
 *
 * ## Timezone is not decoration
 *
 * A clock without a zone is a clock a reader in another zone will act on
 * wrongly, and that is the failure this module exists to prevent. Whenever a
 * time of day is shown, **the event's timezone is the authority** — never the
 * browser's, never UTC-because-it-was-easy. Relative distance is measured in
 * that zone too: "today" means today where the event is, so an organizer in
 * Auckland and one in Helsinki reading the same row see the same word.
 *
 * ## Saying so to a displaced reader
 *
 * The authority being the event's zone is exactly what makes a bare clock a
 * trap for someone reading from elsewhere, so a surface can ask for the zone to
 * be named — {@link ZoneDisplay}, `never` by default, `auto` when the reader is
 * demonstrably somewhere else, `always` where the answer must not depend on
 * knowing where they are. Three rules hold it together:
 *
 * - **The viewer's zone is an input.** This module never asks `Intl` where the
 *   host is. It runs on a server assembling an email and in a browser rendering
 *   a row, and a formatter that read the ambient zone would make the same data
 *   render differently depending on which machine happened to run it. Absent
 *   `viewerTimezone` means *unknown*, and `auto` shows nothing.
 * - **Difference is offsets, not names.** Europe/Berlin and Europe/Paris are
 *   two names for one clock; marking that is noise. Two zones differ when their
 *   UTC offset **at that instant** differs — so a marker can correctly appear
 *   in July and vanish in January when one side keeps DST and the other does
 *   not. Every offset comes from `Intl` `shortOffset`; hand-rolled offset
 *   arithmetic is a defect even when its tests pass.
 * - **The marker is the place, the offset is the precision.** `New York` is
 *   read instantly; `GMT-4` makes a person do arithmetic to recover the same
 *   fact, and abbreviations are worse than both (`CST` names three zones, and
 *   many zones have none). The city is already in the IANA identifier, so
 *   {@link describeZoneMarker} takes it from there — and falls back to the
 *   offset only for identifiers that name no place (`UTC`, `Etc/GMT+5`). The
 *   full identity — city, identifier, and offset together — reaches the
 *   descriptors' accessible text and `title`, never the `title` alone, because
 *   a `title` does not exist on a touch device.
 *
 * Note the asymmetry, which is deliberate: *whether* to show the marker is
 * decided by comparing offsets, *what* it says is the place. Those are two
 * different questions and this module answers them differently.
 *
 * ## Scannability is half the requirement
 *
 * - Dates that stack in a column take {@link DATE_CLASS}`.column` so digits
 *   align and the eye can run down them.
 * - Inside a date line the date is the value at normal-to-medium weight
 *   ({@link DATE_CLASS}`.value`); its qualifier — "Due", "Closes", "Opened" —
 *   is a label at lower ink ({@link DATE_CLASS}`.label`). Bolding the whole
 *   line emphasises nothing.
 * - A deadline carries its **state** — overdue, due soon, upcoming, passed —
 *   in the semantic tone vocabulary and **always with a word**. Colour is never
 *   the only carrier. Settled and passed dates recede to quiet ink while live
 *   ones hold normal ink; that contrast is what lets a reader see what needs
 *   action without reading every row.
 *
 * ## Absence
 *
 * Nothing here ever renders `Invalid Date`, an empty string, or a raw ISO
 * string as a fallback. The plain formatters take a `fallback` and default it
 * to {@link NO_DATE}; the describers return `null` so the surface can name its
 * own reason ("No deadline set", "Never opened") rather than shrugging with a
 * dash. An absent measurement names the reason, not the absence.
 */

// ---------------------------------------------------------------------------
// Vocabulary

/** Non-breaking space. Inside a date so a span never breaks across two lines. */
const NBSP = ' ';
/** A true en dash — the range separator. Never a hyphen, never a tilde. */
const EN_DASH = '–';
/** U+2060: binds the dash to its neighbours so a span never breaks mid-range. */
const WORD_JOINER = '⁠';
/** The open end of a range whose other end is not known. */
const ELLIPSIS = '…';
/** The join between a date and its clock. */
const MIDDOT = '·';
/** The join between an absolute date and its distance from now. */
const EM_DASH = '—';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MINUTES_PER_DAY = 1_440;

/** Below this, distance is told in clock units; above it, in calendar days. */
const CALENDAR_DISTANCE_FLOOR_MS = 22 * HOUR_MS;

/** How close a deadline must be before it reads as `Due soon` rather than `Upcoming`. */
export const DEFAULT_DUE_SOON_HOURS = 48;

const MONTHS: readonly string[] = Object.freeze([
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
]);

const WEEKDAYS: readonly string[] = Object.freeze([
  'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'
]);

/**
 * What a surface says when it was handed nothing readable. Prefer naming the
 * real reason at the call site — "No deadline set" answers the reader's
 * question, and this does not.
 */
export const NO_DATE = 'No date';

/** The clock equivalent of {@link NO_DATE}. */
export const NO_TIME = 'No time';

/**
 * The class vocabulary for the scannability rules above. Class *names* rather
 * than styles, because this module is framework-free and the same names have
 * to be reachable from Svelte markup and from a server-rendered email body.
 * The definitions live in `apps/web/src/lib/format/dates.css`.
 */
export const DATE_CLASS = Object.freeze({
  /** A date that stacks in a column: tabular figures, one unbreakable span. */
  column: 'je-date-column',
  /** The date itself — the value, at normal-to-medium weight. */
  value: 'je-date-value',
  /** Its qualifier ("Due", "Closes", "Opened") — a label, at lower ink. */
  label: 'je-date-label',
  /**
   * The zone marker (`New York`) — the same muted rung as the label, because it
   * qualifies the clock rather than being part of the value a person reads.
   */
  zone: 'je-date-zone',
  /** Settled or passed: recedes to quiet ink beside the live rows. */
  quiet: 'je-date-quiet'
});

/**
 * The subset of the product's closed status-tone vocabulary a date can take.
 * Assignable to the shared badge primitive's `tone` without translation.
 */
export type DateTone = 'neutral' | 'info' | 'warning' | 'danger';

/** Ink weight: live dates hold the row's ink, settled ones step back from it. */
export type DateInk = 'normal' | 'quiet';

/**
 * What a reader has to decide about a deadline. `passed` is the settled case —
 * the thing it gated is closed, so nothing is owed; `overdue` is the same clock
 * position with the obligation still open.
 */
export type DeadlineState = 'overdue' | 'due-soon' | 'upcoming' | 'passed';

export interface DeadlineStateDescriptor {
  readonly state: DeadlineState;
  /** Always rendered. State is never carried by colour alone. */
  readonly word: string;
  readonly tone: DateTone;
  readonly ink: DateInk;
}

const DEADLINE_STATES: Readonly<Record<DeadlineState, DeadlineStateDescriptor>> = Object.freeze({
  overdue: Object.freeze({ state: 'overdue', word: 'Overdue', tone: 'danger', ink: 'normal' }),
  'due-soon': Object.freeze({ state: 'due-soon', word: 'Due soon', tone: 'warning', ink: 'normal' }),
  upcoming: Object.freeze({ state: 'upcoming', word: 'Upcoming', tone: 'neutral', ink: 'normal' }),
  passed: Object.freeze({ state: 'passed', word: 'Passed', tone: 'neutral', ink: 'quiet' })
});

/** The word, tone, and ink a deadline state renders with. */
export function deadlineStateDescriptor(state: DeadlineState): DeadlineStateDescriptor {
  return DEADLINE_STATES[state];
}

// ---------------------------------------------------------------------------
// Parsing

export interface CalendarDayParts {
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  /** 1–31. */
  readonly day: number;
  /** 0 = Sunday. */
  readonly weekday: number;
}

export interface ZonedInstantParts extends CalendarDayParts {
  /** 0–23, in the requested zone. */
  readonly hour: number;
  /** 0–59, in the requested zone. */
  readonly minute: number;
  /** The zone as that zone names itself: `EDT`, `GMT+5:30`, `UTC`. */
  readonly zoneName: string;
  /** Epoch milliseconds — the instant itself, zone-independent. */
  readonly epochMs: number;
  /** Canonical RFC 3339 UTC bytes, for a machine-readable `datetime`. */
  readonly machine: string;
}

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const CLOCK_PATTERN = /^(\d{1,2}):(\d{2})$/u;
const INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/u;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * A calendar date with no zone attached — an event day, a form close date, a
 * deadline's `displayDate`. Rejects anything that is not a real day, so
 * `2027-02-30` is absent rather than silently rolled into March, while
 * `2028-02-29` parses.
 */
export function parseCalendarDate(value: unknown): CalendarDayParts | null {
  if (typeof value !== 'string') return null;
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() + 1 !== month
    || probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day, weekday: probe.getUTCDay() };
}

/**
 * `HH:MM` as minutes since midnight. `24:00` is accepted as the end of a day
 * because a schedule's closing boundary is legitimately written that way.
 */
export function parseClockMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = CLOCK_PATTERN.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes !== 0)) return null;
  return hours * 60 + minutes;
}

/**
 * Instants are parsed strictly rather than handed to `Date.parse`, which
 * accepts `"2027"` and `"Aug 20 2027"` and would let a malformed value render
 * as a confident wrong date.
 */
function parseInstantMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  if (!INSTANT_PATTERN.test(value)) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timezone: string): Intl.DateTimeFormat | null {
  const cached = zonedFormatters.get(timezone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      // Not `hour12: false`: that resolves to the `h24` cycle on some ICU
      // builds and renders midnight as `24:00`.
      hourCycle: 'h23',
      timeZoneName: 'short'
    });
  } catch {
    return null;
  }
  // IANA holds a few hundred zones; anything past this is malformed input
  // churning the cache rather than a real working set.
  if (zonedFormatters.size >= 512) zonedFormatters.clear();
  zonedFormatters.set(timezone, formatter);
  return formatter;
}

/**
 * An instant resolved into a named zone's wall clock. Null when either the
 * instant or the zone cannot be read — the caller decides what to say instead.
 */
export function parseZonedInstant(instant: unknown, timezone: unknown): ZonedInstantParts | null {
  const epochMs = parseInstantMs(instant);
  if (epochMs === null) return null;
  if (typeof timezone !== 'string' || timezone.length === 0) return null;
  const formatter = zonedFormatter(timezone);
  if (formatter === null) return null;

  const collected = new Map<string, string>();
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    collected.set(part.type, part.value);
  }
  const year = Number(collected.get('year'));
  const month = Number(collected.get('month'));
  const day = Number(collected.get('day'));
  const hour = Number(collected.get('hour'));
  const minute = Number(collected.get('minute'));
  const zoneName = collected.get('timeZoneName') ?? '';
  if (![year, month, day, hour, minute].every(Number.isInteger) || zoneName === '') return null;

  // Weekday from the zone-local calendar date, not from an ICU weekday token:
  // one arithmetic rule instead of a locale lookup that could disagree.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return {
    year,
    month,
    day,
    weekday,
    hour,
    minute,
    zoneName,
    epochMs,
    machine: new Date(epochMs).toISOString()
  };
}

// ---------------------------------------------------------------------------
// Assembly

function monthName(month: number): string | null {
  return MONTHS[month - 1] ?? null;
}

function weekdayName(weekday: number): string | null {
  return WEEKDAYS[weekday] ?? null;
}

/** `20 Aug 2027`, held together so it cannot break across a line. */
function dayText(parts: CalendarDayParts, weekday: boolean, year = true): string | null {
  const month = monthName(parts.month);
  if (month === null) return null;
  const tail = year ? `${NBSP}${parts.year}` : '';
  const body = `${parts.day}${NBSP}${month}${tail}`;
  if (!weekday) return body;
  const name = weekdayName(parts.weekday);
  return name === null ? body : `${name}${NBSP}${body}`;
}

/** `20 Aug` — the trailing year is carried by the other end of a range. */
function dayMonthText(parts: CalendarDayParts, weekday: boolean): string | null {
  const month = monthName(parts.month);
  if (month === null) return null;
  const body = `${parts.day}${NBSP}${month}`;
  if (!weekday) return body;
  const name = weekdayName(parts.weekday);
  return name === null ? body : `${name}${NBSP}${body}`;
}

/** `Wed 15` — inside a same-month range, where the month is said once at the end. */
function weekdayDayText(parts: CalendarDayParts): string {
  const name = weekdayName(parts.weekday);
  return name === null ? String(parts.day) : `${name}${NBSP}${parts.day}`;
}

function clockText(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}

// ---------------------------------------------------------------------------
// Calendar dates

export interface DateOptions {
  /**
   * Prefix the day of week. Opt in where it changes what a person does — a
   * schedule tab, a deadline — and leave it off everywhere else.
   */
  readonly weekday?: boolean;
  /**
   * Drop the year. Only where the surrounding surface already fixes it beyond
   * doubt — the day tabs inside one event's schedule, where every tab would
   * otherwise repeat the same four digits. Never in a list that can span years,
   * and never as a way to save space in a column a reader might sort or export.
   */
  readonly year?: boolean;
  /** What to say when the input cannot be read. Name the real reason. */
  readonly fallback?: string;
}

/** `20 Aug 2027`, or `Fri 20 Aug 2027` with `weekday`. */
export function formatDate(date: unknown, options: DateOptions = {}): string {
  const fallback = options.fallback ?? NO_DATE;
  const parts = parseCalendarDate(date);
  if (parts === null) return fallback;
  return dayText(parts, options.weekday === true, options.year !== false) ?? fallback;
}

/**
 * A span with its redundancy collapsed:
 *
 * - one day — `20 Aug 2027`
 * - same month — `15–17 Sep 2027`
 * - same year — `30 Sep – 2 Oct 2027`
 * - across years — `30 Dec 2026 – 2 Jan 2027`
 *
 * `weekday` suppresses the day-number collapse, since `Wed 15–Fri 17` reads as
 * neither one date nor two: it becomes `Wed 15 – Fri 17 Sep 2027`.
 *
 * An end before its start is a data defect, and collapsing it would imply an
 * ordering the data does not have — so both ends are spelled in full and the
 * reader can see exactly what is stored.
 */
export function formatDateRange(start: unknown, end: unknown, options: DateOptions = {}): string {
  const fallback = options.fallback ?? NO_DATE;
  const from = parseCalendarDate(start);
  const to = parseCalendarDate(end);
  if (from === null && to === null) return fallback;
  // One end missing is not a one-day event: saying `15 Sep 2027` for a range
  // whose other end is unknown states something the data does not support.
  // The open side is shown as open.
  if (from === null) return `${ELLIPSIS}${NBSP}${EN_DASH}${NBSP}${formatDate(end, options)}`;
  if (to === null) return `${formatDate(start, options)}${NBSP}${EN_DASH}${NBSP}${ELLIPSIS}`;

  const weekday = options.weekday === true;
  // A cross-year range keeps its years whatever was asked: `30 Dec – 2 Jan`
  // without them is not a shorter range, it is a different one.
  const year = options.year !== false || from.year !== to.year;
  const full = (parts: CalendarDayParts): string | null => dayText(parts, weekday, year);
  const partial = (parts: CalendarDayParts): string | null => dayMonthText(parts, weekday);
  const joined = (left: string | null, right: string | null): string =>
    left === null || right === null
      ? fallback
      : `${left}${NBSP}${EN_DASH}${NBSP}${right}`;

  const sameYear = from.year === to.year;
  const sameMonth = sameYear && from.month === to.month;
  const ordered = from.year < to.year
    || (from.year === to.year
      && (from.month < to.month || (from.month === to.month && from.day <= to.day)));

  if (sameMonth && from.day === to.day) return full(from) ?? fallback;
  if (!ordered) return joined(full(from), full(to));

  if (sameMonth) {
    // The month is still said once, at the end — only the day numbers stop
    // being a bare numeric span once each carries a weekday.
    if (weekday) return joined(weekdayDayText(from), full(to));
    const month = monthName(from.month);
    if (month === null) return fallback;
    // `15–17 Sep 2027`: the dash binds the two day numbers, unspaced, because
    // they are two ends of one number range rather than two dates.
    const tail = year ? `${NBSP}${from.year}` : '';
    // The dash is wrapped in word-joiners: U+2013 is line-break class BA, so a
    // bare one lets `15–` sit at the end of a line with `17 Sep 2027` on the
    // next. Every other join in this module already refuses to break.
    return `${from.day}${WORD_JOINER}${EN_DASH}${WORD_JOINER}${to.day}${NBSP}${month}${tail}`;
  }
  if (sameYear) return joined(partial(from), full(to));
  return joined(full(from), full(to));
}

// ---------------------------------------------------------------------------
// Clocks

export interface ClockOptions {
  /** What to say when the input cannot be read. */
  readonly fallback?: string;
}

/**
 * `09:30` from minutes since the day's midnight. 24-hour throughout the
 * product: a schedule read at a glance should not also be read for `am`/`pm`.
 * Offsets past midnight wrap, so a session running to `25:15` reads `01:15`.
 */
export function formatClock(minutesSinceMidnight: unknown, options: ClockOptions = {}): string {
  const fallback = options.fallback ?? NO_TIME;
  if (typeof minutesSinceMidnight !== 'number' || !Number.isFinite(minutesSinceMidnight)) {
    return fallback;
  }
  const total = Math.trunc(minutesSinceMidnight);
  const wrapped = ((total % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return clockText(Math.floor(wrapped / 60), wrapped % 60);
}

/** `09:30–10:15`, held together so the span never breaks across a line. */
export function formatClockRange(
  startMinutes: unknown,
  endMinutes: unknown,
  options: ClockOptions = {}
): string {
  const fallback = options.fallback ?? NO_TIME;
  const from = formatClock(startMinutes, { fallback: '' });
  const to = formatClock(endMinutes, { fallback: '' });
  if (from === '' && to === '') return fallback;
  if (from === '') return to;
  if (to === '') return from;
  return `${from}${EN_DASH}${to}`;
}

// ---------------------------------------------------------------------------
// The viewer's zone

/**
 * Whether a clock names the zone it is told in.
 *
 * - `never` — the default. Nothing sprays zone markers by accident; a surface
 *   opts in deliberately.
 * - `auto` — name it only when the reader is demonstrably somewhere else, which
 *   requires a `viewerTimezone` and an offset that differs at that instant.
 *   Unknown reader means no marker: this module will not guess where they are.
 * - `always` — name it regardless. The honest choice wherever the reader cannot
 *   be known at render time (an email body, a public page served from cache) or
 *   where the clock is the record rather than a glance.
 */
export type ZoneDisplay = 'never' | 'auto' | 'always';

/**
 * A zone said two ways, because a marker and a record are different jobs.
 *
 * The surface renders {@link short} beside the clock at muted weight and puts
 * {@link complete} where a reader who needs the exact zone can reach it —
 * accessible text, and a `title` in addition to (never instead of) that.
 */
export interface ZoneMarker {
  /**
   * The humanised place from the IANA identifier — `New York`, `Kolkata`,
   * `Buenos Aires` — or `''` where the identifier names no place. Its internal
   * space is non-breaking, like every other space in this module.
   */
  readonly place: string;
  /** The identifier as given: `America/New_York`. Never rewritten. */
  readonly timezone: string;
  /** The offset at that instant, exactly as `Intl` spells it: `GMT-4`, `GMT+5:30`. */
  readonly offset: string;
  /**
   * What the surface shows: the place, or the offset where there is no place.
   * A qualifier, not the value — the clock is the value.
   */
  readonly short: string;
  /**
   * `New York GMT-4` — for a surface with room where the size of the delta is
   * itself what the reader is weighing. Falls back to the offset alone rather
   * than repeating it.
   */
  /**
   * `New York (America/New_York), GMT-4` — city, identifier, and offset in one
   * string. The form that must reach anyone who has to act on the clock.
   */
  readonly complete: string;
}

export interface ZoneMarkerOptions {
  /**
   * Where the *reader* is, as an IANA identifier. Always an input: this module
   * runs server-side and must never ask `Intl` where its host is. Absent — or
   * explicitly `undefined`, which is a value a caller genuinely holds — means
   * unknown, and `auto` then shows nothing.
   */
  readonly viewerTimezone?: string | undefined;
  /**
   * Defaults to `auto` here, unlike the formatters, which default to `never`:
   * reaching for this function is itself the opt-in, while a formatter is
   * called by surfaces that never asked about zones at all.
   */
  readonly zone?: ZoneDisplay;
}

/** What a caller actually asked for, once the legacy boolean is folded in. */
type ZoneSetting = ZoneDisplay | 'legacy';

/**
 * `zone: true` predates the marker and means "append the zone's own short
 * name" — `EDT`, `GMT+5:30`. It is kept working byte for byte because surfaces
 * outside this package render it today, but it is not the vocabulary: an
 * abbreviation is ambiguous worldwide and many zones have none. New callers
 * pass a {@link ZoneDisplay}.
 */
function zoneSetting(zone: boolean | ZoneDisplay | undefined, whenAbsent: ZoneSetting): ZoneSetting {
  if (zone === undefined) return whenAbsent;
  if (zone === true) return 'legacy';
  if (zone === false) return 'never';
  return zone;
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timezone: string): Intl.DateTimeFormat | null {
  const cached = offsetFormatters.get(timezone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      // `shortOffset` rather than `short`: the offset is a fact, an
      // abbreviation is a guess that a third of the world does not have.
      timeZoneName: 'shortOffset'
    });
  } catch {
    return null;
  }
  if (offsetFormatters.size >= 512) offsetFormatters.clear();
  offsetFormatters.set(timezone, formatter);
  return formatter;
}

/**
 * The zone's UTC offset at an instant, as `Intl` spells it. Null when the zone
 * cannot be read — a malformed identifier is answered with silence, never a
 * thrown `RangeError` reaching a render.
 */
function zoneOffsetText(epochMs: number, timezone: unknown): string | null {
  if (typeof timezone !== 'string' || timezone.length === 0) return null;
  const formatter = offsetFormatter(timezone);
  if (formatter === null) return null;
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    if (part.type === 'timeZoneName') return part.value;
  }
  return null;
}

const OFFSET_PATTERN = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/u;

/**
 * The offset in minutes, **parsed from what `Intl` said** rather than computed
 * here. The comparison needs a number and the display needs the string; asking
 * `Intl` for the value and reading it is not the same thing as deriving an
 * offset from a `Date`, which is the mistake `Etc/GMT+5` — offset `GMT-5` —
 * exists to punish.
 */
function offsetMinutes(text: string): number | null {
  const match = OFFSET_PATTERN.exec(text);
  if (match === null) return null;
  const sign = match[1];
  if (sign === undefined) return 0;
  const hours = Number(match[2] ?? '');
  const minutes = Number(match[3] ?? '0');
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  return (sign === '-' ? -1 : 1) * (hours * 60 + minutes);
}

/**
 * A place segment: letters, and the punctuation real IANA locations carry —
 * `Port-au-Prince`, `DumontDUrville`, `Buenos_Aires`. Anything with a digit or
 * a sign is an offset wearing a path, not a city.
 */
const PLACE_SEGMENT = /^[A-Za-z][A-Za-z_'-]*$/u;

/**
 * The city already sitting in the identifier: last segment, underscores to
 * spaces, nothing else touched. `America/Argentina/Buenos_Aires` is
 * `Buenos Aires`; `America/Sao_Paulo` is `Sao Paulo` and stays that way,
 * because inventing the diacritic would be inventing a name.
 *
 * `''` where there is no place to take. That is every identifier without an
 * area (`UTC`, `GMT`, `EST5EDT`, and the legacy country aliases like `Japan`,
 * which name a country rather than the city the vocabulary promises), and
 * everything under `Etc/`, which is offsets in path form.
 */
const NON_PLACE_AREAS: ReadonlySet<string> = new Set([
  // Legacy country/region aliases whose last segment is a compass direction or
  // a region, not a city: `US/Pacific` is not a place called Pacific.
  'etc', 'us', 'canada', 'brazil', 'chile', 'mexico', 'australia_legacy'
]);

function zonePlace(timezone: string): string {
  const segments = timezone.split('/');
  if (segments.length < 2) return '';
  const area = (segments[0] ?? '').toLowerCase();
  if (NON_PLACE_AREAS.has(area)) return '';
  const last = segments[segments.length - 1] ?? '';
  if (!PLACE_SEGMENT.test(last)) return '';
  return last.replace(/_/gu, NBSP);
}

function buildZoneMarker(epochMs: number, timezone: string): ZoneMarker | null {
  const offset = zoneOffsetText(epochMs, timezone);
  if (offset === null) return null;
  const place = zonePlace(timezone);
  return Object.freeze({
    place,
    timezone,
    offset,
    short: place === '' ? offset : place,
    complete: place === '' ? `${timezone}, ${offset}` : `${place} (${timezone}), ${offset}`
  });
}

/**
 * Whether two zones are different *for a reader*, which is a question about
 * clocks and not about names. Berlin and Paris are one clock under two names
 * and reading `Berlin` on a Paris screen teaches nothing; New York and Berlin
 * are six hours apart and reading nothing is how someone joins a call at 03:00.
 *
 * Unreadable on either side answers `false`: a marker we cannot justify is
 * worse than no marker, and a malformed viewer zone must degrade rather than
 * throw.
 */
function offsetsDiffer(epochMs: number, timezone: string, viewerTimezone: unknown): boolean {
  const here = zoneOffsetText(epochMs, timezone);
  const there = zoneOffsetText(epochMs, viewerTimezone);
  if (here === null || there === null) return false;
  const mine = offsetMinutes(here);
  const theirs = offsetMinutes(there);
  // Numbers when both parse, so `GMT` and `GMT+0` cannot read as two zones on
  // an ICU build that spells one of them the other way; the strings otherwise.
  if (mine === null || theirs === null) return here !== there;
  return mine !== theirs;
}

/**
 * The zone marker for an instant, or null when the surface should show none —
 * because the mode says so, because the reader is in the same offset, or
 * because something was unreadable.
 *
 * Use it directly where the clock and its zone are rendered apart: a schedule
 * whose times come from {@link formatClock} and whose zone belongs once in the
 * day header, or a column that states its zone in the heading instead of on
 * every row. The instant matters — an offset moves with DST, so the marker
 * belongs to a moment rather than to a zone.
 */
export function describeZoneMarker(
  instant: unknown,
  timezone: unknown,
  options: ZoneMarkerOptions = {}
): ZoneMarker | null {
  const epochMs = parseInstantMs(instant);
  if (epochMs === null) return null;
  if (typeof timezone !== 'string' || timezone.length === 0) return null;
  const mode = options.zone ?? 'auto';
  if (mode === 'never') return null;
  if (mode === 'auto' && !offsetsDiffer(epochMs, timezone, options.viewerTimezone)) return null;
  return buildZoneMarker(epochMs, timezone);
}

/**
 * What a composed line appends: the compact form for the visible string, the
 * complete identity for the accessible one, and the marker itself so a surface
 * can place and style it instead of parsing it back out of a sentence.
 */
interface ZoneSuffix {
  readonly short: string;
  readonly complete: string;
  readonly marker: ZoneMarker | null;
}

const NO_ZONE_SUFFIX: ZoneSuffix = Object.freeze({ short: '', complete: '', marker: null });

function zoneSuffix(
  parts: ZonedInstantParts,
  timezone: string,
  setting: ZoneSetting,
  viewerTimezone: string | undefined
): ZoneSuffix {
  if (setting === 'never') return NO_ZONE_SUFFIX;
  // The legacy boolean's abbreviation is not a marker and is not offered as
  // one: it goes into the visible string and nowhere else.
  if (setting === 'legacy') {
    return Object.freeze({ short: parts.zoneName, complete: parts.zoneName, marker: null });
  }
  const marker = describeZoneMarker(parts.machine, timezone, {
    zone: setting,
    viewerTimezone
  });
  if (marker === null) return NO_ZONE_SUFFIX;
  return Object.freeze({ short: marker.short, complete: marker.complete, marker });
}

function withSuffix(core: string, suffix: string): string {
  return suffix === '' ? core : `${core}${NBSP}${suffix}`;
}

// ---------------------------------------------------------------------------
// Instants

export interface InstantOptions extends DateOptions {
  /**
   * Name the zone the clock is told in. `never` by default; `auto` names it
   * only when {@link viewerTimezone} is in a different offset at that instant;
   * `always` names it regardless.
   *
   * `true` and `false` are the older spelling and still mean what they meant:
   * `true` appends the zone's own short name (`EDT`). Prefer `'always'`, which
   * appends the place instead.
   */
  readonly zone?: boolean | ZoneDisplay;
  /**
   * Where the reader is. An input, never detected here. See
   * {@link ZoneMarkerOptions.viewerTimezone}.
   */
  readonly viewerTimezone?: string | undefined;
}

/** The calendar day an instant falls on **in the event's zone**: `20 Aug 2027`. */
export function formatInstantDate(
  instant: unknown,
  timezone: unknown,
  options: DateOptions = {}
): string {
  const fallback = options.fallback ?? NO_DATE;
  const parts = parseZonedInstant(instant, timezone);
  if (parts === null) return fallback;
  return dayText(parts, options.weekday === true, options.year !== false) ?? fallback;
}

/** `20 Aug 2027 · 09:30` — the day and clock, before any zone is named. */
function instantCore(parts: ZonedInstantParts, weekday: boolean, year: boolean): string | null {
  const day = dayText(parts, weekday, year);
  if (day === null) return null;
  return `${day}${NBSP}${MIDDOT}${NBSP}${clockText(parts.hour, parts.minute)}`;
}

/**
 * `20 Aug 2027 · 09:30`, `20 Aug 2027 · 09:30 New York` with `zone: 'always'`,
 * or `20 Aug 2027 · 09:30 EDT` with the older `zone: true`.
 *
 * The clock is always the event's, never the reader's: an organizer in Helsinki
 * and a speaker in Auckland looking at the same submission must be looking at
 * the same wall clock, or one of them will miss it by a day. Naming the zone is
 * how the one who is elsewhere finds that out; `auto` does it only for readers
 * whose own clock actually disagrees.
 */
export function formatInstant(
  instant: unknown,
  timezone: unknown,
  options: InstantOptions = {}
): string {
  const fallback = options.fallback ?? NO_DATE;
  const parts = parseZonedInstant(instant, timezone);
  if (parts === null || typeof timezone !== 'string') return fallback;
  const core = instantCore(parts, options.weekday === true, options.year !== false);
  if (core === null) return fallback;
  const suffix = zoneSuffix(
    parts,
    timezone,
    zoneSetting(options.zone, 'never'),
    options.viewerTimezone
  );
  return withSuffix(core, suffix.short);
}

/**
 * How a zone names itself at a given instant — `EDT`, `GMT+5:30`, `UTC`.
 *
 * This is the older column-header answer and the engine behind `zone: true`.
 * For anything new prefer {@link describeZoneMarker}, which names the place
 * rather than an abbreviation that a third of the world's zones do not have and
 * that `CST` shares between three of them.
 *
 * This is the one function here that defaults to an empty fallback, because it
 * returns a fragment that gets appended rather than a date that gets read: an
 * unknown zone is better left unsaid than named wrongly.
 */
export function formatZoneLabel(
  instant: unknown,
  timezone: unknown,
  options: ClockOptions = {}
): string {
  const parts = parseZonedInstant(instant, timezone);
  return parts === null ? (options.fallback ?? '') : parts.zoneName;
}

// ---------------------------------------------------------------------------
// Distance from now

export interface RelativeOptions {
  /**
   * The zone whose calendar days "today", "tomorrow", and "3 days ago" are
   * counted in — the event's. Without it this module will not claim "today",
   * because it has no way to know whose today is meant; distances of a day and
   * over are then spelled numerically (`in 1 day`).
   */
  readonly timezone?: string;
  /** What to say when the instant cannot be read. */
  readonly fallback?: string;
}

const relativeAuto = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const relativeAlways = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

/** Days since the epoch **in a named zone**, so day boundaries are that zone's. */
function zonedDayNumber(epochMs: number, timezone: string): number | null {
  const parts = parseZonedInstant(new Date(epochMs).toISOString(), timezone);
  if (parts === null) return null;
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS);
}

function awayFromZero(value: number): number {
  const rounded = Math.round(Math.abs(value));
  return (value < 0 ? -1 : 1) * Math.max(1, rounded);
}

/**
 * `in 3 days`, `today`, `2 weeks ago`, `40 minutes ago`, `just now`.
 *
 * The unit is chosen by distance so the phrase stays one a person can hold:
 * clock units up to a day, then calendar days, then weeks, months, years once
 * precision has stopped meaning anything.
 *
 * A relative string is a convenience and never the only record of when
 * something happens — every caller keeps the absolute reachable, which is what
 * {@link describeRecency} and {@link describeDeadline} exist to make automatic.
 */
export function formatRelative(instant: unknown, now: number, options: RelativeOptions = {}): string {
  const fallback = options.fallback ?? NO_DATE;
  const at = parseInstantMs(instant);
  if (at === null || !Number.isFinite(now)) return fallback;

  const difference = at - now;
  const size = Math.abs(difference);
  const sign = difference < 0 ? -1 : 1;

  if (size < MINUTE_MS) return 'just now';
  if (size < HOUR_MS) return relativeAlways.format(sign * Math.round(size / MINUTE_MS), 'minute');
  if (size < CALENDAR_DISTANCE_FLOOR_MS) {
    return relativeAlways.format(sign * Math.round(size / HOUR_MS), 'hour');
  }

  const zone = options.timezone;
  let days: number | null = null;
  if (typeof zone === 'string' && zone.length > 0) {
    const target = zonedDayNumber(at, zone);
    const today = zonedDayNumber(now, zone);
    if (target !== null && today !== null) days = target - today;
  }
  const distance = days ?? awayFromZero(difference / DAY_MS);
  const magnitude = Math.abs(distance);

  // `today`, `tomorrow`, and `yesterday` are claims about a particular
  // midnight, so they are only sayable once a zone has named whose. Every
  // coarser unit stays numeric: `next week` is vaguer than the fact it hides.
  if (magnitude < 7) return (days === null ? relativeAlways : relativeAuto).format(distance, 'day');
  if (magnitude < 28) return relativeAlways.format(awayFromZero(distance / 7), 'week');
  if (magnitude < 365) return relativeAlways.format(awayFromZero(distance / 30), 'month');
  return relativeAlways.format(awayFromZero(distance / 365), 'year');
}

// ---------------------------------------------------------------------------
// Composed presentations

/**
 * A past-facing timestamp — arrived, opened, last seen. Relative is what the
 * row shows because that is the question ("is this fresh?"); the absolute
 * stays reachable on hover and to assistive tech, because a relative string
 * alone stops being a record of anything after two days.
 */
export interface RecencyPresentation {
  /** What the row renders: `6 hours ago`. */
  readonly relative: string;
  /** The record behind it: `20 Aug 2027 · 09:30 EDT`. */
  readonly absolute: string;
  /** Canonical UTC bytes for a `<time datetime>` attribute. */
  readonly machine: string;
  /**
   * Hover record — the absolute with the zone spelled in full, never the
   * relative repeated. Hover is not reachable on touch, so nothing lives here
   * that is not also in {@link accessibleText}.
   */
  readonly title: string;
  /** Accessible name carrying both, so the absolute is never screen-reader-only lost. */
  readonly accessibleText: string;
  /**
   * The zone marker when one is shown, so the surface can place and style it
   * rather than parse it back out of {@link absolute}. Null under the default,
   * which names no zone. See {@link DATE_CLASS}`.zone`.
   */
  readonly zoneMarker: ZoneMarker | null;
}

export interface RecencyInput {
  readonly at: string;
  /** The event's zone. Not the reader's. */
  readonly timezone: string;
  readonly now: number;
  /**
   * Where the reader is, for `zone: 'auto'`. An input, never detected here.
   */
  readonly viewerTimezone?: string | undefined;
  /**
   * How the zone is named. Absent keeps the long-standing behaviour — the
   * zone's own short name, `EDT` — because these strings are already rendered
   * that way; a {@link ZoneDisplay} switches the trailing slot to the marker
   * vocabulary, and `'never'` drops it altogether.
   */
  readonly zone?: boolean | ZoneDisplay;
}

/** Null when the instant or zone cannot be read — the surface names its own reason. */
export function describeRecency(input: RecencyInput): RecencyPresentation | null {
  const parts = parseZonedInstant(input.at, input.timezone);
  if (parts === null || !Number.isFinite(input.now)) return null;
  const core = instantCore(parts, false, true);
  if (core === null) return null;
  const suffix = zoneSuffix(
    parts,
    input.timezone,
    zoneSetting(input.zone, 'legacy'),
    input.viewerTimezone
  );
  const absolute = withSuffix(core, suffix.short);
  const complete = withSuffix(core, suffix.complete);
  const relative = formatRelative(input.at, input.now, { timezone: input.timezone });
  return Object.freeze({
    relative,
    absolute,
    machine: parts.machine,
    title: complete,
    accessibleText: `${relative} (${complete})`,
    zoneMarker: suffix.marker
  });
}

/**
 * A deadline as a reader has to act on it: what the moment is, how far away it
 * is, and — the half that decides whether they do anything — what state it is
 * in. Every field is rendered somewhere; none of them is decoration.
 */
export interface DeadlinePresentation {
  readonly state: DeadlineState;
  /** The state in words. Always rendered; colour is never the only carrier. */
  readonly stateWord: string;
  readonly tone: DateTone;
  /** `quiet` once the date is settled or passed, so live rows stand out. */
  readonly ink: DateInk;
  /** `Due`, `Closes`, `Opened` — a label at lower ink, `''` when unlabelled. */
  readonly label: string;
  /** The value: `Fri 20 Aug 2027 · 23:59 EDT`. */
  readonly absolute: string;
  /** The distance: `in 3 days`. */
  readonly relative: string;
  /**
   * Both halves on one line — `Closes Fri 20 Aug 2027 · 23:59 EDT — in 3 days`
   * — for a surface with room for a sentence but not for a stacked pair.
   * Neither half works alone: a date with no distance makes someone do
   * arithmetic, a countdown with no date leaves nothing to put in a calendar.
   */
  readonly text: string;
  /** Canonical UTC bytes for a `<time datetime>` attribute. */
  readonly machine: string;
  /**
   * Hover record: the label and the absolute, with the zone spelled in full.
   * Never the only carrier of the zone — a deadline is acted on from phones.
   */
  readonly title: string;
  /** One accessible sentence carrying label, absolute, zone, distance, and state. */
  readonly accessibleText: string;
  /**
   * The zone marker when one is shown, so the surface can place and style it
   * rather than parse it back out of {@link absolute}. Null under the default,
   * which names the zone the older way. See {@link DATE_CLASS}`.zone`.
   */
  readonly zoneMarker: ZoneMarker | null;
}

export interface DeadlineInput {
  /** The boundary instant. For a calendar deadline use {@link describeCalendarDeadline}. */
  readonly at: string;
  /** The event's zone — the authority on when this deadline actually falls. */
  readonly timezone: string;
  readonly now: number;
  /** `Due`, `Closes`, `Opened`. Omitted where the column heading already says it. */
  readonly label?: string;
  /**
   * The obligation is discharged — the round closed, the file arrived. A
   * settled deadline reads `Passed` and recedes rather than shouting `Overdue`
   * at someone who has nothing left to do.
   */
  readonly settled?: boolean;
  /** How near counts as near. Defaults to {@link DEFAULT_DUE_SOON_HOURS}. */
  readonly dueSoonHours?: number;
  /**
   * Deadlines are a planning context, so the weekday is on by default here —
   * "Friday" is what tells someone whether they have a working day left.
   */
  readonly weekday?: boolean;
  /** See {@link DateOptions.year}. A deadline almost always wants its year. */
  readonly year?: boolean;
  /**
   * Where the reader is, for `zone: 'auto'`. An input, never detected here —
   * and unknowable in an email, where `'always'` is the honest mode.
   */
  readonly viewerTimezone?: string | undefined;
  /**
   * How the zone is named. See {@link RecencyInput.zone}: absent keeps the
   * abbreviation these strings already carry, a {@link ZoneDisplay} switches to
   * the marker vocabulary.
   */
  readonly zone?: boolean | ZoneDisplay;
}

/**
 * Which of the four things a reader needs to know about this deadline.
 * `settled` wins over the clock: an obligation that has been met is passed,
 * not overdue.
 */
export function deadlineState(input: {
  readonly at: string;
  readonly now: number;
  readonly settled?: boolean;
  readonly dueSoonHours?: number;
}): DeadlineState | null {
  const at = parseInstantMs(input.at);
  if (at === null || !Number.isFinite(input.now)) return null;
  if (input.settled === true) return 'passed';
  if (input.now >= at) return 'overdue';
  const dueSoonHours = input.dueSoonHours ?? DEFAULT_DUE_SOON_HOURS;
  return at - input.now <= dueSoonHours * HOUR_MS ? 'due-soon' : 'upcoming';
}

function composeDeadline(
  absolute: string,
  complete: string,
  machine: string,
  relative: string,
  state: DeadlineState,
  label: string,
  marker: ZoneMarker | null
): DeadlinePresentation {
  const descriptor = deadlineStateDescriptor(state);
  const withLabel = (value: string): string => (label === '' ? value : `${label} ${value}`);
  const labelled = withLabel(absolute);
  // The visible line stays compact; the two forms a reader can reach without a
  // pointing device carry the zone in full.
  const labelledComplete = withLabel(complete);
  return Object.freeze({
    state,
    stateWord: descriptor.word,
    tone: descriptor.tone,
    ink: descriptor.ink,
    label,
    absolute,
    relative,
    text: `${labelled} ${EM_DASH} ${relative}`,
    machine,
    title: labelledComplete,
    accessibleText: `${labelledComplete}, ${relative}, ${descriptor.word}`,
    zoneMarker: marker
  });
}

/**
 * A deadline stored as an exact instant — a review round's close, a task's due
 * moment. Null when the instant or the zone cannot be read.
 */
export function describeDeadline(input: DeadlineInput): DeadlinePresentation | null {
  const parts = parseZonedInstant(input.at, input.timezone);
  const state = deadlineState(input);
  if (parts === null || state === null) return null;
  const core = instantCore(parts, input.weekday ?? true, input.year !== false);
  if (core === null) return null;
  const suffix = zoneSuffix(
    parts,
    input.timezone,
    zoneSetting(input.zone, 'legacy'),
    input.viewerTimezone
  );
  const relative = formatRelative(input.at, input.now, { timezone: input.timezone });
  return composeDeadline(
    withSuffix(core, suffix.short),
    withSuffix(core, suffix.complete),
    parts.machine,
    relative,
    state,
    input.label ?? '',
    suffix.marker
  );
}

export interface CalendarDeadlineInput extends Omit<DeadlineInput, 'at'> {
  /** The event-local calendar date the organizer set: `2027-08-20`. */
  readonly displayDate: string;
  /**
   * The canonical boundary instant, which the deadline profile defines as the
   * **first instant of the next** event-local date. It decides the state; it is
   * never what the reader is shown, because `21 Aug · 00:00` is not the day
   * anybody typed.
   */
  readonly effectiveAt: string;
  /** Drop the clock and show the day alone, for a space-constrained label. */
  readonly showTime?: boolean;
}

/**
 * A deadline stored the way the deadline catalog stores one: an event-local
 * calendar date plus an end-exclusive boundary instant.
 *
 * The reader is shown the **last moment they can act** — `Fri 20 Aug 2027 ·
 * 23:59 EDT` — assembled from `displayDate`, not from `effectiveAt`. Rendering
 * the boundary directly would name the following midnight and quietly move
 * every deadline in the product a day later. The boundary still decides the
 * state, so the state is exact even though the clock shown is the friendly
 * inclusive one.
 */
export function describeCalendarDeadline(
  input: CalendarDeadlineInput
): DeadlinePresentation | null {
  const day = parseCalendarDate(input.displayDate);
  const state = deadlineState({
    at: input.effectiveAt,
    now: input.now,
    ...(input.settled === undefined ? {} : { settled: input.settled }),
    ...(input.dueSoonHours === undefined ? {} : { dueSoonHours: input.dueSoonHours })
  });
  if (day === null || state === null) return null;

  const dayLine = dayText(day, input.weekday ?? true, input.year !== false);
  if (dayLine === null) return null;
  const boundary = parseInstantMs(input.effectiveAt);
  if (boundary === null) return null;

  let absolute = dayLine;
  let complete = dayLine;
  let marker: ZoneMarker | null = null;
  if (input.showTime !== false) {
    // One minute inside the boundary, so the zone named is the one in force
    // during the deadline's own last minute rather than after it — which is
    // the whole difference on a night the clocks go back.
    const lastMinute = new Date(boundary - MINUTE_MS).toISOString();
    const lastParts = parseZonedInstant(lastMinute, input.timezone);
    if (lastParts === null) return null;
    const suffix = zoneSuffix(
      lastParts,
      input.timezone,
      zoneSetting(input.zone, 'legacy'),
      input.viewerTimezone
    );
    marker = suffix.marker;
    const clocked = `${dayLine}${NBSP}${MIDDOT}${NBSP}23:59`;
    absolute = withSuffix(clocked, suffix.short);
    complete = withSuffix(clocked, suffix.complete);
  } else {
    // A date-only deadline still belongs to the event's calendar: "closes on
    // the 20th" means the 20th THERE, which is not the reader's 20th when the
    // offsets differ. The zone is quieter here — there is no clock to get
    // wrong — but silence at `always` would drop the fact entirely, and at
    // `auto` it would hide a genuine day-boundary difference.
    const lastMinute = new Date(boundary - MINUTE_MS).toISOString();
    const lastParts = parseZonedInstant(lastMinute, input.timezone);
    if (lastParts === null) return null;
    const suffix = zoneSuffix(
      lastParts,
      input.timezone,
      zoneSetting(input.zone, 'never'),
      input.viewerTimezone
    );
    marker = suffix.marker;
    absolute = withSuffix(dayLine, suffix.short);
    complete = withSuffix(dayLine, suffix.complete);
  }
  // The relative half is measured to the deadline's LAST ACTIONABLE MINUTE,
  // not to the end-exclusive boundary. Measuring to the boundary makes a
  // deadline due today read "tomorrow" beside an absolute that says today —
  // the two halves of one line disagreeing about the same instant.
  const relative = formatRelative(
    new Date(boundary - MINUTE_MS).toISOString(),
    input.now,
    { timezone: input.timezone }
  );
  return composeDeadline(
    absolute,
    complete,
    new Date(boundary).toISOString(),
    relative,
    state,
    input.label ?? '',
    marker
  );
}
